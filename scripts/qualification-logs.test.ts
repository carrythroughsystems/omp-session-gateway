import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { QualificationLogSink, SafeLogger } from "../apps/gateway/src/logger.ts";
import { createQualificationLogs, parseQualificationLogs, pushDeliveryTelemetry, qualificationLogDirectory } from "./qualification-logs.ts";
import { executeFixture } from "./push-qualification-fixture.ts";
const event = (index: number, name: string, fields: Record<string, number | boolean>) => ({ timestamp: "2026-01-01T00:00:00.000Z", level: "info" as const, event: name, request_alias: 1, ...fields, index });
const flags = { request_alias: 1, attention: true, clear: false, activity_stop: false, subscription_replay: false };
const send = [event(1, "push.queue_accepted", { sequence: 1, ...flags }), event(2, "push.send_started", { sequence: 1, ...flags, subscriptions: 1 }),
  event(3, "push.send_failed", { sequence: 1, elapsed_ms: 1, status: 503 })];

test.skipIf(process.platform === "win32")("private browser diagnostic preserves CDP failure without changing telemetry", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-browser-")); chmodSync(root, 0o700);
  const logs = createQualificationLogs({ execute: async () => { throw new Error("diagnostic must stay local"); },
    remoteDirectory: qualificationLogDirectory(root, randomUUID()), jobDirectory: root });
  const cause = new Error("CDP Runtime.evaluate: Cannot find default execution context");
  try {
    await logs.browserFailure("browser_context", new Error("browser wrapper", { cause }), 2606);
    const path = join(root, "browser-substep.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      substep: "browser_context", message: cause.message, cdpMethod: "Runtime.evaluate", elapsedMs: 2606,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(logs.browserFailure("browser_context", cause, 1)).rejects.toThrow();
    expect(readdirSync(root)).toEqual(["browser-substep.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32").each(["symlink", "public-directory"] as const)(
  "private browser diagnostic refuses %s destinations", async variant => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-browser-refuse-")); chmodSync(root, 0o700);
    const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory: qualificationLogDirectory(root, randomUUID()), jobDirectory: root });
    const outside = join(root, "untouched");
    writeFileSync(outside, "preserved", { mode: 0o600 });
    if (variant === "symlink") symlinkSync(outside, join(root, "browser-substep.json"));
    else chmodSync(root, 0o755);
    try {
      await expect(logs.browserFailure("browser_context", new Error("CDP timeout: Runtime.evaluate"), 1)).rejects.toThrow();
      expect(readFileSync(outside, "utf8")).toBe("preserved");
    } finally { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); }
  });

test.each(["reversed-queues", "interleaved-completion"] as const)("506 council telemetry rejects %s ordering", variant => {
  const events = variant === "reversed-queues" ? [
    event(1, "push.queue_accepted", { sequence: 2, ...flags }),
    event(2, "push.send_started", { sequence: 2, ...flags, subscriptions: 1 }),
    event(3, "push.send_acknowledged", { sequence: 2, elapsed_ms: 1 }),
    event(4, "push.queue_accepted", { sequence: 1, ...flags }),
    event(5, "push.send_started", { sequence: 1, ...flags, subscriptions: 1 }),
    event(6, "push.send_acknowledged", { sequence: 1, elapsed_ms: 1 }),
  ] : [
    event(1, "push.queue_accepted", { sequence: 1, ...flags }),
    event(2, "push.send_started", { sequence: 1, ...flags, subscriptions: 2 }),
    event(3, "push.send_acknowledged", { sequence: 1, elapsed_ms: 1 }),
    event(4, "push.send_started", { sequence: 1, ...flags, subscriptions: 2 }),
    event(5, "push.send_acknowledged", { sequence: 1, elapsed_ms: 1 }),
  ];
  expect(pushDeliveryTelemetry(events)).toMatchObject({ sufficient: false, retryable: false, clearAcknowledged: false });
});

