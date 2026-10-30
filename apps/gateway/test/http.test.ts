import { createHmac } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SecretCapability, type ObservedSessionInput } from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import { requestHasTrustedDashboardContext, requestHasValidMutationContext } from "../src/auth.ts";
import { createHttpHandler, startHttpServer } from "../src/http.ts";
import { finalizeHttpResponse } from "../src/http-policy.ts";
import { QualificationLogSink, SafeLogger } from "../src/logger.ts";
import { PushService } from "../src/push.ts";
import { SessionRegistry } from "../src/registry.ts";
import { StaticAssetStore } from "../src/static.ts";
import { SessionCreationProblem, type SessionCreationService } from "../src/tern-creation.ts";
import type { SessionCreationRequest, SessionCreationReceipt, SessionCreationStatus } from "@omp-session-gateway/protocol";
import { HANG_DEADLINE_MS } from "../../../scripts/test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const viewCapability = ["HTTP", "VIEW", "CANARY", "00000000000000000000"].join("__");
const controlCapability = ["HTTP", "CONTROL", "CANARY", "00000000000000000000"].join("__");
const origin = "https://gateway.example.ts.net";
const peer = { address: "127.0.0.1" } as const;
let assetRoot = "";
let assets: StaticAssetStore;

const schemaValidator = new Ajv2020({ strict: true, allErrors: true });
addFormats(schemaValidator);
const validateSessionList = schemaValidator.compile(
  await Bun.file(new URL("../../../schemas/session-list.schema.json", import.meta.url)).json(),
);
const validateSessionEvent = schemaValidator.compile(
  await Bun.file(new URL("../../../schemas/sse-event.schema.json", import.meta.url)).json(),
);
const validateClientConfig = schemaValidator.compile(
  await Bun.file(new URL("../../../schemas/client-config.schema.json", import.meta.url)).json(),
);
const validateCreationOptions = schemaValidator.compile(
  await Bun.file(new URL("../../../schemas/session-creation-options.schema.json", import.meta.url)).json(),
);
const validateCreationStatus = schemaValidator.compile(
  await Bun.file(new URL("../../../schemas/session-creation-status.schema.json", import.meta.url)).json(),
);
const creationId = "11111111-2222-4333-8444-555555555555";
const creationBody: SessionCreationRequest = {
  clientOperationId: creationId, revision: creationId, projectId: "project", workingCopyId: "main", profileId: "omp",
};
function creationStub(): Pick<SessionCreationService, "options" | "accept" | "status"> {
  const records = new Map<string, { owner: string; request: SessionCreationRequest; receipt: SessionCreationReceipt }>();
  return {
    async options() {
      return { version: 1, revision: creationId, available: true,
        projects: [{ id: "project", label: "Project", workingCopies: [{ id: "main", label: "Main" }] }],
        profiles: [{ id: "omp", label: "OMP" }] };
    },
    async accept(owner, request, admitNew) {
      const prior = records.get(owner + request.clientOperationId);
      if (prior) {
        if (JSON.stringify(prior.request) !== JSON.stringify(request)) throw new SessionCreationProblem(409, "operation_conflict");
        return { status: 200, receipt: prior.receipt };
      }
      if (!admitNew()) throw new SessionCreationProblem(429, "rate_limited");
      const receipt: SessionCreationReceipt = { operationId: request.clientOperationId, state: "accepted" };
      records.set(owner + request.clientOperationId, { owner, request, receipt });
      return { status: 202, receipt };
    },
    status(owner, id): SessionCreationStatus | undefined {
      return records.has(owner + id) ? { operationId: id, state: "accepted", updatedAt: "2026-10-24T00:00:00.000Z" } : undefined;
    },
  };
}

function config(mode: GatewayConfig["auth"]["mode"] = "tailscale-serve"): GatewayConfig {
  return {
    http: {
      hostname: "127.0.0.1",
      port: 4317,
      publicOrigin: mode === "dev-localhost" ? "http://127.0.0.1:4317" : origin,
      trustedDashboardOrigins: [],
    },
    fleet: { label: "gateway", targets: [] },
    speech: { browserRecognition: false },
    // Declared rather than measured so this suite does not depend on whether the machine running it
    // has Tailscale in TUN mode. The measured path is covered by "loopback identity trust" below,
    // which builds a config without this field.
    auth: {
      mode,
      allowedLogins: mode === "tailscale-serve" ? ["allowed@example.com"] : [],
      ...(mode === "tailscale-serve" ? { trustIdentityWithoutTailnetDevice: true } : {}),
    },
    omp: { discoveryDir: "/private/omp/run/collab-hosts", queryTimeoutMs: 1_500 },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 10 },
    paths: {
      configDir: "/private/config",
      stateDir: "/private/state",
      runtimeDir: "/private/run",
      tokenPath: "/private/config/readiness-token",
      configPath: "/private/config/config.json",
    },
  };
}

function request(path: string, init: RequestInit = {}, identity = "allowed@example.com"): Request {
  const headers = new Headers(init.headers);
  if (identity.length > 0) headers.set("Tailscale-User-Login", identity);
  return new Request(`${origin}${path}`, { ...init, headers });
}

function observedSession(instanceId = "http-instance-000001", inputRequired = false): ObservedSessionInput {
  return {
    instanceId,
    generation: 3,
    pid: 1234,
    sessionId: "session-three",
    title: "Safe session",
    cwdLabel: "repository",
    model: "fixture/model",
    startedAt: "2026-07-19T00:00:00.000Z",
    inputRequired,
    canControl: true,
  };
}

function populatedRegistry(instanceId = "http-instance-000001"): SessionRegistry {
  const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
  registry.reconcile({ observed: [observedSession(instanceId)], retained: new Set() });
  return registry;
}

/** Resolve on demand against the same metadata the handler serves; no registry fixture stores a link. */
function createTestHttpHandler(
  options: Omit<Parameters<typeof createHttpHandler>[0], "launchResolver">,
): ReturnType<typeof createHttpHandler> {
  return createHttpHandler({
    ...options,
    launchResolver: {
      async resolve({ instanceId, generation, mode, requestId }) {
        const authorization = options.registry.authorizeLaunch(instanceId, generation, mode, requestId);
        if (authorization.status !== "ok") return authorization;
        return { status: "ok", capability: SecretCapability.from(mode === "view" ? viewCapability : controlCapability) };
      },
    },
  });
}

function launchRequest(
  generation = 3,
  mode: "view" | "control" = "view",
  instanceId = "http-instance-000001",
  requestId?: string,
  identity = "allowed@example.com",
): Request {
  return request(
    `/api/v1/sessions/${encodeURIComponent(instanceId)}/launch`,
    {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ mode, generation, ...(requestId === undefined ? {} : { requestId }) }),
    },
    identity,
  );
}

test.skipIf(process.platform === "win32")("495 round2 HTTP shutdown settles admitted handlers before closing structured logs", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "http-shutdown-"));
  const sink = new QualificationLogSink(root);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const server = startHttpServer({ config: { ...config(), http: { ...config().http, port: 0 } },
    registry: populatedRegistry(), staticAssets: assets, logger: new SafeLogger(sink), readinessToken: "synthetic-readiness",
    launchResolver: { async resolve() { entered.resolve(); await release.promise; throw new Error("synthetic handler failure"); } } });
  let settled = false;
  const req = launchRequest();
  const response = fetch(new URL("/api/v1/sessions/http-instance-000001/launch", server.url), {
    method: "POST", headers: req.headers, body: await req.text(),
  }).catch(() => undefined);
  try {
    await entered.promise;
    const stopping = server.stop(true).then(() => { settled = true; });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    release.resolve(); await stopping;
    sink.close();
    expect(await readFile(join(root, "events.0.jsonl"), "utf8")).toContain('"event":"http.request_failed"');
  } finally { release.resolve(); await server.stop(true); await response; await rm(root, { recursive: true, force: true }); }
});

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("SSE stream ended before an event");
    text += decoder.decode(next.value, { stream: true });
  }
  return text.slice(0, text.indexOf("\n\n") + 2);
}

beforeAll(async () => {
  assetRoot = await mkdtemp(join(tmpdir(), "gateway-http-assets-"));
  await writeFile(join(assetRoot, "index.html"), "<!doctype html><title>OMP Sessions</title>");
  await mkdir(join(assetRoot, "client"));
  await mkdir(join(assetRoot, "assets"));
  await writeFile(join(assetRoot, "client", "index.html"), "<!doctype html><title>OMP client</title>");
  await writeFile(join(assetRoot, "assets", "app.0123456789ab.js"), "export {};");
  assets = await StaticAssetStore.load(assetRoot);
});

