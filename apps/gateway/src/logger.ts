import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, number | boolean | undefined>>;

export interface LogSink {
  write(line: string): void;
}

export const QUALIFICATION_LOG_BYTES = 256 * 1024;
export const QUALIFICATION_LOG_FILES = 4;
const QUALIFICATION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "http.listening": ["port"], "http.authorization_denied": ["identity_untrustworthy", "suppressed"],
  "http.identity_trust_declared": [], "http.identity_trust_restored": [], "http.identity_trust_unsound": [],
  "http.request_failed": [], "registry.listener_failed": [], "registry.expired": ["removed"],
  "omp.entry_unreadable": [], "omp.discovery_unreadable": [], "omp.poll_failed": [],
  "omp.directory_changed": ["inserted", "removed", "hosts"],
  "ipc.protocol_rejected": ["suppressed"], "ipc.authentication_denied": ["suppressed"],
  "ipc.connection_timeout": ["suppressed"], "ipc.connection_error": ["suppressed"],
  "push.queue_accepted": ["sequence", "request_alias", "attention", "clear", "activity_stop", "subscription_replay"],
  "push.send_started": ["sequence", "request_alias", "attention", "clear", "activity_stop", "subscriptions", "subscription_replay"],
  "push.send_acknowledged": ["sequence", "request_alias", "elapsed_ms"],
  "push.send_failed": ["sequence", "request_alias", "elapsed_ms", "status"],
  "push.subscription_evicted": ["sequence", "request_alias", "count"],
  "push.delivery_failed": [],
};
export type QualificationLogEvent = Readonly<Record<string, number | boolean | string>> & {
  readonly timestamp: string; readonly level: LogLevel; readonly event: string; readonly index: number;
};

/** A closed schema shared with the collector. Names cannot smuggle identifiers into artifacts. */
export function parseQualificationLogEvent(value: unknown): QualificationLogEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid qualification event");
  const record = value as Record<string, unknown>;
  const fields = typeof record.event === "string" && Object.hasOwn(QUALIFICATION_FIELDS, record.event) ? QUALIFICATION_FIELDS[record.event] : undefined;
  if (fields === undefined || !["info", "warn", "error"].includes(String(record.level)) ||
    typeof record.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(record.timestamp) ||
    !Number.isFinite(Date.parse(record.timestamp)) || !Number.isSafeInteger(record.index) || (record.index as number) < 1) throw new Error("invalid qualification event");
  for (const [key, item] of Object.entries(record)) {
    if (["timestamp", "level", "event", "index"].includes(key)) continue;
    if (!fields.includes(key) || (typeof item !== "boolean" && !(typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= Number.MAX_SAFE_INTEGER))) throw new Error("unsafe qualification event");
  }
  if (record.event !== "http.authorization_denied" && record.event !== "push.send_failed" &&
    fields.some(key => key !== "suppressed" && record[key] === undefined)) throw new Error("incomplete qualification event");
  if (record.event === "push.send_failed" && (record.sequence === undefined || record.request_alias === undefined || record.elapsed_ms === undefined)) throw new Error("incomplete qualification event");
  for (const key of fields) {
    if (record[key] === undefined) continue;
    const boolean = ["attention", "clear", "activity_stop", "subscription_replay", "identity_untrustworthy"].includes(key);
    if (typeof record[key] !== (boolean ? "boolean" : "number") ||
      !boolean && key !== "elapsed_ms" && !Number.isSafeInteger(record[key])) throw new Error("invalid qualification field type");
  }
  return record as QualificationLogEvent;
}

/** Durable high-water index and the first retained index, advanced only by rotation. */
export function parseQualificationLogHealth(text: string): readonly [number, number] {
  if (!/^\[(?:0|[1-9]\d*),[1-9]\d*\]\n$/u.test(text) || text.length > 64) throw new Error("invalid qualification health");
  const [index, first] = JSON.parse(text) as [number, number];
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(first) || first > Math.max(1, index)) throw new Error("invalid qualification health");
  return [index, first];
}

