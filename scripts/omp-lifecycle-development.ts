import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOmpStdinDriver, OmpLifecycleFailure, runOmpLifecycle, type OmpLifecycleEvidence, type OmpLifecycleHost } from "./omp-lifecycle-qualification.ts";
import { OMP_FIXTURE_ARGS, OMP_FIXTURE_ENV } from "./omp-fixture.ts";
import { parseJsonRecord } from "./post-release-smoke.ts";
import { verifyLaunchContracts, waitForPublishedSession, waitForRevocation } from "./stable-qualification.ts";
import upstream from "../UPSTREAM.lock.json";
import { chromium } from "@playwright/test";
import { JOURNEY_VIEW_STATE } from "./browser-journey.ts";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));

// A pipe on the controller side, a real controlling terminal on OMP's side: the same
// byte transport as ssh -tt. No terminal output is retained, parsed, printed, or recorded.
// Unlike `script`, this bridge explicitly waits for its child after forwarding shutdown.
const PTY_BRIDGE = `import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, master = pty.fork()
if pid == 0:
    sink = os.open(os.devnull, os.O_WRONLY)
    os.dup2(sink, 1)
    os.dup2(sink, 2)
    os.close(sink)
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
stopping = None
def stop(*_):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            sys.exit(os.waitstatus_to_exitcode(status))
        if stopping is not None and time.monotonic() - stopping > 10:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        ready, _, _ = select.select([master] + ([] if stopping is not None else [0]), [], [], 0.1)
        for fd in ready:
            try: data = os.read(fd, 65536)
            except OSError:
                stop()
                continue
            if not data:
                stop()
            elif fd == 0:
                while data:
                    written = os.write(master, data)
                    data = data[written:]
finally:
    stop()
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    os.close(master)
`;

async function stopProcess(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (!await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)])) {
    throw new Error("lifecycle development process did not stop");
  }
}

export function parseDevelopmentArgs(args: readonly string[]): { omp: string; isolatedHome: boolean; expectedVersion: string } {
  let omp: string | undefined, expectedVersion: string | undefined;
  let isolatedHome = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--omp" && omp === undefined) omp = args[++index];
    else if (argument === "--isolated-home" && !isolatedHome) isolatedHome = true;
    else if (argument === "--expect-version" && expectedVersion === undefined) expectedVersion = args[++index] ?? "";
    else throw new Error("invalid lifecycle development arguments");
  }
  if (!omp || !isAbsolute(omp) || expectedVersion !== undefined && (!isolatedHome || !/^\d+\.\d+\.\d+$/u.test(expectedVersion))) {
    throw new Error("invalid lifecycle development arguments");
  }
  return { omp, isolatedHome, expectedVersion: expectedVersion ?? upstream.packageVersion };
}

/** Stat metadata only: never read or copy a discovery token or published capability. */
export async function assertPrivatePublication(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new Error("discovery directory is not private");
  const entries = (await readdir(directory)).filter(name => name.endsWith(".json"));
  if (entries.length !== 1) throw new Error("expected exactly one isolated publication");
  const entry = await lstat(join(directory, entries[0]!));
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) throw new Error("discovery file is not private");
}

async function waitForPublicationRemoval(directory: string): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    if (!(await readdir(directory)).some(name => name.endsWith(".json"))) return;
    await Bun.sleep(100);
  }
  throw new Error("OMP did not remove its publication");
}

async function attachViewAndControl(origin: string, label: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    // Ephemeral context only; no traces, HAR, screenshots, recordings or browser-output forwarding.
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    await page.goto(origin);
    await page.getByRole("button", { name: `View ${label}`, exact: true }).click();
    await page.waitForFunction(() => location.pathname === "/client/" && document.querySelector(".conn-chip")?.getAttribute("data-state") === "connected");
    const view = await page.evaluate<{ readOnly: boolean; controlVisible: boolean; rootMounted: boolean }>(JOURNEY_VIEW_STATE);
    if (!view.readOnly || !view.controlVisible || !view.rootMounted) throw new Error();
    await page.locator(".shell-control").click();
    await page.waitForFunction(() => {
      const editor = document.querySelector(".sh-composer-input");
      const control = document.querySelector(".shell-control");
      return document.querySelector(".conn-chip")?.getAttribute("data-state") === "connected" &&
        editor instanceof HTMLTextAreaElement && !editor.disabled && control instanceof HTMLButtonElement && control.hidden;
    });
    if (new URL(page.url()).search || new URL(page.url()).hash) throw new Error();
    await context.close();
  } finally { await browser.close(); }
}

interface DiscoverySeamEvidence {
  readonly passed: true;
  readonly ompVersion: string;
  readonly isolatedHome: true;
  readonly discovery: { readonly sameUid: true; readonly directoryMode: 448; readonly privatePublication: true };
  readonly initial: { readonly published: true; readonly viewAttached: true; readonly viewReadOnly: true; readonly controlAttached: true; readonly controlWritable: true };
  readonly restart: { readonly newInstance: true; readonly generation: 1; readonly republished: true; readonly viewAttached: true; readonly controlAttached: true };
  readonly revocation: { readonly cardsRemoved: 2; readonly filesRemoved: 2 };
}

