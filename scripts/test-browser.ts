import { fileURLToPath } from "node:url";
import { appendFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BROWSER_REPORT_PATH, browserFlakeSummary, browserReportMetadata, isBrowserCI,
  parseBrowserFlakeReport, type BrowserReportMetadata,
} from "./browser-flake-reporter.ts";

export async function completeBrowserRun(
  code: number, path: string, metadata: BrowserReportMetadata, required: boolean, summaryPath?: string,
): Promise<number> {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > 8 * 1_024 * 1_024) throw new Error("oversized report");
    const report = parseBrowserFlakeReport(JSON.parse(text));
    for (const key of ["runId", "runAttempt", "sha", "lane"] as const) {
      if (report[key] !== metadata[key]) throw new Error("foreign report");
    }
    if (summaryPath !== undefined) await appendFile(summaryPath, browserFlakeSummary(report));
  } catch {
    if (required) {
      process.stderr.write("required browser flake report or summary unavailable; details withheld\n");
      if (summaryPath !== undefined) {
        await appendFile(summaryPath, "Browser flake evidence unavailable or invalid; counts withheld.\n").catch(() => undefined);
      }
      return code === 0 ? 1 : code;
    }
  }
  return code;
}

async function main(): Promise<number> {
  // `--compat` selects the browser-neutral lane; other arguments pass through to Playwright.
  const args = Bun.argv.slice(2);
  const compat = args.includes("--compat");
  const lane = compat ? "browser-core" : "browser-notifications";
  const config = compat ? "apps/web/playwright.compat.config.ts" : "apps/web/playwright.config.ts";
  const root = fileURLToPath(new URL("..", import.meta.url));
  const path = resolve(root, BROWSER_REPORT_PATH);
  const summaryOnly = args.includes("--summary-only");
  const required = isBrowserCI(process.env.CI);
  try {
    const checkout = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (checkout.exitCode !== 0) throw new Error("checkout unavailable");
    const env = { ...process.env, OMP_BROWSER_TEST_SHA: checkout.stdout.toString().trim(), OMP_BROWSER_LANE: lane, OMP_BROWSER_FLAKE_REPORT: path, NO_COLOR: "" };
    const metadata = browserReportMetadata(env, lane);
    if (summaryOnly) return completeBrowserRun(0, path, metadata, true, process.env.GITHUB_STEP_SUMMARY);
    // Never accept a prior invocation's report when Playwright or its reporter cannot start.
    await rm(path, { force: true });
    const playwright = Bun.spawn(
      [process.execPath, "x", "playwright", "test", "-c", config, ...args.filter(arg => arg !== "--compat")],
      { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    return completeBrowserRun(await playwright.exited, path, metadata, required);
  } catch {
    process.stderr.write("browser test/report setup failed; details withheld\n");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
