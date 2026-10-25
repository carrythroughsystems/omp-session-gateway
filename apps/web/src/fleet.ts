import {
  MAX_CLIENT_CONFIG_BYTES, MAX_SESSIONS, INSTANCE_ID_PATTERN,
  parseClientConfigResponse, parseSessionListResponse, parseFleetSourceId, parseFleetOrigin,
  parseJsonFrame, parseSessionCreationOptions, parseSessionCreationRequest, parseSessionCreationReceipt,
  parseSessionCreationStatus, parseSessionCreationUuid,
  MAX_SESSION_CREATION_OPTIONS_BYTES, MAX_SESSION_CREATION_STATUS_BYTES,
  type SessionCreationOptions, type SessionCreationRequest, type SessionCreationReceipt, type SessionCreationStatus,
  type ClientConfigResponse, type FleetSource, type SessionListResponse,
} from "@omp-session-gateway/protocol";

export type SourceKey = string;
export interface SessionRef {
  readonly sourceKey: SourceKey;
  readonly instanceId: string;
  readonly generation: number;
  readonly requestId?: string;
}
export const sourceKey = (source: FleetSource): SourceKey => `${source.id}\0${source.origin}`;
export const sessionKey = (ref: Pick<SessionRef, "sourceKey" | "instanceId">): string =>
  `${ref.sourceKey}\0${ref.instanceId}`;
export type SnapshotResult = "healthy" | "unavailable" | "forbidden";
export type SourceStatus = "loading" | "fresh" | "refreshing" | "stale" | "unavailable" | "forbidden";
export const SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const STALE_GRACE_MS = 35_000;

const freshnessClock = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });

/** A successful observation, never the time a failed check happened. */
export function describeFreshness(status: SourceStatus, freshAt?: number) {
  const time = freshAt === undefined ? undefined : freshnessClock.format(freshAt);
  return {
    status,
    current: status === "fresh",
    failed: status === "stale" || status === "unavailable" || status === "forbidden",
    retry: status === "stale" || status === "unavailable",
    time,
    copy: time === undefined ? "No session list received yet." : `List as of ${time}.`,
  };
}

export async function boundedJson(response: Response, maximum: number, strict = false): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximum) throw new Error("response exceeds bound");
  if (response.body === null) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("response exceeds bound");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return strict ? parseJsonFrame(bytes) : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

interface FleetClock {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
}
/**
 * Every timer this document schedules goes through `window`, never the bare global: the page's
 * owner (and the test harness standing in for it) can then cancel all of them together, so no
 * poll, grace, or deadline callback can outlive the document that armed it.
 */
const clock: FleetClock = {
  now: () => Date.now(), random: () => Math.random(),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: timer => window.clearTimeout(timer),
};

