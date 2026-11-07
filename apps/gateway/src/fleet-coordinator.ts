import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  MAX_COORDINATOR_FLEET_GRANTS, MAX_FLEET_FEED_EVENT_BYTES, MAX_FLEET_OUTSTANDING_ASKS,
  MAX_SESSIONS, fleetGrantVerifier, fleetOwnerDigest, fleetSessionSuffix, fleetSourceBinding,
  newFleetGrantSecret, parseClientConfigResponse, parseFleetBearer, parseFleetFeedEvent,
  parseFleetGrantCreateResponse, parseFleetPushMessage, parseFleetRecipientResponse,
  parseFleetStatusResponse, parseSourceGrantResponse,
  type FleetFeedEvent, type FleetFeedSession, type FleetPendingAsk, type FleetPushMessage,
  type FleetGrantCreateResponse, type FleetRecipientResponse, type FleetSourceState,
  type FleetStatusResponse,
} from "@omp-session-gateway/protocol";
import { readPrivateTextFile, writePrivateTextFile } from "./config.ts";
import { SafeLogger } from "./logger.ts";
import { PushService, type FleetPushRecipient } from "./push.ts";
import { SessionRegistry } from "./registry.ts";

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_QUEUE = 256;
const RETRY_MAX = 300_000;

export interface FleetCoordinatorConfig {
  readonly publicOrigin: string;
  readonly ownLabel: string;
  readonly sources: readonly { readonly id: string; readonly origin: string; readonly label: string }[];
}

interface Grant {
  owner: string;
  sourceId: string;
  origin: string;
  grantId: string;
  secret: string;
  active: boolean;
  expiresAt?: string;
}
interface Recipient {
  key: string;
  owner: string;
  sources: string[];
  outstanding: FleetPendingAsk[];
}
interface State {
  version: 1;
  epoch: number;
  grants: Grant[];
  recipients: Recipient[];
}
interface Knowledge {
  state: FleetSourceState;
  sessions: Map<string, FleetFeedSession>;
  reported: boolean;
  snapshot: boolean;
}
interface Puller {
  abort: AbortController;
  task: Promise<void>;
  resolve: (result: Activation) => void;
  first: Promise<Activation>;
  settled: boolean;
  timer?: Timer;
}
type Activation = "ok" | "grant_rejected" | "source_unreachable" | "unsupported";
interface Delivery {
  recipient: Recipient;
  endpoint: string;
  message: FleetPushMessage;
  grantId?: string;
  valid?: () => boolean;
}
export interface FleetCoordinatorClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}
const systemClock: FleetCoordinatorClock = { now: Date.now, setTimeout, clearTimeout };

export interface FleetCoordinatorOptions {
  config: FleetCoordinatorConfig;
  push: PushService;
  registry: SessionRegistry;
  stateDir: string;
  clock?: FleetCoordinatorClock;
  fetch?: typeof fetch;
  random?: () => number;
  logger?: SafeLogger;
  discoveryWarm?: () => boolean;
}