/** Files must arrive oldest-first; sorting records would conceal a torn or truncated history. */
export function parseQualificationLogFiles(texts: readonly string[], firstIndex = 1): QualificationLogEvent[] {
  if (texts.length > QUALIFICATION_LOG_FILES || !Number.isSafeInteger(firstIndex) || firstIndex < 1 ||
    firstIndex > 1 && texts.length !== QUALIFICATION_LOG_FILES) throw new Error("invalid qualification rotation");
  const events: QualificationLogEvent[] = [];
  for (const text of texts) {
    if (Buffer.byteLength(text) > QUALIFICATION_LOG_BYTES || (text !== "" && !text.endsWith("\n")) ||
      texts.length > 1 && text === "") throw new Error("invalid qualification log size");
    for (const line of text.split("\n").slice(0, -1)) {
      if (Buffer.byteLength(line) > 2048 || events.length >= 16_384) throw new Error("qualification logs exceed event bound");
      const event = parseQualificationLogEvent(JSON.parse(line));
      if (JSON.stringify(event) !== line || event.index !== firstIndex + events.length) throw new Error("invalid qualification log sequence");
      events.push(event);
    }
  }
  return events;
}

/** Existing, explicitly private destination; never follows even an ancestor symlink. */
export function assertQualificationLogDirectory(directory: string): void {
  if (!isAbsolute(directory) || resolve(directory) !== directory || process.getuid === undefined) throw new Error("unsafe qualification log directory");
  for (let path = directory; ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe qualification log directory");
    if (path === directory && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)) throw new Error("unsafe qualification log directory");
    if (dirname(path) === path) break;
  }
}

