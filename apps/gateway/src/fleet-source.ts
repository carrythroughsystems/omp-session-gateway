import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  FLEET_GRANT_LIFETIME_MS,
  FLEET_NOTIFICATIONS_VERSION,
  MAX_SOURCE_FLEET_GRANTS,
  fleetGrantVerifier,
  fleetOwnerDigest,
  parseFleetBearer,
  parseFleetFeedEvent,
  parseFleetOrigin,
  parseJsonFrame,
  parseSourceGrantRequest,
  parseSourceGrantResponse,
  type FleetFeedEvent,
  type FleetFeedSession,
  type SessionMetadata,
  type SourceGrantRequest,
  type SourceGrantResponse,
} from "@omp-session-gateway/protocol";
import { normalizeTailscaleLogin } from "./auth.ts";
import { ensureRuntimeDirectories, readPrivateTextFile, writePrivateTextFile, type GatewayConfig } from "./config.ts";
import type { HostPoller } from "./omp-registry.ts";
import { SessionRegistry, type SessionActivityStopEvent } from "./registry.ts";

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 32 * 1024;
const MAX_FEED_QUEUE = 256;
const HEARTBEAT_MS = 15_000;

interface SourceGrant {
  readonly grantId: string;
  readonly coordinator: string;
  readonly owner: string;
  readonly verifier: string;
  readonly expiresAt: string;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid notification grants");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new Error("invalid notification grants");
  }
  return record;
}

function parseState(text: string): SourceGrant[] {
  const record = exactRecord(parseJsonFrame(new TextEncoder().encode(text)), ["version", "grants"]);
  if (record.version !== STATE_VERSION || !Array.isArray(record.grants) || record.grants.length > MAX_SOURCE_FLEET_GRANTS) {
    throw new Error("invalid notification grants");
  }
  const ids = new Set<string>();
  const owners = new Set<string>();
  return record.grants.map((value: unknown) => {
    const grant = exactRecord(value, ["grantId", "coordinator", "owner", "verifier", "expiresAt"]);
    const request = parseSourceGrantRequest({ version: FLEET_NOTIFICATIONS_VERSION, grantId: grant.grantId, verifier: grant.verifier });
    const response = parseSourceGrantResponse({ version: FLEET_NOTIFICATIONS_VERSION, grantId: grant.grantId, expiresAt: grant.expiresAt });
    const coordinator = parseFleetOrigin(grant.coordinator);
    if (typeof grant.owner !== "string" || normalizeTailscaleLogin(grant.owner) !== grant.owner) {
      throw new Error("invalid notification grants");
    }
    const ownerKey = `${grant.owner}\0${coordinator}`;
    if (ids.has(request.grantId) || owners.has(ownerKey)) throw new Error("invalid notification grants");
    ids.add(request.grantId);
    owners.add(ownerKey);
    return { grantId: request.grantId, verifier: request.verifier, expiresAt: response.expiresAt, coordinator, owner: grant.owner };
  });
}

/** Read-only doctor probe: do not create, repair, prune, or delete evidence. */
export async function notificationGrantsHealthy(config: GatewayConfig): Promise<boolean> {
  try {
    const text = await readPrivateTextFile(join(config.paths.stateDir, "notification-grants.json"), MAX_STATE_BYTES);
    if (text !== undefined) parseState(text);
    return true;
  } catch {
    return false;
  }
}

export class FleetSourceProblem extends Error {
  constructor(readonly status: number, readonly code: string) {
    super("Fleet notifications unavailable");
  }
}

function projectSession(session: SessionMetadata): FleetFeedSession {
  return {
    instanceId: session.instanceId,
    generation: session.generation,
    ...(session.inputRequired && session.canControl && session.ask !== undefined ? { requestId: session.ask.requestId } : {}),
  };
}

interface FeedConnection { close(): void }
interface QueuedEvent { readonly event?: FleetFeedEvent; readonly stop?: SessionActivityStopEvent }

export interface FleetSourceOptions {
  readonly config: GatewayConfig;
  readonly registry: SessionRegistry;
  readonly poller: Pick<HostPoller, "discoveryWarm" | "subscribeObservations">;
  readonly now?: () => number;
  readonly heartbeatMs?: number;
  readonly write?: typeof writePrivateTextFile;
}

/** Source-only state: verifiers, never secrets or session metadata. */
export class FleetSourceService {
  readonly #config: GatewayConfig;
  readonly #registry: SessionRegistry;
  readonly #poller: Pick<HostPoller, "discoveryWarm" | "subscribeObservations">;
  readonly #path: string;
  readonly #now: () => number;
  readonly #heartbeatMs: number;
  readonly #write: typeof writePrivateTextFile;
  readonly #grants = new Map<string, SourceGrant>();
  readonly #connections = new Map<string, FeedConnection>();
  #healthy = true;
  #stopped = false;
  #mutationTail: Promise<void> = Promise.resolve();

  private constructor(options: FleetSourceOptions) {
    this.#config = options.config;
    this.#registry = options.registry;
    this.#poller = options.poller;
    this.#now = options.now ?? Date.now;
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.#write = options.write ?? writePrivateTextFile;
    this.#path = join(options.config.paths.stateDir, "notification-grants.json");
  }