export class FleetCoordinatorProblem extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function endpointKey(endpoint: string): string { return createHash("sha256").update(endpoint).digest("hex"); }
function ownerSource(owner: string, sourceId: string): string { return `${owner}\0${sourceId}`; }
function askKey(ask: FleetPendingAsk): string {
  return `${ask.source ?? "local"}\0${ask.instanceId}\0${ask.generation}\0${ask.requestId}`;
}
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid fleet state");
  const result = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("invalid fleet state");
  return result;
}
function owner(value: unknown): string {
  if (typeof value !== "string" || !/^[^\0\r\n]{1,320}$/u.test(value)) throw new Error("invalid fleet state");
  return value;
}
function parseState(value: unknown): State {
  const raw = record(value, ["version", "epoch", "grants", "recipients"]);
  if (raw.version !== 1 || !Number.isSafeInteger(raw.epoch) || (raw.epoch as number) < 1 ||
      !Array.isArray(raw.grants) || raw.grants.length > MAX_COORDINATOR_FLEET_GRANTS ||
      !Array.isArray(raw.recipients) || raw.recipients.length > 8) throw new Error("invalid fleet state");
  const grants = raw.grants.map(value => {
    const grant = record(value, ["owner", "sourceId", "origin", "grantId", "secret", "active"], ["expiresAt"]);
    const peer = parseClientConfigResponse({ version: 1, local: { id: "local", origin: "http://127.0.0.1", label: "Local" },
      targets: [{ id: grant.sourceId, origin: grant.origin, label: "Source" }], speech: { browserRecognition: false } }).targets[0]!;
    const bearer = parseFleetBearer(`Bearer ${String(grant.grantId)}.${String(grant.secret)}`);
    if (bearer === undefined || typeof grant.active !== "boolean") throw new Error("invalid fleet state");
    const expiry = grant.expiresAt === undefined ? {} : { expiresAt: parseSourceGrantResponse({ version: 1, grantId: bearer.grantId, expiresAt: grant.expiresAt }).expiresAt };
    return { owner: owner(grant.owner), sourceId: peer.id, origin: peer.origin, ...bearer, active: grant.active, ...expiry };
  });
  const recipients = raw.recipients.map(value => {
    const recipient = record(value, ["key", "owner", "sources", "outstanding"]);
    if (typeof recipient.key !== "string" || !/^[0-9a-f]{64}$/u.test(recipient.key) || !Array.isArray(recipient.outstanding) || recipient.outstanding.length > MAX_FLEET_OUTSTANDING_ASKS) throw new Error("invalid fleet state");
    const sources = [...parseFleetRecipientResponse({ version: 1, sources: recipient.sources, released: [] }).sources];
    const outstanding = recipient.outstanding.map(value => {
      const ask = record(value, ["instanceId", "generation", "requestId"], ["source"]);
      const parsed = parseFleetPushMessage({ ...ask, version: 3, type: "clear", seq: { epoch: 1, n: 1 }, badge: { count: 0, complete: false } });
      if (parsed.type !== "clear") throw new Error("invalid fleet state");
      return { ...(parsed.source === undefined ? {} : { source: parsed.source }), instanceId: parsed.instanceId, generation: parsed.generation, requestId: parsed.requestId };
    });
    if (new Set(outstanding.map(askKey)).size !== outstanding.length) throw new Error("invalid fleet state");
    return { key: recipient.key, owner: owner(recipient.owner), sources, outstanding };
  });
  if (new Set(recipients.map(recipient => recipient.key)).size !== recipients.length ||
      new Set(grants.map(grant => grant.grantId)).size !== grants.length ||
      new Set(grants.map(grant => `${ownerSource(grant.owner, grant.sourceId)}\0${grant.active}`)).size !== grants.length) throw new Error("invalid fleet state");
  return { version: 1, epoch: raw.epoch as number, grants, recipients };
}

/** Read-only doctor probe: never returns credential or owner material, and never repairs evidence. */
export async function fleetCoordinatorStateHealthy(stateDir: string): Promise<boolean> {
  try {
    const raw = await readPrivateTextFile(join(stateDir, "fleet-notifications.json"), MAX_STATE_BYTES);
    if (raw !== undefined) parseState(JSON.parse(raw));
    return true;
  } catch { return false; }
}

/** Only the configured hosts bypass proxies. Bun reads NO_PROXY at fetch-call time. */
function bypassProxy(origin: string): void {
  const hostname = new URL(origin).hostname;
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const entries = (process.env[key] ?? "").split(",").filter(Boolean);
    if (!entries.includes(hostname)) process.env[key] = [...entries, hostname].join(",");
  }
}

/** One persisted authority, one receipt sequence, bounded per-device reconciliation and pullers. */
export class FleetCoordinator {
  readonly #config: FleetCoordinatorConfig;
  readonly #push: PushService;
  readonly #registry: SessionRegistry;
  readonly #path: string;
  readonly #clock: FleetCoordinatorClock;
  readonly #fetch: typeof fetch;
  readonly #random: () => number;
  readonly #logger: SafeLogger;
  readonly #warm: () => boolean;
  readonly #bindings = new Map<string, string>();
  readonly #labels = new Map<string, string>();
  readonly #knowledge = new Map<string, Knowledge>();
  readonly #pullers = new Map<string, Puller>();
  readonly #queue: Delivery[] = [];
  readonly #inflight = new Set<Promise<void>>();
  readonly #unsubscribers: Array<() => void> = [];
  #state: State = { version: 1, epoch: 0, grants: [], recipients: [] };
  #healthy = true;
  #stopped = false;
  #sequence = 0;
  #tail = Promise.resolve();
  #reconcileScheduled = false;
  #deferredClears = false;
  #restarting = true;
  #mutating = false;
  #pendingStops = 0;
  #restartDeadline = 0;
  #restartTimer: Timer | undefined;

  private constructor(options: FleetCoordinatorOptions) {
    this.#config = options.config; this.#push = options.push; this.#registry = options.registry;
    this.#path = join(options.stateDir, "fleet-notifications.json"); this.#clock = options.clock ?? systemClock;
    this.#fetch = options.fetch ?? fetch; this.#random = options.random ?? Math.random;
    this.#logger = options.logger ?? new SafeLogger(); this.#warm = options.discoveryWarm ?? (() => true);
  }

