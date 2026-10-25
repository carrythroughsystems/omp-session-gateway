import { constants, type Stats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_OMP_REGISTRY_RESPONSE_BYTES,
  OMP_REGISTRY_VERSION,
  observedSessionFromSnapshot,
  parseJsonFrame,
  parseOmpDiscoveryEntry,
  parseOmpLinkReply,
  parseOmpSnapshotReply,
  type LaunchMode,
  type ObservedSessionInput,
  type OmpDiscoveryEntry,
  type OmpHostSnapshot,
  type OmpRegistryErrorCode,
  type SecretCapability,
} from "@omp-session-gateway/protocol";
import type { SessionRegistry } from "./registry.ts";

/**
 * Mainline OMP anchors its collaboration discovery directory under the base configuration root
 * rather than a profile root, so hosts started under any profile are discoverable. `PI_CONFIG_DIR`
 * is a directory *name* relative to the home directory in OMP, not a path; mirror that exactly or
 * the gateway looks in a directory no host ever writes to.
 */
export function resolveOmpDiscoveryDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
): string {
  const configDirName = environment.PI_CONFIG_DIR ?? ".omp";
  return join(home, configDirName, "run", "collab-hosts");
}

/**
 * Why a host was not readable this round.
 *
 * `gone` is reserved for the two answers upstream treats as authoritative death — the socket is
 * absent or refuses — because only those mean the host is really finished. Everything else
 * (timeouts, descriptor exhaustion, permission faults, a room mid-teardown answering
 * `snapshot_unavailable`) is `unavailable`: transient, and unpublishing a live session because the
 * machine was briefly busy is the failure mode worth avoiding.
 */
export type HostUnreachableReason = "gone" | "unavailable";

export type HostQueryResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: HostUnreachableReason; readonly detail: string };

export interface OmpHostObservation {
  readonly entry: OmpDiscoveryEntry;
  readonly snapshot: OmpHostSnapshot;
  readonly session: ObservedSessionInput;
}

export interface OmpDiscoveryObservation {
  /** Hosts that answered `snapshot` this round. */
  readonly hosts: readonly OmpHostObservation[];
  /** Published instance IDs that exist but could not be read; their records must survive. */
  readonly retained: ReadonlySet<string>;
  /** False only when the directory itself is unusable, which is an operator-visible fault. */
  readonly directoryHealthy: boolean;
}

const DEFAULT_QUERY_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_ENTRIES = 100;
const MAX_CONCURRENT_HOST_QUERIES = 8;
/** Upstream classifies exactly these two as a dead endpoint; everything else is transient. */
const DEAD_ENDPOINT_CODES: Readonly<Record<string, true>> = { ENOENT: true, ECONNREFUSED: true };
/**
 * Proven-dead publications remembered per admitted-host slot. OMP prunes a killed host's discovery
 * file only while listing, and the gateway must never delete it, so without this memory every
 * leftover file would cost a read and a query each round. Past the limit, further dead files are
 * read again; newest-first reading keeps them from displacing a newer publication.
 */
const DEAD_PUBLICATIONS_PER_ENTRY = 10;
/** Directory names examined per round, whatever they are; the bound on residue a round tolerates. */
const MAX_DISCOVERY_NAMES = 4_096;

/** A dead publication stays dead only while its exact file is unchanged. */
function fileIdentity(info: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "";
}

/**
 * One request, one connection. Upstream answers the first line and closes, so a reader that keeps
 * the socket open or pipelines a second request simply hangs.
 */
async function connectAndRequest(endpoint: string, timeoutMs: number, payload: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let buffer = "";
  let settled = false;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let socket: Bun.Socket<undefined> | undefined;
  const finish = (outcome: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      socket?.end();
    } catch {
      // The peer closing first is the normal path; the request already has its answer.
    }
    outcome();
  };
  const timer = setTimeout(() => {
    finish(() => reject(Object.assign(new Error("omp host query timed out"), { code: "ETIMEDOUT" })));
  }, timeoutMs);
  try {
    void Bun.connect<undefined>({
      unix: endpoint,
      socket: {
        open(open) {
          // Callbacks can run before connect resolves, including after the query timed out.
          socket = open;
          if (settled) {
            open.end();
            return;
          }
          open.write(payload);
          open.flush();
        },
        data(_socket, chunk) {
          if (settled) return;
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > MAX_OMP_REGISTRY_RESPONSE_BYTES) {
            finish(() => reject(new Error("omp host response exceeded the bounded response size")));
            return;
          }
          const newline = buffer.indexOf("\n");
          if (newline >= 0) {
            const line = buffer.slice(0, newline);
            finish(() => resolve(line));
          }
        },
        error(_socket, error) {
          finish(() => reject(error));
        },
        close() {
          finish(() => reject(new Error("omp host closed the query before answering")));
        },
      },
    }).catch(error => finish(() => reject(error)));
  } catch (error) {
    finish(() => reject(error));
  }
  return promise;
}

