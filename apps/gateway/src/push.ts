import { join } from "node:path";
import webPush from "web-push";
import {
  MAX_FRAME_BYTES,
  PUSH_API_VERSION,
  type AttentionPushMessage,
  type BrowserPushSubscription,
  type PushConfigResponse,
  type PushSubscriptionRequest,
  type PushDetailLevel,
  type PushUnsubscribeRequest,
  type SessionEvent,
  type SessionMetadata,
  parseJsonFrame,
  parsePushSubscriptionRequest,
} from "@omp-session-gateway/protocol";
import {
  ensureRuntimeDirectories,
  type GatewayConfig,
  readPrivateTextFile,
  writePrivateTextFile,
} from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { SessionRegistry, type SessionActivityStopEvent } from "./registry.ts";

const PUSH_STATE_VERSION = 1 as const;
const MAX_PUSH_SUBSCRIPTIONS = 8;
const PUSH_TTL_SECONDS = 5 * 60;
const PUSH_TIMEOUT_MS = 10_000;
const VAPID_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{80,128}$/u;
const VAPID_PRIVATE_KEY_PATTERN = /^[A-Za-z0-9_-]{40,64}$/u;
const IDENTITY_PATTERN = /^[^\0\r\n]{1,320}$/u;
/**
 * RFC 8292 makes the VAPID `sub` claim a contact the push service can reach about this
 * application server. Apple rejects the whole JWT (`403 BadJwtToken`) when that contact cannot
 * exist, which a reserved `.invalid` name guaranteed; FCM never checks it, so the qualified
 * Android path hid the defect (#173). The repository is the one address every install shares.
 */
const VAPID_SUBJECT = "https://github.com/carrythroughsystems/omp-session-gateway";

interface VapidKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

interface StoredPushSubscription extends BrowserPushSubscription {
  readonly identityKey: string;
  readonly detailLevel: PushDetailLevel;
}

interface PushState {
  readonly version: typeof PUSH_STATE_VERSION;
  readonly vapid: VapidKeyPair;
  readonly subscriptions: readonly StoredPushSubscription[];
}

interface AttentionState {
  readonly generation: number;
  readonly requestId?: string;
  readonly active: boolean;
}

export interface PushSendOptions {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly ttlSeconds: number;
}

export interface PushTransport {
  send(subscription: BrowserPushSubscription, payload: string, options: PushSendOptions): Promise<void>;
}

/**
 * Web Push request options for one message. There is deliberately no `Topic`: FCM treats a topic as
 * a collapse key and throttles collapsible messages to a burst of 20 per app per device, refilling
 * one every three minutes. Ordinary ask, clear, and stop traffic exceeds that, and a throttled clear
 * left an answered ask's notification up for minutes. Every message is non-collapsible; the
 * request-specific clear keeps redelivery and reordering from closing a newer ask.
 */
export function webPushOptions(options: PushSendOptions): webPush.RequestOptions {
  return {
    TTL: options.ttlSeconds,
    urgency: "high",
    timeout: PUSH_TIMEOUT_MS,
    contentEncoding: "aes128gcm",
    vapidDetails: {
      subject: options.subject,
      publicKey: options.publicKey,
      privateKey: options.privateKey,
    },
  };
}

const defaultTransport: PushTransport = {
  async send(subscription, payload, options) {
    await webPush.sendNotification(subscription, payload, webPushOptions(options));
  },
};

function exactRecord(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid push state");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const allowed = new Set([...keys, ...optional]);
  if (actual.some(key => !allowed.has(key)) || keys.some(key => !Object.hasOwn(record, key))) {
    throw new Error("invalid push state");
  }
  return record;
}

function parseStoredSubscription(value: unknown): StoredPushSubscription {
  const record = exactRecord(
    value,
    ["identityKey", "endpoint", "expirationTime", "keys"],
    ["detailLevel"],
  );
  if (typeof record.identityKey !== "string" || !IDENTITY_PATTERN.test(record.identityKey)) {
    throw new Error("invalid push state");
  }
  const parsed = parsePushSubscriptionRequest({
    version: PUSH_API_VERSION,
    detailLevel: record.detailLevel ?? "session",
    subscription: {
      endpoint: record.endpoint,
      expirationTime: record.expirationTime,
      keys: record.keys,
    },
  });
  return {
    identityKey: record.identityKey,
    detailLevel: parsed.detailLevel ?? "session",
    ...parsed.subscription,
  };
}

