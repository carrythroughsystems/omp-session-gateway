import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}
interface WorkflowJob {
  readonly name?: string;
  readonly needs?: string | string[];
  readonly if?: string;
  readonly permissions: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly steps?: WorkflowStep[];
}
const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/release-request.yml", import.meta.url)).text()) as {
  on: { schedule: { cron: string }[]; workflow_dispatch: { inputs: { omp_version: Record<string, unknown>; release_class: Record<string, unknown> } } };
  permissions: Record<string, string>;
  jobs: Record<"resolve" | "canary" | "recheck" | "file", WorkflowJob>;
};

function runStep(job: "resolve" | "recheck" | "file"): WorkflowStep & { run: string } {
  const step = workflow.jobs[job].steps?.find(step => step.run !== undefined);
  if (step?.run === undefined) throw new Error("missing request workflow script: " + job);
  return step as WorkflowStep & { run: string };
}

interface IssueFixture {
  number: number;
  title: string;
  state: "open" | "closed";
  user: { login: string };
  labels: { name: string }[];
  pull_request?: { url: string };
}
function tracking(number: number, title = "Upstream tracking: v18.9.3", changes: Partial<IssueFixture> = {}): IssueFixture {
  return { number, title, state: "open", user: { login: "github-actions[bot]" }, labels: [], ...changes };
}
interface FixtureOptions {
  event?: "schedule" | "workflow_dispatch";
  version?: unknown;
  lock?: string;
  pages?: IssueFixture[][];
  failIssues?: boolean;
  releaseClass?: string;
}