class DiscoverySeamFailure extends Error {
  constructor(readonly phase: string) { super("isolated-HOME discovery seam failed"); }
}

async function runDiscoverySeam(host: OmpLifecycleHost, origin: string, label: string, directory: string, ompVersion: string): Promise<DiscoverySeamEvidence> {
  let phase = "initial publication";
  try {
    const initial = await waitForPublishedSession(origin, label, { timeoutMs: 90_000 });
    if (initial.generation !== 1 || typeof initial.instanceId !== "string") throw new Error();
    phase = "initial private ACL";
    await assertPrivatePublication(directory);
    phase = "initial launch contracts";
    await verifyLaunchContracts(origin, initial);
    phase = "initial View/Control attach";
    await attachViewAndControl(origin, label);
    phase = "first stop";
    await host.stop();
    phase = "first card revocation";
    await waitForRevocation(origin, label);
    phase = "first file removal";
    await waitForPublicationRemoval(directory);
    phase = "restart";
    await host.startContinued();
    phase = "restart publication";
    const restarted = await waitForPublishedSession(origin, label, { timeoutMs: 90_000 });
    if (restarted.generation !== 1 || typeof restarted.instanceId !== "string" || restarted.instanceId === initial.instanceId) throw new Error();
    phase = "restart private ACL";
    await assertPrivatePublication(directory);
    phase = "restart launch contracts";
    await verifyLaunchContracts(origin, restarted);
    phase = "restart View/Control attach";
    await attachViewAndControl(origin, label);
    phase = "final stop";
    await host.stop();
    phase = "final card revocation";
    await waitForRevocation(origin, label);
    phase = "final file removal";
    await waitForPublicationRemoval(directory);
    return {
      passed: true, ompVersion, isolatedHome: true,
      discovery: { sameUid: true, directoryMode: 0o700, privatePublication: true },
      initial: { published: true, viewAttached: true, viewReadOnly: true, controlAttached: true, controlWritable: true },
      restart: { newInstance: true, generation: 1, republished: true, viewAttached: true, controlAttached: true },
      revocation: { cardsRemoved: 2, filesRemoved: 2 },
    };
  } catch { throw new DiscoverySeamFailure(phase); }
}

