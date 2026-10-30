import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { assertMacExposureEvidence, loadConfiguredMacTarget, parseStableQualificationArgs } from "./stable-qualification.ts";
import { PRODUCT_VERSION } from "./build-release.ts";

const POSIX = process.platform !== "win32";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts/qualify-macos-host.sh");
const ompScriptPath = join(repositoryRoot, "scripts/qualify-macos-omp.sh");
const sudoPassword = "mac-sudo-'argv-canary";

test.skipIf(!POSIX)("Mac install forwards only the explicit qualification log option through its restart", async () => {
  const result = await runHarness('source "$1"; remote() { cat; }; DNS_NAME=synthetic.invalid; lane_install', [], {
    ...environment("a".repeat(64)), OMP_MAC_QUALIFICATION_LOG_DIR: "/private/qualification-logs/synthetic",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('qualification_log_args=(--qualification-log-dir "/private/qualification-logs/synthetic")');
  expect(result.stdout).toContain('install --origin "https://synthetic.invalid" --allow "$LOGIN" "${qualification_log_args[@]}"');
  expect(result.stdout).toContain('rotate-readiness-token "${qualification_log_args[@]}"');
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function environment(archiveSha256: string): Record<string, string | undefined> {
  return {
    ...process.env,
    OMP_MAC_HOST: "synthetic@example.invalid",
    OMP_MAC_TAG: "v0.4.0-prealpha.1",
    OMP_MAC_PREVIOUS_TAG: "v0.3.0",
    OMP_MAC_LOGIN: "synthetic@example.invalid",
    OMP_MAC_ARCHIVE_SHA256: archiveSha256,
    OMP_MAC_SUDO_PW: sudoPassword,
  };
}

async function runHarness(
  harness: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const journalRoot = await mkdtemp(join(tmpdir(), "mac-harness-journal-"));
  try {
    const child = Bun.spawn(["/bin/bash", "-c", harness, "test", scriptPath, ...args], {
      cwd: repositoryRoot,
      env: { ...env, TMPDIR: journalRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally { await rm(journalRoot, { recursive: true, force: true }); }
}

const cleanupVersion = "18.1.20";
const cleanupSourceTree = "12345678deadbeef";

function cleanupPaths(home: string) {
  const source = join(home, "src", `oh-my-pi-gateway-v${cleanupVersion}`);
  const versionDirectory = join(
    home,
    ".local",
    "lib",
    "omp-session-gateway",
    "omp",
    `v${cleanupVersion}-${cleanupSourceTree.slice(0, 8)}`,
  );
  return {
    source,
    sourceMarker: join(source, "owned-source"),
    binary: join(versionDirectory, "omp"),
    symlink: join(home, ".local", "bin", "omp"),
  };
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function runOmpCleanup(
  home: string,
  sessionLabel = "synthetic-clean",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const fakeBin = join(home, "test-bin");
  const fakePgrep = join(fakeBin, "pgrep");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakePgrep, "#!/bin/sh\nexit 1\n");
  await chmod(fakePgrep, 0o755);

  const cleanup = Bun.spawn(["/bin/bash", ompScriptPath, "clean"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      OMP_QUAL_GATEWAY_ROOT: join(home, "gateway"),
      OMP_QUAL_SESSION_LABEL: sessionLabel,
      OMP_PIN_SOURCE_COMMIT: "source",
      OMP_PIN_SOURCE_TREE: cleanupSourceTree,
      OMP_PIN_VERSION: cleanupVersion,
      OMP_PIN_BUN_VERSION: "1.4.4",
      OMP_PIN_NATIVE_TARBALL_SHA256: "tarball",
      OMP_PIN_NATIVE_BINARY_SHA256: "binary",
      OMP_QUAL_NATIVE_FIXTURE: join(home, "native-fixture"),
      OMP_QUAL_BUILD_LOG: join(home, "build.log"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    cleanup.exited,
    new Response(cleanup.stdout).text(),
    new Response(cleanup.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test.skipIf(!POSIX)("Mac preflight rejects a stale Bun before staging any lane", async () => {
  const result = await runHarness(`
set -euo pipefail
source "$1"
need_command() { :; }
remote() { eval "$(cat)"; }
bun() { printf '0.0.0\\n'; }
PW=""
preflight
printf 'LANE_REACHED\\n'
`, [], environment("a".repeat(64)));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Mac qualification requires Bun");
  expect(result.stderr).toContain("found 0.0.0");
  expect(result.stdout).not.toContain("LANE_REACHED");
});

test.skipIf(!POSIX).each([
  ["missing", "MISSING"],
  ["too old", "omp/18.1.19"],
  ["prerelease", "omp/18.4.8-rc.1"],
  ["malformed", "omp/18.4.8\nprivate-diagnostic"],
] as const)("Mac preflight rejects %s stock OMP before sudo or any lane", async (_reason, banner) => {
  const root = await mkdtemp(join(tmpdir(), "omp-mac-preflight-omp-"));
  const effect = join(root, "unexpected-effect");
  try {
    const result = await runHarness(`
set -euo pipefail
source "$1"
need_command() { :; }
remote() { eval "$(cat)"; }
bun() { if [ "$1" = --version ]; then printf '%s\n' "$BUN_VERSION"; else "$REAL_BUN" "$@"; fi; }
omp() { [ "$OMP_BANNER" != MISSING ] || return 127; printf '%s\n' "$OMP_BANNER"; }
sudo() { : >"$EFFECT_MARKER"; return 1; }
tailscale() { return 1; }
ifconfig() { return 1; }
lane_install() { : >"$EFFECT_MARKER"; }
PW=""
main install
`, [], { ...environment("a".repeat(64)), REAL_BUN: process.execPath, OMP_BANNER: banner, EFFECT_MARKER: effect });
    const pins = JSON.parse(await readFile(join(repositoryRoot, "UPSTREAM.lock.json"), "utf8"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("stock OMP >=18.1.20");
    expect(result.stderr).toContain("bun add --global --exact @oh-my-pi/pi-coding-agent@" + pins.packageVersions["@oh-my-pi/pi-coding-agent"]);
    expect(result.stdout + result.stderr).not.toContain("private-diagnostic");
    expect(await Bun.file(effect).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("Mac host evidence ignores a sysctl planted in the account's Bun directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-mac-hardware-path-"));
  const home = join(root, "home");
  const bin = join(home, ".bun", "bin");
  const planted = join(root, "planted-called");
  const measured = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "hw.model"], { stdout: "pipe", stderr: "pipe" });
  expect(measured.exitCode).toBe(0);
  const model = Buffer.from(measured.stdout).toString().trim();
  try {
    await mkdir(bin, { recursive: true });
    for (const command of ["sysctl", "uname", "sw_vers"]) {
      await writeFile(join(bin, command), "#!/bin/sh\nprintf '%s\\n' Mac99999,1\n: >\"$PLANTED_CALLED\"\n", { mode: 0o700 });
    }
    const pins = JSON.parse(await readFile(join(repositoryRoot, "UPSTREAM.lock.json"), "utf8"));
    const result = await runHarness("set -euo pipefail\nsource \"$1\"\nneed_command() { :; }\nbun() { if [ \"$1\" = --version ]; then printf '%s\\n' \"$EXPECTED_BUN\"; else \"$REAL_BUN\" \"$@\"; fi; }\ntailscale() { printf '%s\\n' '{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"fixture.invalid.\"}}'; }\nifconfig() { printf '%s\\n' 'inet6 fd7a:115c:a1e0::1'; }\nsudo() { return 0; }\nomp() { printf 'omp/18.1.20\\n'; }\nexport -f bun tailscale ifconfig sudo omp\nssh() { /bin/bash -c \"${!#}\"; }\npreflight", [], {
      ...environment("a".repeat(64)), HOME: home, PATH: bin + ":" + process.env.PATH,
      EXPECTED_BUN: pins.bunVersion, REAL_BUN: process.execPath, PLANTED_CALLED: planted, OMP_MAC_SUDO_PW: "",
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result.stdout.match(/^\s*hardware:\s+(\S+)/mu)?.[1]).toBe(model);
    expect(await Bun.file(planted).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX).each(["not executable", "not owner-executable", "directory"] as const)("Mac reboot guard %s refuses preflight before sudo, lanes or receipts", async kind => {
  const root = await mkdtemp(join(tmpdir(), "omp-mac-guard-"));
  const guard = join(root, ".config", "omp-qualification", "reboot-guard");
  const effect = join(root, "effect");
  const receipt = join(root, "receipts");
  try {
    await mkdir(dirname(guard), { recursive: true });
    if (kind === "directory") await mkdir(guard);
    else await writeFile(guard, "#!/bin/sh\nprintf 'release runner busy\\n' >&2\nexit 1\n", { mode: kind === "not executable" ? 0o600 : 0o601 });
    const result = await runHarness(`
set -euo pipefail
source "$1"
need_command() { :; }
bun() { if [ "$1" = --version ]; then printf '%s\n' "$BUN_VERSION"; else "$REAL_BUN" "$@"; fi; }
omp() { printf 'omp/18.1.20\n'; }
sudo() { : >"$EFFECT_MARKER"; return 1; }
tailscale() { return 1; }
ifconfig() { return 1; }
export -f bun omp sudo tailscale ifconfig
ssh() { /bin/bash -c "\${!#}"; }
lane_install() { : >"$EFFECT_MARKER"; }
main install
`, [], { ...environment("a".repeat(64)), HOME: root, REAL_BUN: process.execPath, EFFECT_MARKER: effect, OMP_MAC_RECORD_DIR: receipt });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("the host's reboot guard must be a regular, owner-executable file: " + guard);
    expect(await pathEntryExists(effect)).toBe(false);
    expect(await pathEntryExists(receipt)).toBe(false);
    expect(result.stdout).not.toContain("Lane ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("503 Mac reboot guard runs only immediately before shutdown and bounds refusal output to 400 bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-mac-guard-race-"));
  const guard = join(root, ".config", "omp-qualification", "reboot-guard");
  const shutdown = join(root, "shutdown");
  const busy = "release runner busy: " + "x".repeat(500);
  try {
    await mkdir(dirname(guard), { recursive: true });
    await mkdir(join(root, ".config", "omp-session-gateway"), { recursive: true });
    await writeFile(join(root, ".config", "omp-session-gateway", "readiness-token"), "synthetic-readiness-token");
    await writeFile(guard, '#!/bin/sh\n[ "$#" = 0 ] || exit 2\n[ "$PATH" = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin" ] || exit 3\nprintf "invoked\\n" >>"$HOME/guard-invoked"\nprintf "%s" ' + JSON.stringify(busy) + '\nexit 1\n', { mode: 0o700 });
    const result = await runHarness(`
set -euo pipefail
source "$1"
need_command() { :; }
bun() { if [ "$1" = --version ]; then printf '%s\n' "$BUN_VERSION"; else "$REAL_BUN" "$@"; fi; }
omp() { printf 'omp/18.1.20\n'; }
tailscale() { printf '%s\n' '{"BackendState":"Running","Self":{"DNSName":"fixture.invalid."}}'; }
ifconfig() { printf '%s\n' 'inet6 fd7a:115c:a1e0::1'; }
sudo() { if [ "\${*: -3}" = 'shutdown -r now' ]; then : >"$SHUTDOWN_MARKER"; fi; }
sysctl() { if [ "$*" = '-n kern.bootsessionuuid' ]; then printf '11111111-1111-4111-8111-111111111111\\n'; else command sysctl "$@"; fi; }
sleep() { exit 99; }
export -f bun omp tailscale ifconfig sudo sysctl
ssh() { /bin/bash -c "\${!#}"; }
main persistence
`, [], { ...environment("a".repeat(64)), HOME: root, REAL_BUN: process.execPath, SHUTDOWN_MARKER: shutdown });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Lane 4: reboot and login persistence");
    expect(result.stderr).toContain("the host's reboot guard refused: " + busy.slice(0, 400));
    expect(result.stderr).not.toContain(busy.slice(0, 401));
    expect(result.stdout).not.toContain("reboot issued");
    expect(await readFile(join(root, "guard-invoked"), "utf8")).toBe("invoked\n");
    expect(await pathEntryExists(shutdown)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("Mac reboot request returns while the remote session never closes, and still reboots", async () => {
  // A guest behind a tailnet TUN sends no FIN when it reboots: the session that issued
  // `shutdown -r now` stayed open for the orchestrator's whole Mac budget on 2026-10-02.
  // The remote block must return before the reboot, with the shutdown detached from the session.
  const root = await mkdtemp(join(tmpdir(), "omp-mac-reboot-detach-"));
  const shutdown = join(root, "shutdown");
  try {
    await mkdir(join(root, ".config", "omp-session-gateway"), { recursive: true });
    await writeFile(join(root, ".config", "omp-session-gateway", "readiness-token"), "synthetic-readiness-token");
    const started = Date.now();
    const result = await runHarness(`
set -euo pipefail
source "$1"
need_command() { :; }
bun() { if [ "$1" = --version ]; then printf '%s\n' "$BUN_VERSION"; else "$REAL_BUN" "$@"; fi; }
omp() { printf 'omp/18.1.20\\n'; }
tailscale() { printf '%s\\n' '{"BackendState":"Running","Self":{"DNSName":"fixture.invalid."}}'; }
ifconfig() { printf '%s\\n' 'inet6 fd7a:115c:a1e0::1'; }
# The session that carries the shutdown never returns on its own: a foreground shutdown would hang here.
sudo() { if [ "\${*: -3}" = 'shutdown -r now' ]; then : >"$SHUTDOWN_MARKER"; command sleep 30; fi; }
sysctl() { if [ "$*" = '-n kern.bootsessionuuid' ]; then printf '11111111-1111-4111-8111-111111111111\\n'; else command sysctl "$@"; fi; }
sleep() { exit 99; }
export -f bun omp tailscale ifconfig sudo sysctl
ssh() { /bin/bash -c "\${!#}"; }
main persistence
`, [], { ...environment("a".repeat(64)), HOME: root, REAL_BUN: process.execPath, SHUTDOWN_MARKER: shutdown });
    expect(result.exitCode).toBe(125); // no changed boot identity: the detached owner remains unresolved
    expect(result.stdout).toContain("reboot issued");
    expect(Date.now() - started).toBeLessThan(20_000);
    // The shutdown runs in a detached OS process the lane deliberately does not wait for (that is the
    // behavior under test), so there is no promise or event to await: poll its marker, bounded.
    const deadline = Date.now() + 10_000;
    while (!(await pathEntryExists(shutdown)) && Date.now() < deadline) await Bun.sleep(100);
    expect(await pathEntryExists(shutdown)).toBe(true);
    const owners = join(root, ".local/state/omp-qualification/command-owners");
    const pending = await readdir(owners);
    expect(pending.length).toBe(1);
    const pgid = Number((await readFile(join(owners, pending[0]!, "pgid"), "utf8")).trim());
    expect(Number.isSafeInteger(pgid) && pgid > 1).toBe(true);
    process.kill(-pgid, "SIGTERM");
    const stopped = await Bun.spawn(["/bin/bash", "-c",
      'for ((i=0; i<100; i++)); do kill -0 -- -"$1" 2>/dev/null || exit 0; sleep .05; done; exit 1', "--", String(pgid)],
    { stdout: "ignore", stderr: "ignore" }).exited;
    expect(stopped).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

test.skipIf(!POSIX)("Mac reboot keeps the sudo password in NUL-framed SSH stdin", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-reboot-secret-"));
  const argvPath = join(temporaryRoot, "argv");
  const stdinPath = join(temporaryRoot, "stdin");
  const harness = `
set -euo pipefail
source "$1"
ssh() {
  printf '%s\n' "$*" >>"$ARGV_CAPTURE"
  cat >>"$STDIN_CAPTURE"
}
issue_reboot
`;
  try {
    const result = await runHarness(harness, [], {
      ...environment("a".repeat(64)),
      ARGV_CAPTURE: argvPath,
      STDIN_CAPTURE: stdinPath,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const argv = await readFile(argvPath, "utf8");
    const stdin = await readFile(stdinPath);
    expect(argv).not.toContain(sudoPassword);
    expect(argv).not.toContain("shutdown -r now");
    expect(stdin.indexOf(Buffer.from(sudoPassword))).toBeGreaterThanOrEqual(0);
    expect(stdin.indexOf(Buffer.from("shutdown -r now"))).toBeGreaterThanOrEqual(0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
test.skipIf(!POSIX).each(["absent", "allows"])("Mac reboot guard %s preserves the exact passwordless shutdown command through SSH stdin", async guardState => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-passwordless-"));
  const capture = join(temporaryRoot, "sudo-argv");
  const target = await loadConfiguredMacTarget(parseStableQualificationArgs(["--tag", `v${PRODUCT_VERSION}-prealpha.1`], {
    OMP_STABLE_MAC_HOST: "gwqual@fixture.invalid", OMP_STABLE_MAC_MODEL: "Mac17,14",
  }));
  try {
    if (guardState === "allows") {
      const guard = join(temporaryRoot, ".config", "omp-qualification", "reboot-guard");
      await mkdir(dirname(guard), { recursive: true });
      await writeFile(guard, "#!/bin/sh\nprintf 'safe to reboot\\n'\nexit 0\n", { mode: 0o700 });
    }
    const result = await runHarness(`
set -euo pipefail
source "$1"
sudo() { printf '%s\\n' "$@" >"$SUDO_CAPTURE"; }
export -f sudo
ssh() { /bin/bash -c "\${!#}"; }
issue_reboot
`, [], { ...environment("a".repeat(64)), HOME: temporaryRoot, OMP_MAC_SUDO_PW: target.sudoPassword, SUDO_CAPTURE: capture });
    expect(result).toEqual({ exitCode: 125, stdout: "", stderr: "" });
    // The shutdown is detached from the session on purpose; its argv capture lands shortly after.
    const deadline = Date.now() + 10_000;
    while (!(await pathEntryExists(capture)) && Date.now() < deadline) await Bun.sleep(100);
    expect((await readFile(capture, "utf8")).trim().split("\n")).toEqual(["-n", "shutdown", "-r", "now"]);
    expect((await readdir(join(temporaryRoot, ".local/state/omp-qualification/command-owners"))).length).toBe(1);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!POSIX)("bundle scan keeps readiness token bytes out of subprocess argv", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-bundle-argv-"));
  const fakeBin = join(temporaryRoot, "bin");
  const fakePython = join(fakeBin, "python3");
  const tokenPath = join(temporaryRoot, "readiness-token");
  const bundlePath = join(temporaryRoot, "doctor.tar");
  const argvPath = join(temporaryRoot, "python-argv");
  const token = "readiness-token-'quote-argv-canary";
  const resolution = Bun.spawnSync(["python3", "-c", "import sys; print(sys.executable)"], { stdout: "pipe" });
  if (resolution.exitCode !== 0) throw new Error("python3 is required for this regression");
  const realPython = Buffer.from(resolution.stdout).toString("utf8").trim();
  await mkdir(fakeBin, { recursive: true });
  await writeFile(tokenPath, token);
  await writeFile(bundlePath, `prefix:${token}:suffix`);
  await writeFile(
    fakePython,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >\"$ARGV_CAPTURE\"\nexec \"$REAL_PYTHON\" \"$@\"\n",
  );
  await chmod(fakePython, 0o755);
  try {
    const result = await runHarness('source "$1"; count_file_occurrences "$2" "$3"', [tokenPath, bundlePath], {
      ...environment("a".repeat(64)),
      ARGV_CAPTURE: argvPath,
      REAL_PYTHON: realPython,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "1\n", stderr: "" });
    const argv = await readFile(argvPath, "utf8");
    expect(argv).not.toContain(token);
    expect(argv).toContain(tokenPath);
    expect(argv).toContain(bundlePath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
test.skipIf(!POSIX)("Mac OMP cleanup removes a custom safe session directory", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-custom-session-"));
  const sessionLabel = "stable-custom-session.21";
  const customSession = join(temporaryRoot, sessionLabel);
  await mkdir(customSession, { recursive: true });
  await writeFile(join(customSession, "session-state"), "synthetic");
  try {
    const cleanup = await runOmpCleanup(temporaryRoot, sessionLabel);
    expect({ exitCode: cleanup.exitCode, stderr: cleanup.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(cleanup.stdout).toContain('"liveOmpHosts":0');
    expect(await Bun.file(join(customSession, "session-state")).exists()).toBe(false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("Mac OMP cleanup removes its private runtime without touching an unrelated OMP link", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-runtime-cleanup-"));
  const paths = cleanupPaths(temporaryRoot);
  const replacementTarget = join(temporaryRoot, "unrelated", "omp");
  try {
    await Promise.all([
      mkdir(paths.source, { recursive: true }),
      mkdir(dirname(paths.binary), { recursive: true }),
      mkdir(dirname(paths.symlink), { recursive: true }),
    ]);
    await writeFile(paths.sourceMarker, "owned source");
    await writeFile(paths.binary, "owned binary");
    await symlink(replacementTarget, paths.symlink);
    const cleanup = await runOmpCleanup(temporaryRoot);
    expect(cleanup.exitCode).toBe(0);
    expect(JSON.parse(cleanup.stdout)).toEqual({ liveOmpHosts: 0, binaryPresent: false, sourcePresent: false });
    expect(await Bun.file(paths.binary).exists()).toBe(false);
    expect(await Bun.file(paths.sourceMarker).exists()).toBe(false);
    expect(await pathEntryExists(paths.symlink)).toBe(true);
    expect(await readlink(paths.symlink)).toBe(replacementTarget);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX).each(["missing", "refused"])("Mac OMP cleanup ignores a reused PID when its endpoint is %s", async endpointState => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-stale-"));
  const discovery = join(temporaryRoot, ".omp", "run", "collab-hosts");
  const endpoint = join(temporaryRoot, "host.sock");
  try {
    await mkdir(discovery, { recursive: true });
    if (endpointState === "refused") {
      const boundSocket = Bun.spawn(["python3", "-c", "import socket, sys; socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).bind(sys.argv[1])", endpoint]);
      expect(await boundSocket.exited).toBe(0);
    }
    const entry = join(discovery, "stale.json");
    const record = JSON.stringify({ pid: process.pid, endpoint });
    await writeFile(entry, record, { mode: 0o600 });
    const cleanup = await runOmpCleanup(temporaryRoot);
    expect(cleanup.exitCode).toBe(0);
    expect(JSON.parse(cleanup.stdout).liveOmpHosts).toBe(0);
    expect(await readFile(entry, "utf8")).toBe(record);
    expect(await pathEntryExists(endpoint)).toBe(endpointState === "refused");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("Mac OMP cleanup refuses to claim success while discovery still names a live host", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-live-"));
  const discovery = join(temporaryRoot, ".omp", "run", "collab-hosts");
  const endpoint = join(temporaryRoot, "host.sock");
  const host = Bun.listen({ unix: endpoint, socket: { data() {}, open(socket) { socket.end(); } } });
  try {
    await mkdir(discovery, { recursive: true });
    const entry = join(discovery, "qualification.json");
    await writeFile(entry, JSON.stringify({ pid: process.pid, endpoint }), { mode: 0o600 });
    const cleanup = await runOmpCleanup(temporaryRoot);
    expect(cleanup.exitCode).toBe(1);
    expect(JSON.parse(cleanup.stdout).liveOmpHosts).toBe(1);
    expect(await Bun.file(entry).exists()).toBe(true);
  } finally {
    host.stop(true);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("Mac OMP cleanup retains a host when its endpoint cannot be probed", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-unprobed-"));
  const discovery = join(temporaryRoot, ".omp", "run", "collab-hosts");
  try {
    await mkdir(discovery, { recursive: true });
    const entry = join(discovery, "qualification.json");
    const record = JSON.stringify({ pid: process.pid, endpoint: `/invalid/${"x".repeat(1024)}` });
    await writeFile(entry, record, { mode: 0o600 });
    const cleanup = await runOmpCleanup(temporaryRoot);
    expect(cleanup.exitCode).toBe(1);
    expect(JSON.parse(cleanup.stdout).liveOmpHosts).toBe(1);
    expect(await readFile(entry, "utf8")).toBe(record);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX)("Mac artifact verification rejects bytes outside the orchestrator digest", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-mac-artifact-digest-"));
  const archive = join(temporaryRoot, "candidate.tar");
  const bytes = "candidate-runtime-bytes";
  const expected = sha256(bytes);
  await writeFile(archive, bytes);
  const harness = 'source "$1"; verified_archive_sha256 "$2"';
  try {
    const accepted = await runHarness(harness, [archive], environment(expected));
    expect(accepted).toEqual({ exitCode: 0, stdout: expected, stderr: "" });

    const rejected = await runHarness(harness, [archive], environment("0".repeat(64)));
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("differs from the orchestrator-verified candidate");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

/** Lane 3 with Serve stubbed as healthy; the backend probes reach real sockets through real curl. */
async function runExposureProbes(port: number, tailnetAddress: string) {
  return runHarness(`
set -euo pipefail
source "$1"
remote() { cat >/dev/null; printf '%s\\n' "$TAILNET_ADDRESS"; }
curl() { case "\${@: -1}" in https://*) printf 200 ;; *) command curl "$@" ;; esac; }
DNS_NAME=serve.example.invalid
lane_identity
printf 'LANE_PASSED\\n'
`, [], {
    ...environment("a".repeat(64)),
    OMP_MAC_HOST: "synthetic@127.0.0.1",
    OMP_MAC_PORT: String(port),
    TAILNET_ADDRESS: tailnetAddress,
  });
}

test.skipIf(!POSIX)("Mac exposure probe does not mistake a proxy's bare handshake for a listener", async () => {
  // A carrier's transparent proxy completes the handshake itself, then closes once its upstream refuses.
  const proxy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: socket => void socket.end(), data() {} } });
  try {
    const result = await runExposureProbes(proxy.port, "127.0.0.1");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    // The orchestrator must accept the evidence this lane actually prints.
    assertMacExposureEvidence(result.stdout);
    expect(result.stdout).toContain("LANE_PASSED");
  } finally {
    proxy.stop(true);
  }
});

test.skipIf(!POSIX)("Mac exposure probe stops the lane when the gateway port answers HTTP", async () => {
  const exposed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 403 }) });
  try {
    const result = await runExposureProbes(exposed.port ?? 0, "127.0.0.1");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("HTTP 403 — EXPOSED");
    expect(result.stderr).toContain("That is #98");
    expect(result.stdout).not.toContain("LANE_PASSED");
  } finally {
    exposed.stop(true);
  }
});

test.skipIf(!POSIX)("Mac exposure probe fails closed when it cannot address the host", async () => {
  // Every address refuses, so only the unknown tailnet address can stop the lane.
  const vacant = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = vacant.port;
  vacant.stop(true);
  const result = await runExposureProbes(port, "");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("exposure is unknown");
  expect(result.stdout).not.toContain("LANE_PASSED");
});
