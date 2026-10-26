import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { assertQualificationLogDirectory, parseQualificationLogFiles, parseQualificationLogHealth, type QualificationLogEvent } from "../apps/gateway/src/logger.ts";
import type { FixtureExecutor } from "./push-qualification-fixture.ts";
import { FAILURE_STEPS, PUSH_BROWSER_STEPS, PRIVATE_QUALIFICATION_DIAGNOSTIC_BYTES, privateQualificationFailureDiagnostic, type PushBrowserStep, type QualificationFailureLane } from "./qualification-failure.ts";

export interface QualificationLogWindow { readonly lane: QualificationFailureLane; readonly phase: string; readonly after: number; readonly ordinal: number }
export interface PushDeliveryTelemetry { readonly sufficient: boolean; readonly subscriptionCount: number; readonly sends: number; readonly acknowledgements: number; readonly failures: number; readonly retryable: boolean; readonly httpStatus: number; readonly clearAcknowledged?: boolean; readonly requestAlias?: number }
export interface QualificationLogs {
  prepare(): Promise<void>;
  browserFailure(substep: PushBrowserStep, error: unknown, elapsedMs: number): Promise<void>;
  begin(lane: QualificationLogWindow["lane"], phase: string): Promise<QualificationLogWindow>;
  end(window: QualificationLogWindow): Promise<PushDeliveryTelemetry>;
  healthy(): Promise<boolean>;
  collect(): Promise<{ files: number; events: number }>;
}
export function qualificationLogDirectory(home: string, epoch: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(home) || home.split("/").includes("..") || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(epoch)) throw new Error("invalid qualification log path");
  return `${home}/.local/state/omp-session-gateway/qualification-logs/${epoch}`;
}

export function parseQualificationLogs(texts: readonly string[], firstIndex = 1): QualificationLogEvent[] {
  return parseQualificationLogFiles(texts, firstIndex);
}

/** One request alias owns every queue and complete fan-out in the observation window. */
export function pushDeliveryTelemetry(events: readonly QualificationLogEvent[]): PushDeliveryTelemetry {
  const push = events.filter(event => event.event.startsWith("push."));
  const queues = push.filter(event => event.event === "push.queue_accepted");
  const sends = push.filter(event => event.event === "push.send_started");
  const acks = push.filter(event => event.event === "push.send_acknowledged");
  const failures = push.filter(event => event.event === "push.send_failed");
  const requestAlias = queues[0]?.request_alias;
  let subscriptionCount = 0;
  const groups = new Map<number, { started: number; completed: number; expected: number }>();
  let attributable = queues.length > 0 && sends.length > 0 &&
    typeof requestAlias === "number" && Number.isSafeInteger(requestAlias) && requestAlias > 0;
  let previousIndex = 0, previousQueue = 0;
  for (const event of push) {
    if (event.request_alias !== requestAlias || typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence) ||
      event.sequence < 1 || event.index <= previousIndex) { attributable = false; break; }
    previousIndex = event.index;
    const group = groups.get(event.sequence);
    if (event.event === "push.queue_accepted") {
      if (group !== undefined || event.sequence <= previousQueue || event.subscription_replay !== false) { attributable = false; break; }
      previousQueue = event.sequence;
      groups.set(event.sequence, { started: 0, completed: 0, expected: 0 });
    } else if (event.event === "push.send_started") {
      if (group === undefined || event.subscription_replay !== false || typeof event.subscriptions !== "number" ||
        !Number.isSafeInteger(event.subscriptions) || event.subscriptions < 1 || event.subscriptions > 8 ||
        group.expected !== 0 && group.expected !== event.subscriptions ||
        event.attention !== queues[0]?.attention || event.clear !== queues[0]?.clear ||
        event.activity_stop !== queues[0]?.activity_stop) { attributable = false; break; }
      group.expected = event.subscriptions;
      subscriptionCount = Math.max(subscriptionCount, event.subscriptions);
      group.started++;
    } else if (event.event === "push.send_acknowledged" || event.event === "push.send_failed") {
      if (group === undefined || group.started !== group.expected || group.completed >= group.started) { attributable = false; break; }
      group.completed++;
    } else {
      attributable = false;
      break;
    }
  }
  for (const group of groups.values()) {
    if (group.expected < 1 || group.started !== group.expected || group.completed !== group.started) attributable = false;
  }
  attributable &&= queues.every(queue => queue.attention === queues[0]?.attention && queue.clear === queues[0]?.clear && queue.activity_stop === queues[0]?.activity_stop);
  const acknowledged = attributable && failures.length === 0 && acks.length === sends.length;
  const sufficient = acknowledged && queues[0]?.attention === true;
  const status = typeof failures[0]?.status === "number" ? failures[0].status : 0;
  // Preserve the existing single failed-send recovery authority; partial fan-out never authorizes re-arm.
  const retryable = attributable && queues[0]?.attention === true && sends.length === 1 && failures.length === 1 &&
    (status === 429 || status >= 500 && status <= 599);
  return { sufficient, subscriptionCount,
    sends: sends.length, acknowledgements: acks.length, failures: failures.length, retryable, httpStatus: attributable ? status : 0,
    clearAcknowledged: acknowledged && queues[0]?.clear === true,
    ...(attributable ? { requestAlias: requestAlias as number } : {}) };
}

