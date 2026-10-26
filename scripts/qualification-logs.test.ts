import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { QualificationLogSink, SafeLogger } from "../apps/gateway/src/logger.ts";
import { createQualificationLogs, parseQualificationLogs, pushDeliveryTelemetry, qualificationLogDirectory } from "./qualification-logs.ts";
import { executeFixture } from "./push-qualification-fixture.ts";
const event = (index: number, name: string, fields: Record<string, number | boolean>) => ({ timestamp: "2026-01-01T00:00:00.000Z", level: "info" as const, event: name, ...fields, index });
const flags = { attention: true, clear: false, activity_stop: false };
const send = [event(1, "push.queue_accepted", { sequence: 1, ...flags }), event(2, "push.send_started", { sequence: 1, ...flags, subscriptions: 1 }),
  event(3, "push.send_failed", { sequence: 1, elapsed_ms: 1, status: 503 })];

test("only an unambiguous single send's explicit retryable status authorizes recovery", () => {
  expect(pushDeliveryTelemetry(send)).toMatchObject({ sufficient: true, retryable: true, sends: 1, acknowledgements: 0 });
  expect(pushDeliveryTelemetry([...send, event(4, "push.queue_accepted", { sequence: 2, ...flags })]).sufficient).toBe(false);
  expect(pushDeliveryTelemetry([send[0]!, { ...send[1]!, subscriptions: 2 }, send[2]!]).sufficient).toBe(false);
  expect(pushDeliveryTelemetry([send[0]!, send[1]!, event(3, "push.send_acknowledged", { sequence: 1, elapsed_ms: 1 })]).retryable).toBe(false);
  expect(pushDeliveryTelemetry([send[0]!, send[1]!, event(3, "push.send_failed", { sequence: 1, elapsed_ms: 1 })]).retryable).toBe(false);
});

test("R3 subscription replay is not an attributable fresh ask and R6 clear acknowledgement is explicit", () => {
  expect(pushDeliveryTelemetry(send.map(item => ({ ...item, subscription_replay: true }))).sufficient).toBe(false);
  const clear = [event(1, "push.queue_accepted", { sequence: 1, attention: false, clear: true, activity_stop: false }),
    event(2, "push.send_started", { sequence: 1, attention: false, clear: true, activity_stop: false, subscriptions: 1 }),
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

test.skipIf(process.platform === "win32")("collector validates real private paths, keeps immutable slices and removes only after collection", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualification-collection-")); chmodSync(root, 0o700);
  const job = mkdtempSync(join(root, "job-")); chmodSync(job, 0o700);
  const remoteDirectory = qualificationLogDirectory(root, randomUUID());
  const logs = createQualificationLogs({ execute: executeFixture, remoteDirectory, jobDirectory: job });
  try {
    await logs.prepare();
    const logger = new SafeLogger(new QualificationLogSink(remoteDirectory));
    const window = await logs.begin("androidPush", "private_verified");
    logger.event("info", "push.queue_accepted", { sequence: 1, ...flags });
    logger.event("info", "push.send_started", { sequence: 1, ...flags, subscriptions: 1 });
    logger.event("warn", "push.send_failed", { sequence: 1, elapsed_ms: 10, status: 503 });
    expect(await logs.end(window)).toMatchObject({ sufficient: true, retryable: true });
    expect(await logs.healthy()).toBe(true);
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
    await logs.prepare(); new QualificationLogSink(remoteDirectory);
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
