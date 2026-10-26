import { createHmac } from "node:crypto";
import {
  CLIENT_CONFIG_VERSION,
  INSTANCE_ID_PATTERN,
  LOCAL_FLEET_SOURCE_ID,
  MAX_FRAME_BYTES,
  MAX_PUSH_SUBSCRIPTION_BYTES,
  PUSH_API_VERSION,
  ProtocolValidationError,
  type ClientConfigResponse,
  type LaunchMode,
  type SessionEvent,
  parseJsonFrame,
  parseLaunchRequest,
  parseNotificationRoute,
  parsePushSubscriptionRequest,
  parsePushUnsubscribeRequest,
  parseSessionCreationRequest,
  SESSION_CREATION_UUID_PATTERN,
  MAX_SESSION_CREATION_REQUEST_BYTES,
} from "@omp-session-gateway/protocol";
import {
  authorizeHttpRequest,
  isLoopbackAddress,
  requestHasTrustedDashboardContext,
  requestHasValidMutationContext,
  type RequestPeer,
} from "./auth.ts";
import { createTailnetPresenceProbe } from "./tailnet.ts";
import type { GatewayConfig } from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { SessionRegistry } from "./registry.ts";
import type { PushService } from "./push.ts";
import { SessionCreationProblem, type SessionCreationService } from "./tern-creation.ts";

import { StaticAssetStore } from "./static.ts";
import type { LaunchResolution } from "./omp-registry.ts";
import { corsAdmission, finalizeHttpResponse, preflightDecision, type PreflightDecision } from "./http-policy.ts";

/**
 * The launch side of the OMP reader, narrowed to what HTTP needs. Keeping it an interface means the
 * handler tests drive refusals without a live host, and the daemon binds the real socket client.
 */
export interface LaunchBroker {
  resolve(request: {
    readonly instanceId: string;
    readonly generation: number;
    readonly mode: LaunchMode;
    readonly requestId?: string;
  }): Promise<LaunchResolution>;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

class LaunchRateLimiter {
  readonly #buckets = new Map<string, RateBucket>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxBuckets: number;

  constructor(limit = 20, windowMs = 60_000, maxBuckets = 2_000) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxBuckets = maxBuckets;
  }

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (this.#buckets.size >= this.#maxBuckets) {
        for (const [candidate, value] of this.#buckets) {
          if (value.resetAt <= now) this.#buckets.delete(candidate);
        }
        if (this.#buckets.size >= this.#maxBuckets) return false;
      }
      this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    if (bucket.count >= this.#limit) return false;
    bucket.count += 1;
    return true;
  }
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { "Content-Type": "application/problem+json" } });
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new ProtocolValidationError();
  }
  if (request.body === null) throw new ProtocolValidationError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) throw new ProtocolValidationError();
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const SSE_KEEPALIVE_MS = 5_000;

/**
 * @param stillAuthorized re-read on every keepalive. Authorization for this endpoint would otherwise
 * be evaluated once and never again, so a stream admitted while identity trust was sound would keep
 * delivering the session directory after the topology stopped justifying it. The keepalive is
 * already the stream's liveness tick, so this adds a predicate read rather than a timer.
 *
 * Admission goes through `subscribeWithSnapshot` so the snapshot and the live subscription are one
 * step: a revision landing mid-handshake is replayed in order rather than lost, and teardown is
 * reachable from the first frame onward instead of only after the subscription is assigned.
 */