// Filesystem inspection runs on the retained Mac, not on a Studio pathname with the same spelling.
// It returns only bounded bytes to the in-memory validator; raw bytes never enter job artifacts.
const remoteScript = `import os,sys,stat,json
p,expected,op=sys.argv[1:]
if not os.path.isabs(p) or os.path.normpath(p)!=p: raise ValueError('unsafe path')
if op=='prepare':
 q='/'
 for part in os.path.dirname(p).split('/')[1:]:
  q=os.path.join(q,part)
  try: s=os.lstat(q)
  except FileNotFoundError: os.mkdir(q,0o700);s=os.lstat(q)
  if not stat.S_ISDIR(s.st_mode): raise ValueError('unsafe ancestor')
 os.mkdir(p,0o700)
q=p
while True:
 s=os.lstat(q)
 if not stat.S_ISDIR(s.st_mode): raise ValueError('unsafe directory')
 if q==p and (s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o700): raise ValueError('unsafe owner')
 if os.path.dirname(q)==q: break
 q=os.path.dirname(q)
if op=='prepare': print('{}');sys.exit(0)
if op=='claim':
 fd=os.open(os.path.join(p,'claim'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  if os.write(fd,b'collector\\n')!=10: raise ValueError('claim write failed')
  os.fsync(fd)
 finally: os.close(fd)
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try: os.fsync(fd)
 finally: os.close(fd)
def read_private(n,limit):
 fd=os.open(os.path.join(p,n),os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1 or s.st_size>limit: raise ValueError('unsafe file')
  data=os.read(fd,limit+1)
  if len(data)>limit: raise ValueError('oversized file')
  return data.decode('utf-8')
 finally: os.close(fd)
try: before=read_private('health',64)
except FileNotFoundError: before=None
try: writer_before=read_private('writer',16)
except FileNotFoundError: writer_before=None
names=os.listdir(p)
try: claim=read_private('claim',16)
except FileNotFoundError: claim=None
if claim not in [None,'writer\\n','collector\\n']: raise ValueError('invalid claim')
files=sorted(n for n in names if n not in ['health','writer','claim'])
if len(files)>4 or files!=['events.%d.jsonl'%i for i in range(len(files))]: raise ValueError('rotation gap')
texts=[read_private(n,262144) for n in reversed(files)]
try: after=read_private('health',64)
except FileNotFoundError: after=None
try: writer_after=read_private('writer',16)
except FileNotFoundError: writer_after=None
stable=before==after and before is not None and before.startswith('[') and before.endswith('\\n') and writer_before==writer_after and writer_after in ['active\\n','closed\\n']
if op=='remove':
 if claim!='collector\\n': raise ValueError('collector claim missing')
 if names!=['claim'] and (not stable or after!=expected or writer_after!='closed\\n'): raise ValueError('retained snapshot changed')
 retired=p+'.retired'
 try: os.lstat(retired)
 except FileNotFoundError: pass
 else: raise ValueError('retired destination exists')
 os.rename(p,retired)
 p=retired
 fd=os.open(os.path.dirname(p),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try: os.fsync(fd)
 finally: os.close(fd)
 for n in names:
  if n!='claim': os.unlink(os.path.join(p,n))
 os.unlink(os.path.join(p,'claim'))
 os.rmdir(p)
print(json.dumps({'healthy':stable and 'events.0.jsonl' in names,'health':after,'writer':writer_after,'texts':texts,'empty':not any(n!='claim' for n in names)}))
`;

