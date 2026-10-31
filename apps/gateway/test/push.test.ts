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
import { PushService, type PushSendOptions, type PushTransport, webPushOptions } from "../src/push.ts";
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
  test("authenticated push config counts eligible global recipients without listing private state", async () => {
    const root = await createRoot();
    const gatewayConfig = config(root), registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const service = await PushService.open({ config: gatewayConfig, registry, transport: new RecordingTransport() });
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
    const service = await PushService.open({ config: config(root), registry, transport, logger: new SafeLogger({ write: line => lines.push(line) }) });
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
    const service = await PushService.open({ config: gatewayConfig, registry, transport: new RecordingTransport() });
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

    const reopened = await PushService.open({ config: gatewayConfig, registry, transport: new RecordingTransport() });
    expect(reopened.configResponse().applicationServerKey).toBe(publicKey);
    await reopened.stop();
  });

  test("signs each send with a VAPID contact a push service can reach", async () => {
    const root = await createRoot();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const transport = new RecordingTransport();
    const service = await PushService.open({ config: config(root), registry, transport });
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
    const service = await PushService.open({ config: gatewayConfig, registry, transport });
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
    const restarted = await PushService.open({ config: gatewayConfig, registry, transport });
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
    const service = await PushService.open({ config: config(root), registry, transport });
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
    const service = await PushService.open({ config: config(root), registry, transport });
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
    const service = await PushService.open({ config: config(root), registry, transport });
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
    const service = await PushService.open({ config: config(root), registry, transport });
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
    const service = await PushService.open({ config: config(root), registry, transport });
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
    const service = await PushService.open({ config: gatewayConfig, registry, transport });
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
    const service = await PushService.open({ config: config(root), registry, transport });
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
    const service = await PushService.open({ config: gatewayConfig, registry, transport, logger });
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
    const service = await PushService.open({ config: gatewayConfig, registry, transport, logger });
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
});