test("readiness fan-out requires complete acknowledgement of every send for one alias", () => {
  const fanout = [
    event(1, "push.queue_accepted", { sequence: 1, ...flags }),
    event(2, "push.send_started", { sequence: 1, ...flags, subscriptions: 2 }),
    event(3, "push.send_started", { sequence: 1, ...flags, subscriptions: 2 }),
    event(4, "push.send_acknowledged", { sequence: 1, elapsed_ms: 1 }),
    event(5, "push.send_acknowledged", { sequence: 1, elapsed_ms: 2 }),
  ];
  expect(pushDeliveryTelemetry(fanout)).toMatchObject({
    sufficient: true, subscriptionCount: 2, sends: 2, acknowledgements: 2, requestAlias: 1,
  });
  const repeated = [...fanout, ...fanout.map(item => ({ ...item, index: item.index + 5, sequence: 2 }))];
  expect(pushDeliveryTelemetry(repeated)).toMatchObject({ sufficient: true, sends: 4, acknowledgements: 4, requestAlias: 1 });
  const changedCohort = [...fanout,
    event(6, "push.queue_accepted", { sequence: 2, ...flags }),
    event(7, "push.send_started", { sequence: 2, ...flags, subscriptions: 1 }),
    event(8, "push.send_acknowledged", { sequence: 2, elapsed_ms: 1 }),
  ];
  expect(pushDeliveryTelemetry(changedCohort)).toMatchObject({ sufficient: true, subscriptionCount: 2, sends: 3, acknowledgements: 3 });
  for (const incomplete of [
    fanout.slice(0, -1),
    fanout.filter(item => item.index !== 2),
    fanout.map(item => item.index === 5 ? { ...item, request_alias: 2 } : item),
    fanout.map(item => item.index === 3 ? { ...item, sequence: 2 } : item),
    fanout.map(item => item.index === 5 ? { ...item, event: "push.send_failed", status: 503 } : item),
    fanout.map(item => ({ ...item, subscription_replay: true })),
  ]) expect(pushDeliveryTelemetry(incomplete)).toMatchObject({ sufficient: false, retryable: false });
});

