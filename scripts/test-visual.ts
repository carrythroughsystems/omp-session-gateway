import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { startDashboardFixture, type SyntheticFixtureAuthority } from "../apps/web/e2e/fixture-server.ts";
import { assertPercyLogsSafe } from "../apps/web/visual/snapshot-safety.ts";
import { VISUAL_CASE_COUNT, VISUAL_PHASES, VISUAL_PROJECTS, VISUAL_STATES, VISUAL_UPLOAD_REASONS } from "../apps/web/visual/safe-reporter.ts";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

export type VisualMode = "local" | "upload";
export interface VisualProcessResult { code: number; stdout: string; stderr: string }
export type VisualProcess = (command: string[], environment: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<VisualProcessResult>;
export type VisualRuntimeResolver = (executable: string) => string | null;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = createRequire(import.meta.url).resolve("@percy/cli");
// CLI's exported index is dist/index.js; its pinned package's executable is bin/run.cjs.
const CLI_EXECUTABLE = fileURLToPath(new URL("../bin/run.cjs", pathToFileURL(CLI)));
const CONFIG = "apps/web/playwright.visual.config.ts";
const MISSING_TOKEN = "visual upload: PERCY_TOKEN is required";
const MISSING_NODE = "visual upload: Node.js is required for Percy";
export const LOG_AUDIT_SUCCESS = `visual-audit: states=${VISUAL_CASE_COUNT} logs=passed planted=rejected`;
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
  "cli-http-401": true, "cli-http-403": true, "cli-http-429": true, "cli-http-5xx": true,
  "cli-dns-failed": true, "cli-connection-refused": true, "cli-timeout": true,
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
  ["cli-http-401", /\b(?:HTTP|status(?:Code)?)[: =]+401\b/iu],
  ["cli-http-403", /\b(?:HTTP|status(?:Code)?)[: =]+403\b/iu],
  ["cli-http-429", /\b(?:HTTP|status(?:Code)?)[: =]+429\b/iu],
  ["cli-http-5xx", /\b(?:HTTP|status(?:Code)?)[: =]+5\d\d\b/iu],
  ["cli-dns-failed", /\b(?:ENOTFOUND|EAI_AGAIN)\b/u],
  ["cli-connection-refused", /\bECONNREFUSED\b/u],
  ["cli-timeout", /\b(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/u],
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
    const summary = /^visual: validated=(\d{1,2}) queued=(\d{1,2}) outcome=(passed|failed)$/u.exec(line);
    if (summary && Number(summary[1]) <= VISUAL_CASE_COUNT && Number(summary[2]) <= Number(summary[1])) {
      lines.push(`visual: validated=${Number(summary[1])} queued=${Number(summary[2])} outcome=${summary[3]}`);
      continue;
    }
    const runner = /^visual-runner: phase=([a-z-]+) reason=([a-z0-9-]+)$/u.exec(line);
    if (runner && Object.hasOwn(RUNNER_PHASES, runner[1] ?? "") && Object.hasOwn(RUNNER_REASONS, runner[2] ?? "")) {
      lines.push(`visual-runner: phase=${runner[1]} reason=${runner[2]}`);
    }
  }
  return lines;
}