  static async open(options: FleetCoordinatorOptions): Promise<FleetCoordinator> {
    // Reuse the public configuration parser even for hand-built internal configurations.
    const parsed = parseClientConfigResponse({ version: 1, local: { id: "local", origin: options.config.publicOrigin, label: options.config.ownLabel },
      targets: options.config.sources, speech: { browserRecognition: false } });
    const coordinator = new FleetCoordinator({ ...options, config: { publicOrigin: parsed.local.origin, ownLabel: parsed.local.label, sources: parsed.targets } });
    for (const source of parsed.targets) {
      const binding = await fleetSourceBinding(source.id, source.origin);
      coordinator.#bindings.set(source.id, binding);
      coordinator.#labels.set(binding, source.label);
    }
    try {
      const raw = await readPrivateTextFile(coordinator.#path, MAX_STATE_BYTES);
      if (raw !== undefined) coordinator.#state = parseState(JSON.parse(raw));
      coordinator.#state.epoch = Math.max(coordinator.#state.epoch + 1, Math.floor(coordinator.#clock.now() / 1_000));
      if (!Number.isSafeInteger(coordinator.#state.epoch)) throw new Error("invalid fleet epoch");
      await coordinator.#persist();
    } catch { coordinator.#failClosed(); }
    coordinator.#push.attachFleet(coordinator);
    if (!coordinator.#healthy) return coordinator;
    coordinator.#restartDeadline = coordinator.#clock.now() + 30_000;
    coordinator.#restartTimer = coordinator.#clock.setTimeout(() => coordinator.#scheduleReconcile(), 30_000);
    coordinator.#unsubscribers.push(coordinator.#registry.subscribeWithSnapshot(() => coordinator.#scheduleReconcile()));
    coordinator.#unsubscribers.push(coordinator.#registry.subscribeActivityStops(event => {
      if (coordinator.#restarting || coordinator.#queue.length + coordinator.#pendingStops >= MAX_QUEUE) return;
      coordinator.#pendingStops++;
      void coordinator.#serial(async () => {
        if (!coordinator.#registry.isCurrentActivityStop(event)) return;
        const current = coordinator.#registry.authorizeLaunch(event.session.instanceId, event.session.generation, "view");
        if (current.status !== "ok" || !current.session.canView || current.session.busy !== false || current.session.inputRequired || current.session.ask !== undefined) return;
        for (const recipient of coordinator.#state.recipients) coordinator.#enqueue(recipient, "activity_stop", event.session, undefined,
          () => coordinator.#registry.isCurrentActivityStop(event));
        await coordinator.#persist();
      }).catch(() => undefined).finally(() => { coordinator.#pendingStops--; });
    }));
    await coordinator.#serial(async () => { coordinator.#prune(); coordinator.#syncPullers(); await coordinator.#reconcile(); });
    return coordinator;
  }

  get healthy(): boolean { return this.#healthy; }
  diagnostics(): { healthy: boolean; grants: number; recipients: number; queued: number; sending: number } {
    return { healthy: this.#healthy, grants: this.#state.grants.length, recipients: this.#state.recipients.length, queued: this.#queue.length, sending: this.#inflight.size };
  }
  includes(owner: string, endpoint: string): boolean {
    return !this.#healthy || this.#state.recipients.some(recipient => recipient.owner === owner && recipient.key === endpointKey(endpoint));
  }
  subscriptionsChanged(): void { this.#scheduleReconcile(); }
  #subscription(recipient: Recipient): FleetPushRecipient | undefined {
    return this.#push.fleetRecipients().find(subscription => subscription.owner === recipient.owner && endpointKey(subscription.endpoint) === recipient.key);
  }
  #grant(owner: string, sourceId: string): Grant | undefined {
    return this.#state.grants.find(grant => grant.owner === owner && grant.sourceId === sourceId && grant.active) ??
      this.#state.grants.find(grant => grant.owner === owner && grant.sourceId === sourceId);
  }
  #known(owner: string, sourceId: string): Knowledge {
    const key = ownerSource(owner, sourceId);
    let value = this.#knowledge.get(key);
    if (value === undefined) {
      value = { state: this.#grant(owner, sourceId) === undefined ? "not_enrolled" : "pending", sessions: new Map(), reported: false, snapshot: false };
      this.#knowledge.set(key, value);
    }
    return value;
  }
  #assertHealthy(): void { if (!this.#healthy || this.#stopped) throw new FleetCoordinatorProblem(503, "fleet_unavailable"); }
  #failClosed(): void {
    this.#healthy = false;
    for (const puller of this.#pullers.values()) puller.abort.abort();
    this.#queue.length = 0;
    this.#logger.event("error", "fleet.state_unavailable", { healthy: false });
  }
  async #persist(): Promise<void> {
    try {
      const text = `${JSON.stringify(this.#state)}\n`;
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("fleet state capacity");
      await writePrivateTextFile(this.#path, text);
    } catch { this.#failClosed(); throw new FleetCoordinatorProblem(503, "fleet_unavailable"); }
  }
  #serial(work: () => Promise<void>): Promise<void> {
    const operation = this.#tail.then(async () => {
      this.#assertHealthy();
      this.#mutating = true;
      try { await work(); }
      finally { this.#mutating = false; }
      this.#drain();
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
  #scheduleReconcile(): void {
    if (this.#reconcileScheduled || this.#stopped || !this.#healthy) return;
    this.#reconcileScheduled = true;
    void this.#serial(async () => {
      this.#reconcileScheduled = false; this.#prune(); this.#syncPullers(); await this.#reconcile();
    }).catch(() => undefined);
  }
  #prune(): void {
    const removed = this.#state.recipients.filter(recipient => this.#subscription(recipient) === undefined);
    this.#state.recipients = this.#state.recipients.filter(recipient => !removed.includes(recipient));
    for (const recipient of removed) this.#releaseUnused(recipient.owner, recipient.sources);
    this.#state.grants = this.#state.grants.filter(grant => {
      const allowed = this.#push.fleetRecipients().some(subscription => subscription.owner === grant.owner);
      const configured = this.#config.sources.some(source => source.id === grant.sourceId && source.origin === grant.origin);
      if (!allowed || !configured) { this.#known(grant.owner, grant.sourceId).state = "unauthorized"; return false; }
      return true;
    });
  }
  async status(owner: string, endpoint?: string): Promise<FleetStatusResponse> {
    if (endpoint !== undefined && !this.#push.fleetRecipients().some(subscription => subscription.owner === owner && subscription.endpoint === endpoint)) throw new FleetCoordinatorProblem(409, "subscription_required");
    await this.#serial(async () => { this.#prune(); this.#syncPullers(); await this.#reconcile(); });
    const recipient = endpoint === undefined ? undefined : this.#state.recipients.find(value => value.owner === owner && value.key === endpointKey(endpoint));
    return parseFleetStatusResponse({ version: 1, sources: this.#config.sources.map(source => {
      const grant = this.#grant(owner, source.id);
      const known = this.#known(owner, source.id).state;
      const state = grant === undefined ? known === "unsupported" ? "unsupported" : "not_enrolled" :
        (known === "current" || known === "stale") && grant.expiresAt === undefined ? "pending" : known;
      return { sourceId: source.id, state, selected: recipient?.sources.includes(source.id) ?? false,
        ...(grant === undefined ? {} : { grantId: grant.grantId, ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }) }) };
    }) });
  }
  async createGrant(owner: string, sourceId: string): Promise<FleetGrantCreateResponse> {
    let result!: FleetGrantCreateResponse;
    await this.#serial(async () => {
      const source = this.#config.sources.find(source => source.id === sourceId);
      if (source === undefined) throw new FleetCoordinatorProblem(400, "bad_request");
      if (!this.#push.fleetRecipients().some(subscription => subscription.owner === owner)) throw new FleetCoordinatorProblem(409, "subscription_required");
      this.#prune();
      this.#state.grants = this.#state.grants.filter(grant => grant.owner !== owner || grant.sourceId !== sourceId || grant.active);
      if (this.#state.grants.length >= MAX_COORDINATOR_FLEET_GRANTS) throw new FleetCoordinatorProblem(503, "grant_capacity");
      const grant: Grant = { owner, sourceId, origin: source.origin, grantId: randomUUID(), secret: newFleetGrantSecret(), active: false };
      this.#state.grants.push(grant);
      result = parseFleetGrantCreateResponse({ version: 1, grantId: grant.grantId, verifier: await fleetGrantVerifier(grant.grantId, grant.secret) });
      if (this.#grant(owner, sourceId) === grant) this.#known(owner, sourceId).state = "pending";
      this.#syncPullers();
      await this.#persist();
    });
    return result;
  }
  async activate(owner: string, grantId: string): Promise<void> {
    this.#assertHealthy();
    const grant = this.#state.grants.find(grant => grant.owner === owner && grant.grantId === grantId);
    if (grant === undefined || !this.#push.fleetRecipients().some(subscription => subscription.owner === owner)) throw new FleetCoordinatorProblem(409, "grant_rejected");
    let puller = this.#pullers.get(grantId);
    if (puller?.settled && this.#known(owner, grant.sourceId).state !== "current") {
      puller.abort.abort();
      await puller.task;
      puller = undefined;
    }
    puller ??= this.#startPuller(grant, true);
    const timeout = Promise.withResolvers<Activation>();
    const timer = this.#clock.setTimeout(() => timeout.resolve("source_unreachable"), 5_000);
    const result = await Promise.race([puller.first, timeout.promise]);
    this.#clock.clearTimeout(timer);
    if (result !== "ok") {
      await this.#serial(async () => {
        if (!grant.active) this.#state.grants = this.#state.grants.filter(value => value !== grant);
        this.#syncPullers(); await this.#persist();
      });
      throw new FleetCoordinatorProblem(result === "grant_rejected" ? 409 : result === "unsupported" ? 404 : 503, result);
    }
  }
  async revoke(owner: string, grantId: string): Promise<void> {
    await this.#serial(async () => {
      const grant = this.#state.grants.find(grant => grant.owner === owner && grant.grantId === grantId);
      if (grant !== undefined) {
        this.#state.grants = this.#state.grants.filter(value => value !== grant);
        if (this.#grant(owner, grant.sourceId) === undefined) this.#known(owner, grant.sourceId).state = "unauthorized";
      }
      this.#syncPullers(); await this.#reconcile();
    });
  }
  async select(owner: string, endpoint: string, sources: readonly string[]): Promise<FleetRecipientResponse> {
    let released: Array<{ sourceId: string; grantId: string }> = [];
    await this.#serial(async () => {
      // Reuse the response parser for an empty deselection; the HTTP request parser forbids empty PUTs.
      parseFleetRecipientResponse({ version: 1, sources, released: [] });
      if (sources.some(id => !this.#bindings.has(id))) throw new FleetCoordinatorProblem(400, "bad_request");
      const subscription = this.#push.fleetRecipients().find(value => value.owner === owner && value.endpoint === endpoint);
      if (subscription === undefined) throw new FleetCoordinatorProblem(409, "subscription_required");
      let recipient = this.#state.recipients.find(value => value.key === endpointKey(endpoint));
      if (recipient !== undefined && recipient.owner !== owner) throw new FleetCoordinatorProblem(409, "subscription_required");
      if (recipient === undefined && sources.length > 0) {
        if (this.#state.recipients.length >= 8) throw new FleetCoordinatorProblem(503, "recipient_capacity");
        recipient = { key: endpointKey(endpoint), owner, sources: [], outstanding: [] }; this.#state.recipients.push(recipient);
      }
      const previous = recipient?.sources ?? [];
      if (recipient !== undefined) recipient.sources = [...sources];
      released = this.#releaseUnused(owner, previous.filter(id => !sources.includes(id)));
      this.#syncPullers(); await this.#reconcile(true);
    });
    return parseFleetRecipientResponse({ version: 1, sources, released });
  }
  #releaseUnused(owner: string, sources: readonly string[]): Array<{ sourceId: string; grantId: string }> {
    const released: Array<{ sourceId: string; grantId: string }> = [];
    this.#state.grants = this.#state.grants.filter(grant => {
      if (grant.owner !== owner || !sources.includes(grant.sourceId) || this.#state.recipients.some(recipient => recipient.owner === owner && recipient.sources.includes(grant.sourceId))) return true;
      const prior = released.findIndex(value => value.sourceId === grant.sourceId);
      if (prior === -1) released.push({ sourceId: grant.sourceId, grantId: grant.grantId });
      else if (grant.active) released[prior] = { sourceId: grant.sourceId, grantId: grant.grantId };
      this.#known(owner, grant.sourceId).state = "not_enrolled"; return false;
    });
    return released;
  }
  #syncPullers(): void {
    for (const [id, puller] of this.#pullers) {
      const grant = this.#state.grants.find(grant => grant.grantId === id);
      if (grant === undefined || (puller.settled && !this.#selected(grant))) puller.abort.abort();
    }
    for (const grant of this.#state.grants) {
      if (grant.active && this.#selected(grant) && !this.#pullers.has(grant.grantId)) this.#startPuller(grant, false);
    }
  }
  #selected(grant: Grant): boolean {
    return this.#state.recipients.some(recipient => recipient.owner === grant.owner && recipient.sources.includes(grant.sourceId) && this.#subscription(recipient) !== undefined);
  }
  #startPuller(grant: Grant, activation: boolean): Puller {
    const first = Promise.withResolvers<Activation>();
    const puller: Puller = { abort: new AbortController(), task: Promise.resolve(), first: first.promise, resolve: first.resolve, settled: false };
    this.#pullers.set(grant.grantId, puller);
    puller.task = this.#pull(grant, puller, activation).catch(() => undefined).finally(() => {
      if (!puller.settled) { puller.settled = true; puller.resolve("source_unreachable"); }
      if (puller.timer !== undefined) this.#clock.clearTimeout(puller.timer);
      if (this.#pullers.get(grant.grantId) === puller) this.#pullers.delete(grant.grantId);
      this.#scheduleReconcile();
    });
    return puller;
  }
  async #sleep(puller: Puller, ms: number): Promise<void> {
    if (puller.abort.signal.aborted) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = (): void => { if (puller.timer !== undefined) this.#clock.clearTimeout(puller.timer); puller.abort.signal.removeEventListener("abort", done); resolve(); };
    puller.timer = this.#clock.setTimeout(done, ms); puller.abort.signal.addEventListener("abort", done, { once: true });
    await promise;
  }
  async #pull(grant: Grant, puller: Puller, activation: boolean): Promise<void> {
    const expectedOwner = await fleetOwnerDigest(this.#config.publicOrigin, grant.owner);
    let backoff = 1_000;
    while (!this.#stopped && this.#healthy && !puller.abort.signal.aborted) {
      const connection = new AbortController();
      const cancel = (): void => connection.abort();
      puller.abort.signal.addEventListener("abort", cancel, { once: true });
      let deadline = this.#clock.setTimeout(cancel, activation && !puller.settled ? 5_000 : 45_000);
      let result: Activation = "source_unreachable";
      let received = false;
      let mismatch = false;
      try {
        bypassProxy(grant.origin);
        const response = await this.#fetch(`${grant.origin}/api/v1/notification-feed`, {
          headers: { Authorization: `Bearer ${grant.grantId}.${grant.secret}`, Accept: "text/event-stream" }, redirect: "error", signal: connection.signal,
        });
        if (response.status === 401) result = "grant_rejected";
        else if (response.status === 404) result = "unsupported";
        else if (response.ok && response.headers.get("content-type")?.split(";")[0]?.trim() === "text/event-stream" && response.body !== null) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let buffer = "", name = "", data = "", eventBytes = 0;
          try {
            while (!connection.signal.aborted) {
              const chunk = await reader.read();
              if (chunk.done) break;
              // Limit bytes before decoding/concatenation, including a single oversized transport chunk.
              if (chunk.value.byteLength > MAX_FLEET_FEED_EVENT_BYTES * 2) throw new Error("feed bound");
              buffer += decoder.decode(chunk.value, { stream: true });
              let newline: number;
              while ((newline = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newline).replace(/\r$/u, ""); buffer = buffer.slice(newline + 1);
                const bytes = Buffer.byteLength(line);
                if (bytes > MAX_FLEET_FEED_EVENT_BYTES) throw new Error("feed bound");
                if (line.startsWith(":")) {
                  if (received) {
                    this.#clock.clearTimeout(deadline);
                    deadline = this.#clock.setTimeout(cancel, Math.min(45_000, Math.max(0, Date.parse(grant.expiresAt!) - this.#clock.now())));
                  }
                  continue;
                }
                eventBytes += bytes;
                if (eventBytes > MAX_FLEET_FEED_EVENT_BYTES + 128) throw new Error("feed bound");
                if (line.startsWith("event: ")) name = line.slice(7);
                else if (line.startsWith("data: ")) data += line.slice(6);
                else if (line === "") {
                  if (data !== "") {
                    const event = parseFleetFeedEvent(JSON.parse(data));
                    if (event.type !== name || (!received && event.type !== "snapshot")) throw new Error("feed order");
                    if (event.type === "snapshot" && event.owner !== expectedOwner) { result = "grant_rejected"; mismatch = true; throw new Error("feed owner"); }
                    if (event.type === "snapshot" && Date.parse(event.expiresAt) <= this.#clock.now()) { result = "grant_rejected"; throw new Error("feed expiry"); }
                    await this.#serial(async () => {
                      if (!this.#state.grants.includes(grant) || puller.abort.signal.aborted || !this.#push.fleetRecipients().some(recipient => recipient.owner === grant.owner)) throw new Error("revoked feed");
                      if (event.type === "snapshot") {
                        grant.active = true; grant.expiresAt = event.expiresAt;
                        this.#state.grants = this.#state.grants.filter(value => value === grant || value.owner !== grant.owner || value.sourceId !== grant.sourceId);
                      }
                      await this.#accept(grant, event);
                    });
                    received = true; result = "ok"; backoff = 1_000;
                    this.#clock.clearTimeout(deadline);
                    deadline = this.#clock.setTimeout(cancel, Math.min(45_000, Math.max(0, Date.parse(grant.expiresAt!) - this.#clock.now())));
                    if (!puller.settled) { puller.settled = true; puller.resolve("ok"); }
                    if (!this.#selected(grant)) { puller.abort.abort(); break; }
                  }
                  name = ""; data = ""; eventBytes = 0;
                }
              }
              if (Buffer.byteLength(buffer) > MAX_FLEET_FEED_EVENT_BYTES) throw new Error("feed bound");
            }
          } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        } else await response.body?.cancel();
      } catch { /* No transport errors or credential-bearing URLs enter logs. */ }
      finally { this.#clock.clearTimeout(deadline); connection.abort(); puller.abort.signal.removeEventListener("abort", cancel); }
      if (puller.abort.signal.aborted || this.#stopped || !this.#healthy || !this.#state.grants.includes(grant)) return;
      if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= this.#clock.now()) result = "grant_rejected";
      await this.#serial(async () => {
        const existing = this.#grant(grant.owner, grant.sourceId);
        if (existing === grant || existing?.active !== true) {
          const knowledge = this.#known(grant.owner, grant.sourceId);
          knowledge.state = result === "grant_rejected" ? "unauthorized" : result === "unsupported" ? "unsupported" : "stale";
          knowledge.reported = true;
        }
        if (mismatch) this.#state.grants = this.#state.grants.filter(value => value !== grant);
        await this.#reconcile();
      });
      if (!puller.settled) { puller.settled = true; puller.resolve(result === "ok" ? "source_unreachable" : result); }
      if (mismatch || !grant.active || !this.#selected(grant)) return;
      const delay = result === "grant_rejected" || result === "unsupported" ? RETRY_MAX : Math.round(backoff * (0.8 + this.#random() * 0.4));
      backoff = Math.min(RETRY_MAX, backoff * 2);
      await this.#sleep(puller, delay);
    }
  }
  async #accept(grant: Grant, event: FleetFeedEvent): Promise<void> {
    const knowledge = this.#known(grant.owner, grant.sourceId);
    if (event.type === "snapshot") {
      knowledge.sessions = new Map(event.sessions.map(session => [session.instanceId, session])); knowledge.state = "current"; knowledge.reported = true; knowledge.snapshot = true;
      for (const [id, puller] of this.#pullers) if (!this.#state.grants.some(value => value.grantId === id)) puller.abort.abort();
    } else if (event.type === "upsert") {
      if (!knowledge.sessions.has(event.session.instanceId) && knowledge.sessions.size >= MAX_SESSIONS) throw new Error("feed capacity");
      knowledge.sessions.set(event.session.instanceId, event.session);
    } else if (event.type === "remove") {
      if (knowledge.sessions.get(event.instanceId)?.generation === event.generation) knowledge.sessions.delete(event.instanceId);
    } else if (!this.#restarting) {
      const current = knowledge.sessions.get(event.instanceId);
      if (current?.generation === event.generation && current.requestId === undefined) {
        for (const recipient of this.#state.recipients) {
          if (recipient.owner === grant.owner && recipient.sources.includes(grant.sourceId)) this.#enqueue(recipient, "activity_stop", current, grant.sourceId,
            () => knowledge.sessions.get(current.instanceId) === current && current.requestId === undefined);
        }
      }
    }
    await this.#reconcile();
  }
  #pending(recipient: Recipient): FleetPendingAsk[] {
    const asks: FleetPendingAsk[] = this.#registry.snapshot().sessions.flatMap(session => session.inputRequired && session.canControl && session.ask !== undefined ?
      [{ instanceId: session.instanceId, generation: session.generation, requestId: session.ask.requestId }] : []);
    for (const id of recipient.sources) {
      const known = this.#known(recipient.owner, id), source = this.#bindings.get(id);
      if (source === undefined || (known.state !== "current" && known.state !== "stale" && known.state !== "pending")) continue;
      for (const session of known.sessions.values()) if (session.requestId !== undefined) asks.push({ source, instanceId: session.instanceId, generation: session.generation, requestId: session.requestId });
      if (!known.snapshot) for (const ask of recipient.outstanding) if (ask.source === source) asks.push(ask);
    }
    return asks;
  }
  async #reconcile(force = false): Promise<void> {
    if (this.#restarting) {
      const reported = this.#warm() && this.#state.recipients.every(recipient => recipient.sources.every(id => !this.#bindings.has(id) || this.#known(recipient.owner, id).reported || this.#grant(recipient.owner, id) === undefined));
      if (reported || this.#clock.now() >= this.#restartDeadline) { this.#restarting = false; if (this.#restartTimer !== undefined) this.#clock.clearTimeout(this.#restartTimer); }
      else if (!force) { await this.#persist(); return; }
    }
    this.#deferredClears = false;
    for (const recipient of this.#state.recipients) {
      const pending = this.#pending(recipient), keys = new Set(pending.map(askKey));
      for (const ask of [...recipient.outstanding]) {
        const id = ask.source === undefined ? undefined : [...this.#bindings].find(([, binding]) => binding === ask.source)?.[0];
        const selected = id !== undefined && recipient.sources.includes(id);
        const state = id === undefined ? undefined : this.#known(recipient.owner, id).state;
        const stale = selected && (state === "stale" || state === "pending" || state === "unsupported");
        if (recipient.sources.length === 0 ? ask.source !== undefined : !keys.has(askKey(ask)) && !stale && (ask.source !== undefined || this.#warm())) {
          if (!this.#enqueue(recipient, "clear", ask, id)) this.#deferredClears = true;
        }
      }
      if (recipient.sources.length > 0) for (const ask of pending) {
        const id = ask.source === undefined ? undefined : [...this.#bindings].find(([, binding]) => binding === ask.source)?.[0];
        if ((id === undefined ? this.#warm() : this.#known(recipient.owner, id).state === "current") && !recipient.outstanding.some(previous => askKey(previous) === askKey(ask))) this.#enqueue(recipient, "attention", ask, id);
      }
    }
    this.#state.recipients = this.#state.recipients.filter(recipient => recipient.sources.length > 0 || recipient.outstanding.some(ask => ask.source !== undefined) || this.#queue.some(delivery => delivery.recipient === recipient) || this.#inflight.size > 0);
    await this.#persist();
  }
  #enqueue(recipient: Recipient, type: FleetPushMessage["type"], session: FleetFeedSession & { source?: string }, sourceId?: string, valid?: () => boolean): boolean {
    const subscription = this.#subscription(recipient);
    if (subscription === undefined || this.#queue.length >= MAX_QUEUE || (type === "attention" && recipient.outstanding.length >= MAX_FLEET_OUTSTANDING_ASKS)) return false;
    const source = session.source ?? (sourceId === undefined ? undefined : this.#bindings.get(sourceId));
    const pending = this.#pending(recipient);
    const common = { version: 3, ...(source === undefined ? {} : { source }), instanceId: session.instanceId, generation: session.generation,
      seq: { epoch: this.#state.epoch, n: ++this.#sequence }, badge: { count: pending.length, complete: recipient.sources.every(id => this.#known(recipient.owner, id).state === "current") } };
    let body: string | undefined;
    if (type !== "clear" && subscription.detailLevel !== "private") {
      if (sourceId !== undefined) body = `${this.#config.sources.find(source => source.id === sourceId)!.label} · ${fleetSessionSuffix(session.instanceId)}`;
      else {
        const local = this.#registry.snapshot().sessions.find(value => value.instanceId === session.instanceId && value.generation === session.generation);
        if (local !== undefined) body = this.#push.fleetLocalBody(local, subscription.detailLevel, this.#config.ownLabel);
      }
    }
    const message = parseFleetPushMessage({ ...common, type, ...(type === "clear" || type === "attention" ? { requestId: session.requestId } : {}),
      ...(type === "clear" ? {} : { title: type === "attention" ? "OMP session needs attention" : "OMP session activity stopped", ...(body === undefined ? {} : { body }) }) }, this.#labels);
    if (message.type !== "activity_stop") {
      const ask: FleetPendingAsk = { ...(source === undefined ? {} : { source }), instanceId: session.instanceId, generation: session.generation, requestId: message.requestId };
      if (type === "attention") recipient.outstanding.push(ask);
      else recipient.outstanding = recipient.outstanding.filter(previous => askKey(previous) !== askKey(ask));
    }
    const grantId = sourceId === undefined ? undefined : this.#grant(recipient.owner, sourceId)?.grantId;
    this.#queue.push({ recipient, endpoint: subscription.endpoint, message, ...(grantId === undefined ? {} : { grantId }), ...(valid === undefined ? {} : { valid }) });
    return true;
  }
  #authorized(delivery: Delivery): boolean {
    if (!this.#healthy || this.#stopped || delivery.valid?.() === false) return false;
    const { recipient, message } = delivery;
    if (this.#subscription(recipient) === undefined) return false;
    if (message.type === "clear") return true;
    if (!this.#state.recipients.includes(recipient) || recipient.sources.length === 0) return false;
    if (message.source === undefined) return true;
    const grant = this.#state.grants.find(grant => grant.grantId === delivery.grantId);
    return grant !== undefined && grant.active && grant.owner === recipient.owner && recipient.sources.includes(grant.sourceId) &&
      this.#bindings.get(grant.sourceId) === message.source && this.#known(grant.owner, grant.sourceId).state === "current" &&
      grant.expiresAt !== undefined && Date.parse(grant.expiresAt) > this.#clock.now();
  }
  #drain(): void {
    while (this.#healthy && !this.#stopped && !this.#mutating && this.#inflight.size < 8 && this.#queue.length > 0) {
      const delivery = this.#queue.shift()!;
      const task = this.#push.sendFleet(delivery.recipient.owner, delivery.endpoint, delivery.message, () => this.#authorized(delivery))
        .catch(() => this.#logger.event("warn", "fleet.send_failed", { failed: true }))
        .finally(() => {
          this.#inflight.delete(task); this.#drain();
          if (this.#deferredClears || this.#state.recipients.some(recipient => recipient.sources.length === 0)) this.#scheduleReconcile();
        });
      this.#inflight.add(task);
    }
  }
  async flush(): Promise<void> {
    do { await this.#tail; await Promise.allSettled([...this.#inflight]); } while (this.#inflight.size > 0 || this.#reconcileScheduled || this.#queue.length > 0);
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    if (this.#restartTimer !== undefined) this.#clock.clearTimeout(this.#restartTimer);
    for (const puller of this.#pullers.values()) puller.abort.abort();
    this.#queue.length = 0;
    await Promise.allSettled([...this.#pullers.values()].map(puller => puller.task));
    await this.#tail; await Promise.allSettled([...this.#inflight]);
  }
}

