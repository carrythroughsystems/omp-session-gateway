import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { VISUAL_PHASES, VISUAL_PROJECTS, VISUAL_STATES, VISUAL_UPLOAD_REASONS } from "../apps/web/visual/safe-reporter.ts";

export type VisualMode = "local" | "upload";
export interface VisualProcessResult { code: number; stdout: string; stderr: string }
export type VisualProcess = (command: string[], environment: NodeJS.ProcessEnv) => Promise<VisualProcessResult>;
export type VisualRuntimeResolver = (executable: string) => string | null;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = createRequire(import.meta.url).resolve("@percy/cli");
// CLI's exported index is dist/index.js; its pinned package's executable is bin/run.cjs.
const CLI_EXECUTABLE = fileURLToPath(new URL("../bin/run.cjs", pathToFileURL(CLI)));
const CONFIG = "apps/web/playwright.visual.config.ts";
const MISSING_TOKEN = "visual upload: PERCY_TOKEN is required";
const MISSING_NODE = "visual upload: Node.js is required for Percy";
// @percy/cli 1.32.11 bin/run.cjs:13-16 prints this unconditionally, even on Node 24.
// Our exact major pin and native Node >=20 already satisfy this future-major announcement.
export const PERCY_RUNTIME_NOTICE = "Heads up! The next major version of @percy/cli will require Node 20+. Either pin @percy/cli to its current major version, or make sure your setup runs on Node 20+, before the next major release.";
const RUNNER_PHASES: Readonly<Record<string, true>> = { server: true, playwright: true, percy: true };
const RUNNER_REASONS: Readonly<Record<string, true>> = {
  healthy: true, "health-rejected": true, "child-exit": true, "sdk-warning": true,
  "missing-summary": true, "not-finalized": true,
  "health-address": true, "health-unreachable": true, "health-status": true, "health-shape": true,
  "health-type": true, "health-build": true,
  "node-missing": true,
  "cli-baseline-warning": true, "cli-config-warning": true, "cli-discovery-warning": true,
  "cli-sdk-update": true, "cli-log-upload-warning": true, "cli-layout-mode-warning": true,
  "cli-lockfile-warning": true, "cli-proxy-warning": true, "cli-node-warning": true,
  "cli-serialization-warning": true, "cli-unknown-diagnostic": true,
  "cli-runtime-notice": true,
};
// Stable messages from the pinned CLI; classify only, never echo text or relax failure policy.
const CLI_DIAGNOSTICS: ReadonlyArray<readonly [string, RegExp]> = [
  ["cli-baseline-warning", /Skipping baseline setup|baseline snapshot\(s\)|cannot read build status|Baseline build did not finish/iu],
  ["cli-config-warning", /Invalid (?:snapshot options|upload options|config):/iu],
  ["cli-discovery-warning", /Browser disconnected|browser disconnection|Skipping resource:|Network idle|Domain validation:|Failed to save auto configured hostnames/iu],
  ["cli-sdk-update", /\[SDK Update Available\]/u],
  ["cli-log-upload-warning", /Could not send the builds logs/iu],
  ["cli-layout-mode-warning", /VRA is Percy's recommended visual review mode/u],
  ["cli-lockfile-warning", /buildDepTree: (?:OLD|NEW) lockfile failed to parse/u],
  ["cli-proxy-warning", /system level proxy/iu],
  ["cli-node-warning", /ExperimentalWarning|DeprecationWarning|MaxListenersExceededWarning/u],
  ["cli-serialization-warning", /Encountered snapshot serialization warnings|Readiness timed out|DOM elements found outside/iu],
];

export function visualEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("PERCY_") && !key.startsWith("OMP_VISUAL_") && !key.startsWith("__PERCY_")));
}

