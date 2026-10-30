import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  parseNotificationRoute, parseJsonFrame, parseSessionCreationRequest, parseSessionCreationStatus,
  SESSION_CREATION_UUID_PATTERN, type FleetSource, type SessionEvent, type SessionMetadata,
  type SessionCreationOptions, type SessionCreationRequest, type SessionCreationState, type SessionCreationError,
} from "@omp-session-gateway/protocol";
import { HANG_DEADLINE_MS } from "../../../scripts/test-support.ts";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
const distRoot = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const fixtureCsp = (origins: readonly string[]): string =>
  `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' wss://my.omp.sh${origins.map(value => ` ${value}`).join("")}; manifest-src 'self'; worker-src 'self'`;

export interface DashboardFixtureOptions {
  readonly roomKey?: Uint8Array;
  /** Existing scenarios model a returning device; first-run specs opt into genuinely empty storage. */
  readonly firstRun?: boolean;
  /** In-memory audit input only; ordinary and README fixtures keep random authority. */
  readonly syntheticAuthority?: SyntheticFixtureAuthority;
}

export interface SyntheticFixtureAuthority {
  readonly roomId: string;
  readonly encodedRoomKey: string;
  readonly encodedControlEntropy: string;
}

function parseSyntheticAuthority(value: unknown): SyntheticFixtureAuthority {
  if (value === null || typeof value !== "object" ||
    !("roomId" in value) || typeof value.roomId !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(value.roomId) ||
    !("encodedRoomKey" in value) || typeof value.encodedRoomKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.encodedRoomKey) ||
    !("encodedControlEntropy" in value) || typeof value.encodedControlEntropy !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(value.encodedControlEntropy)) {
    throw new Error("visual log audit: invalid synthetic authority");
  }
  return {
    roomId: value.roomId,
    encodedRoomKey: value.encodedRoomKey,
    encodedControlEntropy: value.encodedControlEntropy,
  };
}

/** Authority crosses only a private local pipe, never argv, environment, files or fixture properties. */
export async function readSyntheticAuditAuthority(pipe: string): Promise<SyntheticFixtureAuthority> {
  try {
    const text = await new Promise<string>((resolveRead, rejectRead) => {
      const socket = createConnection(pipe);
      let text = "";
      socket.setEncoding("utf8");
      socket.setTimeout(HANG_DEADLINE_MS, () => socket.destroy(new Error("visual log audit: authority timeout")));
      socket.on("data", chunk => {
        text += chunk;
        if (text.length > 1_024) socket.destroy(new Error("visual log audit: oversized authority"));
      });
      socket.on("error", rejectRead);
      socket.on("end", () => resolveRead(text));
    });
    return parseSyntheticAuthority(JSON.parse(text));
  } catch {
    throw new Error("visual log audit: authority unavailable");
  }
}

export interface FixtureLaunchRequest {
  readonly generation: number;
  readonly instanceId: string;
  readonly mode: "view" | "control";
  readonly requestId?: string;
}

export interface DashboardFixture {
  readonly origin: string;
  readonly requests: readonly string[];
  readonly launchRequests: readonly FixtureLaunchRequest[];
  readonly requestLog: readonly FixtureRequestLog[];
  readonly creationRequests: readonly SessionCreationRequest[];
  configureCreation(config: CreationFixtureConfig): void;
  configureFleet(label: string, targets: readonly FleetSource[], trustedOrigins: readonly string[]): void;
  setListFailure(failure: "forbidden" | "timeout" | "malformed" | undefined): void;
  assertNoCapabilityMaterial(text: string): void;
  disconnectEvents(): number;
  remove(instanceId: string, generation: number): void;
  setSnapshot(sessions: readonly SessionMetadata[], revision?: number): void;
  stop(): Promise<void>;
  upsert(session: SessionMetadata): void;
  upgradeServiceWorker(): void;
}

