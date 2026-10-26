import type { FullConfig, FullResult, Reporter, Suite, TestCase } from "@playwright/test/reporter";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_REPORT_PATH = "test-results/browser-flakes/browser-flake-report.json";
export const BROWSER_PROJECTS = {
  "browser-notifications": ["pixel-10-pro-411x816", "synthetic-narrow-390x844"],
  "browser-core": ["desktop-chromium", "desktop-firefox", "desktop-webkit", "iphone-webkit"],
} as const;
export type BrowserLane = keyof typeof BROWSER_PROJECTS;
export type BrowserProject = typeof BROWSER_PROJECTS[BrowserLane][number];
export interface BrowserReportMetadata {
  formatVersion: 1;
  runId: string;
  runAttempt: number;
  /** Exact checkout tested, including GitHub's PR merge commit when applicable. */
  sha: string;
  lane: BrowserLane;
}
export interface BrowserTestLocation { file: string; line: number; column: number }
export interface BrowserTestExecution {
  project: BrowserProject;
  location: BrowserTestLocation;
  identity: string;
  attempts: { ordinal: number; status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted"; durationMs: number }[];
  outcome: "expected" | "unexpected" | "flaky" | "skipped";
}
export interface BrowserFlakeReport extends BrowserReportMetadata { tests: BrowserTestExecution[] }
const root = fileURLToPath(new URL("../", import.meta.url));
export const isBrowserCI = (value: string | undefined): boolean => value === "true" || value === "1";
export const isCommitSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
function invalid(): never { throw new Error("invalid browser flake report"); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}

export function browserReportMetadata(env: NodeJS.ProcessEnv, lane: BrowserLane): BrowserReportMetadata {
  const ci = isBrowserCI(env.CI);
  const runId = env.GITHUB_RUN_ID ?? (ci ? "" : "0");
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT ?? (ci ? "" : "1"));
  const sha = env.OMP_BROWSER_TEST_SHA ?? (ci ? "" : "0".repeat(40));
  if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(runId) || (ci && runId === "0") || !integer(runAttempt, 1) || !isCommitSha(sha)) invalid();
  return { formatVersion: 1, runId, runAttempt, sha, lane };
}

function identity(project: string, location: BrowserTestLocation, occurrence: number): string {
  // Location alone is not unique for parameterized test declarations. Suite order supplies a
  // deterministic occurrence, without ever hashing a title, fixture value or Playwright test ID.
  return createHash("sha256").update(`${project}\0${location.file}:${location.line}:${location.column}\0${occurrence}`).digest("hex");
}
function occurrenceKey(project: string, location: BrowserTestLocation): string {
  return `${project}\0${location.file}:${location.line}:${location.column}`;
}

/** Validate exact keys before a report can become an artifact, summary, or budget input. */
export function parseBrowserFlakeReport(value: unknown): BrowserFlakeReport {
  const report = object(value, ["formatVersion", "runId", "runAttempt", "sha", "lane", "tests"]);
  if (report.formatVersion !== 1 || typeof report.runId !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/u.test(report.runId) ||
    !integer(report.runAttempt, 1) || !isCommitSha(report.sha) ||
    (report.lane !== "browser-core" && report.lane !== "browser-notifications") ||
    !Array.isArray(report.tests) || report.tests.length > 20_000) invalid();
  const occurrences = new Map<string, number>();
  const tests: BrowserTestExecution[] = report.tests.map((input: unknown) => {
    const test = object(input, ["project", "location", "identity", "attempts", "outcome"]);
    if (typeof test.project !== "string" || !(BROWSER_PROJECTS[report.lane as BrowserLane] as readonly string[]).includes(test.project)) invalid();
    const location = object(test.location, ["file", "line", "column"]);
    if (typeof location.file !== "string" || location.file.length > 240 ||
      !/^apps\/web\/e2e\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.e2e\.ts$/u.test(location.file) ||
      !integer(location.line, 1) || !integer(location.column, 1)) invalid();
    const safeLocation = { file: location.file, line: location.line, column: location.column };
    const key = occurrenceKey(test.project, safeLocation);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    if (test.identity !== identity(test.project, safeLocation, occurrence) || !Array.isArray(test.attempts) || test.attempts.length > 2 ||
      typeof test.outcome !== "string" || !["expected", "unexpected", "flaky", "skipped"].includes(test.outcome)) invalid();
    const attempts = test.attempts.map((input: unknown, ordinal: number) => {
      const attempt = object(input, ["ordinal", "status", "durationMs"]);
      if (attempt.ordinal !== ordinal || typeof attempt.status !== "string" || !["passed", "failed", "timedOut", "skipped", "interrupted"].includes(attempt.status) ||
        !integer(attempt.durationMs)) invalid();
      return { ordinal, status: attempt.status as BrowserTestExecution["attempts"][number]["status"], durationMs: attempt.durationMs };
    });
    if (test.outcome === "flaky" && (attempts.length !== 2 || attempts[0]?.status === attempts[1]?.status)) invalid();
    if (test.outcome === "skipped" && attempts.some(attempt => attempt.status !== "skipped")) invalid();
    if (test.outcome !== "skipped" && (attempts.length === 0 || attempts.every(attempt => attempt.status === "skipped"))) invalid();
    return {
      project: test.project as BrowserProject, location: safeLocation, identity: test.identity,
      attempts, outcome: test.outcome as BrowserTestExecution["outcome"],
    };
  });
  return { formatVersion: 1, runId: report.runId, runAttempt: report.runAttempt, sha: report.sha, lane: report.lane, tests };
}

