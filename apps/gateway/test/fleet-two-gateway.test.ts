import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_FLEET_WORKER_STATE, OMP_REGISTRY_VERSION, fleetNotificationTag, fleetSourceBinding,
  parseFleetFeedEvent, parseFleetGrantCreateResponse, parseFleetPushMessage, parseFleetStatusResponse,
  type BrowserPushSubscription, type FleetDisplayedNotification, type FleetEffect, type FleetFeedEvent,
  type FleetPushMessage, type FleetWorkerState, reduceFleetPush,
} from "@omp-session-gateway/protocol";
import type { RequestPeer } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createDiagnosticsBundle } from "../src/diagnostics.ts";
import { FleetCoordinator, type FleetCoordinatorClock } from "../src/fleet-coordinator.ts";
import { FleetSourceService } from "../src/fleet-source.ts";
import { createHttpHandler } from "../src/http.ts";
import { SafeLogger } from "../src/logger.ts";
import { OmpHostReader, OmpLaunchResolver, startHostPoller } from "../src/omp-registry.ts";
import { PushService, type PushTransport } from "../src/push.ts";
import { SessionRegistry } from "../src/registry.ts";
import { StaticAssetStore } from "../src/static.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const shared = "synthetic-shared-instance-000001";
const resolved = "synthetic-resolved-instance-000002";
const unseen = "synthetic-unseen-instance-000003";
const alice = "alice@example.test", bob = "bob@example.test";
const canaries = ["SYNTHETIC_FLEET_TITLE_CANARY", "SYNTHETIC_FLEET_CWD_CANARY", "SYNTHETIC_FLEET_PREVIEW_CANARY"];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class Clock implements FleetCoordinatorClock {
  time = Date.parse("2026-11-07T00:00:00.000Z");
  next = 1;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = (): number => this.time;
  setTimeout = (callback: () => void, ms: number): Timer => {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id as unknown as Timer;
  };
  clearTimeout = (timer: Timer): void => { this.timers.delete(timer as unknown as number); };
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.time) {
      this.timers.delete(id); timer.callback();
    }
  }
  retryScheduled(): boolean { return [...this.timers.values()].some(timer => timer.at === this.time + 1_000); }
}

class CapturingPush implements PushTransport {
  readonly calls: Array<{ endpoint: string; payload: string; message: FleetPushMessage; effects: readonly FleetEffect[] }> = [];
  readonly workers = new Map<string, { state: FleetWorkerState; displayed: FleetDisplayedNotification[] }>();
  readonly failedClears: FleetPushMessage[] = [];
  failClears = 0;
  constructor(readonly clock: Clock) {}
  async send(subscription: BrowserPushSubscription, payload: string): Promise<void> {
    // No external push service: observe the actual PushService plaintext, not a rebuilt envelope.
    const message = parseFleetPushMessage(JSON.parse(payload));
    if (message.type === "clear" && this.failClears > 0) {
      this.failClears--; this.failedClears.push(message);
      throw new Error("synthetic clear transport failure");
    }
    const worker = this.workers.get(subscription.endpoint) ?? { state: EMPTY_FLEET_WORKER_STATE, displayed: [] };
    const reduction = reduceFleetPush(worker.state, message, worker.displayed, this.clock.now());
    worker.state = reduction.state;
    for (const effect of reduction.effects) {
      if (effect.kind === "close") worker.displayed = worker.displayed.filter(value =>
        value.tag !== effect.tag || value.intent.kind !== "attention" || value.intent.requestId !== effect.requestId);
      if (effect.kind === "show" && message.type !== "clear") {
        worker.displayed = worker.displayed.filter(value => value.tag !== effect.tag);
        worker.displayed.push({ tag: effect.tag, intent: message.type === "attention" ?
          { kind: "attention", ...(message.source === undefined ? {} : { source: message.source }), instanceId: message.instanceId, requestId: message.requestId } :
          { kind: "activity_stop", ...(message.source === undefined ? {} : { source: message.source }), instanceId: message.instanceId, generation: message.generation } });
      }
    }
    this.workers.set(subscription.endpoint, worker);
    this.calls.push({ endpoint: subscription.endpoint, payload, message, effects: reduction.effects });
  }
  for(endpoint: string) { return this.calls.filter(call => call.endpoint === endpoint); }
  displayed(endpoint: string) { return this.workers.get(endpoint)?.displayed ?? []; }
}

