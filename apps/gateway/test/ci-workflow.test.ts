import { expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageManifest from "../../../package.json";
import { checkWorkflowMergeQueue } from "../../../scripts/check-repository.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const workflowPath = join(import.meta.dir, "../../../.github/workflows/ci.yml");
const validEnvironment = {
  ROUTING_LABEL: "gateway-ci-linux-x64-12345678-1234-1234-1234-123456789abc",
  TARGET_SHA: "a".repeat(40),
  RUNNER_NAME: "gateway-ci-nyc-2",
};

test("all seven required checks run on merge groups without a pull request payload", async () => {
  const requiredJobs = {
    "ci.yml": ["implementation-checks", "browser-notifications"],
    "compatibility.yml": ["portable-source", "browser-core"],
    "platform-qualification.yml": ["windows-service-lifecycle"],
  };
  let checks = 0;
  for (const [file, names] of Object.entries(requiredJobs)) {
    const workflow = Bun.YAML.parse(await readFile(join(import.meta.dir, "../../../.github/workflows", file), "utf8")) as {
      on: Record<string, unknown>;
      jobs: Record<string, {
        if?: string;
        strategy?: { matrix?: { os?: string[] } };
        steps: VisualWorkflowStep[];
      }>;
    };
    expect(workflow.on.merge_group).toEqual({ types: ["checks_requested"] });
    expect(Object.hasOwn(workflow.on, "pull_request")).toBe(true);
    for (const name of names) {
      const job = workflow.jobs[name]!;
      expect(job).toBeDefined();
      expect(job.if).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain("github.event.pull_request");
      const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"))!;
      expect(checkout).toBeDefined();
      // Checkout's default is the event SHA; the fleet override must fall back to it too.
      if (checkout.with?.ref !== undefined) expect(checkout.with.ref).toMatch(/github\.sha\s*\}\}$/u);
      checks += job.strategy?.matrix?.os?.length ?? 1;
    }
  }
  expect(checks).toBe(7);
});

test("workflow policy rejects the pre-queue state and filtered or missing merge-group checks", async () => {
  for (const file of ["ci.yml", "compatibility.yml", "platform-qualification.yml"]) {
    const source = await readFile(join(import.meta.dir, "../../../.github/workflows", file), "utf8");
    const workflow = Bun.YAML.parse(source) as { on: Record<string, unknown> };
    expect(checkWorkflowMergeQueue(file, source)).toEqual([]);
    // Model the existing PR-only workflow before enabling the queue.
    delete workflow.on.merge_group;
    expect(checkWorkflowMergeQueue(file, Bun.YAML.stringify(workflow))).toHaveLength(1);
    for (const trigger of [{ types: ["destroyed"] }, { types: ["checks_requested"], branches: ["other"] }]) {
      workflow.on.merge_group = trigger;
      expect(checkWorkflowMergeQueue(file, Bun.YAML.stringify(workflow))).toHaveLength(1);
    }
  }
  expect(checkWorkflowMergeQueue("signed-release.yml", "on:\n  push:\n    tags: ['v*']\n")).toEqual([]);
});

function validationScripts(source: string): string[] {
  return [...source.matchAll(/      - name: Validate bounded gateway dispatch[\s\S]*?        run: \|\n((?:          .*\n)+)/g)].map(
    (match) => match[1] ?? "",
  );
}

function runValidation(
  script: string,
  updates: Record<string, string> = {},
  socketPath = join(tmpdir(), "gateway-ci-absent-docker.sock"),
): number | null {
  return spawnSync(
    "bash",
    ["-Eeuo", "pipefail", "-c", script.replace("/var/run/docker.sock", socketPath)],
    {
      encoding: "utf8",
      env: { ...process.env, ...validEnvironment, ...updates },
    },
  ).status;
}