/** The two directory-handle operations the scan uses; `opendir` supplies them in production. */
export interface DiscoveryDirectoryHandle {
  read(): Promise<{ readonly name: string } | null>;
  close(): Promise<void>;
}

export interface OmpHostReaderOptions {
  readonly directory: string;
  readonly maxEntries?: number;
  readonly timeoutMs?: number;
  /** Test seam: replaces the socket round trip with a deterministic transport. */
  readonly request?: (endpoint: string, payload: string, timeoutMs: number) => Promise<string>;
  /** Test seam: iterates names in a deterministic order after the privacy check has passed. */
  readonly openDirectory?: (path: string) => Promise<DiscoveryDirectoryHandle>;
  readonly onFault?: (event: string, detail: Readonly<Record<string, number | boolean>>) => void;
}

/**
 * Reads mainline OMP's own collaboration host registry: one discovery file plus one owner-only
 * socket per live host. The gateway is a guest in this directory — it parses and queries, and it
 * never writes, renames, or unlinks anything, because the publishing host and OMP's own lister own
 * that lifecycle.
 */
export class OmpHostReader {
  readonly #directory: string;
  readonly #maxEntries: number;
  readonly #timeoutMs: number;
  readonly #request: (endpoint: string, payload: string, timeoutMs: number) => Promise<string>;
  readonly #openDirectoryHandle: (path: string) => Promise<DiscoveryDirectoryHandle>;
  readonly #onFault: (event: string, detail: Readonly<Record<string, number | boolean>>) => void;
  #entries = new Map<string, OmpDiscoveryEntry>();
  /** Entry ID -> file identity of publications whose endpoint proved dead (ENOENT/ECONNREFUSED). */
  readonly #dead = new Map<string, string>();

