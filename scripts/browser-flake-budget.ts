import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_REPORT_VERSION, isCommitSha, parseBrowserFlakeReport, wasBrowserTestExecuted, type BrowserFlakeReport, type BrowserLane,
  type BrowserProject, type BrowserTestLocation,
} from "./browser-flake-reporter.ts";

const WINDOW_MS = 7 * 86_400_000;
const MAX_BYTES = 8 * 1_024 * 1_024;
export interface BrowserBudgetRun {
  runId: string;
  runAttempt: number;
  /** Tested subject, independently validated against the GitHub run before aggregation. */
  sha: string;
  dispatchTargetSha: string | null;
  lane: BrowserLane;
  completedAt: string;
  reporterEnabled: boolean;
  report?: unknown;
}
interface ProjectBudget { lane: BrowserLane; project: BrowserProject; executions: number; flaky: number }
interface RepeatedFlake { lane: BrowserLane; project: BrowserProject; location: BrowserTestLocation; count: number }
export interface BrowserFlakeBudget {
  ok: boolean;
  coverage: { expected: number; reports: number; missing: number };
  projects: ProjectBudget[];
  repeated: RepeatedFlake[];
}
function invalid(): never { throw new Error("invalid browser flake budget evidence"); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid();
  return Date.parse(value);
}
function completedEvidence(status: unknown, conclusion: unknown): boolean {
  if (["queued", "in_progress", "waiting", "pending", "requested"].includes(String(status))) return false;
  if (status !== "completed") invalid();
  if (conclusion === null || ["cancelled", "skipped", "neutral", "action_required", "stale", "startup_failure"].includes(String(conclusion))) return false;
  if (!["success", "failure", "timed_out"].includes(String(conclusion))) invalid();
  return true;
}

/** A workflow revision, not an arbitrary rollout date, defines reporting coverage. */
export function browserReportingEnabled(source: string, lane: BrowserLane): boolean {
  const workflow = record(Bun.YAML.parse(source));
  const jobs = record(workflow.jobs);
  const job = jobs[lane];
  if (job === undefined) return false;
  const env = record(job).env;
  if (env === undefined) return false;
  const version = record(env).OMP_BROWSER_REPORT_VERSION;
  if (version === undefined) return false;
  // Format 1 predates independently derived outcome and exact-attempt coverage evidence.
  if (version === "1") return false;
  if (version !== String(BROWSER_REPORT_VERSION)) invalid();
  return true;
}

const FLEET_CONDITION = "${{ github.event_name == 'workflow_dispatch' && inputs.runner == 'gateway-ci' && startsWith(inputs.routing_label, 'gateway-ci-linux-x64-') && inputs.target_sha != '' }}";
const FLEET_CHECKOUT = "${{ github.event_name == 'workflow_dispatch' && inputs.runner == 'gateway-ci' && startsWith(inputs.routing_label, 'gateway-ci-linux-x64-') && inputs.target_sha != '' && inputs.target_sha || github.sha }}";
const FLEET_TARGET = "${{ github.event_name == 'workflow_dispatch' && inputs.runner == 'gateway-ci' && startsWith(inputs.routing_label, 'gateway-ci-linux-x64-') && inputs.target_sha != '' && inputs.target_sha || '' }}";

