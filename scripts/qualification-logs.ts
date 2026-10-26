import { constants, closeSync, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { assertQualificationLogDirectory, parseQualificationLogEvent, QUALIFICATION_LOG_BYTES, QUALIFICATION_LOG_FILES, type QualificationLogEvent } from "../apps/gateway/src/logger.ts";
import type { FixtureExecutor } from "./push-qualification-fixture.ts";
import { FAILURE_STEPS, type QualificationFailureLane } from "./qualification-failure.ts";

export interface QualificationLogWindow { readonly lane: QualificationFailureLane; readonly phase: string; readonly after: number; readonly ordinal: number }
export interface PushDeliveryTelemetry { readonly sufficient: boolean; readonly sends: number; readonly acknowledgements: number; readonly failures: number; readonly retryable: boolean; readonly httpStatus: number; readonly clearAcknowledged?: boolean }
export interface QualificationLogs {
  prepare(): Promise<void>;
  begin(lane: QualificationLogWindow["lane"], phase: string): Promise<QualificationLogWindow>;
  end(window: QualificationLogWindow): Promise<PushDeliveryTelemetry>;
  healthy(): Promise<boolean>;
  collect(): Promise<{ files: number; events: number }>;
}
export function qualificationLogDirectory(home: string, epoch: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(home) || home.split("/").includes("..") || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(epoch)) throw new Error("invalid qualification log path");
  return `${home}/.local/state/omp-session-gateway/qualification-logs/${epoch}`;
}

export function parseQualificationLogs(texts: readonly string[]): QualificationLogEvent[] {
  if (texts.length > QUALIFICATION_LOG_FILES) throw new Error("qualification logs exceed file bound");
  const events: QualificationLogEvent[] = [];
  for (const text of texts) {
    if (Buffer.byteLength(text) > QUALIFICATION_LOG_BYTES || (text !== "" && !text.endsWith("\n"))) throw new Error("invalid qualification log size");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      if (Buffer.byteLength(line) > 2048 || events.length >= 16_384) throw new Error("qualification logs exceed event bound");
      const event = parseQualificationLogEvent(JSON.parse(line));
      // Writers emit canonical JSON; this also rejects duplicate/escaped keys and hidden discarded values.
      if (JSON.stringify(event) !== line) throw new Error("noncanonical qualification event");
      events.push(event);
    }
  }
  events.sort((left, right) => left.index - right.index);
  for (let index = 1; index < events.length; index++) if (events[index]!.index !== events[index - 1]!.index + 1) throw new Error("qualification log sequence gap");
  return events;
}

/** A unique queue/send pair, not wall-clock proximity, establishes the observation window. */
export function pushDeliveryTelemetry(events: readonly QualificationLogEvent[]): PushDeliveryTelemetry {
  const push = events.filter(event => event.event.startsWith("push."));
  const queues = push.filter(event => event.event === "push.queue_accepted");
  const sends = push.filter(event => event.event === "push.send_started");
  const acks = push.filter(event => event.event === "push.send_acknowledged");
  const failures = push.filter(event => event.event === "push.send_failed");
  const sequence = queues[0]?.sequence;
  const unique = queues.length === 1 && sends.length === 1 && sends[0]?.subscriptions === 1 &&
    push.every(event => event.sequence === sequence) && acks.length + failures.length === 1 &&
    sends[0]!.index > queues[0]!.index && (acks[0] ?? failures[0])!.index > sends[0]!.index;
  const sufficient = unique && queues[0]?.attention === true && sends[0]?.attention === true &&
    queues[0]?.subscription_replay !== true && sends[0]?.subscription_replay !== true;
  const status = typeof failures[0]?.status === "number" ? failures[0].status : 0;
  return { sufficient, sends: sends.length, acknowledgements: acks.length, failures: failures.length,
    retryable: sufficient && failures.length === 1 && (status === 429 || status >= 500 && status <= 599), httpStatus: sufficient ? status : 0,
    clearAcknowledged: unique && queues[0]?.clear === true && sends[0]?.clear === true && acks.length === 1 };
}