/** Reconstruct only closed-set diagnostics; never forward raw child lines or matched substrings. */
export function safeVisualLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.replace(/\u001b\[[0-9;]*m/gu, "").split("\n")) {
    const state = /^visual: ([a-z-]+) \/ ([a-z0-9-]+): (passed|failed)(?: phase=([a-z-]+))?(?: reason=([a-z-]+))?$/u.exec(line);
    if (state && VISUAL_STATES.some(value => value === state[1]) && VISUAL_PROJECTS.some(value => value === state[2]) &&
      (state[3] === "passed" && state[4] === undefined && state[5] === undefined ||
        state[3] === "failed" && Object.hasOwn(VISUAL_PHASES, state[4] ?? "") && (state[5] === undefined || Object.hasOwn(VISUAL_UPLOAD_REASONS, state[5])))) {
      lines.push(`visual: ${state[1]} / ${state[2]}: ${state[3]}${state[4] ? ` phase=${state[4]}` : ""}${state[5] ? ` reason=${state[5]}` : ""}`);
      continue;
    }
    const summary = /^visual: validated=(\d{1,2}) submitted=(\d{1,2}) outcome=(passed|failed)$/u.exec(line);
    if (summary && Number(summary[1]) <= 18 && Number(summary[2]) <= Number(summary[1])) {
      lines.push(`visual: validated=${Number(summary[1])} submitted=${Number(summary[2])} outcome=${summary[3]}`);
      continue;
    }
    const runner = /^visual-runner: phase=([a-z-]+) reason=([a-z-]+)$/u.exec(line);
    if (runner && Object.hasOwn(RUNNER_PHASES, runner[1] ?? "") && Object.hasOwn(RUNNER_REASONS, runner[2] ?? "")) {
      lines.push(`visual-runner: phase=${runner[1]} reason=${runner[2]}`);
    }
  }
  return lines;
}