  constructor(options: OmpHostReaderOptions) {
    this.#directory = options.directory;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1 || this.#maxEntries > 1_000) {
      throw new Error("invalid discovery capacity");
    }
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.#request = options.request ?? ((endpoint, payload, timeoutMs) => connectAndRequest(endpoint, timeoutMs, payload));
    // Do not let the directory API preallocate an attacker-sized name array.
    this.#openDirectoryHandle = options.openDirectory ?? (path => opendir(path, { bufferSize: 1 }));
    this.#onFault = options.onFault ?? (() => undefined);
  }

  get directory(): string {
    return this.#directory;
  }

  /** Absence is healthy; unsafe permissions and unreadable directories are not. */
  async directoryUsable(): Promise<boolean> {
    try {
      const directory = await this.#openDirectory();
      await directory.close();
      return true;
    } catch (error) {
      return errorCode(error) === "ENOENT";
    }
  }

  async #assertPrivateDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe discovery directory");
    if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
      throw new Error("unsafe discovery directory permissions");
    }
  }

  async #openDirectory(): Promise<DiscoveryDirectoryHandle> {
    await this.#assertPrivateDirectory(this.#directory);
    return this.#openDirectoryHandle(this.#directory);
  }

  /** Lists only bounded, private publications. This never establishes a launch binding. */
  async listEntries(): Promise<readonly OmpDiscoveryEntry[]> {
    return (await this.#readEntries()).entries;
  }

  async #readEntries(): Promise<{
    entries: readonly OmpDiscoveryEntry[];
    identities: ReadonlyMap<string, string>;
    retained: Set<string>;
    directoryHealthy: boolean;
  }> {
    const entries = new Map<string, OmpDiscoveryEntry>();
    const identities = new Map<string, string>();
    const retained = new Set<string>();
    const ambiguous = new Set<string>();
    const knownFiles = new Map([...this.#entries.values()].map(entry => [entry.entryId, entry.instanceId]));
    try {
      const directory = await this.#openDirectory();
      try {
        const buffer = Buffer.allocUnsafe(MAX_OMP_REGISTRY_RESPONSE_BYTES + 1);
        let files = 0;
        const readEntry = async (entryId: string): Promise<void> => {
          files++;
          try {
            const { entry, identity } = await this.#readEntry(entryId, buffer);
            identities.set(entryId, identity);
            const known = knownFiles.get(entryId);
            if (known !== undefined && known !== entry.instanceId) retained.add(known);
            if (ambiguous.has(entry.instanceId)) return;
            if (entries.has(entry.instanceId)) {
              entries.delete(entry.instanceId);
              ambiguous.add(entry.instanceId);
              retained.add(entry.instanceId);
              return;
            }
            entries.set(entry.instanceId, entry);
          } catch (error) {
            if (errorCode(error) === "ENOENT") return;
            this.#onFault("omp.entry_unreadable", {});
            const known = knownFiles.get(entryId);
            if (known !== undefined) retained.add(known);
          }
        };
        // Revisit admitted publications first: an overfull prefix must neither evict a live host
        // nor preserve a vanished host forever. These reads consume the same per-round budget.
        for (const entryId of knownFiles.keys()) await readEntry(entryId);
        // Then read unknown publications newest first. A new session is the newest file, so
        // neither killed hosts' leftovers nor foreign names ahead of it in directory order can keep
        // it out of this round's budget; a remembered dead publication costs one lstat.
        const candidates: { readonly entryId: string; readonly mtimeMs: number }[] = [];
        const seenDead = new Set<string>();
        let complete = false;
        for (let scanned = 0; scanned < MAX_DISCOVERY_NAMES; scanned++) {
          const name = await directory.read();
          if (name === null) {
            complete = true;
            break;
          }
          if (!name.name.endsWith(".json")) continue;
          const entryId = name.name.slice(0, -".json".length);
          if (knownFiles.has(entryId)) continue;
          let info: Stats;
          try {
            info = await lstat(join(this.#directory, name.name));
          } catch {
            continue;
          }
          const remembered = this.#dead.get(entryId);
          if (remembered !== undefined) {
            if (remembered === fileIdentity(info)) {
              seenDead.add(entryId);
              continue;
            }
            // A replaced file is a new publication under an old name; read it again.
            this.#dead.delete(entryId);
          }
          candidates.push({ entryId, mtimeMs: info.mtimeMs });
        }
        candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
        for (const candidate of candidates) {
          if (files >= this.#maxEntries) break;
          await readEntry(candidate.entryId);
        }
        // Only a finished scan proves which remembered files OMP has since pruned.
        if (complete) {
          for (const entryId of this.#dead.keys()) if (!seenDead.has(entryId)) this.#dead.delete(entryId);
        }
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { entries: [], identities: new Map(), retained: new Set(), directoryHealthy: true };
      }
      this.#onFault("omp.discovery_unreadable", {});
      return { entries: [], identities: new Map(), retained: new Set(this.#entries.keys()), directoryHealthy: false };
    }
    return { entries: [...entries.values()], identities, retained, directoryHealthy: true };
  }

  #rememberDead(entryId: string, identity: string | undefined): void {
    if (identity === undefined || this.#dead.size >= this.#maxEntries * DEAD_PUBLICATIONS_PER_ENTRY) return;
    this.#dead.set(entryId, identity);
  }

  async #readEntry(entryId: string, buffer: Buffer): Promise<{ entry: OmpDiscoveryEntry; identity: string }> {
    const path = join(this.#directory, entryId + ".json");
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe discovery file");
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = await open(path, flags);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw new Error("changed discovery file");
      if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
        throw new Error("unsafe discovery file permissions");
      }
      if (info.size > MAX_OMP_REGISTRY_RESPONSE_BYTES) throw new Error("oversized discovery file");
      let length = 0;
      while (length < buffer.byteLength) {
        const { bytesRead } = await file.read(buffer, length, buffer.byteLength - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_OMP_REGISTRY_RESPONSE_BYTES) throw new Error("oversized discovery file");
      const entry = parseOmpDiscoveryEntry(entryId, parseJsonFrame(buffer.subarray(0, length)));
      if (entry.version !== OMP_REGISTRY_VERSION) throw new Error("foreign discovery version");
      return { entry, identity: fileIdentity(info) };
    } finally {
      await file.close();
    }
  }

  async snapshot(entry: OmpDiscoveryEntry): Promise<HostQueryResult<OmpHostSnapshot>> {
    const reply = await this.#query(entry, { v: OMP_REGISTRY_VERSION, token: entry.token, op: "snapshot" });
    if (reply.status !== "ok") return reply;
    try {
      const parsed = parseOmpSnapshotReply(parseJsonFrame(new TextEncoder().encode(reply.value)));
      if (!parsed.ok) return { status: "unavailable", detail: parsed.error };
      if (parsed.value.instanceId !== entry.instanceId || parsed.value.pid !== entry.pid) {
        return { status: "unavailable", detail: "snapshot_identity_mismatch" };
      }
      return { status: "ok", value: parsed.value };
    } catch {
      return { status: "unavailable", detail: "malformed_snapshot" };
    }
  }

  /**
   * Requests one capability for an exact generation. Passing the generation is what makes a stale
   * card fail instead of silently receiving a link to a session the operator never looked at.
   */
  async link(
    entry: OmpDiscoveryEntry,
    access: LaunchMode,
    generation: number,
  ): Promise<HostQueryResult<SecretCapability> | { readonly status: "refused"; readonly error: OmpRegistryErrorCode }> {
    const reply = await this.#query(entry, {
      v: OMP_REGISTRY_VERSION,
      token: entry.token,
      op: "link",
      access,
      generation,
    });
    if (reply.status !== "ok") return reply;
    try {
      const parsed = parseOmpLinkReply(parseJsonFrame(new TextEncoder().encode(reply.value)));
      if (!parsed.ok) return { status: "refused", error: parsed.error };
      return { status: "ok", value: parsed.value };
    } catch {
      return { status: "unavailable", detail: "malformed_link" };
    }
  }

  /** The discovery entry the last observation bound to this instance; the host query revalidates it. */
  entryFor(instanceId: string): OmpDiscoveryEntry | undefined {
    return this.#entries.get(instanceId);
  }

  /** Queries a bounded set with a fixed concurrency ceiling, retaining only validated bindings. */
  async observe(): Promise<OmpDiscoveryObservation> {
    const { entries, identities, retained, directoryHealthy } = await this.#readEntries();
    const results = new Array<HostQueryResult<OmpHostSnapshot>>(entries.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(entries.length, MAX_CONCURRENT_HOST_QUERIES) }, async () => {
      while (cursor < entries.length) {
        const index = cursor++;
        results[index] = await this.snapshot(entries[index]!);
      }
    }));
    const hosts: OmpHostObservation[] = [];
    const nextEntries = new Map<string, OmpDiscoveryEntry>();
    for (const [instanceId, entry] of this.#entries) {
      if (retained.has(instanceId)) nextEntries.set(instanceId, entry);
    }
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const result = results[index]!;
      const known = this.#entries.get(entry.instanceId);
      if (result.status === "gone") {
        retained.delete(entry.instanceId);
        nextEntries.delete(entry.instanceId);
        this.#rememberDead(entry.entryId, identities.get(entry.entryId));
        continue;
      }
      if (result.status !== "ok" || (known !== undefined && known.pid !== entry.pid)) {
        retained.add(entry.instanceId);
        // Never let an unreadable or mismatched publication retarget an existing card.
        if (known !== undefined) nextEntries.set(entry.instanceId, known);
        continue;
      }
      if (!nextEntries.has(entry.instanceId) && nextEntries.size >= this.#maxEntries) continue;
      let session: ObservedSessionInput;
      try {
        session = observedSessionFromSnapshot(result.value);
      } catch {
        retained.add(entry.instanceId);
        if (known !== undefined) nextEntries.set(entry.instanceId, known);
        continue;
      }
      nextEntries.set(entry.instanceId, entry);
      hosts.push({ entry, snapshot: result.value, session });
    }
    this.#entries = nextEntries;
    return { hosts, retained, directoryHealthy };
  }

  async #query(entry: OmpDiscoveryEntry, request: Record<string, unknown>): Promise<HostQueryResult<string>> {
    try {
      if (process.platform !== "win32") {
        await this.#assertPrivateDirectory(dirname(entry.endpoint));
        const info = await lstat(entry.endpoint);
        if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
          return { status: "unavailable", detail: "unsafe_endpoint" };
        }
      }
      const line = await this.#request(entry.endpoint, `${JSON.stringify(request)}\n`, this.#timeoutMs);
      return { status: "ok", value: line };
    } catch (error) {
      const code = errorCode(error);
      if (Object.hasOwn(DEAD_ENDPOINT_CODES, code)) return { status: "gone", detail: code };
      return { status: "unavailable", detail: code || "transport" };
    }
  }
}