/** The workflow revision, not a report's claim, must enforce a fleet input and verify checkout. */
export function browserFleetDispatchEnforced(source: string, lane: BrowserLane): boolean {
  if (lane !== "browser-notifications") return false;
  const job = record(record(record(Bun.YAML.parse(source)).jobs)[lane]);
  if (!Array.isArray(job.steps) || record(job.env).OMP_BROWSER_DISPATCH_TARGET_SHA !== FLEET_TARGET) return false;
  const steps = job.steps.map(record);
  const validate = steps.filter(step => step.name === "Validate bounded gateway dispatch");
  const verify = steps.filter(step => step.name === "Verify exact dispatch target");
  const checkout = steps.filter(step => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));
  const execute = steps.findIndex(step => step.run === "bun run test:browser");
  if (validate.length !== 1 || verify.length !== 1 || checkout.length !== 1 || execute < 0) return false;
  const validation = validate[0]!;
  const verification = verify[0]!;
  if (validation.if !== FLEET_CONDITION || verification.if !== FLEET_CONDITION ||
    record(checkout[0]!.with).ref !== FLEET_CHECKOUT ||
    record(validation.env).TARGET_SHA !== "${{ inputs.target_sha }}" ||
    record(verification.env).TARGET_SHA !== "${{ inputs.target_sha }}" ||
    verification.run !== 'test "$(git rev-parse HEAD)" = "$TARGET_SHA"' || typeof validation.run !== "string") return false;
  const predicates = [
    '[[ "$ROUTING_LABEL" =~ ^gateway-ci-linux-x64-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || fail routing_label',
    '[[ "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]] || fail target_sha',
    '[[ "$RUNNER_NAME" =~ ^gateway-ci-(nyc|sf)-[1-3]$ ]] || fail runner_name',
    '[[ ! -S /var/run/docker.sock ]] || fail docker_socket',
  ];
  const validationRun = validation.run;
  return predicates.every(predicate => validationRun.includes(predicate)) &&
    steps.indexOf(validation) < steps.indexOf(checkout[0]!) && steps.indexOf(checkout[0]!) < steps.indexOf(verification) && steps.indexOf(verification) < execute;
}

export function validateReportSubject(
  event: string, head: string, tested: string, parents: readonly string[],
  dispatch: { targetSha: string | null; verified: boolean } = { targetSha: null, verified: false },
): boolean {
  if (!isCommitSha(head) || !isCommitSha(tested)) return false;
  if (dispatch.targetSha !== null) return event === "workflow_dispatch" && dispatch.verified && isCommitSha(dispatch.targetSha) && tested === dispatch.targetSha;
  if (head === tested) return true;
  // Actions' head_sha is the PR source head; checkout github.sha tests its temporary merge.
  return event === "pull_request" && parents.length === 2 && parents.every(isCommitSha) && parents[1] === head;
}

export function evaluateBrowserFlakeBudget(runs: readonly BrowserBudgetRun[], now = Date.now()): BrowserFlakeBudget {
  if (!Number.isFinite(now)) invalid();
  const coverage = { expected: 0, reports: 0, missing: 0 };
  const projects = new Map<string, ProjectBudget>();
  const flakes = new Map<string, RepeatedFlake>();
  const seen = new Map<string, string>();
  for (const run of runs) {
    const completed = timestamp(run.completedAt);
    if (completed < now - WINDOW_MS || completed > now || !run.reporterEnabled) continue;
    if (!/^[1-9][0-9]{0,19}$/u.test(run.runId) || !Number.isSafeInteger(run.runAttempt) || run.runAttempt < 1 || !isCommitSha(run.sha) ||
      (run.lane !== "browser-core" && run.lane !== "browser-notifications")) invalid();
    const key = `${run.runId}:${run.runAttempt}:${run.lane}`;
    const serialized = JSON.stringify(run);
    const previous = seen.get(key);
    if (previous !== undefined) {
      if (previous !== serialized) invalid();
      continue;
    }
    seen.set(key, serialized);
    coverage.expected++;
    if (run.report === undefined) { coverage.missing++; continue; }
    const report = parseBrowserFlakeReport(run.report);
    if (report.runId !== run.runId || report.runAttempt !== run.runAttempt || report.sha !== run.sha || report.lane !== run.lane ||
      report.dispatchTargetSha !== run.dispatchTargetSha) invalid();
    coverage.reports++;
    for (const test of report.tests) {
      const projectKey = `${report.lane}:${test.project}`;
      let budget = projects.get(projectKey);
      if (budget === undefined) {
        budget = { lane: report.lane, project: test.project, executions: 0, flaky: 0 };
        projects.set(projectKey, budget);
      }
      if (!wasBrowserTestExecuted(test)) continue;
      budget.executions++;
      if (test.outcome !== "flaky") continue;
      budget.flaky++;
      const testKey = `${projectKey}:${test.identity}`;
      const flake = flakes.get(testKey) ?? { lane: report.lane, project: test.project, location: test.location, count: 0 };
      flake.count++;
      flakes.set(testKey, flake);
    }
  }
  const repeated = [...flakes.values()].filter(flake => flake.count > 2);
  const values = [...projects.values()].sort((left, right) => `${left.lane}:${left.project}`.localeCompare(`${right.lane}:${right.project}`));
  return { ok: coverage.missing === 0 && repeated.length === 0 && values.every(project => project.flaky * 100 <= project.executions), coverage, projects: values, repeated };
}

