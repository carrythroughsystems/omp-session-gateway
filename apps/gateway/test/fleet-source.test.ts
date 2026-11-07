import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLEET_GRANT_LIFETIME_MS, fleetGrantVerifier, fleetOwnerDigest, parseFleetFeedEvent,
  type FleetFeedEvent, type ObservedSessionInput,
} from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import { writePrivateTextFile } from "../src/config.ts";
import { diagnosticsBundleBytes } from "../src/diagnostics.ts";
import { FleetSourceService, notificationGrantsHealthy } from "../src/fleet-source.ts";
import { createHttpHandler } from "../src/http.ts";
import { SafeLogger } from "../src/logger.ts";
import { OmpHostReader, startHostPoller, type AdoptionObservation, type OmpDiscoveryObservation } from "../src/omp-registry.ts";
import { SessionRegistry } from "../src/registry.ts";
import { StaticAssetStore } from "../src/static.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const origin = "https://source.example.ts.net";
const coordinator = "https://home.example.ts.net";
const otherCoordinator = "https://other-home.example.ts.net";
const owner = "source-owner@example.com";
const secret = "SYNTHETIC_FLEET_SECRET_CANARY_".padEnd(43, "0");
const wrongSecret = "SYNTHETIC_OTHER_FLEET_SECRET_".padEnd(43, "1");
const grantId = "a1111111-b222-4333-8444-c55555555555";
const peer = { address: "127.0.0.1" };
const cleanups: (() => void | Promise<void>)[] = [];
let assets: StaticAssetStore;
let assetRoot: string;

beforeAll(async () => {
  assetRoot = await mkdtemp(join(tmpdir(), "fleet-source-assets-"));
  await writeFile(join(assetRoot, "index.html"), "<!doctype html><title>OMP Sessions</title>");
  assets = await StaticAssetStore.load(assetRoot);
});
afterAll(async () => { await rm(assetRoot, { recursive: true, force: true }); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function session(overrides: Partial<ObservedSessionInput> = {}): ObservedSessionInput {
  return { instanceId: "fleet-source-instance-000001", generation: 3, pid: 1234, sessionId: "synthetic-session",
    title: "FLEET_TITLE_CANARY", cwdLabel: "FLEET_CWD_CANARY", model: "FLEET_MODEL_CANARY",
    startedAt: "2026-11-06T01:02:03.000Z", inputRequired: true, canControl: true, ...overrides };
}

async function fixture(options: {
  readonly warm?: boolean; readonly mode?: GatewayConfig["auth"]["mode"]; readonly heartbeatMs?: number;
  readonly write?: typeof writePrivateTextFile;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "fleet-source-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const mode = options.mode ?? "tailscale-serve";
  const publicOrigin = mode === "dev-localhost" ? "http://127.0.0.1:4317" : origin;
  const homeOrigin = mode === "dev-localhost" ? "http://127.0.0.1:4318" : coordinator;
  const config = {
    http: { hostname: "127.0.0.1" as const, port: 4317, publicOrigin,
      trustedDashboardOrigins: [homeOrigin, otherCoordinator, "https://dashboard-only.example.ts.net"] },
    fleet: { label: "Source", targets: [] }, speech: { browserRecognition: false },
    notifications: { coordinators: [{ id: "home", origin: homeOrigin }, { id: "other", origin: otherCoordinator }] },
    auth: { mode, allowedLogins: [owner, ...Array.from({ length: 20 }, (_, i) => `owner-${i}@example.com`)],
      trustIdentityWithoutTailnetDevice: true },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 1000 },
    omp: { discoveryDir: join(root, "discovery"), queryTimeoutMs: 1500 },
    paths: { configDir: join(root, "config"), stateDir: join(root, "state"), runtimeDir: join(root, "runtime"),
      configPath: join(root, "config/config.json"), tokenPath: join(root, "config/readiness-token") },
  } satisfies GatewayConfig;
  const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 1000 });
  const observations = new Set<(observation: AdoptionObservation) => void>();
  const poller = { discoveryWarm: options.warm ?? true,
    subscribeObservations(listener: (observation: AdoptionObservation) => void) {
      observations.add(listener); return () => { observations.delete(listener); };
    } };
  let now = Date.parse("2026-11-06T12:00:00.000Z");
  let topology = true;
  const logs: unknown[] = [];
  const source = await FleetSourceService.open({ config, registry, poller, now: () => now,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.write === undefined ? {} : { write: options.write }) });
  cleanups.push(() => source.stop());
  const handlerOptions = { config, registry, staticAssets: assets, fleetSourceService: source,
    launchResolver: { resolve: async () => ({ status: "missing" as const }) },
    tailnetPresent: () => topology, now: () => now,
    logger: new SafeLogger({ write: line => { logs.push(line); } }) };
  const handler = createHttpHandler(handlerOptions);
  const request = (path: string, init: RequestInit = {}, identity?: string) => {
    const headers = new Headers(init.headers);
    if (identity !== undefined) headers.set("Tailscale-User-Login", identity);
    return new Request(`${publicOrigin}${path}`, { ...init, headers });
  };
  const mutate = (path: string, body: unknown, identity = owner, requestOrigin = homeOrigin) => handler(request(path, {
    method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify(body),
  }, identity), peer);
  const create = async (id = grantId, identity = owner, requestOrigin = homeOrigin) => mutate("/api/v1/notification-grants", {
    version: 1, grantId: id, verifier: await fleetGrantVerifier(id, secret),
  }, identity, requestOrigin);
  const feed = (headers: HeadersInit = {}, targetPeer = peer) => {
    const supplied = new Headers(headers);
    if (!supplied.has("Authorization")) supplied.set("Authorization", `Bearer ${grantId}.${secret}`);
    return handler(request("/api/v1/notification-feed", { headers: supplied }), targetPeer);
  };
  return { root, config, registry, poller, source, logs, handler, handlerOptions, request, mutate, create, feed,
    homeOrigin, publicOrigin, statePath: join(config.paths.stateDir, "notification-grants.json"),
    advance(ms: number) { now += ms; }, setTopology(value: boolean) { topology = value; },
    warm() { poller.discoveryWarm = true; for (const listener of observations) listener({ round: 1, startedAt: 0,
      directoryHealthy: true, knownInstanceIds: [], hosts: [] }); } };
}

