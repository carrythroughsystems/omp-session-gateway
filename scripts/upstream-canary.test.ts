import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canaryBunEngineError,
  canarySummary,
  CANARY_STAGES,
  hasCanaryPrompt,
  hasRewindConfirmation,
  isSupportedOmpVersion,
  parseCanaryArgs,
  parseCanarySummary,
  parseOmpVersion,
  readCanaryPackage,
  windowsArgument,
  windowsHostScript,
} from "./upstream-canary.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

async function withOmpPackage(bunEngine: string, check: (directory: string, binary: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omp-canary-report-test-"));
  const directory = join(root, "node_modules", "@oh-my-pi", "pi-coding-agent");
  const binary = join(directory, "dist", "cli.js");
  try {
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: "@oh-my-pi/pi-coding-agent", version: "18.14.0", engines: { bun: bunEngine },
    }));
    // A stock-shaped package whose CLI cannot start, as with an incompatible runtime floor.
    await writeFile(binary, "#!/usr/bin/env bun\nprocess.exit(1);\n", { mode: 0o700 });
    await check(directory, binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function failedCanary(binary: string) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./upstream-canary.ts", import.meta.url)), "--omp", binary], {
    encoding: "utf8", timeout: HANG_DEADLINE_MS,
  });
  expect(result.status).toBe(1);
  return { summary: parseCanarySummary(result.stdout), stderr: result.stderr };
}

describe("upstream canary arguments", () => {
  test("accepts a binary path with spaces and an explicit diagnostic model", () => {
    expect(parseCanaryArgs(["--omp", "/tmp/stock omp", "--model", "provider/model"])).toEqual({
      omp: "/tmp/stock omp", model: "provider/model",
    });
  });

  test("refuses missing, duplicate, unknown, and truncated arguments without echoing their values", () => {
    for (const args of [
      [], ["--omp"], ["--omp", ""], ["--model", "provider/model"],
      ["--omp", "--model"], ["--omp", "binary", "--omp", "other"],
      ["--omp", "binary", "--unknown", "private-value"],
      ["--omp", "binary", "--model", "one", "--model", "two"],
      ["--omp", "binary\0suffix"], ["--omp", "binary", "unexpected"],
    ]) {
      expect(() => parseCanaryArgs(args)).toThrow(/^(?:invalid arguments|--omp is required)$/u);
    }
  });
});

describe("stock OMP version gate", () => {
  test("enforces the mainline minimum and rejects prereleases", () => {
    expect(isSupportedOmpVersion("18.1.19")).toBe(false);
    expect(isSupportedOmpVersion("18.1.20")).toBe(true);
    expect(isSupportedOmpVersion("18.3.0")).toBe(true);
    expect(isSupportedOmpVersion("19.0.0")).toBe(true);
    expect(isSupportedOmpVersion("18.1.20-rc.1")).toBe(false);
    expect(isSupportedOmpVersion("18.3.0-rc.1")).toBe(false);
  });

  test("extracts bare and prefixed banners without forwarding extra output", () => {
    expect(parseOmpVersion("18.1.20\n")).toBe("18.1.20");
    expect(parseOmpVersion("omp/18.3.0")).toBe("18.3.0");
    expect(parseOmpVersion("omp 18.3.0")).toBe("18.3.0");
    expect(parseOmpVersion("18.3.0\nprivate diagnostic")).toBeUndefined();
    expect(parseOmpVersion("18.3.0 private diagnostic")).toBeUndefined();
    expect(isSupportedOmpVersion("not-a-version")).toBe(false);
    expect(isSupportedOmpVersion("omp/18.3.0")).toBe(false);
  });
});

