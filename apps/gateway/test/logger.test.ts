import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QualificationLogSink, SafeLogger } from "../src/logger.ts";

test("rejects runtime nonnumeric fields including nonfinite numbers", () => {
  const logger = new SafeLogger({ write() { throw new Error("must not write"); } });
  for (const value of ["SYNTHETIC-SECRET", null, {}, NaN, Infinity]) {
    expect(() => logger.event("info", "http.listening", { port: value as number })).toThrow("unsafe log field value");
  }
});

test.skipIf(process.platform === "win32")("qualification sink rotates four private bounded files and contains no identifiers", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "safe-logs-"));
  try {
    chmodSync(dir, 0o700);
    const sink = new QualificationLogSink(dir);
    const logger = new SafeLogger(sink);
    for (let i = 0; i < 12_000; i++) logger.event("info", "http.listening", { port: 4317 });
    await Promise.resolve();
    const files = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
    expect(files).toHaveLength(4);
    for (const name of files) {
      expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(256 * 1024);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, name), "utf8")).not.toContain("SYNTHETIC-SECRET");
    }
    expect(sink.healthy).toBe(true);
    sink.close();
    const restarted = new QualificationLogSink(dir);
    expect(restarted.healthy).toBe(true);
    restarted.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("qualification sink refuses unsafe destinations and sticks failed after a write failure", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "unsafe-logs-"));
  try {
    chmodSync(root, 0o755);
    expect(() => new QualificationLogSink(root)).toThrow();
    chmodSync(root, 0o700);
    symlinkSync(root, `${root}-link`);
    expect(() => new QualificationLogSink(`${root}-link`)).toThrow();
    const sink = new QualificationLogSink(root);
    rmSync(join(root, "events.0.jsonl"));
    symlinkSync(join(root, "health"), join(root, "events.0.jsonl"));
    const logger = new SafeLogger(sink);
    expect(() => logger.event("info", "http.listening", { port: 4317 })).toThrow();
    expect(sink.healthy).toBe(false);
    rmSync(join(root, "events.0.jsonl"));
    expect(() => logger.event("info", "http.listening", { port: 4317 })).toThrow();
  } finally { rmSync(`${root}-link`, { force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("coalesces repetitive denial events into a bounded log rate", () => {
  const lines: string[] = [];
  let now = 1_000;
  const logger = new SafeLogger({ write: line => lines.push(line) }, () => now);

  logger.event("warn", "http.authorization_denied");
  logger.event("warn", "http.authorization_denied");
  logger.event("warn", "http.authorization_denied");
  expect(lines).toHaveLength(1);

  now += 60_000;
  logger.event("warn", "http.authorization_denied");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
    level: "warn",
    event: "http.authorization_denied",
    suppressed: 2,
  });
});

test.skipIf(process.platform === "win32")("R1 write-ahead health survives a directory that cannot unlink the old success marker", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "health-state-")); chmodSync(dir, 0o700);
  try {
    const logger = new SafeLogger(new QualificationLogSink(dir));
    logger.event("info", "http.listening", { port: 4317 });
    chmodSync(dir, 0o500);
    expect(() => logger.event("info", "http.listening", { port: 4317 })).toThrow();
    chmodSync(dir, 0o700);
    expect(() => new QualificationLogSink(dir)).toThrow();
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("U1 restart validates every rotated event and all rate-limited IPC events remain safe", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "health-vocabulary-")); chmodSync(dir, 0o700);
  try {
    let now = 0;
    const sink = new QualificationLogSink(dir), logger = new SafeLogger(sink, () => now);
    for (const event of ["ipc.protocol_rejected", "ipc.authentication_denied", "ipc.connection_timeout", "ipc.connection_error"]) {
      logger.event("warn", event); logger.event("warn", event); now += 60_000; logger.event("warn", event);
    }
    await Promise.resolve();
    sink.close();
    const restarted = new QualificationLogSink(dir);
    expect(restarted.healthy).toBe(true);
    restarted.close();
    writeFileSync(join(dir, "events.1.jsonl"), '{"payload":"SYNTHETIC-SECRET"}\n', { mode: 0o600 });
    expect(() => new QualificationLogSink(dir)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("coalesces a synchronous burst behind durable unhealthy state until its commit", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "health-batch-")); chmodSync(dir, 0o700);
  try {
    let sink = new QualificationLogSink(dir), logger = new SafeLogger(sink);
    for (let index = 0; index < 100; index++) logger.event("info", "http.listening", { port: 4317 });
    expect(readFileSync(join(dir, "health"), "utf8")).toBe("!");
    expect(() => new QualificationLogSink(dir)).toThrow();
    await Promise.resolve();
    expect(readFileSync(join(dir, "health"), "utf8")).toBe("[100,1]\n");
    expect(() => new QualificationLogSink(dir)).toThrow("not closed");
    sink.close();
    sink = new QualificationLogSink(dir); logger = new SafeLogger(sink);
    expect(sink.nextIndex).toBe(101);
    logger.event("info", "http.listening", { port: 4317 });
    chmodSync(dir, 0o500);
    expect(() => logger.event("info", "http.listening", { port: 4317 })).toThrow();
    chmodSync(dir, 0o700);
    await Promise.resolve();
    expect(sink.healthy).toBe(false);
    expect(readFileSync(join(dir, "health"), "utf8")).toBe("!");
    expect(() => new QualificationLogSink(dir)).toThrow();
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

test("does not suppress distinct lifecycle information", () => {
  const lines: string[] = [];
  const logger = new SafeLogger({ write: line => lines.push(line) });
  logger.event("info", "http.listening", { port: 4317 });
  logger.event("info", "http.listening", { port: 4318 });
  expect(lines).toHaveLength(2);
});

test.skipIf(process.platform === "win32")("R2 search-permission loss cannot resurrect a committed healthy sink", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "health-search-")); chmodSync(root, 0o700);
  const dir = mkdtempSync(join(root, "logs-")); chmodSync(dir, 0o700);
  try {
    const logger = new SafeLogger(new QualificationLogSink(dir));
    logger.event("info", "http.listening", { port: 4317 }); await Promise.resolve();
    chmodSync(dir, 0);
    expect(() => logger.event("info", "http.listening", { port: 4317 })).toThrow();
    chmodSync(dir, 0o700);
    expect(() => new QualificationLogSink(dir)).toThrow();
  } finally { chmodSync(dir, 0o700); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("495 R1 restart fails closed when every failure-marker write is denied", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "health-no-writes-")); chmodSync(root, 0o700);
  const dir = mkdtempSync(join(root, "logs-")); chmodSync(dir, 0o700);
  try {
    const sink = new QualificationLogSink(dir), logger = new SafeLogger(sink);
    logger.event("info", "http.listening", { port: 4317 }); await Promise.resolve();
    chmodSync(root, 0o500); chmodSync(dir, 0);
    expect(() => logger.event("info", "http.listening", { port: 4317 })).toThrow();
    expect(sink.healthy).toBe(false);
    chmodSync(root, 0o700); chmodSync(dir, 0o700);
    expect(() => sink.close()).toThrow();
    expect(readFileSync(join(dir, "writer"), "utf8")).toBe("active\n");
    expect(() => new QualificationLogSink(dir)).toThrow();
  } finally { chmodSync(root, 0o700); chmodSync(dir, 0o700); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32").each(["missing-first", "truncated-first", "missing-rotated"] as const)(
  "R2 restart refuses lost retained history: %s", async variant => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "health-retention-")); chmodSync(dir, 0o700);
    try {
      const sink = new QualificationLogSink(dir), logger = new SafeLogger(sink);
      for (let index = 0; index < (variant === "missing-rotated" ? 12_000 : 3); index++) logger.event("info", "http.listening", { port: 4317 });
      await Promise.resolve();
      sink.close();
      if (variant === "missing-rotated") rmSync(join(dir, "events.3.jsonl"));
      else {
        const path = join(dir, "events.0.jsonl");
        const lines = readFileSync(path, "utf8").trimEnd().split("\n");
        writeFileSync(path, `${lines.slice(variant === "missing-first" ? 1 : 2).join("\n")}\n`);
      }
      expect(() => new QualificationLogSink(dir)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
