import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { OMP_FIXTURE_ARGS, OMP_FIXTURE_ENV } from "./omp-fixture.ts";
import { PUSH_FIXTURE_COMMANDS, type PushFixtureCommand } from "./fixtures/push-qualification-extension.ts";

export interface FixtureExecution { readonly exitCode: number; readonly stdout: string }
export type FixtureExecutor = (argv: readonly string[]) => Promise<FixtureExecution>;
export interface PushFixtureLocation {
  readonly root: string;
  readonly epoch: string;
  readonly bun: string;
  readonly binary: string;
  /** Stage this module, omp-fixture.ts/json, and fixtures/ below this scripts directory. */
  readonly scripts: string;
}

export const executeFixture: FixtureExecutor = async argv => {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, exitCode };
};

/** The only host transport boundary. An SSH executor can run these exact argv on the retained Mac. */
export async function commandPushFixture(
  location: PushFixtureLocation,
  operation: "start" | PushFixtureCommand,
  execute: FixtureExecutor = executeFixture,
  guardSession = false,
): Promise<void> {
  const result = await execute([
    location.bun, join(location.scripts, "push-qualification-fixture.ts"), operation,
    location.root, location.epoch, location.binary, location.scripts,
    ...(guardSession ? ["guard-session"] : []),
  ]);
  if (result.exitCode !== 0) throw new Error(`Push fixture ${operation} failed`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitForAcknowledgement(root: string, epoch: string, sequence: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const raw = await readFile(join(root, "ack.json"), "utf8").catch(() => undefined);
    if (raw !== undefined) {
      const ack: unknown = JSON.parse(raw);
      if (typeof ack !== "object" || ack === null || !("epoch" in ack) || ack.epoch !== epoch ||
        !("sequence" in ack) || !("phase" in ack)) throw new Error("invalid fixture acknowledgement");
      if (ack.sequence === sequence) {
        if (ack.phase === "failed") throw new Error("fixture rejected command");
        if (["ready", "accepted", "settled"].includes(String(ack.phase))) return;
      }
    }
    await Bun.sleep(100);
  }
  throw new Error("fixture acknowledgement timed out");
}

async function control(root: string, epoch: string, operation: PushFixtureCommand, guardSession = false): Promise<void> {
  if (await readFile(join(root, "owner"), "utf8") !== epoch) throw new Error("fixture ownership changed");
  const prior: unknown = JSON.parse(await readFile(join(root, "ack.json"), "utf8"));
  if (typeof prior !== "object" || prior === null || !("epoch" in prior) || prior.epoch !== epoch || !("sequence" in prior) || typeof prior.sequence !== "number" ||
    !Number.isSafeInteger(prior.sequence) || prior.sequence < 0) throw new Error("invalid fixture sequence");
  const sequence = prior.sequence + 1;
  let expectedSessionId: string | undefined;
  if (guardSession) {
    if (operation !== "ask" || !("sessionId" in prior) || typeof prior.sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(prior.sessionId)) throw new Error("fixture session ownership unavailable");
    expectedSessionId = prior.sessionId;
  }
  await writeFile(join(root, "command.json.tmp"), JSON.stringify({ epoch, sequence, operation,
    ...(expectedSessionId === undefined ? {} : { expectedSessionId }) }), { mode: 0o600 });
  await rename(join(root, "command.json.tmp"), join(root, "command.json"));
  await waitForAcknowledgement(root, epoch, sequence);
}

const PTY_HOLDER = `import errno, os, signal, sys
os.setsid()
with open(os.path.join(os.path.dirname(sys.argv[1]), 'pid'), 'x') as pid_file:
    os.chmod(pid_file.name, 0o600)
    pid_file.write(str(os.getpid()))
child, master = os.forkpty()
if child == 0:
    signal.signal(signal.SIGHUP, signal.SIG_DFL)
    os.execv(sys.argv[1], [sys.argv[1]])
def terminate(signum, frame):
    try:
        os.killpg(child, signum)
    except ProcessLookupError:
        pass
signal.signal(signal.SIGTERM, terminate)
while True:
    try:
        if not os.read(master, 65536):
            break
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        break
_, status = os.waitpid(child, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

export async function runFixtureOperation(location: PushFixtureLocation, operation: "start" | PushFixtureCommand, execute: FixtureExecutor = executeFixture, guardSession = false): Promise<void> {
  const { root, epoch, binary, scripts } = location;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(epoch) || root !== resolve(root) || root.includes("collab-hosts")) {
    throw new Error("invalid fixture location");
  }
  const holder = join(root, "hold.py");
  if (guardSession && operation !== "ask") throw new Error("only fixture asks accept a session guard");
  if (operation === "start") {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, "owner"), epoch, { mode: 0o600, flag: "wx" });
    await mkdir(join(root, "agent"), { mode: 0o700 });
    await writeFile(join(root, "fixture.yml"), "collab:\n  autoStart: control\n", { mode: 0o600, flag: "wx" });
    const host = /\.[cm]?[jt]s$/u.test(binary) ? [location.bun, binary] : [binary];
    const argv = [...host, ...OMP_FIXTURE_ARGS, "--config", join(root, "fixture.yml"),
      "--extension", join(scripts, "fixtures", "push-qualification-extension.ts"), "/push-qualification"];
    await writeFile(join(root, "launch.sh"), ["#!/bin/sh",
      ...Object.entries({ ...OMP_FIXTURE_ENV, PI_CODING_AGENT_DIR: join(root, "agent"), OMP_PUSH_FIXTURE_ROOT: root, OMP_PUSH_FIXTURE_EPOCH: epoch })
        .map(([key, value]) => `export ${key}=${shellQuote(value)}`),
      `exec ${argv.map(shellQuote).join(" ")}`, ""].join("\n"), { mode: 0o700, flag: "wx" });
    await writeFile(holder, PTY_HOLDER, { mode: 0o600, flag: "wx" });
    const launched = await execute(["sh", "-c", `cd ${shellQuote(root)} && { nohup python3 ${shellQuote(holder)} ${shellQuote(join(root, "launch.sh"))} </dev/null >/dev/null 2>&1 & }`]);
    if (launched.exitCode !== 0) throw new Error("fixture launch failed");
    await waitForAcknowledgement(root, epoch, 0);
  } else if (operation === "stop") {
    const owner = await readFile(join(root, "owner"), "utf8").catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (owner === undefined) {
      // start can be interrupted between mkdir and its first exclusive owner write.
      // Remove only an empty directory; never recursively remove an unowned tree.
      await rmdir(root).catch(error => { if (error.code !== "ENOENT") throw error; });
      return;
    }
    if (owner !== epoch) throw new Error("fixture ownership changed");
    const pid = await readFile(join(root, "pid"), "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (pid !== undefined) {
      if (!/^[1-9]\d*$/u.test(pid) || !Number.isSafeInteger(Number(pid)) || Number(pid) < 2) throw new Error("invalid fixture process identity");
      const alive = async () => {
        const process = await execute(["ps", "-ww", "-p", pid, "-o", "pgid=,stat=,command="]);
        if (process.exitCode !== 0 || !process.stdout.includes(holder)) return false;
        const fields = process.stdout.trim().split(/\s+/u);
        if (fields[1]?.startsWith("Z")) return false;
        if (fields[0] !== pid) throw new Error("fixture holder process group changed");
        return true;
      };
      const waitForExit = async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && await alive()) await Bun.sleep(100);
      };
      if (await alive()) {
        await control(root, epoch, "stop").catch(() => undefined);
        await waitForExit();
        for (const signal of ["SIGTERM", "SIGKILL"]) {
          if (!await alive()) break;
          await execute(["python3", "-c", `import os, signal, sys; os.killpg(int(sys.argv[1]), signal.${signal})`, pid]);
          await waitForExit();
        }
        if (await alive()) throw new Error("fixture holder remained active");
      }
    }
    const processes = await execute(["ps", "-ww", "-axo", "command="]);
    if (processes.exitCode !== 0 || processes.stdout.includes(join(root, "fixture.yml")) || processes.stdout.includes(holder)) throw new Error("owned fixture process remained active");
    await rm(root, { recursive: true });
  } else {
    await control(root, epoch, operation, guardSession);
  }
}

if (import.meta.main) {
  const [operation, root, epoch, binary, scripts, guard, ...extra] = process.argv.slice(2);
  try {
    if (operation === undefined || root === undefined || epoch === undefined || binary === undefined || scripts === undefined ||
      (operation !== "start" && !PUSH_FIXTURE_COMMANDS.includes(operation as PushFixtureCommand)) ||
      extra.length > 0 || guard !== undefined && guard !== "guard-session") throw new Error("invalid fixture arguments");
    await runFixtureOperation({ root, epoch, binary, scripts, bun: process.execPath }, operation as "start" | PushFixtureCommand, executeFixture, guard !== undefined);
    console.log(JSON.stringify({ completed: true }));
  } catch {
    console.error("Push fixture operation failed");
    process.exitCode = 1;
  }
}