/** Only graceful writer closure permits restart; failed writes cannot erase the active lease. */
export class QualificationLogSink implements LogSink {
  readonly #directory: string;
  #healthy = true;
  #index = 0;
  #firstIndex = 1;
  #pending = false;
  #rotated = false;
  #closed = false;
  constructor(directory: string) {
    assertQualificationLogDirectory(directory);
    this.#directory = directory;
    const names = readdirSync(directory);
    if (names.length > 0) {
      if (!names.includes("health") || !names.includes("writer") || !names.includes("events.0.jsonl") ||
        names.some(name => name !== "health" && name !== "writer" && !/^events\.[0-3]\.jsonl$/u.test(name))) throw new Error("qualification logging was interrupted");
      for (const name of names) {
        const path = join(directory, name), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.nlink !== 1 ||
          (stat.mode & 0o777) !== 0o600 || stat.size > QUALIFICATION_LOG_BYTES ||
          ["health", "writer"].includes(name) && stat.size > 64) throw new Error("unsafe qualification log file");
      }
      if (readFileSync(join(directory, "writer"), "utf8") !== "closed\n") throw new Error("qualification writer was not closed");
      const files = names.filter(name => name.startsWith("events.")).sort();
      if (files.some((name, index) => name !== `events.${index}.jsonl`)) throw new Error("qualification rotation gap");
      const [committed, first] = parseQualificationLogHealth(readFileSync(join(directory, "health"), "utf8"));
      const events = parseQualificationLogFiles(files.reverse().map(name => readFileSync(join(directory, name), "utf8")), first);
      this.#index = events.at(-1)?.index ?? 0;
      this.#firstIndex = first;
      if (committed !== this.#index) throw new Error("qualification logging was interrupted");
      this.#state("active\n", "writer");
      return;
    }
    for (const name of ["events.0.jsonl", "health", "writer"]) {
      const fd = openSync(join(directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        if (name !== "events.0.jsonl") {
          const value = name === "health" ? "[0,1]\n" : "active\n";
          if (writeSync(fd, value) !== Buffer.byteLength(value)) throw new Error("qualification state write failed");
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    this.#syncDirectory();
  }
  #state(value: string, name: "health" | "writer" = "health"): void {
    // Overwrite the existing private inode, not a directory entry: even lost directory-write
    // permission cannot preserve an old success marker across a failed event.
    const fd = openSync(join(this.#directory, name), constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) throw new Error("unsafe qualification health");
      if (writeSync(fd, value, 0, "utf8") !== Buffer.byteLength(value)) throw new Error("qualification health write failed");
      ftruncateSync(fd, Buffer.byteLength(value)); fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  #syncDirectory(): void {
    const fd = openSync(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  #syncLog(): void {
    const fd = openSync(join(this.#directory, "events.0.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600 ||
        stat.size > QUALIFICATION_LOG_BYTES) throw new Error("unsafe qualification log file");
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  #fail(): void {
    this.#healthy = false;
    // The durable active lease already prevents restart/final retention if this write also
    // fails. It lives inside the service's accepted writable directory, not beside it.
    try { this.#state("!"); } catch { /* Active lease remains unverifiable until explicit reset. */ }
  }
  #commit(): void {
    if (!this.#healthy || !this.#pending) return;
    try {
      assertQualificationLogDirectory(this.#directory);
      this.#syncLog();
      if (this.#rotated) this.#syncDirectory();
      this.#state(`[${this.#index},${this.#firstIndex}]\n`);
      this.#pending = false; this.#rotated = false;
    } catch { this.#fail(); }
  }
  get healthy(): boolean { return this.#healthy; }
  get nextIndex(): number {
    if (!this.#healthy || this.#closed || !Number.isSafeInteger(this.#index + 1)) throw new Error("qualification logging failed");
    return this.#index + 1;
  }
  /** Called only after every event producer stops; failed closure never releases the lease. */
  close(): void {
    if (this.#closed) return;
    this.#commit();
    if (this.#healthy) {
      try { this.#state("closed\n", "writer"); }
      catch { this.#fail(); }
    }
    this.#closed = true;
    if (!this.#healthy) throw new Error("qualification logging failed");
  }
  write(line: string): void {
    if (!this.#healthy || this.#closed) throw new Error("qualification logging failed");
    try {
      if (!this.#pending) {
        // One durable unhealthy transition covers the entire synchronous burst.
        // The queued commit cannot run between its bounded writes.
        this.#state("!");
        this.#pending = true;
        queueMicrotask(() => this.#commit());
      }
      assertQualificationLogDirectory(this.#directory);
      const event = parseQualificationLogEvent({ ...JSON.parse(line), index: ++this.#index });
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      if (bytes.length > 2048) throw new Error("qualification event exceeds bound");
      const path = join(this.#directory, "events.0.jsonl");
      const current = lstatSync(path);
      if (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid!() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) throw new Error("unsafe qualification log file");
      // A crash or partial write leaves the durable write-ahead state unhealthy.
      if (current.size + bytes.length > QUALIFICATION_LOG_BYTES) {
        this.#syncLog();
        this.#rotated = true;
        for (let index = QUALIFICATION_LOG_FILES - 1; index >= 0; index--) {
          const name = join(this.#directory, `events.${index}.jsonl`);
          let stat;
          try { stat = lstatSync(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error("unsafe qualification log file");
          if (index === QUALIFICATION_LOG_FILES - 1) unlinkSync(name);
          else renameSync(name, join(this.#directory, `events.${index + 1}.jsonl`));
        }
        const oldest = readdirSync(this.#directory).filter(name => /^events\.[1-3]\.jsonl$/u.test(name)).sort().at(-1)!;
        this.#firstIndex = parseQualificationLogEvent(JSON.parse(readFileSync(join(this.#directory, oldest), "utf8").split("\n", 1)[0]!)).index;
      }
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600 ||
          stat.size + bytes.length > QUALIFICATION_LOG_BYTES || writeSync(fd, bytes) !== bytes.length) throw new Error("qualification log write failed");
      } finally { closeSync(fd); }
    } catch {
      this.#fail();
      throw new Error("qualification logging failed");
    }
  }
}

const stdoutSink: LogSink = {
  write(line) {
    process.stdout.write(`${line}\n`);
  },
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMITED_EVENTS = new Set([
  "http.authorization_denied",
  "ipc.protocol_rejected",
  "ipc.authentication_denied",
  "ipc.connection_timeout",
  "ipc.connection_error",
]);

interface RateLimitState {
  lastWrittenAt: number;
  suppressed: number;
}

export class SafeLogger {
  readonly #sink: LogSink;
  readonly #now: () => number;
  readonly #rateLimits = new Map<string, RateLimitState>();

  constructor(sink: LogSink = stdoutSink, now: () => number = Date.now) {
    this.#sink = sink;
    this.#now = now;
  }

  /** Qualification aliases use the next append index, never identity-derived bytes. */
  get nextQualificationIndex(): number | undefined {
    return this.#sink instanceof QualificationLogSink ? this.#sink.nextIndex : undefined;
  }

  event(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (!["info", "warn", "error"].includes(level)) throw new Error("unsafe log level");
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(event)) throw new Error("unsafe log event name");
    const safeFields: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!/^[a-z][a-z0-9_.-]{0,31}$/u.test(key)) throw new Error("unsafe log field name");
      if (value !== undefined) {
        if (typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) throw new Error("unsafe log field value");
        safeFields[key] = value;
      }
    }
    if (RATE_LIMITED_EVENTS.has(event)) {
      const now = this.#now();
      const state = this.#rateLimits.get(event);
      if (state !== undefined && now - state.lastWrittenAt < RATE_LIMIT_WINDOW_MS) {
        state.suppressed += 1;
        return;
      }
      if (state !== undefined && state.suppressed > 0) safeFields.suppressed = state.suppressed;
      this.#rateLimits.set(event, { lastWrittenAt: now, suppressed: 0 });
    }
    this.#sink.write(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeFields }));
  }
}