interface FeedCapture {
  grantId: string;
  boot: number;
  status: number;
  headerNames: string[];
  frames: string[];
  events: FleetFeedEvent[];
  closed: boolean;
}
class CapturingFeeds {
  boot = 0;
  readonly calls: FeedCapture[] = [];
  readonly faults: Array<"disconnect" | "hang"> = [];
  fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const call: FeedCapture = { grantId: headers.get("Authorization")!.slice(7).split(".")[0]!,
      boot: this.boot, status: 0, headerNames: [...headers.keys()].sort(), frames: [], events: [], closed: false };
    this.calls.push(call);
    const fault = this.faults.shift();
    if (fault !== undefined) {
      if (fault === "hang") await new Promise<void>(resolve => {
        if (init?.signal?.aborted) resolve();
        else init?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      call.closed = true;
      throw new Error("synthetic feed connection failure");
    }
    // This seam records a real loopback HTTP stream; it never supplies a feed event or identity.
    let response: Response;
    try { response = await fetch(input, init); }
    catch (error) { call.closed = true; throw error; }
    call.status = response.status;
    if (!response.ok || response.body === null) { call.closed = true; return response; }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { call.closed = true; controller.close(); return; }
          buffer += decoder.decode(chunk.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            call.frames.push(frame);
            const data = /^event: ([a-z]+)\ndata: (.+)$/u.exec(frame);
            if (data !== null) {
              const event = parseFleetFeedEvent(JSON.parse(data[2]!));
              expect(String(event.type)).toBe(data[1]!); call.events.push(event);
            }
          }
          controller.enqueue(chunk.value);
        } catch (error) { call.closed = true; controller.error(error); }
      },
      async cancel() { call.closed = true; await reader.cancel(); },
    }), { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

/** Same private discovery/socket wire as omp-registry.test.ts; no registry.reconcile shortcut. */
async function fakeHost(directory: string, instanceId: string, remote: boolean) {
  const socketRoot = await mkdtemp(join(tmpdir(), "fleet-omp-"));
  const endpoint = join(socketRoot, "host.sock");
  const token = createHash("sha256").update(`SYNTHETIC_DISCOVERY_${remote}_${instanceId}`).digest("hex");
  const snapshot = { instanceId, generation: 1, pid: 4242, sessionId: `synthetic-${instanceId}`,
    sessionName: remote ? canaries[0]! : "Synthetic local session",
    cwd: remote ? `/synthetic/${canaries[1]!}` : "/synthetic/local-project",
    model: { provider: "synthetic", id: "model" }, startedAt: Date.parse("2026-11-06T00:00:00.000Z"),
    participants: 1, relayConnected: true, inputRequired: false, busy: false, access: "control",
    // Additive upstream content must be stripped before the source's explicit feed projection.
    preview: canaries[2]!, attentionPreview: canaries[2]!,
  };
  const operations: string[] = [];
  const server = Bun.listen<undefined>({ unix: endpoint, socket: {
    data(socket, bytes) {
      const request = JSON.parse(new TextDecoder().decode(bytes).split("\n")[0]!);
      operations.push(request.op);
      socket.end(`${JSON.stringify(request.token === token && request.op === "snapshot" ?
        { ok: true, v: OMP_REGISTRY_VERSION, snapshot } :
        { ok: false, v: OMP_REGISTRY_VERSION, error: "authentication_failed" })}\n`);
    },
  } });
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  await writeFile(join(directory, `${instanceId}.json`), JSON.stringify({ version: OMP_REGISTRY_VERSION,
    instanceId, pid: 4242, endpoint, token, createdAt: Date.parse("2026-11-06T00:00:00.000Z") }), { mode: 0o600 });
  cleanups.push(async () => { server.stop(true); await rm(socketRoot, { recursive: true, force: true }); });
  return { snapshot, operations };
}

type HttpHandler = (request: Request, peer?: RequestPeer) => Promise<Response>;
interface Listener {
  readonly server: Bun.Server<undefined>;
  readonly origin: string;
  setHandler(handler: HttpHandler): void;
}
function listener(port = 0): Listener {
  let handler: HttpHandler | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port,
    fetch(request, bunServer) {
      const address = bunServer.requestIP(request)?.address;
      return handler === undefined ? new Response(null, { status: 503 }) :
        handler(request, address === undefined ? undefined : { address });
    },
  });
  return { server, origin: `http://127.0.0.1:${server.port}`, setHandler(value) { handler = value; } };
}

