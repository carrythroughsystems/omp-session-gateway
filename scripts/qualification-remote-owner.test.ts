import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertRetainedMacCommandsSettled, runMacScript } from "./stable-qualification.ts";

const root = resolve(import.meta.dir, "..");
const helper = join(import.meta.dir, "qualification-remote-owner.sh");

async function ownedPtyReader(startupDelayMs: number, reader: string, timeoutSeconds = 10): Promise<{ exitCode: number; stderr: string }> {
  const home = await mkdtemp(join(tmpdir(), "remote-pty-owner-"));
  const id = "11111111-2222-4333-8444-555555555556";
  const child = Bun.spawn(["python3", "-c", `
import os, pty, select, signal, sys, time
startup_delay = float(sys.argv[1]) / 1000
pid, terminal = pty.fork()
if pid == 0:
    time.sleep(startup_delay)
    os.execv("/bin/bash", ["bash", *sys.argv[3:]])
reaped = False
code = 124
pending = b""
ready = os.environ["PTY_READER_READY"].encode()
sent = False
try:
    # The fixture's injected sleep must not consume the reader's readiness/exit budget.
    deadline = time.monotonic() + startup_delay + float(sys.argv[2])
    while time.monotonic() < deadline:
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            reaped = True
            code = os.waitstatus_to_exitcode(status)
            break
        if select.select([terminal], [], [], .05)[0]:
            try: pending += os.read(terminal, 4096)
            except OSError: pass
            if not sent and ready in pending:
                os.write(terminal, b"synthetic\\n")
                sent = True
            pending = pending[-(len(ready) - 1):]
    if not reaped:
        sys.stderr.write("PTY reader deadline exceeded (readiness=%s)\\n" % ("observed" if sent else "missing"))
finally:
    # A stopped owner or its TERM trap can wait forever. Never block in waitpid(pid, 0).
    for stop in (signal.SIGTERM, signal.SIGKILL):
        if reaped:
            break
        try: os.kill(pid, stop)
        except ProcessLookupError: pass
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            ended, status = os.waitpid(pid, os.WNOHANG)
            if ended:
                reaped = True
                break
            time.sleep(.05)
    os.close(terminal)
sys.exit(code)
`, String(startupDelayMs), String(timeoutSeconds), helper, "run", id, "/bin/bash", "-c", reader],
  { env: { ...process.env, HOME: home, PTY_READER_READY: "reader-ready" }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { exitCode, stderr };
  }
  finally {
    const control = Bun.spawn(["/bin/bash", helper, "settle", id],
      { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
    await control.exited;
    await rm(home, { recursive: true, force: true });
  }
}

// Worst default case: 2.5 s injected startup + 10 s readiness/exit + 2 s reap + 20 s settle = 34.5 s.
// Input still waits for the real read prompt; extending the bound never sends input speculatively.
test.skipIf(process.platform !== "darwin").each([0, 2_500])("council498r1 owned OMP PTY keeps its reader in the foreground (startup delay %i ms)", async startupDelayMs => {
  // The read builtin emits the prompt only once it starts; prompts need no newline.
  // Keep the marker in the environment so an echoed command cannot satisfy the handshake.
  expect(await ownedPtyReader(startupDelayMs, 'IFS= read -r -p "$PTY_READER_READY" line; [ "$line" = synthetic ]')).toEqual({ exitCode: 0, stderr: "" });
}, 40_000);

test.skipIf(process.platform !== "darwin")("injected startup delay does not consume the PTY reader budget", async () => {
  expect(await ownedPtyReader(500, 'IFS= read -r -p "$PTY_READER_READY" line; [ "$line" = synthetic ]', 0.5))
    .toEqual({ exitCode: 0, stderr: "" });
}, 40_000);

test.skipIf(process.platform !== "darwin").each([0, 250])("PTY reader waits for its first output before writing (first output delay %i ms)", async firstOutputDelayMs => {
  // Hold the first prompt through a one-second read: any input before readiness must fail.
  expect(await ownedPtyReader(0, `/bin/sleep ${firstOutputDelayMs / 1000}; if IFS= read -r -t 1 line; then exit 91; fi; IFS= read -r -p "$PTY_READER_READY" line; [ "$line" = synthetic ]`)).toEqual({ exitCode: 0, stderr: "" });
}, 40_000);

test.skipIf(process.platform !== "darwin")("PTY regression supervisor bounds termination of a stopped owner", async () => {
  expect(await ownedPtyReader(0, 'kill -STOP "$PPID"; IFS= read -r line', 0.5)).toEqual({
    exitCode: 124, stderr: "PTY reader deadline exceeded (readiness=missing)\n",
  });
}, 40_000);

test("council498r1 every Mac command entry is owned or explicitly effect-free", async () => {
  const orchestrator = await readFile(join(import.meta.dir, "stable-qualification.ts"), "utf8");
  const shell = await readFile(join(import.meta.dir, "qualify-macos-host.sh"), "utf8");
  // Common owned dispatch, effect-free admission, owned OMP PTY, and command-free -N tunnel.
  expect([...orchestrator.matchAll(/\[\s*"ssh"/gu)]).toHaveLength(4);
  expect(orchestrator).toContain('remoteOwnerCommand("run", owner, ["/bin/bash", "-c", ompRemoteCommand');
  expect(orchestrator).toContain('ownedMacProcesses.set(child, { target, owner })');
  expect(orchestrator).toContain('"-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes"');
  expect([...shell.matchAll(/^\s*(?:\}\s*\|\s*)?ssh\b/gmu)]).toHaveLength(2);
  expect(shell).not.toMatch(/\bscp\s/u);
  expect(shell).toContain('remote run-reboot');
  expect(shell.indexOf(': > "$REMOTE_OWNER_DIRECTORY/$owner"')).toBeLessThan(shell.indexOf('} | ssh'));
});

test.skipIf(process.platform === "win32")("council498r1 reboot handoff remains owned until boot identity changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "remote-reboot-owner-"));
  const id = "11111111-2222-4333-8444-555555555555";
  const owner = join(home, ".local/state/omp-qualification/command-owners", id);
  const invoke = (mode: string, ...argv: string[]) => Bun.spawn(["/bin/bash", helper, mode, id, ...argv],
    { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" }).exited;
  try {
    expect(await invoke("run-reboot", "/bin/bash", "-c", ":")).toBe(0);
    expect(await invoke("settle")).toBe(125);
    expect(await Bun.file(join(owner, "reboot")).exists()).toBe(true);
    await writeFile(join(owner, "boot"), "synthetic-previous-boot\n");
    expect(await invoke("settle")).toBe(0);
    expect(await readdir(join(home, ".local/state/omp-qualification/command-owners"))).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32").each([false, true])(
  "council498r1 actual Mac shell wrapper settles or fences remote work (control unavailable=%s)", async unavailable => {
    const home = await mkdtemp(join(tmpdir(), "remote-shell-owner-")), bin = join(home, "bin"), ready = join(home, "ready");
    const controller = new AbortController();
    const destination = `shell-owner-${unavailable}.invalid`;
    await mkdir(bin);
    await writeFile(join(bin, "ssh"), `#!${process.execPath}\nconst input = new Uint8Array(await Bun.stdin.arrayBuffer());
const child = Bun.spawn(["/bin/bash", "-c", process.argv.at(-1)], {
  env: { ...process.env, HOME: process.env.SYNTHETIC_REMOTE_HOME }, stdin: input,
  stdout: "ignore", stderr: "ignore", detached: true
});
process.exit(await child.exited);\n`, { mode: 0o700 });
    const environment = { OMP_MAC_HOST: destination, OMP_MAC_TAG: "v0.7.7-prealpha.21", OMP_MAC_PREVIOUS_TAG: "v0.7.6",
      OMP_MAC_LOGIN: "synthetic", OMP_MAC_ARCHIVE_SHA256: "b".repeat(64), PATH: `${bin}:${process.env.PATH}`,
      SYNTHETIC_REMOTE_HOME: home, SYNTHETIC_READY: ready };
    const execute: NonNullable<Parameters<typeof runMacScript>[4]> = async (argv, options) => {
      if (argv[0] === "ssh" && unavailable) return { exitCode: 125, stdout: "", stderr: "" };
      const command = argv[0] === "bash" ? ["/bin/bash", "-c",
        'source scripts/qualify-macos-host.sh; remote <<\'REMOTE\'\nprintf "%s" "$$" > "$SYNTHETIC_READY"\nsleep 120\nREMOTE'] : [...argv];
      const child = Bun.spawn(command, { cwd: root, env: { ...process.env, ...environment, ...options?.env },
        stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const cancel = () => child.kill("SIGKILL"); // Simulate local SSH loss, not remote termination.
      options?.execution?.signal.addEventListener("abort", cancel, { once: true });
      try { return { exitCode: await child.exited, stdout: "", stderr: "" }; }
      finally { options?.execution?.signal.removeEventListener("abort", cancel); }
    };
    let pid = 0;
    const result = runMacScript(environment, ["uninstall"], 60_000,
      { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 301 }, execute).catch(error => error);
    try {
      const deadline = performance.now() + 5_000;
      while (!await Bun.file(ready).exists() && performance.now() < deadline) await Bun.sleep(10);
      pid = Number(await readFile(ready, "utf8"));
      controller.abort();
      await result;
      if (unavailable) expect(() => assertRetainedMacCommandsSettled(destination)).toThrow();
      else {
        expect(() => process.kill(pid, 0)).toThrow();
        expect(() => assertRetainedMacCommandsSettled(destination)).not.toThrow();
      }
    } finally {
      controller.abort();
      if (!pid && await Bun.file(ready).exists()) pid = Number(await readFile(ready, "utf8"));
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* Settled already. */ }
      await result;
      await rm(home, { recursive: true, force: true });
    }
  }, 35_000);