export interface CreationFixtureConfig {
  readonly options?: SessionCreationOptions | 404;
  readonly states?: readonly { state: SessionCreationState; error?: SessionCreationError }[];
  readonly readySession?: SessionMetadata;
  readonly delayMs?: { options?: number; create?: number; status?: number };
  readonly lostAcknowledgement?: boolean;
  readonly revisionMismatchOnce?: boolean;
  readonly postProblem?: { status: number; code: string };
}
export const creationFixtureOptions: SessionCreationOptions = {
  version: 1, revision: "3a7ad103-71aa-42cb-8c29-c93ebc0bed01", available: true,
  projects: [{ id: "synthetic-project", label: "Synthetic project", workingCopies: [
    { id: "main", label: "Main" }, { id: "review", label: "Review" },
  ] }],
  profiles: [{ id: "omp", label: "OMP" }, { id: "careful", label: "Careful OMP" }],
};

export interface FixtureRequestLog {
  readonly method: string;
  readonly path: string;
  readonly origin: string | null;
  readonly fetchMode: string | null;
  readonly credentialsPresent: boolean;
}

export async function startDashboardFixture(
  initialSessions: readonly SessionMetadata[],
  options: DashboardFixtureOptions = {},
): Promise<DashboardFixture> {
  const sessions = new Map(initialSessions.map(session => [session.instanceId, session]));
  const streams = new Set<ServerResponse>();
  const requests: string[] = [];
  const launchRequests: FixtureLaunchRequest[] = [];
  const requestLog: FixtureRequestLog[] = [];
  const creationRequests: SessionCreationRequest[] = [];
  let creationConfig: CreationFixtureConfig = { options: 404 };
  let lostCreationAcknowledgement = false;
  let mismatchedCreationRevision = false;
  const creations = new Map<string, { request: SessionCreationRequest; operationId: string; cursor: number }>();
  let label = "This host";
  let targets: readonly FleetSource[] = [];
  let trustedOrigins: readonly string[] = [];
  let listFailure: "forbidden" | "timeout" | "malformed" | undefined;
  let origin = "";
  let serviceWorkerVersion = 0;
  let revision = 1;
  const authority = options.syntheticAuthority === undefined ? undefined : parseSyntheticAuthority(options.syntheticAuthority);
  const roomId = authority?.roomId ?? randomBytes(16).toString("base64url");
  const roomKey = authority !== undefined ? Buffer.from(authority.encodedRoomKey, "base64url")
    : options.roomKey === undefined ? randomBytes(32) : Buffer.from(options.roomKey);
  if (roomKey.byteLength !== 32) throw new Error("dashboard fixture room key must be 32 bytes");
  const viewCapability = `${roomId}.${roomKey.toString("base64url")}`;
  const controlEntropy = authority === undefined ? randomBytes(16) : Buffer.from(authority.encodedControlEntropy, "base64url");
  const controlCapability = `${roomId}.${Buffer.concat([roomKey, controlEntropy]).toString("base64url")}`;
  // Keep the canaries closure-owned: consumers get a predicate, never secret properties.
  const forbiddenMaterial = new Set<string>();
  for (const value of [viewCapability, controlCapability, roomId, roomKey.toString("base64url")]) {
    const segments = [value];
    for (let offset = 0; offset + 16 <= value.length; offset++) {
      segments.push(value.slice(offset, offset + 16));
    }
    for (const segment of segments) {
      forbiddenMaterial.add(segment);
      forbiddenMaterial.add(encodeURIComponent(segment));
      forbiddenMaterial.add(JSON.stringify(segment).slice(1, -1));
      forbiddenMaterial.add(segment.replace(/[&<>"']/gu, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[character]!));
      // Escaping all code points is legal too (and base64url otherwise escapes to itself).
      forbiddenMaterial.add([...segment].map(character => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
      forbiddenMaterial.add([...segment].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
      forbiddenMaterial.add([...segment].map(character => `&#${character.charCodeAt(0)};`).join(""));
      forbiddenMaterial.add([...segment].map(character => `&#x${character.charCodeAt(0).toString(16)};`).join(""));
    }
  }

  const snapshotEvent = (): SessionEvent => ({
    type: "snapshot",
    revision,
    sessions: [...sessions.values()],
  });
  const frame = (event: SessionEvent): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const broadcast = (event: SessionEvent): void => {
    const encoded = frame(event);
    for (const stream of streams) stream.write(encoded);
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      requests.push(`${method} ${url.pathname}`);
      const requestOrigin = request.headers.origin;
      requestLog.push({
        method, path: url.pathname, origin: requestOrigin ?? null,
        fetchMode: request.headers["sec-fetch-mode"] as string ?? null,
        credentialsPresent: request.headers.cookie !== undefined || request.headers.authorization !== undefined,
      });
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Content-Security-Policy", fixtureCsp([]));
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()");
      const launchPath = /^\/api\/v1\/sessions\/[^/]+\/launch$/u.test(url.pathname);
      const creationOptionsPath = url.pathname === "/api/v1/session-creation-options";
      const creationPostPath = url.pathname === "/api/v1/session-creations";
      const creationStatusId = url.pathname.startsWith("/api/v1/session-creations/") ? url.pathname.slice("/api/v1/session-creations/".length) : "";
      const creationStatusPath = SESSION_CREATION_UUID_PATTERN.test(creationStatusId);
      const routeMethod = url.pathname === "/api/v1/sessions" || creationOptionsPath || creationStatusPath ? "GET"
        : launchPath || creationPostPath ? "POST" : undefined;
      const admitted = requestOrigin !== undefined && trustedOrigins.includes(requestOrigin) &&
        routeMethod !== undefined && (method === routeMethod || method === "OPTIONS");
      if (url.pathname.startsWith("/api/")) {
        response.setHeader("Cache-Control", "no-store, max-age=0");
        response.setHeader("Pragma", "no-cache");
        if (requestOrigin !== undefined && requestOrigin !== origin && !admitted) {
          response.writeHead(403).end('{"error":"forbidden"}');
          return;
        }
      }
      if (method === "OPTIONS") {
        const requestedHeaders = request.headers["access-control-request-headers"];
        if (!admitted || url.search !== "" || request.headers["access-control-request-method"] !== routeMethod ||
          (requestedHeaders !== undefined && (routeMethod !== "POST" || requestedHeaders.toString().toLowerCase() !== "content-type"))) {
          response.writeHead(403).end('{"error":"forbidden"}');
          return;
        }
        response.setHeader("Access-Control-Allow-Origin", requestOrigin!);
        response.setHeader("Access-Control-Allow-Methods", routeMethod!);
        if (routeMethod === "POST") response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
        response.writeHead(204).end();
        return;
      }
      if (admitted) {
        response.setHeader("Access-Control-Allow-Origin", requestOrigin!);
        response.setHeader("Vary", "Origin");
      }
      if ((creationOptionsPath || creationPostPath || creationStatusPath) && method === routeMethod) {
        if (url.search !== "") { response.writeHead(400).end(); return; }
        const fetchSite = request.headers["sec-fetch-site"];
        const contextValid = (method !== "POST" || request.headers["content-type"] === "application/json") && (
          admitted ? fetchSite === undefined || fetchSite === "same-site" || fetchSite === "cross-site"
            : (requestOrigin === origin || (method === "GET" && requestOrigin === undefined)) &&
              (fetchSite === undefined || fetchSite === "same-origin")
        );
        if (!contextValid) { response.writeHead(403).end('{"code":"forbidden"}'); return; }
        response.setHeader("Content-Type", "application/json");
        const delay = creationConfig.delayMs?.[creationOptionsPath ? "options" : creationPostPath ? "create" : "status"] ?? 0;
        if (delay > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
        const configuredOptions = creationConfig.options ?? creationFixtureOptions;
        if (creationOptionsPath) {
          if (configuredOptions === 404) response.writeHead(404).end();
          else response.end(JSON.stringify(configuredOptions));
          return;
        }
        if (creationPostPath) {
          let bytes = Buffer.alloc(0);
          for await (const chunk of request) {
            bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
            if (bytes.byteLength > 4_096) { response.writeHead(400).end(); return; }
          }
          let parsed: SessionCreationRequest;
          try { parsed = parseSessionCreationRequest(parseJsonFrame(bytes)); }
          catch { response.writeHead(400).end('{"code":"malformed_request"}'); return; }
          creationRequests.push(parsed);
          const previous = creations.get(parsed.clientOperationId);
          if (previous !== undefined) {
            if (JSON.stringify(previous.request) !== JSON.stringify(parsed)) {
              response.writeHead(409).end('{"code":"operation_conflict"}');
            } else {
              const states = creationConfig.states ?? [{ state: "accepted" }, { state: "launching" }, { state: "awaiting_omp" }, { state: "ready" }];
              response.end(JSON.stringify({ operationId: previous.operationId, state: states[Math.min(previous.cursor, states.length - 1)]!.state }));
            }
            return;
          }
          if ((creationConfig.revisionMismatchOnce && !mismatchedCreationRevision) ||
            (configuredOptions !== 404 && parsed.revision !== configuredOptions.revision)) {
            mismatchedCreationRevision = true;
            response.writeHead(409).end('{"code":"revision_mismatch"}');
            return;
          }
          if (creationConfig.postProblem !== undefined) {
            response.writeHead(creationConfig.postProblem.status).end(JSON.stringify({ code: creationConfig.postProblem.code }));
            return;
          }
          if (configuredOptions === 404 || !configuredOptions.available ||
            !configuredOptions.projects.some(project => project.id === parsed.projectId && project.workingCopies.some(copy => copy.id === parsed.workingCopyId)) ||
            !configuredOptions.profiles.some(profile => profile.id === parsed.profileId)) {
            response.writeHead(400).end('{"code":"malformed_request"}');
            return;
          }
          const operation = { request: parsed, operationId: randomUUID(), cursor: 0 };
          creations.set(parsed.clientOperationId, operation);
          if (creationConfig.lostAcknowledgement && !lostCreationAcknowledgement) {
            lostCreationAcknowledgement = true;
            // A truncated acknowledgement after HTTP admission is ambiguous to the caller.
            // Resetting a reused TCP socket instead lets Chromium transparently retry the POST.
            response.writeHead(202).end('{"operationId":');
          } else response.writeHead(202).end(JSON.stringify({ operationId: operation.operationId, state: "accepted" }));
          return;
        }
        const operation = [...creations.values()].find(value => value.operationId === creationStatusId);
        if (operation === undefined) { response.writeHead(404).end(); return; }
        const states = creationConfig.states ?? [{ state: "accepted" }, { state: "launching" }, { state: "awaiting_omp" }, { state: "ready" }];
        const state = states[Math.min(operation.cursor++, states.length - 1)]!;
        const ready = creationConfig.readySession;
        if (state.state === "ready" && ready !== undefined) {
          sessions.set(ready.instanceId, ready);
          revision += 1;
          broadcast({ type: "session_upsert", revision, session: ready });
        }
        const status = parseSessionCreationStatus({
          operationId: operation.operationId, updatedAt: new Date().toISOString(), ...state,
          ...(state.state === "ready" && ready !== undefined ? { session: { instanceId: ready.instanceId, generation: ready.generation } } : {}),
        });
        response.end(JSON.stringify(status));
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/client-config") {
        if (url.search !== "") { response.writeHead(400).end(); return; }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          version: 1, local: { id: "local", label, origin }, targets,
          speech: { browserRecognition: false },
        }));
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/sessions") {
        if (url.search !== "") { response.writeHead(400).end(); return; }
        if (listFailure === "timeout") return;
        if (listFailure === "forbidden") { response.writeHead(403).end('{"error":"forbidden"}'); return; }
        if (listFailure === "malformed") { response.writeHead(200).end('{"invalid":true}'); return; }
        response.writeHead(200, {
          "Cache-Control": "no-store, max-age=0",
          "Content-Type": "application/json; charset=utf-8",
          Pragma: "no-cache",
        });
        response.end(JSON.stringify({ revision, sessions: [...sessions.values()] }));
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/health") {
        response.writeHead(200, {
          "Cache-Control": "no-store, max-age=0",
          "Content-Type": "application/json; charset=utf-8",
          Pragma: "no-cache",
        });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/push/config") {
        response.writeHead(200, {
          "Cache-Control": "no-store, max-age=0",
          "Content-Type": "application/json; charset=utf-8",
          Pragma: "no-cache",
        });
        response.end(JSON.stringify({ version: 2, applicationServerKey: "V".repeat(87), subscriptionCount: 0 }));
        return;
      }
      if (
        (method === "POST" || method === "DELETE") &&
        url.pathname === "/api/v1/push/subscription"
      ) {
        let requestBody = "";
        for await (const chunk of request) requestBody += String(chunk);
        if (method === "POST") {
          const parsed = JSON.parse(requestBody) as { detailLevel?: unknown };
          response.writeHead(200, {
            "Cache-Control": "no-store, max-age=0",
            "Content-Type": "application/json; charset=utf-8",
            Pragma: "no-cache",
          });
          response.end(JSON.stringify({
            version: 2,
            detailLevel: parsed.detailLevel ?? "session",
          }));
        } else {
          response.writeHead(204, {
            "Cache-Control": "no-store, max-age=0",
            Pragma: "no-cache",
          });
          response.end();
        }
        return;
      }
      const launchMatch = /^\/api\/v1\/sessions\/([^/]+)\/launch$/u.exec(url.pathname);
      if (method === "POST" && launchMatch !== null) {
        const fetchSite = request.headers["sec-fetch-site"];
        const contextValid = request.headers["content-type"] === "application/json" && (
          admitted ? fetchSite === undefined || fetchSite === "same-site" || fetchSite === "cross-site"
            : requestOrigin === origin && (fetchSite === undefined || fetchSite === "same-origin")
        );
        if (!contextValid) { response.writeHead(403).end('{"error":"forbidden"}'); return; }
        let requestBody = "";
        for await (const chunk of request) {
          requestBody += String(chunk);
          if (requestBody.length > 4_096) {
            response.writeHead(413).end("Too large");
            return;
          }
        }
        const instanceId = decodeURIComponent(launchMatch[1] ?? "");
        const session = sessions.get(instanceId);
        const parsed = JSON.parse(requestBody) as {
          generation?: unknown;
          mode?: unknown;
          requestId?: unknown;
        };
        if (
          session === undefined ||
          parsed.generation !== session.generation ||
          (parsed.mode !== "view" && parsed.mode !== "control") ||
          (parsed.mode === "view" && !session.canView) ||
          (parsed.mode === "control" && !session.canControl) ||
          (parsed.requestId !== undefined &&
            (parsed.mode !== "control" ||
              !session.inputRequired ||
              session.ask?.requestId !== parsed.requestId))
        ) {
          response.writeHead(409).end("Expired");
          return;
        }
        launchRequests.push({
          instanceId,
          generation: parsed.generation,
          mode: parsed.mode,
          ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}),
        });
        response.writeHead(200, {
          "Cache-Control": "no-store, max-age=0",
          "Content-Type": "application/json; charset=utf-8",
          Pragma: "no-cache",
        });
        response.end(JSON.stringify({
          generation: session.generation,
          mode: parsed.mode,
          capability: parsed.mode === "view" ? viewCapability : controlCapability,
        }));
        return;
      }
      if (method === "GET" && url.pathname === "/api/v1/events") {
        response.writeHead(200, {
          "Cache-Control": "no-store, max-age=0",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
        });
        streams.add(response);
        response.write(frame(snapshotEvent()));
        request.once("close", () => streams.delete(response));
        return;
      }
      if (method !== "GET") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (url.pathname === "/assets/fixture-returning-device.js") {
        response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
        response.end('localStorage.setItem("omp.sessions.first-run.v1", JSON.stringify({version:1,step:"done",updatedAt:"2026-10-24T00:00:00.000Z"}));');
        return;
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(404).end("Not found");
        return;
      }
      const notificationBootstrap = parseNotificationRoute(url) !== undefined;
      const relative = pathname === "/" || pathname === "/client/" || pathname === "/update/" || notificationBootstrap
        ? "index.html"
        : pathname.endsWith("/")
          ? `${pathname.slice(1)}index.html`
          : pathname.slice(1);
      const candidate = resolve(distRoot, relative);
      if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${sep}`)) {
        response.writeHead(404).end("Not found");
        return;
      }
      try {
        const body = await readFile(candidate);
        const servedBody = relative === "service-worker.js" && serviceWorkerVersion > 0
          ? Buffer.concat([body, Buffer.from(`\n// fixture update ${serviceWorkerVersion}\n`)])
          : relative === "index.html" && options.firstRun !== true
            ? Buffer.from(body.toString().replace("<head>", '<head><script src="/assets/fixture-returning-device.js"></script>'))
            : body;
        if (relative === "index.html") response.setHeader("Content-Security-Policy", fixtureCsp(targets.map(target => target.origin)));
        response.writeHead(200, {
          "Cache-Control": relative === "index.html"
            ? pathname === "/" ? "no-cache" : "no-store, max-age=0"
            : relative === "service-worker.js" ? "no-cache" : "public, max-age=31536000, immutable",
          "Content-Type": MIME_TYPES[extname(candidate)] ?? "application/octet-stream",
        });
        response.end(servedBody);
      } catch {
        response.writeHead(404).end("Not found");
      }
    } catch {
      response.writeHead(500).end("Fixture failure");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests,
    launchRequests,
    requestLog,
    creationRequests,
    configureCreation(config): void {
      creationConfig = config;
      lostCreationAcknowledgement = false;
      mismatchedCreationRevision = false;
      creations.clear();
      creationRequests.length = 0;
    },
    configureFleet(nextLabel, nextTargets, nextTrusted): void {
      label = nextLabel;
      targets = nextTargets;
      trustedOrigins = nextTrusted;
    },
    setListFailure(failure): void { listFailure = failure; },
    assertNoCapabilityMaterial(text): void {
      // Decode ordinary mixed escaping before checking, without retaining or echoing input.
      let normalized = text;
      for (let pass = 0; pass < 2; pass++) {
        normalized = normalized
          .replace(/%([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
          .replace(/\\u([0-9a-f]{4})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
          .replace(/\\\//gu, "/")
          .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/giu, (_, hex: string | undefined, decimal: string) => {
            const code = Number.parseInt(hex ?? decimal, hex === undefined ? 10 : 16);
            return code <= 0x10ffff ? String.fromCodePoint(code) : "";
          })
          .replace(/&(?:amp|lt|gt|quot|apos);/gu, entity => ({
            "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
          })[entity]!);
      }
      for (const value of forbiddenMaterial) {
        if (text.includes(value) || normalized.includes(value)) {
          throw new Error("visual safety: capability material detected");
        }
      }
    },
    disconnectEvents(): number {
      const disconnected = streams.size;
      for (const stream of streams) stream.end();
      streams.clear();
      return disconnected;
    },
    remove(instanceId, generation): void {
      const current = sessions.get(instanceId);
      if (current?.generation !== generation) return;
      sessions.delete(instanceId);
      revision += 1;
      broadcast({ type: "session_remove", revision, instanceId, generation });
    },
    setSnapshot(nextSessions, nextRevision = revision + 1): void {
      sessions.clear();
      for (const session of nextSessions) sessions.set(session.instanceId, session);
      revision = nextRevision;
      broadcast(snapshotEvent());
    },
    async stop(): Promise<void> {
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => {
          if (error === undefined) resolveClose();
          else rejectClose(error);
        });
        // A browser may retain an idle keep-alive socket after the EventSource ends. `close()`
        // stops new requests but waits for that socket indefinitely, so force only this fixture's
        // remaining HTTP connections after closing admission.
        server.closeAllConnections();
      });
    },
    upgradeServiceWorker(): void {
      serviceWorkerVersion += 1;
    },
    upsert(session): void {
      sessions.set(session.instanceId, session);
      revision += 1;
      broadcast({ type: "session_upsert", revision, session });
    },
  };
}

/** Counter the stub transport below increments, read back by {@link relaySocketCount}. */
interface RelaySocketCounter {
  __ompRelaySocketCount?: number;
}

/**
 * Replace `WebSocket` with a transport that never connects, so a fixture run stays offline and
 * deterministic instead of reaching for a real relay. The constructor count is what distinguishes
 * "reused the live socket" from "opened a new one", so it is always recorded; a test that does not
 * care simply never reads it.
 */
export async function installSilentWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counter = globalThis as typeof globalThis & RelaySocketCounter;
    counter.__ompRelaySocketCount = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: class {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly url: string;
        readyState = 0;
        binaryType = "blob";
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;

        constructor(url: string) {
          this.url = url;
          counter.__ompRelaySocketCount = (counter.__ompRelaySocketCount ?? 0) + 1;
        }

        close(): void {
          this.readyState = 3;
        }

        send(): void {}
      },
    });
  });
}

/** Number of stub sockets constructed since the page loaded. */
export function relaySocketCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (globalThis as typeof globalThis & RelaySocketCounter).__ompRelaySocketCount ?? 0,
  );
}