async function withUnixSocket(check: (socketPath: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ci-workflow-"));
  const socketPath = join(directory, "docker.sock");
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  try {
    check(socketPath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(directory, { recursive: true, force: true });
  }
}

test("every fleet lane fails closed and admits either qualified site", async () => {
  const source = await readFile(workflowPath, "utf8");
  const fleetRunsOn =
    source.match(/^    runs-on: .*inputs\.routing_label \|\| 'ubuntu-24\.04' \}\}$/gm) ?? [];
  const scripts = validationScripts(source);

  expect(fleetRunsOn).toHaveLength(3);
  expect(scripts).toHaveLength(fleetRunsOn.length);
  expect(source).not.toContain("^gateway-ci-nyc-[1-3]$");
  for (const script of scripts) {
    const predicates = script
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("[["));
    expect(predicates).toHaveLength(4);
    expect(predicates.every((line) => /\]\] \|\| fail [a-z_]+$/.test(line))).toBe(true);
    expect(script).toContain("^gateway-ci-(nyc|sf)-[1-3]$");

    expect(runValidation(script)).toBe(0);
    expect(runValidation(script, { RUNNER_NAME: "gateway-ci-sf-2" })).toBe(0);
    expect(runValidation(script, { ROUTING_LABEL: "gateway-ci-linux-x64-shared" })).toBe(2);
    expect(runValidation(script, { TARGET_SHA: "A".repeat(40) })).toBe(2);
    expect(runValidation(script, { RUNNER_NAME: "unknown-runner" })).toBe(2);
    await withUnixSocket((socketPath) => {
      expect(runValidation(script, {}, socketPath)).toBe(2);
    });
  }
});

interface VisualWorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "timeout-minutes"?: number;
  "continue-on-error"?: boolean;
}
interface VisualWorkflow {
  jobs: Record<string, {
    "runs-on": string;
    "timeout-minutes": number;
    env?: unknown;
    needs?: unknown;
    "continue-on-error"?: boolean;
    steps: VisualWorkflowStep[];
  }>;
}