export function visualProcessReasons(result: VisualProcessResult, upload: boolean, requireFinalization = upload): string[] {
  const expected = `visual: validated=${VISUAL_CASE_COUNT} queued=${upload ? VISUAL_CASE_COUNT : 0} outcome=passed`;
  const reasons: string[] = [];
  if (result.code !== 0) reasons.push("child-exit");
  // The sole nonfatal diagnostic is the exact pinned entry-point announcement, not SDK output.
  const stderr = result.stderr.replace(/\u001b\[[0-9;]*m/gu, "").split("\n")
    .filter(line => !requireFinalization || line !== PERCY_RUNTIME_NOTICE).join("\n");
  const stdout = result.stdout.replace(/\u001b\[[0-9;]*m/gu, "");
  const categories: string[] = [];
  for (const line of [...stdout.split("\n"), ...stderr.split("\n")]) {
    if (requireFinalization && line === PERCY_RUNTIME_NOTICE) continue;
    for (const [category, pattern] of CLI_DIAGNOSTICS) {
      if (pattern.test(line) && !categories.includes(category)) categories.push(category);
    }
  }
  // All other warnings/errors remain fatal. Never print their contents.
  if (categories.length !== 0 || stderr.trim() !== "" || /Percy is not running|\bwarning\b|skipping visual tests|Percy is disabled/iu.test(stdout)) {
    reasons.push("sdk-warning");
    if (categories.length !== 0) reasons.push(...categories);
    else if (requireFinalization) reasons.push("cli-unknown-diagnostic");
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

async function execute(command: string[], environment: NodeJS.ProcessEnv, timeoutMs = 7 * HANG_DEADLINE_MS): Promise<VisualProcessResult> {
  const child = Bun.spawn(command, { cwd: ROOT, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stop = (): void => { child.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const deadline = setTimeout(stop, timeoutMs);
  const hardDeadline = setTimeout(() => child.kill("SIGKILL"), timeoutMs + HANG_DEADLINE_MS);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardDeadline);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

/**
 * Native-Node testing host: the full discovery/SDK/state suite, no vendor effects. A private pipe
 * supplies one ephemeral authority so the retained fixture guard covers every worker's logs.
 */
export async function runPercyLogAuditHost(bunExecutable: string): Promise<void> {
  // These transitive paths are selected through the installed, pinned CLI, not hoisted imports.
  const requirePercy = createRequire(CLI);
  const { default: Percy } = await import(pathToFileURL(requirePercy.resolve("@percy/core")).href);
  const { redactSecrets } = await import(pathToFileURL(requirePercy.resolve("@percy/core/utils")).href);
  const { default: logger } = await import(pathToFileURL(requirePercy.resolve("@percy/logger")).href);
  const authority: SyntheticFixtureAuthority = {
    roomId: "visualAudit" + randomBytes(8).toString("base64url"),
    encodedRoomKey: randomBytes(32).toString("base64url"),
    encodedControlEntropy: randomBytes(16).toString("base64url"),
  };
  const fixture = await startDashboardFixture([], { syntheticAuthority: authority });
  const directory = process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "opv-"));
  const pipe = directory === undefined ? `\\\\.\\pipe\\omp-percy-audit-${randomUUID()}` : join(directory, "s");
  const authorityServer = createServer(socket => socket.end(JSON.stringify(authority)));
  const percy = new Percy({ testing: true, port: 0, projectType: "web", token: "web_local-synthetic-testing-only" });
  percy.skipDiscovery = false;
  percy.testing.build = { id: "local-synthetic-build" };
  let failed = false;
  let phase = "setup";
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      authorityServer.once("error", rejectListen);
      authorityServer.listen(pipe, resolveListen);
    });
    if (directory !== undefined) await chmod(pipe, 0o600);
    await percy.start();
    phase = "suite";
    const child = spawn(bunExecutable, ["scripts/test-visual.ts", "upload"], {
      cwd: ROOT,
      env: {
        ...visualEnvironment(process.env),
        PERCY_SERVER_ADDRESS: percy.address(),
        PERCY_LOGS_IN_MEMORY: "1",
        PERCY_CLIENT_ERROR_LOGS: "false",
        OMP_VISUAL_PERCY_CHILD: "1",
        OMP_VISUAL_AUDIT_PIPE: pipe,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    const deadline = setTimeout(() => child.kill("SIGTERM"), 3 * HANG_DEADLINE_MS);
    const hardDeadline = setTimeout(() => child.kill("SIGKILL"), 4 * HANG_DEADLINE_MS);
    try {
      const code = await new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", resolveExit);
      });
      if (visualProcessReasons({ code: code ?? 1, stdout, stderr }, true, false).length !== 0) throw new Error();
    } finally {
      clearTimeout(deadline);
      clearTimeout(hardDeadline);
    }
    const requests = percy.testing.requests ?? [];
    if (!percy.browser.isConnected() ||
      requests.filter((request: { method: string; url: string }) => request.method === "POST" && request.url === "/percy/snapshot").length !== VISUAL_CASE_COUNT) throw new Error();
    const readCliLogs = async (): Promise<unknown[]> => {
      const response = await fetch(new URL("/test/logs", percy.address()), { signal: AbortSignal.timeout(HANG_DEADLINE_MS) });
      const body: unknown = await response.json();
      if (!response.ok || body === null || typeof body !== "object" || !("logs" in body) || !Array.isArray(body.logs)) throw new Error();
      // Exactly the selection used by @percy/core sendBuildLogs; CI-stream entries are excluded.
      return body.logs.filter(entry => !(entry !== null && typeof entry === "object" && "debug" in entry && entry.debug === "ci"));
    };
    phase = "logs";
    assertPercyLogsSafe(redactSecrets(await readCliLogs()), fixture);
    phase = "planted";
    // Memory-only SDK namespace; testing mode never calls sendBuildLogs or uploads this canary.
    logger("sdk").error(authority.roomId.slice(0, 16));
    let rejected = false;
    try { assertPercyLogsSafe(redactSecrets(await readCliLogs()), fixture); }
    catch { rejected = true; }
    if (!rejected) throw new Error();
  } catch {
    failed = true;
  } finally {
    const cleanup = await Promise.allSettled([
      percy.stop(),
      fixture.stop(),
      new Promise<void>(resolveClose => authorityServer.close(() => resolveClose())),
    ]);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    logger.instance.reset();
    failed ||= cleanup.some(result => result.status === "rejected");
  }
  if (failed) throw new Error(`visual log audit: ${phase} failed`);
  process.stdout.write(`${LOG_AUDIT_SUCCESS}\n`);
}

export async function requirePercyServer(environment: NodeJS.ProcessEnv): Promise<void> {
  let reason = "health-address";
  try {
    const address = new URL(environment.PERCY_SERVER_ADDRESS ?? "http://127.0.0.1:5338");
    if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || address.username || address.password || address.search || address.hash || address.pathname !== "/") throw new Error();
    reason = "health-unreachable";
    const response = await fetch(new URL("/percy/healthcheck", address), { signal: AbortSignal.timeout(HANG_DEADLINE_MS) });
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

async function runVisualProcess(
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
    const result = await run(playwright, {
      ...clean, PERCY_SERVER_ADDRESS: environment.PERCY_SERVER_ADDRESS ?? "http://127.0.0.1:5338",
      PERCY_LOGS_IN_MEMORY: "1", PERCY_CLIENT_ERROR_LOGS: "false", OMP_VISUAL_MODE: "upload", NO_COLOR: "",
      ...(environment.OMP_VISUAL_AUDIT_PIPE === undefined ? {} : { OMP_VISUAL_AUDIT_PIPE: environment.OMP_VISUAL_AUDIT_PIPE }),
    });
    for (const line of safeVisualLines(`${result.stdout}\n${result.stderr}`)) process.stdout.write(`${line}\n`);
    // The worker requires every state/project submission; only its owning CLI can finalize the build.
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
  const auditScript = `import { runPercyLogAuditHost } from ${JSON.stringify(import.meta.url)}; try { await runPercyLogAuditHost(process.argv[1]); } catch { process.stderr.write("visual log audit: failed\\n"); process.exitCode = 1; }`;
  const audit = await run([percyRuntime!, "--input-type=module", "--eval", auditScript, process.execPath], {
    ...clean, PERCY_SERVER_HOST: "127.0.0.1", PERCY_BROWSER_EXECUTABLE: chromium.executablePath(),
    PERCY_LOGS_IN_MEMORY: "1", PERCY_CLIENT_ERROR_LOGS: "false", PERCY_DROPIN_DISABLE: "true",
    // No responsive recapture: also prevents the core's unnecessary startup device lookup.
    PERCY_DO_NOT_CAPTURE_RESPONSIVE_ASSETS: "true",
  }, 5 * HANG_DEADLINE_MS);
  if (audit.code !== 0 || audit.stderr.trim() !== "" || !audit.stdout.split("\n").includes(LOG_AUDIT_SUCCESS)) {
    throw new Error("visual upload: log audit failed");
  }
  process.stdout.write(`${LOG_AUDIT_SUCCESS}\n`);
  const result = await run([percyRuntime!, CLI_EXECUTABLE, "exec", "--", process.execPath, "scripts/test-visual.ts", "upload"], {
    ...clean,
    PERCY_TOKEN: environment.PERCY_TOKEN,
    PERCY_SERVER_HOST: "127.0.0.1",
    PERCY_BROWSER_EXECUTABLE: chromium.executablePath(),
    PERCY_LOGLEVEL: "info",
    PERCY_LOGS_IN_MEMORY: "1",
    PERCY_CLIENT_ERROR_LOGS: "false",
    PERCY_DROPIN_DISABLE: "true",
    PERCY_DO_NOT_CAPTURE_RESPONSIVE_ASSETS: "true",
    OMP_VISUAL_PERCY_CHILD: "1",
    NO_COLOR: "1",
  });
  for (const line of safeVisualLines(`${result.stdout}\n${result.stderr}`)) process.stdout.write(`${line}\n`);
  if (result.stderr.replace(/\u001b\[[0-9;]*m/gu, "").split("\n").includes(PERCY_RUNTIME_NOTICE)) {
    process.stdout.write("visual-runner: phase=percy reason=cli-runtime-notice\n");
  }
  for (const reason of visualProcessReasons(result, true)) process.stdout.write(`visual-runner: phase=percy reason=${reason}\n`);
  assertVisualResult(result, true);
  process.stdout.write(`visual upload: submitted=${VISUAL_CASE_COUNT} build finalized\n`);
}

/** Persist only reconstructed, closed-set diagnostics, never vendor text, URLs or credentials. */
export async function runVisual(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  run: VisualProcess = execute,
  resolveRuntime: VisualRuntimeResolver = Bun.which,
): Promise<void> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const reasons = new Set<string>();
  let summary = { validated: 0, queued: 0, outcome: "failed" };
  let passed = false;
  try {
    await runVisualProcess(args, environment, async (command, childEnvironment, timeoutMs) => {
      const result = await run(command, childEnvironment, timeoutMs);
      const lines = safeVisualLines(`${result.stdout}\n${result.stderr}`);
      stdout.push(...safeVisualLines(result.stdout));
      stderr.push(...safeVisualLines(result.stderr));
      for (const line of lines) {
        const code = /^visual-runner: phase=[a-z-]+ reason=([a-z0-9-]+)$/u.exec(line)?.[1];
        if (code && code !== "healthy") reasons.add(code);
        const counts = /^visual: validated=(\d+) queued=(\d+) outcome=(passed|failed)$/u.exec(line);
        if (counts) summary = { validated: Number(counts[1]), queued: Number(counts[2]), outcome: counts[3]! };
      }
      if (command[1] === CLI_EXECUTABLE) {
        for (const code of visualProcessReasons(result, true)) {
          reasons.add(code);
          stderr.push(`visual-runner: phase=percy reason=${code}`);
        }
      }
      return result;
    }, resolveRuntime);
    passed = true;
  } catch (error) {
    const fixedReason = error instanceof Error ? ({
      [MISSING_TOKEN]: "token-missing",
      [MISSING_NODE]: "node-missing",
      "visual upload: log audit failed": "log-audit-failed",
      "visual: build failed": "build-failed",
    } as Record<string, string>)[error.message] : undefined;
    if (fixedReason) reasons.add(fixedReason);
    if (reasons.size === 0) reasons.add("execution-failed");
    throw error;
  } finally {
    const directory = environment.OMP_VISUAL_EVIDENCE_DIR;
    if (directory && (args[0] === "local" || args[0] === "upload")) {
      const mode = args[0];
      if (!passed) summary.outcome = "failed";
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(join(directory, `${mode}-stdout.log`), stdout.join("\n") + "\n"),
        writeFile(join(directory, `${mode}-stderr.log`), stderr.join("\n") + "\n"),
        writeFile(join(directory, `${mode}-summary.json`), JSON.stringify(summary) + "\n"),
      ]);
      if (mode === "upload" && environment.GITHUB_STEP_SUMMARY) {
        let localPassed = false;
        try {
          const local = JSON.parse(await readFile(join(directory, "local-summary.json"), "utf8"));
          localPassed = local.validated === VISUAL_CASE_COUNT && local.queued === 0 && local.outcome === "passed";
        } catch { /* Absent or invalid local evidence cannot claim a passed validation. */ }
        await appendFile(environment.GITHUB_STEP_SUMMARY,
          `visual upload ${passed ? "PASSED: finalized" : `FAILED (advisory): ${[...reasons].join(", ")}`}; local visual validation ${localPassed ? "PASSED" : "FAILED"}\n`);
      }
    }
  }
}

if (import.meta.main) {
  try { await runVisual(Bun.argv.slice(2), process.env); }
  catch (error) {
    const allowed = [MISSING_TOKEN, MISSING_NODE, "visual: choose local or upload", "visual: build failed", "visual local: validation failed", "visual upload: healthy Percy server required", "visual upload: submissions failed", "visual upload: log audit failed", "visual upload: incomplete or failed Percy build"];
    const message = error instanceof Error && allowed.includes(error.message) ? error.message : "visual: execution failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