async function runDevelopment(omp: string, isolatedHome: boolean, expectedVersion: string): Promise<void> {
  let root: string | undefined;
  let daemon: Bun.Subprocess | undefined;
  let host: OmpLifecycleHost | undefined;
  const children: Bun.Subprocess[] = [];
  let phase = "setup";
  let failed = false;
  let evidence: OmpLifecycleEvidence | DiscoverySeamEvidence | undefined;
  let rootRemoved = false;
  try {
    if (process.platform !== "darwin" || !isAbsolute(omp) || !await Bun.file(omp).exists()) throw new Error();
    const command = /\.[cm]?js$/u.test(omp) ? [process.execPath, omp] : [omp];
    root = await mkdtemp("/tmp/omp-lifecycle-dev-");
    const home = join(root, "home");
    const discovery = join(home, ".omp/run/collab-hosts");
    const label = "omp-lifecycle-development";
    const cwd = join(root, label);
    for (const path of [home, cwd, join(root, "config/omp-session-gateway"), join(root, "state"), join(root, "run")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    const environment = {
      HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", TERM: "xterm-256color",
      ...OMP_FIXTURE_ENV,
    };
    phase = "OMP version";
    const version = Bun.spawn([...command, "--version"], { cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    children.push(version);
    const versionText = await new Response(version.stdout).text();
    if (await version.exited !== 0 || versionText.trim() !== `omp/${expectedVersion}`) throw new Error();
    phase = "OMP configuration";
    const config = Bun.spawn([...command, "config", "set", "collab.autoStart", "control"], { cwd, env: environment, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    children.push(config);
    if (await config.exited !== 0) throw new Error();
    // A settings write can exit 0 without persisting; OMP's own read-back is the proof.
    const readBack = Bun.spawn([...command, "config", "get", "collab.autoStart", "--json"], { cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    children.push(readBack);
    const readBackText = await new Response(readBack.stdout).text();
    if (await readBack.exited !== 0 || parseJsonRecord(readBackText, "OMP auto-start").value !== "control") throw new Error();
    phase = "gateway startup";
    if (!await Bun.file(join(REPOSITORY, "apps/web/dist/index.html")).exists()) throw new Error();
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const port = reservation.port;
    reservation.stop(true);
    if (port === undefined || port === 4317) throw new Error();
    const origin = `http://127.0.0.1:${port}`;
    await writeFile(join(root, "config/omp-session-gateway/config.json"), JSON.stringify({
      http: { hostname: "127.0.0.1", port, publicOrigin: origin },
      auth: { mode: "dev-localhost", allowedLogins: [] },
      omp: { discoveryDir: discovery },
      registry: { heartbeatSeconds: 2, ttlSeconds: 11, maxSessions: 10 },
    }), { mode: 0o600, flag: "wx" });
    await writeFile(join(root, "config/omp-session-gateway/readiness-token"), `${"synthetic-readiness-".padEnd(43, "x")}\n`, { mode: 0o600, flag: "wx" });
    daemon = Bun.spawn([process.execPath, "apps/gateway/src/cli.ts", "serve"], {
      cwd: REPOSITORY, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      env: { ...environment, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"), TMPDIR: join(root, "run") },
    });
    children.push(daemon);
    const deadline = performance.now() + 30_000;
    let ready = false;
    while (performance.now() < deadline && daemon.exitCode === null) {
      try {
        const response = await fetch(`${origin}/api/v1/health`, { cache: "no-store", signal: AbortSignal.timeout(1_000) });
        const body: unknown = await response.json();
        if (response.status === 200 && typeof body === "object" && body !== null && "status" in body && body.status === "ready") { ready = true; break; }
      } catch { /* The isolated daemon may not yet have bound its port. */ }
      await Bun.sleep(100);
    }
    if (!ready) throw new Error();
    phase = "host startup";
    const start = (continued: boolean) => {
      const child = Bun.spawn(["/usr/bin/env", "python3", "-c", PTY_BRIDGE, ...command, ...OMP_FIXTURE_ARGS, ...(continued ? ["--continue"] : [])], {
        cwd, env: environment, stdin: "pipe", stdout: "ignore", stderr: "ignore",
      });
      children.push(child);
      return child;
    };
    host = createOmpStdinDriver(start(false), () => start(true), async child => {
      if (child.exitCode !== null) return;
      if (isolatedHome) {
        // Let OMP finish its controller shutdown; closing the bridge first sends SIGTERM and
        // can leave a stale publication, which proves process death but not file revocation.
        await child.stdin.write("/quit\r");
        await child.stdin.flush();
        if (!await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)])) {
          await stopProcess(child);
          throw new Error("OMP did not finish graceful shutdown");
        }
        child.stdin.end();
        return;
      }
      child.stdin.end();
      await stopProcess(child);
    });
    phase = isolatedHome ? "isolated-HOME discovery seam" : "lifecycle";
    evidence = isolatedHome
      ? await runDiscoverySeam(host, origin, label, discovery, expectedVersion)
      : await runOmpLifecycle({ host, observer: { origin, waitForPublishedSession, verifyLaunchContracts, waitForRevocation }, label });
  } catch (error) {
    if (error instanceof OmpLifecycleFailure) phase = error.step;
    if (error instanceof DiscoverySeamFailure) phase = `isolated-HOME ${error.phase}`;
    failed = true;
  }
  // The catch above keeps every outcome, so cleanup always runs from here.
  let cleanupFailed = false;
  try { await host?.stopAll(); } catch { cleanupFailed = true; }
  for (const child of children) {
    try { await stopProcess(child); } catch { cleanupFailed = true; }
  }
  if (root !== undefined && !cleanupFailed) {
    // Only OMP may remove its publications. Do not recursively erase a live/stale discovery entry.
    try {
      if (host !== undefined) {
        const command = /\.[cm]?js$/u.test(omp) ? [process.execPath, omp] : [omp];
        const prune = Bun.spawn([...command, "collab", "list"], {
          cwd: root, env: { HOME: join(root, "home"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...OMP_FIXTURE_ENV },
          stdin: "ignore", stdout: "ignore", stderr: "ignore",
        });
        children.push(prune);
        if (!await Promise.race([prune.exited.then(code => code === 0), Bun.sleep(15_000).then(() => false)])) {
          await stopProcess(prune);
          throw new Error();
        }
      }
      const entries = await readdir(join(root, "home/.omp/run/collab-hosts")).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
        throw error;
      });
      if (entries.length !== 0) throw new Error();
      await rm(root, { recursive: true, force: true });
      rootRemoved = true;
    } catch { cleanupFailed = true; }
  }
  const cleanupPassed = !cleanupFailed && children.every(child => child.exitCode !== null);
  if (failed || !cleanupPassed) {
    console.log(JSON.stringify({ passed: false, reason: `lifecycle development ${failed ? phase : "cleanup"} failed`, cleanup: { stopped: children.every(child => child.exitCode !== null), privateRootRemoved: root === undefined || rootRemoved } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(isolatedHome ? { ...evidence, cleanup: { stopped: cleanupPassed, privateRootRemoved: rootRemoved } } : evidence));
  }
}

if (import.meta.main) {
  let options: ReturnType<typeof parseDevelopmentArgs> | undefined;
  try { options = parseDevelopmentArgs(process.argv.slice(2)); }
  catch {
    console.error("usage: bun scripts/omp-lifecycle-development.ts --omp <absolute stock OMP binary or dist/cli.js> [--isolated-home --expect-version X.Y.Z]");
    process.exitCode = 1;
  }
  if (options) await runDevelopment(options.omp, options.isolatedHome, options.expectedVersion);
}