test("visual review stays GitHub-hosted and scopes its secret only to eligible uploads", async () => {
  const source = await readFile(workflowPath, "utf8");
  const workflow = Bun.YAML.parse(source) as VisualWorkflow;
  const visual = workflow.jobs["visual-review"]!;
  expect(visual["runs-on"]).toBe("ubuntu-24.04");
  expect(visual["timeout-minutes"]).toBe(20);
  expect(visual.env).toBeUndefined();
  expect(visual.needs).toBeUndefined();
  expect(visual["continue-on-error"]).toBeUndefined();
  expect(JSON.stringify(visual)).not.toMatch(/retries/u);
  const steps = visual.steps;
  const setup = steps.find(step => step.uses?.startsWith("oven-sh/setup-bun@"))!;
  expect(setup.if).toBeUndefined();
  expect(setup.with?.["bun-version"]).toBe(packageManifest.packageManager.replace(/^bun@/u, ""));
  const nodeSetup = steps.find(step => step.uses?.startsWith("actions/setup-node@"))!;
  expect(nodeSetup.uses).toBe("actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"); // v7.1.0
  expect(nodeSetup.if).toBeUndefined();
  expect(nodeSetup.with?.["node-version"]).toBe("24.22.0");
  expect(nodeSetup.with?.["package-manager-cache"]).toBe(false);
  const nodeSelection = steps.find(step => step.name === "Select pinned Percy Node")!;
  expect(nodeSelection.run).toContain('test "$(node --version)" = v24.22.0');
  expect(nodeSelection.run).toContain('node --print process.execPath');
  expect(steps.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(false);
  expect(steps.find((step: { run?: string }) => step.run === "bun install --frozen-lockfile")).toBeDefined();
  expect(steps.find(step => step.run === "bunx playwright install chromium")?.["timeout-minutes"]).toBe(10);
  const local = steps.find(step => step.run === "bun run test:visual")!;
  expect(local.if).toBeUndefined();
  expect(local["continue-on-error"]).toBeUndefined();
  expect(local.env?.OMP_VISUAL_EVIDENCE_DIR).toBe("test-results/visual-diagnostics");
  const secretSteps = steps.filter((step: unknown) => JSON.stringify(step).includes("secrets.PERCY_TOKEN"));
  expect(secretSteps).toHaveLength(1);
  const upload = secretSteps[0]!;
  expect(upload["continue-on-error"]).toBe(true);
  expect(steps.filter(step => step["continue-on-error"])).toEqual([upload]);
  expect(upload.run).toBe("bun run test:visual:percy");
  expect(upload.env?.OMP_VISUAL_NODE_EXECUTABLE).toBe("${{ steps.percy-node.outputs.executable }}");
  for (const condition of [upload.if, upload.env?.PERCY_TOKEN]) {
    expect(condition).toContain("github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository");
    expect(condition).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(condition).toContain("github.event_name == 'workflow_dispatch' && inputs.runner == 'github-hosted'");
    expect(condition).not.toContain("pull_request_target");
  }
  const summary = steps.find(step => step.name === "Record local-only visual review")!;
  expect(summary.if).toContain("inputs.runner != 'github-hosted'");
  expect(summary.if).toContain("head.repo.full_name != github.repository");
  expect(summary.run).toContain("Percy not uploaded");
  expect(summary.env).toBeUndefined();
});

test("local visual failure fails the job while upload failure is advisory with retained diagnostics", async () => {
  const workflow = Bun.YAML.parse(await readFile(workflowPath, "utf8")) as VisualWorkflow;
  const visual = workflow.jobs["visual-review"]!;
  const local = visual.steps.find(step => step.run === "bun run test:visual")!;
  const upload = visual.steps.find(step => step.run === "bun run test:visual:percy")!;
  const failsJob = (step: VisualWorkflowStep): boolean =>
    spawnSync("bash", ["-e", "-c", step.run!.replace(/bun run test:visual(?::percy)?/u, "exit 23")]).status !== 0 &&
    step["continue-on-error"] !== true;
  expect(failsJob(local)).toBe(true);
  expect(failsJob(upload)).toBe(false);
  expect(upload.env?.GITHUB_STEP_SUMMARY).toBeUndefined(); // GitHub supplies the real summary path.
  const artifact = visual.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"))!;
  expect(artifact.if).toBe("${{ always() }}");
  expect(artifact.with?.path).toBe("test-results/visual-diagnostics/");
});

test("both required browser lanes execute their exact checkout with bounded retries and only sanitized always-run uploads", async () => {
  for (const [file, lane, command] of [
    ["ci.yml", "browser-notifications", "bun run test:browser"],
    ["compatibility.yml", "browser-core", "bun run test:browser:compat"],
  ] as const) {
    const source = await readFile(join(import.meta.dir, "../../../.github/workflows", file), "utf8");
    const workflow = Bun.YAML.parse(source) as VisualWorkflow;
    const job = workflow.jobs[lane]!;
    expect(job["timeout-minutes"]).toBe(20);
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job.env).toMatchObject({ OMP_BROWSER_REPORT_VERSION: "2" });
    const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with?.ref).toContain("github.sha");
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    const execute = job.steps.find(step => step.run === command)!;
    expect(execute.if).toBeUndefined();
    expect(execute["continue-on-error"]).toBeUndefined();
    const artifacts = job.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0]!;
    expect(artifact.if).toBe("${{ always() }}");
    expect(artifact.with?.path).toBe("test-results/browser-flakes/browser-flake-report.json");
    expect(artifact.with?.["retention-days"]).toBe(14);
    expect(artifact.with?.["if-no-files-found"]).toBe("error");
    expect(artifact.with?.name).toBe(`browser-flake-${lane}-\${{ github.run_id }}-\${{ github.run_attempt }}`);
    const summary = job.steps.find(step => step.name === "Summarize sanitized browser flakes")!;
    expect(summary.if).toBe("${{ always() }}");
    expect(summary.run).toBe(`bun scripts/test-browser.ts --summary-only${lane === "browser-core" ? " --compat" : ""}`);
    expect(JSON.stringify(job)).not.toMatch(/main.*(?:green|skip)|paths-ignore/u);
  }
});

test("weekly browser flake maintenance is manual/scheduled, seven-day, read-only and not a release gate", async () => {
  const source = await readFile(join(import.meta.dir, "../../../.github/workflows/browser-flake-budget.yml"), "utf8");
  const workflow = Bun.YAML.parse(source) as VisualWorkflow & { on: Record<string, unknown>; permissions: Record<string, string> };
  expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  expect(workflow.on.schedule).toHaveLength(1);
  expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
  const budget = workflow.jobs["browser-flake-budget"]!;
  expect(budget["runs-on"]).toBe("ubuntu-24.04");
  expect(budget["timeout-minutes"]).toBe(20);
  expect(budget.steps.some(step => step.run === "bun run check:browser-flakes")).toBe(true);
  expect(source).not.toContain("actions/upload-artifact");
});