export function visualProcessReasons(result: VisualProcessResult, upload: boolean, requireFinalization = upload): string[] {
  const expected = `visual: validated=18 submitted=${upload ? 18 : 0} outcome=passed`;
  const reasons: string[] = [];
  if (result.code !== 0) reasons.push("child-exit");
  // The sole nonfatal diagnostic is the exact pinned entry-point announcement, not SDK output.
  const stderr = result.stderr.replace(/\u001b\[[0-9;]*m/gu, "").split("\n")
    .filter(line => !requireFinalization || line !== PERCY_RUNTIME_NOTICE).join("\n");
  // All other warnings/errors remain fatal. Never print their contents.
  if (stderr.trim() !== "" || /Percy is not running|\bwarning\b|skipping visual tests|Percy is disabled/iu.test(result.stdout)) {
    reasons.push("sdk-warning");
    if (requireFinalization) {
      const diagnostics = `${stderr}\n${result.stdout}`.replace(/\u001b\[[0-9;]*m/gu, "");
      const categories = CLI_DIAGNOSTICS.filter(([, pattern]) => pattern.test(diagnostics)).map(([code]) => code);
      reasons.push(...(categories.length ? categories : ["cli-unknown-diagnostic"]));
    }
  }
  if (!result.stdout.split("\n").includes(expected)) reasons.push("missing-summary");
  if (requireFinalization && !/\[percy\] Finalized build #\d+:/u.test(result.stdout.replace(/\u001b\[[0-9;]*m/gu, ""))) reasons.push("not-finalized");
  return reasons;
}

export function assertVisualResult(result: VisualProcessResult, upload: boolean): void {
  if (visualProcessReasons(result, upload).length !== 0) {
    throw new Error(upload ? "visual upload: incomplete or failed Percy build" : "visual local: validation failed");
  }
}

async function execute(command: string[], environment: NodeJS.ProcessEnv): Promise<VisualProcessResult> {
  const child = Bun.spawn(command, { cwd: ROOT, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stop = (): void => { child.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const deadline = setTimeout(stop, 13 * 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function requirePercyServer(environment: NodeJS.ProcessEnv): Promise<void> {
  let reason = "health-address";
  try {
    const address = new URL(environment.PERCY_SERVER_ADDRESS ?? "http://127.0.0.1:5338");
    if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || address.username || address.password || address.search || address.hash || address.pathname !== "/") throw new Error();
    reason = "health-unreachable";
    const response = await fetch(new URL("/percy/healthcheck", address), { signal: AbortSignal.timeout(5_000) });
    reason = "health-status";
    if (!response.ok) throw new Error();
    reason = "health-shape";
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object" || !("success" in body) || body.success !== true) throw new Error();
    reason = "health-type";
    if (!("type" in body) || body.type !== "web") throw new Error();
    reason = "health-build";
    if (!("build" in body) || body.build === null || typeof body.build !== "object" || !("id" in body.build) || !body.build.id) throw new Error();
  } catch { throw new Error(`visual upload: healthy Percy server required (${reason})`); }
}

export async function runVisual(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  run: VisualProcess = execute,
  resolveRuntime: VisualRuntimeResolver = Bun.which,
): Promise<void> {
  if (args.length !== 1 || (args[0] !== "local" && args[0] !== "upload")) throw new Error("visual: choose local or upload");
  const upload = args[0] === "upload";
  const clean = visualEnvironment(environment);
  delete clean.FORCE_COLOR;
  const playwright = [process.execPath, "x", "--no-install", "playwright", "test", "-c", CONFIG];
  if (upload && environment.OMP_VISUAL_PERCY_CHILD === "1") {
    try { await requirePercyServer(environment); }
    catch (error) {
      const code = error instanceof Error ? /^visual upload: healthy Percy server required \(([a-z-]+)\)$/u.exec(error.message)?.[1] : undefined;
      const reason = code && Object.hasOwn(RUNNER_REASONS, code) ? code : "health-rejected";
      process.stdout.write(`visual-runner: phase=server reason=${reason}\n`);
      throw new Error("visual upload: healthy Percy server required");
    }
    process.stdout.write("visual-runner: phase=server reason=healthy\n");
    const result = await run(playwright, { ...clean, PERCY_SERVER_ADDRESS: environment.PERCY_SERVER_ADDRESS ?? "http://127.0.0.1:5338", PERCY_LOGS_IN_MEMORY: "1", PERCY_CLIENT_ERROR_LOGS: "false", OMP_VISUAL_MODE: "upload", NO_COLOR: "" });
    for (const line of safeVisualLines(`${result.stdout}\n${result.stderr}`)) process.stdout.write(`${line}\n`);
    // The worker requires 18 submissions; only its owning CLI can finalize the build.
    const reasons = visualProcessReasons(result, true, false);
    for (const reason of reasons) process.stdout.write(`visual-runner: phase=playwright reason=${reason}\n`);
    if (reasons.length !== 0) throw new Error("visual upload: submissions failed");
    return;
  }
  if (upload && !environment.PERCY_TOKEN?.trim()) throw new Error(MISSING_TOKEN);
  // Percy is a Node CLI. Bun's http.Server compatibility can start its API without serving
  // requests, yielding a created build with zero snapshots. Keep our worker on pinned Bun.
  // Let the platform resolver honor Windows Path/PATHEXT and native delimiters. The real
  // environment is already inherited; an artificial uppercase PATH loses Windows resolution.
  const percyRuntime = upload ? resolveRuntime(environment.OMP_VISUAL_NODE_EXECUTABLE ?? "node") : undefined;
  if (upload && !percyRuntime) {
    process.stdout.write("visual-runner: phase=percy reason=node-missing\n");
    throw new Error(MISSING_NODE);
  }
  const build = await run([process.execPath, "run", "build"], clean);
  if (build.code !== 0) throw new Error("visual: build failed");
  if (!upload) {
    const result = await run(playwright, { ...clean, OMP_VISUAL_MODE: "local", NO_COLOR: "" });
    // Only emit the reporter's fixed grammar, never subprocess/browser/serializer diagnostics.
    for (const line of safeVisualLines(result.stdout)) process.stdout.write(`${line}\n`);
    assertVisualResult(result, false);
    return;
  }
  const result = await run([percyRuntime!, CLI_EXECUTABLE, "exec", "--", process.execPath, "scripts/test-visual.ts", "upload"], {
    ...clean,
    PERCY_TOKEN: environment.PERCY_TOKEN,
    PERCY_SERVER_HOST: "127.0.0.1",
    PERCY_BROWSER_EXECUTABLE: chromium.executablePath(),
    PERCY_LOGLEVEL: "info",
    PERCY_LOGS_IN_MEMORY: "1",
    PERCY_CLIENT_ERROR_LOGS: "false",
    PERCY_DROPIN_DISABLE: "true",
    OMP_VISUAL_PERCY_CHILD: "1",
    NO_COLOR: "1",
  });
  for (const line of safeVisualLines(`${result.stdout}\n${result.stderr}`)) process.stdout.write(`${line}\n`);
  if (result.stderr.replace(/\u001b\[[0-9;]*m/gu, "").split("\n").includes(PERCY_RUNTIME_NOTICE)) {
    process.stdout.write("visual-runner: phase=percy reason=cli-runtime-notice\n");
  }
  for (const reason of visualProcessReasons(result, true)) process.stdout.write(`visual-runner: phase=percy reason=${reason}\n`);
  assertVisualResult(result, true);
  process.stdout.write("visual upload: build finalized\n");
}

if (import.meta.main) {
  try { await runVisual(Bun.argv.slice(2), process.env); }
  catch (error) {
    const allowed = [MISSING_TOKEN, MISSING_NODE, "visual: choose local or upload", "visual: build failed", "visual local: validation failed", "visual upload: healthy Percy server required", "visual upload: submissions failed", "visual upload: incomplete or failed Percy build"];
    const message = error instanceof Error && allowed.includes(error.message) ? error.message : "visual: execution failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