async function frame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const read = await reader.read();
  expect(read.done).toBe(false);
  return new TextDecoder().decode(read.value);
}
async function event(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<FleetFeedEvent> {
  const text = await frame(reader);
  const data = /^event: ([a-z]+)\ndata: (.+)\n\n$/u.exec(text);
  expect(data).not.toBeNull();
  const parsed = parseFleetFeedEvent(JSON.parse(data![2]!));
  expect(String(parsed.type)).toBe(data![1]!);
  return parsed;
}
function reader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  return response.body!.getReader();
}

describe("fleet source grant and authorization boundaries", () => {
  test("stores private verifiers only, binds owner/coordinator, renews expired grants and revokes durably", async () => {
    const f = await fixture();
    const created = await f.create();
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ version: 1, grantId, expiresAt: "2026-12-06T12:00:00.000Z" });
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe(coordinator);
    expect(await notificationGrantsHealthy(f.config)).toBe(true);
    const persisted = JSON.parse(await readFile(f.statePath, "utf8"));
    expect(persisted).toEqual({ version: 1, grants: [{ grantId, coordinator, owner,
      verifier: await fleetGrantVerifier(grantId, secret), expiresAt: "2026-12-06T12:00:00.000Z" }] });
    if (process.platform !== "win32") expect((await lstat(f.statePath)).mode & 0o777).toBe(0o600);
    expect((await f.mutate(`/api/v1/notification-grants/${grantId}/renew`, { version: 1 }, "owner-0@example.com")).status).toBe(401);
    expect((await f.mutate(`/api/v1/notification-grants/${grantId}/renew`, { version: 1 }, owner, otherCoordinator)).status).toBe(401);
    expect((await f.create(grantId, "owner-0@example.com")).status).toBe(409);
    expect((await f.mutate(`/api/v1/notification-grants/${grantId}/revoke`, { version: 1 }, "owner-0@example.com")).status).toBe(204);
    expect(await f.source.authenticate(`Bearer ${grantId}.${secret}`)).toBe(grantId);
    f.advance(FLEET_GRANT_LIFETIME_MS);
    expect((await f.feed()).status).toBe(401);
    expect((await f.mutate(`/api/v1/notification-grants/${grantId}/renew`, { version: 1 })).status).toBe(200);
    expect(await f.source.authenticate(`Bearer ${grantId}.${secret}`)).toBe(grantId);
    expect((await f.mutate(`/api/v1/notification-grants/${grantId}/revoke`, { version: 1 })).status).toBe(204);
    expect(JSON.parse(await readFile(f.statePath, "utf8")).grants).toEqual([]);
    expect((await f.feed()).status).toBe(401);
    expect((await f.mutate(`/api/v1/notification-grants/${grantId}/revoke`, { version: 1 })).status).toBe(204);
  });

  test("denies credential reuse on another route, source peer, or verifier and ignores forged identity", async () => {
    const f = await fixture(), other = await fixture();
    expect((await f.create()).status).toBe(201);
    expect((await other.mutate("/api/v1/notification-grants", {
      version: 1, grantId, verifier: await fleetGrantVerifier(grantId, wrongSecret),
    })).status).toBe(201);
    for (const path of ["/api/v1/sessions", "/api/v1/events", "/api/v1/client-config", "/api/v1/push/config",
      "/api/v1/session-creation-options", "/api/v1/push/fleet/status"]) {
      expect((await f.handler(f.request(path, { headers: { Authorization: `Bearer ${grantId}.${secret}` } }), peer)).status).toBe(403);
    }
    for (const path of ["/api/v1/notification-grants", `/api/v1/notification-grants/${grantId}/renew`,
      `/api/v1/notification-grants/${grantId}/revoke`, "/api/v1/push/subscription", "/api/v1/session-creations",
      "/api/v1/sessions/fleet-source-instance-000001/launch"]) {
      expect((await f.handler(f.request(path, { method: "POST", headers: { Authorization: `Bearer ${grantId}.${secret}`,
        Origin: coordinator, "Content-Type": "application/json" }, body: '{"version":1}' }), peer)).status).toBe(403);
    }
    expect((await other.feed()).status).toBe(401);
    expect((await f.feed({}, { address: "100.64.0.2" })).status).toBe(401);
    expect((await f.feed({ Authorization: `Bearer ${grantId}.${wrongSecret}` })).status).toBe(401);
    const stream = reader(await f.feed({ "Tailscale-User-Login": "forged-not-allowlisted@example.com" }));
    const snapshot = await event(stream);
    expect(snapshot.type === "snapshot" && snapshot.owner).toBe(await fleetOwnerDigest(coordinator, owner));
    await stream.cancel();
    f.setTopology(false);
    // A browser-only harness declaration is not measured machine topology.
    expect((await f.feed({ "Tailscale-User-Login": owner })).status).toBe(401);
    f.setTopology(true);
    for (const headers of [{ "X-Forwarded-For": "1.2.3.4" }, { Forwarded: "for=100.64.0.1" },
      { "X-Forwarded-Host": "other.example.ts.net" }, { "Tailscale-Funnel-Request": "true" }]) {
      expect((await f.feed(headers)).status).toBe(401);
    }
    const valid = reader(await f.feed({ "X-Forwarded-For": "100.64.0.1", "X-Forwarded-Host": "source.example.ts.net" }));
    await valid.cancel();
  });

  test("refuses every browser context and malformed bearer without CORS or input echo", async () => {
    const f = await fixture(); await f.create();
    for (const headers of [{ Origin: origin }, { Origin: coordinator }, { Origin: "null" },
      { "Sec-Fetch-Site": "none" }, { "Sec-Fetch-Mode": "cors" }, { "Sec-Fetch-Dest": "empty" },
      { "Sec-Fetch-User": "?1" }, { "Sec-Fetch-Arbitrary": "" }]) {
      const response = await f.feed(headers);
      expect(response.status).toBe(403); expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    for (const Authorization of ["", `bearer ${grantId}.${secret}`, `Bearer ${grantId.toUpperCase()}.${secret}`,
      `Bearer ${grantId}.${secret}=`, `Bearer ${grantId}.${secret} extra`, "X".repeat(8192)]) {
      const response = await f.feed({ Authorization }); expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"code":"unauthorized","message":"Unauthorized"}');
    }
  });

  test("limits feed reconnects per grant without consuming another grant's budget", async () => {
    const f = await fixture(); await f.create();
    for (let i = 0; i < 20; i++) await reader(await f.feed()).cancel();
    expect((await f.feed()).status).toBe(429);
    const id = "22222222-2222-4222-8222-222222222222";
    expect((await f.create(id, "owner-0@example.com")).status).toBe(201);
    await reader(await f.feed({ Authorization: `Bearer ${id}.${secret}` })).cancel();
    f.advance(60_000);
    await reader(await f.feed()).cancel();
  });

  test("admits loopback development feeds only for the configured request URL origin", async () => {
    const f = await fixture({ mode: "dev-localhost" }); await f.create();
    await reader(await f.feed()).cancel();
    const response = await f.handler(new Request("http://127.0.0.1:9999/api/v1/notification-feed", {
      headers: { Authorization: `Bearer ${grantId}.${secret}`, "Tailscale-User-Login": owner },
    }), peer);
    expect(response.status).toBe(401);
  });

  test("bounds malformed, duplicate-key and oversized grant input without persisting secrets", async () => {
    const f = await fixture();
    for (const body of ["{}", "null", '{"version":1,"version":1}', "not-json", JSON.stringify({ version: 2, grantId, verifier: secret }),
      JSON.stringify({ version: 1, grantId, verifier: secret, secret }), JSON.stringify({ version: 1, grantId: grantId.toUpperCase(), verifier: secret }),
      JSON.stringify({ version: 1, grantId, verifier: "short" }), "x".repeat(4097)]) {
      const response = await f.handler(f.request("/api/v1/notification-grants", { method: "POST",
        headers: { Origin: coordinator, "Content-Type": "application/json" }, body }, owner), peer);
      expect(response.status).toBe(400); expect(await response.text()).not.toContain(secret);
    }
    const streamed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4097)); } });
    expect((await f.handler(f.request("/api/v1/notification-grants", { method: "POST", body: streamed,
      headers: { Origin: coordinator, "Content-Type": "application/json" } }, owner), peer)).status).toBe(400);
    for (const contentType of ["text/plain", "application/json; charset=utf-8"]) {
      expect((await f.handler(f.request("/api/v1/notification-grants", { method: "POST", body: "{}",
        headers: { Origin: coordinator, "Content-Type": contentType } }, owner), peer)).status).toBe(403);
    }
    expect(await readdir(f.config.paths.stateDir)).toEqual([]);
    expect(JSON.stringify(f.logs)).not.toContain(secret);
  });

  test("preflights admit only exact configured and trusted coordinator origins on the three grant routes", async () => {
    const f = await fixture();
    const paths = ["/api/v1/notification-grants", `/api/v1/notification-grants/${grantId}/renew`, `/api/v1/notification-grants/${grantId}/revoke`];
    for (const path of paths) {
      const headers = { Origin: coordinator, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type" };
      const accepted = await f.handler(f.request(path, { method: "OPTIONS", headers }, owner), peer);
      expect(accepted.status).toBe(204); expect(accepted.headers.get("Access-Control-Allow-Origin")).toBe(coordinator);
      expect(accepted.headers.get("Access-Control-Allow-Methods")).toBe("POST");
      expect(accepted.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      for (const changes of [{ Origin: "https://dashboard-only.example.ts.net" }, { Origin: coordinator + "/" },
        { "Access-Control-Request-Method": "GET" }, { "Access-Control-Request-Headers": "Authorization" }]) {
        const response = await f.handler(f.request(path, { method: "OPTIONS", headers: { ...headers, ...changes } }, owner), peer);
        expect(response.status).toBe(403); expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      }
      expect((await f.handler(f.request(path, { method: "OPTIONS", headers }), peer)).status).toBe(403);
    }
    for (let i = 0; i < 25; i++) expect((await f.handler(f.request(paths[0]!, { method: "OPTIONS", headers: {
      Origin: coordinator, "Access-Control-Request-Method": "POST" } }, owner), peer)).status).toBe(204);
    expect((await f.create()).status).toBe(201);
    for (const path of ["/api/v1/notification-feed", `/api/v1/notification-grants/${grantId.toUpperCase()}/renew`,
      `/api/v1/notification-grants/${grantId}/anything`, "/api/v1/push/fleet/status"]) {
      const response = await f.handler(f.request(path, { method: "OPTIONS", headers: { Origin: coordinator,
        "Access-Control-Request-Method": "POST" } }, owner), peer);
      expect(response.status).toBe(403); expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    f.config.http.trustedDashboardOrigins.splice(0);
    expect((await f.mutate(paths[0]!, { version: 1, grantId, verifier: secret })).status).toBe(403);
  });

  test("absent notifications config returns 404 for every fleet route before origin and identity checks", async () => {
    const f = await fixture();
    const { notifications: _notifications, ...disabled } = f.config;
    const handler = createHttpHandler({ ...f.handlerOptions, config: disabled });
    for (const path of ["/api/v1/notification-grants", `/api/v1/notification-grants/${grantId}/renew`,
      `/api/v1/notification-grants/${grantId}/revoke`, "/api/v1/notification-feed", "/api/v1/push/fleet/status",
      "/api/v1/push/fleet/grants", `/api/v1/push/fleet/grants/${grantId}/activate`, "/api/v1/push/fleet/recipient"]) {
      for (const method of ["GET", "POST", "OPTIONS"]) expect((await handler(f.request(path, {
        method, headers: { Origin: coordinator } }), peer)).status).toBe(404);
    }
  });
});

describe("fleet source feed projection and lifecycle", () => {
  test("projects only identifiers and actionable Control request IDs, never forbidden-field canaries", async () => {
    const f = await fixture(); await f.create();
    f.registry.reconcile({ observed: [session(), session({ instanceId: "fleet-view-only-000002", canControl: false }),
      session({ instanceId: "fleet-idle-000000000003", inputRequired: false })], retained: new Set() });
    const snapshot = f.registry.snapshot.bind(f.registry);
    f.registry.snapshot = () => { const value = snapshot(); return { ...value, sessions: value.sessions.map(item => ({ ...item,
      capability: "FLEET_CAPABILITY_CANARY", fullPath: "/FLEET_FULL_PATH_CANARY", preview: "FLEET_PREVIEW_CANARY",
      ...(item.ask === undefined ? {} : { ask: { ...item.ask, preview: "FLEET_ASK_PREVIEW_CANARY", optionCount: 7 } }),
    })) }; };
    const stream = reader(await f.feed());
    const first = await event(stream);
    expect(first.type).toBe("snapshot");
    if (first.type !== "snapshot") throw new Error("snapshot expected");
    expect(first.sessions).toHaveLength(3);
    expect(first.sessions.find(item => item.instanceId === "fleet-source-instance-000001")?.requestId).toBeDefined();
    expect(first.sessions.filter(item => item.requestId !== undefined)).toHaveLength(1);
    const text = JSON.stringify(first);
    for (const forbidden of ["FLEET_TITLE_CANARY", "FLEET_CWD_CANARY", "FLEET_MODEL_CANARY", "FLEET_CAPABILITY_CANARY",
      "FLEET_FULL_PATH_CANARY", "FLEET_PREVIEW_CANARY", "FLEET_ASK_PREVIEW_CANARY", "optionCount", "startedAt", "lastSeenAt", "since", secret]) {
      expect(text).not.toContain(forbidden);
    }
    f.registry.reconcile({ observed: [session({ inputRequired: false, title: "FLEET_LIVE_TITLE_CANARY" })], retained: new Set() });
    const upsert = await event(stream);
    expect(upsert).toEqual({ version: 1, type: "upsert", session: { instanceId: "fleet-source-instance-000001", generation: 3 } });
    expect(JSON.stringify(upsert)).not.toContain("CANARY");
    expect((await event(stream)).type).toBe("remove");
    expect((await event(stream)).type).toBe("remove");
    await stream.cancel();
  });

  test("sends live stop edges only, revalidates queued stops, and reconnects from a fresh snapshot", async () => {
    const f = await fixture(); await f.create();
    f.registry.reconcile({ observed: [session({ inputRequired: false, busy: true })], retained: new Set() });
    const stream = reader(await f.feed()); await event(stream);
    f.registry.reconcile({ observed: [session({ inputRequired: false, busy: false })], retained: new Set() });
    expect((await event(stream)).type).toBe("upsert");
    expect(await event(stream)).toEqual({ version: 1, type: "stop", instanceId: "fleet-source-instance-000001", generation: 3 });
    f.registry.reconcile({ observed: [session({ inputRequired: false, busy: true })], retained: new Set() });
    await event(stream);
    f.registry.reconcile({ observed: [session({ inputRequired: false, busy: false })], retained: new Set() });
    f.registry.reconcile({ observed: [session({ busy: false })], retained: new Set() });
    expect((await event(stream)).type).toBe("upsert");
    const current = await event(stream);
    expect(current.type === "upsert" && current.session.requestId).toBeTruthy();
    const replacement = reader(await f.feed());
    expect((await stream.read()).done).toBe(true);
    expect((await event(replacement)).type).toBe("snapshot");
    await replacement.cancel();
  });

  test("overflow closes the bounded 256-event queue without leaking pending events", async () => {
    const f = await fixture(); await f.create();
    const stream = reader(await f.feed()); await event(stream);
    for (let generation = 1; generation <= 257; generation++) {
      f.registry.reconcile({ observed: [session({ generation, inputRequired: false })], retained: new Set() });
    }
    expect((await stream.read()).done).toBe(true);
  });

  test("a full 256-event queue still drains and rechecks authorization at write time", async () => {
    const f = await fixture(); await f.create();
    const stream = reader(await f.feed()); await event(stream);
    for (let generation = 1; generation <= 256; generation++) {
      f.registry.reconcile({ observed: [session({ generation, inputRequired: false })], retained: new Set() });
    }
    expect(await event(stream)).toEqual({ version: 1, type: "upsert",
      session: { instanceId: "fleet-source-instance-000001", generation: 1 } });
    f.config.auth.allowedLogins.splice(0);
    expect((await stream.read()).done).toBe(true);
  });

  for (const removal of ["expiry", "allowlist", "coordinator", "origin-trust", "topology"] as const) {
    test(`${removal} removal stops the live feed before another event and refuses reconnect`, async () => {
      const f = await fixture(); await f.create();
      const stream = reader(await f.feed()); await event(stream);
      if (removal === "expiry") f.advance(FLEET_GRANT_LIFETIME_MS);
      if (removal === "allowlist") f.config.auth.allowedLogins.splice(0);
      if (removal === "coordinator") f.config.notifications.coordinators.splice(0);
      if (removal === "origin-trust") f.config.http.trustedDashboardOrigins.splice(0);
      if (removal === "topology") f.setTopology(false);
      f.registry.reconcile({ observed: [session()], retained: new Set() });
      expect((await stream.read()).done).toBe(true);
      expect((await f.feed()).status).toBe(removal === "coordinator" ? 404 : 401);
    });
  }

  test("heartbeat comments close an idle stream on authorization loss", async () => {
    const f = await fixture({ heartbeatMs: 5 }); await f.create();
    const stream = reader(await f.feed()); await event(stream);
    expect(await frame(stream)).toBe(": heartbeat\n\n");
    f.config.http.trustedDashboardOrigins.splice(0);
    expect((await stream.read()).done).toBe(true);
  });

  test("expiry also closes an idle feed without a registry event", async () => {
    const f = await fixture({ heartbeatMs: 5 }); await f.create();
    const stream = reader(await f.feed()); await event(stream);
    f.advance(FLEET_GRANT_LIFETIME_MS);
    expect((await stream.read()).done).toBe(true);
  });

  test("revocation closes the stream before its durable write finishes and fails closed when unwritable", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let writes = 0;
    const f = await fixture({ write: async (...args) => {
      if (++writes > 1) { entered.resolve(); await gate.promise; throw new Error("synthetic unwritable state"); }
      await writePrivateTextFile(...args);
    } });
    await f.create();
    const original = await readFile(f.statePath, "utf8");
    const stream = reader(await f.feed()); await event(stream);
    const revoke = f.mutate(`/api/v1/notification-grants/${grantId}/revoke`, { version: 1 });
    await entered.promise;
    expect((await stream.read()).done).toBe(true);
    expect((await f.feed()).status).toBe(401);
    gate.resolve();
    expect((await revoke).status).toBe(503);
    expect((await f.feed()).status).toBe(503);
    expect(await readFile(f.statePath, "utf8")).toBe(original);
    expect(f.source.healthy).toBe(false);
  });

  test("renewal preserves bearer authorization until durable publication then reconnects with the new expiry", async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    let writes = 0;
    const f = await fixture({ write: async (...args) => {
      if (++writes > 1) { entered.resolve(); await gate.promise; }
      await writePrivateTextFile(...args);
    } });
    cleanups.push(async () => { gate.resolve(); });
    await f.create();
    const stream = reader(await f.feed());
    expect(await event(stream)).toMatchObject({ type: "snapshot", expiresAt: "2026-12-06T12:00:00.000Z" });
    f.advance(60_000);
    const renewal = f.mutate(`/api/v1/notification-grants/${grantId}/renew`, { version: 1 });
    await entered.promise;
    try {
      expect(await f.source.authenticate(`Bearer ${grantId}.${secret}`)).toBe(grantId);
      f.registry.reconcile({ observed: [session()], retained: new Set() });
      expect((await event(stream)).type).toBe("upsert");
    } finally { gate.resolve(); }
    expect((await renewal).status).toBe(200);
    expect((await stream.read()).done).toBe(true);
    const reconnected = reader(await f.feed());
    expect(await event(reconnected)).toMatchObject({ type: "snapshot", expiresAt: "2026-12-06T12:01:00.000Z" });
    await reconnected.cancel();
  });

  test("a new verified grant replaces the same owner/coordinator grant and closes its old stream", async () => {
    const f = await fixture(); await f.create();
    const stream = reader(await f.feed()); await event(stream);
    const id = "22222222-2222-4222-8222-222222222222";
    expect((await f.create(id)).status).toBe(201);
    expect((await stream.read()).done).toBe(true);
    expect((await f.feed()).status).toBe(401);
    expect(JSON.parse(await readFile(f.statePath, "utf8")).grants.map((grant: { grantId: string }) => grant.grantId)).toEqual([id]);
  });

  test("restart emits heartbeats only until a real discovery round reconciles, never an authoritative cold empty snapshot", async () => {
    const f = await fixture(); await f.create(); await f.source.stop();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const discovery = new OmpHostReader({ directory: f.config.omp.discoveryDir });
    const round = Promise.withResolvers<OmpDiscoveryObservation>();
    discovery.observe = () => round.promise;
    const poller = startHostPoller({ reader: discovery, registry, intervalMs: 60_000 });
    cleanups.push(() => poller.stop());
    expect(poller.discoveryWarm).toBe(false);
    const restarted = await FleetSourceService.open({ config: f.config, registry, poller,
      now: () => Date.parse("2026-11-06T12:00:00.000Z"), heartbeatMs: 5 });
    cleanups.push(() => restarted.stop());
    const id = await restarted.authenticate(`Bearer ${grantId}.${secret}`);
    expect(id).toBe(grantId);
    const stream = (await restarted.feed(id!, () => true)).body!.getReader();
    expect(await frame(stream)).toBe(": heartbeat\n\n");
    expect(await frame(stream)).toBe(": heartbeat\n\n");
    round.resolve({ directoryHealthy: true, retained: new Set(), hosts: [] });
    await poller.poll();
    expect(poller.discoveryWarm).toBe(true);
    expect(await event(stream)).toMatchObject({ type: "snapshot", sessions: [] });
    await stream.cancel();
  });
});