// Exercise the shipped scripts with an isolated npm/gh transport. Real node and jq execute the
// workflow's version comparison and issue predicates; no network or repository writes are allowed.
async function exerciseStep(job: "resolve" | "recheck" | "file", options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-release-request-"));
  try {
    const bash = Bun.which("bash");
    if (bash === null) throw new Error("missing shell fixture prerequisite: bash");
    for (const command of ["bash", "node", "jq"]) {
      const executable = Bun.which(command);
      if (executable === null) throw new Error("missing shell fixture prerequisite: " + command);
      await symlink(executable, join(root, command));
    }
    await writeFile(join(root, "UPSTREAM.lock.json"), JSON.stringify({ tag: options.lock ?? "v18.9.3" }));
    for (const file of ["output", "summary", "calls"]) await writeFile(join(root, file), "");
    await writeFile(join(root, "gh"), `#!${bash}
set -euo pipefail
printf 'gh %s\\n' "$*" >>"$TEST_CALLS"
case "$1 $2" in
  'api --method')
    if [[ "$TEST_FAIL_ISSUES" == true ]]; then
      printf 'issue listing failed\\n' >&2
      exit 1
    fi
    [[ " $* " == *" --paginate "* && " $* " == *" state=open "* && " $* " == *" per_page=100 "* ]] || exit 92
    filter=
    while (( $# > 0 )); do
      if [[ "$1" == --jq ]]; then filter="$2"; break; fi
      shift
    done
    [[ -n "$filter" ]] || exit 93
    printf '%s\\n' "$TEST_ISSUE_PAGES" | jq -c '.[]' | while IFS= read -r page; do
      printf '%s\\n' "$page" | jq 'map(select(.state == "open"))' | jq -r "$filter"
    done
    ;;
  'label create'|'issue edit') ;;
  'issue create') printf 'https://github.com/example/gateway/issues/999\\n' ;;
  *) exit 91 ;;
esac
`, { mode: 0o700 });
    const child = Bun.spawn(["bash", "-c", `
npm() { printf 'npm %s\\n' "$*" >>"$TEST_CALLS"; printf '%s\\n' "$TEST_NPM_VERSION"; }
${runStep(job).run}
`], {
      cwd: root,
      env: {
        ...process.env,
        PATH: root,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: join(root, "output"),
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "example/gateway",
        GITHUB_RUN_ID: "42",
        REQUEST_EVENT: options.event ?? "schedule",
        REQUEST_ACTOR: "maintainer",
        RELEASE_CLASS: options.releaseClass ?? "patch",
        OMP_INPUT: options.event === "workflow_dispatch" ? "18.10.0" : "latest",
        OMP_VERSION: typeof options.version === "string" ? options.version : "18.10.0",
        LOCK_TAG: options.lock ?? "v18.9.3",
        TEST_CALLS: join(root, "calls"),
        TEST_NPM_VERSION: JSON.stringify(options.version ?? "18.10.0"),
        TEST_ISSUE_PAGES: JSON.stringify(options.pages ?? [[]]),
        TEST_FAIL_ISSUES: String(options.failIssues ?? false),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const [output, summary, calls] = await Promise.all([
      readFile(join(root, "output"), "utf8"),
      readFile(join(root, "summary"), "utf8"),
      readFile(join(root, "calls"), "utf8"),
    ]);
    return { code, stdout, stderr, output, summary, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const shellTest = test.skipIf(process.platform === "win32");

test("weekly scheduling and downstream gates preserve the request identity and privilege boundary", async () => {
  expect(workflow.on.schedule).toEqual([{ cron: "17 15 * * 1" }]);
  expect(workflow.on.workflow_dispatch.inputs.omp_version).toEqual({
    description: "Stock OMP npm version or dist-tag to request", required: true, default: "latest", type: "string",
  });
  expect(workflow.on.workflow_dispatch.inputs.release_class).toEqual({
    description: "Gateway version transition", required: true, default: "patch", type: "choice", options: ["patch", "minor"],
  });
  expect(workflow.permissions).toEqual({});
  expect(workflow.jobs.resolve.permissions).toEqual({ contents: "read", issues: "read" });
  expect(workflow.jobs.resolve.outputs?.should_request).toBe("${{ steps.resolve.outputs.should_request }}");
  expect(runStep("resolve").env?.OMP_INPUT).toBe("${{ github.event_name == 'schedule' && 'latest' || inputs.omp_version }}");
  expect(workflow.jobs.resolve.steps?.[0]?.with).toEqual({
    "persist-credentials": false, "sparse-checkout": "UPSTREAM.lock.json", "sparse-checkout-cone-mode": false,
  });
  expect(workflow.jobs.canary.if).toBe("${{ needs.resolve.outputs.should_request == 'true' }}");
  expect(workflow.jobs.recheck.permissions).toEqual({ issues: "read" });
  expect(workflow.jobs.recheck.needs).toEqual(["resolve", "canary"]);
  expect(workflow.jobs.recheck.if).toBe("${{ needs.resolve.outputs.should_request == 'true' && needs.canary.outputs.passed == 'true' }}");
  expect(workflow.jobs.recheck.outputs?.should_file).toBe("${{ steps.recheck.outputs.should_file }}");
  expect(workflow.jobs.file.name).toBe("Request OMP v${{ needs.resolve.outputs.omp_version }}${{ needs.resolve.outputs.class_suffix }}");
  expect(workflow.jobs.file.needs).toEqual(["resolve", "canary", "recheck"]);
  expect(workflow.jobs.file.if).toBe("${{ needs.resolve.outputs.should_request == 'true' && needs.canary.outputs.passed == 'true' && needs.recheck.outputs.should_file == 'true' }}");
  expect(workflow.jobs.file.permissions).toEqual({ issues: "write" });
  for (const job of [workflow.jobs.recheck, workflow.jobs.file]) {
    expect(job.steps?.some(step => step.uses !== undefined)).toBe(false);
    for (const step of job.steps ?? []) expect(step.run).not.toMatch(/\b(?:bun|npm|node)\b|scripts\//u);
  }
  const canary = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/upstream-canary.yml", import.meta.url)).text()) as {
    jobs: Record<string, { permissions: Record<string, string> }>;
  };
  for (const name of ["canary", "canary-windows"]) expect(canary.jobs[name]?.permissions).toEqual({ contents: "read" });
});

shellTest("scheduled resolution requests one exact latest version when the numeric baseline is older", async () => {
  const result = await exerciseStep("resolve");
  expect(result.code, result.stderr).toBe(0);
  expect(result.output).toBe("omp_version=18.10.0\nlock_tag=v18.9.3\nshould_request=true\nrelease_class=patch\nclass_suffix=\n");
  expect(result.summary).toContain("Request: upstream refresh");
  expect(result.calls).toContain("npm view @oh-my-pi/pi-coding-agent@latest version --json");
  expect(result.calls).toContain("gh api --method GET --paginate");
});

shellTest("scheduled resolution succeeds without a request or issue lookup at or below the lock", async () => {
  for (const version of ["18.9.3", "18.9.2", "17.99.99"]) {
    const result = await exerciseStep("resolve", { version });
    expect(result.code, result.stderr).toBe(0);
    expect(result.output).toContain("should_request=false\n");
    expect(result.summary).toContain(`lock baseline v18.9.3 already equals or exceeds latest v${version}`);
    expect(result.calls).not.toContain("gh ");
  }
});

shellTest("both scheduled guards deny every exact open bot request, including later pages and any version", async () => {
  for (const job of ["resolve", "recheck"] as const) {
    for (const title of ["Upstream tracking: v18.8.3", "Upstream tracking: v18.10.0", "Upstream tracking: v19.0.0", "Upstream tracking: v00.1.1"]) {
      const result = await exerciseStep(job, { pages: [[], [tracking(405, title)]] });
      expect(result.code, result.stderr).toBe(0);
      expect(result.output).toContain(`${job === "resolve" ? "should_request" : "should_file"}=false\n`);
      expect(result.summary).toContain("Scheduled release request skipped: open bot-authored tracking request #405");
      expect(result.calls).not.toMatch(/gh (?:label|issue) /u);
    }
  }
});

shellTest("both scheduled guards ignore closed issues, PRs, human lookalikes and non-exact titles", async () => {
  const pages = [[
    tracking(401, undefined, { state: "closed" }),
    tracking(402, undefined, { user: { login: "maintainer" } }),
    tracking(403, undefined, { pull_request: { url: "https://github.com/example/gateway/pulls/403" } }),
    ...["Upstream tracking: v18.9.3 trailing", "Upstream tracking: v18.9.3-rc.1", "Upstream tracking: v18x9x3", "Upstream OMP canary: v18.9.3"].map((title, index) => tracking(410 + index, title)),
  ]];
  for (const job of ["resolve", "recheck"] as const) {
    const result = await exerciseStep(job, { pages });
    expect(result.code, result.stderr).toBe(0);
    expect(result.output).toContain(`${job === "resolve" ? "should_request" : "should_file"}=true\n`);
    expect(result.summary).not.toContain("skipped");
  }
});

shellTest("manual resolution and the late gate never suppress fixes-only or refresh requests", async () => {
  for (const version of ["18.9.3", "18.10.0"]) {
    const options: FixtureOptions = { event: "workflow_dispatch", version, pages: [[tracking(405)]] };
    const resolved = await exerciseStep("resolve", options);
    expect(resolved.code, resolved.stderr).toBe(0);
    expect(resolved.output).toContain("should_request=true\n");
    expect(resolved.summary).toContain(version === "18.9.3" ? "fixes-only (equal to baseline)" : "upstream refresh");
    expect(resolved.calls).not.toContain("gh ");
    const gate = await exerciseStep("recheck", options);
    expect(gate.code, gate.stderr).toBe(0);
    expect(gate.output).toBe("should_file=true\n");
    expect(gate.calls).toBe("");
  }
});

shellTest("manual requests still refuse a version below the lock", async () => {
  const result = await exerciseStep("resolve", { event: "workflow_dispatch", version: "18.9.2" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Requested v18.9.2 is lower than lock baseline v18.9.3");
  expect(result.output).toBe("");
});

shellTest("resolution retains strict npm and lock validation", async () => {
  for (const version of ["18.10.0-rc.1", ["18.10.0", "18.10.1"]]) {
    const result = await exerciseStep("resolve", { version });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("npm must resolve one strict X.Y.Z release version");
    expect(result.output).toBe("");
  }
  const result = await exerciseStep("resolve", { lock: "18.9.3" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("UPSTREAM.lock.json must name a strict vX.Y.Z baseline");
});

shellTest("issue lookup failure cannot authorize either scheduled gate", async () => {
  for (const job of ["resolve", "recheck"] as const) {
    const result = await exerciseStep(job, { failIssues: true });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("issue listing failed");
    expect(result.output).toBe("");
    expect(result.calls).not.toMatch(/gh (?:label|issue) /u);
  }
});

shellTest("the late gate permits filing when no trusted open request exists", async () => {
  const gate = await exerciseStep("recheck");
  expect(gate.code, gate.stderr).toBe(0);
  expect(gate.output).toBe("should_file=true\n");
  const filed = await exerciseStep("file");
  expect(filed.code, filed.stderr).toBe(0);
  expect(filed.calls).toContain("gh issue create");
  expect(filed.summary).toContain("Tracking issue (created): https://github.com/example/gateway/issues/999");
});

shellTest("manual filing still reuses only the identical request without comments or body edits", async () => {
  for (const labeled of [false, true]) {
    const result = await exerciseStep("file", {
      event: "workflow_dispatch", version: "18.9.3", pages: [[tracking(405, undefined, { labels: labeled ? [{ name: "release-request" }] : [] })]],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.summary).toContain("Tracking issue (reused): https://github.com/example/gateway/issues/405");
    expect(result.calls.includes("gh issue edit 405")).toBe(!labeled);
    expect(result.calls).not.toMatch(/gh issue (?:create|comment)/u);
    expect(result.calls).not.toContain("--body");
  }
  const result = await exerciseStep("file", { event: "workflow_dispatch", pages: [[tracking(405)]] });
  expect(result.code, result.stderr).toBe(0);
  expect(result.calls).toContain("gh issue create");
  expect(result.summary).toContain("Tracking issue (created)");
});

shellTest("manual minor requests carry their class and do not reuse the same OMP patch request", async () => {
  const options: FixtureOptions = { event: "workflow_dispatch", version: "18.9.3", releaseClass: "minor", pages: [[tracking(439)]] };
  const resolved = await exerciseStep("resolve", options);
  expect(resolved.code, resolved.stderr).toBe(0);
  expect(resolved.output).toContain("release_class=minor\nclass_suffix= (minor)\n");
  const filed = await exerciseStep("file", options);
  expect(filed.code, filed.stderr).toBe(0);
  expect(filed.calls).toContain("--label release-request --label release-minor --title Upstream tracking: v18.9.3");
  expect(filed.summary).toContain("Tracking issue (created)");
  const minorIssue = tracking(441, undefined, { labels: [{ name: "release-request" }, { name: "release-minor" }] });
  const repeated = await exerciseStep("file", { ...options, pages: [[tracking(439), minorIssue]] });
  expect(repeated.code, repeated.stderr).toBe(0);
  expect(repeated.summary).toContain("issues/441");
  expect(repeated.calls).not.toContain("gh issue create");
  const patch = await exerciseStep("file", { ...options, releaseClass: "patch", pages: [[minorIssue]] });
  expect(patch.code, patch.stderr).toBe(0);
  expect(patch.summary).toContain("Tracking issue (created)");
});

shellTest("scheduled requests remain patch-only and invalid manual classes refuse before issue writes", async () => {
  const scheduled = await exerciseStep("resolve", { releaseClass: "minor" });
  expect(scheduled.code, scheduled.stderr).toBe(0);
  expect(scheduled.output).toContain("release_class=patch\n");
  for (const job of ["resolve", "file"] as const) {
    const invalid = await exerciseStep(job, { event: "workflow_dispatch", releaseClass: "major" });
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("release class must be patch or minor");
    expect(invalid.calls).not.toMatch(/gh (?:label|issue) /u);
  }
});
