import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { parseNotificationRoute, type SessionEvent, type SessionMetadata } from "@omp-session-gateway/protocol";

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

export interface DashboardFixtureOptions {
  readonly roomKey?: Uint8Array;
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
      socket.setTimeout(5_000, () => socket.destroy(new Error("visual log audit: authority timeout")));
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
  assertNoCapabilityMaterial(text: string): void;
  disconnectEvents(): number;
  remove(instanceId: string, generation: number): void;
  setSnapshot(sessions: readonly SessionMetadata[], revision?: number): void;
  stop(): Promise<void>;
  upsert(session: SessionMetadata): void;
  upgradeServiceWorker(): void;
}

export async function startDashboardFixture(
  initialSessions: readonly SessionMetadata[],
  options: DashboardFixtureOptions = {},
): Promise<DashboardFixture> {
  const sessions = new Map(initialSessions.map(session => [session.instanceId, session]));
  const streams = new Set<ServerResponse>();
  const requests: string[] = [];
  const launchRequests: FixtureLaunchRequest[] = [];
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
      if (method === "GET" && url.pathname === "/api/v1/sessions") {
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
        response.end(JSON.stringify({ version: 2, applicationServerKey: "V".repeat(87) }));
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
          : body;
        response.writeHead(200, {
          "Cache-Control": relative === "service-worker.js" ? "no-cache" : "public, max-age=60",
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

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    launchRequests,
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
