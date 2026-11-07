import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EMPTY_FLEET_WORKER_STATE, fleetNotificationTag, fleetOwnerDigest, fleetSourceBinding,
  parseFleetFeedEvent, parseFleetPushMessage, parseFleetStatusResponse, reduceFleetPush,
  type BrowserPushSubscription, type FleetFeedEvent, type FleetFeedSession, type FleetPushMessage,
  type FleetWorkerState, type FleetDisplayedNotification, type ObservedSessionInput,
} from "@omp-session-gateway/protocol";
import { FleetCoordinator, FleetCoordinatorProblem, fleetCoordinatorStateHealthy, type FleetCoordinatorClock, type FleetCoordinatorConfig } from "../src/fleet-coordinator.ts";
import type { GatewayConfig } from "../src/config.ts";
import { SafeLogger } from "../src/logger.ts";
import { PushService, type PushTransport } from "../src/push.ts";
import { SessionRegistry } from "../src/registry.ts";
import { diagnosticsBundleBytes } from "../src/diagnostics.ts";

const instanceId = "synthetic-shared-instance";
const requestId = "req_0123456789abcdef";
const nextRequest = "req_fedcba9876543210";
const sourceA = { id: "studio", origin: "https://studio.example.test", label: "Studio" };
const sourceB = { id: "laptop", origin: "https://laptop.example.test", label: "Laptop" };
const alice = "alice@example.test", bob = "bob@example.test";
const expiry = "2030-01-01T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class Clock implements FleetCoordinatorClock {
  time = Date.parse("2026-11-07T00:00:00.000Z");
  next = 1;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = (): number => this.time;
  setTimeout = (callback: () => void, ms: number): Timer => {
    const id = this.next++; this.timers.set(id, { at: this.time + ms, callback }); return id as unknown as Timer;
  };
  clearTimeout = (timer: Timer): void => { this.timers.delete(timer as unknown as number); };
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.time) { this.timers.delete(id); timer.callback(); }
  }
}