export async function loadClientConfig(origin: string, time: FleetClock = clock): Promise<ClientConfigResponse | undefined> {
  const controller = new AbortController();
  const timer = time.setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch("/api/v1/client-config", {
      cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error("client configuration unavailable");
    const config = parseClientConfigResponse(await boundedJson(response, MAX_CLIENT_CONFIG_BYTES));
    if (config.local.origin !== origin) throw new Error("client configuration origin mismatch");
    return config;
  } finally { time.clearTimeout(timer); }
}

/** One source owns one request, one revision domain and one visibility epoch. */
export class FleetTransport {
  readonly key: SourceKey;
  status: SourceStatus = "loading";
  snapshot: SessionListResponse | undefined;
  epoch = 0;
  sequence = 0;
  revision = -1;
  freshAt: number | undefined;
  staleSince: number | undefined;
  private visible = false;
  private failures = 0;
  private request: { controller: AbortController; promise: Promise<SnapshotResult> } | undefined;
  private timer: number | undefined;
  private graceTimer: number | undefined;

  constructor(
    readonly source: FleetSource,
    private readonly changed: (source: FleetTransport) => void,
    private readonly fetcher: typeof fetch = fetch,
    private readonly time: FleetClock = clock,
  ) { this.key = sourceKey(source); }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.epoch += 1;
    this.request?.controller.abort();
    this.request = undefined;
    this.clearTimer();
    if (this.status === "fresh") this.status = "refreshing";
    this.changed(this);
    if (visible) {
      this.failures = 0;
      this.expire();
      void this.refresh(true);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.time.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private expire(): void {
    if (this.staleSince === undefined || this.time.now() - this.staleSince < STALE_GRACE_MS) return;
    this.snapshot = undefined;
    if (this.status !== "forbidden") this.status = "unavailable";
    this.changed(this);
  }

  forbid(): void {
    this.epoch += 1;
    this.request?.controller.abort();
    this.request = undefined;
    this.clearTimer();
    if (this.graceTimer !== undefined) this.time.clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.snapshot = undefined;
    this.status = "forbidden";
    this.changed(this);
  }

  refresh(explicit = false): Promise<SnapshotResult> {
    if (this.request !== undefined) return this.request.promise;
    if (!this.visible || (this.status === "forbidden" && !explicit)) {
      return Promise.resolve(this.status === "forbidden" ? "forbidden" : "unavailable");
    }
    this.clearTimer();
    const epoch = this.epoch;
    const sequence = ++this.sequence;
    const controller = new AbortController();
    const promise = this.fetchSnapshot(controller, epoch, sequence);
    this.request = { controller, promise };
    return promise;
  }

  async probe(signal: AbortSignal): Promise<SnapshotResult> {
    if (signal.aborted) return "unavailable";
    // Cancelling a consumer must not cancel the directory's coalesced request.
    const { promise, resolve } = Promise.withResolvers<SnapshotResult>();
    const abort = (): void => { signal.removeEventListener("abort", abort); resolve("unavailable"); };
    signal.addEventListener("abort", abort, { once: true });
    void this.refresh().then(result => {
      signal.removeEventListener("abort", abort);
      resolve(signal.aborted ? "unavailable" : result);
    });
    return await promise;
  }

  private async fetchSnapshot(controller: AbortController, epoch: number, sequence: number): Promise<SnapshotResult> {
    let timedOut = false;
    const timeout = this.time.setTimeout(() => { timedOut = true; controller.abort(); }, 5_000);
    const current = (): boolean => this.epoch === epoch && this.sequence === sequence && this.visible;
    try {
      // Native browser fetch must not receive this transport as its Window receiver.
      const fetchSnapshot = this.fetcher;
      const response = await fetchSnapshot(`${this.source.origin}/api/v1/sessions`, {
        mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
      });
      if (!current()) return "unavailable";
      if (response.status === 403) { this.forbid(); return "forbidden"; }
      if (!response.ok) throw new Error("snapshot unavailable");
      const payload = parseSessionListResponse(await boundedJson(response, SNAPSHOT_BYTES));
      if (!current() || controller.signal.aborted) return "unavailable";
      // Full snapshots are authoritative by request order, not by daemon-local revision.
      this.snapshot = payload;
      this.revision = payload.revision;
      this.status = "fresh";
      this.freshAt = this.time.now();
      this.staleSince = undefined;
      this.failures = 0;
      if (this.graceTimer !== undefined) this.time.clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
      this.changed(this);
      return "healthy";
    } catch {
      if (!current() || (controller.signal.aborted && !timedOut)) return "unavailable";
      this.failures += 1;
      this.staleSince ??= this.time.now();
      this.status = this.snapshot === undefined ? "unavailable" : "stale";
      if (this.graceTimer === undefined) {
        this.graceTimer = this.time.setTimeout(() => {
          this.graceTimer = undefined;
          this.expire();
        }, Math.max(0, STALE_GRACE_MS - (this.time.now() - this.staleSince)));
      }
      this.expire();
      this.changed(this);
      return "unavailable";
    } finally {
      this.time.clearTimeout(timeout);
      if (current()) {
        this.request = undefined;
        if (this.status !== "forbidden") {
          const cap = Math.min(30_000, 1_000 * 2 ** Math.min(5, Math.max(0, this.failures - 1)));
          const delay = this.failures === 0 ? 10_000 : Math.floor(cap / 2 + this.time.random() * cap / 2);
          this.timer = this.time.setTimeout(() => { this.timer = undefined; void this.refresh(); }, delay);
        }
      }
    }
  }
}

const CREATION_PROBLEMS = [
  "revision_mismatch", "operation_conflict", "creation_busy", "rate_limited",
  "tern_unavailable", "creation_capacity", "ledger_unavailable",
] as const;
type CreationProblem = typeof CREATION_PROBLEMS[number] | "forbidden" | "not_found" | "unavailable" | "rejected";
export class CreationTransportError extends Error {
  constructor(readonly code: CreationProblem) { super("Session creation request unavailable"); }
}

/** No retries: an explicit Check may replay a frozen POST, never an automatic transport retry. */
export class SessionCreationTransport {
  constructor(
    readonly source: FleetSource,
    private readonly forbidden: (source: FleetSource) => void,
    private readonly fetcher: typeof fetch = fetch,
    private readonly time: FleetClock = clock,
  ) {}

  options(signal: AbortSignal): Promise<SessionCreationOptions | undefined> {
    return this.request("/api/v1/session-creation-options", undefined, signal, 4_000,
      MAX_SESSION_CREATION_OPTIONS_BYTES, parseSessionCreationOptions, true);
  }

  async create(request: SessionCreationRequest, signal: AbortSignal): Promise<SessionCreationReceipt> {
    const payload = parseSessionCreationRequest(request);
    return (await this.request("/api/v1/session-creations", payload, signal, 10_000,
      MAX_SESSION_CREATION_STATUS_BYTES, parseSessionCreationReceipt))!;
  }

  async status(operationId: string, signal: AbortSignal): Promise<SessionCreationStatus> {
    const id = parseSessionCreationUuid(operationId);
    return (await this.request(`/api/v1/session-creations/${id}`, undefined, signal, 4_000,
      MAX_SESSION_CREATION_STATUS_BYTES, parseSessionCreationStatus))!;
  }

  private async request<T>(
    path: string, payload: SessionCreationRequest | undefined, signal: AbortSignal, timeoutMs: number,
    maximum: number, parse: (value: unknown) => T, missingOptions = false,
  ): Promise<T | undefined> {
    if (signal.aborted) throw new CreationTransportError("unavailable");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = this.time.setTimeout(abort, timeoutMs);
    try {
      const remote = this.source.id !== "local";
      const fetchRequest = this.fetcher;
      const response = await fetchRequest(`${remote ? this.source.origin : ""}${path}`, {
        method: payload === undefined ? "GET" : "POST",
        ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
        cache: "no-store", credentials: remote ? "omit" : "same-origin", redirect: "error",
        ...(remote ? { mode: "cors" as const } : {}), signal: controller.signal,
      });
      if (controller.signal.aborted) throw new CreationTransportError("unavailable");
      if (response.status === 403) {
        this.forbidden(this.source);
        throw new CreationTransportError("forbidden");
      }
      if (response.status === 404) {
        if (missingOptions) return undefined;
        throw new CreationTransportError("not_found");
      }
      if (!response.ok) {
        let code: CreationProblem = response.status >= 400 && response.status < 500 ? "rejected" : "unavailable";
        try {
          const problem = await boundedJson(response, MAX_SESSION_CREATION_STATUS_BYTES, true);
          if (problem !== null && typeof problem === "object" && "code" in problem &&
            CREATION_PROBLEMS.includes(problem.code as typeof CREATION_PROBLEMS[number])) {
            code = problem.code as typeof CREATION_PROBLEMS[number];
          }
        } catch { /* Never retain or expose arbitrary server error content. */ }
        throw new CreationTransportError(code);
      }
      const result = parse(await boundedJson(response, maximum, true));
      if (controller.signal.aborted) throw new CreationTransportError("unavailable");
      return result;
    } catch (error) {
      if (error instanceof CreationTransportError) throw error;
      throw new CreationTransportError("unavailable");
    } finally {
      this.time.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }
}

export interface SourceRecord { readonly sourceId: string; readonly sourceOrigin: string }
export interface HeldAsk extends SourceRecord {
  readonly instanceId: string; readonly requestId: string; readonly heldAt: string;
}
export interface DismissedSession extends SourceRecord {
  readonly instanceId: string; readonly generation: number; readonly dismissedAt: string;
}
export const HELD_KEY = "omp.sessions.held-asks.v2";
export const DISMISSED_KEY = "omp.sessions.dismissed.v2";
export const recordKey = (record: SourceRecord & { instanceId: string }, suffix: string | number): string =>
  `${record.sourceId}\0${record.sourceOrigin}\0${record.instanceId}\0${suffix}`;
export const recordRef = (record: SourceRecord & { instanceId: string }): Pick<SessionRef, "sourceKey" | "instanceId"> =>
  ({ sourceKey: `${record.sourceId}\0${record.sourceOrigin}`, instanceId: record.instanceId });
const timestamp = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

export function readSourceRecords(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key: typeof HELD_KEY | typeof DISMISSED_KEY,
  sources: readonly FleetSource[],
  authoritative: boolean,
): Map<string, HeldAsk | DismissedSession> {
  const records = new Map<string, HeldAsk | DismissedSession>();
  const previous = key.replace(/v2$/u, "v1");
  let migrate = false;
  try {
    let serialized = storage.getItem(key);
    if (serialized === null) { serialized = storage.getItem(previous); migrate = serialized !== null; }
    if (serialized === null) return records;
    let values: unknown;
    try { values = serialized.length <= 512_000 ? JSON.parse(serialized) : undefined; }
    catch { values = undefined; }
    if (Array.isArray(values) && values.length <= MAX_SESSIONS) {
      for (const value of values) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        const held = key === HELD_KEY;
        const keys = held ? ["instanceId", "requestId", "heldAt"] : ["instanceId", "generation", "dismissedAt"];
        if (!migrate) keys.push("sourceId", "sourceOrigin");
        if (Object.keys(record).length !== keys.length || keys.some(name => !Object.hasOwn(record, name))) continue;
        let source: Pick<FleetSource, "id" | "origin"> | undefined = migrate ? sources.find(source => source.id === "local") : sources.find(source =>
          source.id === record.sourceId && source.origin === record.sourceOrigin);
        // A failed bootstrap cannot prove removal or rebinding; retain valid inert records.
        if (source === undefined && !authoritative && !migrate) {
          try {
            source = { id: parseFleetSourceId(record.sourceId), origin: parseFleetOrigin(record.sourceOrigin) };
          } catch { continue; }
        }
        if (source === undefined || typeof record.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(record.instanceId)) continue;
        const base = { sourceId: source.id, sourceOrigin: source.origin, instanceId: record.instanceId };
        if (held && typeof record.requestId === "string" && /^[A-Za-z0-9_-]{16,128}$/u.test(record.requestId) && timestamp(record.heldAt)) {
          const item: HeldAsk = { ...base, requestId: record.requestId, heldAt: record.heldAt };
          records.set(recordKey(item, item.requestId), item);
        } else if (!held && Number.isSafeInteger(record.generation) && (record.generation as number) >= 1 && timestamp(record.dismissedAt)) {
          const item: DismissedSession = { ...base, generation: record.generation as number, dismissedAt: record.dismissedAt };
          records.set(recordKey(item, item.generation), item);
        }
      }
    }
    if (authoritative) {
      storage.setItem(key, JSON.stringify([...records.values()]));
      if (migrate || storage.getItem(previous) !== null) storage.removeItem(previous);
    }
  } catch { /* Optional storage: retain in-memory decisions even if migration cannot commit. */ }
  return records;
}

export interface CreationPreference extends SourceRecord {
  readonly projectId: string;
  readonly workingCopyId: string;
  readonly profileId: string;
  readonly updatedAt: string;
}
export const CREATION_PREFERENCES_KEY = "omp.sessions.creation-prefs.v1";
const MAX_CREATION_PREFERENCES_BYTES = 16 * 1024;

function creationPreference(value: unknown): CreationPreference | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["sourceId", "sourceOrigin", "projectId", "workingCopyId", "profileId", "updatedAt"];
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key)) || !timestamp(record.updatedAt)) return undefined;
  try {
    return {
      sourceId: parseFleetSourceId(record.sourceId), sourceOrigin: parseFleetOrigin(record.sourceOrigin),
      projectId: parseFleetSourceId(record.projectId), workingCopyId: parseFleetSourceId(record.workingCopyId),
      profileId: parseFleetSourceId(record.profileId), updatedAt: record.updatedAt,
    };
  } catch { return undefined; }
}