export function createBrowserFlakeReport(metadata: BrowserReportMetadata, tests: readonly TestCase[], repositoryRoot = root): BrowserFlakeReport {
  const occurrences = new Map<string, number>();
  return parseBrowserFlakeReport({
    ...metadata,
    tests: tests.map(test => {
      const project = test.parent.project()?.name ?? "";
      const location = { file: relative(repositoryRoot, test.location.file).split(sep).join("/"), line: test.location.line, column: test.location.column };
      const key = occurrenceKey(project, location);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      return {
        project, location, identity: identity(project, location, occurrence),
        attempts: test.results.map(result => ({ ordinal: result.retry, status: result.status, durationMs: result.duration })),
        outcome: test.outcome(),
      };
    }),
  });
}

export async function writeBrowserFlakeReport(path: string, report: BrowserFlakeReport): Promise<void> {
  const text = JSON.stringify(parseBrowserFlakeReport(report)) + "\n";
  if (Buffer.byteLength(text) > 8 * 1_024 * 1_024) invalid();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

export function browserFlakeSummary(input: BrowserFlakeReport): string {
  const report = parseBrowserFlakeReport(input);
  const lines = [`## Browser flakes: ${report.lane}`, ""];
  for (const project of BROWSER_PROJECTS[report.lane]) {
    const tests = report.tests.filter(test => test.project === project);
    const count = (outcome: BrowserTestExecution["outcome"]): number => tests.filter(test => test.outcome === outcome).length;
    lines.push(`- ${project}: executions=${tests.length - count("skipped")} flaky=${count("flaky")} unexpected=${count("unexpected")} skipped=${count("skipped")}`);
    for (const test of tests.filter(test => test.outcome === "flaky" || test.outcome === "unexpected")) {
      lines.push(`  - ${test.outcome}: ${test.location.file}:${test.location.line}:${test.location.column}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** No titles, errors, output, attachments, source, URLs or fixture-controlled values are copied. */
export default class BrowserFlakeReporter implements Reporter {
  private tests: TestCase[] = [];
  constructor(private readonly options: { lane: BrowserLane }) {}
  onBegin(_config: FullConfig, suite: Suite): void { this.tests = suite.allTests(); }
  async onEnd(_result: FullResult): Promise<{ status: "failed" } | void> {
    try {
      const lane = this.options.lane;
      if (lane !== "browser-core" && lane !== "browser-notifications") invalid();
      const metadata = browserReportMetadata(process.env, lane);
      await writeBrowserFlakeReport(resolve(root, process.env.OMP_BROWSER_FLAKE_REPORT ?? BROWSER_REPORT_PATH), createBrowserFlakeReport(metadata, this.tests));
    } catch {
      // Playwright swallows reporter exceptions. The wrapper also validates the required file.
      process.stderr.write("browser flake reporting failed; details withheld\n");
      return { status: "failed" };
    }
  }
  printsToStdio(): boolean { return false; }
}
