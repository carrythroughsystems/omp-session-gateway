import { expect, test } from "bun:test";
import { createBrowserFlakeReport, type BrowserFlakeReport, type BrowserLane } from "./browser-flake-reporter.ts";
import {
  browserReportingEnabled, collectBrowserFlakeRuns, evaluateBrowserFlakeBudget, validateReportSubject, type BrowserBudgetRun,
} from "./browser-flake-budget.ts";
import type { TestCase } from "@playwright/test/reporter";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const now = Date.parse("2026-10-25T20:00:00Z");
function run(id = "123", flaky = 1, total = 100, lane: BrowserLane = "browser-notifications"): BrowserBudgetRun {
  const metadata = { formatVersion: 1 as const, runId: id, runAttempt: 1, sha: "a".repeat(40), lane };
  const cases = Array.from({ length: total }, (_, index) => ({
    location: { file: join(root, "apps/web/e2e/trays.e2e.ts"), line: index + 1, column: 1 },
    parent: { project: () => ({ name: lane === "browser-core" ? "desktop-firefox" : "pixel-10-pro-411x816" }) },
    results: (index < flaky ? ["failed", "passed"] : ["passed"]).map((status, retry) => ({ status, retry, duration: 10 })),
    outcome: () => index < flaky ? "flaky" : "expected",
  })) as unknown as TestCase[];
  return {
    runId: id, runAttempt: 1, sha: metadata.sha, lane, completedAt: new Date(now - 1_000).toISOString(),
    reporterEnabled: true, report: createBrowserFlakeReport(metadata, cases, root),
  };
}

test("one percent is inclusive and retries count once per logical execution, independently per lane/project", () => {
  const allowed = evaluateBrowserFlakeBudget([run()], now);
  expect(allowed.ok).toBe(true);
  expect(allowed.projects[0]).toMatchObject({ executions: 100, flaky: 1 });
  expect(evaluateBrowserFlakeBudget([run("123", 1, 99)], now).ok).toBe(false);
  expect(evaluateBrowserFlakeBudget([run("123", 0, 1_000), run("124", 1, 1, "browser-core")], now).ok).toBe(false);
});

test("a test/project may flake twice, not three times, even when its lane rate remains within budget", () => {
  expect(evaluateBrowserFlakeBudget([run("123"), run("124")], now).ok).toBe(true);
  const exhausted = evaluateBrowserFlakeBudget([run("123"), run("124"), run("125")], now);
  expect(exhausted.ok).toBe(false);
  expect(exhausted.repeated).toHaveLength(1);
  expect(exhausted.repeated[0]).toMatchObject({ count: 3, location: { file: "apps/web/e2e/trays.e2e.ts", line: 1, column: 1 } });
});

test("deduplicates identical run attempts but refuses conflicting duplicates and foreign report bindings", () => {
  const entry = run();
  expect(evaluateBrowserFlakeBudget([entry, structuredClone(entry)], now).projects[0]?.executions).toBe(100);
  const conflicting = run();
  conflicting.report = run("123", 0).report;
  expect(() => evaluateBrowserFlakeBudget([entry, conflicting], now)).toThrow();
  for (const update of [{ runId: "124" }, { runAttempt: 2 }, { sha: "b".repeat(40) }, { lane: "browser-core" }]) {
    expect(() => evaluateBrowserFlakeBudget([{ ...entry, report: { ...(entry.report as BrowserFlakeReport), ...update } }], now)).toThrow();
  }
  const retry = { ...run("123", 0), runAttempt: 2, report: { ...(run("123", 0).report as BrowserFlakeReport), runAttempt: 2 } };
  expect(evaluateBrowserFlakeBudget([entry, retry], now).projects[0]?.executions).toBe(200);
});

test("completed reporter-enabled attempts without reports fail coverage; historical revisions do not", () => {
  const missing = { ...run(), report: undefined };
  const result = evaluateBrowserFlakeBudget([missing], now);
  expect(result.ok).toBe(false);
  expect(result.coverage).toEqual({ expected: 1, reports: 0, missing: 1 });
  expect(evaluateBrowserFlakeBudget([{ ...missing, reporterEnabled: false }], now).ok).toBe(true);
  const old = { ...missing, completedAt: new Date(now - 7 * 86_400_000 - 1).toISOString() };
  expect(evaluateBrowserFlakeBudget([old], now).coverage.expected).toBe(0);
  expect(evaluateBrowserFlakeBudget([{ ...old, completedAt: new Date(now - 7 * 86_400_000).toISOString() }], now).ok).toBe(false);
});