function parsePushState(value: unknown): PushState {
  const record = exactRecord(value, ["version", "vapid", "subscriptions"]);
  if (record.version !== PUSH_STATE_VERSION || !Array.isArray(record.subscriptions)) {
    throw new Error("invalid push state");
  }
  if (record.subscriptions.length > MAX_PUSH_SUBSCRIPTIONS) throw new Error("invalid push state");
  const vapid = exactRecord(record.vapid, ["publicKey", "privateKey"]);
  if (
    typeof vapid.publicKey !== "string" ||
    typeof vapid.privateKey !== "string" ||
    !VAPID_PUBLIC_KEY_PATTERN.test(vapid.publicKey) ||
    !VAPID_PRIVATE_KEY_PATTERN.test(vapid.privateKey)
  ) {
    throw new Error("invalid push state");
  }
  const subscriptions = record.subscriptions.map(parseStoredSubscription);
  if (new Set(subscriptions.map(subscription => subscription.endpoint)).size !== subscriptions.length) {
    throw new Error("invalid push state");
  }
  return {
    version: PUSH_STATE_VERSION,
    vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    subscriptions,
  };
}


async function loadOrCreatePushState(config: GatewayConfig, path: string): Promise<PushState> {
  await ensureRuntimeDirectories(config);
  const raw = await readPrivateTextFile(path, MAX_FRAME_BYTES);
  if (raw !== undefined) {
    try {
      return parsePushState(parseJsonFrame(new TextEncoder().encode(raw)));
    } catch {
      throw new Error("push state is invalid or unsafe");
    }
  }
  const vapid = webPush.generateVAPIDKeys();
  const state: PushState = {
    version: PUSH_STATE_VERSION,
    vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    subscriptions: [],
  };
  await writePrivateTextFile(path, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = error.statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * A 404/410 condemns exactly the subscription that was sent, so stale cleanup compares the whole
 * delivery target — owner identity, endpoint, expiry, and both transport keys — instead of the endpoint
 * alone. A browser may renew a subscription while a delivery is still in flight, and that renewal reuses
 * the endpoint with fresh keys; matching on the endpoint alone would let the obsolete failure delete the
 * live record. `detailLevel` is a presentation preference rather than part of the target, so changing it
 * never shields a dead endpoint from cleanup.
 */
function isSameDeliveryTarget(subscription: StoredPushSubscription, other: StoredPushSubscription): boolean {
  return (
    subscription.identityKey === other.identityKey &&
    subscription.endpoint === other.endpoint &&
    subscription.expirationTime === other.expirationTime &&
    subscription.keys.p256dh === other.keys.p256dh &&
    subscription.keys.auth === other.keys.auth
  );
}

/** OS notification surfaces cannot load the dashboard's symbol font, so Nerd Font icons (Private Use Area) leave the body. */
const PRIVATE_USE_PATTERN = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+ ?/gu;

function sessionNotificationBody(session: SessionMetadata, detailLevel: PushDetailLevel): string | undefined {
  if (detailLevel === "private") return undefined;
  const labels = [session.title, session.cwdLabel].map(value => value?.replace(PRIVATE_USE_PATTERN, "").trim()).filter(
    (value, index, values): value is string =>
      value !== undefined && value.length > 0 && values.indexOf(value) === index,
  );
  const sessionLine = labels.join(" · ");
  const preview = detailLevel === "preview" ? session.ask?.preview : undefined;
  const combined = [sessionLine, preview].filter((value): value is string => value !== undefined && value.length > 0).join("\n");
  if (combined.length === 0) return undefined;
  return [...combined].slice(0, 256).join("");
}

export class PushService {
  readonly #config: GatewayConfig;
  readonly #registry: SessionRegistry;
  readonly #logger: SafeLogger;
  readonly #transport: PushTransport;
  readonly #path: string;
  readonly #vapid: VapidKeyPair;
  readonly #attention = new Map<string, AttentionState>();
  readonly #deliveryChains = new Map<string, Promise<void>>();
  #subscriptions: readonly StoredPushSubscription[];
  #mutationTail = Promise.resolve();
  #unsubscribeRegistry: (() => void) | undefined;
  #unsubscribeActivityStops: (() => void) | undefined;
  #stopped = false;

  private constructor(options: {
    config: GatewayConfig;
    registry: SessionRegistry;
    logger: SafeLogger;
    transport: PushTransport;
    path: string;
    state: PushState;
  }) {
    this.#config = options.config;
    this.#registry = options.registry;
    this.#logger = options.logger;
    this.#transport = options.transport;
    this.#path = options.path;
    this.#vapid = options.state.vapid;
    this.#subscriptions = options.state.subscriptions.filter(subscription =>
      subscription.expirationTime === null || subscription.expirationTime > Date.now(),
    );
    this.#unsubscribeRegistry = this.#registry.subscribeWithSnapshot(event => this.#acceptRegistryEvent(event));
    this.#unsubscribeActivityStops = this.#registry.subscribeActivityStops(event => {
      if (!this.#stopped) this.#queueActivityStop(event);
    });
  }

  static async open(options: {
    readonly config: GatewayConfig;
    readonly registry: SessionRegistry;
    readonly logger?: SafeLogger;
    readonly transport?: PushTransport;
    readonly statePath?: string;
  }): Promise<PushService> {
    const path = options.statePath ?? join(options.config.paths.stateDir, "push-state.json");
    const state = await loadOrCreatePushState(options.config, path);
    return new PushService({
      config: options.config,
      registry: options.registry,
      logger: options.logger ?? new SafeLogger(),
      transport: options.transport ?? defaultTransport,
      path,
      state,
    });
  }

  configResponse(): PushConfigResponse {
    return { version: PUSH_API_VERSION, applicationServerKey: this.#vapid.publicKey };
  }

  async subscribe(identityKey: string, request: PushSubscriptionRequest): Promise<PushDetailLevel> {
    if (!this.#identityAllowed(identityKey)) throw new Error("push identity is not allowed");
    let stored: StoredPushSubscription | undefined;
    await this.#mutateSubscriptions(current => {
      const existing = current.find(subscription => subscription.endpoint === request.subscription.endpoint);
      stored = {
        identityKey,
        detailLevel: request.detailLevel ?? existing?.detailLevel ?? "session",
        ...request.subscription,
      };
      const remaining = current.filter(subscription => subscription.endpoint !== stored?.endpoint);
      if (remaining.length >= MAX_PUSH_SUBSCRIPTIONS) throw new Error("push subscription limit reached");
      return [...remaining, stored];
    });
    if (stored === undefined) throw new Error("push subscription could not be saved");
    for (const session of this.#registry.snapshot().sessions) {
      if (session.inputRequired && session.canControl && session.ask !== undefined) {
        this.#queueAttention(session, [stored]);
      }
    }
    return stored.detailLevel;
  }

  async unsubscribe(identityKey: string, request: PushUnsubscribeRequest): Promise<boolean> {
    let removed = false;
    await this.#mutateSubscriptions(current =>
      current.filter(subscription => {
        const matches = subscription.identityKey === identityKey && subscription.endpoint === request.endpoint;
        removed ||= matches;
        return !matches;
      }),
    );
    return removed;
  }

  async flush(): Promise<void> {
    while (this.#deliveryChains.size > 0) {
      await Promise.allSettled([...this.#deliveryChains.values()]);
    }
    await this.#mutationTail;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribeRegistry?.();
    this.#unsubscribeRegistry = undefined;
    this.#unsubscribeActivityStops?.();
    this.#unsubscribeActivityStops = undefined;
    await this.flush();
  }

  #identityAllowed(identityKey: string): boolean {
    return this.#config.auth.mode === "dev-localhost"
      ? identityKey === "dev-localhost"
      : this.#config.auth.allowedLogins.includes(identityKey);
  }

  #acceptRegistryEvent(event: SessionEvent): void {
    if (this.#stopped) return;
    if (event.type === "snapshot") {
      this.#attention.clear();
      for (const session of event.sessions) {
        this.#attention.set(session.instanceId, {
          generation: session.generation,
          ...(session.ask === undefined ? {} : { requestId: session.ask.requestId }),
          active: session.inputRequired && session.canControl && session.ask !== undefined,
        });
      }
      return;
    }
    if (event.type === "session_remove") {
      const previous = this.#attention.get(event.instanceId);
      if (previous?.generation !== event.generation) return;
      this.#attention.delete(event.instanceId);
      if (previous.active && previous.requestId !== undefined) {
        this.#queueClear(event.instanceId, previous.requestId);
      }
      return;
    }

    const { session } = event;
    const previous = this.#attention.get(session.instanceId);
    const active = session.inputRequired && session.canControl && session.ask !== undefined;
    if (
      previous?.active &&
      previous.requestId !== undefined &&
      (!active || previous.requestId !== session.ask?.requestId)
    ) {
      this.#queueClear(session.instanceId, previous.requestId);
    }
    if (active) this.#queueAttention(session);
    this.#attention.set(session.instanceId, {
      generation: session.generation,
      ...(session.ask === undefined ? {} : { requestId: session.ask.requestId }),
      active,
    });
  }

  #pendingAskCount(): number {
    return this.#registry.snapshot().sessions.filter(
      session => session.inputRequired && session.canControl && session.ask !== undefined,
    ).length;
  }

  #queueAttention(
    session: SessionMetadata,
    subscriptions?: readonly StoredPushSubscription[],
  ): void {
    const requestId = session.ask?.requestId;
    if (requestId === undefined) return;
    const pendingAskCount = this.#pendingAskCount();
    this.#queueDelivery(session.instanceId, async () => {
      await this.#deliver(
        session.instanceId,
        subscription => {
          const body = sessionNotificationBody(session, subscription.detailLevel);
          return {
            version: PUSH_API_VERSION,
            type: "attention",
            instanceId: session.instanceId,
            generation: session.generation,
            requestId,
            pendingAskCount,
            title: "OMP session needs attention",
            ...(body === undefined ? {} : { body }),
          };
        },
        subscriptions,
      );
    });
  }

  #queueActivityStop(event: SessionActivityStopEvent): void {
    const { instanceId, generation } = event.session;
    this.#queueDelivery(instanceId, async () => {
      // A later ask, resume, unreadable poll, or replacement invalidates this edge even if the
      // session has already returned to the same stopped metadata while delivery was queued.
      const pendingAskCount = this.#pendingAskCount();
      const current = this.#registry.authorizeLaunch(instanceId, generation, "view");
      if (current.status !== "ok") return;
      const { session } = current;
      if (!session.canView || session.busy !== false || session.inputRequired || session.ask !== undefined) return;
      if (!this.#registry.isCurrentActivityStop(event)) return;
      await this.#deliver(instanceId, subscription => {
        const body = sessionNotificationBody(session, subscription.detailLevel === "private" ? "private" : "session");
        return {
          version: PUSH_API_VERSION,
          type: "activity_stop",
          instanceId,
          generation,
          pendingAskCount,
          title: "OMP session activity stopped",
          ...(body === undefined ? {} : { body }),
        };
      });
    });
  }

  #queueClear(instanceId: string, requestId: string): void {
    const pendingAskCount = this.#pendingAskCount();
    this.#queueDelivery(instanceId, async () => {
      await this.#deliver(instanceId, () => ({
        version: PUSH_API_VERSION,
        type: "clear",
        instanceId,
        requestId,
        pendingAskCount,
      }));
    });
  }

  #queueDelivery(instanceId: string, send: () => Promise<void>): void {
    const prior = this.#deliveryChains.get(instanceId) ?? Promise.resolve();
    const delivery = prior
      .then(send)
      .catch(() => {
        this.#logger.event("warn", "push.delivery_failed");
      })
      .finally(() => {
        if (this.#deliveryChains.get(instanceId) === delivery) this.#deliveryChains.delete(instanceId);
      });
    this.#deliveryChains.set(instanceId, delivery);
  }

  async #deliver(
    instanceId: string,
    messageFor: (subscription: StoredPushSubscription) => AttentionPushMessage,
    selectedSubscriptions?: readonly StoredPushSubscription[],
  ): Promise<void> {
    const subscriptions = (selectedSubscriptions ?? this.#subscriptions).filter(subscription =>
      this.#identityAllowed(subscription.identityKey),
    );
    if (subscriptions.length === 0) return;
    const stale: StoredPushSubscription[] = [];
    await Promise.all(
      subscriptions.map(async subscription => {
        try {
          await this.#transport.send(subscription, JSON.stringify(messageFor(subscription)), {
            subject: VAPID_SUBJECT,
            publicKey: this.#vapid.publicKey,
            privateKey: this.#vapid.privateKey,
            ttlSeconds: PUSH_TTL_SECONDS,
          });
        } catch (error) {
          const code = statusCode(error);
          if (code === 404 || code === 410) stale.push(subscription);
          else this.#logger.event("warn", "push.delivery_failed", { ...(code === undefined ? {} : { status: code }) });
        }
      }),
    );
    if (stale.length > 0) {
      await this.#mutateSubscriptions(current =>
        current.filter(
          subscription => !stale.some(failed => isSameDeliveryTarget(subscription, failed)),
        ),
      );
    }
  }

  async #mutateSubscriptions(
    mutate: (current: readonly StoredPushSubscription[]) => readonly StoredPushSubscription[],
  ): Promise<void> {
    const operation = this.#mutationTail.then(async () => {
      const next = mutate(this.#subscriptions);
      const state: PushState = { version: PUSH_STATE_VERSION, vapid: this.#vapid, subscriptions: next };
      await writePrivateTextFile(this.#path, `${JSON.stringify(state, null, 2)}\n`);
      this.#subscriptions = next;
    });
    this.#mutationTail = operation.catch(() => undefined);
    await operation;
  }
}