async function fixture(identities = false) {
  const root = await mkdtemp(join(tmpdir(), "fleet-two-gateway-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const proxy = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  cleanups.push(async () => { for (const key of ["NO_PROXY", "no_proxy"] as const) {
    if (proxy[key] === undefined) delete process.env[key]; else process.env[key] = proxy[key];
  } });
  const clock = new Clock(), transport = new CapturingPush(clock), feeds = new CapturingFeeds();
  const logs = { home: [] as string[], studio: [] as string[] };
  const secrets: Array<{ grantId: string; secret: string }> = [];
  const requests = { home: 0, studio: 0 };
  const assetsRoot = join(root, "assets"); await mkdir(assetsRoot);
  await writeFile(join(assetsRoot, "index.html"), "<!doctype html><title>OMP Sessions</title>");
  const assets = await StaticAssetStore.load(assetsRoot);
  const homeListener = listener(), studioListener = listener();
  cleanups.push(async () => { await homeListener.server.stop(true); await studioListener.server.stop(true); });
  const target = { id: "studio", origin: studioListener.origin, label: "Studio-like label" };
  function config(role: "home" | "studio", bound: Listener): GatewayConfig {
    const dir = join(root, role);
    return { http: { hostname: "127.0.0.1", port: bound.server.port!, publicOrigin: bound.origin,
      trustedDashboardOrigins: role === "studio" ? [homeListener.origin] : [] },
    fleet: { label: role === "home" ? "Home" : target.label, targets: role === "home" ? [target] : [] },
    notifications: role === "home" ? { sources: [target.id] } : { coordinators: [{ id: "home", origin: homeListener.origin }] },
    speech: { browserRecognition: false },
    auth: identities ? { mode: "tailscale-serve", allowedLogins: [alice, bob], trustIdentityWithoutTailnetDevice: true } :
      { mode: "dev-localhost", allowedLogins: [] },
    omp: { discoveryDir: join(dir, "discovery"), queryTimeoutMs: HANG_DEADLINE_MS },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 100 },
    paths: { stateDir: join(dir, "state"), configDir: join(dir, "config"), runtimeDir: join(dir, "run"),
      configPath: join(dir, "config", "config.json"), tokenPath: join(dir, "config", "readiness-token") } };
  }
  const homeConfig = config("home", homeListener), studioConfig = config("studio", studioListener);
  for (const value of [homeConfig, studioConfig]) await mkdir(value.omp.discoveryDir, { recursive: true, mode: 0o700 });
  const local = await fakeHost(homeConfig.omp.discoveryDir, shared, false);
  const remote = await fakeHost(studioConfig.omp.discoveryDir, shared, true);
  const resolvedHost = await fakeHost(studioConfig.omp.discoveryDir, resolved, true);
  const unseenHost = await fakeHost(studioConfig.omp.discoveryDir, unseen, true);

  async function runtime(role: "home" | "studio", bound: Listener, cold = false) {
    const config = role === "home" ? homeConfig : studioConfig;
    const logger = new SafeLogger({ write: line => logs[role].push(line) });
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 100,
      clock: { monotonicNowMs: clock.now, wallNowIso: () => new Date(clock.now()).toISOString() },
      requestIdFactory: () => `req_${role}_${String(++requests[role]).padStart(16, "0")}` });
    const reader = new OmpHostReader({ directory: config.omp.discoveryDir, timeoutMs: HANG_DEADLINE_MS,
      onFault: (event, detail) => logger.event("warn", event, detail) });
    const gate = Promise.withResolvers<void>();
    const observe = reader.observe.bind(reader);
    if (cold) reader.observe = async () => { await gate.promise; return observe(); };
    else gate.resolve();
    // Match runServe: fully load PushService before starting discovery and the coordinator.
    const push = await PushService.open({ config, registry, logger, transport });
    const poller = startHostPoller({ reader, registry, intervalMs: 60_000,
      onEvent: (event, detail) => logger.event("info", event, detail) });
    const source = role === "studio" ? await FleetSourceService.open({ config, registry, poller, now: clock.now,
      // Bounded polling observes real heartbeats without waiting the production 15-second period.
      heartbeatMs: 10 }) : undefined;
    const coordinator = role === "home" ? await FleetCoordinator.open({ stateDir: config.paths.stateDir,
      config: { publicOrigin: config.http.publicOrigin, ownLabel: config.fleet.label, sources: [target] },
      registry, push, clock, random: () => 0.5, logger, fetch: feeds.fetch,
      discoveryWarm: () => poller.discoveryWarm, subscribeObservations: poller.subscribeObservations }) : undefined;
    bound.setHandler(createHttpHandler({ config, registry, staticAssets: assets, pushService: push,
      ...(source === undefined ? {} : { fleetSourceService: source }),
      ...(coordinator === undefined ? {} : { fleetCoordinator: coordinator }),
      launchResolver: new OmpLaunchResolver({ registry, reader }), logger, now: clock.now,
      // Production identity path only in the owner-isolation test; never forwarded by the puller.
      tailnetPresent: () => true }));
    // Synchronize the test only after all daemon services have opened, not before PushService.
    if (!cold) await poller.poll();
    let stopped = false;
    return { config, registry, poller, push, source, coordinator, server: bound.server,
      async warm() { gate.resolve(); await poller.poll(); },
      async stop() {
        if (stopped) return; stopped = true;
        poller.stop(); gate.resolve(); await poller.poll();
        await coordinator?.stop(); await source?.stop(); await push.stop(); await bound.server.stop(true);
      } };
  }
  let studio = await runtime("studio", studioListener), home = await runtime("home", homeListener);
  cleanups.push(async () => { await home.stop(); await studio.stop(); });

  async function browser(where: "home" | "studio", path: string, body: unknown, owner?: string, method = "POST") {
    const destination = where === "home" ? homeConfig.http.publicOrigin : studioConfig.http.publicOrigin;
    return fetch(`${destination}${path}`, { method, headers: { Origin: homeConfig.http.publicOrigin,
      "Sec-Fetch-Site": where === "home" ? "same-origin" : "same-site", "Content-Type": "application/json",
      ...(owner === undefined ? {} : { "Tailscale-User-Login": owner }) }, body: JSON.stringify(body) });
  }
  async function device(name: string, detailLevel: "private" | "session" | "preview", owner?: string) {
    const subscription = { endpoint: `https://push.example.test/send/synthetic-${name}`, expirationTime: null,
      keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) } };
    const response = await browser("home", "/api/v1/push/subscription", { version: 2, detailLevel, subscription }, owner);
    expect(response.status).toBe(200); await response.body?.cancel(); await home.push.flush();
    return subscription.endpoint;
  }
  async function enroll(owner?: string) {
    const pending = await browser("home", "/api/v1/push/fleet/grants", { version: 1, sourceId: target.id }, owner);
    expect(pending.status).toBe(201);
    const grant = parseFleetGrantCreateResponse(await pending.json());
    // The browser sees the verifier only. Read synthetic private state solely to scan its secret.
    expect(Object.keys(grant).sort()).toEqual(["grantId", "verifier", "version"]);
    const state = JSON.parse(await readFile(join(homeConfig.paths.stateDir, "fleet-notifications.json"), "utf8"));
    secrets.push(state.grants.find((value: { grantId: string }) => value.grantId === grant.grantId));
    const accepted = await browser("studio", "/api/v1/notification-grants", grant, owner);
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("Access-Control-Allow-Origin")).toBe(homeConfig.http.publicOrigin);
    await accepted.body?.cancel();
    const activated = await browser("home", `/api/v1/push/fleet/grants/${grant.grantId}/activate`, { version: 1 }, owner);
    expect(activated.status).toBe(204);
    return grant;
  }
  async function select(endpoint: string, sources: string[], owner?: string) {
    const response = await browser("home", "/api/v1/push/fleet/recipient", {
      version: 1, endpoint, ...(sources.length === 0 ? {} : { sources }),
    }, owner,
      sources.length === 0 ? "DELETE" : "PUT");
    expect(response.status).toBe(200); await response.body?.cancel();
  }
  async function status(owner?: string, endpoint?: string) {
    // The HTTP status route is exercised explicitly; internal polling avoids consuming rate budgets.
    const response = await browser("home", "/api/v1/push/fleet/status", { version: 1, ...(endpoint === undefined ? {} : { endpoint }) }, owner);
    expect(response.status).toBe(200); return parseFleetStatusResponse(await response.json());
  }
  async function leaks() {
    await home.coordinator!.flush(); await home.push.flush(); await studio.push.flush();
    const texts: Array<{ path: string; text: string }> = [];
    for (const config of [homeConfig, studioConfig]) {
      for (const name of await readdir(config.paths.stateDir)) {
        texts.push({ path: join(config.paths.stateDir, name), text: await readFile(join(config.paths.stateDir, name), "utf8") });
      }
      // The test root exists on every platform; Windows never creates the POSIX runtime directory.
      const path = join(root, `${config === homeConfig ? "home" : "studio"}-diagnostics.tar`);
      await rm(path, { force: true });
      await createDiagnosticsBundle({ service: "omp-session-gateway", checks: {
        discoveryHealthy: (config === homeConfig ? home : studio).poller.discoveryHealthy,
        fleetHealthy: config === homeConfig ? home.coordinator!.healthy : studio.source!.healthy,
      } }, path);
      texts.push({ path, text: await readFile(path, "utf8") });
    }
    texts.push({ path: "captured push", text: transport.calls.map(call => call.payload).join("\n") },
      { path: "home logs", text: logs.home.join("\n") }, { path: "studio logs", text: logs.studio.join("\n") },
      { path: "machine feed", text: feeds.calls.flatMap(call => call.frames).join("\n") });
    const allowed = join(homeConfig.paths.stateDir, "fleet-notifications.json");
    for (const { path, text } of texts) {
      for (const canary of canaries) expect({ path, leaked: text.includes(canary) }).toEqual({ path, leaked: false });
      for (const { secret } of secrets) if (path !== allowed) expect({ path, leaked: text.includes(secret) }).toEqual({ path, leaked: false });
    }
    const persisted = JSON.parse(await readFile(allowed, "utf8"));
    for (const grant of persisted.grants) expect(secrets.some(value => value.grantId === grant.grantId && value.secret === grant.secret)).toBe(true);
    for (const call of feeds.calls) expect(call.headerNames).toEqual(["accept", "authorization"]);
    for (const line of [...logs.home, ...logs.studio]) for (const [key, value] of Object.entries(JSON.parse(line))) {
      if (!["event", "level", "timestamp"].includes(key)) expect(typeof value === "number" || typeof value === "boolean").toBe(true);
    }
  }
  return { clock, transport, feeds, local, remote, resolvedHost, unseenHost, target, browser, device, enroll, select, status, leaks, secrets,
    get home() { return home; }, get studio() { return studio; },
    async restartHome(down: () => Promise<void> = async () => {}, cold = false) {
      await home.stop(); await down(); home = await runtime("home", listener(homeConfig.http.port), cold);
    },
    async restartStudioCold() {
      await studio.stop(); feeds.boot++;
      studio = await runtime("studio", listener(studioConfig.http.port), true);
    } };
}