export type LaunchResolution =
  | { readonly status: "ok"; readonly capability: SecretCapability }
  | { readonly status: "generation_mismatch" }
  | { readonly status: "request_mismatch" }
  | { readonly status: "mode_unavailable" }
  | { readonly status: "missing" };

/**
 * Brokers one launch: the directory must still show the exact session and generation the operator
 * pressed, and only then is the capability fetched straight from that host. Nothing is cached —
 * the gateway never holds a link between launches, and a stale card gets a refusal, not a link to
 * a session it was never showing.
 */
export class OmpLaunchResolver {
  readonly #registry: SessionRegistry;
  readonly #reader: OmpHostReader;

  constructor(options: { readonly registry: SessionRegistry; readonly reader: OmpHostReader }) {
    this.#registry = options.registry;
    this.#reader = options.reader;
  }

  async resolve(request: {
    readonly instanceId: string;
    readonly generation: number;
    readonly mode: LaunchMode;
    readonly requestId?: string;
  }): Promise<LaunchResolution> {
    const authorized = this.#registry.authorizeLaunch(
      request.instanceId,
      request.generation,
      request.mode,
      request.requestId,
    );
    if (authorized.status !== "ok") return { status: authorized.status };
    const entry = await this.#entryFor(request.instanceId);
    if (entry === undefined) return { status: "missing" };
    const link = await this.#reader.link(entry, request.mode, request.generation);
    if (link.status === "ok") {
      const current = this.#registry.authorizeLaunch(
        request.instanceId,
        request.generation,
        request.mode,
        request.requestId,
      );
      if (current.status !== "ok") return { status: current.status };
      return { status: "ok", capability: link.value };
    }
    if (link.status === "refused") {
      // The host is the authority on its own generation and access: a refusal means the card the
      // operator pressed no longer describes that session.
      if (link.error === "stale_generation") return { status: "generation_mismatch" };
      if (link.error === "access_unavailable" || link.error === "invalid_access") {
        return { status: "mode_unavailable" };
      }
      return { status: "missing" };
    }
    return { status: "missing" };
  }

  /**
   * Prefers the entry the last poll bound, then validates a rediscovered endpoint against its
   * snapshot. Cached entries are routing hints; the host still authorizes generation and access
   * on every link query rather than the gateway inferring revocation from a file race.
   */
  async #entryFor(instanceId: string): Promise<OmpDiscoveryEntry | undefined> {
    const known = this.#reader.entryFor(instanceId);
    if (known !== undefined) return known;
    const entries = await this.#reader.listEntries();
    const entry = entries.find(candidate => candidate.instanceId === instanceId);
    if (entry === undefined) return undefined;
    const snapshot = await this.#reader.snapshot(entry);
    return snapshot.status === "ok" ? entry : undefined;
  }
}

