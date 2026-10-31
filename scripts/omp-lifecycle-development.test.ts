import { expect, test, setDefaultTimeout } from "bun:test";
import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrivatePublication, parseDevelopmentArgs } from "./omp-lifecycle-development.ts";
import upstream from "../UPSTREAM.lock.json";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

test("development mode requires an explicit opt-in for a non-baseline version and rejects malformed flags", () => {
  expect(parseDevelopmentArgs(["--omp", "/synthetic/dist/cli.js"])).toEqual({
    omp: "/synthetic/dist/cli.js", isolatedHome: false, expectedVersion: upstream.packageVersion,
  });
  expect(parseDevelopmentArgs(["--omp", "/synthetic/omp", "--isolated-home", "--expect-version", "18.12.6"])).toEqual({
    omp: "/synthetic/omp", isolatedHome: true, expectedVersion: "18.12.6",
  });
  for (const args of [
    ["--omp", "/synthetic/omp", "--expect-version", "18.12.6"],
    ["--omp", "/synthetic/omp", "--isolated-home", "--expect-version"],
    ["--omp", "/synthetic/omp", "--isolated-home", "--expect-version", "latest"],
    ["--omp", "/synthetic/omp", "--isolated-home", "--isolated-home"],
    ["--omp", "relative/omp"],
  ]) expect(() => parseDevelopmentArgs(args)).toThrow("invalid lifecycle development arguments");
});

test.skipIf(process.platform === "win32")("publication proof rejects shared directory and file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-seam-permissions-"));
  const entry = join(directory, "synthetic.json");
  try {
    await writeFile(entry, "{}\n", { mode: 0o600 });
    await assertPrivatePublication(directory);
    await chmod(directory, 0o750);
    await expect(assertPrivatePublication(directory)).rejects.toThrow("discovery directory is not private");
    await chmod(directory, 0o700);
    await chmod(entry, 0o640);
    await expect(assertPrivatePublication(directory)).rejects.toThrow("discovery file is not private");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Exercise the real CLI parser and fail-closed setup, not a mocked OMP/gateway boundary.
test("isolated-HOME proof accepts its native-executable mode and refuses a missing OMP before effects", async () => {
  const child = Bun.spawn([process.execPath, "scripts/omp-lifecycle-development.ts", "--omp", "/nonexistent/stock-omp", "--isolated-home", "--expect-version", "18.12.6"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    passed: false, reason: "lifecycle development setup failed", cleanup: { stopped: true, privateRootRemoved: true },
  });
});