test("malformed artifacts fail closed and skipped cases cannot dilute the denominator", () => {
  const entry = run("123", 1, 100);
  const report = structuredClone(entry.report) as BrowserFlakeReport;
  for (const value of report.tests.slice(1)) {
    value.outcome = "skipped";
    value.attempts = [{ ordinal: 0, status: "skipped", durationMs: 0 }];
  }
  expect(evaluateBrowserFlakeBudget([{ ...entry, report }], now).projects[0]).toMatchObject({ executions: 1, flaky: 1 });
  expect(evaluateBrowserFlakeBudget([{ ...entry, report }], now).ok).toBe(false);
  expect(() => evaluateBrowserFlakeBudget([{ ...entry, report: { ...report, error: "synthetic-private-value" } }], now)).toThrow();
});

test("reporting cohorts follow the job marker at the workflow revision, not run age or branch", () => {
  expect(browserReportingEnabled("jobs:\n  browser-core:\n    steps: []\n", "browser-core")).toBe(false);
  expect(browserReportingEnabled('jobs:\n  browser-core:\n    env:\n      OMP_BROWSER_REPORT_VERSION: "1"\n', "browser-core")).toBe(true);
  expect(() => browserReportingEnabled('jobs:\n  browser-core:\n    env:\n      OMP_BROWSER_REPORT_VERSION: "2"\n', "browser-core")).toThrow();
  expect(() => browserReportingEnabled("not: [valid", "browser-core")).toThrow();
});

test("GitHub subject validation accepts only the metadata head or the exact PR merge's second parent", () => {
  const head = "a".repeat(40);
  const tested = "b".repeat(40);
  const parents = ["c".repeat(40), head];
  expect(validateReportSubject("push", head, head, [])).toBe(true);
  expect(validateReportSubject("workflow_dispatch", head, tested, parents)).toBe(false);
  expect(validateReportSubject("pull_request", head, tested, parents)).toBe(true);
  expect(validateReportSubject("pull_request", head, tested, [head])).toBe(false);
  expect(validateReportSubject("pull_request", head, tested, [...parents].reverse())).toBe(false);
  expect(validateReportSubject("pull_request", head, tested, [...parents, head])).toBe(false);
});

test("collector reads revision cohorts and all completed attempts, even when the latest rerun is in progress", async () => {
  const entry = run("123", 0);
  const head = entry.sha;
  const calls: string[] = [];
  const metadata = { id: 123, run_attempt: 1, status: "completed", head_sha: head, event: "push", path: ".github/workflows/ci.yml", updated_at: entry.completedAt };
  const artifact = { name: "browser-flake-browser-notifications-123-1", workflow_run: { id: 123, head_sha: head } };
  const source = {
    read(endpoint: string): unknown {
      calls.push(endpoint);
      if (endpoint.endsWith("/attempts/1")) return metadata;
      if (endpoint.endsWith("/attempts/2")) return { ...metadata, run_attempt: 2, status: "in_progress" };
      if (endpoint.includes("/contents/")) return { encoding: "base64", content: Buffer.from('jobs:\n  browser-notifications:\n    env:\n      OMP_BROWSER_REPORT_VERSION: "1"\n').toString("base64") };
      throw new Error("unexpected offline endpoint");
    },
    list(endpoint: string): Record<string, unknown>[] {
      if (endpoint.endsWith("/ci.yml/runs")) return [{ ...metadata, run_attempt: 2 }];
      if (endpoint.endsWith("/compatibility.yml/runs")) return [];
      if (endpoint.endsWith("/artifacts")) return [artifact];
      throw new Error("unexpected offline endpoint");
    },
    async report(): Promise<BrowserFlakeReport> { return entry.report as BrowserFlakeReport; },
  };
  const entries = await collectBrowserFlakeRuns("synthetic/repository", now, source);
  expect(entries).toHaveLength(1);
  expect(evaluateBrowserFlakeBudget(entries, now).ok).toBe(true);
  expect(calls.some(endpoint => endpoint.endsWith("/attempts/2"))).toBe(true);
  expect(calls.some(endpoint => endpoint.endsWith(`?ref=${head}`))).toBe(true);
  const missing = await collectBrowserFlakeRuns("synthetic/repository", now, {
    ...source, list: endpoint => endpoint.endsWith("/artifacts") ? [] : source.list(endpoint),
  });
  expect(evaluateBrowserFlakeBudget(missing, now).coverage).toEqual({ expected: 1, reports: 0, missing: 1 });
  await expect(collectBrowserFlakeRuns("synthetic/repository", now, {
    ...source, read: endpoint => { if (endpoint.includes("/contents/")) throw new Error("unreadable revision"); return source.read(endpoint); },
  })).rejects.toThrow("unreadable revision");
  await expect(collectBrowserFlakeRuns("synthetic/repository", now, {
    ...source, report: async () => ({ ...(entry.report as BrowserFlakeReport), sha: "b".repeat(40) }),
  })).rejects.toThrow("invalid browser flake budget evidence");
});