test.skipIf(process.platform === "win32")("495 round2 collector excludes writer restart before retention and retires before unlink", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-claim-")); chmodSync(root, 0o700);
  const job = mkdtempSync(join(root, "job-")); chmodSync(job, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory, jobDirectory: job });
  const original = fs.fsyncSync;
  let tested = false, restarted = false, syncing: ReturnType<typeof spyOn> | undefined;
  try {
    await logs.prepare(); new QualificationLogSink(remoteDirectory).close();
    syncing = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (!tested) {
        tested = true;
        try { new QualificationLogSink(remoteDirectory).close(); restarted = true; } catch { /* Exclusive collection must win. */ }
      }
      original(fd);
    });
    await logs.collect();
    expect(tested).toBe(true);
    expect(restarted).toBe(false);
    expect(existsSync(remoteDirectory)).toBe(false);
  } finally { syncing?.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32").each([false, true])("495 round2 remote unlink requires permanent retirement (failure=%s)", async fail => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-retire-")); chmodSync(root, 0o700);
  const job = mkdtempSync(join(root, "job-")); chmodSync(job, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  const logs = createQualificationLogs({ remoteDirectory, jobDirectory: job, execute: async argv => {
    if (argv.at(-1) !== "remove") return executeFixture(argv);
    const hook = `import os,sys
original_unlink=os.unlink
def checked_unlink(path,*args,**kwargs):
 if os.path.exists(sys.argv[1]) or os.path.dirname(path)!=sys.argv[1]+'.retired': raise ValueError('unlink before retirement')
 if ${fail ? "True" : "False"}: raise ValueError('synthetic unlink failure')
 return original_unlink(path,*args,**kwargs)
os.unlink=checked_unlink
`;
    return executeFixture([...argv.slice(0, 2), hook + argv[2], ...argv.slice(3)]);
  } });
  try {
    await logs.prepare(); new QualificationLogSink(remoteDirectory).close();
    if (fail) {
      await expect(logs.collect()).rejects.toThrow();
      expect(existsSync(join(remoteDirectory + ".retired", "health"))).toBe(true);
      expect(() => new QualificationLogSink(remoteDirectory + ".retired")).toThrow();
    } else await logs.collect();
    expect(existsSync(remoteDirectory)).toBe(false);
    expect(existsSync(join(job, "gateway-structured.jsonl"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only an unambiguous single send's explicit retryable status authorizes recovery", () => {
  expect(pushDeliveryTelemetry(send)).toMatchObject({ sufficient: false, retryable: true, sends: 1, acknowledgements: 0 });
  expect(pushDeliveryTelemetry([...send, event(4, "push.queue_accepted", { sequence: 2, ...flags })]).sufficient).toBe(false);
  expect(pushDeliveryTelemetry([send[0]!, { ...send[1]!, subscriptions: 2 }, send[2]!]).sufficient).toBe(false);
  expect(pushDeliveryTelemetry([send[0]!, send[1]!, event(3, "push.send_acknowledged", { sequence: 1, elapsed_ms: 1 })]).retryable).toBe(false);
  expect(pushDeliveryTelemetry([send[0]!, send[1]!, event(3, "push.send_failed", { sequence: 1, elapsed_ms: 1 })]).retryable).toBe(false);
});

test("R3 subscription replay is not an attributable fresh ask and R6 clear acknowledgement is explicit", () => {
  expect(pushDeliveryTelemetry(send.map(item => ({ ...item, subscription_replay: true }))).sufficient).toBe(false);
  const clear = [event(1, "push.queue_accepted", { sequence: 1, ...flags, attention: false, clear: true }),
    event(2, "push.send_started", { sequence: 1, ...flags, attention: false, clear: true, subscriptions: 1 }),
    event(3, "push.send_acknowledged", { sequence: 1, elapsed_ms: 1 })];
  expect(pushDeliveryTelemetry(clear)).toMatchObject({ clearAcknowledged: true });
  expect(pushDeliveryTelemetry(clear.slice(0, 2))).toMatchObject({ clearAcknowledged: false });
});

test.skipIf(process.platform === "win32")("R1 collector refuses stale success after an unremovable health-marker failure", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-health-")); chmodSync(root, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory, jobDirectory: root });
  try {
    await logs.prepare();
    const logger = new SafeLogger(new QualificationLogSink(remoteDirectory));
    logger.event("info", "http.listening", { port: 4317 });
    chmodSync(remoteDirectory, 0o500);
    expect(() => logger.event("info", "http.listening", { port: 4317 })).toThrow();
    chmodSync(remoteDirectory, 0o700);
    expect(await logs.healthy()).toBe(false);
  } finally { chmodSync(remoteDirectory, 0o700); rmSync(root, { recursive: true, force: true }); }
});

test("log parser rejects hidden payloads, invalid values, duplicate keys, gaps and excessive bytes", () => {
  const line = JSON.stringify(send[0]);
  for (const text of [line.replace('"index":1', '"payload":"SYNTHETIC-SECRET","index":1'), line.replace('"index":1', '"index":1,"index":1'),
    JSON.stringify({ ...send[0], event: "push.SYNTHETIC_ID" }), JSON.stringify({ ...send[0], sequence: null }), " ".repeat(256 * 1024 + 1)]) {
    expect(() => parseQualificationLogs([`${text}\n`])).toThrow();
  }
  expect(() => parseQualificationLogs([`${line}\n${JSON.stringify(send[2])}\n`])).toThrow();
  expect(parseQualificationLogs([send.map(item => JSON.stringify(item)).join("\n") + "\n"])).toHaveLength(3);
});

test("R2 collector refuses lost prefixes and disordered records rather than sorting away evidence", () => {
  const lines = send.map(item => JSON.stringify(item));
  for (const texts of [[`${lines[1]}\n${lines[2]}\n`], [`${lines[1]}\n${lines[0]}\n${lines[2]}\n`],
    [`${lines[1]}\n${lines[2]}\n`, `${lines[0]}\n`]]) expect(() => parseQualificationLogs(texts)).toThrow();
});

test("R2 missing replay provenance cannot authorize a fresh-ask recovery", () => {
  const missing = send.map(item => { const copy = { ...item }; delete (copy as Record<string, unknown>).subscription_replay; return copy; });
  expect(pushDeliveryTelemetry(missing)).toMatchObject({ sufficient: false, retryable: false });
});

test.skipIf(process.platform === "win32")("R2 collector brackets a concurrent committed append with two health reads", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-bracket-")); chmodSync(root, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  let armed = false, reads = 0;
  const execute = async (argv: readonly string[]) => {
    if (argv.at(-1) !== "read" || !armed) return executeFixture(argv);
    armed = false; reads++;
    const hook = `import os,sys,json
original_open=os.open
def intercepted_open(path,flags,*args,**kwargs):
 if path==os.path.join(sys.argv[1],'events.0.jsonl'):
  with open(path) as f: event=json.loads(f.readline())
  event['index']=2
  with open(path,'a') as f: f.write(json.dumps(event,separators=(',',':'))+'\\n')
  health=os.path.join(sys.argv[1],'health')
  with open(health) as f: structured=f.read().startswith('[')
  with open(health,'w') as f: f.write('[2,1]\\n' if structured else '2\\n')
  os.open=original_open
 return original_open(path,flags,*args,**kwargs)
os.open=intercepted_open
`;
    return executeFixture([...argv.slice(0, 2), hook + argv[2], ...argv.slice(3)]);
  };
  const logs = createQualificationLogs({ execute: async argv => {
    if (argv.at(-1) === "read" && !armed) reads++;
    return execute(argv);
  }, remoteDirectory, jobDirectory: root });
  try {
    await logs.prepare();
    new SafeLogger(new QualificationLogSink(remoteDirectory)).event("info", "http.listening", { port: 4317 });
    await Promise.resolve(); armed = true;
    expect(await logs.healthy()).toBe(true);
    expect(reads).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("R2 retained files and their directory are durable before remote removal", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-fsync-")); chmodSync(root, 0o700);
  const job = mkdtempSync(join(root, "job-")); chmodSync(job, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  let fileSynced = false, directorySynced = false;
  const logs = createQualificationLogs({ remoteDirectory, jobDirectory: job, execute: async argv => {
    if (argv.at(-1) === "remove") { expect(fileSynced).toBe(true); expect(directorySynced).toBe(true); }
    return executeFixture(argv);
  } });
  const original = fs.fsyncSync;
  let syncing: ReturnType<typeof spyOn> | undefined;
  try {
    await logs.prepare(); new QualificationLogSink(remoteDirectory).close();
    syncing = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) directorySynced = true; else fileSynced = true;
      original(fd);
    });
    await logs.collect();
    expect(existsSync(remoteDirectory)).toBe(false);
  } finally { syncing?.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("495 R1 final collection refuses a matching commit from an unclosed writer", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-unclosed-")); chmodSync(root, 0o700);
  const job = mkdtempSync(join(root, "job-")); chmodSync(job, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory, jobDirectory: job });
  try {
    await logs.prepare();
    new SafeLogger(new QualificationLogSink(remoteDirectory)).event("info", "http.listening", { port: 4317 });
    await Promise.resolve();
    expect(await logs.healthy()).toBe(true);
    await expect(logs.collect()).rejects.toThrow();
    expect(existsSync(remoteDirectory)).toBe(true);
    expect(readdirSync(job)).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32").each(["file", "directory"] as const)("R2 failed %s fsync preserves remote evidence", async stage => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-durability-")); chmodSync(root, 0o700);
  const job = mkdtempSync(join(root, "job-")); chmodSync(job, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory, jobDirectory: job });
  const original = fs.fsyncSync;
  let syncing: ReturnType<typeof spyOn> | undefined;
  try {
    await logs.prepare(); new QualificationLogSink(remoteDirectory).close();
    syncing = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory() === (stage === "directory")) throw new Error("synthetic retention failure");
      original(fd);
    });
    await expect(logs.collect()).rejects.toThrow("synthetic retention failure");
    expect(existsSync(join(remoteDirectory, "health"))).toBe(true);
  } finally { syncing?.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("collector validates real private paths, keeps immutable slices and removes only after collection", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-collection-")); chmodSync(root, 0o700);
  const job = mkdtempSync(join(root, "job-")); chmodSync(job, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory, jobDirectory: job });
  try {
    await logs.prepare();
    const sink = new QualificationLogSink(remoteDirectory), logger = new SafeLogger(sink);
    const window = await logs.begin("androidPush", "private_verified");
    logger.event("info", "push.queue_accepted", { sequence: 1, ...flags });
    logger.event("info", "push.send_started", { sequence: 1, ...flags, subscriptions: 1 });
    logger.event("warn", "push.send_failed", { sequence: 1, request_alias: 1, elapsed_ms: 10, status: 503 });
    expect(await logs.end(window)).toMatchObject({ sufficient: false, retryable: true });
    expect(await logs.healthy()).toBe(true);
    sink.close();
    expect(await logs.collect()).toEqual({ files: 2, events: 3 });
    expect(existsSync(remoteDirectory)).toBe(false);
    for (const name of readdirSync(job)) {
      expect(statSync(join(job, name)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(job, name), "utf8")).not.toContain(root);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("invalid remote telemetry and destination collisions preserve remote evidence", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-invalid-")); chmodSync(root, 0o700);
  const job = mkdtempSync(join(root, "job-")); chmodSync(job, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory, jobDirectory: job });
  try {
    await logs.prepare(); new QualificationLogSink(remoteDirectory).close();
    writeFileSync(join(remoteDirectory, "events.0.jsonl"), '{"payload":"SYNTHETIC-SECRET"}\n');
    expect(await logs.healthy()).toBe(false);
    await expect(logs.collect()).rejects.toThrow();
    expect(readdirSync(job)).toHaveLength(0);
    expect(existsSync(remoteDirectory)).toBe(true);
    writeFileSync(join(remoteDirectory, "events.0.jsonl"), "");
    symlinkSync(join(root, "outside"), join(job, "gateway-structured.jsonl"));
    await expect(logs.collect()).rejects.toThrow();
    expect(existsSync(remoteDirectory)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("a never-started gateway's empty directory can be disposed without fabricated telemetry", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-empty-")); chmodSync(root, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory, jobDirectory: root });
  try {
    await logs.prepare();
    expect(await logs.healthy()).toBe(false);
    expect(await logs.collect()).toEqual({ files: 0, events: 0 });
    expect(existsSync(remoteDirectory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("remote preparation refuses an ancestor symlink before creating any destination", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-symlink-")); chmodSync(root, 0o700);
  const outside = mkdtempSync(join(realpathSync(tmpdir()), "qualification-outside-"));
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  try {
    symlinkSync(outside, join(root, ".local"));
    const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory, jobDirectory: root });
    await expect(logs.prepare()).rejects.toThrow("inspection failed");
    expect(readdirSync(outside)).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