// Filesystem inspection runs on the retained Mac, not on a Studio pathname with the same spelling.
// It returns only bounded bytes to the in-memory validator; raw bytes never enter job artifacts.
const remoteScript = `import os,sys,stat,json
p,op=sys.argv[1:]
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
names=os.listdir(p)
allowed=['health']+['events.%d.jsonl'%i for i in range(4)]
if any(n not in allowed for n in names): raise ValueError('unknown file')
texts=[]
health=None
for n in sorted(names):
 fd=os.open(os.path.join(p,n),os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1 or s.st_size>262144: raise ValueError('unsafe file')
  data=os.read(fd,262145)
  if len(data)>262144: raise ValueError('oversized file')
  if n=='health':
   if len(data)>32: raise ValueError('invalid health')
   health=data.decode('ascii')
  else: texts.append(data.decode('utf-8'))
 finally: os.close(fd)
if op=='remove':
 for n in names: os.unlink(os.path.join(p,n))
 os.rmdir(p)
stable=False
if health is not None:
 if op=='remove': stable=True
 else:
  fd=os.open(os.path.join(p,'health'),os.O_RDONLY|os.O_NOFOLLOW)
  try:
   s=os.fstat(fd)
   if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1: raise ValueError('unsafe health')
   stable=health==os.read(fd,33).decode('ascii')
  finally: os.close(fd)
committed=int(health) if health is not None and health.endswith('\\n') and health[:-1].isdigit() else -1
print(json.dumps({'healthy':stable and committed>=0 and 'events.0.jsonl' in names,'index':committed,'texts':texts,'empty':len(names)==0}))
`;

export function createQualificationLogs(options: { execute: FixtureExecutor; remoteDirectory: string; jobDirectory: string }): QualificationLogs {
  if (!/\/\.local\/state\/omp-session-gateway\/qualification-logs\/[a-f0-9-]{36}$/u.test(options.remoteDirectory)) throw new Error("qualification logs must be outside fixture cleanup");
  let ordinal = 0;
  const windows = new Map<QualificationLogWindow, QualificationLogEvent[]>();
  let retainedBytes = 0;
  const remote = async (operation: "prepare" | "read" | "remove") => {
    const result = await options.execute(["python3", "-c", remoteScript, options.remoteDirectory, operation]);
    if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) throw new Error("qualification log inspection failed");
    return JSON.parse(result.stdout) as unknown;
  };
  const read = async () => {
    let value = await remote("read");
    // The synchronous writer marks health pending while committing one bounded event.
    // Only that explicit in-progress marker is sampled again, never malformed/unsafe records.
    for (let attempt = 0; attempt < 2 && typeof value === "object" && value !== null && "healthy" in value && value.healthy === false; attempt++) {
      await Bun.sleep(50);
      value = await remote("read");
    }
    if (typeof value !== "object" || value === null || !("healthy" in value) || value.healthy !== true || !("texts" in value) ||
      !Array.isArray(value.texts) || value.texts.some(text => typeof text !== "string")) throw new Error("qualification logging unhealthy");
    const events = parseQualificationLogs(value.texts);
    if (!("index" in value) || value.index !== (events.at(-1)?.index ?? 0)) throw new Error("qualification health sequence differs");
    return events;
  };
  const persist = (name: string, events: readonly QualificationLogEvent[]) => {
    assertQualificationLogDirectory(options.jobDirectory);
    const path = join(options.jobDirectory, name);
    const bytes = events.map(event => JSON.stringify(event)).join("\n") + (events.length === 0 ? "" : "\n");
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { if (writeSync(fd, bytes) !== Buffer.byteLength(bytes) || fstatSync(fd).nlink !== 1) throw new Error("qualification log retention failed"); }
    finally { closeSync(fd); }
    if (readFileSync(path, "utf8") !== bytes) throw new Error("qualification log retention differs");
  };
  return {
    async prepare() { await remote("prepare"); },
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
      const state = await remote("read");
      if (typeof state === "object" && state !== null && "empty" in state && state.empty === true && windows.size === 0) {
        // A prepared destination whose daemon never started has no telemetry to claim or retain.
        await remote("remove");
        return { files: 0, events: 0 };
      }
      const events = await read();
      persist("gateway-structured.jsonl", events);
      for (const [window, slice] of windows) persist(`gateway-${window.lane}-${window.phase}-${window.ordinal}.jsonl`, slice);
      await remote("remove");
      return { files: windows.size + 1, events: events.length };
    },
  };
}
