import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webPush from "web-push";
import {
  PUSH_API_VERSION,
  type BrowserPushSubscription,
  type ObservedSessionInput,
  type PushSubscriptionKeys,
  parseAttentionPushMessage,
  parsePushSubscriptionRequest,
} from "@omp-session-gateway/protocol";
import type { GatewayConfig } from "../src/config.ts";
import { SafeLogger } from "../src/logger.ts";
import { PUSH_ENDPOINT_SPACING_MS, PushService, type PushSendOptions, type PushTransport, webPushOptions } from "../src/push.ts";
import { SessionRegistry } from "../src/registry.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const endpoint = "https://push.example.test/send/device-subscription";
const previousKeys: PushSubscriptionKeys = { p256dh: "P".repeat(88), auth: "A".repeat(22) };
const renewedKeys: PushSubscriptionKeys = { p256dh: "Q".repeat(88), auth: "B".repeat(22) };
const subscription: BrowserPushSubscription = {
  endpoint,
  expirationTime: null,
  keys: previousKeys,
};

/** Names a device by its key pair so a failed expectation never prints transport key material. */
function keyLabel(keys: PushSubscriptionKeys): string {
  if (keys.p256dh === previousKeys.p256dh && keys.auth === previousKeys.auth) return "previous";
  if (keys.p256dh === renewedKeys.p256dh && keys.auth === renewedKeys.auth) return "renewed";
  return "unrecognized";
}

function pushError(status: number): Error {
  const error = new Error("push service rejected request");
  Object.defineProperty(error, "statusCode", { value: status });
  return error;
}

type SettleSend = (error?: unknown) => void;

function config(root: string): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317", trustedDashboardOrigins: [] },
    fleet: { label: "127.0.0.1", targets: [] },
    speech: { browserRecognition: false },
    auth: { mode: "dev-localhost", allowedLogins: [] },
    omp: { discoveryDir: join(root, "omp", "run", "collab-hosts"), queryTimeoutMs: 1_500 },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 100 },
    paths: {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
      tokenPath: join(root, "config", "readiness-token"),
      configPath: join(root, "config", "config.json"),
    },
  };
}

function observedSession(inputRequired: boolean, generation = 1): ObservedSessionInput {
  return {
    instanceId: "push-instance-000001",
    generation,
    pid: 1234,
    sessionId: `session-${generation}`,
    title: "\u{F04E6} PROMPT_CONTENT_CANARY",
    cwdLabel: "OPTION_CONTENT_CANARY",
    model: "provider/model",
    startedAt: "2026-07-24T00:00:00.000Z",
    inputRequired,
    canControl: true,
  };
}

class RecordingTransport implements PushTransport {
  readonly calls: Array<{
    readonly subscription: BrowserPushSubscription;
    readonly payload: string;
    readonly options: PushSendOptions;
  }> = [];
  statusCode: number | undefined;
  blockWhen: ((subscription: BrowserPushSubscription) => boolean) | undefined;
  readonly #gates: SettleSend[] = [];
  readonly #waiters: Array<(settle: SettleSend) => void> = [];

  /** Resolves with the gate of the next blocked send, awaiting that signal instead of a timer. */
  nextBlockedSend(): Promise<SettleSend> {
    const ready = this.#gates.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    const { promise, resolve } = Promise.withResolvers<SettleSend>();
    this.#waiters.push(resolve);
    return promise;
  }

  async send(pushSubscription: BrowserPushSubscription, payload: string, options: PushSendOptions): Promise<void> {
    this.calls.push({ subscription: pushSubscription, payload, options });
    if (this.blockWhen?.(pushSubscription) === true) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const settle: SettleSend = error => {
        if (error === undefined) resolve();
        else reject(error);
      };
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#gates.push(settle);
      else waiter(settle);
      await promise;
      return;
    }
    if (this.statusCode !== undefined) throw pushError(this.statusCode);
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-gateway-push-"));
  return root;
}