export function createQualificationLogs(options: { execute: FixtureExecutor; remoteDirectory: string; jobDirectory: string }): QualificationLogs {
  if (!/\/\.local\/state\/omp-session-gateway\/qualification-logs\/[a-f0-9-]{36}$/u.test(options.remoteDirectory)) throw new Error("qualification logs must be outside fixture cleanup");
  let ordinal = 0;
  const windows = new Map<QualificationLogWindow, QualificationLogEvent[]>();
  let retainedBytes = 0;
  const remote = async (operation: "prepare" | "read" | "claim" | "remove", expected = "") => {
    const result = await options.execute(["python3", "-c", remoteScript, options.remoteDirectory, expected, operation]);
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) throw new Error("qualification log inspection failed");
    return JSON.parse(result.stdout) as unknown;
  };
  const readState = async (requireClosed = false) => {
    let value = await remote("read");
    // A pending writer or any changed health state invalidates the entire bracketed read.
    for (let attempt = 0; attempt < 2 && typeof value === "object" && value !== null && "healthy" in value && value.healthy === false; attempt++) {
      await Bun.sleep(50);
      value = await remote("read");
    }
    if (typeof value !== "object" || value === null || !("healthy" in value) || value.healthy !== true || !("texts" in value) ||
      !Array.isArray(value.texts) || value.texts.some(text => typeof text !== "string")) throw new Error("qualification logging unhealthy");
    if (!("health" in value) || typeof value.health !== "string") throw new Error("qualification health missing");
    if (!("writer" in value) || !["active\n", "closed\n"].includes(String(value.writer)) ||
      requireClosed && value.writer !== "closed\n") throw new Error("qualification writer was not closed");
    const [index, first] = parseQualificationLogHealth(value.health);
    const events = parseQualificationLogs(value.texts, first);
    if (index !== (events.at(-1)?.index ?? 0)) throw new Error("qualification health sequence differs");
    return { events, health: value.health };
  };
  const read = async () => (await readState()).events;
  const persist = (name: string, bytes: string) => {
    assertQualificationLogDirectory(options.jobDirectory);
    const path = join(options.jobDirectory, name);
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      if (writeSync(fd, bytes) !== Buffer.byteLength(bytes) || fstatSync(fd).nlink !== 1) throw new Error("qualification log retention failed");
      fsyncSync(fd);
    }
    finally { closeSync(fd); }
    if (readFileSync(path, "utf8") !== bytes) throw new Error("qualification log retention differs");
  };
  return {
    async prepare() { await remote("prepare"); },
    async browserFailure(substep, error, elapsedMs) {
      if (!PUSH_BROWSER_STEPS.includes(substep) || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error("invalid private browser diagnostic");
      const chain = privateQualificationFailureDiagnostic(error);
      const method = /^CDP (?:timeout: )?([A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*)(?::|$)/u;
      const cause = chain.filter(entry => method.test(entry.message)).reduce((deepest, entry) =>
        entry.path.split(".").length >= deepest.path.split(".").length ? entry : deepest, chain[0]!);
      const bytes = JSON.stringify({ substep, message: cause.message,
        cdpMethod: method.exec(cause.message)?.[1] ?? null, elapsedMs,
        ...(chain.some(entry => entry.truncated) ? { truncated: true } : {}),
        ...(chain.some(entry => entry.redacted) ? { redacted: true } : {}) }) + "\n";
      if (Buffer.byteLength(bytes) > PRIVATE_QUALIFICATION_DIAGNOSTIC_BYTES) throw new Error("private browser diagnostic exceeds byte limit");
      persist("browser-substep.json", bytes);
      const directory = openSync(options.jobDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    },
    async begin(lane, phase) {
      if (!Object.hasOwn(FAILURE_STEPS, lane) || (!(FAILURE_STEPS[lane] as readonly string[]).includes(phase) &&
        !(lane === "rigReadiness" && phase === "readiness")) || ordinal >= 256) throw new Error("invalid qualification capture window");
      const events = await read();
      const window = { lane, phase, after: events.at(-1)?.index ?? 0, ordinal: ++ordinal };
      windows.set(window, []);
      retainedBytes += 2;
      return window;
    },
    async end(window) {
      if (!windows.has(window)) throw new Error("unowned qualification capture window");
      const events = await read();
      if (events.length > 0 && events[0]!.index > window.after + 1) throw new Error("qualification capture rotated away");
      const slice = events.filter(event => event.index > window.after);
      retainedBytes -= JSON.stringify(windows.get(window)).length;
      retainedBytes += JSON.stringify(slice).length;
      if (retainedBytes > 8 * 1024 * 1024) throw new Error("qualification captures exceed bound");
      windows.set(window, slice);
      return pushDeliveryTelemetry(slice);
    },
    async healthy() { try { await read(); return true; } catch { return false; } },
    async collect() {
      // Claim before reading/copying; a writer cannot restart between retention and unlink.
      // Any failed retention deliberately leaves the claim and all remote evidence intact.
      const state = await remote("claim");
      if (typeof state === "object" && state !== null && "empty" in state && state.empty === true && windows.size === 0) {
        // A prepared destination whose daemon never started has no telemetry to claim or retain.
        await remote("remove");
        return { files: 0, events: 0 };
      }
      const { events, health } = await readState(true);
      const lines = (events: readonly QualificationLogEvent[]) => events.map(event => JSON.stringify(event)).join("\n") + (events.length === 0 ? "" : "\n");
      persist("gateway-structured.jsonl", lines(events));
      for (const [window, slice] of windows) persist(`gateway-${window.lane}-${window.phase}-${window.ordinal}.jsonl`, lines(slice));
      const directory = openSync(options.jobDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      await remote("remove", health);
      return { files: windows.size + 1, events: events.length };
    },
  };
}