class Feeds {
  readonly connections: Array<{ origin: string; grantId: string; send: (event: FleetFeedEvent) => void; close: () => void; raw: (text: string) => void }> = [];
  readonly snapshots = new Map<string, { owner: string; sessions: FleetFeedSession[] }>();
  readonly statuses = new Map<string, number>();
  readonly requests: Array<{ url: string; headers: string[]; redirect: string | undefined }> = [];
  async register(grantId: string, owner: string, sessions: FleetFeedSession[] = []): Promise<void> {
    this.snapshots.set(grantId, { owner: await fleetOwnerDigest("http://127.0.0.1:4317", owner), sessions });
  }
  fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input), headers = new Headers(init?.headers), authorization = headers.get("Authorization")!;
    const grantId = authorization.slice(7).split(".")[0]!;
    this.requests.push({ url, headers: [...headers.keys()].sort(), redirect: init?.redirect });
    const status = this.statuses.get(grantId);
    if (status === -1) throw new Error("SYNTHETIC_NETWORK_CANARY");
    if (status !== undefined) return new Response(null, { status });
    const snapshot = this.snapshots.get(grantId);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { closed = true; } });
    const raw = (text: string): void => { if (!closed) controller.enqueue(new TextEncoder().encode(text)); };
    const send = (event: FleetFeedEvent): void => { parseFleetFeedEvent(event); raw(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
    const close = (): void => { if (!closed) { closed = true; controller.close(); } };
    init?.signal?.addEventListener("abort", close, { once: true });
    this.connections.push({ origin: new URL(url).origin, grantId, send, close, raw });
    if (snapshot !== undefined) send({ version: 1, type: "snapshot", owner: snapshot.owner, expiresAt: expiry, sessions: snapshot.sessions });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  live(grantId: string) { return this.connections.filter(connection => connection.grantId === grantId).at(-1)!; }
}

class Transport implements PushTransport {
  readonly calls: Array<{ endpoint: string; payload: string; message: FleetPushMessage }> = [];
  readonly legacy: string[] = [];
  readonly workers = new Map<string, { state: FleetWorkerState; displayed: FleetDisplayedNotification[] }>();
  readonly gates: Array<() => void> = [];
  block = false;
  failure = 0;
  sending = 0;
  peak = 0;
  async send(subscription: BrowserPushSubscription, payload: string): Promise<void> {
    this.sending++; this.peak = Math.max(this.peak, this.sending);
    try {
      const value = JSON.parse(payload);
      if (value.version === 2) this.legacy.push(payload);
      else {
        const message = parseFleetPushMessage(value);
        this.calls.push({ endpoint: subscription.endpoint, payload, message });
        const worker = this.workers.get(subscription.endpoint) ?? { state: EMPTY_FLEET_WORKER_STATE, displayed: [] };
        const reduction = reduceFleetPush(worker.state, message, worker.displayed, Date.parse("2026-11-07T00:00:00.000Z"));
        worker.state = reduction.state;
        for (const effect of reduction.effects) {
          if (effect.kind === "close") worker.displayed = worker.displayed.filter(value => value.tag !== effect.tag || value.intent.kind !== "attention" || value.intent.requestId !== effect.requestId);
          if (effect.kind === "show" && message.type !== "clear") {
            worker.displayed = worker.displayed.filter(value => value.tag !== effect.tag);
            worker.displayed.push({ tag: effect.tag, intent: message.type === "attention" ?
              { kind: "attention", ...(message.source === undefined ? {} : { source: message.source }), instanceId: message.instanceId, requestId: message.requestId } :
              { kind: "activity_stop", ...(message.source === undefined ? {} : { source: message.source }), instanceId: message.instanceId, generation: message.generation } });
          }
        }
        this.workers.set(subscription.endpoint, worker);
      }
      if (this.block) { const gate = Promise.withResolvers<void>(); this.gates.push(gate.resolve); await gate.promise; }
      if (this.failure !== 0) throw Object.assign(new Error("SYNTHETIC_PUSH_CANARY"), { statusCode: this.failure });
    } finally { this.sending--; }
  }
  release(): void { this.block = false; for (const resolve of this.gates.splice(0)) resolve(); }
}

function gatewayConfig(root: string): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317", trustedDashboardOrigins: [] },
    fleet: { label: "Home", targets: [sourceA, sourceB] }, speech: { browserRecognition: false },
    auth: { mode: "tailscale-serve", allowedLogins: [alice, bob], trustIdentityWithoutTailnetDevice: true },
    omp: { discoveryDir: join(root, "omp"), queryTimeoutMs: 1500 }, registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 1000 },
    paths: { configDir: join(root, "config"), stateDir: join(root, "state"), runtimeDir: join(root, "run"), tokenPath: join(root, "config", "token"), configPath: join(root, "config", "config.json") },
  };
}
function subscription(device: string): BrowserPushSubscription {
  return { endpoint: `https://push.example.test/send/synthetic-${device}`, expirationTime: null, keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) } };
}
function observed(inputRequired: boolean): ObservedSessionInput {
  return { instanceId, generation: 1, pid: 1234, sessionId: "synthetic-session", title: "SYNTHETIC_LOCAL_TITLE", cwdLabel: "SYNTHETIC_LOCAL_PROJECT", model: "test/model", startedAt: "2026-11-07T00:00:00.000Z", inputRequired, canControl: true, busy: false };
}
async function fixture(sources = [sourceA, sourceB]) {
  const root = await mkdtemp(join(tmpdir(), "fleet-coordinator-"));
  const config = gatewayConfig(root), registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 1000 }), transport = new Transport(), feeds = new Feeds(), clock = new Clock();
  const logs: string[] = [];
  const logger = new SafeLogger({ write: line => logs.push(line) });
  const push = await PushService.open({ config, registry, transport, logger });
  const coordinatorConfig: FleetCoordinatorConfig = { publicOrigin: config.http.publicOrigin, ownLabel: "Home", sources };
  let coordinator = await FleetCoordinator.open({ config: coordinatorConfig, stateDir: config.paths.stateDir, push, registry, fetch: feeds.fetch, clock, logger, random: () => 0.5 });
  cleanups.push(async () => { transport.release(); await coordinator.stop(); await push.stop(); });
  return { root, config, registry, transport, feeds, clock, logs, push, coordinatorConfig,
    get coordinator() { return coordinator; },
    async restart(next = coordinatorConfig, warm: () => boolean = () => true) {
      await coordinator.stop();
      coordinator = await FleetCoordinator.open({ config: next, stateDir: config.paths.stateDir, push, registry, fetch: feeds.fetch, clock, logger, random: () => 0.5, discoveryWarm: warm });
      return coordinator;
    },
    async device(owner = alice, device = "one", detailLevel: "private" | "session" | "preview" = "session") {
      const value = subscription(device); await push.subscribe(owner, { version: 2, subscription: value, detailLevel }); await push.flush(); return value.endpoint;
    },
    async grant(owner = alice, source = sourceA.id, sessions: FleetFeedSession[] = []) {
      const grant = await coordinator.createGrant(owner, source); await feeds.register(grant.grantId, owner, sessions); await coordinator.activate(owner, grant.grantId); return grant.grantId;
    },
  };
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition did not settle");
}
async function settled(coordinator: FleetCoordinator): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; await coordinator.flush();
}