describe("fleet source state bounds and leak checks", () => {
  test("prunes expired grants before the 16-grant capacity and preserves all other owners", async () => {
    const f = await fixture();
    for (let i = 0; i < 16; i++) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      expect((await f.create(id, `owner-${i}@example.com`)).status).toBe(201);
    }
    const extra = await f.create(grantId, "owner-16@example.com");
    expect(extra.status).toBe(503); expect((await extra.json()).code).toBe("grant_capacity");
    expect(JSON.parse(await readFile(f.statePath, "utf8")).grants).toHaveLength(16);
    f.advance(FLEET_GRANT_LIFETIME_MS);
    expect((await f.create(grantId, "owner-16@example.com")).status).toBe(201);
    expect(JSON.parse(await readFile(f.statePath, "utf8")).grants).toHaveLength(1);
  });

  test("corrupt, oversized, duplicate-key and unsafe state fail closed without deleting evidence", async () => {
    const grant = { grantId, coordinator, owner, verifier: secret, expiresAt: "2026-12-06T12:00:00.000Z" };
    for (const text of ["{corrupt", '{"version":2,"grants":[]}', '{"version":1,"version":1,"grants":[]}',
      '{"version":1,"grants":[],"secret":"SYNTHETIC_CORRUPTION_CANARY"}', "x".repeat(32769),
      JSON.stringify({ version: 1, grants: [grant, grant] }),
      JSON.stringify({ version: 1, grants: [grant, { ...grant, grantId: "22222222-2222-4222-8222-222222222222" }] }),
      JSON.stringify({ version: 1, grants: Array.from({ length: 17 }, () => grant) }),
      JSON.stringify({ version: 1, grants: [{ grantId, coordinator, owner, verifier: secret, expiresAt: "not-a-date" }] })]) {
      const f = await fixture(); await f.source.stop();
      await writePrivateTextFile(f.statePath, text);
      const source = await FleetSourceService.open({ config: f.config, registry: f.registry, poller: f.poller });
      cleanups.push(() => source.stop());
      const handler = createHttpHandler({ ...f.handlerOptions, fleetSourceService: source });
      expect(source.healthy).toBe(false);
      expect(await notificationGrantsHealthy(f.config)).toBe(false);
      expect((await handler(f.request("/api/v1/notification-feed", { headers: { Authorization: `Bearer ${grantId}.${secret}` } }), peer)).status).toBe(503);
      expect((await handler(f.request("/api/v1/notification-grants", { method: "POST", headers: { Origin: coordinator,
        "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, grantId, verifier: secret }) }, owner), peer)).status).toBe(503);
      expect(await readFile(f.statePath, "utf8")).toBe(text);
    }
  });

  test.skipIf(process.platform === "win32")("unsafe permissions and symlinks preserve evidence and refuse grants", async () => {
    const f = await fixture(); await f.create(); await f.source.stop();
    const text = await readFile(f.statePath, "utf8");
    await chmod(f.statePath, 0o644);
    expect(await notificationGrantsHealthy(f.config)).toBe(false);
    const unsafe = await FleetSourceService.open({ config: f.config, registry: f.registry, poller: f.poller });
    expect(unsafe.healthy).toBe(false); await unsafe.stop();
    await chmod(f.statePath, 0o600); await rm(f.statePath);
    const target = join(f.root, "evidence.json"); await writePrivateTextFile(target, text);
    await symlink(target, f.statePath);
    const linked = await FleetSourceService.open({ config: f.config, registry: f.registry, poller: f.poller });
    expect(linked.healthy).toBe(false); await linked.stop();
    expect(await readFile(target, "utf8")).toBe(text); expect((await lstat(f.statePath)).isSymbolicLink()).toBe(true);
  });

  test("source state, logs and support archive never persist grant secrets or projected forbidden fields", async () => {
    const f = await fixture(); await f.create();
    f.registry.reconcile({ observed: [session()], retained: new Set() });
    const stream = reader(await f.feed()); await event(stream); await stream.cancel();
    await f.feed({ Authorization: `Bearer ${grantId}.${wrongSecret}` });
    const archive = diagnosticsBundleBytes({ service: "omp-session-gateway", checks: {
      notificationGrantsHealthy: await notificationGrantsHealthy(f.config),
    }, ...{ secret, verifier: await fleetGrantVerifier(grantId, secret), fleetNotifications: "FLEET_COORDINATOR_STATE_CANARY" } });
    const state = await readFile(f.statePath, "utf8");
    const report = archive.toString("utf8");
    for (const value of [secret, wrongSecret, "FLEET_TITLE_CANARY", "FLEET_CWD_CANARY", "FLEET_MODEL_CANARY"]) {
      expect(state).not.toContain(value); expect(JSON.stringify(f.logs)).not.toContain(value); expect(report).not.toContain(value);
    }
    expect(report).not.toContain(await fleetGrantVerifier(grantId, secret));
    expect(report).not.toContain(owner); expect(report).not.toContain(grantId);
    expect(report).not.toContain("FLEET_COORDINATOR_STATE_CANARY");
    expect(report).toContain("notification-grants.json and fleet-notifications.json");
    expect(JSON.stringify(f.logs)).not.toContain(await fleetGrantVerifier(grantId, secret));
    expect(await readdir(f.config.paths.stateDir)).toEqual(["notification-grants.json"]);
  });
});
