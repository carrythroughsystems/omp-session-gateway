import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { assertVisualResult, requirePercyServer, runVisual, visualEnvironment, type VisualProcessResult } from "./test-visual.ts";

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
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.environment.PERCY_TOKEN).toBeUndefined();
  expect(calls[1]?.command[1]?.endsWith("/bin/run.cjs")).toBe(true);
  expect(calls[1]?.environment.PERCY_BROWSER_EXECUTABLE?.includes("chromium")).toBe(true);
  expect(calls[1]?.environment.PERCY_SERVER_HOST).toBe("127.0.0.1");
  expect(calls[1]?.environment.PERCY_CLIENT_ERROR_LOGS).toBe("false");
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