export interface AdoptionObservation {
  readonly round: number;
  readonly startedAt: number;
  readonly directoryHealthy: boolean;
  readonly knownInstanceIds: readonly string[];
  readonly hosts: readonly {
    readonly instanceId: string; readonly generation: number; readonly sessionId: string;
    readonly pid: number; readonly startedAt: number; readonly createdAt: number; readonly canControl: boolean;
  }[];
}
export type AdoptionRefresh = { readonly status: "ok"; readonly observation: AdoptionObservation } |
  { readonly status: "aborted" | "timed_out" | "stopped" };

export interface HostPoller {
  /** False while OMP's discovery directory itself is unusable. */
  readonly discoveryHealthy: boolean;
  poll(): Promise<void>;
  subscribeObservations(listener: (observation: AdoptionObservation) => void): () => void;
  refreshForAdoption(options: { readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<AdoptionRefresh>;
  stop(): void;
}

/**
 * Polls the discovery directory on a fixed interval. Rounds never overlap — one slow host must not
 * cause a second wave of queries against hosts already struggling to answer — and a caller that
 * asks while a round is in flight joins that round rather than being dropped, so `poll()` always
 * resolves against a completed observation.
 */
export function startHostPoller(options: {
  readonly reader: OmpHostReader;
  readonly registry: SessionRegistry;
  readonly intervalMs: number;
  readonly onEvent?: (event: string, detail: Readonly<Record<string, number | boolean>>) => void;
}): HostPoller {
  let healthy = true;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let roundNumber = 0;
  const listeners = new Set<(observation: AdoptionObservation) => void>();
  const waiters = new Set<{ minimum: number; finish: (result: AdoptionRefresh) => void }>();
  const round = async (): Promise<void> => {
    const currentRound = ++roundNumber;
    const startedAt = performance.now();
    try {
      const observation = await options.reader.observe();
      if (stopped) return;
      healthy = observation.directoryHealthy;
      const result = options.registry.reconcile({
        observed: observation.hosts.map(host => host.session),
        retained: observation.retained,
      });
      if (result.inserted > 0 || result.removed > 0) {
        options.onEvent?.("omp.directory_changed", {
          inserted: result.inserted,
          removed: result.removed,
          hosts: observation.hosts.length,
        });
      }
      const batch: AdoptionObservation = {
        round: currentRound, startedAt, directoryHealthy: healthy,
        knownInstanceIds: [...new Set([...observation.retained, ...observation.hosts.map(host => host.snapshot.instanceId)])],
        hosts: observation.hosts.map(({ entry, snapshot }) => ({
          instanceId: snapshot.instanceId, generation: snapshot.generation, sessionId: snapshot.sessionId,
          pid: snapshot.pid, startedAt: snapshot.startedAt, createdAt: entry.createdAt, canControl: snapshot.access === "control",
        })),
      };
      for (const listener of listeners) {
        try { listener(batch); } catch { /* One consumer must not prevent other observations. */ }
      }
      for (const waiter of waiters) if (waiter.minimum <= currentRound) waiter.finish({ status: "ok", observation: batch });
    } catch {
      if (stopped) return;
      healthy = false;
      options.onEvent?.("omp.poll_failed", {});
      const batch: AdoptionObservation = {
        round: currentRound, startedAt, directoryHealthy: false, hosts: [], knownInstanceIds: [],
      };
      for (const listener of listeners) {
        try { listener(batch); } catch { /* Isolate consumers. */ }
      }
      for (const waiter of waiters) if (waiter.minimum <= currentRound) waiter.finish({ status: "ok", observation: batch });
    }
  };
  const poll = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= round().finally(() => {
      inFlight = undefined;
      if (!stopped && [...waiters].some(waiter => waiter.minimum > roundNumber)) void poll();
    });
    return inFlight;
  };
  const timer = setInterval(() => void poll(), options.intervalMs);
  void poll();
  return {
    get discoveryHealthy(): boolean {
      return healthy;
    },
    poll,
    subscribeObservations(listener) {
      if (!stopped) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refreshForAdoption({ signal, timeoutMs }) {
      if (stopped) return Promise.resolve({ status: "stopped" });
      if (signal.aborted) return Promise.resolve({ status: "aborted" });
      const { promise, resolve } = Promise.withResolvers<AdoptionRefresh>();
        const minimum = roundNumber + 1;
        const waiter = { minimum, finish };
        const abort = (): void => finish({ status: "aborted" });
        const timer = setTimeout(() => finish({ status: "timed_out" }), Math.min(5000, Math.max(0, timeoutMs)));
        function finish(result: AdoptionRefresh): void {
          if (!waiters.delete(waiter)) return;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          resolve(result);
        }
        waiters.add(waiter);
        signal.addEventListener("abort", abort, { once: true });
      if (!inFlight) void poll();
      return promise;
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
      for (const waiter of waiters) waiter.finish({ status: "stopped" });
    },
  };
}
