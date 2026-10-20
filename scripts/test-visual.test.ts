import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";
import { assertVisualResult, requirePercyServer, runVisual, safeVisualLines, visualEnvironment, visualProcessReasons, type VisualProcessResult } from "./test-visual.ts";

const localSuccess = { code: 0, stdout: "visual: validated=18 submitted=0 outcome=passed\n", stderr: "" };
const uploadSuccess = { code: 0, stdout: "visual: validated=18 submitted=18 outcome=passed\n[percy] Finalized build #1: https://percy.example.test/build/1\n", stderr: "" };

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
    return commands.length === 1 ? { code: 0, stdout: "", stderr: "" } : uploadSuccess;
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
  const calls: Array<{ command: string[]; environment: NodeJS.ProcessEnv }> = [];
  await runVisual(["upload"], { PERCY_TOKEN: "synthetic-test-token", PERCY_ENABLE: "0", PERCY_PARALLEL_TOTAL: "-1" }, async (command, environment) => {
    calls.push({ command, environment });
    return calls.length === 1 ? { code: 0, stdout: "", stderr: "" } : uploadSuccess;
  }, () => "synthetic-node");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.environment.PERCY_TOKEN).toBeUndefined();
  expect(calls[1]?.command[0]).toBe("synthetic-node");
  expect(basename(calls[1]?.command[1] ?? "")).toBe("run.cjs");
  expect(basename(dirname(calls[1]?.command[1] ?? ""))).toBe("bin");
  expect(calls[1]?.environment.PERCY_BROWSER_EXECUTABLE?.includes("chromium")).toBe(true);
  expect(calls[1]?.environment.PERCY_SERVER_HOST).toBe("127.0.0.1");
  expect(calls[1]?.environment.PERCY_CLIENT_ERROR_LOGS).toBe("false");
  expect(calls[1]?.environment.PERCY_DROPIN_DISABLE).toBe("true");
  expect(calls[1]?.environment.PERCY_LOGS_IN_MEMORY).toBe("1");
  expect(calls[1]?.environment.PERCY_ENABLE).toBeUndefined();
  expect(calls[1]?.environment.PERCY_PARALLEL_TOTAL).toBeUndefined();
});

test("upload rejects disabled Percy, swallowed warnings, incomplete counts and finalize failures", () => {
  const failures: VisualProcessResult[] = [
    { ...uploadSuccess, stdout: localSuccess.stdout },
    { ...uploadSuccess, stdout: uploadSuccess.stdout + "Percy is not running\n" },
    { ...uploadSuccess, stderr: "SDK warning contains untrusted detail" },
    { ...uploadSuccess, stdout: "visual: validated=18 submitted=18 outcome=passed\n" },
    { ...uploadSuccess, stdout: uploadSuccess.stdout.replace("submitted=18", "submitted=17") },
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

test("nested upload diagnostics preserve only closed-set phases, reasons and bounded counts", () => {
  const planted = "synthetic-sensitive-diagnostic";
  const diagnostic = [
    "visual: directory-empty / visual-phone-390x844: failed phase=submit reason=guard-rejected",
    "visual: validated=0 submitted=0 outcome=failed",
    "visual-runner: phase=server reason=healthy",
    "visual-runner: phase=playwright reason=child-exit",
    `[percy] ${planted}`,
    `visual: directory-empty / visual-phone-390x844: failed phase=${planted}`,
    `visual: directory-empty / visual-phone-390x844: failed phase=submit reason=${planted}`,
    "visual: directory-empty / visual-phone-390x844: failed phase=constructor",
    "visual: directory-empty / visual-phone-390x844: failed phase=submit reason=constructor",
    "visual-runner: phase=constructor reason=healthy",
    "visual: unknown-state / visual-phone-390x844: passed",
    "visual: validated=99 submitted=0 outcome=passed",
    "visual: validated=0 submitted=18 outcome=passed",
  ].join("\n");
  const lines = safeVisualLines(diagnostic);
  expect(lines.some(line => line.includes(planted))).toBe(false);
  expect(lines).toEqual(diagnostic.split("\n").slice(0, 4));
  expect(visualProcessReasons({ code: 1, stdout: diagnostic, stderr: planted }, true)).toEqual([
    "child-exit", "sdk-warning", "cli-unknown-diagnostic", "missing-summary", "not-finalized",
  ]);
});

test("classified and unknown CLI diagnostics still fail a finalized 18-snapshot build", () => {
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
      const response = await fetch(percy.address() + "/percy/healthcheck", { signal: AbortSignal.timeout(2000) });
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
}, 10_000);
