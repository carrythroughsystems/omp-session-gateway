import { expect, test, setDefaultTimeout } from "bun:test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_AUDIT_SUCCESS, PERCY_RUNTIME_NOTICE, assertVisualResult, requirePercyServer, runVisual, safeVisualLines, visualEnvironment, visualProcessReasons, type VisualProcessResult } from "./test-visual.ts";
import { VISUAL_CASE_COUNT, VISUAL_PHASES } from "../apps/web/visual/safe-reporter.ts";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const localSuccess = { code: 0, stdout: `visual: validated=${VISUAL_CASE_COUNT} queued=0 outcome=passed\n`, stderr: "" };
const uploadSuccess = { code: 0, stdout: `visual: validated=${VISUAL_CASE_COUNT} queued=${VISUAL_CASE_COUNT} outcome=passed\n[percy] Finalized build #1: https://percy.example.test/build/1\n`, stderr: "" };
const auditSuccess = { code: 0, stdout: LOG_AUDIT_SUCCESS + "\n", stderr: "" };

test("tray parity diagnostics retain their closed-set phase", () => {
  expect(VISUAL_PHASES["parity-tray"]).toBe(true);
  expect(VISUAL_PHASES["parity-settings"]).toBeUndefined();
});

test("local mode starts only the build and Playwright without Percy credentials or controls", async () => {
  const calls: Array<{ command: string[]; environment: NodeJS.ProcessEnv }> = [];
  await runVisual(["local"], { PATH: process.env.PATH, PERCY_TOKEN: "synthetic-test-token", PERCY_SERVER_ADDRESS: "http://127.0.0.1:1", PERCY_ENABLE: "1", OMP_VISUAL_PERCY_CHILD: "1" }, async (command, environment) => {
    calls.push({ command, environment });
    return calls.length === 1 ? { code: 0, stdout: "", stderr: "" } : localSuccess;
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.command.slice(1)).toEqual(["run", "build"]);
  expect(calls[1]?.command).toContain("apps/web/playwright.visual.config.ts");
  expect(calls.every(call => call.command.every(value => !value.includes("percy/cli")))).toBe(true);
  expect(calls.every(call => Object.keys(call.environment).every(key => !key.startsWith("PERCY_")))).toBe(true);
  expect(calls[1]?.environment.OMP_VISUAL_MODE).toBe("local");
});

test("upload mode refuses an absent token before creating any child", async () => {
  let calls = 0;
  await expect(runVisual(["upload"], {}, async () => { calls++; return uploadSuccess; })).rejects.toThrow("visual upload: PERCY_TOKEN is required");
  expect(calls).toBe(0);
});

test("upload refuses missing native Node before creating any child", async () => {
  let calls = 0;
  await expect(runVisual(["upload"], {
    PERCY_TOKEN: "synthetic-test-token", OMP_VISUAL_NODE_EXECUTABLE: "/nonexistent/percy-node",
  }, async () => { calls++; return uploadSuccess; }, () => null)).rejects.toThrow("visual upload: Node.js is required for Percy");
  expect(calls).toBe(0);
});

test("upload uses the explicitly selected setup-node executable rather than another PATH node", async () => {
  const selected = process.platform === "win32" ? "C:\\synthetic\\node.exe" : "/synthetic/node";
  const commands: string[][] = [];
  const requested: string[] = [];
  await runVisual(["upload"], {
    PERCY_TOKEN: "synthetic-test-token", OMP_VISUAL_NODE_EXECUTABLE: selected, PATH: "/nonexistent",
  }, async command => {
    commands.push(command);
    return commands.length === 1 ? { code: 0, stdout: "", stderr: "" } : commands.length === 2 ? auditSuccess : uploadSuccess;
  }, executable => { requested.push(executable); return selected; });
  expect(commands[1]?.[0]).toBe(selected);
  expect(requested).toEqual([selected]);
});

test("modes are closed and never fall back on a failure or invalid selection", async () => {
  for (const args of [[], ["auto"], ["local", "upload"]]) {
    await expect(runVisual(args, {})).rejects.toThrow("visual: choose local or upload");
  }
  await expect(runVisual(["local"], {}, async () => ({ code: 1, stdout: "", stderr: "" }))).rejects.toThrow("visual: build failed");
  await expect(runVisual(["local"], {}, async command => command.includes("build") ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" })).rejects.toThrow("visual local: validation failed");
});

test("upload launches the pinned CLI with the Playwright browser and isolated log controls", async () => {
  const calls: Array<{ command: string[]; environment: NodeJS.ProcessEnv; timeoutMs: number | undefined }> = [];
  await runVisual(["upload"], { PERCY_TOKEN: "synthetic-test-token", PERCY_ENABLE: "0", PERCY_PARALLEL_TOTAL: "-1" }, async (command, environment, timeoutMs) => {
    calls.push({ command, environment, timeoutMs });
    return calls.length === 1 ? { code: 0, stdout: "", stderr: "" } : calls.length === 2 ? auditSuccess : uploadSuccess;
  }, () => "synthetic-node");
  expect(calls).toHaveLength(3);
  expect(calls[0]?.environment.PERCY_TOKEN).toBeUndefined();
  expect(calls[1]?.environment.PERCY_TOKEN).toBeUndefined();
  expect(calls[1]?.timeoutMs).toBe(5 * HANG_DEADLINE_MS);
  expect(calls[1]?.environment.PERCY_DO_NOT_CAPTURE_RESPONSIVE_ASSETS).toBe("true");
  expect(calls[1]?.command).toContain("--eval");
  expect(calls[2]?.command[0]).toBe("synthetic-node");
  expect(basename(calls[2]?.command[1] ?? "")).toBe("run.cjs");
  expect(basename(dirname(calls[2]?.command[1] ?? ""))).toBe("bin");
  expect(calls[2]?.environment.PERCY_BROWSER_EXECUTABLE?.includes("chromium")).toBe(true);
  expect(calls[2]?.environment.PERCY_SERVER_HOST).toBe("127.0.0.1");
  expect(calls[2]?.environment.PERCY_CLIENT_ERROR_LOGS).toBe("false");
  expect(calls[2]?.environment.PERCY_DROPIN_DISABLE).toBe("true");
  expect(calls[2]?.environment.PERCY_DO_NOT_CAPTURE_RESPONSIVE_ASSETS).toBe("true");
  expect(calls[2]?.environment.PERCY_LOGS_IN_MEMORY).toBe("1");
  expect(calls[2]?.environment.PERCY_ENABLE).toBeUndefined();
  expect(calls[2]?.environment.PERCY_PARALLEL_TOTAL).toBeUndefined();
  expect(calls[2]?.timeoutMs).toBeUndefined();
});

test("a failed log-audit preflight prevents starting the real Percy CLI", async () => {
  const commands: string[][] = [];
  await expect(runVisual(["upload"], { PERCY_TOKEN: "synthetic-test-token" }, async command => {
    commands.push(command);
    return commands.length === 1 ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "unsafe synthetic diagnostic" };
  }, () => "synthetic-node")).rejects.toThrow("visual upload: log audit failed");
  expect(commands).toHaveLength(2);
  expect(commands.some(command => command.some(argument => basename(argument) === "run.cjs"))).toBe(false);
});

test("upload rejects disabled Percy, swallowed warnings, incomplete counts and finalize failures", () => {
  const failures: VisualProcessResult[] = [
    { ...uploadSuccess, stdout: localSuccess.stdout },
    { ...uploadSuccess, stdout: uploadSuccess.stdout + "Percy is not running\n" },
    { ...uploadSuccess, stderr: "SDK warning contains untrusted detail" },
    { ...uploadSuccess, stdout: `visual: validated=${VISUAL_CASE_COUNT} queued=${VISUAL_CASE_COUNT} outcome=passed\n` },
    { ...uploadSuccess, stdout: uploadSuccess.stdout.replace(`queued=${VISUAL_CASE_COUNT}`, `queued=${VISUAL_CASE_COUNT - 1}`) },
    { ...uploadSuccess, code: 1 },
  ];
  for (const result of failures) expect(() => assertVisualResult(result, true)).toThrow("visual upload: incomplete or failed Percy build");
  assertVisualResult(uploadSuccess, true);
});

test("server health requires an active real build, not just a reachable HTTP server", async () => {
  const server = createServer((_request, response) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ success: true, type: "web", build: {} })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  try {
    await expect(requirePercyServer({ PERCY_SERVER_ADDRESS: `http://127.0.0.1:${address.port}` })).rejects.toThrow("visual upload: healthy Percy server required");
    await expect(requirePercyServer({ PERCY_SERVER_ADDRESS: "http://127.0.0.1:1" })).rejects.toThrow("visual upload: healthy Percy server required");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("failed diagnostics never repeat untrusted child output", () => {
  const planted = "synthetic-sensitive-diagnostic";
  let message = "";
  try { assertVisualResult({ code: 1, stdout: planted, stderr: planted }, true); }
  catch (error) { message = error instanceof Error ? error.message : ""; }
  expect(message.includes(planted)).toBe(false);
  expect(visualEnvironment({ PERCY_TOKEN: planted, __PERCY_BROWSERIFIED__: "1", OMP_VISUAL_MODE: "upload", CI: "true" })).toEqual({ CI: "true" });
});

test("unfinalized upload retains only sanitized diagnostics and reports advisory failure after local validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visual-evidence-"));
  const environment = {
    PERCY_TOKEN: "synthetic-test-token",
    OMP_VISUAL_EVIDENCE_DIR: directory,
    GITHUB_STEP_SUMMARY: join(directory, "step-summary"),
  };
  try {
    await runVisual(["local"], environment, async command =>
      command.includes("build") ? { code: 0, stdout: "", stderr: "" } : localSuccess);
    const output: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((value: string) => { output.push(value); return true; }) as typeof original;
    try {
      let calls = 0;
      await expect(runVisual(["upload"], environment, async () => {
        calls++;
        return calls === 1 ? { code: 0, stdout: "", stderr: "" } : calls === 2 ? auditSuccess : {
          code: 1,
          stdout: `visual-runner: phase=server reason=health-unreachable\nvisual: validated=${VISUAL_CASE_COUNT} queued=${VISUAL_CASE_COUNT} outcome=passed\n`,
          stderr: "HTTP 403 synthetic-sensitive-diagnostic",
        };
      }, () => "synthetic-node")).rejects.toThrow("visual upload: incomplete or failed Percy build");
    } finally { process.stdout.write = original; }
    expect(output.join("")).not.toMatch(/submitted|uploaded/u);
    const summary = await readFile(environment.GITHUB_STEP_SUMMARY, "utf8");
    expect(summary).toContain("visual upload FAILED (advisory):");
    expect(summary).toContain("health-unreachable");
    expect(summary).toContain("cli-http-403");
    expect(summary).toContain("; local visual validation PASSED");
    const local = JSON.parse(await readFile(join(directory, "local-summary.json"), "utf8"));
    expect(local).toEqual({ validated: VISUAL_CASE_COUNT, queued: 0, outcome: "passed" });
    for (const path of ["upload-stdout.log", "upload-stderr.log"]) {
      const text = await readFile(join(directory, path), "utf8");
      expect(text).not.toContain("synthetic-sensitive-diagnostic");
      expect(text).not.toContain(environment.PERCY_TOKEN);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("nested upload diagnostics preserve only closed-set phases, reasons and bounded counts", () => {
  const planted = "synthetic-sensitive-diagnostic";
  const diagnostic = [
    "visual: directory-empty / visual-phone-390x844: failed phase=submit reason=guard-rejected",
    "visual: validated=0 queued=0 outcome=failed",
    "visual-runner: phase=server reason=healthy",
    "visual-runner: phase=playwright reason=child-exit",
    `[percy] ${planted}`,
    `visual: directory-empty / visual-phone-390x844: failed phase=${planted}`,
    `visual: directory-empty / visual-phone-390x844: failed phase=submit reason=${planted}`,
    "visual: directory-empty / visual-phone-390x844: failed phase=constructor",
    "visual: directory-empty / visual-phone-390x844: failed phase=submit reason=constructor",
    "visual-runner: phase=constructor reason=healthy",
    "visual: unknown-state / visual-phone-390x844: passed",
    "visual: validated=99 queued=0 outcome=passed",
    `visual: validated=0 queued=${VISUAL_CASE_COUNT} outcome=passed`,
  ].join("\n");
  const lines = safeVisualLines(diagnostic);
  expect(lines.some(line => line.includes(planted))).toBe(false);
  expect(lines).toEqual(diagnostic.split("\n").slice(0, 4));
  expect(visualProcessReasons({ code: 1, stdout: diagnostic, stderr: planted }, true)).toEqual([
    "child-exit", "sdk-warning", "cli-unknown-diagnostic", "missing-summary", "not-finalized",
  ]);
});

test("classified and unknown CLI diagnostics still fail a finalized full-snapshot build", () => {
  for (const [text, category] of [
    ["[percy] Skipping baseline setup", "cli-baseline-warning"],
    ["[percy] [SDK Update Available] package: version", "cli-sdk-update"],
    ["[percy] Invalid snapshot options:", "cli-config-warning"],
    ["[percy] Could not send the builds logs", "cli-log-upload-warning"],
    ["(node:1) DeprecationWarning: synthetic", "cli-node-warning"],
    ["unknown synthetic diagnostic", "cli-unknown-diagnostic"],
  ]) {
    const result = { ...uploadSuccess, stderr: text! };
    expect(visualProcessReasons(result, true)).toContain(category!);
    expect(() => assertVisualResult(result, true)).toThrow("visual upload: incomplete or failed Percy build");
  }
});

for (const [diagnostic, category] of [
  ["Skipping baseline setup", "cli-baseline-warning"],
  ["Invalid snapshot options:", "cli-config-warning"],
  ["Skipping resource: synthetic", "cli-discovery-warning"],
  ["[SDK Update Available] synthetic", "cli-sdk-update"],
  ["Could not send the builds logs", "cli-log-upload-warning"],
  ["VRA is Percy's recommended visual review mode", "cli-layout-mode-warning"],
  ["buildDepTree: OLD lockfile failed to parse", "cli-lockfile-warning"],
  ["system level proxy", "cli-proxy-warning"],
  ["MaxListenersExceededWarning", "cli-node-warning"],
  ["Encountered snapshot serialization warnings", "cli-serialization-warning"],
] as const) {
  test(`classified stdout diagnostic ${category} fails a finalized build`, () => {
    const result = { ...uploadSuccess, stdout: `${uploadSuccess.stdout}[percy] ${diagnostic}\n` };
    expect(visualProcessReasons(result, true)).toContain(category);
    expect(() => assertVisualResult(result, true)).toThrow("visual upload: incomplete or failed Percy build");
  });
}

test("only the exact pinned entry-point future-Node notice is nonfatal", () => {
  const notice = { ...uploadSuccess, stderr: PERCY_RUNTIME_NOTICE + "\n" };
  expect(visualProcessReasons(notice, true)).toEqual([]);
  assertVisualResult(notice, true);
  for (const stderr of [
    PERCY_RUNTIME_NOTICE + " changed",
    PERCY_RUNTIME_NOTICE + "\n[percy] Warning: synthetic SDK warning",
    "[percy] " + PERCY_RUNTIME_NOTICE,
  ]) expect(() => assertVisualResult({ ...uploadSuccess, stderr }, true)).toThrow("visual upload: incomplete or failed Percy build");
  expect(visualProcessReasons(notice, true, false)).toContain("sdk-warning");
});

// A cold Windows runner can spend over 10 s starting Node and loading @percy/core (2026-10-20,
// Compatibility portable-source); 30 s matches the portable lane's default per-test bound.
test("the installed Percy API answers health under its native Node runtime", async () => {
  const script = `
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    const require = createRequire(pathToFileURL(process.cwd() + "/package.json"));
    const cliRequire = createRequire(require.resolve("@percy/cli"));
    // Resolve the pinned transitive package rather than importing a hoisted dependency.
    const { default: Percy } = await import(pathToFileURL(cliRequire.resolve("@percy/core")).href);
    const percy = new Percy({ testing: true, port: 0, projectType: "web" });
    percy.testing.build = { id: "local-synthetic-build" };
    try {
      await percy.start();
      const response = await fetch(percy.address() + "/percy/healthcheck", { signal: AbortSignal.timeout(${HANG_DEADLINE_MS}) });
      const body = await response.json();
      if (!response.ok || body.success !== true || body.type !== "web" || body.build?.id !== "local-synthetic-build") throw new Error();
      process.stdout.write("local-percy: healthy\\n");
    } catch {
      process.stderr.write("local-percy: failed\\n");
      process.exitCode = 1;
    } finally { await percy.stop(); }
  `;
  const child = Bun.spawn([Bun.which("node")!, "--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...visualEnvironment(process.env),
      PERCY_TOKEN: "web_local-synthetic-testing-only",
      PERCY_SERVER_HOST: "127.0.0.1",
      PERCY_LOGS_IN_MEMORY: "1",
      PERCY_CLIENT_ERROR_LOGS: "false",
    },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0);
  expect(stdout === "local-percy: healthy\n").toBe(true);
  expect(stderr === "").toBe(true);
}, 2 * HANG_DEADLINE_MS);