describe("canary preparation failures", () => {
  test("retains the installed manifest version when the version query cannot run", async () => {
    await withOmpPackage(">=1.3.14", async (_directory, binary) => {
      const { summary, stderr } = failedCanary(binary);
      expect(stderr).toContain("OMP version query failed");
      expect(summary.ompVersion).toBe("18.14.0");
    });
  });

  test("attributes version-query and stock-binary failures to prepare, not publish", async () => {
    await withOmpPackage(">=1.3.14", async (directory, binary) => {
      const nonStock = join(directory, "..", "..", "..", "not-stock.js");
      await writeFile(nonStock, "#!/usr/bin/env bun\nprocess.exit(1);\n", { mode: 0o700 });
      for (const target of [binary, nonStock]) {
        const { summary } = failedCanary(target);
        expect(summary.failedStage).toBe("prepare");
        expect(summary.stages.prepare).toBe("failed");
        expect(summary.stages.publish).toBe("skipped");
      }
    });
  });

  test("compares the installed OMP engine floor with an explicit Bun version", async () => {
    await withOmpPackage(">=1.4.4", async directory => {
      const installed = await readCanaryPackage(directory);
      expect(installed).toEqual({ ompVersion: "18.14.0", bunEngine: ">=1.4.4" });
      expect(canaryBunEngineError(installed, "1.4.0")).toBe("OMP 18.14.0 requires Bun >=1.4.4; running Bun 1.4.0");
      expect(canaryBunEngineError(installed, "1.4.4")).toBeUndefined();
    });
  });

  test("rejects an incompatible Bun before executing the installed OMP CLI", async () => {
    await withOmpPackage(">=99.0.0", async (directory, binary) => {
      const marker = join(directory, "cli-executed");
      await writeFile(binary, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, "executed");\nprocess.exit(1);\n`);
      const { summary, stderr } = failedCanary(binary);
      expect(summary.failedStage).toBe("prepare");
      expect(summary.ompVersion).toBe("18.14.0");
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(stderr).toBe(`prepare: OMP 18.14.0 requires Bun >=99.0.0; running Bun ${Bun.version}\n`);
    });
  });

  test("binds both passed outputs to the nonempty requested-or-resolved install version", async () => {
    const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/upstream-canary.yml", import.meta.url)).text()) as {
      jobs: Record<string, { outputs: Record<string, string>; steps: { id?: string; run?: string }[] }>;
    };
    for (const name of ["canary", "canary-windows"]) {
      const job = workflow.jobs[name]!;
      expect(job.outputs.passed).toBe("${{ steps.summary.outcome == 'success' && steps.summary.outputs.failed_stage == '' && steps.install.outputs.expected_version != '' && steps.summary.outputs.omp_version == steps.install.outputs.expected_version }}");
      const install = job.steps.find(step => step.id === "install")!;
      expect(install.run).toContain('const expectedVersion = process.env.OMP_VERSION === "latest" ? installed.ompVersion : process.env.OMP_VERSION;');
      expect(install.run).toContain('await appendFile(process.env.GITHUB_OUTPUT, `omp_version=${installed.ompVersion}\\nbun_engine=${installed.bunEngine}\\nexpected_version=${expectedVersion}\\n`);');
    }
  });

  test("publishes the resolved version and runtime context even without a canary report", async () => {
    const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/upstream-canary.yml", import.meta.url)).text()) as {
      jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
    };
    const root = await mkdtemp(join(tmpdir(), "omp-canary-summary-test-"));
    try {
      for (const [job, platform] of [["canary", "posix"], ["canary-windows", "windows"]] as const) {
        const step = workflow.jobs[job]!.steps.find(candidate => candidate.id === "summary")!;
        const stepSummary = join(root, `${platform}-summary`);
        const stepOutput = join(root, `${platform}-output`);
        const result = spawnSync("bash", ["-c", step.run!], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            ...process.env, CANARY_REPORT: join(root, "missing-report"),
            REQUESTED_OMP_VERSION: "latest", RESOLVED_OMP_VERSION: "18.14.0",
            BUN_VERSION: "1.4.0", OMP_BUN_ENGINE: ">=1.4.4",
            GITHUB_STEP_SUMMARY: stepSummary, GITHUB_OUTPUT: stepOutput,
          },
          encoding: "utf8", timeout: HANG_DEADLINE_MS,
        });
        expect(result.status).toBe(1);
        expect(parseCanarySummary(result.stdout, platform)).toEqual(canarySummary("18.14.0", 0, "prepare", false, platform));
        expect(await Bun.file(stepOutput).text()).toBe("omp_version=18.14.0\nfailed_stage=prepare\n");
        const summary = await Bun.file(stepSummary).text();
        for (const line of ["requestedOmpVersion: latest", "resolvedOmpVersion: 18.14.0", "bunVersion: 1.4.0", "bunEngine: >=1.4.4"]) {
          expect(summary).toContain(line);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("canary public reports", () => {
  test("stops at the first failure and does not claim later stages ran", () => {
    expect(canarySummary("18.3.0", 123, "snapshot")).toEqual({
      ompVersion: "18.3.0", platform: "posix", durationMs: 123, failedStage: "snapshot", discoveryFileRemoved: false,
      stages: { prepare: "passed", publish: "passed", snapshot: "failed", "stale-generation": "skipped", view: "skipped", control: "skipped",
        "new-generation": "skipped", fork: "skipped", "branch-rewind": "skipped", continue: "skipped", unregister: "skipped" },
    });
    expect(canarySummary("", 1, "publish").stages).toEqual({
      prepare: "passed", publish: "failed", snapshot: "skipped", "stale-generation": "skipped", view: "skipped", control: "skipped",
      "new-generation": "skipped", fork: "skipped", "branch-rewind": "skipped", continue: "skipped", unregister: "skipped",
    });
    expect(canarySummary("18.1.20", 123).stages).toEqual({
      prepare: "passed", publish: "passed", snapshot: "passed", "stale-generation": "passed", view: "passed", control: "passed",
      "new-generation": "passed", fork: "passed", "branch-rewind": "passed", continue: "passed", unregister: "passed",
    });
  });

  test("round-trips prepare failures and fills only a missing report version from the manifest", () => {
    for (const platform of ["posix", "windows"] as const) {
      const summary = canarySummary("", 0, "prepare", false, platform);
      expect(summary.stages.prepare).toBe("failed");
      expect(CANARY_STAGES.filter(stage => stage !== "prepare").every(stage => summary.stages[stage] === "skipped")).toBe(true);
      expect(parseCanarySummary(JSON.stringify(summary), platform, "18.14.0")).toEqual({ ...summary, ompVersion: "18.14.0" });
      const resolved = canarySummary("18.13.3", 1, "publish", false, platform);
      expect(parseCanarySummary(JSON.stringify(resolved), platform, "18.14.0")).toEqual(resolved);
      expect(() => parseCanarySummary(JSON.stringify(summary), platform, "18.14.0\nprivate-value")).toThrow("invalid canary summary");
    }
  });

  test("admits only the exact successful platform projection, never arbitrary skips", () => {
    const windowsSkips = new Set(["new-generation", "fork", "branch-rewind"]);
    for (const platform of ["posix", "windows"] as const) {
      const summary = canarySummary("18.4.8", 123, undefined, true, platform);
      expect(parseCanarySummary(JSON.stringify(summary), platform)).toEqual(summary);
      for (let mask = 0; mask < 2 ** CANARY_STAGES.length; mask++) {
        const stages = Object.fromEntries(CANARY_STAGES.map((stage, index) => [stage, mask & (1 << index) ? "skipped" : "passed"]));
        const valid = CANARY_STAGES.every(stage => stages[stage] === (platform === "windows" && windowsSkips.has(stage) ? "skipped" : "passed"));
        if (!valid) expect(() => parseCanarySummary(JSON.stringify({ ...summary, stages }), platform)).toThrow("invalid canary summary");
      }
    }
  });

  test("preserves the failure frontier after Windows-only skips and binds reports to their job", () => {
    const summary = canarySummary("18.4.8", 123, "continue", false, "windows");
    expect(summary.stages).toEqual({
      prepare: "passed", publish: "passed", snapshot: "passed", "stale-generation": "passed", view: "passed", control: "passed",
      "new-generation": "skipped", fork: "skipped", "branch-rewind": "skipped", continue: "failed", unregister: "skipped",
    });
    expect(parseCanarySummary(JSON.stringify(summary), "windows")).toEqual(summary);
    expect(() => parseCanarySummary(JSON.stringify(summary), "posix")).toThrow("invalid canary summary");
    expect(() => parseCanarySummary(JSON.stringify(canarySummary("18.4.8", 123)), "windows")).toThrow("invalid canary summary");
    expect(() => canarySummary("18.4.8", 123, "fork", false, "windows")).toThrow("invalid canary summary");
  });

  test("projects only approved fields before writing CI summaries", () => {
    const summary = canarySummary("18.3.0", 321, "control", true);
    expect(parseCanarySummary(JSON.stringify({ ...summary, hostDiagnostic: "private-value" }))).toEqual(summary);
  });

  test("rejects unsafe versions, inconsistent progress, and malformed reports with a fixed reason", () => {
    const summary = canarySummary("18.3.0", 321, "view");
    for (const text of [
      "private-value", "null", "{}", `${JSON.stringify(summary)}\n${JSON.stringify(summary)}`,
      JSON.stringify({ ...summary, ompVersion: "18.3.0\nprivate-value" }),
      JSON.stringify({ ...summary, durationMs: -1 }),
      JSON.stringify({ ...summary, durationMs: 1.5 }),
      JSON.stringify({ ...summary, durationMs: Number.MAX_SAFE_INTEGER + 1 }),
      JSON.stringify({ ...summary, platform: undefined }),
      JSON.stringify({ ...summary, platform: "linux" }),
      JSON.stringify({ ...summary, failedStage: null }),
      JSON.stringify({ ...summary, discoveryFileRemoved: "false" }),
      JSON.stringify({ ...summary, failedStage: "private-value" }),
      JSON.stringify({ ...summary, stages: { ...summary.stages, control: "passed" } }),
      JSON.stringify({ ...summary, stages: { ...summary.stages, snapshot: "failed" } }),
      JSON.stringify({ ...summary, stages: null }),
      JSON.stringify({ ...summary, stages: [] }),
      JSON.stringify({ ...summary, stages: { ...summary.stages, continue: undefined } }),
      JSON.stringify({ ...summary, stages: { ...summary.stages, extra: "skipped" } }),
    ]) {
      expect(() => parseCanarySummary(text)).toThrow("invalid canary summary");
    }
  });
});

describe("lifecycle evidence", () => {
  test("recognizes typed and collaborative user prompts, not unrelated or partial transcript matches", () => {
    const marker = "synthetic-transition-marker";
    expect(hasCanaryPrompt([{ type: "message", message: { role: "user", content: [{ type: "text", text: marker }] } }], marker)).toBe(true);
    expect(hasCanaryPrompt([{ type: "message", message: { role: "user", content: marker } }], marker)).toBe(true);
    expect(hasCanaryPrompt([{ type: "custom_message", customType: "collab-prompt", content: marker }], marker)).toBe(true);
    expect(hasCanaryPrompt([
      null, false, marker, {}, { type: "message", message: null },
      { type: "message", message: { role: "assistant", content: marker } },
      { type: "message", message: { role: "user", content: [{ type: "image", text: marker }] } },
      { type: "message", message: { role: "user", content: `draft-${marker}` } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "draft-" }, { type: "text", text: marker }] } },
      { type: "message", message: { role: "user", content: { text: marker } } },
      { type: "custom_message", customType: "other", content: marker },
      { type: "session", title: marker },
    ], marker)).toBe(false);
  });

  test("requires a complete positive rewind status, not selection, failure, or quoted text", () => {
    expect(hasRewindConfirmation("header\n  Rewound to selected point  \nfooter")).toBe(true);
    expect(hasRewindConfirmation("Already at this point")).toBe(false);
    expect(hasRewindConfirmation("selected: Rewound to selected point")).toBe(false);
    expect(hasRewindConfirmation("Rewound to selected point failed")).toBe(false);
    expect(hasRewindConfirmation("Rewound to selected point?")).toBe(false);
    expect(hasRewindConfirmation("Rewound to selected point in history")).toBe(false);
  });
});

describe("Windows host launch", () => {
  test("quotes arguments by the Windows command-line rules", () => {
    expect(windowsArgument("plain")).toBe("plain");
    expect(windowsArgument("")).toBe('""');
    expect(windowsArgument("C:\\stock omp\\cli.js")).toBe('"C:\\stock omp\\cli.js"');
    // A trailing backslash would otherwise escape the closing quote.
    expect(windowsArgument("C:\\stock omp\\")).toBe('"C:\\stock omp\\\\"');
    expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""');
    // Backslashes before a quote double, then the quote itself is escaped.
    expect(windowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
  });

  test("refuses an environment variable name that could execute PowerShell", () => {
    expect(() => windowsHostScript("C:\\bun.exe", [], "C:\\work", { "PATH;Remove-Item": "x" })).toThrow("invalid host environment");
  });
});