function eventStream(
  registry: SessionRegistry,
  keepaliveMs = SSE_KEEPALIVE_MS,
  stillAuthorized: () => boolean = () => true,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const release = (): void => {
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(keepalive);
    keepalive = undefined;
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const close = (): void => {
          release();
          try {
            controller.close();
          } catch {
            // The peer may have errored the stream before Bun delivered cancel().
          }
        };
        const send = (event: SessionEvent): void => {
          if (closed) return;
          if ((controller.desiredSize ?? 1) < -32) {
            close();
            return;
          }
          try {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          } catch {
            release();
          }
        };
        const dispose = registry.subscribeWithSnapshot(send);
        // A stream abandoned during admission has no subscription handle to revoke yet, so revoke the
        // one admission just returned instead of leaving the listener attached to the registry.
        if (closed) {
          dispose();
          return;
        }
        unsubscribe = dispose;
        keepalive = setInterval(() => {
          if (closed) return;
          if (!stillAuthorized()) {
            close();
            return;
          }
          if ((controller.desiredSize ?? 1) < -32) {
            close();
            return;
          }
          try {
            controller.enqueue(encoder.encode("event: keepalive\ndata: {}\n\n"));
          } catch {
            release();
          }
        }, keepaliveMs);
      },
      cancel() {
        release();
      },
    },
    { highWaterMark: 32 },
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
export function createHttpHandler(options: {
  readonly config: GatewayConfig;
  readonly registry: SessionRegistry;
  /** Brokers one capability per explicit launch, straight from the owning OMP host. */
  readonly launchResolver: LaunchBroker;
  readonly staticAssets: StaticAssetStore;
  readonly pushService?: PushService;
  readonly creationService?: Pick<SessionCreationService, "options" | "accept" | "status">;
  readonly logger?: SafeLogger;
  readonly readinessToken?: string;
  readonly readinessInstance?: string;
  readonly sseKeepaliveMs?: number;
  /** Supplies wall-clock time for deterministic rate-window enforcement. */
  readonly now?: () => number;
  /**
   * Reports whether OMP's collaboration discovery directory is still readable. A daemon whose
   * discovery root turned into a symlink or another user's directory keeps serving HTTP while no
   * session can ever appear, so readiness must reflect discovery rather than process liveness.
   */
  readonly endpointHealthy?: () => boolean;
  /**
   * Whether Tailscale Serve is still the only path to this loopback listener, i.e. tailscaled owns a
   * TUN device. Injectable so tests can drive both topologies; the default measures the host.
   */
  readonly tailnetPresent?: () => boolean;
}): (request: Request, peer?: RequestPeer) => Promise<Response> {
  const { config, registry, staticAssets, launchResolver } = options;
  const logger = options.logger ?? new SafeLogger();
  const identityCapacity = config.auth.mode === "dev-localhost" ? 1 : config.auth.allowedLogins.length;
  // Each admitted identity owns three keys (`launch`, `push`, `creation`), so configured identities
  // can never deny one another merely by filling the bounded map.
  const limiter = new LaunchRateLimiter(20, 60_000, Math.max(3, identityCapacity * 3));
  const now = options.now ?? Date.now;
  const tailnetPresent = options.tailnetPresent ?? createTailnetPresenceProbe();
  // `tailscale-serve` mode trusts an identity header from any loopback peer, which is only sound
  // while Serve is the sole way in. Configuration may declare that no tailnet reaches this host at
  // all, which is how a loopback-only harness exercises the production identity path with no
  // Tailscale installed; on a host running userspace-mode tailscaled that declaration is false and
  // re-opens #98, so `doctor` reports it rather than letting it pass silently.
  const identityTrustDeclared = config.auth.trustIdentityWithoutTailnetDevice === true;
  if (identityTrustDeclared && config.auth.mode === "tailscale-serve") {
    // Declared trust disables the measurement, so without this the daemon's logs would be
    // byte-identical to a healthy host's. Emitted once at construction so the assertion is always on
    // the record, whether or not it happens to be true.
    logger.event("warn", "http.identity_trust_declared");
  }
  // Seeded sound so a healthy daemon says nothing at startup and only a change is reported. This
  // governs logging only; authorization always uses the measured value.
  let identityTrustLogged = true;
  const route = async (
    request: Request,
    peer: RequestPeer | undefined,
    url: URL,
    admittedOrigin: string | undefined,
    preflight: PreflightDecision | undefined,
  ): Promise<Response> => {
    const clientRoute = request.method === "GET" && url.pathname === "/client/";
    const requestBootstrap = request.method === "GET" && parseNotificationRoute(url) !== undefined;
    const updateBootstrap = request.method === "GET" && url.pathname === "/update/";
    const origin = request.headers.get("Origin");
    if (
      url.pathname.startsWith("/api/") &&
      !(url.pathname === "/api/v1/health" && request.method === "GET") &&
      origin !== null &&
      origin !== config.http.publicOrigin &&
      admittedOrigin === undefined
    ) {
      return problem(403, "forbidden", "Forbidden");
    }
    if (url.search !== "" && !requestBootstrap) {
      return problem(400, "bad_request", "Query parameters are not accepted");
    }


    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      if (peer === undefined || !isLoopbackAddress(peer.address)) {
        return problem(403, "forbidden", "Forbidden");
      }
      const status = options.endpointHealthy?.() === false ? "degraded" : "ready";
      const challenge = request.headers.get("X-OMP-Readiness-Challenge");
      if (challenge === null) return Response.json({ status });
      if (options.readinessToken === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
        return problem(400, "bad_request", "Invalid readiness challenge");
      }
      const instance = options.readinessInstance ?? "";
      const proof = createHmac("sha256", options.readinessToken)
        .update(challenge)
        .update("\0")
        .update(instance)
        .digest("base64url");
      return Response.json({ status, proof, ...(instance === "" ? {} : { instance }) });
    }

    // Only `tailscale-serve` mode believes an identity header, so only it pays for the measurement.
    let serveOwnsIdentityHeaders = true;
    if (config.auth.mode === "tailscale-serve") {
      serveOwnsIdentityHeaders = identityTrustDeclared || tailnetPresent();
      if (serveOwnsIdentityHeaders !== identityTrustLogged) {
        identityTrustLogged = serveOwnsIdentityHeaders;
        // Logged on transition, not per request: this is one property of the host, and a per-request
        // line would be unbounded noise for a single operator-visible fact.
        logger.event(
          serveOwnsIdentityHeaders ? "info" : "error",
          serveOwnsIdentityHeaders ? "http.identity_trust_restored" : "http.identity_trust_unsound",
        );
      }
    }
    const authorization = authorizeHttpRequest(request, peer, config, serveOwnsIdentityHeaders);
    if (!authorization.allowed) {
      logger.event("warn", "http.authorization_denied", {
        identity_untrustworthy: authorization.reason === "identity_untrustworthy",
      });
      return problem(403, "forbidden", "Forbidden");
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return preflight?.allowed === true
        ? new Response(null, { status: 204 })
        : problem(403, "forbidden", "Forbidden");
    }
    if (url.pathname === "/api/v1/client-config" && request.method === "GET") {
      const response: ClientConfigResponse = {
        version: CLIENT_CONFIG_VERSION,
        local: { id: LOCAL_FLEET_SOURCE_ID, label: config.fleet.label, origin: config.http.publicOrigin },
        targets: config.fleet.targets.map(target => ({ id: target.id, label: target.label, origin: target.origin })),
        speech: { browserRecognition: config.speech.browserRecognition },
      };
      return Response.json(response);
    }
    if (url.pathname === "/api/v1/sessions" && request.method === "GET") {
      const snapshot = registry.snapshot();
      return Response.json({ ...snapshot, sessions: snapshot.sessions.map(session => {
        const qualificationPushAlias = options.pushService?.qualificationAlias(session);
        return qualificationPushAlias === undefined ? session : { ...session, qualificationPushAlias };
      }) });
    }
    if (url.pathname === "/api/v1/session-creation-options" && request.method === "GET" && options.creationService) {
      return Response.json(await options.creationService.options());
    }
    if (url.pathname === "/api/v1/session-creations" && request.method === "POST" && options.creationService) {
      const validContext = origin === config.http.publicOrigin
        ? requestHasValidMutationContext(request, config.http.publicOrigin)
        : requestHasTrustedDashboardContext(request, config.http.trustedDashboardOrigins) !== undefined;
      if (!validContext) return problem(403, "forbidden", "Forbidden");
      if (request.headers.get("Content-Type")?.toLowerCase() !== "application/json") {
        return problem(415, "unsupported_media_type", "Expected application/json");
      }
      let creationRequest;
      try {
        creationRequest = parseSessionCreationRequest(parseJsonFrame(await readBoundedBody(request, MAX_SESSION_CREATION_REQUEST_BYTES)));
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      try {
        const result = await options.creationService.accept(authorization.identityKey, creationRequest,
          () => limiter.allow(`${authorization.identityKey}\0creation`, now()));
        return Response.json(result.receipt, { status: result.status });
      } catch (error) {
        if (error instanceof SessionCreationProblem) return problem(error.status, error.code, "Session creation is unavailable");
        return problem(503, "tern_unavailable", "Session creation is unavailable");
      }
    }
    const creationMatch = /^\/api\/v1\/session-creations\/([^/]+)$/u.exec(url.pathname);
    if (creationMatch && SESSION_CREATION_UUID_PATTERN.test(creationMatch[1]!) && request.method === "GET" && options.creationService) {
      try {
        const status = options.creationService.status(authorization.identityKey, creationMatch[1]!);
        return status ? Response.json(status) : problem(404, "not_found", "Not found");
      } catch (error) {
        if (error instanceof SessionCreationProblem) return problem(error.status, error.code, "Session creation is unavailable");
        return problem(503, "ledger_unavailable", "Session creation is unavailable");
      }
    }
    if (url.pathname === "/api/v1/events" && request.method === "GET") {
      // Re-read per keepalive: an admitted stream must not outlive the topology that justified it.
      return eventStream(registry, options.sseKeepaliveMs, () =>
        config.auth.mode !== "tailscale-serve" || identityTrustDeclared || tailnetPresent(),
      );
    }
    if (url.pathname === "/api/v1/push/config" && request.method === "GET" && options.pushService !== undefined) {
      return Response.json(options.pushService.configResponse());
    }
    if (
      url.pathname === "/api/v1/push/subscription" &&
      (request.method === "POST" || request.method === "DELETE") &&
      options.pushService !== undefined
    ) {
      if (!requestHasValidMutationContext(request, config.http.publicOrigin)) {
        return problem(403, "forbidden", "Forbidden");
      }
      if (request.headers.get("Content-Type")?.toLowerCase() !== "application/json") {
        return problem(415, "unsupported_media_type", "Expected application/json");
      }
      if (!limiter.allow(`${authorization.identityKey}\0push`, now())) {
        return problem(429, "rate_limited", "Too many requests");
      }
      let body: unknown;
      try {
        body = parseJsonFrame(await readBoundedBody(request, MAX_PUSH_SUBSCRIPTION_BYTES));
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      if (request.method === "POST") {
        let subscriptionRequest;
        try {
          subscriptionRequest = parsePushSubscriptionRequest(body);
        } catch {
          return problem(400, "bad_request", "Invalid request");
        }
        try {
          const detailLevel = await options.pushService.subscribe(authorization.identityKey, subscriptionRequest);
          return Response.json({ version: PUSH_API_VERSION, detailLevel });
        } catch {
          return problem(409, "subscription_rejected", "Push subscription could not be saved");
        }
      } else {
        let unsubscribeRequest;
        try {
          unsubscribeRequest = parsePushUnsubscribeRequest(body);
        } catch {
          return problem(400, "bad_request", "Invalid request");
        }
        await options.pushService.unsubscribe(authorization.identityKey, unsubscribeRequest);
      }
      return new Response(null, { status: 204 });
    }


    const launchMatch = /^\/api\/v1\/sessions\/([^/]{1,384})\/launch$/u.exec(url.pathname);
    if (launchMatch !== null && request.method === "POST") {
      const encodedInstanceId = launchMatch[1];
      if (encodedInstanceId === undefined) return problem(400, "bad_request", "Invalid request");
      let instanceId: string;
      try {
        instanceId = decodeURIComponent(encodedInstanceId);
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      if (!INSTANCE_ID_PATTERN.test(instanceId)) {
        return problem(400, "bad_request", "Invalid request");
      }
      const validContext = origin === config.http.publicOrigin
        ? requestHasValidMutationContext(request, config.http.publicOrigin)
        : requestHasTrustedDashboardContext(request, config.http.trustedDashboardOrigins) !== undefined;
      if (!validContext) {
        return problem(403, "forbidden", "Forbidden");
      }
      if (request.headers.get("Content-Type")?.toLowerCase() !== "application/json") {
        return problem(415, "unsupported_media_type", "Expected application/json");
      }
      let launchRequest;
      try {
        const body = await readBoundedBody(request, Math.min(MAX_FRAME_BYTES, 4_096));
        launchRequest = parseLaunchRequest(parseJsonFrame(body));
      } catch {
        return problem(400, "bad_request", "Invalid request");
      }
      if (!limiter.allow(`${authorization.identityKey}\0launch`, now())) {
        return problem(429, "rate_limited", "Too many requests");
      }
      const resolution = await launchResolver.resolve({
        instanceId,
        generation: launchRequest.generation,
        mode: launchRequest.mode,
        ...(launchRequest.requestId === undefined ? {} : { requestId: launchRequest.requestId }),
      });
      if (resolution.status === "generation_mismatch") {
        return problem(409, "generation_mismatch", "Session changed; refresh and try again");
      }
      if (resolution.status === "request_mismatch") {
        return problem(409, "request_mismatch", "Request changed; refresh and try again");
      }
      if (resolution.status === "mode_unavailable") {
        return problem(409, "mode_unavailable", "Session no longer shares that access; refresh and try again");
      }
      if (resolution.status !== "ok") return problem(404, "not_found", "Session unavailable");
      const response = Response.json({
        mode: launchRequest.mode,
        generation: launchRequest.generation,
        capability: resolution.capability.reveal(),
      });
      return response;
    }

    if (url.pathname.startsWith("/api/")) return problem(404, "not_found", "Not found");
    const staticResponse = staticAssets.response(
      clientRoute || requestBootstrap || updateBootstrap ? "/" : url.pathname,
    );
    return staticResponse ?? new Response("Not found", { status: 404 });
  };
  return async (request, peer): Promise<Response> => {
    let url: URL | undefined;
    let admittedOrigin: string | undefined;
    let preflight: PreflightDecision | undefined;
    let response: Response;
    try {
      url = new URL(request.url);
    } catch {
      return finalizeHttpResponse(problem(400, "bad_request", "Invalid request"), config, {
        document: false,
        noStore: true,
      });
    }
    try {
      admittedOrigin = corsAdmission(request, config);
      preflight = request.method === "OPTIONS" ? preflightDecision(request, config) : undefined;
      response = await route(request, peer, url, admittedOrigin, preflight);
    } catch {
      logger.event("error", "http.request_failed");
      response = problem(500, "internal_error", "Internal server error");
    }
    const bootstrap = request.method === "GET" &&
      (url.pathname === "/client/" || url.pathname === "/update/" || parseNotificationRoute(url) !== undefined);
    return finalizeHttpResponse(response, config, {
      document: response.status < 400 && response.headers.get("Content-Type")?.startsWith("text/html") === true,
      noStore: url.pathname.startsWith("/api/") || bootstrap ||
        response.headers.get("Content-Type") === "application/problem+json",
      ...(request.method === "OPTIONS" || admittedOrigin === undefined ? {} : { corsOrigin: admittedOrigin }),
      ...(preflight?.allowed === true && response.status === 204 ? { preflight } : {}),
    });
  };
}

export function startHttpServer(options: {
  readonly config: GatewayConfig;
  readonly registry: SessionRegistry;
  readonly launchResolver: LaunchBroker;
  readonly staticAssets: StaticAssetStore;
  readonly pushService?: PushService;
  readonly creationService?: Pick<SessionCreationService, "options" | "accept" | "status">;
  readonly logger?: SafeLogger;
  readonly readinessToken: string;
  readonly readinessInstance?: string;
  readonly endpointHealthy?: () => boolean;
}): Bun.Server<undefined> {
  const handler = createHttpHandler(options);
  let handlers = 0;
  let drained: (() => void) | undefined;
  let draining: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: options.config.http.hostname,
    port: options.config.http.port,
    // Must exceed the five-second SSE keepalive interval or Bun repeatedly closes event streams.
    idleTimeout: 30,
    async fetch(request, bunServer) {
      const address = bunServer.requestIP(request)?.address;
      handlers++;
      try { return await handler(request, address === undefined ? undefined : { address }); }
      finally { if (--handlers === 0) drained?.(); }
    },
  });
  const stop = server.stop.bind(server);
  server.stop = async closeActiveConnections => {
    try { await stop(closeActiveConnections); }
    finally {
      // Bun's forced connection close can resolve before an admitted async handler returns.
      // That handler still owns its logger; socket closure alone is not a producer drain.
      if (handlers > 0) await (draining ??= new Promise<void>(resolve => { drained = resolve; }));
    }
  };
  options.logger?.event("info", "http.listening", { port: server.port ?? options.config.http.port });
  return server;
}
