import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QualificationLogSink, SafeLogger } from "../src/logger.ts";

test("rejects runtime nonnumeric fields including nonfinite numbers", () => {
  const logger = new SafeLogger({ write() { throw new Error("must not write"); } });
  for (const value of ["SYNTHETIC-SECRET", null, {}, NaN, Infinity]) {
    expect(() => logger.event("info", "http.listening", { port: value as number })).toThrow("unsafe log field value");
  }
});

test.skipIf(process.platform === "win32")("qualification sink rotates four private bounded files and contains no identifiers", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "safe-logs-"));
  try {
    chmodSync(dir, 0o700);
    const sink = new QualificationLogSink(dir);
    const logger = new SafeLogger(sink);
    for (let i = 0; i < 12_000; i++) logger.event("info", "http.listening", { port: 4317 });
    const files = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
    expect(files).toHaveLength(4);
    for (const name of files) {
      expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(256 * 1024);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, name), "utf8")).not.toContain("SYNTHETIC-SECRET");
    }
    expect(sink.healthy).toBe(true);
    expect(new QualificationLogSink(dir).healthy).toBe(true);
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

test("does not suppress distinct lifecycle information", () => {
  const lines: string[] = [];
  const logger = new SafeLogger({ write: line => lines.push(line) });
  logger.event("info", "http.listening", { port: 4317 });
  logger.event("info", "http.listening", { port: 4318 });
  expect(lines).toHaveLength(2);
});
