import { expect, test } from "bun:test";
import type { FullConfig, Suite, TestCase } from "@playwright/test/reporter";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  browserFlakeSummary, browserReportMetadata, createBrowserFlakeReport,
  parseBrowserFlakeReport, writeBrowserFlakeReport, type BrowserReportMetadata,
} from "./browser-flake-reporter.ts";
import BrowserFlakeReporter from "./browser-flake-reporter.ts";
import { completeBrowserRun } from "./test-browser.ts";

const root = resolve(import.meta.dir, "..");
const metadata: BrowserReportMetadata = {
  formatVersion: 2, runId: "123", runAttempt: 2, sha: "a".repeat(40), lane: "browser-notifications", dispatchTargetSha: null,
};
const secret = "synthetic-private-reporter-value";
function testcase(statuses: string[], outcome = "expected", line = 12, expectedStatus = "passed"): TestCase {
  return {
    expectedStatus,
    title: secret, id: secret, annotations: [{ type: secret, description: secret }],
    location: { file: join(root, "apps/web/e2e/trays.e2e.ts"), line, column: 3 },
    parent: { project: () => ({ name: "pixel-10-pro-411x816" }) },
    results: statuses.map((status, retry) => ({
      retry, status, duration: 10 + retry, error: { message: secret }, errors: [secret],
      stdout: [secret], stderr: [secret], attachments: [{ name: secret, path: secret, body: Buffer.from(secret) }],
    })),
    outcome: () => outcome,
  } as unknown as TestCase;
}

test("reporter distinguishes clean, flaky, exhausted, skipped and expected failures without copying private surfaces", () => {
  const report = createBrowserFlakeReport(metadata, [
    testcase(["passed"]), testcase(["failed", "passed"], "flaky"),
    testcase(["failed", "failed"], "unexpected"), testcase(["skipped"], "skipped"),
    testcase(["failed"], "expected", 12, "failed"),
  ], root);
  expect(report.tests.map(value => value.outcome)).toEqual(["expected", "flaky", "unexpected", "skipped", "expected"]);
  expect(report.tests[1]?.attempts).toEqual([
    { ordinal: 0, status: "failed", durationMs: 10 }, { ordinal: 1, status: "passed", durationMs: 11 },
  ]);
  expect(new Set(report.tests.map(value => value.identity)).size).toBe(5);
  expect(createBrowserFlakeReport(metadata, [testcase(["passed"])], root).tests[0]?.identity).toBe(report.tests[0]?.identity);
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(JSON.stringify(report)).not.toContain(root);
  expect(parseBrowserFlakeReport(report)).toEqual(report);
  expect(browserFlakeSummary(report)).toContain("executions=4 flaky=1 unexpected=1 skipped=1");
  expect(browserFlakeSummary(report)).toContain("apps/web/e2e/trays.e2e.ts:12:3");
  expect(browserFlakeSummary(report)).not.toContain(secret);
});

test("closed report schema refuses unknown fields, invalid locations, identities, ordinals and nonfinite durations", () => {
  const report = createBrowserFlakeReport(metadata, [testcase(["passed"])], root);
  const changed = (update: Record<string, unknown>): unknown => ({ ...report, tests: [{ ...report.tests[0], ...update }] });
  const attempt = (update: Record<string, unknown>): unknown => changed({ attempts: [{ ...report.tests[0]?.attempts[0], ...update }] });
  for (const value of [
    { ...report, errors: [secret] },
    changed({ stdout: [secret] }),
    changed({ location: { file: "../private.e2e.ts", line: 1, column: 1 } }),
    changed({ location: { file: "apps/web/e2e/https://private.e2e.ts", line: 1, column: 1 } }),
    changed({ identity: "b".repeat(64) }),
    attempt({ ordinal: 1 }),
    attempt({ durationMs: Infinity }),
    changed({ outcome: "flaky" }),
    changed({ project: secret }),
    { ...report, runId: "not-a-run" }, { ...report, runAttempt: 0 }, { ...report, sha: secret },
  ]) expect(() => parseBrowserFlakeReport(value)).toThrow("invalid browser flake report");
  expect(() => createBrowserFlakeReport(metadata, [
    { ...testcase(["passed"]), location: { file: join(root, "private.ts"), line: 1, column: 1 } } as TestCase,
  ], root)).toThrow("invalid browser flake report");
});

test("attempt evidence, not the supplied outcome label, determines flaky accounting", () => {
  const report = createBrowserFlakeReport(metadata, [testcase(["failed", "passed"], "flaky")], root);
  for (const outcome of ["expected", "unexpected", "skipped"]) {
    expect(() => parseBrowserFlakeReport({ ...report, tests: [{ ...report.tests[0], outcome }] })).toThrow();
  }
});

