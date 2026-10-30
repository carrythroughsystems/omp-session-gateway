/**
 * Runs the repository test suite on the current host OS, minus the files that are bound to another
 * host. `portable-source` runs this on Linux, macOS, and Windows for every change, so a new test is
 * cross-platform by default: excluding one takes an entry here, with its platform and reason.
 *
 * An exclusion means "cannot run unchanged on this OS", never "flaky": nothing here retries, and a
 * file that fails anywhere it is not excluded fails the job.
 */
import { fileURLToPath } from "node:url";
import { HANG_DEADLINE_MS } from "./test-support.ts";

interface HostBoundTest {
  readonly platforms: readonly NodeJS.Platform[];
  readonly reason: string;
}

export const HOST_BOUND_TESTS: Readonly<Record<string, HostBoundTest>> = {
  "apps/gateway/test/ci-workflow.test.ts": {
    platforms: ["win32"],
    reason: "executes ci.yml's bash dispatch guards against a Unix-domain socket",
  },
  "apps/gateway/test/cli.test.ts": {
    platforms: ["win32"],
    reason: "asserts XDG config paths and cannot isolate the host's Task Scheduler; windows-service-lifecycle installs the CLI for real",
  },
  "apps/gateway/test/doctor.test.ts": {
    platforms: ["win32"],
    reason: "seeds gateway config under XDG paths, which Windows does not read",
  },
  "apps/gateway/test/push.test.ts": {
    platforms: ["win32"],
    reason: "asserts POSIX file modes on push state; Windows protects it with the profile ACL",
  },
  "scripts/stable-qualification.test.ts": {
    platforms: ["win32"],
    reason: "asserts POSIX receipt modes and a Darwin-arm64 qualification host",
  },
  "scripts/testingbot.test.ts": {
    platforms: ["win32"],
    reason: "asserts a POSIX 0600 token file and drives stand-in tunnels through /bin/sh, lsof, and ps, as on the macOS qualification host",
  },
};

export function portableTestFiles(tracked: readonly string[], platform: NodeJS.Platform): string[] {
  return tracked.filter(file => HOST_BOUND_TESTS[file]?.platforms.includes(platform) !== true).sort();
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const listing = Bun.spawnSync(["git", "ls-files", "*.test.ts"], { cwd: root, stdout: "pipe", stderr: "inherit" });
  if (listing.exitCode !== 0) throw new Error("git ls-files failed");
  const tracked = new TextDecoder().decode(listing.stdout).split(/\r?\n/u).filter(Boolean);
  const files = portableTestFiles(tracked, process.platform);
  const excluded = tracked.length - files.length;
  console.log(`portable tests on ${process.platform}: ${files.length} files, ${excluded} host-bound excluded`);
  // Explicit ./paths make bun treat each argument as a file rather than a name filter. Leave room
  // beyond a real-process hang budget for each test's setup and teardown.
  const child = Bun.spawn([process.execPath, "test", "--timeout", String(2 * HANG_DEADLINE_MS), ...files.map(file => `./${file}`)], {
    cwd: root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
