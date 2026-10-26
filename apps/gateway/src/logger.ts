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
  "push.queue_accepted": ["sequence", "attention", "clear", "activity_stop", "subscription_replay"],
  "push.send_started": ["sequence", "attention", "clear", "activity_stop", "subscriptions", "subscription_replay"],
  "push.send_acknowledged": ["sequence", "elapsed_ms"],
  "push.send_failed": ["sequence", "elapsed_ms", "status"],
  "push.subscription_evicted": ["sequence", "count"],
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
    fields.some(key => !["suppressed", "subscription_replay"].includes(key) && record[key] === undefined)) throw new Error("incomplete qualification event");
  if (record.event === "push.send_failed" && (record.sequence === undefined || record.elapsed_ms === undefined)) throw new Error("incomplete qualification event");
  return record as QualificationLogEvent;
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

/** Service restarts preserve the sequence; an unhealthy prior writer cannot erase its failure. */
export class QualificationLogSink implements LogSink {
  readonly #directory: string;
  #healthy = true;
  #index = 0;
  constructor(directory: string) {
    assertQualificationLogDirectory(directory);
    this.#directory = directory;
    const names = readdirSync(directory);
    if (names.length > 0) {
      if (!names.includes("health") || !names.includes("events.0.jsonl") ||
        names.some(name => name !== "health" && !/^events\.[0-3]\.jsonl$/u.test(name))) throw new Error("qualification logging was interrupted");
      for (const name of names) {
        const path = join(directory, name), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.nlink !== 1 ||
          (stat.mode & 0o777) !== 0o600 || stat.size > QUALIFICATION_LOG_BYTES || name === "health" && stat.size > 32) throw new Error("unsafe qualification log file");
      }
      for (const name of names.filter(name => name !== "health").sort().reverse()) {
        const text = readFileSync(join(directory, name), "utf8");
        if (text !== "" && !text.endsWith("\n")) throw new Error("qualification logging was interrupted");
        for (const line of text.trimEnd().split("\n")) {
          if (line === "") continue;
          const event = parseQualificationLogEvent(JSON.parse(line));
          if (Buffer.byteLength(line) > 2048 || JSON.stringify(event) !== line ||
            this.#index !== 0 && event.index !== this.#index + 1) throw new Error("invalid qualification log sequence");
          this.#index = event.index;
        }
      }
      if (readFileSync(join(directory, "health"), "utf8") !== `${this.#index}\n`) throw new Error("qualification logging was interrupted");
      return;
    }
    for (const name of ["events.0.jsonl", "health"]) {
      const fd = openSync(join(directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { if (name === "health") writeSync(fd, "0\n"); fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  #state(value: string): void {
    // Overwrite the existing private inode, not a directory entry: even lost directory-write
    // permission cannot preserve an old success marker across a failed event.
    const fd = openSync(join(this.#directory, "health"), constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) throw new Error("unsafe qualification health");
      if (writeSync(fd, value, 0, "utf8") !== Buffer.byteLength(value)) throw new Error("qualification health write failed");
      ftruncateSync(fd, Buffer.byteLength(value)); fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  get healthy(): boolean { return this.#healthy; }
  write(line: string): void {
    if (!this.#healthy) throw new Error("qualification logging failed");
    try {
      this.#state("!");
      assertQualificationLogDirectory(this.#directory);
      const event = parseQualificationLogEvent({ ...JSON.parse(line), index: ++this.#index });
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      if (bytes.length > 2048) throw new Error("qualification event exceeds bound");
      const path = join(this.#directory, "events.0.jsonl");
      const current = lstatSync(path);
      if (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid!() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) throw new Error("unsafe qualification log file");
      // A crash or partial write leaves the durable write-ahead state unhealthy.
      if (current.size + bytes.length > QUALIFICATION_LOG_BYTES) {
        for (let index = QUALIFICATION_LOG_FILES - 1; index >= 0; index--) {
          const name = join(this.#directory, `events.${index}.jsonl`);
          let stat;
          try { stat = lstatSync(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error("unsafe qualification log file");
          if (index === QUALIFICATION_LOG_FILES - 1) unlinkSync(name);
          else renameSync(name, join(this.#directory, `events.${index + 1}.jsonl`));
        }
      }
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600 ||
          stat.size + bytes.length > QUALIFICATION_LOG_BYTES || writeSync(fd, bytes) !== bytes.length) throw new Error("qualification log write failed");
        fsyncSync(fd);
      } finally { closeSync(fd); }
      this.#state(`${this.#index}\n`);
    } catch {
      this.#healthy = false;
      try { this.#state("!"); } catch { /* Never repair missing or inaccessible failure evidence. */ }
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