test("empty and all-unexecuted reports cannot satisfy evidence coverage; interrupted outcomes follow Playwright", () => {
  const report = createBrowserFlakeReport(metadata, [testcase(["passed"])], root);
  expect(() => parseBrowserFlakeReport({ ...report, tests: [] })).toThrow();
  expect(() => createBrowserFlakeReport(metadata, [testcase(["skipped"], "skipped")], root)).toThrow();
  const interrupted = createBrowserFlakeReport(metadata, [testcase(["interrupted"], "skipped")], root);
  expect(interrupted.tests[0]?.outcome).toBe("skipped");
  expect(interrupted.tests[0]?.attempts[0]?.status).toBe("interrupted");
});

test("CI metadata is required only for true or 1 and must bind a valid run and sha", () => {
  for (const CI of ["true", "1"]) {
    expect(() => browserReportMetadata({ CI }, "browser-core")).toThrow();
    expect(browserReportMetadata({ CI, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", OMP_BROWSER_TEST_SHA: metadata.sha }, "browser-core")).toEqual({ ...metadata, lane: "browser-core" });
  }
  for (const CI of [undefined, "false", "0", "TRUE", ""]) {
    const env = CI === undefined ? {} : { CI };
    expect(browserReportMetadata(env, "browser-core").runId).toBe("0");
  }
});

test("report persistence is sanitized and runner preserves failure exits but fails closed for required missing reporting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-flake-report-"));
  const path = join(directory, "browser-flake-report.json");
  const summary = join(directory, "summary.md");
  const report = createBrowserFlakeReport(metadata, [testcase(["failed", "passed"], "flaky")], root);
  try {
    await writeBrowserFlakeReport(path, report);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(report);
    expect(await completeBrowserRun(0, path, metadata, true, summary)).toBe(0);
    expect(await readFile(summary, "utf8")).toContain("flaky=1");
    await rm(path);
    expect(await completeBrowserRun(0, path, metadata, true)).toBe(1);
    expect(await completeBrowserRun(23, path, metadata, true)).toBe(23);
    expect(await completeBrowserRun(0, path, metadata, false)).toBe(0);
    await writeFile(path, JSON.stringify({ ...report, sha: "b".repeat(40) }));
    expect(await completeBrowserRun(0, path, metadata, true)).toBe(1);
    await writeBrowserFlakeReport(path, report);
    expect(await completeBrowserRun(0, path, metadata, true, directory)).toBe(1);
    await expect(writeBrowserFlakeReport(join(path, "child"), report)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Playwright lifecycle writes failed/flaky evidence and makes reporter write failures terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-flake-lifecycle-"));
  const path = join(directory, "report.json");
  const updates = { CI: "true", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", OMP_BROWSER_TEST_SHA: metadata.sha, OMP_BROWSER_FLAKE_REPORT: path };
  const before = Object.fromEntries(Object.keys(updates).map(key => [key, process.env[key]]));
  Object.assign(process.env, updates);
  try {
    const reporter = new BrowserFlakeReporter({ lane: "browser-notifications" });
    // These in-process fakes expose exactly the pinned reporter callback surface under test.
    reporter.onBegin({} as FullConfig, { allTests: () => [testcase(["failed", "passed"], "flaky")] } as Suite);
    expect(await reporter.onEnd({ status: "failed", startTime: new Date(), duration: 21 })).toBeUndefined();
    expect(parseBrowserFlakeReport(JSON.parse(await readFile(path, "utf8"))).tests[0]?.outcome).toBe("flaky");
    process.env.OMP_BROWSER_FLAKE_REPORT = directory;
    expect(await reporter.onEnd({ status: "passed", startTime: new Date(), duration: 21 })).toEqual({ status: "failed" });
    process.env.CI = "false";
    expect(await reporter.onEnd({ status: "passed", startTime: new Date(), duration: 21 })).toBeUndefined();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}.tmp`, { force: true });
  }
});

test("both nonvisual configurations retry only true/1 CI and disable automatic secret-bearing captures", async () => {
  // A fresh module-loading boundary per environment is required; a static import caches CI values.
  // Load all twelve independently; cold Playwright imports get the portable lane's 30 s bound.
  await Promise.all(["apps/web/playwright.config.ts", "apps/web/playwright.compat.config.ts"].flatMap(file =>
    ["true", "1", "false", "0", "TRUE", ""].map(async CI => {
      const child = Bun.spawn([process.execPath, "-e", `const {default:c}=await import(${JSON.stringify(join(root, file))});console.log(JSON.stringify({retries:c.retries,workers:c.workers,projects:c.projects.map(p=>p.name),use:c.use,reporter:c.reporter}));`], { env: { ...process.env, CI, PLAYWRIGHT_WORKERS: "2" }, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      const config = JSON.parse(stdout);
      expect(config.retries).toBe(CI === "true" || CI === "1" ? 1 : 0);
      expect(config.workers).toBe(file.includes("compat") ? 1 : 2);
      for (const key of ["trace", "video", "screenshot"]) expect(config.use[key]).toBe("off");
      expect(config.reporter[0]).toEqual(["line"]);
      expect(config.reporter[1][0]).toBe(join(root, "scripts/browser-flake-reporter.ts"));
      if (file.includes("compat")) expect(config.projects).toEqual(["desktop-chromium", "desktop-firefox", "desktop-webkit", "iphone-webkit"]);
    }),
  ));
}, 30_000);