  static async open(options: FleetSourceOptions): Promise<FleetSourceService> {
    const service = new FleetSourceService(options);
    try {
      await ensureRuntimeDirectories(options.config);
      const text = await readPrivateTextFile(service.#path, MAX_STATE_BYTES);
      if (text !== undefined) for (const grant of parseState(text)) service.#grants.set(grant.grantId, grant);
    } catch {
      service.#healthy = false;
    }
    return service;
  }

  get healthy(): boolean { return this.#healthy && !this.#stopped; }

  #coordinatorAllowed(origin: string): boolean {
    return this.#config.notifications?.coordinators?.some(peer => peer.origin === origin) === true &&
      this.#config.http.trustedDashboardOrigins.includes(origin);
  }

  #ownerAllowed(owner: string): boolean {
    return this.#config.auth.mode === "dev-localhost" ? owner === "dev-localhost" : this.#config.auth.allowedLogins.includes(owner);
  }

  #authorized(grant: SourceGrant): boolean {
    return this.healthy && this.#grants.get(grant.grantId) === grant && this.#coordinatorAllowed(grant.coordinator) &&
      this.#ownerAllowed(grant.owner) && Date.parse(grant.expiresAt) > this.#now();
  }

  #assertAvailable(): void {
    if (!this.healthy) throw new FleetSourceProblem(503, "grants_unavailable");
  }

  #mutate<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = this.#mutationTail.then(() => { this.#assertAvailable(); return mutation(); });
    this.#mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #persist(grants: Map<string, SourceGrant>): Promise<void> {
    try {
      await this.#write(this.#path, `${JSON.stringify({ version: STATE_VERSION, grants: [...grants.values()] })}\n`, { syncDirectory: true });
    } catch {
      this.#healthy = false;
      for (const connection of this.#connections.values()) connection.close();
      throw new FleetSourceProblem(503, "grants_unavailable");
    }
    // Shutdown can race a durable write. It never reopens authorization or live connections.
    this.#grants.clear();
    for (const [id, grant] of grants) this.#grants.set(id, grant);
    for (const [id, connection] of this.#connections) if (!this.#grants.has(id)) connection.close();
  }

  #pruned(): Map<string, SourceGrant> {
    return new Map([...this.#grants].filter(([, grant]) => Date.parse(grant.expiresAt) > this.#now()));
  }

  create(owner: string, coordinator: string, request: SourceGrantRequest): Promise<SourceGrantResponse> {
    return this.#mutate(async () => {
      if (!this.#ownerAllowed(owner) || !this.#coordinatorAllowed(coordinator)) throw new FleetSourceProblem(403, "forbidden");
      const existing = this.#grants.get(request.grantId);
      if (existing && (existing.owner !== owner || existing.coordinator !== coordinator)) {
        throw new FleetSourceProblem(409, "grant_rejected");
      }
      const grants = this.#pruned();
      for (const [id, grant] of grants) {
        if (grant.owner === owner && grant.coordinator === coordinator) grants.delete(id);
      }
      if (grants.size >= MAX_SOURCE_FLEET_GRANTS) throw new FleetSourceProblem(503, "grant_capacity");
      const grant = { grantId: request.grantId, verifier: request.verifier, coordinator, owner,
        expiresAt: new Date(this.#now() + FLEET_GRANT_LIFETIME_MS).toISOString() };
      grants.set(grant.grantId, grant);
      // Refuse the replaced credential before a durable write can yield to a feed event.
      for (const [id, previous] of this.#grants) {
        if (!grants.has(id) || id === grant.grantId) {
          this.#grants.delete(id);
          this.#connections.get(previous.grantId)?.close();
        }
      }
      await this.#persist(grants);
      return parseSourceGrantResponse({ version: FLEET_NOTIFICATIONS_VERSION, grantId: grant.grantId, expiresAt: grant.expiresAt });
    });
  }

  renew(owner: string, coordinator: string, grantId: string): Promise<SourceGrantResponse> {
    return this.#mutate(async () => {
      const prior = this.#grants.get(grantId);
      if (!this.#ownerAllowed(owner) || !this.#coordinatorAllowed(coordinator) ||
          prior?.owner !== owner || prior.coordinator !== coordinator) throw new FleetSourceProblem(401, "unauthorized");
      const grant = { ...prior, expiresAt: new Date(this.#now() + FLEET_GRANT_LIFETIME_MS).toISOString() };
      const grants = this.#pruned();
      grants.set(grantId, grant);
      await this.#persist(grants);
      this.#connections.get(grantId)?.close();
      return parseSourceGrantResponse({ version: FLEET_NOTIFICATIONS_VERSION, grantId, expiresAt: grant.expiresAt });
    });
  }

  revoke(owner: string, coordinator: string, grantId: string): Promise<void> {
    return this.#mutate(async () => {
      const prior = this.#grants.get(grantId);
      const grants = this.#pruned();
      if (prior?.owner === owner && prior.coordinator === coordinator) {
        grants.delete(grantId);
        this.#grants.delete(grantId);
        this.#connections.get(grantId)?.close();
      }
      await this.#persist(grants);
    });
  }

  async authenticate(header: string | null): Promise<string | undefined> {
    this.#assertAvailable();
    const bearer = parseFleetBearer(header);
    if (bearer === undefined) return undefined;
    const grant = this.#grants.get(bearer.grantId);
    if (grant === undefined) return undefined;
    const supplied = await fleetGrantVerifier(bearer.grantId, bearer.secret);
    if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(grant.verifier))) return undefined;
    return this.#authorized(grant) ? grant.grantId : undefined;
  }

  async feed(grantId: string, stillAuthorized: () => boolean): Promise<Response> {
    this.#assertAvailable();
    const grant = this.#grants.get(grantId);
    if (grant === undefined || !this.#authorized(grant) || !stillAuthorized()) throw new FleetSourceProblem(401, "unauthorized");
    const owner = await fleetOwnerDigest(grant.coordinator, grant.owner);
    if (!this.#authorized(grant) || !stillAuthorized()) throw new FleetSourceProblem(401, "unauthorized");
    this.#connections.get(grantId)?.close();
    const encoder = new TextEncoder();
    const pending: QueuedEvent[] = [];
    const disposers: (() => void)[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let begun = false;
    let waiting = false;
    let delivering = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const connection: FeedConnection = { close: () => {
      if (closed) return;
      closed = true;
      pending.length = 0;
      for (const dispose of disposers) dispose();
      clearInterval(timer);
      clearTimeout(expiry);
      if (this.#connections.get(grantId) === connection) this.#connections.delete(grantId);
      try { controller.close(); } catch { /* The peer may have cancelled first. */ }
    } };
    const authorized = (): boolean => this.#authorized(grant) && stillAuthorized();
    const deliver = (): void => {
      if (closed || !waiting || delivering) return;
      if (!authorized()) { connection.close(); return; }
      delivering = true;
      try {
        while (pending.length > 0) {
          const next = pending.shift()!;
          if (next.stop !== undefined) {
            const current = this.#registry.authorizeLaunch(next.stop.session.instanceId, next.stop.session.generation, "view");
            if (current.status !== "ok" || !current.session.canView || current.session.busy !== false ||
                current.session.inputRequired || current.session.ask !== undefined || !this.#registry.isCurrentActivityStop(next.stop)) continue;
          }
          // Registry revalidation can sweep records and notify other consumers; authorization is last.
          if (closed || !authorized()) { connection.close(); return; }
          waiting = false;
          try {
            controller.enqueue(encoder.encode(next.event === undefined ? ": heartbeat\n\n" :
              `event: ${next.event.type}\ndata: ${JSON.stringify(next.event)}\n\n`));
          } catch { connection.close(); }
          return;
        }
      } finally { delivering = false; }
    };
    const queue = (event?: FleetFeedEvent, stop?: SessionActivityStopEvent): void => {
      if (closed) return;
      if (!authorized() || pending.length >= MAX_FEED_QUEUE) { connection.close(); return; }
      try {
        pending.push({ ...(event === undefined ? {} : { event: parseFleetFeedEvent(event) }), ...(stop === undefined ? {} : { stop }) });
      } catch { connection.close(); return; }
      deliver();
    };
    const retain = (dispose: () => void): void => { if (closed) dispose(); else disposers.push(dispose); };
    const begin = (): void => {
      if (closed || begun || !this.#poller.discoveryWarm) return;
      begun = true;
      retain(this.#registry.subscribeWithSnapshot(event => {
        if (event.type === "snapshot") queue({ version: FLEET_NOTIFICATIONS_VERSION, type: "snapshot", owner,
          expiresAt: grant.expiresAt, sessions: event.sessions.map(projectSession) });
        else if (event.type === "session_upsert") queue({ version: FLEET_NOTIFICATIONS_VERSION, type: "upsert", session: projectSession(event.session) });
        else queue({ version: FLEET_NOTIFICATIONS_VERSION, type: "remove", instanceId: event.instanceId, generation: event.generation });
      }));
      if (!closed) retain(this.#registry.subscribeActivityStops(stop => queue({ version: FLEET_NOTIFICATIONS_VERSION, type: "stop",
        instanceId: stop.session.instanceId, generation: stop.session.generation }, stop)));
    };
    const stream = new ReadableStream<Uint8Array>({
      start: target => {
        controller = target;
        this.#connections.set(grantId, connection);
        retain(this.#poller.subscribeObservations(begin));
        begin();
        if (closed) return;
        timer = setInterval(() => { begin(); queue(); }, this.#heartbeatMs);
        const expire = (): void => {
          if (!authorized()) { connection.close(); return; }
          // Thirty days exceeds the platform timer's signed 32-bit delay.
          expiry = setTimeout(expire, Math.min(2_147_483_647, Math.max(0, Date.parse(grant.expiresAt) - this.#now())));
        };
        expire();
      },
      pull: () => { waiting = true; deliver(); },
      cancel: () => connection.close(),
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no",
    } });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const connection of this.#connections.values()) connection.close();
    await this.#mutationTail;
  }
}