// Every recorded v3 payload is parsed and applied to the real shared reducer by Transport.send.
describe("fleet coordinator", () => {
  test("same instance on two sources has independent tags, asks, counts; selections are owner/device scoped", async () => {
    const f = await fixture();
    const a1 = await f.device(alice, "a1"), a2 = await f.device(alice, "a2"), b1 = await f.device(bob, "b1");
    const ask = { instanceId, generation: 1, requestId };
    await f.grant(alice, sourceA.id, [ask]); await f.grant(alice, sourceB.id, [ask]); await f.grant(bob, sourceB.id, [ask]);
    await f.coordinator.select(alice, a1, [sourceA.id, sourceB.id]); await f.coordinator.select(alice, a2, [sourceB.id]); await f.coordinator.select(bob, b1, [sourceB.id]);
    await settled(f.coordinator);
    expect(f.transport.calls.filter(call => call.endpoint === a1)).toHaveLength(2);
    expect(f.transport.calls.filter(call => call.endpoint === a2)).toHaveLength(1);
    expect(f.transport.calls.filter(call => call.endpoint === b1)).toHaveLength(1);
    const tags = f.transport.workers.get(a1)!.displayed.map(value => value.tag);
    expect(new Set(tags).size).toBe(2);
    const bindingA = await fleetSourceBinding(sourceA.id, sourceA.origin), bindingB = await fleetSourceBinding(sourceB.id, sourceB.origin);
    expect(tags.sort()).toEqual([fleetNotificationTag(bindingA, instanceId), fleetNotificationTag(bindingB, instanceId)].sort());
    expect(f.transport.calls.filter(call => call.endpoint === a1).every(call => call.message.badge.count === 2)).toBe(true);
    expect(f.transport.calls.every(call => call.message.type !== "clear" && call.message.body === `${call.message.source === bindingA ? "Studio" : "Laptop"} · ${instanceId.slice(-6)}`)).toBe(true);
    expect(f.feeds.requests.every(request => request.headers.join(",") === "accept,authorization" && request.redirect === "error" && request.url.endsWith("/api/v1/notification-feed"))).toBe(true);
    expect(parseFleetStatusResponse(await f.coordinator.status(alice, a2)).sources.map(row => row.selected)).toEqual([false, true]);
  });

  test("selection replay and deselection affect only that recipient and release only the last selector", async () => {
    const f = await fixture(); const one = await f.device(alice, "one"), two = await f.device(alice, "two");
    const grantId = await f.grant(alice, sourceA.id, [{ instanceId, generation: 1, requestId }]);
    await f.coordinator.select(alice, one, [sourceA.id]); await settled(f.coordinator);
    await f.coordinator.select(alice, two, [sourceA.id]); await settled(f.coordinator);
    expect(f.transport.calls.map(call => call.endpoint)).toEqual([one, two]);
    expect((await f.coordinator.select(alice, one, [])).released).toEqual([]); await settled(f.coordinator);
    expect(f.transport.calls.at(-1)?.message.type).toBe("clear"); expect(f.transport.calls.at(-1)?.endpoint).toBe(one);
    expect((await f.coordinator.select(alice, two, [])).released).toEqual([{ sourceId: sourceA.id, grantId }]); await settled(f.coordinator);
    expect(f.transport.workers.get(two)!.displayed).toHaveLength(0);
    const state = JSON.parse(await readFile(join(f.config.paths.stateDir, "fleet-notifications.json"), "utf8"));
    expect(state.grants).toHaveLength(0);
  });

  test("snapshot diff clears old requests before alerting replacements; stops are live only", async () => {
    const f = await fixture(); const device = await f.device(); const grant = await f.grant(alice, sourceA.id, [{ instanceId, generation: 1, requestId }]);
    await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator);
    await until(() => f.feeds.connections.filter(value => value.grantId === grant).length >= 2);
    const feed = f.feeds.live(grant);
    feed.send({ version: 1, type: "snapshot", owner: await fleetOwnerDigest(f.config.http.publicOrigin, alice), expiresAt: expiry, sessions: [{ instanceId, generation: 2, requestId: nextRequest }] });
    await until(() => f.transport.calls.length >= 3); await settled(f.coordinator);
    expect(f.transport.calls.map(call => call.message.type)).toEqual(["attention", "clear", "attention"]);
    expect(f.transport.calls[1]!.message.generation).toBe(1);
    feed.send({ version: 1, type: "upsert", session: { instanceId, generation: 2 } });
    feed.send({ version: 1, type: "stop", instanceId, generation: 2 });
    await until(() => f.transport.calls.length >= 5); await settled(f.coordinator);
    expect(f.transport.calls.slice(-2).map(call => call.message.type)).toEqual(["clear", "activity_stop"]);
    expect(f.transport.workers.get(device)!.displayed[0]?.intent.kind).toBe("activity_stop");
  });

  test("disconnect and heartbeat timeout retain asks and emit incomplete badges without false clears", async () => {
    const f = await fixture(); const device = await f.device(); const grant = await f.grant(alice, sourceA.id, [{ instanceId, generation: 1, requestId }]);
    await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator);
    f.feeds.live(grant).close(); await until(async () => (await f.coordinator.status(alice, device)).sources[0]!.state === "stale");
    f.registry.reconcile({ observed: [observed(true)], retained: new Set() }); await settled(f.coordinator);
    expect(f.transport.calls.at(-1)!.message.badge).toEqual({ count: 2, complete: false });
    expect(f.transport.calls.some(call => call.message.type === "clear")).toBe(false);
    f.clock.advance(1000); await until(() => f.feeds.connections.length >= 3); await settled(f.coordinator);
    f.clock.advance(45_000); await until(async () => (await f.coordinator.status(alice, device)).sources[0]!.state === "stale");
    expect(f.transport.workers.get(device)!.displayed).toHaveLength(2);
  });

  test("queued revocation and owner removal cannot start another authorized remote send", async () => {
    for (const removedOwner of [false, true]) {
      const f = await fixture(); const device = await f.device();
      const sessions = Array.from({ length: 20 }, (_, index) => ({ instanceId: `synthetic-session-${index}`, generation: 1, requestId }));
      const grant = await f.grant(alice, sourceA.id, sessions);
      f.transport.block = true; await f.coordinator.select(alice, device, [sourceA.id]);
      await until(() => f.transport.gates.length === 8);
      if (removedOwner) (f.config.auth.allowedLogins as string[]).splice(0, 1);
      else await f.coordinator.revoke(alice, grant);
      f.transport.release(); await settled(f.coordinator);
      expect(f.transport.calls.filter(call => call.message.type === "attention")).toHaveLength(8);
      expect(f.transport.peak).toBeLessThanOrEqual(8);
    }
  });

  test("restart advances the epoch and diffs resolved/unseen asks without repeats or stops", async () => {
    const f = await fixture(); const device = await f.device();
    const unchanged = { instanceId: "synthetic-unchanged", generation: 1, requestId };
    const grant = await f.grant(alice, sourceA.id, [{ instanceId, generation: 1, requestId }, unchanged]);
    await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator);
    const old = f.transport.calls[0]!.message, count = f.transport.calls.length;
    await f.feeds.register(grant, alice, [unchanged, { instanceId: "synthetic-unseen", generation: 1, requestId: nextRequest }]);
    await f.restart(); await until(() => f.transport.calls.length >= count + 2); await settled(f.coordinator);
    const fresh = f.transport.calls.slice(count).map(call => call.message);
    expect(fresh.map(message => message.type)).toEqual(["clear", "attention"]);
    expect(fresh.every(message => message.seq.epoch === old.seq.epoch + 1)).toBe(true);
    expect(f.transport.workers.get(device)!.displayed.map(value => value.intent.instanceId).sort()).toEqual(["synthetic-unchanged", "synthetic-unseen"]);
    const worker = f.transport.workers.get(device)!;
    expect(reduceFleetPush(worker.state, old, worker.displayed, f.clock.now()).effects).toEqual([]);
    await f.restart(); await settled(f.coordinator); expect(f.transport.calls).toHaveLength(count + 2);
  });

  test("restart with queued old messages preserves outstanding identity and rejects late old epochs", async () => {
    const f = await fixture(); const device = await f.device();
    const sessions = Array.from({ length: 20 }, (_, index) => ({ instanceId: `synthetic-queued-${index}`, generation: 1, requestId }));
    const grant = await f.grant(alice, sourceA.id, sessions); f.transport.block = true;
    await f.coordinator.select(alice, device, [sourceA.id]); await until(() => f.transport.gates.length === 8);
    const old = f.transport.calls[0]!.message;
    const stopping = f.coordinator.stop(); f.transport.release(); await stopping;
    expect(f.transport.calls).toHaveLength(8);
    await f.feeds.register(grant, alice, [{ instanceId: "synthetic-after-restart", generation: 2, requestId: nextRequest }]);
    await f.restart(); await until(() => f.transport.calls.length === 29); await settled(f.coordinator);
    expect(f.transport.calls.slice(8).filter(call => call.message.type === "clear")).toHaveLength(20);
    expect(f.transport.calls.slice(8).filter(call => call.message.type === "attention")).toHaveLength(1);
    expect(f.transport.calls.slice(8).every(call => call.message.seq.epoch === old.seq.epoch + 1)).toBe(true);
    const worker = f.transport.workers.get(device)!;
    expect(reduceFleetPush(worker.state, old, worker.displayed, f.clock.now()).effects).toEqual([]);
    expect(worker.displayed.map(value => value.intent.instanceId)).toEqual(["synthetic-after-restart"]);
  });

  test("restart clears unauthorized, removed, repointed, and deselected bindings; stale stays outstanding", async () => {
    for (const mode of ["unauthorized", "removed", "repointed", "deselected", "stale"] as const) {
      const f = await fixture(); const device = await f.device(); const grant = await f.grant(alice, sourceA.id, [{ instanceId, generation: 1, requestId }]);
      await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator); await f.coordinator.stop();
      if (mode === "unauthorized") f.feeds.statuses.set(grant, 401);
      if (mode === "stale") f.feeds.statuses.set(grant, -1);
      if (mode === "deselected") {
        const path = join(f.config.paths.stateDir, "fleet-notifications.json"); const state = JSON.parse(await readFile(path, "utf8"));
        state.recipients[0].sources = [sourceB.id]; await writeFile(path, JSON.stringify(state), { mode: 0o600 });
      }
      await f.restart({ ...f.coordinatorConfig, sources: mode === "removed" ? [sourceB] : mode === "repointed" ? [{ ...sourceA, origin: "https://replacement.example.test" }, sourceB] : f.coordinatorConfig.sources });
      await until(async () => { await f.coordinator.status(alice, device); return mode === "stale" || f.transport.calls.length === 2; });
      await settled(f.coordinator);
      expect(f.transport.calls.map(call => call.message.type)).toEqual(mode === "stale" ? ["attention"] : ["attention", "clear"]);
    }
  });

  test("activation maps failures, bounds its snapshot wait, and drops owner-digest mismatches", async () => {
    const f = await fixture(); await f.device();
    for (const [status, code, http] of [[401, "grant_rejected", 409], [404, "unsupported", 404], [-1, "source_unreachable", 503]] as const) {
      const grant = await f.coordinator.createGrant(alice, sourceA.id); f.feeds.statuses.set(grant.grantId, status);
      try { await f.coordinator.activate(alice, grant.grantId); throw new Error("activation succeeded"); }
      catch (error) { expect(error instanceof FleetCoordinatorProblem && error.status === http && error.code === code).toBe(true); }
    }
    const hanging = await f.coordinator.createGrant(alice, sourceA.id);
    const pending = f.coordinator.activate(alice, hanging.grantId).catch((error: unknown) => error);
    await until(() => f.feeds.connections.some(connection => connection.grantId === hanging.grantId));
    f.clock.advance(5_000);
    expect(await pending).toMatchObject({ status: 503, code: "source_unreachable" });
    const mismatch = await f.coordinator.createGrant(alice, sourceA.id); await f.feeds.register(mismatch.grantId, bob);
    await expect(f.coordinator.activate(alice, mismatch.grantId)).rejects.toMatchObject({ status: 409, code: "grant_rejected" });
    const state = JSON.parse(await readFile(join(f.config.paths.stateDir, "fleet-notifications.json"), "utf8")); expect(state.grants).toHaveLength(0);
    await expect(f.coordinator.createGrant("not-subscribed@example.test", sourceA.id)).rejects.toMatchObject({ status: 409 });
  });

  test("authorization retry recovers after renewal; malformed and oversized feeds retain stale asks", async () => {
    const f = await fixture(); const device = await f.device();
    const grant = await f.grant(alice, sourceA.id, [{ instanceId, generation: 1, requestId }]);
    await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator);
    f.feeds.statuses.set(grant, 401); f.feeds.live(grant).close();
    await until(async () => (await f.coordinator.status(alice, device)).sources[0]!.state === "stale");
    f.clock.advance(1000);
    await until(async () => (await f.coordinator.status(alice, device)).sources[0]!.state === "unauthorized"); await settled(f.coordinator);
    expect(f.transport.calls.at(-1)?.message.type).toBe("clear");
    const attempts = f.feeds.requests.length; f.clock.advance(299_999); await settled(f.coordinator); expect(f.feeds.requests).toHaveLength(attempts);
    f.feeds.statuses.delete(grant); f.clock.advance(1);
    await until(() => f.transport.calls.length === 3); await settled(f.coordinator);
    expect(f.transport.calls.at(-1)?.message.type).toBe("attention");
    f.feeds.live(grant).raw(`data: ${"x".repeat(70_000)}\n\n`);
    await until(async () => (await f.coordinator.status(alice, device)).sources[0]!.state === "stale");
    expect(f.transport.calls).toHaveLength(3);
    f.clock.advance(1000); await until(async () => (await f.coordinator.status(alice, device)).sources[0]!.state === "current");
    f.feeds.live(grant).raw('event: upsert\ndata: {\"version\":1,\"type\":\"upsert\",\"session\":{\"instanceId\":\"synthetic-instance\",\"generation\":1,\"preview\":\"SYNTHETIC_FORBIDDEN\"}}\n\n');
    await until(async () => (await f.coordinator.status(alice, device)).sources[0]!.state === "stale");
    expect(f.transport.calls).toHaveLength(3);
  });

  test("legacy payload and state bytes remain identical; fleet private/session/preview stay bounded", async () => {
    const f = await fixture(); const legacy = await f.device(alice, "legacy", "preview");
    const device = await f.device(alice, "fleet", "preview"); const privateDevice = await f.device(alice, "private", "private");
    const before = await readFile(join(f.config.paths.stateDir, "push-state.json"), "utf8");
    await f.grant(alice, sourceA.id, [{ instanceId, generation: 1, requestId }]); await f.coordinator.select(alice, device, [sourceA.id]); await f.coordinator.select(alice, privateDevice, [sourceA.id]);
    f.registry.reconcile({ observed: [observed(true)], retained: new Set() }); await settled(f.coordinator); await f.push.flush();
    const session = f.registry.snapshot().sessions[0]!;
    expect(f.transport.legacy.at(-1)).toBe(JSON.stringify({ version: 2, type: "attention", instanceId, generation: 1, requestId: session.ask!.requestId, pendingAskCount: 1, title: "OMP session needs attention", body: "SYNTHETIC_LOCAL_TITLE · SYNTHETIC_LOCAL_PROJECT" }));
    expect(await readFile(join(f.config.paths.stateDir, "push-state.json"), "utf8")).toBe(before);
    expect(f.transport.calls.filter(call => call.endpoint === privateDevice).every(call => !("body" in call.message))).toBe(true);
    expect(f.transport.calls.find(call => call.endpoint === device && call.message.source === undefined)?.message).toMatchObject({ body: "Home · SYNTHETIC_LOCAL_TITLE · SYNTHETIC_LOCAL_PROJECT" });
    expect(f.transport.calls.some(call => call.endpoint === legacy)).toBe(false);
    f.registry.reconcile({ observed: [observed(false)], retained: new Set() }); await f.push.flush(); await settled(f.coordinator);
    expect(f.transport.legacy.at(-1)).toBe(JSON.stringify({ version: 2, type: "clear", instanceId, requestId: session.ask!.requestId, pendingAskCount: 0 }));
    f.registry.reconcile({ observed: [{ ...observed(false), busy: true }], retained: new Set() });
    f.registry.reconcile({ observed: [{ ...observed(false), busy: false }], retained: new Set() }); await f.push.flush(); await settled(f.coordinator);
    expect(f.transport.legacy.at(-1)).toBe(JSON.stringify({ version: 2, type: "activity_stop", instanceId, generation: 1, pendingAskCount: 0, title: "OMP session activity stopped", body: "SYNTHETIC_LOCAL_TITLE · SYNTHETIC_LOCAL_PROJECT" }));
    expect(await readFile(join(f.config.paths.stateDir, "push-state.json"), "utf8")).toBe(before);
  });

  test("startup discovery cannot downgrade persisted fleet recipients to v2 while state loads", async () => {
    const f = await fixture(); const device = await f.device(); await f.grant(alice, sourceA.id);
    await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator); await f.coordinator.stop(); await f.push.stop();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 1000 });
    const push = await PushService.open({ config: { ...f.config, notifications: { sources: [sourceA.id] } }, registry, transport: f.transport, logger: new SafeLogger({ write() {} }) });
    registry.reconcile({ observed: [observed(true)], retained: new Set() });
    await Bun.sleep(1); expect(f.transport.legacy).toHaveLength(0);
    const coordinator = await FleetCoordinator.open({ config: f.coordinatorConfig, push, registry, stateDir: f.config.paths.stateDir, fetch: f.feeds.fetch, clock: f.clock });
    try {
      await push.flush(); await until(() => f.transport.calls.length > 0); await settled(coordinator);
      expect(f.transport.legacy).toHaveLength(0);
      expect(f.transport.calls[0]?.message).toMatchObject({ version: 3, type: "attention", instanceId });
    } finally { await coordinator.stop(); await push.stop(); }
  });

  test("restart waits for local discovery or its 30-second deadline without clearing cold local asks", async () => {
    const f = await fixture(); const device = await f.device(); await f.grant(alice, sourceA.id);
    await f.coordinator.select(alice, device, [sourceA.id]); f.registry.reconcile({ observed: [observed(true)], retained: new Set() }); await settled(f.coordinator);
    const count = f.transport.calls.length; await f.coordinator.stop();
    f.registry.reconcile({ observed: [], retained: new Set() }); await f.push.flush();
    let warm = false; await f.restart(f.coordinatorConfig, () => warm); await settled(f.coordinator);
    expect(f.transport.calls).toHaveLength(count);
    f.clock.advance(30_000); await settled(f.coordinator); expect(f.transport.calls).toHaveLength(count);
    warm = true; await f.coordinator.status(alice, device); await settled(f.coordinator);
    expect(f.transport.calls.at(-1)?.message.type).toBe("clear");
  });

  test("capacity and queue flood stay bounded; every queued alert remains clearable", async () => {
    const f = await fixture(); const device = await f.device();
    const sessions = Array.from({ length: 300 }, (_, index) => ({ instanceId: `synthetic-flood-${index}`, generation: 1, requestId }));
    const grant = await f.grant(alice, sourceA.id, sessions); f.transport.block = true;
    await f.coordinator.select(alice, device, [sourceA.id]); await until(() => f.transport.gates.length === 8);
    expect(f.coordinator.diagnostics().queued).toBeLessThanOrEqual(256);
    f.transport.release(); await settled(f.coordinator);
    expect(f.transport.calls.filter(call => call.message.type === "attention")).toHaveLength(256);
    expect(f.transport.calls.every(call => call.message.badge.count === 300)).toBe(true);
    const persisted = JSON.parse(await readFile(join(f.config.paths.stateDir, "fleet-notifications.json"), "utf8")); expect(persisted.recipients[0].outstanding).toHaveLength(256);
    f.feeds.live(grant).send({ version: 1, type: "snapshot", owner: await fleetOwnerDigest(f.config.http.publicOrigin, alice), expiresAt: expiry, sessions: [] });
    await until(() => f.transport.calls.filter(call => call.message.type === "clear").length === 256); await settled(f.coordinator);
    expect(f.transport.workers.get(device)!.displayed).toHaveLength(0);
    await expect(FleetCoordinator.open({ config: { ...f.coordinatorConfig, sources: Array.from({ length: 8 }, (_, index) => ({ id: `source-${index}`, origin: `https://source-${index}.example.test`, label: "Source" })) }, push: f.push, registry: f.registry, stateDir: f.config.paths.stateDir })).rejects.toThrow();
  });

  test("a flood exceeding the delivery queue never drops clears across recipients", async () => {
    const f = await fixture(); const one = await f.device(alice, "one"), two = await f.device(alice, "two");
    const sessions = Array.from({ length: 256 }, (_, index) => ({ instanceId: `synthetic-clear-flood-${index}`, generation: 1, requestId }));
    const grant = await f.grant(alice, sourceA.id, sessions);
    await f.coordinator.select(alice, one, [sourceA.id]); await settled(f.coordinator);
    await f.coordinator.select(alice, two, [sourceA.id]); await settled(f.coordinator);
    expect(f.transport.calls).toHaveLength(512);
    f.transport.block = true; await f.coordinator.revoke(alice, grant); await until(() => f.transport.gates.length === 8);
    expect(f.coordinator.diagnostics().queued).toBeLessThanOrEqual(256);
    f.transport.release(); await settled(f.coordinator);
    expect(f.transport.calls.filter(call => call.message.type === "clear")).toHaveLength(512);
    expect(f.transport.workers.get(one)!.displayed).toHaveLength(0); expect(f.transport.workers.get(two)!.displayed).toHaveLength(0);
  });

  test("eviction and unsubscribe remove recipient state; corruption fails closed without deleting evidence", async () => {
    const f = await fixture(); const device = await f.device(); await f.grant(alice, sourceA.id, [{ instanceId, generation: 1, requestId }]);
    f.transport.failure = 410; await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator);
    expect(f.coordinator.diagnostics().recipients).toBe(0); expect(f.push.fleetRecipients()).toHaveLength(0);
    f.transport.failure = 0; const next = await f.device(alice, "next"); await f.coordinator.select(alice, next, [sourceA.id]);
    await f.push.unsubscribe(alice, { version: 2, endpoint: next }); await settled(f.coordinator); expect(f.coordinator.diagnostics().recipients).toBe(0);
    await f.coordinator.stop(); const path = join(f.config.paths.stateDir, "fleet-notifications.json"); await writeFile(path, "{SYNTHETIC_CORRUPTION}", { mode: 0o600 });
    await f.restart(); expect(f.coordinator.healthy).toBe(false); await expect(f.coordinator.status(alice)).rejects.toMatchObject({ status: 503 });
    expect(await fleetCoordinatorStateHealthy(f.config.paths.stateDir)).toBe(false);
    expect(await readFile(path, "utf8")).toBe("{SYNTHETIC_CORRUPTION}");
  });

  test("grant secrets never reach responses, logs, diagnostics, or endpoint-keyed fleet state", async () => {
    const f = await fixture(); const device = await f.device(); const response = await f.coordinator.createGrant(alice, sourceA.id);
    const raw = await readFile(join(f.config.paths.stateDir, "fleet-notifications.json"), "utf8"); const secret = JSON.parse(raw).grants[0].secret;
    expect(secret.length).toBe(43); expect(JSON.stringify(response).includes(secret)).toBe(false);
    await f.feeds.register(response.grantId, alice); await f.coordinator.activate(alice, response.grantId); await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator);
    const visible = JSON.stringify({ status: await f.coordinator.status(alice, device), diagnostics: f.coordinator.diagnostics(), logs: f.logs });
    expect(visible.includes(secret)).toBe(false); expect(visible.includes(device)).toBe(false);
    const archive = diagnosticsBundleBytes({ service: "omp-session-gateway", checks: { fleetHealthy: f.coordinator.healthy } }).toString(); expect(archive.includes(secret)).toBe(false);
    expect((await readFile(join(f.config.paths.stateDir, "fleet-notifications.json"), "utf8")).includes(device)).toBe(false);
    for (const line of f.logs) { const entry = JSON.parse(line); for (const [key, value] of Object.entries(entry)) if (!["timestamp", "level", "event"].includes(key)) expect(typeof value === "boolean" || typeof value === "number").toBe(true); }
  });

  test("corrupt coordinator state falls back to byte-identical v2 local alerts for enrolled devices", async () => {
    const f = await fixture(); const device = await f.device();
    await f.grant(alice, sourceA.id); await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator);
    await f.coordinator.stop();
    const path = join(f.config.paths.stateDir, "fleet-notifications.json");
    await writeFile(path, "{SYNTHETIC_CORRUPTION}", { mode: 0o600 }); await f.restart();
    expect(f.coordinator.healthy).toBe(false);
    f.registry.reconcile({ observed: [observed(true)], retained: new Set() }); await f.push.flush();
    const session = f.registry.snapshot().sessions[0]!;
    expect(f.transport.legacy).toEqual([JSON.stringify({ version: 2, type: "attention", instanceId, generation: 1, requestId: session.ask!.requestId, pendingAskCount: 1, title: "OMP session needs attention", body: "SYNTHETIC_LOCAL_TITLE · SYNTHETIC_LOCAL_PROJECT" })]);
    expect(f.transport.calls).toHaveLength(0);
    expect(await readFile(path, "utf8")).toBe("{SYNTHETIC_CORRUPTION}");
  });

  test("restart accepts a canonical port-80 source and fails closed on active grants missing expiry", async () => {
    const f = await fixture([{ ...sourceA, origin: "http://127.0.0.1" }]); const device = await f.device();
    await f.grant(alice, sourceA.id, [{ instanceId, generation: 1, requestId }]);
    await f.coordinator.select(alice, device, [sourceA.id]); await settled(f.coordinator);
    await f.restart(); await settled(f.coordinator); expect(f.coordinator.healthy).toBe(true);
    expect(await fleetCoordinatorStateHealthy(f.config.paths.stateDir)).toBe(true);
    await f.coordinator.stop();
    const path = join(f.config.paths.stateDir, "fleet-notifications.json"), state = JSON.parse(await readFile(path, "utf8"));
    delete state.grants[0].expiresAt; await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    await f.restart(); expect(f.coordinator.healthy).toBe(false);
    expect(await fleetCoordinatorStateHealthy(f.config.paths.stateDir)).toBe(false);
  });

  test("real fetch bypasses dead HTTP/HTTPS proxies for the configured host", async () => {
    const previous = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
    const digest = await fleetOwnerDigest("http://127.0.0.1:4317", alice);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      expect(request.headers.get("Origin")).toBeNull(); expect(request.headers.get("Tailscale-User-Login")).toBeNull();
      return new Response(`event: snapshot\ndata: ${JSON.stringify({ version: 1, type: "snapshot", owner: digest, expiresAt: expiry, sessions: [] })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    } });
    try {
      process.env.HTTPS_PROXY = "http://127.0.0.1:1"; process.env.HTTP_PROXY = "http://127.0.0.1:1"; process.env.NO_PROXY = ""; process.env.no_proxy = "";
      const f = await fixture([{ ...sourceA, origin: `http://127.0.0.1:${server.port}` }]); await f.device(); await f.coordinator.stop();
      const coordinator = await FleetCoordinator.open({ config: f.coordinatorConfig, stateDir: f.config.paths.stateDir, push: f.push, registry: f.registry });
      try { const grant = await coordinator.createGrant(alice, sourceA.id); await coordinator.activate(alice, grant.grantId); }
      finally { await coordinator.stop(); }
      expect(process.env.NO_PROXY?.split(",").includes("127.0.0.1")).toBe(true);
    } finally { await server.stop(true); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
});