/** All GitHub responses remain private memory; command failures never repeat stderr or argv. */
function githubBytes(endpoint: string): Buffer {
  try {
    return execFileSync("gh", ["api", endpoint], {
      encoding: "buffer", maxBuffer: MAX_BYTES, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { throw new Error("browser flake budget GitHub read failed; details withheld"); }
}
function github(endpoint: string): unknown { return JSON.parse(githubBytes(endpoint).toString("utf8")); }
function collection(endpoint: string, key: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const values = record(github(`${endpoint}?per_page=100&page=${page}`))[key];
    if (!Array.isArray(values)) invalid();
    entries.push(...values.map(record));
    if (values.length < 100) return entries;
  }
}

async function artifactReport(repository: string, artifact: Record<string, unknown>): Promise<BrowserFlakeReport> {
  const size = positive(artifact.size_in_bytes);
  if (size > MAX_BYTES || artifact.expired !== false) invalid();
  const id = positive(artifact.id);
  const directory = await mkdtemp(join(tmpdir(), "gateway-flake-budget-"));
  try {
    const archive = join(directory, "report.zip");
    await writeFile(archive, githubBytes(`repos/${repository}/actions/artifacts/${id}/zip`), { mode: 0o600 });
    const options = { encoding: "utf8" as const, maxBuffer: MAX_BYTES, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
    const names = execFileSync("unzip", ["-Z1", archive], options).trim().split("\n");
    if (names.length !== 1 || names[0] !== "browser-flake-report.json") invalid();
    return parseBrowserFlakeReport(JSON.parse(execFileSync("unzip", ["-p", archive, names[0]], options)));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Include every completed attempt (including earlier attempts of an in-progress rerun). */
export async function collectBrowserFlakeRuns(
  repository: string, now = Date.now(),
  source = { read: github, list: collection, report: artifactReport },
): Promise<BrowserBudgetRun[]> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) invalid();
  const entries: BrowserBudgetRun[] = [];
  const revisions = new Map<string, { enabled: boolean; fleetEnforced: boolean }>();
  for (const [workflow, lane] of [["ci.yml", "browser-notifications"], ["compatibility.yml", "browser-core"]] as const) {
    // No created-at filter: an older run may have been rerun during the current seven-day window.
    const runs = source.list(`repos/${repository}/actions/workflows/${workflow}/runs`, "workflow_runs");
    for (const latest of runs) {
      if (timestamp(latest.updated_at) < now - WINDOW_MS) continue;
      const id = positive(latest.id);
      const count = positive(latest.run_attempt);
      if (count > 100) invalid();
      let artifacts: Record<string, unknown>[] | undefined;
      for (let attempt = 1; attempt <= count; attempt++) {
        const run = record(source.read(`repos/${repository}/actions/runs/${id}/attempts/${attempt}`));
        if (run.id !== id || run.run_attempt !== attempt) invalid();
        // Cancelled/incomplete attempts are not completed browser evidence, even if superseded
        // workflows retain earlier artifacts. Selective reruns are inspected job by job below.
        if (!completedEvidence(run.status, run.conclusion)) continue;
        const completed = timestamp(run.updated_at);
        if (completed < now - WINDOW_MS || completed > now) continue;
        const head = run.head_sha;
        if (!isCommitSha(head) || typeof run.event !== "string" || typeof run.path !== "string" || run.path.split("@")[0] !== `.github/workflows/${workflow}`) invalid();
        const revisionKey = `${workflow}:${head}`;
        let revision = revisions.get(revisionKey);
        if (revision === undefined) {
          // Missing/unreadable revision is an evidence error, never a pre-reporting assumption.
          const content = record(source.read(`repos/${repository}/contents/.github/workflows/${workflow}?ref=${head}`));
          if (content.encoding !== "base64" || typeof content.content !== "string") invalid();
          const workflowSource = Buffer.from(content.content, "base64").toString("utf8");
          const enabled = browserReportingEnabled(workflowSource, lane);
          revision = { enabled, fleetEnforced: enabled && lane === "browser-notifications" && browserFleetDispatchEnforced(workflowSource, lane) };
          revisions.set(revisionKey, revision);
        }
        if (!revision.enabled) continue;
        const jobs = source.list(`repos/${repository}/actions/runs/${id}/attempts/${attempt}/jobs`, "jobs");
        const browserJobs = jobs.filter(job => job.name === lane);
        for (const job of browserJobs) {
          if (job.run_id !== id || positive(job.run_attempt) > attempt) invalid();
        }
        const candidates = browserJobs.filter(job => job.run_attempt === attempt);
        if (candidates.length > 1) invalid();
        const job = candidates[0];
        if (job === undefined) continue; // A selective rerun of sibling jobs owes no new report.
        if (!completedEvidence(job.status, job.conclusion)) continue;
        timestamp(job.started_at);
        const jobCompleted = timestamp(job.completed_at);
        if (jobCompleted < now - WINDOW_MS || jobCompleted > now) continue;
        artifacts ??= source.list(`repos/${repository}/actions/runs/${id}/artifacts`, "artifacts");
        const matches = artifacts.filter(artifact => artifact.name === `browser-flake-${lane}-${id}-${attempt}`);
        if (matches.length > 1) invalid();
        const artifact = matches[0];
        let report: BrowserFlakeReport | undefined;
        if (artifact !== undefined) {
          const binding = record(artifact.workflow_run);
          if (binding.id !== id || binding.head_sha !== head) invalid();
          report = await source.report(repository, artifact);
          let parents: string[] = [];
          if (report.sha !== head && run.event === "pull_request") {
            const commit = record(source.read(`repos/${repository}/commits/${report.sha}`));
            if (commit.sha !== report.sha || !Array.isArray(commit.parents)) invalid();
            parents = commit.parents.map(parent => {
              const sha = record(parent).sha;
              if (!isCommitSha(sha)) invalid();
              return sha;
            });
          }
          const steps = Array.isArray(job.steps) ? job.steps.map(record) : [];
          const fleetVerified = revision.fleetEnforced && ["Validate bounded gateway dispatch", "Verify exact dispatch target"].every(name => {
            const matches = steps.filter(step => step.name === name);
            return matches.length === 1 && matches[0]?.status === "completed" && matches[0]?.conclusion === "success";
          });
          if (!validateReportSubject(run.event, head, report.sha, parents, { targetSha: report.dispatchTargetSha, verified: fleetVerified })) invalid();
        }
        entries.push({ runId: String(id), runAttempt: attempt, sha: report?.sha ?? head, dispatchTargetSha: report?.dispatchTargetSha ?? null, lane, completedAt: new Date(jobCompleted).toISOString(), reporterEnabled: true, report });
      }
    }
  }
  return entries;
}

function budgetSummary(result: BrowserFlakeBudget): string {
  const lines = ["## Browser flake budget (preceding 7 days)", "", `Coverage: expected=${result.coverage.expected} reports=${result.coverage.reports} missing=${result.coverage.missing}`, "Limits: flaky executions <=1% per lane/project; each test/project flaky <=2 times."];
  for (const project of result.projects) lines.push(`- ${project.lane}/${project.project}: executions=${project.executions} flaky=${project.flaky}`);
  for (const test of result.repeated) lines.push(`- repeated=${test.count}: ${test.lane}/${test.project} ${test.location.file}:${test.location.line}:${test.location.column}`);
  lines.push(`Outcome: ${result.ok ? "passed" : "failed"}`);
  return lines.join("\n") + "\n";
}
if (import.meta.main) {
  try {
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const now = Date.now();
    const result = evaluateBrowserFlakeBudget(await collectBrowserFlakeRuns(repository, now), now);
    const summary = budgetSummary(result);
    process.stdout.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    const summary = "Browser flake budget failed: missing or invalid GitHub/report evidence; details withheld.\n";
    process.stderr.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    process.exitCode = 1;
  }
}