/** Only fixed option IDs and source bindings persist; never operation IDs or task text. */
export function writeCreationPreferences(
  storage: Pick<Storage, "setItem">,
  preferences: Iterable<CreationPreference>,
): void {
  const choices = new Map<string, CreationPreference>();
  for (const value of preferences) {
    const record = creationPreference(value);
    if (record === undefined) continue;
    choices.set(record.sourceId, record);
  }
  const bounded = [...choices.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const serialized = JSON.stringify({ version: 1, choices: bounded });
  if (new TextEncoder().encode(serialized).byteLength > MAX_CREATION_PREFERENCES_BYTES) return;
  try { storage.setItem(CREATION_PREFERENCES_KEY, serialized); } catch { /* Optional device-local preference. */ }
}

export function readCreationPreferences(
  storage: Pick<Storage, "getItem" | "setItem">,
  sources: readonly FleetSource[],
  authoritative: boolean,
): Map<SourceKey, CreationPreference> {
  const preferences = new Map<SourceKey, CreationPreference>();
  try {
    const serialized = storage.getItem(CREATION_PREFERENCES_KEY);
    if (serialized === null) return preferences;
    const value: unknown = new TextEncoder().encode(serialized).byteLength <= MAX_CREATION_PREFERENCES_BYTES
      ? JSON.parse(serialized) : undefined;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length === 2 && record.version === 1 && Array.isArray(record.choices) && record.choices.length <= 8) {
        const ids = new Set<string>();
        for (const value of record.choices) {
          const choice = creationPreference(value);
          if (choice === undefined || ids.has(choice.sourceId)) continue;
          ids.add(choice.sourceId);
          if (authoritative && !sources.some(source => source.id === choice.sourceId && source.origin === choice.sourceOrigin)) continue;
          preferences.set(`${choice.sourceId}\0${choice.sourceOrigin}`, choice);
        }
      }
    }
  } catch { /* An invalid or unavailable record is not a prerequisite for creation. */ }
  if (authoritative) writeCreationPreferences(storage, preferences.values());
  return preferences;
}