/** Real loopback I/O has no fake-timer completion signal; bounded condition polling only. */
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + HANG_DEADLINE_MS;
  while (performance.now() < deadline) { if (await predicate()) return; await Bun.sleep(1); }
  throw new Error("two-gateway condition did not settle");
}
async function settled(coordinator: FleetCoordinator): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve); await promise; await coordinator.flush();
}
function ask(registry: SessionRegistry, instanceId = shared): string {
  const request = registry.snapshot().sessions.find(session => session.instanceId === instanceId)?.ask?.requestId;
  expect(request).toBeDefined(); return request!;
}

// This is Tested server/worker-contract evidence, not physical Push or device qualification.
describe("two real fleet gateways over loopback", () => {
  for (const scenario of ["warm", "discovery-warms", "discovery-deadline", "one-hung-connect", "two-hung-connects", "disconnect-backoff", "clear-retry", "unhealthy-state"] as const) {
    test(`daemon-order restart exact clear: ${scenario}`, async () => {
      const f = await fixture(), endpoint = await f.device("restart", "private");
      await f.enroll(); await f.select(endpoint, [f.target.id]);
      f.remote.snapshot.inputRequired = true; await f.studio.poller.poll();
      await until(() => f.transport.for(endpoint).length === 1); await settled(f.home.coordinator!);
      const old = f.transport.for(endpoint)[0]!.message;
      expect(old.type).toBe("attention");
      if (old.type !== "attention") throw new Error("initial attention missing");
      const statePath = join(f.home.config.paths.stateDir, "fleet-notifications.json");
      const ledger = async () => JSON.parse(await readFile(statePath, "utf8")).recipients
        .flatMap((row: { outstanding: unknown[] }) => row.outstanding);
      expect(await ledger()).toHaveLength(1);
      const started = f.clock.now(), offset = f.feeds.calls.length;
      const cold = scenario === "discovery-warms" || scenario === "discovery-deadline";
      await f.restartHome(async () => {
        f.remote.snapshot.inputRequired = false; await f.studio.poller.poll();
        if (scenario === "one-hung-connect") f.feeds.faults.push("hang");
        if (scenario === "two-hung-connects") f.feeds.faults.push("hang", "hang");
        if (scenario === "disconnect-backoff") f.feeds.faults.push(...Array<"disconnect">(6).fill("disconnect"));
        if (scenario === "clear-retry") f.transport.failClears = 1;
        if (scenario === "unhealthy-state") await writeFile(statePath, "{synthetic-corruption}", { mode: 0o600 });
      }, cold);
      expect(f.home.push.fleetRecipients()).toHaveLength(1);
      if (scenario === "unhealthy-state") {
        expect(f.home.coordinator!.healthy).toBe(false);
        f.clock.advance(60_000); await settled(f.home.coordinator!);
        expect(f.feeds.calls).toHaveLength(offset);
        expect(f.transport.for(endpoint)).toHaveLength(1);
        expect(await readFile(statePath, "utf8")).toBe("{synthetic-corruption}");
        return;
      }
      expect(f.home.coordinator!.healthy).toBe(true);
      expect(f.home.coordinator!.diagnostics()).toMatchObject({ grants: 1, recipients: 1 });
      await until(() => f.feeds.calls.length > offset);
      let elapsed = 0;
      const noClear = async () => {
        await settled(f.home.coordinator!);
        expect(f.transport.for(endpoint)).toHaveLength(1);
        expect(await ledger()).toHaveLength(1);
        expect(f.transport.displayed(endpoint)).toHaveLength(1);
      };
      const retry = async (delay: number) => {
        await until(() => [...f.clock.timers.values()].some(timer => timer.at === f.clock.now() + delay));
        await noClear();
        f.clock.advance(delay - 1); elapsed += delay - 1; await noClear();
        f.clock.advance(1); elapsed++;
      };
      if (scenario === "one-hung-connect" || scenario === "two-hung-connects") {
        const attempts = scenario === "one-hung-connect" ? 1 : 2;
        for (let index = 0; index < attempts; index++) {
          await until(() => f.feeds.calls.length === offset + index + 1);
          await noClear();
          f.clock.advance(44_999); elapsed += 44_999; await noClear();
          expect(f.feeds.calls.at(-1)!.closed).toBe(false);
          f.clock.advance(1); elapsed++;
          await retry(1_000 * 2 ** index);
        }
      }
      if (scenario === "disconnect-backoff") for (let index = 0; index < 6; index++) await retry(1_000 * 2 ** index);
      await until(() => f.feeds.calls.at(-1)!.events.some(event => event.type === "snapshot"));
      if (cold) {
        await noClear();
        expect(f.home.poller.discoveryWarm).toBe(false);
        f.clock.advance(scenario === "discovery-warms" ? 10_000 : 29_999);
        elapsed = scenario === "discovery-warms" ? 10_000 : 29_999; await noClear();
        if (scenario === "discovery-warms") await f.home.warm();
        else { f.clock.advance(1); elapsed++; }
      }
      if (scenario === "clear-retry") {
        await until(() => f.transport.failedClears.length === 1);
        await retry(30_000);
      }
      await until(() => f.transport.for(endpoint).length === 2); await settled(f.home.coordinator!);
      const clear = f.transport.for(endpoint)[1]!;
      expect(clear.message).toMatchObject({ type: "clear", source: old.source, instanceId: old.instanceId,
        generation: old.generation, requestId: old.requestId });
      expect(clear.message.seq.epoch).toBeGreaterThan(old.seq.epoch);
      expect(clear.effects.some(effect => effect.kind === "close")).toBe(true);
      expect(f.transport.displayed(endpoint)).toEqual([]);
      expect(await ledger()).toEqual([]);
      expect(f.clock.now() - started).toBe(elapsed);
      expect(elapsed).toBe(({ warm: 0, "discovery-warms": 10_000, "discovery-deadline": 30_000,
        "one-hung-connect": 46_000, "two-hung-connects": 93_000, "disconnect-backoff": 63_000, "clear-retry": 30_000 })[scenario]);
      if (scenario === "clear-retry") expect(clear.message).toEqual(f.transport.failedClears[0]!);
      await f.home.coordinator!.status("dev-localhost"); await settled(f.home.coordinator!);
      expect(f.transport.for(endpoint)).toHaveLength(2);
    });
  }

  test("enrolls, routes exact asks/stops/revocation, and reconciles warm restarts and stale outages", async () => {
    const f = await fixture();
    const sessionDevice = await f.device("session", "session"), privateDevice = await f.device("private", "private");
    const grant = await f.enroll();
    await f.select(sessionDevice, [f.target.id]); await f.select(privateDevice, [f.target.id]);
    await until(async () => (await f.home.coordinator!.status("dev-localhost")).sources[0]!.state === "current");
    expect((await f.status(undefined, sessionDevice)).sources[0]).toMatchObject({ sourceId: "studio", state: "current", selected: true, grantId: grant.grantId });
    expect(f.home.config.paths.stateDir).not.toBe(f.studio.config.paths.stateDir);
    expect(f.home.server.port).not.toBe(f.studio.server.port);
    expect(f.home.registry.snapshot().sessions[0]!.instanceId).toBe(shared);
    expect(f.studio.registry.snapshot().sessions.some(session => session.instanceId === shared)).toBe(true);
    const binding = await fleetSourceBinding(f.target.id, f.target.origin);
    const remoteTag = fleetNotificationTag(binding, shared), localTag = fleetNotificationTag(undefined, shared);
    expect(f.transport.calls).toHaveLength(0);

    f.remote.snapshot.inputRequired = true; await f.studio.poller.poll();
    const remoteAsk = ask(f.studio.registry);
    await until(() => f.transport.calls.length >= 2); await settled(f.home.coordinator!);
    for (const endpoint of [sessionDevice, privateDevice]) {
      const call = f.transport.for(endpoint)[0]!;
      expect(call.message).toMatchObject({ version: 3, type: "attention", source: binding, instanceId: shared,
        generation: 1, requestId: remoteAsk, badge: { count: 1, complete: true } });
      expect(call.effects.some(effect => effect.kind === "show" && effect.tag === remoteTag)).toBe(true);
      expect(call.effects.some(effect => effect.kind === "badge" && effect.count === 1)).toBe(true);
    }
    expect(f.transport.for(sessionDevice)[0]!.message).toHaveProperty("body", `Studio-like label · ${shared.slice(-6)}`);
    expect(f.transport.for(privateDevice)[0]!.message).not.toHaveProperty("body");
    await f.leaks();

    f.local.snapshot.inputRequired = true; await f.home.poller.poll(); await settled(f.home.coordinator!);
    const localAsk = ask(f.home.registry);
    expect(localAsk).not.toBe(remoteAsk);
    for (const endpoint of [sessionDevice, privateDevice]) {
      const call = f.transport.for(endpoint).at(-1)!;
      expect(call.message).toMatchObject({ type: "attention", instanceId: shared, requestId: localAsk, badge: { count: 2, complete: true } });
      expect(call.message).not.toHaveProperty("source");
      expect(f.transport.displayed(endpoint).map(value => value.tag).sort()).toEqual([localTag, remoteTag].sort());
      expect(call.effects.some(effect => effect.kind === "badge" && effect.count === 2)).toBe(true);
    }

    let offset = f.transport.calls.length;
    f.remote.snapshot.inputRequired = false; await f.studio.poller.poll();
    await until(() => f.transport.calls.length >= offset + 2); await settled(f.home.coordinator!);
    expect(f.transport.calls.slice(offset).map(call => call.message)).toEqual([sessionDevice, privateDevice].map(() => expect.objectContaining({
      type: "clear", source: binding, instanceId: shared, generation: 1, requestId: remoteAsk, badge: { count: 1, complete: true },
    })));
    for (const endpoint of [sessionDevice, privateDevice]) expect(f.transport.displayed(endpoint).map(value => value.tag)).toEqual([localTag]);
    expect(f.transport.calls.slice(offset).every(call => call.effects.some(effect => effect.kind === "close" && effect.tag === remoteTag && effect.requestId === remoteAsk))).toBe(true);

    offset = f.transport.calls.length;
    f.remote.snapshot.busy = true; await f.studio.poller.poll();
    f.remote.snapshot.busy = false; await f.studio.poller.poll();
    await until(() => f.transport.calls.length >= offset + 2); await settled(f.home.coordinator!);
    expect(f.transport.calls.slice(offset).every(call => call.message.type === "activity_stop" && call.message.source === binding)).toBe(true);
    expect(f.transport.displayed(sessionDevice).find(value => value.tag === remoteTag)?.intent.kind).toBe("activity_stop");
    expect(f.feeds.calls.flatMap(call => call.events).filter(event => event.type === "stop")).toHaveLength(1);

    f.remote.snapshot.inputRequired = true; await f.studio.poller.poll();
    await until(() => f.transport.calls.length >= offset + 4); await settled(f.home.coordinator!);
    const revokedAsk = ask(f.studio.registry);
    expect(f.transport.displayed(sessionDevice).find(value => value.tag === remoteTag)?.intent).toMatchObject({ kind: "attention", requestId: revokedAsk });
    const live = f.feeds.calls.filter(call => call.grantId === grant.grantId && !call.closed).at(-1)!;
    expect(live).toBeDefined(); offset = f.transport.calls.length;
    expect((await f.browser("studio", `/api/v1/notification-grants/${grant.grantId}/revoke`, { version: 1 })).status).toBe(204);
    await until(() => live.closed && f.clock.retryScheduled()); f.clock.advance(1_000);
    await until(async () => (await f.home.coordinator!.status("dev-localhost")).sources[0]!.state === "unauthorized");
    await settled(f.home.coordinator!);
    expect((await f.status(undefined, sessionDevice)).sources[0]!.state).toBe("unauthorized");
    expect(f.feeds.calls.some(call => call.grantId === grant.grantId && call.status === 401)).toBe(true);
    expect(f.transport.calls.slice(offset).every(call => call.message.type === "clear" && call.message.source === binding && call.message.requestId === revokedAsk)).toBe(true);
    for (const endpoint of [sessionDevice, privateDevice]) expect(f.transport.displayed(endpoint).map(value => value.tag)).toEqual([localTag]);

    // Re-enroll without replaying a tombstoned ask; prepare unchanged/resolved/unseen restart sets.
    f.remote.snapshot.inputRequired = false; await f.studio.poller.poll();
    const replacement = await f.enroll(); expect(replacement.grantId).not.toBe(grant.grantId);
    f.local.snapshot.inputRequired = false; await f.home.poller.poll(); await settled(f.home.coordinator!);
    f.remote.snapshot.inputRequired = true; f.resolvedHost.snapshot.inputRequired = true;
    await f.studio.poller.poll();
    await until(() => f.transport.displayed(sessionDevice).filter(value => value.intent.kind === "attention").length === 2);
    await settled(f.home.coordinator!);
    const unchangedAsk = ask(f.studio.registry), resolvedAsk = ask(f.studio.registry, resolved);
    const old = f.transport.for(sessionDevice).at(-1)!.message;
    offset = f.transport.calls.length;
    await f.restartHome(async () => {
      f.resolvedHost.snapshot.inputRequired = false; f.unseenHost.snapshot.inputRequired = true;
      await f.studio.poller.poll();
    });
    const unseenAsk = ask(f.studio.registry, unseen);
    await until(() => f.transport.calls.length >= offset + 4); await settled(f.home.coordinator!);
    const restart = f.transport.calls.slice(offset);
    expect(restart).toHaveLength(4);
    for (const endpoint of [sessionDevice, privateDevice]) {
      expect(restart.filter(call => call.endpoint === endpoint).map(call => call.message)).toEqual([
        expect.objectContaining({ type: "clear", source: binding, instanceId: resolved, generation: 1, requestId: resolvedAsk }),
        expect.objectContaining({ type: "attention", source: binding, instanceId: unseen, requestId: unseenAsk }),
      ]);
      expect(f.transport.displayed(endpoint).map(value => value.intent.instanceId).sort()).toEqual([shared, unseen].sort());
      const worker = f.transport.workers.get(endpoint)!;
      expect(reduceFleetPush(worker.state, old, worker.displayed, f.clock.now()).effects).toEqual([]);
    }
    expect(restart.every(call => call.message.seq.epoch > old.seq.epoch)).toBe(true);
    expect(restart.some(call => call.message.type === "activity_stop" || call.message.type === "attention" && call.message.instanceId === shared)).toBe(false);
    expect(ask(f.studio.registry)).toBe(unchangedAsk);
    offset = f.transport.calls.length;
    await f.restartHome();
    await until(async () => (await f.home.coordinator!.status("dev-localhost")).sources[0]!.state === "current");
    await settled(f.home.coordinator!); expect(f.transport.calls).toHaveLength(offset);
    await f.leaks();

    // S starts with an actually empty memory-only registry and a gated real discovery round.
    await f.restartStudioCold();
    expect(f.studio.registry.size).toBe(0); expect(f.studio.poller.discoveryWarm).toBe(false);
    await until(() => f.clock.retryScheduled()); f.clock.advance(1_000);
    await until(() => f.feeds.calls.some(call => call.boot === 1 && call.frames.length >= 2));
    const cold = f.feeds.calls.filter(call => call.boot === 1 && call.status === 200).at(-1)!;
    expect(cold.frames.every(frame => frame === ": heartbeat")).toBe(true); expect(cold.events).toEqual([]);
    await settled(f.home.coordinator!); expect(f.transport.calls).toHaveLength(offset);
    expect(f.transport.displayed(sessionDevice).map(value => value.intent.instanceId).sort()).toEqual([shared, unseen].sort());
    f.remote.snapshot.inputRequired = false; f.unseenHost.snapshot.inputRequired = false;
    await f.studio.warm();
    await until(() => f.transport.calls.length >= offset + 4); await settled(f.home.coordinator!);
    expect(cold.events[0]).toMatchObject({ type: "snapshot" });
    expect(f.transport.calls.slice(offset).every(call => call.message.type === "clear" && call.message.source === binding)).toBe(true);
    expect(f.transport.calls.slice(offset).map(call => call.message.type === "clear" ? call.message.requestId : "unexpected").sort()).toEqual([unchangedAsk, unchangedAsk, unseenAsk, unseenAsk].sort());
    expect(f.transport.displayed(sessionDevice)).toEqual([]);

    f.remote.snapshot.inputRequired = true; await f.studio.poller.poll();
    await until(() => f.transport.displayed(sessionDevice).some(value => value.intent.kind === "attention"));
    await settled(f.home.coordinator!); const outstanding = ask(f.studio.registry); offset = f.transport.calls.length;
    await f.studio.server.stop(true);
    await until(async () => (await f.home.coordinator!.status("dev-localhost")).sources[0]!.state === "stale");
    await until(() => f.clock.retryScheduled()); f.clock.advance(1_000);
    await until(() => f.feeds.calls.some(call => call.boot === 1 && call.status === 0 && call.closed));
    f.local.snapshot.inputRequired = true; await f.home.poller.poll(); await settled(f.home.coordinator!);
    expect(f.transport.calls.slice(offset)).toHaveLength(2);
    for (const endpoint of [sessionDevice, privateDevice]) {
      const call = f.transport.for(endpoint).at(-1)!;
      expect(call.message).toMatchObject({ type: "attention", badge: { count: 2, complete: false } });
      expect(call.message).not.toHaveProperty("source");
      expect(call.effects.some(effect => effect.kind === "badge" && effect.count === 2 && !effect.complete)).toBe(true);
      expect(f.transport.displayed(endpoint).find(value => value.tag === remoteTag)?.intent).toMatchObject({ kind: "attention", requestId: outstanding });
    }
    expect(f.transport.calls.slice(offset).some(call => call.message.type === "clear")).toBe(false);
    expect((await f.status(undefined, sessionDevice)).sources[0]).toMatchObject({ state: "stale", selected: true });
    await f.leaks();
  });

  test("isolates two owners and each owner's devices, denies cross-route bearer reuse, and falls Preview back to Session", async () => {
    const f = await fixture(true);
    const a1 = await f.device("alice-selected", "preview", alice), a2 = await f.device("alice-local-only", "private", alice);
    const b1 = await f.device("bob-selected", "private", bob), b2 = await f.device("bob-local-only", "session", bob);
    const aGrant = await f.enroll(alice), bGrant = await f.enroll(bob);
    await f.select(a1, [f.target.id], alice); await f.select(b1, [f.target.id], bob);
    expect((await f.status(alice, a2)).sources[0]!.selected).toBe(false);
    expect((await f.status(bob, b2)).sources[0]!.selected).toBe(false);
    expect((await f.browser("home", "/api/v1/push/fleet/recipient", { version: 1, endpoint: b1, sources: [f.target.id] }, alice, "PUT")).status).toBe(409);
    expect((await f.browser("home", `/api/v1/push/fleet/grants/${aGrant.grantId}/activate`, { version: 1 }, bob)).status).toBe(409);
    expect((await f.browser("studio", `/api/v1/notification-grants/${aGrant.grantId}/renew`, { version: 1 }, bob)).status).toBe(401);
    expect((await f.browser("studio", `/api/v1/notification-grants/${aGrant.grantId}/revoke`, { version: 1 }, bob)).status).toBe(204);

    const credential = f.secrets.find(value => value.grantId === aGrant.grantId)!;
    const bearer = `Bearer ${credential.grantId}.${credential.secret}`;
    for (const gateway of [f.home, f.studio]) {
      for (const [method, path, body] of [
        ["GET", "/api/v1/sessions", undefined], ["GET", "/api/v1/push/config", undefined],
        ["POST", "/api/v1/push/fleet/status", { version: 1 }],
        ["POST", `/api/v1/sessions/${shared}/launch`, { mode: "control", generation: 1 }],
        ["POST", "/api/v1/session-creations", { version: 1 }],
        ["POST", "/api/v1/notification-grants", { ...aGrant }],
      ] as const) {
        const response = await fetch(`${gateway.config.http.publicOrigin}${path}`, { method,
          headers: { Authorization: bearer, Origin: gateway.config.http.publicOrigin,
            "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        // C has not enabled the source role; its grant routes fail closed before identity auth.
        const status = gateway === f.home && path === "/api/v1/notification-grants" ? 404 : 403;
        expect({ method, path, status: response.status }).toEqual({ method, path, status }); await response.body?.cancel();
      }
    }
    expect((await fetch(`${f.home.config.http.publicOrigin}/api/v1/notification-feed`, { headers: { Authorization: bearer } })).status).toBe(404);
    expect((await fetch(`${f.studio.config.http.publicOrigin}/api/v1/notification-feed`, { headers: { Authorization: bearer, Origin: f.home.config.http.publicOrigin } })).status).toBe(403);
    expect(f.local.operations.every(op => op === "snapshot")).toBe(true);
    expect(f.remote.operations.every(op => op === "snapshot")).toBe(true);

    f.remote.snapshot.inputRequired = true; await f.studio.poller.poll();
    await until(() => f.transport.calls.length >= 2); await settled(f.home.coordinator!);
    expect(f.transport.calls.map(call => call.endpoint).sort()).toEqual([a1, b1].sort());
    expect(f.transport.for(a2)).toEqual([]); expect(f.transport.for(b2)).toEqual([]);
    expect(f.transport.for(a1)[0]!.message).toHaveProperty("body", `Studio-like label · ${shared.slice(-6)}`);
    expect(f.transport.for(b1)[0]!.message).not.toHaveProperty("body");
    const offset = f.transport.calls.length;
    expect((await f.browser("studio", `/api/v1/notification-grants/${aGrant.grantId}/revoke`, { version: 1 }, alice)).status).toBe(204);
    await until(() => f.clock.retryScheduled()); f.clock.advance(1_000);
    await until(async () => (await f.home.coordinator!.status(alice)).sources[0]!.state === "unauthorized");
    await settled(f.home.coordinator!);
    expect(f.transport.calls.slice(offset)).toHaveLength(1);
    expect(f.transport.calls.at(-1)).toMatchObject({ endpoint: a1, message: { type: "clear" } });
    expect(f.transport.displayed(a1)).toEqual([]); expect(f.transport.displayed(b1)).toHaveLength(1);
    expect((await f.status(bob, b1)).sources[0]).toMatchObject({ state: "current", selected: true, grantId: bGrant.grantId });
    await f.leaks();
  });
});
