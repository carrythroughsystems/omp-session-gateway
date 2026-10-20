import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

export type VisualMode = "local" | "upload";
export interface VisualProcessResult { code: number; stdout: string; stderr: string }
export type VisualProcess = (command: string[], environment: NodeJS.ProcessEnv) => Promise<VisualProcessResult>;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = createRequire(import.meta.url).resolve("@percy/cli");
// CLI's exported index is dist/index.js; its pinned package's executable is bin/run.cjs.
const CLI_EXECUTABLE = fileURLToPath(new URL("../bin/run.cjs", pathToFileURL(CLI)));
const CONFIG = "apps/web/playwright.visual.config.ts";
const MISSING_TOKEN = "visual upload: PERCY_TOKEN is required";

export function visualEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("PERCY_") && !key.startsWith("OMP_VISUAL_") && !key.startsWith("__PERCY_")));
}

export function assertVisualResult(result: VisualProcessResult, upload: boolean): void {
  const expected = `visual: validated=18 submitted=${upload ? 18 : 0} outcome=passed`;
  // Warnings/errors use stderr at info loglevel in the pinned CLI. Do not print their contents.
  if (result.code !== 0 || result.stderr.trim() !== "" || !result.stdout.split("\n").includes(expected) ||
    /Percy is not running|\bwarning\b|skipping visual tests|Percy is disabled/iu.test(result.stdout) ||
    (upload && !/\[percy\] Finalized build #\d+:/u.test(result.stdout.replace(/\u001b\[[0-9;]*m/gu, "")))) {
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
  try {
    const address = new URL(environment.PERCY_SERVER_ADDRESS ?? "http://127.0.0.1:5338");
    if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || address.username || address.password || address.search || address.hash || address.pathname !== "/") throw new Error();
    const response = await fetch(new URL("/percy/healthcheck", address), { signal: AbortSignal.timeout(5_000) });
    const body: unknown = await response.json();
    if (!response.ok || body === null || typeof body !== "object" || !("success" in body) || body.success !== true ||
      !("type" in body) || body.type !== "web" || !("build" in body) || body.build === null || typeof body.build !== "object" ||
      !("id" in body.build) || !body.build.id) throw new Error();
  } catch { throw new Error("visual upload: healthy Percy server required"); }
}

export async function runVisual(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  run: VisualProcess = execute,
): Promise<void> {
  if (args.length !== 1 || (args[0] !== "local" && args[0] !== "upload")) throw new Error("visual: choose local or upload");
  const upload = args[0] === "upload";
  const clean = visualEnvironment(environment);
  delete clean.FORCE_COLOR;
  const playwright = [process.execPath, "x", "--no-install", "playwright", "test", "-c", CONFIG];
  if (upload && environment.OMP_VISUAL_PERCY_CHILD === "1") {
    await requirePercyServer(environment);
    const result = await run(playwright, { ...clean, PERCY_SERVER_ADDRESS: environment.PERCY_SERVER_ADDRESS ?? "http://127.0.0.1:5338", PERCY_LOGS_IN_MEMORY: "1", PERCY_CLIENT_ERROR_LOGS: "false", OMP_VISUAL_MODE: "upload", NO_COLOR: "" });
    if (result.code !== 0 || result.stderr.trim() !== "" || !result.stdout.includes("visual: validated=18 submitted=18 outcome=passed")) throw new Error("visual upload: submissions failed");
    process.stdout.write("visual: validated=18 submitted=18 outcome=passed\n");
    return;
  }
  if (upload && !environment.PERCY_TOKEN?.trim()) throw new Error(MISSING_TOKEN);
  const build = await run([process.execPath, "run", "build"], clean);
  if (build.code !== 0) throw new Error("visual: build failed");
  if (!upload) {
    const result = await run(playwright, { ...clean, OMP_VISUAL_MODE: "local", NO_COLOR: "" });
    // Only emit the reporter's fixed grammar, never subprocess/browser/serializer diagnostics.
    for (const line of result.stdout.split("\n")) {
      if (/^visual: (?:[a-z-]+ \/ visual-(?:phone-390x844|tablet-810x1080|desktop-1280x800): (?:passed|failed phase=[a-z-]+)|validated=\d+ submitted=0 outcome=(?:passed|failed))$/u.test(line)) process.stdout.write(`${line}\n`);
    }
    assertVisualResult(result, false);
    return;
  }
  const result = await run([process.execPath, CLI_EXECUTABLE, "exec", "--", process.execPath, "scripts/test-visual.ts", "upload"], {
    ...clean,
    PERCY_TOKEN: environment.PERCY_TOKEN,
    PERCY_SERVER_HOST: "127.0.0.1",
    PERCY_BROWSER_EXECUTABLE: chromium.executablePath(),
    PERCY_LOGLEVEL: "info",
    PERCY_LOGS_IN_MEMORY: "1",
    PERCY_CLIENT_ERROR_LOGS: "false",
    OMP_VISUAL_PERCY_CHILD: "1",
    NO_COLOR: "1",
  });
  assertVisualResult(result, true);
  process.stdout.write("visual: validated=18 submitted=18 outcome=passed\nvisual upload: build finalized\n");
}

if (import.meta.main) {
  try { await runVisual(Bun.argv.slice(2), process.env); }
  catch (error) {
    const allowed = [MISSING_TOKEN, "visual: choose local or upload", "visual: build failed", "visual local: validation failed", "visual upload: healthy Percy server required", "visual upload: submissions failed", "visual upload: incomplete or failed Percy build"];
    const message = error instanceof Error && allowed.includes(error.message) ? error.message : "visual: execution failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