afterAll(async () => {
  await rm(assetRoot, { recursive: true, force: true });
});

describe("HTTP boundary", () => {
  test("admits exact creation requests, returns schema-safe no-store metadata and owner-scoped status", async () => {
    const base = config();
    const handler = createTestHttpHandler({ config: { ...base, auth: { ...base.auth, allowedLogins: ["allowed@example.com", "other@example.com"] } },
      registry: populatedRegistry(), staticAssets: assets, creationService: creationStub() });
    const options = await handler(request("/api/v1/session-creation-options"), peer);
    expect(options.status).toBe(200); expect(validateCreationOptions(await options.json())).toBe(true);
    expect(options.headers.get("Cache-Control")).toContain("no-store");
    const post = (body: unknown, headers: HeadersInit = { Origin: origin, "Content-Type": "application/json" }) =>
      request("/api/v1/session-creations", { method: "POST", headers, body: JSON.stringify(body) });
    expect((await handler(post(creationBody), peer)).status).toBe(202);
    expect((await handler(post(creationBody), peer)).status).toBe(200);
    const status = await handler(request(`/api/v1/session-creations/${creationId}`), peer);
    expect(validateCreationStatus(await status.json())).toBe(true);
    expect(status.headers.get("Cache-Control")).toContain("no-store");
    expect((await handler(request(`/api/v1/session-creations/${creationId}`, {}, "other@example.com"), peer)).status).toBe(404);
    for (const path of [`/api/v1/session-creations/${creationId.toUpperCase().replace("555555555555", "AAAAAAAAAAAA")}`,
      `/api/v1/session-creations/${creationId}/extra`]) expect((await handler(request(path), peer)).status).toBe(404);
    expect((await handler(request(`/api/v1/session-creations/${creationId}?extra=1`), peer)).status).toBe(400);
    expect((await handler(post(creationBody, { "Content-Type": "application/json" }), peer)).status).toBe(403);
    expect((await handler(post(creationBody, { Origin: origin, "Content-Type": "text/plain" }), peer)).status).toBe(415);
    expect((await handler(post(creationBody, { Origin: origin, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }), peer)).status).toBe(403);
    for (const body of [{ ...creationBody, argv: ["CREATION_HTTP_SECRET_CANARY"] }, { ...creationBody, profileId: null }, { ...creationBody, prompt: "x".repeat(4096) }]) {
      const response = await handler(post(body), peer); expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("CREATION_HTTP_SECRET_CANARY");
    }
    const conflict = await handler(post({ ...creationBody, revision: "aaaaaaaa-2222-4333-8444-555555555555" }), peer);
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: "operation_conflict" });
    expect((await handler(request("/api/v1/session-creation-options", {}, ""), peer)).status).toBe(403);
  });
  test("isolates creation rate keys and leaves duplicate receipts readable after exhaustion", async () => {
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets, creationService: creationStub() });
    const post = (i: number) => request("/api/v1/session-creations", { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ ...creationBody, clientOperationId: `11111111-2222-4333-8444-${String(i).padStart(12, "0")}` }) });
    for (let i = 0; i < 20; i++) expect((await handler(post(i), peer)).status).toBe(202);
    expect((await handler(post(20), peer)).status).toBe(429);
    expect((await handler(post(0), peer)).status).toBe(200);
    expect((await handler(launchRequest(), peer)).status).toBe(200);
  });
  test("proves loopback readiness with a readiness-token HMAC challenge", async () => {
    const readinessToken = "T".repeat(43);
    const challenge = "C".repeat(43);
    const readinessInstance = "I".repeat(43);
    const handler = createTestHttpHandler({
      config: config(),
      registry: populatedRegistry(),
      staticAssets: assets,
      readinessToken,
      readinessInstance,
    });
    const healthRequest = new Request("http://127.0.0.1:4317/api/v1/health", {
      headers: { "X-OMP-Readiness-Challenge": challenge },
    });
    const response = await handler(healthRequest, peer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      instance: readinessInstance,
      proof: createHmac("sha256", readinessToken)
        .update(challenge)
        .update("\0")
        .update(readinessInstance)
        .digest("base64url"),
    });
    expect((await handler(healthRequest, { address: "192.168.1.20" })).status).toBe(403);
  });

  test("reports degraded readiness when OMP discovery is unhealthy", async () => {
    const readinessToken = "T".repeat(43);
    const challenge = "C".repeat(43);
    const handler = createTestHttpHandler({
      config: config(),
      registry: populatedRegistry(),
      staticAssets: assets,
      readinessToken,
      endpointHealthy: () => false,
    });

    const proven = await handler(
      new Request("http://127.0.0.1:4317/api/v1/health", { headers: { "X-OMP-Readiness-Challenge": challenge } }),
      peer,
    );
    expect(proven.status).toBe(200);
    expect(await proven.json()).toEqual({
      status: "degraded",
      proof: createHmac("sha256", readinessToken).update(challenge).update("\0").update("").digest("base64url"),
    });

    const plain = await handler(new Request("http://127.0.0.1:4317/api/v1/health"), peer);
    expect(await plain.json()).toEqual({ status: "degraded" });
  });

  test("fails closed for missing, disallowed, forged remote, and tagged-style identities", async () => {
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    expect((await handler(request("/api/v1/sessions", {}, ""), peer)).status).toBe(403);
    expect((await handler(request("/api/v1/sessions", {}, "other@example.com"), peer)).status).toBe(403);
    expect((await handler(request("/api/v1/sessions"), { address: "192.168.1.20" })).status).toBe(403);
    expect((await handler(request("/api/v1/sessions", {}, "tag:phone"), peer)).status).toBe(403);
  });

  test("dev mode requires both a loopback peer and the configured loopback origin", async () => {
    const handler = createTestHttpHandler({ config: config("dev-localhost"), registry: populatedRegistry(), staticAssets: assets });
    const localRequest = new Request("http://127.0.0.1:4317/api/v1/sessions");
    expect((await handler(localRequest, { address: "10.0.0.8" })).status).toBe(403);
    expect((await handler(request("/api/v1/sessions", {}, ""), peer)).status).toBe(403);
    expect((await handler(localRequest, peer)).status).toBe(200);
  });

  /**
   * The bypass in #98, as a test. A tailnet peer reaching a userspace-mode host arrives on the
   * loopback listener indistinguishable from a local client, so these cases drive the topology
   * signal rather than the peer address: `tailnetPresent: () => false` is exactly what the exposed
   * macOS qualification host looked like, where a forged header returned `200` with session data.
   */
  describe("loopback identity trust", () => {
    function measured(): GatewayConfig {
      const base = config();
      return { ...base, auth: { mode: base.auth.mode, allowedLogins: base.auth.allowedLogins } };
    }

    test("refuses an allowlisted identity when no tailnet interface vouches for Serve", async () => {
      const handler = createTestHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        tailnetPresent: () => false,
      });

      // Same request that returned 200 on the exposed host.
      const denied = await handler(request("/api/v1/sessions"), peer);
      expect(denied.status).toBe(403);
      // The launch surface is the one that mints capabilities, so it must fail on the same signal.
      expect((await handler(launchRequest(), peer)).status).toBe(403);
    });

    /**
     * The exposure both #158 and #74 ask for. A tunnel or reverse proxy runs on this host, so it
     * satisfies the loopback check by being local, and the tunnel device is present because the host
     * really is on a tailnet — every existing signal says yes. The identity header is then whatever
     * the remote caller typed, which is a full authentication bypass to View and Control.
     *
     * A caller cannot suppress what the proxy in front of it inserts, so these requests are refused
     * on that evidence. Not authentication: a raw TCP forwarder inserts nothing and is still
     * indistinguishable from Serve.
     */
    test("refuses an allowlisted identity carrying evidence of a second HTTP hop", async () => {
      const handler = createTestHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        // Pinned true so the only thing that can refuse these is the second-hop evidence. Left to
        // the real probe, this test passes on any machine without a tailnet — including every CI
        // runner — whether or not the guard exists.
        tailnetPresent: () => true,
      });
      const proxied = [
        // cloudflared and ngrok both report the public client here; Serve reports the tailnet peer.
        { "X-Forwarded-For": "203.0.113.7" },
        // A proxy chained in front of Serve appends rather than replacing.
        { "X-Forwarded-For": "100.101.102.103, 203.0.113.7" },
        // Serve sets this to the tailnet host it answered on, never to a tunnel hostname.
        { "X-Forwarded-Host": "gateway.example.com" },
        { "CF-Connecting-IP": "203.0.113.7" },
        { "CF-Ray": "8f2b1c0d4e5a6b7c-SJC" },
        { "X-Real-IP": "203.0.113.7" },
        { Forwarded: "for=203.0.113.7;proto=https" },
        { "X-Forwarded-Server": "tunnel-edge-01" },
        // Funnel is never a supported path.
        { "Tailscale-Funnel-Request": "?1" },
      ];
      const proxiedLaunch = (headers: Record<string, string>): Request =>
        request(`/api/v1/sessions/http-instance-000001/launch`, {
          method: "POST",
          headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ mode: "view", generation: 3 }),
        });
      for (const headers of proxied) {
        expect((await handler(request("/api/v1/sessions", { headers }), peer)).status).toBe(403);
        // The launch surface mints capabilities, so it must refuse on the same evidence.
        expect((await handler(proxiedLaunch(headers), peer)).status).toBe(403);
      }
    });

    test("admits the request shape Tailscale Serve actually produces", async () => {
      const handler = createTestHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        // Without this the suite depends on whether the machine running it has Tailscale in TUN
        // mode, which is exactly the trap `config()` documents.
        tailnetPresent: () => true,
      });
      // Measured against `addProxyForwardedHeaders` in Tailscale's `ipn/ipnlocal/serve.go`: the
      // single tailnet source address, the host Serve answered on, and `https`. Refusing any of
      // these would break the only supported remote path.
      const served = await handler(
        request("/api/v1/sessions", {
          headers: {
            "X-Forwarded-For": "100.101.102.103",
            "X-Forwarded-Host": new URL(origin).host,
            "X-Forwarded-Proto": "https",
            "Tailscale-Headers-Info": "https://tailscale.com/s/serve-headers",
          },
        }),
        peer,
      );
      expect(served.status).toBe(200);
    });

    /**
     * The class, not the two instances above. Every route that can answer must sit behind the
     * identity gate, so adding one in front of it fails here rather than in a later qualification.
     *
     * `/api/v1/health` is the single deliberate exception and is asserted as such. It is loopback-
     * gated only, carries no session data and no capability, and on a userspace-mode host a tailnet
     * peer can read `{"status":"ready"}` and obtain `HMAC(readinessToken, challenge \0 instance)` for
     * a challenge of its choice. That is bounded: the readiness token authenticates a daemon to an
     * installer over loopback on the same host, which a remote caller cannot become, and it is the
     * gateway's only use of that secret — OMP's discovery sockets authenticate with their own
     * per-host tokens, which this daemon reads and never issues, so a readiness proof cannot be
     * replayed against a host. Gating health would also blind `doctor`, which reaches the daemon
     * through this endpoint, exactly when it needs to report `loopbackTrustSound: false`.
     */
    test("no route but health answers while identity trust is unsound", async () => {
      const handler = createTestHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        // No push service: the gate runs before route dispatch, so `/api/v1/push/config` below is
        // refused by the gate rather than by being unrouted, which is the invariant being asserted.
        tailnetPresent: () => false,
      });

      for (const path of [
        "/",
        "/api/v1/sessions",
        "/api/v1/events",
        "/api/v1/push/config",
        "/manifest.webmanifest",
        "/service-worker.js",
        "/assets/app.0123456789ab.js",
        "/client/",
      ]) {
        expect({ path, status: (await handler(request(path), peer)).status }).toEqual({ path, status: 403 });
      }

      const health = await handler(new Request("http://127.0.0.1:4317/api/v1/health"), peer);
      expect(health.status).toBe(200);
    });

    test("serves the same identity once a TUN device owns a tailnet address", async () => {
      const handler = createTestHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        tailnetPresent: () => true,
      });

      expect((await handler(request("/api/v1/sessions"), peer)).status).toBe(200);
      expect((await handler(launchRequest(), peer)).status).toBe(200);
    });

    /**
     * Authorization for a stream used to be a one-shot decision at request time, so a feed admitted
     * while the topology justified it kept delivering the session directory afterwards. The keepalive
     * is the stream's own liveness tick, so it is where the decision is revisited.
     */
    test("an admitted stream stops when the topology stops justifying it", async () => {
      let present = true;
      const handler = createTestHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        sseKeepaliveMs: 1,
        tailnetPresent: () => present,
      });

      const stream = await handler(request("/api/v1/events"), peer);
      expect(stream.status).toBe(200);
      const reader = stream.body?.getReader();
      if (reader === undefined) throw new Error("missing SSE body");
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("event: snapshot");

      present = false;
      // Drain until the stream ends. It must end rather than keep emitting keepalives.
      let closed = false;
      for (let read = 0; read < 200; read += 1) {
        const chunk = await reader.read();
        if (chunk.done) {
          closed = true;
          break;
        }
      }
      expect(closed).toBe(true);
    });

    test("declared trust always leaves a record, because it disables the measurement", async () => {
      const lines: string[] = [];
      createTestHttpHandler({
        config: config(),
        registry: populatedRegistry(),
        staticAssets: assets,
        logger: new SafeLogger({ write: line => lines.push(line) }),
        tailnetPresent: () => false,
      });

      // Without this the logs of a host asserting the flag would be byte-identical to a healthy one's.
      expect(lines.map(line => (JSON.parse(line) as { event: string }).event)).toContain(
        "http.identity_trust_declared",
      );
    });

    test("dev mode declares nothing, because it believes no identity header", async () => {
      const lines: string[] = [];
      createTestHttpHandler({
        config: config("dev-localhost"),
        registry: populatedRegistry(),
        staticAssets: assets,
        logger: new SafeLogger({ write: line => lines.push(line) }),
      });

      expect(lines).toHaveLength(0);
    });

    test("a declared tailnet-less host trusts the header without measuring", async () => {
      let measurements = 0;
      const handler = createTestHttpHandler({
        config: config(),
        registry: populatedRegistry(),
        staticAssets: assets,
        tailnetPresent: () => {
          measurements += 1;
          return false;
        },
      });

      expect((await handler(request("/api/v1/sessions"), peer)).status).toBe(200);
      expect(measurements).toBe(0);
    });

    test("dev mode neither consults nor is blocked by the topology", async () => {
      let measurements = 0;
      const handler = createTestHttpHandler({
        config: config("dev-localhost"),
        registry: populatedRegistry(),
        staticAssets: assets,
        tailnetPresent: () => {
          measurements += 1;
          return false;
        },
      });

      expect((await handler(new Request("http://127.0.0.1:4317/api/v1/sessions"), peer)).status).toBe(200);
      expect(measurements).toBe(0);
    });

    test("records the unsound topology once and marks the denial reason", async () => {
      const lines: string[] = [];
      const handler = createTestHttpHandler({
        config: measured(),
        registry: populatedRegistry(),
        staticAssets: assets,
        logger: new SafeLogger({ write: line => lines.push(line) }),
        tailnetPresent: () => false,
      });

      await handler(request("/api/v1/sessions"), peer);
      await handler(request("/api/v1/sessions"), peer);
      const events = lines.map(line => JSON.parse(line) as { event: string; identity_untrustworthy?: boolean });
      // One host-level fact, not one line per request.
      expect(events.filter(entry => entry.event === "http.identity_trust_unsound")).toHaveLength(1);
      expect(events.filter(entry => entry.event === "http.authorization_denied")).toHaveLength(1);
      expect(events.find(entry => entry.event === "http.authorization_denied")?.identity_untrustworthy).toBe(true);
      expect(lines.join("\n")).not.toContain("allowed@example.com");
    });
  });

  test("does not expose an HTTP shutdown control endpoint", async () => {
    const handler = createTestHttpHandler({
      config: config(),
      registry: populatedRegistry(),
      staticAssets: assets,
    });
    const response = await handler(
      request("/_internal/v1/shutdown", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"S".repeat(43)}`,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      peer,
    );
    expect(response.status).toBe(404);
  });

  test("published schemas accept canonical HTTP and SSE ask/activity transitions with short OMP identities", async () => {
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.reconcile({
      observed: [{ ...observedSession("a1b2c3d4", true), busy: true }],
      retained: new Set(),
    });
    const handler = createTestHttpHandler({ config: config(), registry, staticAssets: assets, sseKeepaliveMs: 60_000 });
    const list = await (await handler(request("/api/v1/sessions"), peer)).json();
    expect(list.sessions[0].ask).toBeDefined();
    expect(validateSessionList(list)).toBeTrue();

    const sse = await handler(request("/api/v1/events"), peer);
    const reader = sse.body?.getReader();
    if (reader === undefined) throw new Error("missing SSE body");
    const nextEvent = async (): Promise<unknown> => {
      const frame = await readSseEvent(reader);
      return JSON.parse(frame.slice(frame.indexOf("data: ") + "data: ".length));
    };
    try {
      const snapshot = await nextEvent();
      expect(snapshot).toMatchObject({ type: "snapshot" });
      expect(validateSessionEvent(snapshot)).toBeTrue();
      registry.reconcile({
        observed: [{ ...observedSession("a1b2c3d4"), busy: false }],
        retained: new Set(),
      });
      const upsert = await nextEvent();
      expect(upsert).toMatchObject({ type: "session_upsert", session: { inputRequired: false, busy: false } });
      expect(validateSessionEvent(upsert)).toBeTrue();
      registry.reconcile({ observed: [], retained: new Set() });
      const removal = await nextEvent();
      expect(removal).toMatchObject({ type: "session_remove", instanceId: "a1b2c3d4" });
      expect(validateSessionEvent(removal)).toBeTrue();
    } finally {
      await reader.cancel();
    }
  });

  test("published metadata schemas enforce identity, attention and private-field boundaries", () => {
    const session = populatedRegistry("a1b2c3d4").snapshot().sessions[0]!;
    const waiting = {
      ...session,
      inputRequired: true,
      ask: {
        requestId: "r".repeat(128),
        since: session.lastSeenAt,
        preview: String.fromCodePoint(0x1d11e).repeat(256),
        optionCount: 128,
      },
    };
    const list = (value: unknown, revision = 0) => ({ revision, sessions: [value] });
    expect(validateSessionList(list(session))).toBeTrue();
    expect(validateSessionList(list(waiting))).toBeTrue();
    for (const instanceId of ["a1b2c3d4", "a".repeat(64)]) {
      expect(validateSessionList(list({ ...session, instanceId }))).toBeTrue();
      expect(validateSessionEvent({ type: "session_remove", revision: 0, instanceId, generation: 1 })).toBeTrue();
    }
    for (const instanceId of ["a".repeat(7), "a".repeat(65), "invalid_identity"]) {
      expect(validateSessionList(list({ ...session, instanceId }))).toBeFalse();
      expect(validateSessionEvent({ type: "session_remove", revision: 1, instanceId, generation: 1 })).toBeFalse();
    }
    for (const invalid of [
      { ...session, inputRequired: true },
      { ...waiting, inputRequired: false },
      { ...waiting, ask: { ...waiting.ask, capability: viewCapability } },
      { ...waiting, ask: { ...waiting.ask, requestId: "r".repeat(129) } },
      { ...waiting, ask: { ...waiting.ask, optionCount: 0 } },
      { ...waiting, ask: { ...waiting.ask, optionCount: 129 } },
      { ...session, capability: viewCapability },
      { ...session, busy: null },
      { ...session, generation: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(validateSessionList(list(invalid))).toBeFalse();
      expect(validateSessionEvent({ type: "session_upsert", revision: 1, session: invalid })).toBeFalse();
    }
    expect(validateSessionList(list(session, Number.MAX_SAFE_INTEGER + 1))).toBeFalse();
    expect(validateSessionEvent({ type: "snapshot", ...list(session, Number.MAX_SAFE_INTEGER + 1) })).toBeFalse();
    expect(validateSessionEvent({ type: "activity_stop", revision: 1, session })).toBeFalse();
  });

  test("returns ordered metadata-only no-store list and SSE transitions", async () => {
    const registry = populatedRegistry();
    const handler = createTestHttpHandler({ config: config(), registry, staticAssets: assets, sseKeepaliveMs: 1 });
    const list = await handler(request("/api/v1/sessions"), peer);
    const text = await list.text();
    expect(list.headers.get("Cache-Control")).toContain("no-store");
    expect(text).not.toContain(viewCapability);
    expect(text).not.toContain(controlCapability);
    expect(text).not.toContain("PROMPT_CONTENT_CANARY");
    expect(text).toContain("Safe session");
    expect(text).toContain('"inputRequired":false');

    const sse = await handler(request("/api/v1/events"), peer);
    const reader = sse.body?.getReader();
    if (reader === undefined) throw new Error("missing SSE body");
    const snapshot = await readSseEvent(reader);
    expect(snapshot).toContain("event: snapshot");
    expect(snapshot).not.toContain(viewCapability);
    expect(snapshot).not.toContain("PROMPT_CONTENT_CANARY");
    expect(snapshot).toContain('"inputRequired":false');
    const keepalive = await readSseEvent(reader);
    expect(keepalive).toBe("event: keepalive\ndata: {}\n\n");
    expect(keepalive).not.toContain(viewCapability);
    expect(keepalive).not.toContain(controlCapability);

    registry.reconcile({ observed: [observedSession("http-instance-000001", true)], retained: new Set() });
    const required = await readSseEvent(reader);
    expect(required).toContain("event: session_upsert");
    expect(required).toContain('"revision":2');
    expect(required).toContain('"inputRequired":true');
    expect(required).not.toContain(viewCapability);

    registry.reconcile({ observed: [observedSession("http-instance-000001", false)], retained: new Set() });
    const cleared = await readSseEvent(reader);
    expect(cleared).toContain('"revision":3');
    expect(cleared).toContain('"inputRequired":false');
    expect((await handler(launchRequest(), peer)).status).toBe(200);
    await reader.cancel();
  });

  test("closes an unread SSE stream after keepalive saturation without registry changes", async () => {
    const registry = populatedRegistry();
    const handler = createTestHttpHandler({ config: config(), registry, staticAssets: assets, sseKeepaliveMs: 1 });
    const sse = await handler(request("/api/v1/events"), peer);
    expect(sse.status).toBe(200);
    const reader = sse.body?.getReader();
    if (reader === undefined) throw new Error("missing SSE body");
    try {
      // Leave the body unread across more timer turns than its bounded queue can hold.
      // Separate waits let keepalives run even when the test process is heavily scheduled.
      for (let tick = 0; tick < 100; tick += 1) await Bun.sleep(2);
      expect(await readSseEvent(reader)).toContain("event: snapshot");
      // The snapshot and at most 64 keepalives fit before the slow-consumer cutoff.
      let closed = false;
      for (let frame = 0; frame < 65; frame += 1) {
        const chunk = await reader.read();
        if (chunk.done) {
          closed = true;
          break;
        }
        expect(new TextDecoder().decode(chunk.value)).toBe("event: keepalive\ndata: {}\n\n");
      }
      expect(closed).toBe(true);
    } finally {
      await reader.cancel();
    }
  });

  test("admits an SSE stream with one snapshot and no repeated or reordered revision", async () => {
    let monotonic = 1_000;
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      clock: { monotonicNowMs: () => monotonic, wallNowIso: () => "2026-07-19T00:00:00.000Z" },
    });
    registry.reconcile({ observed: [observedSession("http-instance-000001")], retained: new Set() });
    monotonic += 35_000;
    const handler = createTestHttpHandler({ config: config(), registry, staticAssets: assets, sseKeepaliveMs: 60_000 });
    const sse = await handler(request("/api/v1/events"), peer);
    const reader = sse.body?.getReader();
    if (reader === undefined) throw new Error("missing SSE body");
    const framed = (text: string): [string, unknown] => {
      const data: unknown = JSON.parse(text.slice(text.indexOf("data: ") + "data: ".length));
      if (typeof data !== "object" || data === null || !("revision" in data)) {
        throw new Error("SSE frame carries no revision");
      }
      return [text.slice("event: ".length, text.indexOf("\n")), data.revision];
    };

    // Admission sweeps the expired record, so that removal is already inside the snapshot revision and
    // must not also be framed; the two later upserts must each arrive once, in revision order.
    const snapshot = await readSseEvent(reader);
    registry.reconcile({ observed: [observedSession("http-instance-000002")], retained: new Set() });
    registry.reconcile({
      observed: [observedSession("http-instance-000002"), observedSession("http-instance-000003")],
      retained: new Set(),
    });
    const frames = [snapshot, await readSseEvent(reader), await readSseEvent(reader)];

    expect(frames.map(text => framed(text))).toEqual([
      ["snapshot", 2],
      ["session_upsert", 3],
      ["session_upsert", 4],
    ]);
    expect(snapshot).toContain('"sessions":[]');
    expect(frames.join("")).not.toContain(viewCapability);
    await reader.cancel();
  });

  test("releases exactly one requested capability with no-store", async () => {
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const response = await handler(launchRequest(), peer);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(payload.capability).toBe(viewCapability);
    expect(JSON.stringify(payload)).not.toContain(controlCapability);
  });

  test("returns a no-store 404 when a host disappears before launch", async () => {
    const registry = populatedRegistry();
    const handler = createTestHttpHandler({ config: config(), registry, staticAssets: assets });
    registry.reconcile({ observed: [], retained: new Set() });

    const response = await handler(launchRequest(), peer);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  test("refuses control with mode_unavailable when the host now shares view-only", async () => {
    const registry = populatedRegistry();
    const handler = createTestHttpHandler({ config: config(), registry, staticAssets: assets });
    registry.reconcile({ observed: [{ ...observedSession(), canControl: false }], retained: new Set() });

    const response = await handler(launchRequest(3, "control"), peer);
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ code: "mode_unavailable" });
    expect((await handler(launchRequest(3, "view"), peer)).status).toBe(200);
  });

  test("enforces the launch rate-limit boundary and resets it at the window edge", async () => {
    let now = 1_000;
    const handler = createTestHttpHandler({
      config: config(),
      registry: populatedRegistry(),
      staticAssets: assets,
      now: () => now,
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await handler(launchRequest(), peer)).status).toBe(200);
    }
    const limited = await handler(launchRequest(), peer);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: "rate_limited", message: "Too many requests" });

    now += 60_000;
    const reset = await handler(launchRequest(), peer);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ mode: "view", generation: 3, capability: expect.any(String) });
  });

  test("shares the launch window within one identity without coupling another allowed identity", async () => {
    const base = config();
    const gatewayConfig: GatewayConfig = {
      ...base,
      auth: { ...base.auth, allowedLogins: ["allowed@example.com", "other@example.com"] },
    };
    const handler = createTestHttpHandler({
      config: gatewayConfig,
      registry: populatedRegistry(),
      staticAssets: assets,
      now: () => 1_000,
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await handler(launchRequest(), peer)).status).toBe(200);
    }
    expect(
      (await handler(launchRequest(3, "view", "http-instance-999999"), peer)).status,
    ).toBe(429);
    expect(
      (await handler(launchRequest(3, "view", "http-instance-000001", undefined, "other@example.com"), peer)).status,
    ).toBe(200);
  });

  test("rejects a launch body declared over the endpoint maximum", async () => {
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const response = await handler(
      request("/api/v1/sessions/http-instance-000001/launch", {
        method: "POST",
        headers: {
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Content-Length": "4097",
        },
        body: JSON.stringify({ mode: "view", generation: 3 }),
      }),
      peer,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "bad_request", message: "Invalid request" });
  });

  test("rejects streamed launch bodies that cross the maximum with an acceptable or absent declaration", async () => {
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const json = JSON.stringify({ mode: "view", generation: 3 });
    const firstChunk = new TextEncoder().encode(json + " ".repeat(4_096 - json.length));
    const finalChunk = new TextEncoder().encode(" ");
    const streamedRequest = (declaredLength?: string): Request =>
      request("/api/v1/sessions/http-instance-000001/launch", {
        method: "POST",
        headers: {
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          ...(declaredLength === undefined ? {} : { "Content-Length": declaredLength }),
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(firstChunk);
            controller.enqueue(finalChunk);
            controller.close();
          },
        }),
      });

    for (const declaredLength of ["4096", undefined]) {
      const response = await handler(streamedRequest(declaredLength), peer);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "bad_request", message: "Invalid request" });
    }
  });

  test("revalidates request-bound control launches at capability release", async () => {
    const requestIds = ["http-request-id-000001", "http-request-id-000002"];
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      requestIdFactory: () => requestIds.shift() ?? "http-request-id-fallback",
    });
    registry.reconcile({ observed: [observedSession("http-instance-000001", true)], retained: new Set() });
    const handler = createTestHttpHandler({ config: config(), registry, staticAssets: assets });

    expect((await handler(launchRequest(3, "control", "http-instance-000001", "http-request-id-000001"), peer)).status).toBe(200);
    registry.reconcile({ observed: [observedSession("http-instance-000001", false)], retained: new Set() });
    registry.reconcile({ observed: [observedSession("http-instance-000001", true)], retained: new Set() });
    const stale = await handler(
      launchRequest(3, "control", "http-instance-000001", "http-request-id-000001"),
      peer,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "request_mismatch" });
    expect((await handler(launchRequest(3, "control", "http-instance-000001", "http-request-id-000002"), peer)).status).toBe(200);
    expect((await handler(launchRequest(3, "view", "http-instance-000001", "http-request-id-000002"), peer)).status).toBe(400);
  });

  /**
   * OMP accepts an 8-character instance id, and a real host used one. The gateway used to require
   * 16, so it admitted that host from discovery and then rejected it at the launch route — and the
   * browser rejected the whole directory response, blanking every session card.
   */
  test("launches the shortest instance ID OMP will mint", async () => {
    const instanceId = "a1b2c3d4";
    const handler = createTestHttpHandler({
      config: config(),
      registry: populatedRegistry(instanceId),
      staticAssets: assets,
    });
    const response = await handler(launchRequest(3, "view", instanceId), peer);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).capability).toBe(viewCapability);
  });

  test("rejects malformed and encoded-separator instance IDs", async () => {
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    expect((await handler(launchRequest(3, "view", "http%instance00001"), peer)).status).toBe(400);
    // Below OMP's own minimum, and uppercase outside its alphabet: neither can name a real host.
    expect((await handler(launchRequest(3, "view", "a1b2c3d"), peer)).status).toBe(400);
    expect((await handler(launchRequest(3, "view", "Instance-000001"), peer)).status).toBe(400);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance%2F000001/launch", {
            method: "POST",
            headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "view", generation: 3 }),
          }),
          peer,
        )
      ).status,
    ).toBe(400);
  });

  test("enforces generation, origin, fetch metadata, media type, and body shape", async () => {
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    expect((await handler(launchRequest(2), peer)).status).toBe(409);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance-000001/launch", {
            method: "POST",
            headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "view", generation: 3 }),
          }),
          peer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance-000001/launch", {
            method: "POST",
            headers: { Origin: origin, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "view", generation: 3 }),
          }),
          peer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance-000001/launch", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "text/plain" },
            body: "{}",
          }),
          peer,
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handler(
          request("/api/v1/sessions/http-instance-000001/launch", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "view", generation: 3, extra: true }),
          }),
          peer,
        )
      ).status,
    ).toBe(400);
  });

  test("authenticates and strictly validates persistent browser push subscriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-http-push-"));
    const base = config();
    const gatewayConfig: GatewayConfig = {
      ...base,
      paths: {
        configDir: join(root, "config"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        tokenPath: join(root, "config", "readiness-token"),
        configPath: join(root, "config", "config.json"),
      },
    };
    const registry = populatedRegistry();
    const pushService = await PushService.open({
      config: gatewayConfig,
      registry,
      transport: { async send(): Promise<void> {} },
    });
    const handler = createTestHttpHandler({ config: gatewayConfig, registry, staticAssets: assets, pushService });
    const configResponse = await handler(request("/api/v1/push/config"), peer);
    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("Cache-Control")).toContain("no-store");
    expect((await configResponse.json()) as Record<string, unknown>).toMatchObject({
      version: 2,
      applicationServerKey: expect.any(String),
      subscriptionCount: 0,
    });

    const body = {
      version: 2,
      detailLevel: "preview",
      subscription: {
        endpoint: "https://push.example.test/send/http-device",
        expirationTime: null,
        keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
      },
    };
    const mutation = (value: unknown, requestOrigin = origin): Request =>
      request("/api/v1/push/subscription", {
        method: "POST",
        headers: {
          Origin: requestOrigin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(value),
      });
    expect((await handler(mutation(body, "https://evil.example"), peer)).status).toBe(403);
    expect((await handler(mutation({ ...body, prompt: "PROMPT_CONTENT_CANARY" }), peer)).status).toBe(400);
    const subscriptionResponse = await handler(mutation(body), peer);
    expect(subscriptionResponse.status).toBe(200);
    expect(await subscriptionResponse.json()).toEqual({ version: 2, detailLevel: "preview" });
    const state = await Bun.file(join(root, "state", "push-state.json")).text();
    expect(state).toContain(body.subscription.endpoint);
    expect(state).not.toContain("PROMPT_CONTENT_CANARY");
    await pushService.stop();
    await rm(root, { recursive: true, force: true });
  });

  test.skipIf(process.platform === "win32")("R2 authenticated current asks expose only their qualification log alias", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gateway-http-alias-")));
    const logs = join(root, "logs"); await mkdir(logs, { mode: 0o700 });
    const base = config();
    const gatewayConfig = { ...base, paths: { ...base.paths, stateDir: join(root, "state"), configDir: join(root, "config"), runtimeDir: join(root, "run") } };
    const registry = populatedRegistry();
    const logger = new SafeLogger(new QualificationLogSink(logs));
    const pushService = await PushService.open({ config: gatewayConfig, registry, logger,
      transport: { async send() { throw Object.assign(new Error("SYNTHETIC-PROVIDER-BODY"), { statusCode: 503 }); } } });
    try {
      await pushService.subscribe("allowed@example.com", { version: 2, detailLevel: "private", subscription: {
        endpoint: "https://push.example.test/send/fixture", expirationTime: null, keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
      } });
      registry.reconcile({ observed: [observedSession("http-instance-000001", true)], retained: new Set() });
      await pushService.flush();
      const handler = createTestHttpHandler({ config: gatewayConfig, registry, staticAssets: assets, pushService, logger });
      const response = await handler(request("/api/v1/sessions"), peer);
      const body = await response.json();
      const current = body.sessions[0];
      expect(Number.isSafeInteger(current.qualificationPushAlias)).toBe(true);
      expect(current.qualificationPushAlias).toBeGreaterThan(0);
      expect(pushService.qualificationAlias({ ...current, generation: current.generation + 1 })).toBeUndefined();
      expect(pushService.qualificationAlias({ ...current, ask: { ...current.ask, requestId: "foreign-request-0001" } })).toBeUndefined();
      expect(pushService.qualificationAlias({ ...current, instanceId: "foreign-instance-0001" })).toBeUndefined();
      expect(validateSessionList(body)).toBe(true);
      expect((await handler(request("/api/v1/sessions", {}, ""), peer)).status).toBe(403);
      const ordinary = createTestHttpHandler({ config: gatewayConfig, registry, staticAssets: assets, logger });
      expect((await (await ordinary(request("/api/v1/sessions"), peer)).json()).sessions[0].qualificationPushAlias).toBeUndefined();
      const text = await readFile(join(logs, "events.0.jsonl"), "utf8");
      for (const name of ["push.queue_accepted", "push.send_started", "push.send_failed"]) {
        expect(text.trimEnd().split("\n").map(line => JSON.parse(line)).find(event => event.event === name)?.request_alias).toBe(current.qualificationPushAlias);
      }
      for (const forbidden of [current.instanceId, current.ask.requestId, "SYNTHETIC-PROVIDER-BODY", "push.example.test"]) expect(text).not.toContain(forbidden);
      registry.reconcile({ observed: [observedSession("http-instance-000001", false)], retained: new Set() });
      registry.reconcile({ observed: [observedSession("http-instance-000001", true)], retained: new Set() });
      await pushService.flush();
      const fresh = (await (await handler(request("/api/v1/sessions"), peer)).json()).sessions[0];
      expect(fresh.qualificationPushAlias).toBeGreaterThan(current.qualificationPushAlias);
      expect(pushService.qualificationAlias(current)).toBeUndefined();
    } finally { await pushService.stop(); await rm(root, { recursive: true, force: true }); }
  });

  test("isolates push DELETE mutations by authenticated identity for same and other endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-http-push-isolation-"));
    const base = config();
    const gatewayConfig: GatewayConfig = {
      ...base,
      auth: { ...base.auth, allowedLogins: ["allowed@example.com", "other@example.com"] },
      paths: {
        configDir: join(root, "config"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        tokenPath: join(root, "config", "readiness-token"),
        configPath: join(root, "config", "config.json"),
      },
    };
    const registry = populatedRegistry();
    const pushService = await PushService.open({
      config: gatewayConfig,
      registry,
      transport: { async send(): Promise<void> {} },
    });
    const handler = createTestHttpHandler({ config: gatewayConfig, registry, staticAssets: assets, pushService });
    const sharedEndpoint = "https://push.example.test/send/shared-device";
    const otherEndpoint = "https://push.example.test/send/other-device";
    const mutate = (method: "POST" | "DELETE", identity: string, value: unknown): Request =>
      request(
        "/api/v1/push/subscription",
        {
          method,
          headers: {
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(value),
        },
        identity,
      );
    const subscription = (endpoint: string) => ({
      version: 2,
      subscription: {
        endpoint,
        expirationTime: null,
        keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
      },
    });

    expect((await handler(mutate("POST", "allowed@example.com", subscription(sharedEndpoint)), peer)).status).toBe(200);
    expect((await handler(mutate("POST", "other@example.com", subscription(sharedEndpoint)), peer)).status).toBe(200);
    expect((await handler(mutate("POST", "other@example.com", subscription(otherEndpoint)), peer)).status).toBe(200);
    const statePath = join(root, "state", "push-state.json");
    const beforeDeniedDeletes = await Bun.file(statePath).text();
    expect(beforeDeniedDeletes).toContain(sharedEndpoint);
    expect(beforeDeniedDeletes).toContain(otherEndpoint);

    for (const endpoint of [sharedEndpoint, otherEndpoint]) {
      const deniedDelete = await handler(
        mutate("DELETE", "allowed@example.com", { version: 2, endpoint }),
        peer,
      );
      expect(deniedDelete.status).toBe(204);
      expect(await deniedDelete.text()).toBe("");
    }
    expect(await Bun.file(statePath).text()).toBe(beforeDeniedDeletes);

    const ownDelete = await handler(
      mutate("DELETE", "other@example.com", { version: 2, endpoint: otherEndpoint }),
      peer,
    );
    expect(ownDelete.status).toBe(204);
    expect(await ownDelete.text()).toBe("");
    const afterOwnDelete = await Bun.file(statePath).text();
    expect(afterOwnDelete).toContain(sharedEndpoint);
    expect(afterOwnDelete).not.toContain(otherEndpoint);
    await pushService.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("applies security headers to static and API responses", async () => {
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    for (const response of [await handler(request("/"), peer), await handler(request("/api/v1/sessions"), peer)]) {
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
      expect(response.headers.has("Access-Control-Allow-Origin")).toBeFalse();
    }
  });

  test("rejects query-bearing assets and client routes while mapping clean client routes to the PWA shell", async () => {
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const rejected = await handler(request(`/assets/app.0123456789ab.js?token=${viewCapability}`), peer);
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("Cache-Control")).toContain("no-store");

    const rejectedClient = await handler(
      request("/client/?handoff=7a2cadc8-c634-4a4e-9045-bc7001a034a7"),
      peer,
    );
    expect(rejectedClient.status).toBe(400);
    expect(rejectedClient.headers.get("Cache-Control")).toContain("no-store");

    const client = await handler(request("/client/"), peer);
    expect(client.status).toBe(200);
    expect(client.headers.get("Cache-Control")).toContain("no-store");
    expect(await client.text()).toContain("OMP Sessions");
    const update = await handler(request("/update/"), peer);
    expect(update.status).toBe(200);
    expect(update.headers.get("Cache-Control")).toContain("no-store");
    expect(await update.text()).toContain("OMP Sessions");
    const attention = await handler(
      request("/collab/http-instance-000001?request=http-request-identity-0001"),
      peer,
    );
    expect(attention.status).toBe(200);
    expect(attention.headers.get("Cache-Control")).toContain("no-store");
    expect(await attention.text()).toContain("OMP Sessions");
    expect((await handler(request("/collab/short?request=http-request-identity-0001"), peer)).status).toBe(400);
    expect((await handler(request("/collab/http-instance-000001?request=short"), peer)).status).toBe(400);
  });

  test("serves stop notification navigation as the no-store PWA shell and refuses ambiguous routes", async () => {
    const shellRoot = new URL("../../web/src/", import.meta.url);
    const shellAssets = await StaticAssetStore.load(fileURLToPath(shellRoot));
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: shellAssets });
    const shell = await Bun.file(new URL("index.html", shellRoot)).text();
    for (const query of ["activity=stopped&generation=1", "generation=9007199254740991&activity=stopped"]) {
      const response = await handler(request("/collab/http-instance-000001?" + query), peer);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expect(await response.text()).toBe(shell);
    }
    for (const path of [
      "/collab/short?activity=stopped&generation=1",
      "/collab/invalid_id?activity=stopped&generation=1",
      "/collab/%FF?activity=stopped&generation=1",
      ...[
        "activity=stopped", "activity=stopped&generation=0", "activity=stopped&generation=01",
        "activity=stopped&generation=1.0", "activity=stopped&generation=1e2",
        "activity=stopped&generation=9007199254740992", "activity=stopped&generation=-1",
        "activity=stopped&generation=1&generation=1", "activity=stopped&activity=stopped&generation=1",
        "activity=stopped&generation=1&extra=1", "activity=stopped&generation=1&request=http-request-identity-0001",
        "request=http-request-identity-0001&request=http-request-identity-0001",
      ].map(query => "/collab/http-instance-000001?" + query),
    ]) {
      const response = await handler(request(path), peer);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "bad_request" });
    }
  });

  test("never writes capability-bearing data to structured logs", async () => {
    const lines: string[] = [];
    const logger = new SafeLogger({ write: line => lines.push(line) });
    const handler = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets, logger });
    await handler(launchRequest(), peer);
    await handler(request("/api/v1/sessions", {}, "denied@example.com"), peer);
    expect(lines.join("\n")).not.toContain(viewCapability);
    expect(lines.join("\n")).not.toContain(controlCapability);
    expect(lines.join("\n")).not.toContain("denied@example.com");
  });
});

describe("browser-direct fleet boundary", () => {
  test("exposes only exact creation routes with authenticated header-minimal preflight and no credential grant", async () => {
    const dashboard = "https://dashboard.example.ts.net";
    const base = config();
    const handler = createTestHttpHandler({ config: { ...base, http: { ...base.http, trustedDashboardOrigins: [dashboard] } },
      registry: populatedRegistry(), staticAssets: assets, creationService: creationStub() });
    for (const [path, method] of [["/api/v1/session-creation-options", "GET"],
      ["/api/v1/session-creations", "POST"], [`/api/v1/session-creations/${creationId}`, "GET"]] as const) {
      const response = await handler(request(path, { method: "OPTIONS", headers: { Origin: dashboard,
        "Access-Control-Request-Method": method, ...(method === "POST" ? { "Access-Control-Request-Headers": "content-type" } : {}) } }), peer);
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(dashboard);
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(response.headers.get("Access-Control-Max-Age")).toBeNull();
      for (const identity of ["", "unauthorized@example.com"]) {
        const denied = await handler(request(path, { method: "OPTIONS", headers: { Origin: dashboard, "Access-Control-Request-Method": method } }, identity), peer);
        expect(denied.status).toBe(403); expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
      }
      const extra = await handler(request(path, { method: "OPTIONS", headers: { Origin: dashboard,
        "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization" } }), peer);
      expect(extra.status).toBe(403); expect(extra.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    for (const type of ["application/json; charset=utf-8", "Application/JSON", "text/plain"]) {
      const response = await handler(request("/api/v1/session-creations", { method: "POST", headers: {
        Origin: dashboard, "Sec-Fetch-Site": "cross-site", "Content-Type": type }, body: JSON.stringify(creationBody) }), peer);
      expect(response.status).toBe(403);
    }
    const created = await handler(request("/api/v1/session-creations", { method: "POST", headers: {
      Origin: dashboard, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" }, body: JSON.stringify(creationBody) }), peer);
    expect(created.status).toBe(202); expect(created.headers.get("Access-Control-Allow-Origin")).toBe(dashboard);
    expect(created.headers.get("Cache-Control")).toContain("no-store");
    expect(created.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(await created.text()).not.toMatch(/capability|argv|env|path/u);
    const rejected = await handler(request("/api/v1/session-creations/not-a-uuid", { headers: { Origin: dashboard } }), peer);
    expect(rejected.status).toBe(403); expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  const dashboard = "https://dashboard.example.ts.net";
  const target = { id: "remote", label: "Remote", origin: "https://remote.example.ts.net" };
  const launchPath = "/api/v1/sessions/http-instance-000001/launch";

  function fleetConfig(): GatewayConfig {
    const base = config();
    return {
      ...base,
      http: { ...base.http, trustedDashboardOrigins: [dashboard] },
      fleet: { label: "Studio", targets: [target] },
      speech: { browserRecognition: true },
    };
  }

  function remoteLaunch(headers: Record<string, string> = {}, body = JSON.stringify({ mode: "view", generation: 3 })): Request {
    return request(launchPath, {
      method: "POST",
      headers: { Origin: dashboard, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json", ...headers },
      body,
    });
  }

  function preflight(path = launchPath, method = "POST", headers: Record<string, string> = {}, identity?: string): Request {
    return request(path, {
      method: "OPTIONS",
      headers: { Origin: dashboard, "Access-Control-Request-Method": method, ...headers },
    }, identity);
  }

  function expectCors(response: Response, allowedOrigin = dashboard): void {
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(allowedOrigin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  }

  function expectNoCors(response: Response): void {
    for (const key of ["Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers"]) {
      expect(response.headers.get(key)).toBeNull();
    }
  }

  test("serves the named public client config only through authenticated same-origin requests", async () => {
    const gatewayConfig = fleetConfig();
    const handler = createTestHttpHandler({ config: gatewayConfig, registry: populatedRegistry(), staticAssets: assets });
    for (const headers of [{}, { Origin: origin }]) {
      const response = await handler(request("/api/v1/client-config", { headers }), peer);
      expect(response.status).toBe(200);
      expectNoCors(response);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      const body = await response.json();
      expect(validateClientConfig(body)).toBe(true);
      expect(body).toEqual({
        version: 1,
        local: { id: "local", label: "Studio", origin },
        targets: [target],
        speech: { browserRecognition: true },
      });
      expect(JSON.stringify(body)).not.toContain("allowed@example.com");
      expect(JSON.stringify(body)).not.toContain("/private");
      expect(JSON.stringify(body)).not.toContain(dashboard);
    }
    for (const foreign of [dashboard, "https://untrusted.example", "null"]) {
      const response = await handler(request("/api/v1/client-config", { headers: { Origin: foreign } }), peer);
      expect(response.status).toBe(403);
      expectNoCors(response);
    }
    expect((await handler(request("/api/v1/client-config", {}, ""), peer)).status).toBe(403);
    expect((await handler(request("/api/v1/client-config?extra=1"), peer)).status).toBe(400);
    expect(validateClientConfig({
      version: 2, local: { id: "local", label: "Studio", origin }, targets: [], speech: { browserRecognition: false },
    })).toBe(false);
  });

  test("admits configured dashboards for metadata and generation-bound launch without credentials", async () => {
    const handler = createTestHttpHandler({ config: fleetConfig(), registry: populatedRegistry(), staticAssets: assets });
    const list = await handler(request("/api/v1/sessions", { headers: { Origin: dashboard } }), peer);
    expect(list.status).toBe(200);
    expectCors(list);
    expect(validateSessionList(await list.json())).toBe(true);
    for (const site of [undefined, "same-site", "cross-site"]) {
      const launch = remoteLaunch();
      if (site === undefined) launch.headers.delete("Sec-Fetch-Site");
      else launch.headers.set("Sec-Fetch-Site", site);
      const response = await handler(launch, peer);
      expect(response.status).toBe(200);
      expectCors(response);
      expect(await response.json()).toEqual({ mode: "view", generation: 3, capability: viewCapability });
    }
    const local = await handler(launchRequest(), peer);
    expect(local.status).toBe(200);
    expectNoCors(local);
    const noOrigin = await handler(request("/api/v1/sessions"), peer);
    expect(noOrigin.status).toBe(200);
    expectNoCors(noOrigin);
  });

  test("refuses untrusted, null, malformed and multiple dashboard origins", async () => {
    const handler = createTestHttpHandler({ config: fleetConfig(), registry: populatedRegistry(), staticAssets: assets });
    for (const foreign of [
      "https://untrusted.example", "null", dashboard + "/", "not an origin", `${dashboard}, ${dashboard}`,
      `${dashboard} https://untrusted.example`,
    ]) {
      for (const req of [
        request("/api/v1/sessions", { headers: { Origin: foreign } }),
        request("/api/v1/sessions?extra=1", { headers: { Origin: foreign } }),
        remoteLaunch({ Origin: foreign }),
      ]) {
        const response = await handler(req, peer);
        expect(response.status).toBe(403);
        expectNoCors(response);
      }
    }
    const multiple = request("/api/v1/sessions", { headers: [["Origin", dashboard], ["Origin", "https://untrusted.example"]] });
    expectNoCors(await handler(multiple, peer));
    const unconfigured = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const denied = await unconfigured(request("/api/v1/sessions", { headers: { Origin: dashboard } }), peer);
    expect(denied.status).toBe(403);
    expectNoCors(denied);
  });

  test("requires the separate trusted-dashboard launch context without weakening local mutations", async () => {
    const gatewayConfig = fleetConfig();
    const handler = createTestHttpHandler({ config: gatewayConfig, registry: populatedRegistry(), staticAssets: assets });
    for (const headers of [
      { "Sec-Fetch-Site": "none" }, { "Sec-Fetch-Site": "same-origin" }, { "Content-Type": "Application/JSON" },
      { "Content-Type": "application/json; charset=utf-8" }, { "Content-Type": "text/plain" },
    ]) {
      const response = await handler(remoteLaunch(headers), peer);
      expect(response.status).toBe(403);
      expectCors(response);
    }
    const missingOrigin = remoteLaunch();
    missingOrigin.headers.delete("Origin");
    expect((await handler(missingOrigin, peer)).status).toBe(403);
    const untrusted = remoteLaunch({ Origin: "https://untrusted.example" });
    expect(requestHasTrustedDashboardContext(untrusted, gatewayConfig.http.trustedDashboardOrigins)).toBeUndefined();
  });

  test("admits route-specific authenticated preflights without querying OMP or spending launch tokens", async () => {
    let launches = 0;
    const handler = createHttpHandler({
      config: fleetConfig(), registry: populatedRegistry(), staticAssets: assets,
      launchResolver: { async resolve() { launches += 1; return { status: "missing" }; } },
    });
    for (let index = 0; index < 25; index += 1) {
      const response = await handler(preflight(), peer);
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(dashboard);
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
      expect(response.headers.get("Vary")).toBe("Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(response.headers.get("Access-Control-Max-Age")).toBeNull();
      expect(await response.text()).toBe("");
    }
    expect(launches).toBe(0);
    for (const requested of ["content-type", "CONTENT-TYPE"]) {
      expect((await handler(preflight(launchPath, "POST", { "Access-Control-Request-Headers": requested }), peer)).status).toBe(204);
    }
    const get = await handler(preflight("/api/v1/sessions", "GET"), peer);
    expect(get.status).toBe(204);
    expect(get.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(get.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect((await handler(remoteLaunch(), peer)).status).toBe(404);
    expect(launches).toBe(1);
  });

  test("preflight cannot bypass identity trust, loopback, allowlist or second-hop checks", async () => {
    const base = fleetConfig();
    const gatewayConfig: GatewayConfig = { ...base, auth: { mode: "tailscale-serve", allowedLogins: base.auth.allowedLogins } };
    const handler = createTestHttpHandler({
      config: gatewayConfig, registry: populatedRegistry(), staticAssets: assets, tailnetPresent: () => true,
    });
    const unsound = createTestHttpHandler({
      config: gatewayConfig, registry: populatedRegistry(), staticAssets: assets, tailnetPresent: () => false,
    });
    for (const response of [
      await handler(preflight(launchPath, "POST", {}, ""), peer),
      await handler(preflight(launchPath, "POST", {}, "other@example.com"), peer),
      await handler(preflight(), { address: "192.168.1.20" }),
      await handler(preflight(launchPath, "POST", { "X-Forwarded-Host": "other.example" }), peer),
      await unsound(preflight(), peer),
    ]) {
      expect(response.status).toBe(403);
      expectNoCors(response);
    }
  });

  test("rejects wrong preflight methods, extra headers and every non-fleet route without CORS", async () => {
    const handler = createTestHttpHandler({ config: fleetConfig(), registry: populatedRegistry(), staticAssets: assets });
    for (const req of [
      preflight(launchPath, "GET"), preflight("/api/v1/sessions", "POST"), preflight(launchPath, "post"),
      preflight(launchPath, "POST", { "Access-Control-Request-Headers": "x-extra" }),
      preflight(launchPath, "POST", { "Access-Control-Request-Headers": "content-type, x-extra" }),
      preflight(launchPath, "POST", { "Access-Control-Request-Headers": "content-type, content-type" }),
      preflight("/api/v1/sessions", "GET", { "Access-Control-Request-Headers": "content-type" }),
      preflight(launchPath, "POST", { Origin: "null" }),
      preflight(launchPath, "POST", { Origin: "https://untrusted.example" }),
      ...["/api/v1/events", "/api/v1/client-config", "/api/v1/push/config", "/api/v1/health", "/api/v1/unknown"].map(path => preflight(path, "GET")),
    ]) {
      const response = await handler(req, peer);
      expect(response.status).toBe(403);
      expectNoCors(response);
    }
    const missingOrigin = preflight();
    missingOrigin.headers.delete("Origin");
    const missingMethod = preflight();
    missingMethod.headers.delete("Access-Control-Request-Method");
    for (const req of [missingOrigin, missingMethod]) {
      const response = await handler(req, peer);
      expect(response.status).toBe(403);
      expectNoCors(response);
    }
    const noTrust = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    const denied = await noTrust(preflight(), peer);
    expect(denied.status).toBe(403);
    expectNoCors(denied);
    for (const path of ["/api/v1/events", "/api/v1/client-config", "/api/v1/push/config", "/api/v1/unknown"]) {
      const response = await handler(request(path, { headers: { Origin: dashboard } }), peer);
      expect(response.status).toBe(403);
      expectNoCors(response);
    }
    const health = await handler(request("/api/v1/health", { headers: { Origin: dashboard } }), peer);
    expect(health.status).toBe(200);
    expectNoCors(health);
    const asset = await handler(request("/assets/app.0123456789ab.js", { headers: { Origin: dashboard } }), peer);
    expectNoCors(asset);
  });

  test("trusted-dashboard origins never authorize local push mutations", async () => {
    const handler = createTestHttpHandler({ config: fleetConfig(), registry: populatedRegistry(), staticAssets: assets });
    for (const method of ["POST", "DELETE"]) {
      const mutation = request("/api/v1/push/subscription", {
        method, headers: { Origin: dashboard, "Content-Type": "application/json" }, body: "{}",
      });
      expect(requestHasValidMutationContext(mutation, origin)).toBe(false);
      const response = await handler(mutation, peer);
      expect(response.status).toBe(403);
      expectNoCors(response);
    }
  });

  test("adds readable CORS to admitted problems including identity denial and unexpected failures", async () => {
    const gatewayConfig = fleetConfig();
    const handler = createTestHttpHandler({ config: gatewayConfig, registry: populatedRegistry(), staticAssets: assets });
    const unauthenticated = remoteLaunch();
    unauthenticated.headers.delete("Tailscale-User-Login");
    for (const [req, status] of [
      [remoteLaunch({}, "{bad"), 400],
      [remoteLaunch({ Origin: dashboard }, JSON.stringify({ mode: "view", generation: 2 })), 409],
      [request("/api/v1/sessions/missing0/launch", {
        method: "POST", headers: { Origin: dashboard, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "view", generation: 3 }),
      }), 404],
      [unauthenticated, 403],
      [request("/api/v1/sessions?extra=1", { headers: { Origin: dashboard } }), 400],
    ] as const) {
      const response = await handler(req, peer);
      expect(response.status).toBe(status);
      expectCors(response);
    }
    const crash = createHttpHandler({
      config: gatewayConfig, registry: populatedRegistry(), staticAssets: assets,
      launchResolver: { async resolve() { throw new Error("private failure detail"); } },
    });
    const failure = await crash(remoteLaunch(), peer);
    expect(failure.status).toBe(500);
    expectCors(failure);
    expect(await failure.json()).toEqual({ code: "internal_error", message: "Internal server error" });
    for (let index = 0; index < 21; index += 1) await handler(remoteLaunch(), peer);
    const limited = await handler(remoteLaunch(), peer);
    expect(limited.status).toBe(429);
    expectCors(limited);
    for (const status of [400, 403, 404, 409, 413, 415, 429, 500]) {
      const finalized = finalizeHttpResponse(Response.json({ code: "fixture" }, { status }), gatewayConfig, {
        document: false, noStore: true, corsOrigin: dashboard,
      });
      expectCors(finalized);
    }
  });

  test("extends only document CSP and microphone policy, preserving asset and bootstrap caching", async () => {
    const handler = createTestHttpHandler({ config: fleetConfig(), registry: populatedRegistry(), staticAssets: assets });
    for (const path of ["/", "/index.html", "/client/", "/update/", "/collab/http-instance-000001?request=http-request-000001"]) {
      const response = await handler(request(path), peer);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Security-Policy")).toContain(`connect-src 'self' wss://my.omp.sh ${target.origin};`);
      expect(response.headers.get("Content-Security-Policy")).not.toContain(dashboard);
      expect(response.headers.get("Permissions-Policy")).toContain("microphone=(self)");
      expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Cache-Control")).toContain(path === "/" || path === "/index.html" ? "no-cache" : "no-store");
      expectNoCors(response);
    }
    for (const path of ["/api/v1/sessions", "/api/v1/client-config", "/api/v1/unknown", "/assets/app.0123456789ab.js", "/api/v1/events"]) {
      const response = await handler(request(path), peer);
      expect(response.headers.get("Content-Security-Policy")).not.toContain(target.origin);
      expect(response.headers.get("Permissions-Policy")).toContain("microphone=()");
      if (path === "/api/v1/events") await response.body?.cancel();
      if (path.startsWith("/assets/")) expect(response.headers.get("Cache-Control")).toContain("immutable");
    }
    const disabled = createTestHttpHandler({ config: config(), registry: populatedRegistry(), staticAssets: assets });
    expect((await disabled(request("/"), peer)).headers.get("Permissions-Policy")).toContain("microphone=()");
  });
});