describe("Web Push service", () => {
  test.each(["missing subscription", "disallowed identity", "rejected authority"] as const)(
    "reports skipped fleet delivery for %s without calling transport", async reason => {
      const root = await createRoot(), gatewayConfig = config(root);
      const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 }), transport = new RecordingTransport();
      const service = await PushService.open({ config: gatewayConfig, registry, transport, endpointSpacingMs: 0 });
      try {
        await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, subscription });
        if (reason === "missing subscription") await service.unsubscribe("dev-localhost", { version: PUSH_API_VERSION, endpoint });
        if (reason === "disallowed identity") {
          // Retain the owned subscription while withdrawing the allowlist entry.
          const auth = gatewayConfig.auth as { mode: GatewayConfig["auth"]["mode"]; allowedLogins: string[] };
          auth.mode = "tailscale-serve";
          auth.allowedLogins = [];
        }
        const outcome = await service.sendFleet("dev-localhost", endpoint, {
          version: 3, type: "attention", instanceId: "synthetic-fleet-skipped", generation: 1, requestId: "synthetic-skipped-request",
          seq: { epoch: 1, n: 1 }, badge: { count: 1, complete: false }, title: "OMP session needs attention",
        }, () => reason !== "rejected authority");
        expect(transport.calls).toEqual([]);
        expect(outcome).toBe("skipped");
      } finally { await service.stop(); }
    },
  );

  test("authenticated push config counts eligible global recipients without listing private state", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root), registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const service = await PushService.open({ config: gatewayConfig, registry, transport: new RecordingTransport(), endpointSpacingMs: 0 });
    try {
      expect(service.configResponse()).toMatchObject({ subscriptionCount: 0 });
      for (const suffix of ["one", "two"]) await service.subscribe("dev-localhost", {
        version: PUSH_API_VERSION, subscription: { ...subscription, endpoint: `${endpoint}/${suffix}` },
      });
      const result = service.configResponse();
      expect(result).toMatchObject({ subscriptionCount: 2 });
      for (const secret of [endpoint, previousKeys.auth, previousKeys.p256dh, "dev-localhost"]) {
        expect(JSON.stringify(result)).not.toContain(secret);
      }
      await service.unsubscribe("dev-localhost", { version: PUSH_API_VERSION, endpoint: `${endpoint}/one` });
      expect(service.configResponse()).toMatchObject({ subscriptionCount: 1 });
    } finally { await service.stop(); }
  });

  test.each([undefined, 503, 410])("emits bounded transport evidence without notification or subscription data (%s)", async status => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    transport.statusCode = status;
    const lines: string[] = [];
    const service = await PushService.open({ config: config(root), registry, transport, logger: new SafeLogger({ write: line => lines.push(line) }), endpointSpacingMs: 0 });
    await service.subscribe("dev-localhost", parsePushSubscriptionRequest({ version: PUSH_API_VERSION, detailLevel: "preview", subscription }));
    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    await service.flush();
    await service.subscribe("dev-localhost", parsePushSubscriptionRequest({ version: PUSH_API_VERSION, detailLevel: "preview", subscription }));
    await service.flush(); await service.stop();
    expect(service.qualificationAlias(registry.snapshot().sessions[0]!)).toBeUndefined();
    const events = lines.map(line => JSON.parse(line));
    expect(events.some(event => event.event === "push.queue_accepted")).toBe(true);
    expect(events.some(event => event.event === "push.send_started")).toBe(true);
    expect(events.some(event => event.event === "push.send_started" && event.subscription_replay === true)).toBe(true);
    expect(events.some(event => event.event === "push.send_started" && event.subscription_replay === false)).toBe(true);
    expect(events.some(event => event.event === (status === undefined ? "push.send_acknowledged" : "push.send_failed"))).toBe(true);
    if (status === 410) expect(events.some(event => event.event === "push.subscription_evicted")).toBe(true);
    for (const forbidden of [endpoint, subscription.keys.auth, subscription.keys.p256dh, "PROMPT_CONTENT_CANARY", "OPTION_CONTENT_CANARY", "push-instance-000001", "dev-localhost"]) {
      expect(lines.join("\n")).not.toContain(forbidden);
    }
    for (const event of events) for (const [key, value] of Object.entries(event)) {
      if (["event", "level", "timestamp"].includes(key)) continue;
      expect(typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)).toBe(true);
    }
  });

  test("persists private VAPID and subscription state without session content", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root);
    const statePath = join(gatewayConfig.paths.stateDir, "push-state.json");
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const service = await PushService.open({ config: gatewayConfig, registry, transport: new RecordingTransport(), endpointSpacingMs: 0 });
    const publicKey = service.configResponse().applicationServerKey;
    await service.subscribe(
      "dev-localhost",
      parsePushSubscriptionRequest({
        version: PUSH_API_VERSION,
        detailLevel: "preview",
        subscription,
      }),
    );
    await service.stop();

    const state = await readFile(statePath, "utf8");
    expect(state).toContain(endpoint);
    expect(state).toContain('"detailLevel": "preview"');
    expect((await stat(statePath)).mode & 0o077).toBe(0);

    const reopened = await PushService.open({ config: gatewayConfig, registry, transport: new RecordingTransport(), endpointSpacingMs: 0 });
    expect(reopened.configResponse().applicationServerKey).toBe(publicKey);
    await reopened.stop();
  });

  test("signs each send with a VAPID contact a push service can reach", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 0 });
    await service.subscribe(
      "dev-localhost",
      parsePushSubscriptionRequest({ version: PUSH_API_VERSION, detailLevel: "private", subscription }),
    );

    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    await service.flush();
    await service.stop();

    expect(transport.calls).toHaveLength(1);
    // Apple returns 403 BadJwtToken for a `sub` whose contact host cannot exist (#173); RFC
    // 2606/6761 reserve these names, and web-push itself warns that `localhost` is rejected.
    const subject = new URL(transport.calls[0]?.options.subject ?? "");
    expect(["https:", "mailto:"]).toContain(subject.protocol);
    const host = subject.protocol === "mailto:" ? subject.pathname.slice(subject.pathname.lastIndexOf("@") + 1) : subject.hostname;
    expect(host).not.toMatch(/(^|\.)(invalid|test|example|localhost)$/u);
  });

  test("delivers each real stop once at device detail without retaining activity or replaying it", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root);
    const statePath = join(gatewayConfig.paths.stateDir, "push-state.json");
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: gatewayConfig, registry, transport, endpointSpacingMs: 0 });
    const subscriptions = (["private", "session", "preview"] as const).map((detailLevel, index) => ({
      version: PUSH_API_VERSION,
      detailLevel,
      subscription: { ...subscription, endpoint: `${endpoint}-${index}` },
    }));
    for (const request of subscriptions) await service.subscribe("dev-localhost", request);
    const stateBeforeActivity = await readFile(statePath, "utf8");

    const session = observedSession(false);
    registry.reconcile({ observed: [{ ...session, busy: false }], retained: new Set() });
    await service.flush();
    expect(transport.calls).toHaveLength(0);
    for (const canControl of [true, false]) {
      registry.reconcile({ observed: [{ ...session, canControl, busy: true }], retained: new Set() });
      registry.reconcile({ observed: [{ ...session, canControl, busy: false }], retained: new Set() });
      await service.flush();
      registry.reconcile({ observed: [{ ...session, canControl, busy: false }], retained: new Set() });
      registry.reconcile({ observed: [{ ...session, canControl, busy: false, model: "provider/updated" }], retained: new Set() });
      await service.flush();
    }

    expect(transport.calls).toHaveLength(6);
    for (const request of subscriptions) {
      const messages = transport.calls
        .filter(call => call.subscription.endpoint === request.subscription.endpoint)
        .map(call => parseAttentionPushMessage(JSON.parse(call.payload)));
      expect(messages).toEqual(Array.from({ length: 2 }, () => ({
        version: PUSH_API_VERSION,
        type: "activity_stop",
        instanceId: session.instanceId,
        generation: session.generation,
        pendingAskCount: 0,
        title: "OMP session activity stopped",
        ...(request.detailLevel === "private" ? {} : { body: "PROMPT_CONTENT_CANARY · OPTION_CONTENT_CANARY" }),
      })));
    }
    expect(transport.calls.every(call => call.options.ttlSeconds === 300)).toBe(true);
    expect(await readFile(statePath, "utf8")).toBe(stateBeforeActivity);
    await service.stop();

    registry.reconcile({ observed: [{ ...session, busy: true }], retained: new Set() });
    registry.reconcile({ observed: [{ ...session, busy: false }], retained: new Set() });
    await service.flush();
    expect(transport.calls).toHaveLength(6);
    const restarted = await PushService.open({ config: gatewayConfig, registry, transport, endpointSpacingMs: 0 });
    for (const request of subscriptions) await restarted.subscribe("dev-localhost", request);
    await restarted.subscribe("dev-localhost", {
      version: PUSH_API_VERSION,
      detailLevel: "private",
      subscription: { ...subscription, endpoint: `${endpoint}-0`, keys: renewedKeys },
    });
    registry.reconcile({ observed: [{ ...session, busy: false }], retained: new Set() });
    await restarted.flush();
    expect(transport.calls).toHaveLength(6);
    await restarted.stop();
  });

  test.each([
    "unknown", "retained gap", "older generation", "new generation",
    "immutable replacement", "removal", "expiry", "registry reset",
  ])("does not synthesize or dispatch a queued stop across %s", async boundary => {
    const root = await createRoot();
    let now = 0;
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      clock: { monotonicNowMs: () => now, wallNowIso: () => new Date(now).toISOString() },
    });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 0 });
    await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, detailLevel: "private", subscription });
    let session = observedSession(false, 2);
    const sample = (busy: boolean): void => {
      registry.reconcile({ observed: [{ ...session, busy }], retained: new Set() });
    };
    const crossBoundary = (): void => {
      switch (boundary) {
        case "unknown":
          registry.reconcile({ observed: [session], retained: new Set() });
          break;
        case "retained gap":
          registry.reconcile({ observed: [], retained: new Set([session.instanceId]) });
          break;
        case "older generation":
          registry.reconcile({ observed: [{ ...session, generation: 1, busy: false }], retained: new Set() });
          break;
        case "new generation":
          session = { ...session, generation: session.generation + 1 };
          break;
        case "immutable replacement":
          session = { ...session, pid: session.pid + 1 };
          break;
        case "removal":
          registry.reconcile({ observed: [], retained: new Set() });
          break;
        case "expiry":
          now += 35_000;
          registry.sweepExpired();
          break;
        case "registry reset":
          registry.clear();
          break;
      }
      sample(false);
    };

    sample(true);
    crossBoundary();
    await service.flush();
    expect(transport.calls).toHaveLength(0);

    transport.blockWhen = () => true;
    const blocked = transport.nextBlockedSend();
    sample(true);
    sample(false);
    const release = await blocked;
    sample(true);
    sample(false);
    crossBoundary();
    transport.blockWhen = undefined;
    release();
    await service.flush();
    expect(transport.calls.map(call => parseAttentionPushMessage(JSON.parse(call.payload)).type)).toEqual([
      "activity_stop",
    ]);
    await service.stop();
  });

  test("drops superseded queued stops when activity resumes and rearms", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 0 });
    await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, detailLevel: "private", subscription });
    const sample = (busy: boolean): void => {
      registry.reconcile({ observed: [{ ...observedSession(false), busy }], retained: new Set() });
    };
    transport.blockWhen = () => true;
    const blocked = transport.nextBlockedSend();
    sample(true);
    sample(false);
    const release = await blocked;
    sample(true);
    sample(false);
    sample(true);
    sample(false);
    transport.blockWhen = undefined;
    release();
    await service.flush();
    expect(transport.calls.map(call => parseAttentionPushMessage(JSON.parse(call.payload)).type)).toEqual([
      "activity_stop", "activity_stop",
    ]);
    await service.stop();
  });

  test("prioritizes asks at the stop edge and when an ask overtakes queued stop delivery", async () => {
    const root = await createRoot();
    let requests = 0;
    const registry = new SessionRegistry({
      ttlSeconds: 35, maxSessions: 10, requestIdFactory: () => `push-request-${++requests}-identity`,
    });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 0 });
    await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, detailLevel: "private", subscription });
    const sample = (busy: boolean, inputRequired: boolean): void => {
      registry.reconcile({ observed: [{ ...observedSession(inputRequired), busy }], retained: new Set() });
    };
    sample(true, false);
    sample(false, true);
    await service.flush();
    sample(true, true);
    sample(false, false);
    await service.flush();
    expect(transport.calls.map(call => parseAttentionPushMessage(JSON.parse(call.payload)).type)).toEqual([
      "attention", "attention", "clear",
    ]);

    transport.blockWhen = () => true;
    const blocked = transport.nextBlockedSend();
    sample(true, true);
    const release = await blocked;
    sample(true, false);
    sample(false, false);
    sample(false, true);
    transport.blockWhen = undefined;
    release();
    await service.flush();
    const messages = transport.calls.slice(3).map(call => parseAttentionPushMessage(JSON.parse(call.payload)));
    expect(messages.map(message => message.type)).toEqual([
      "attention", "clear", "attention",
    ]);
    expect(messages.map(message => message.type === "activity_stop" ? undefined : message.requestId)).toEqual([
      "push-request-2-identity", "push-request-2-identity", "push-request-3-identity",
    ]);
    expect(messages.map(message => message.pendingAskCount)).toEqual([1, 0, 1]);
    await service.stop();
  });

  test("does not backfill an earlier stop when a device first opts in", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 0 });
    registry.reconcile({ observed: [{ ...observedSession(false), busy: true }], retained: new Set() });
    registry.reconcile({ observed: [{ ...observedSession(false), busy: false }], retained: new Set() });
    await service.flush();
    await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, detailLevel: "private", subscription });
    await service.flush();
    expect(transport.calls).toHaveLength(0);
    await service.stop();
  });

  test("uses the latest badge count and FIFO order for stops and asks", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 0 });
    await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, detailLevel: "private", subscription });
    const session = observedSession(false);
    const other = { ...observedSession(true), instanceId: "push-other-instance-0001" };
    transport.blockWhen = () => transport.calls.length === 1;
    const blocked = transport.nextBlockedSend();
    registry.reconcile({ observed: [{ ...session, busy: true }], retained: new Set() });
    registry.reconcile({ observed: [{ ...session, busy: false }], retained: new Set() });
    const release = await blocked;
    registry.reconcile({ observed: [{ ...session, busy: true }], retained: new Set() });
    registry.reconcile({ observed: [{ ...session, busy: false }], retained: new Set() });
    registry.reconcile({ observed: [{ ...session, busy: false }, other], retained: new Set() });
    release();
    await service.flush();
    registry.reconcile({ observed: [{ ...session, busy: false, inputRequired: true }, other], retained: new Set() });
    await service.flush();
    const calls = transport.calls.filter(call => JSON.parse(call.payload).instanceId === session.instanceId);
    const messages = calls.map(call => parseAttentionPushMessage(JSON.parse(call.payload)));
    expect(messages.map(message => message.type)).toEqual([
      "activity_stop", "activity_stop", "attention",
    ]);
    expect(messages.map(message => message.pendingAskCount)).toEqual([0, 1, 2]);
    await service.stop();
  });

  test("cleans only the failed stop-delivery subscription and ignores presentation-only renewal", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root);
    const statePath = join(gatewayConfig.paths.stateDir, "push-state.json");
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: gatewayConfig, registry, transport, endpointSpacingMs: 0 });
    await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, detailLevel: "private", subscription });
    const sample = (busy: boolean): void => {
      registry.reconcile({ observed: [{ ...observedSession(false), busy }], retained: new Set() });
    };
    const storedLabels = async (): Promise<readonly string[]> => {
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        readonly subscriptions: readonly { readonly keys: PushSubscriptionKeys }[];
      };
      return state.subscriptions.map(entry => keyLabel(entry.keys));
    };
    transport.blockWhen = () => true;
    const firstBlocked = transport.nextBlockedSend();
    sample(true);
    sample(false);
    const releaseFirst = await firstBlocked;
    const renewed = { ...subscription, keys: renewedKeys };
    await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, detailLevel: "preview", subscription: renewed });
    expect(transport.calls).toHaveLength(1);
    releaseFirst(pushError(410));
    await service.flush();
    expect(await storedLabels()).toEqual(["renewed"]);

    const secondBlocked = transport.nextBlockedSend();
    sample(true);
    sample(false);
    const releaseSecond = await secondBlocked;
    await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, detailLevel: "session", subscription: renewed });
    expect(transport.calls.map(call => keyLabel(call.subscription.keys))).toEqual(["previous", "renewed"]);
    releaseSecond(pushError(404));
    await service.flush();
    expect(await storedLabels()).toEqual([]);
    await service.stop();
  });

  test("builds per-device detail, re-pings silently, and clears the exact request", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      requestIdFactory: () => "push-request-identity-0001",
    });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 0 });
    const subscriptions = (["private", "session", "preview"] as const).map((detailLevel, index) => ({
      detailLevel,
      subscription: {
        ...subscription,
        endpoint: `${endpoint}-${index}`,
      },
    }));
    for (const entry of subscriptions) {
      await service.subscribe(
        "dev-localhost",
        parsePushSubscriptionRequest({
          version: PUSH_API_VERSION,
          detailLevel: entry.detailLevel,
          subscription: entry.subscription,
        }),
      );
    }

    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    // Identical polls coalesce; a visible update while the host keeps asking re-pings the same request.
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    registry.reconcile({ observed: [{ ...observedSession(true), model: "provider/updated" }], retained: new Set() });
    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    await service.flush();

    expect(transport.calls).toHaveLength(9);
    for (const entry of subscriptions) {
      const messages = transport.calls
        .filter(call => call.subscription.endpoint === entry.subscription.endpoint)
        .map(call => parseAttentionPushMessage(JSON.parse(call.payload)));
      expect(messages.map(message => message.type)).toEqual(["attention", "attention", "clear"]);
      expect(messages.map(message => message.pendingAskCount)).toEqual([1, 1, 0]);
      expect(messages.map(message => message.type === "activity_stop" ? undefined : message.requestId)).toEqual([
        "push-request-identity-0001",
        "push-request-identity-0001",
        "push-request-identity-0001",
      ]);
      const first = messages[0];
      if (first?.type !== "attention") throw new Error("expected attention");
      if (entry.detailLevel === "private") {
        expect(first.body).toBeUndefined();
      } else {
        expect(first.body).toBe("PROMPT_CONTENT_CANARY · OPTION_CONTENT_CANARY");
      }
      for (const call of transport.calls.filter(call => call.subscription.endpoint === entry.subscription.endpoint)) {
        expect(call.options.ttlSeconds).toBe(300);
        expect(call.options.privateKey).not.toBe(call.options.publicKey);
      }
    }
    await service.stop();
  });

  test("sends every message without a Topic, so FCM never throttles it as collapsible", () => {
    const vapid = webPush.generateVAPIDKeys();
    const request = webPush.generateRequestDetails(
      { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-device-0001", keys: previousKeys },
      null,
      webPushOptions({
        subject: "https://github.com/carrythroughsystems/omp-session-gateway",
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
        ttlSeconds: 300,
      }),
    );
    expect(request.headers.Topic).toBeUndefined();
    expect(String(request.headers.TTL)).toBe("300");
    expect(request.headers.Urgency).toBe("high");
  });

  test("removes expired push endpoints without logging endpoint or payload data", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root);
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    transport.statusCode = 410;
    const lines: string[] = [];
    const logger = new SafeLogger({ write(line): void { lines.push(line); } });
    const service = await PushService.open({ config: gatewayConfig, registry, transport, logger, endpointSpacingMs: 0 });
    await service.subscribe(
      "dev-localhost",
      parsePushSubscriptionRequest({
        version: PUSH_API_VERSION,
        detailLevel: "private",
        subscription,
      }),
    );

    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    await service.flush();
    await service.stop();

    const state = await readFile(join(gatewayConfig.paths.stateDir, "push-state.json"), "utf8");
    expect(state).not.toContain(endpoint);
    expect(lines.join("\n")).not.toContain(endpoint);
    expect(lines.join("\n")).not.toContain("CONTENT_CANARY");
  });

  test("keeps a renewed subscription when the in-flight send for the replaced keys is gone", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root);
    const statePath = join(gatewayConfig.paths.stateDir, "push-state.json");
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const lines: string[] = [];
    const logger = new SafeLogger({ write(line): void { lines.push(line); } });
    const service = await PushService.open({ config: gatewayConfig, registry, transport, logger, endpointSpacingMs: 0 });
    const subscribeWith = async (keys: PushSubscriptionKeys): Promise<void> => {
      await service.subscribe(
        "dev-localhost",
        parsePushSubscriptionRequest({
          version: PUSH_API_VERSION,
          detailLevel: "private",
          subscription: { endpoint, expirationTime: null, keys: { ...keys } },
        }),
      );
    };
    const storedLabels = async (): Promise<readonly string[]> => {
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        readonly subscriptions: readonly { readonly keys: PushSubscriptionKeys }[];
      };
      return state.subscriptions.map(entry => keyLabel(entry.keys));
    };

    await subscribeWith(previousKeys);
    transport.blockWhen = candidate => keyLabel(candidate.keys) === "previous";

    const blockedSend = transport.nextBlockedSend();
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    const settleBlockedSend = await blockedSend;
    expect(transport.calls.map(call => keyLabel(call.subscription.keys))).toEqual(["previous"]);

    await subscribeWith(renewedKeys);
    expect(await storedLabels()).toEqual(["renewed"]);
    expect(transport.calls).toHaveLength(1);

    transport.blockWhen = undefined;
    settleBlockedSend(pushError(410));
    await service.flush();

    expect(await storedLabels()).toEqual(["renewed"]);

    const deliveredBeforeClear = transport.calls.length;
    registry.reconcile({ observed: [observedSession(false)], retained: new Set() });
    await service.flush();
    const afterRenewal = transport.calls.slice(deliveredBeforeClear);
    expect(afterRenewal.map(call => keyLabel(call.subscription.keys))).toEqual(["renewed"]);
    expect(afterRenewal.map(call => parseAttentionPushMessage(JSON.parse(call.payload)).type)).toEqual(["clear"]);

    transport.statusCode = 410;
    registry.reconcile({ observed: [observedSession(true)], retained: new Set() });
    await service.flush();
    expect(await storedLabels()).toEqual([]);

    await service.stop();
    const log = lines.join("\n");
    expect(log).not.toContain(endpoint);
    expect(log).not.toContain(previousKeys.auth);
    expect(log).not.toContain(renewedKeys.auth);
    expect(log).not.toContain(previousKeys.p256dh);
    expect(log).not.toContain(renewedKeys.p256dh);
  });

  // Pacing is a real-time gap kept by the platform timer inside async send chains, so the tests
  // below measure it against the clock with small spacings; only the default check waits 1 s.
  const fleetClear = (n: number) => ({ version: 3, type: "clear", instanceId: "push-instance-000001", generation: 1,
    requestId: `synthetic-paced-request-${n}`, seq: { epoch: 1, n }, badge: { count: 0, complete: true } }) as const;

  test("sends to one subscription one at a time in order, spaced after each settles, without holding back another", async () => {
    const root = await createRoot(), spacing = 50;
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 }), transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: spacing });
    const paced = `${endpoint}/paced`, other = `${endpoint}/other`;
    const sequence = () => transport.calls.filter(call => call.subscription.endpoint === paced).map(call => JSON.parse(call.payload).seq.n);
    try {
      for (const target of [paced, other]) {
        await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, subscription: { ...subscription, endpoint: target } });
      }
      transport.blockWhen = candidate => candidate.endpoint === paced;
      const sends = [1, 2, 3].map(n => service.sendFleet("dev-localhost", paced, fleetClear(n), () => true));
      const first = await transport.nextBlockedSend();
      // Another device is not delayed while this one has a send in flight and two queued.
      expect(await service.sendFleet("dev-localhost", other, fleetClear(9), () => true)).toBe("delivered");
      expect(sequence()).toEqual([1]);
      // A failed send still releases the subscription and paces the next one.
      first(pushError(503));
      let settled = performance.now();
      const second = await transport.nextBlockedSend();
      expect(performance.now() - settled).toBeGreaterThanOrEqual(spacing - 5);
      expect(sequence()).toEqual([1, 2]);
      second();
      settled = performance.now();
      const third = await transport.nextBlockedSend();
      expect(performance.now() - settled).toBeGreaterThanOrEqual(spacing - 5);
      third();
      expect(await Promise.all(sends)).toEqual(["failed", "delivered", "delivered"]);
      expect(sequence()).toEqual([1, 2, 3]);
    } finally { await service.stop(); }
  });

  test("a send that waited for its subscription's turn re-checks authority before going out", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 }), transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 20 });
    try {
      await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, subscription });
      transport.blockWhen = () => transport.calls.length === 1;
      let authorized = true;
      const first = service.sendFleet("dev-localhost", endpoint, fleetClear(1), () => true);
      const waiting = service.sendFleet("dev-localhost", endpoint, fleetClear(2), () => authorized);
      const release = await transport.nextBlockedSend();
      // The grant is revoked while the second push waits behind the first.
      authorized = false;
      release();
      expect(await Promise.all([first, waiting])).toEqual(["delivered", "skipped"]);
      expect(transport.calls).toHaveLength(1);
    } finally { await service.stop(); }
  });

  test("a send skipped before transport does not hold its subscription for the gap", async () => {
    const root = await createRoot(), started: number[] = [];
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const service = await PushService.open({ config: config(root), registry, transport: { async send() { started.push(performance.now()); } }, endpointSpacingMs: 2_000 });
    try {
      await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, subscription });
      const begun = performance.now();
      expect(await Promise.all([
        service.sendFleet("dev-localhost", endpoint, fleetClear(1), () => false),
        service.sendFleet("dev-localhost", endpoint, fleetClear(2), () => true),
      ])).toEqual(["skipped", "delivered"]);
      expect(started).toHaveLength(1);
      expect(started[0]! - begun).toBeLessThan(1_000);
    } finally { await service.stop(); }
  });

  test("a legacy push that waited for its subscription's turn is dropped once that subscription is gone", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 }), transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 20 });
    try {
      await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, subscription });
      transport.blockWhen = () => transport.calls.length === 1;
      registry.reconcile({ observed: [observedSession(true), { ...observedSession(true), instanceId: "push-other-instance-0001" }], retained: new Set() });
      const release = await transport.nextBlockedSend();
      // The second session's push waits behind the first while the device unsubscribes.
      expect(await service.unsubscribe("dev-localhost", { version: PUSH_API_VERSION, endpoint })).toBe(true);
      release();
      await service.flush();
      expect(transport.calls).toHaveLength(1);
    } finally { await service.stop(); }
  });

  test("a legacy activity stop that waited for its subscription's turn is dropped once the session resumed", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 }), transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: 20 });
    const session = observedSession(false), asking = { ...observedSession(true), instanceId: "push-other-instance-0001" };
    try {
      await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, subscription });
      registry.reconcile({ observed: [{ ...session, busy: true }], retained: new Set() });
      transport.blockWhen = () => transport.calls.length === 1;
      registry.reconcile({ observed: [{ ...session, busy: true }, asking], retained: new Set() });
      const release = await transport.nextBlockedSend();
      // The stop edge passes its queue-time checks and waits behind the held push (one event-loop
      // turn drains the microtasks that get it there); then the session resumes.
      registry.reconcile({ observed: [{ ...session, busy: false }, asking], retained: new Set() });
      await new Promise(resolve => setImmediate(resolve));
      registry.reconcile({ observed: [{ ...session, busy: true }, asking], retained: new Set() });
      release();
      await service.flush();
      expect(transport.calls.map(call => parseAttentionPushMessage(JSON.parse(call.payload)).type)).toEqual(["attention"]);
    } finally { await service.stop(); }
  });

  test("paces legacy pushes for different sessions to one subscription", async () => {
    const root = await createRoot(), spacing = 50, started: Array<{ at: number; instanceId: string }> = [];
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport: PushTransport = { async send(_subscription, payload) { started.push({ at: performance.now(), instanceId: JSON.parse(payload).instanceId }); } };
    const service = await PushService.open({ config: config(root), registry, transport, endpointSpacingMs: spacing });
    try {
      await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, detailLevel: "private", subscription });
      // Two sessions ask at once: their delivery chains are independent, the subscription is not.
      registry.reconcile({ observed: [observedSession(true), { ...observedSession(true), instanceId: "push-other-instance-0001" }], retained: new Set() });
      await service.flush();
      expect(started.map(entry => entry.instanceId).sort()).toEqual(["push-instance-000001", "push-other-instance-0001"]);
      expect(started[1]!.at - started[0]!.at).toBeGreaterThanOrEqual(spacing - 5);
    } finally { await service.stop(); }
  });

  test("defaults to a one-second gap between pushes to one subscription", async () => {
    const root = await createRoot(), started: number[] = [];
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const service = await PushService.open({ config: config(root), registry, transport: { async send() { started.push(performance.now()); } } });
    try {
      await service.subscribe("dev-localhost", { version: PUSH_API_VERSION, subscription });
      expect(await Promise.all([1, 2].map(n => service.sendFleet("dev-localhost", endpoint, fleetClear(n), () => true)))).toEqual(["delivered", "delivered"]);
      expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(PUSH_ENDPOINT_SPACING_MS - 5);
    } finally { await service.stop(); }
  });
});
