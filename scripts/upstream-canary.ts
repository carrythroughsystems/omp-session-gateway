import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OmpHostReader } from "../apps/gateway/src/omp-registry.ts";
import type { OmpDiscoveryEntry } from "../packages/protocol/src/types.ts";
import { fixtureModelError, OMP_FIXTURE_ARGS, OMP_FIXTURE_ENV } from "./omp-fixture.ts";
import { isStockOmpBinary, parseJsonRecord } from "./post-release-smoke.ts";

export const CANARY_STAGES = ["prepare", "publish", "snapshot", "stale-generation", "view", "control", "new-generation", "fork", "branch-rewind", "continue", "unregister"] as const;
export type CanaryStage = typeof CANARY_STAGES[number];
export type CanaryPlatform = "posix" | "windows";
type StageResult = "passed" | "failed" | "skipped";
const POSIX_STAGES: readonly CanaryStage[] = ["new-generation", "fork", "branch-rewind"];
export interface CanarySummary {
  readonly ompVersion: string;
  readonly platform: CanaryPlatform;
  readonly stages: Record<CanaryStage, StageResult>;
  readonly failedStage?: CanaryStage;
  readonly durationMs: number;
  readonly discoveryFileRemoved: boolean;
}
export interface CanaryOptions {
  readonly omp: string;
  /** Diagnostic override only; ordinary runs use the shared fixture arguments unchanged. */
  readonly model?: string;
}
export interface CanaryPackage {
  readonly ompVersion: string;
  readonly bunEngine: string;
}

interface CanaryGuestSnapshot {
  readonly phase: string;
  readonly readOnly: boolean;
  readonly working: boolean;
  readonly entries: readonly unknown[];
}
interface CanaryGuestClient {
  connect(): void;
  close(): void;
  sendPrompt(text: string): void;
  getSnapshot(): CanaryGuestSnapshot;
}
interface CanaryClientModule {
  readonly GuestClient: new (capability: string, displayName: string) => CanaryGuestClient;
}
interface CanaryHost {
  readonly session?: string;
  pid?: number;
  stopRequested: boolean;
  exited: boolean;
}

class CanaryFailure extends Error {}

export function parseCanaryArgs(args: readonly string[]): CanaryOptions {
  let omp: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--") || value.includes("\0")) throw new CanaryFailure("invalid arguments");
    if (flag === "--omp" && omp === undefined) omp = value;
    else if (flag === "--model" && model === undefined) model = value;
    else throw new CanaryFailure("invalid arguments");
  }
  if (omp === undefined) throw new CanaryFailure("--omp is required");
  return model === undefined ? { omp } : { omp, model };
}

/** Admit only the version, never trailing diagnostics from the binary's output. */
export function parseOmpVersion(banner: string): string | undefined {
  return /^(?:omp[ /])?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(banner.trim())?.[1];
}

export function isSupportedOmpVersion(version: string): boolean {
  return parseOmpVersion(version) === version && Bun.semver.satisfies(version, ">=18.1.20");
}

/** Read bounded public package metadata without needing OMP to start under this runtime. */
export async function readCanaryPackage(directory: string): Promise<CanaryPackage> {
  try {
    const value: unknown = await Bun.file(join(directory, "package.json")).json();
    if (typeof value !== "object" || value === null
      || !("version" in value) || typeof value.version !== "string" || parseOmpVersion(value.version) !== value.version
      || !("engines" in value) || typeof value.engines !== "object" || value.engines === null
      || !("bun" in value.engines) || typeof value.engines.bun !== "string"
      || !/^[0-9A-Za-z.*+~^<>=| -]{1,160}$/u.test(value.engines.bun)) throw new Error();
    return { ompVersion: value.version, bunEngine: value.engines.bun };
  } catch {
    throw new CanaryFailure("invalid OMP package manifest");
  }
}

export function canaryBunEngineError(installed: CanaryPackage, bunVersion: string): string | undefined {
  return Bun.semver.satisfies(bunVersion, installed.bunEngine) ? undefined
    : `OMP ${installed.ompVersion} requires Bun ${installed.bunEngine}; running Bun ${bunVersion}`;
}

export function canarySummary(ompVersion: string, durationMs: number, failedStage?: CanaryStage, discoveryFileRemoved = false, platform: CanaryPlatform = "posix"): CanarySummary {
  if (platform === "windows" && failedStage !== undefined && POSIX_STAGES.includes(failedStage)) throw new CanaryFailure("invalid canary summary");
  const failedIndex = failedStage === undefined ? CANARY_STAGES.length : CANARY_STAGES.indexOf(failedStage);
  const stages = Object.fromEntries(CANARY_STAGES.map((stage, index) => [
    stage, platform === "windows" && POSIX_STAGES.includes(stage) ? "skipped"
      : index < failedIndex ? "passed" : index === failedIndex ? "failed" : "skipped",
  ])) as Record<CanaryStage, StageResult>;
  return { ompVersion, platform, stages, ...(failedStage === undefined ? {} : { failedStage }), durationMs, discoveryFileRemoved };
}

/** Reconstruct the public report before sending it to summaries or issue-job outputs. */
export function parseCanarySummary(text: string, expectedPlatform?: CanaryPlatform, fallbackVersion = ""): CanarySummary {
  try {
    if (fallbackVersion !== "" && parseOmpVersion(fallbackVersion) !== fallbackVersion) throw new Error();
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || !("ompVersion" in value) || typeof value.ompVersion !== "string"
      || (value.ompVersion !== "" && parseOmpVersion(value.ompVersion) !== value.ompVersion)
      || !("platform" in value) || (value.platform !== "posix" && value.platform !== "windows")
      || (expectedPlatform !== undefined && value.platform !== expectedPlatform)
      || !("durationMs" in value) || typeof value.durationMs !== "number" || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0
      || !("discoveryFileRemoved" in value) || typeof value.discoveryFileRemoved !== "boolean"
      || !("stages" in value) || typeof value.stages !== "object" || value.stages === null || Array.isArray(value.stages)) throw new Error();
    const failedStage = "failedStage" in value ? CANARY_STAGES.find(stage => stage === value.failedStage) : undefined;
    if ("failedStage" in value && failedStage === undefined) throw new Error();
    const summary = canarySummary(value.ompVersion || fallbackVersion, value.durationMs, failedStage, value.discoveryFileRemoved, value.platform);
    const stages = value.stages;
    if (Object.keys(stages).length !== CANARY_STAGES.length
      || CANARY_STAGES.some(stage => !(stage in stages) || Reflect.get(stages, stage) !== summary.stages[stage])) throw new Error();
    return summary;
  } catch {
    throw new CanaryFailure("invalid canary summary");
  }
}

/** Match a complete synthetic user prompt, never metadata, assistant output, or a substring. */
export function hasCanaryPrompt(entries: readonly unknown[], marker: string): boolean {
  return entries.some(entry => {
    if (typeof entry !== "object" || entry === null || !("type" in entry)) return false;
    let content: unknown;
    if (entry.type === "custom_message" && "customType" in entry && entry.customType === "collab-prompt" && "content" in entry) {
      content = entry.content;
    } else if (entry.type === "message" && "message" in entry && typeof entry.message === "object" && entry.message !== null) {
      const message = entry.message;
      if (!("role" in message) || message.role !== "user" || !("content" in message)) return false;
      content = message.content;
    } else return false;
    if (typeof content === "string") return content === marker;
    if (!Array.isArray(content) || content.length !== 1) return false;
    const part: unknown = content[0];
    return typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && part.text === marker;
  });
}

/** Only the complete status line proves a rewind; a selected prompt or old transcript does not. */
export function hasRewindConfirmation(pane: string): boolean {
  return /^\s*(?:[✓✔]\s+)?Rewound to selected point\s*$/mu.test(pane);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quote one argument for a Windows command line (the CommandLineToArgvW/MSVCRT rules). */
export function windowsArgument(value: string): string {
  if (value !== "" && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}

/**
 * PowerShell that starts one host in its own hidden console and prints only its PID. The console is
 * the point: OMP starts its interactive session, the only one `collab.autoStart` publishes from,
 * only when it has a terminal, and on Windows a redirected child has none. Nothing is redirected.
 * PowerShell itself runs with the runner's profile, because a cold start against an empty private
 * profile outlasted the command bound; it then replaces its whole environment with `environment`
 * before the start, so the host inherits nothing else, as `env -i` guarantees on POSIX.
 */
export function windowsHostScript(bun: string, argv: readonly string[], work: string, environment: Readonly<Record<string, string>>): string {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    // Resolve the cmdlet while the runner's module path is still in place.
    "$start = Get-Command -Name Start-Process -CommandType Cmdlet",
    "Get-ChildItem -Path Env: | ForEach-Object { Remove-Item -LiteralPath \"Env:$($_.Name)\" }",
    ...Object.entries(environment).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new CanaryFailure("invalid host environment");
      return `Set-Item -LiteralPath ${literal(`Env:${name}`)} -Value ${literal(value)}`;
    }),
    `$host_process = & $start -FilePath ${literal(bun)} -ArgumentList ${literal(argv.map(windowsArgument).join(" "))} -WorkingDirectory ${literal(work)} -WindowStyle Hidden -PassThru`,
    "[Console]::Out.Write($host_process.Id)",
  ].join("; ");
}

/** The variables a Windows child needs to start at all, from the runner, plus a private profile. */
function windowsEnvironment(home: string, temp: string, path: string): Record<string, string> {
  const inherited = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"] as const;
  const environment: Record<string, string> = {};
  for (const name of inherited) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment, PATH: path, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  };
}

async function runCanary(args: readonly string[]): Promise<{ summary: CanarySummary; reason?: string }> {
  const started = performance.now();
  let stage: CanaryStage = "prepare";
  let ompVersion = "";
  let failedStage: CanaryStage | undefined;
  let reason: string | undefined;
  let root: string | undefined;
  let discoveryDirectory: string | undefined;
  let reader: OmpHostReader | undefined;
  const guests = new Set<CanaryGuestClient>();
  const hosts: CanaryHost[] = [];
  let stockBinary: string | undefined;
  let discoveryFileRemoved = false;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const path = process.env.PATH ?? "";
  const windows = process.platform === "win32";
  let environment: Record<string, string> = { PATH: path };
  // Stock OMP ships a Bun script. Windows cannot execute its shebang, so this Bun runs it there.
  const omp = (binary: string, ...rest: string[]): string[] => windows ? [process.execPath, binary, ...rest] : [binary, ...rest];

  // All child output is discarded except bounded version/PID/status responses retained in memory.
  function command(argv: string[], failure: string, allowFailure = false, options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly maxBuffer?: number } = {}): string | undefined {
    const result = spawnSync(argv[0]!, argv.slice(1), {
      env: options.env ?? environment, cwd: root === undefined ? undefined : join(root, "work"),
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      timeout: options.timeoutMs ?? 10_000, maxBuffer: options.maxBuffer ?? 4_096,
    });
    if (result.error !== undefined || result.status !== 0) {
      if (allowFailure) return undefined;
      throw new CanaryFailure(failure);
    }
    return result.stdout.trim();
  }

  // The first OMP command in a fresh private home also unpacks OMP's native addon; on a Windows
  // runner that alone outlasted 10 s (run 36015033822). The bound is longer, never retried.
  function ompCommand(binary: string, args: readonly string[], failure: string): string | undefined {
    return command(omp(binary, ...args), failure, false, { timeoutMs: 60_000 });
  }

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, failure: string, cleaning = false): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (!cleaning && interrupted) throw new CanaryFailure("interrupted");
      if (await predicate()) return;
      await Bun.sleep(100);
    }
    throw new CanaryFailure(failure);
  }

  function stopHost(host: CanaryHost): void {
    if (host.stopRequested || hostExited(host)) return;
    if (windows) {
      // A console process takes no signal from outside its console, so end the host's whole tree.
      // It then cannot unregister, which the verdict accepts: its named pipe goes with it.
      if (host.pid !== undefined) {
        command(["taskkill.exe", "/PID", String(host.pid), "/T", "/F"], "host stop failed");
      }
      host.stopRequested = true;
      return;
    }
    const pidText = command(["tmux", "display-message", "-p", "-t", `=${host.session}:`, "#{pane_pid}"], "host stop failed", true);
    if (pidText === undefined) return;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new CanaryFailure("host PID query failed");
    if (host.pid !== undefined && host.pid !== pid) throw new CanaryFailure("host PID changed");
    host.pid = pid;
    try { process.kill(pid, "SIGTERM"); host.stopRequested = true; }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") throw new CanaryFailure("host signal failed");
      host.exited = true;
    }
  }

  function hostExited(host: CanaryHost): boolean {
    if (host.exited) return true;
    // The named tmux session belongs to this invocation; never signal a recycled process ID.
    if (host.session !== undefined && command(["tmux", "has-session", "-t", `=${host.session}`], "host exit query failed", true) === undefined) {
      host.exited = true;
      return true;
    }
    if (host.pid === undefined) return false;
    try { process.kill(host.pid, 0); return false; }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
        host.exited = true;
        return true;
      }
      throw new CanaryFailure("host exit query failed");
    }
  }

  async function observeStoppedHosts(): Promise<boolean> {
    if (!hosts.every(hostExited)) return false;
    if (reader === undefined) return true;
    if (!await reader.directoryUsable()) return false;
    const entries = await reader.listEntries();
    discoveryFileRemoved = entries.length === 0;
    for (const entry of entries) {
      if ((await reader.snapshot(entry)).status !== "gone") return false;
    }
    return true;
  }

  async function launchHost(binary: string, fixtureArgs: readonly string[], resume: boolean): Promise<CanaryHost> {
    const work = join(root!, "work");
    const argv = [binary, ...fixtureArgs, ...(resume ? ["--continue"] : [])];
    const host: CanaryHost = { stopRequested: false, exited: false,
      ...(!windows ? { session: `omp-upstream-canary-${crypto.randomUUID()}` } : {}) };
    if (windows) {
      host.pid = Number(command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        windowsHostScript(process.execPath, argv, work, { ...environment, ...OMP_FIXTURE_ENV })],
      "host startup failed", false, { env: process.env, timeoutMs: 60_000 }));
      hosts.push(host);
    } else {
      const launcher = join(root!, `launch-${hosts.length}.sh`);
      const hostEnvironment = Object.entries({ ...environment, ...OMP_FIXTURE_ENV }).map(([key, value]) => `${key}=${quote(value)}`).join(" ");
      // stdin for commands is closed above; this interactive host owns its new tmux PTY.
      // env -i matters even with a private HOME: an existing tmux server keeps its own environment.
      await writeFile(launcher, `#!/bin/sh\ncd ${quote(work)} || exit 1\nexec /usr/bin/env -i ${hostEnvironment} ${argv.map(quote).join(" ")}\n`, { mode: 0o700 });
      command(["tmux", "new-session", "-d", "-s", host.session!, "-x", "200", "-y", "50", `exec ${quote(launcher)}`], "host startup failed");
      hosts.push(host);
      host.pid = Number(command(["tmux", "display-message", "-p", "-t", `=${host.session}:`, "#{pane_pid}"], "host PID query failed"));
    }
    if (!Number.isSafeInteger(host.pid) || host.pid! <= 1) throw new CanaryFailure("host PID query failed");
    return host;
  }

  function keys(host: CanaryHost, ...values: string[]): void {
    if (interrupted) throw new CanaryFailure("interrupted");
    if (host.session === undefined || hostExited(host)) throw new CanaryFailure("terminal host unavailable");
    command(["tmux", "send-keys", "-t", `=${host.session}:`, ...values], "terminal input failed");
  }

  function submit(host: CanaryHost, text: string): void {
    // All fixture drafts are one line. Home then kill-to-end also clears rewind-prefilled text.
    keys(host, "C-a", "C-k");
    keys(host, "-l", text);
    keys(host, "Enter");
  }

  function paneMatches(host: CanaryHost, matches: (pane: string) => boolean): boolean {
    const pane = command(["tmux", "capture-pane", "-p", "-t", `=${host.session}:`], "terminal observation failed", false, { maxBuffer: 64 * 1024 });
    return matches(pane ?? "");
  }

  try {
    const options = parseCanaryArgs(args);
    const binary = await realpath(resolve(options.omp));
    if (!isStockOmpBinary(binary)) throw new CanaryFailure("stock mainline OMP is required");
    stockBinary = binary;
    const installed = await readCanaryPackage(dirname(dirname(binary)));
    ompVersion = installed.ompVersion;
    const engineError = canaryBunEngineError(installed, Bun.version);
    if (engineError !== undefined) throw new CanaryFailure(engineError);
    root = await mkdtemp(join(tmpdir(), "omp-upstream-canary-"));
    await chmod(root, 0o700);
    const home = join(root, "home");
    const work = join(root, "work");
    await mkdir(home, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    if (windows) {
      const temp = join(root, "temp");
      for (const directory of [temp, join(home, "AppData", "Roaming"), join(home, "AppData", "Local")]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      environment = windowsEnvironment(home, temp, path);
    } else {
      environment = { HOME: home, PATH: path, TERM: "xterm-256color" };
    }
    discoveryDirectory = join(home, ".omp", "run", "collab-hosts");
    reader = new OmpHostReader({ directory: discoveryDirectory, timeoutMs: 5_000 });
    const queriedVersion = parseOmpVersion(ompCommand(binary, ["--version"], "OMP version query failed") ?? "") ?? "";
    if (!isSupportedOmpVersion(queriedVersion)) throw new CanaryFailure("stock OMP >=18.1.20 is required");
    ompVersion = queriedVersion;
    stage = "publish";
    ompCommand(binary, ["config", "set", "collab.autoStart", "control"], "auto-start configuration failed");
    // A settings write can exit 0 without persisting; the host's own read-back is the proof.
    const readBack = ompCommand(binary, ["config", "get", "collab.autoStart", "--json"], "auto-start read-back failed") ?? "";
    let autoStart: unknown;
    try { autoStart = parseJsonRecord(readBack, "OMP auto-start").value; } catch { autoStart = undefined; }
    if (autoStart !== "control") throw new CanaryFailure("collab.autoStart does not read back as control");
    const fixtureArgs = OMP_FIXTURE_ARGS.map((value, index) =>
      options.model !== undefined && OMP_FIXTURE_ARGS[index - 1] === "--model" ? options.model : value);
    let host = await launchHost(binary, fixtureArgs, false);
    let entry: OmpDiscoveryEntry | undefined;
    await waitFor(async () => {
      entry = (await reader!.listEntries()).find(candidate => candidate.pid === host.pid);
      return entry !== undefined;
    }, 90_000, "publication timed out");
    if (entry === undefined) throw new CanaryFailure("publication timed out");

    stage = "snapshot";
    const snapshot = await reader.snapshot(entry);
    if (snapshot.status !== "ok") throw new CanaryFailure("snapshot query failed");
    if (snapshot.value.generation !== 1 || snapshot.value.access !== "control") throw new CanaryFailure("snapshot contract mismatch");
    const model = snapshot.value.model;
    const modelError = fixtureModelError({ model: model === undefined ? undefined : `${model.provider}/${model.id}` }, options.model);
    if (modelError !== undefined) throw new CanaryFailure(modelError);
    let generation = snapshot.value.generation;

    stage = "stale-generation";
    const stale = await reader.link(entry, "view", generation + 1);
    if (stale.status !== "refused") throw new CanaryFailure("stale generation was not refused");

    stage = "view";
    // Like relay-soak.ts, preserve the pinned client’s separate, relaxed TypeScript boundary.
    const moduleUrl = new URL("../packages/collab-client/upstream/src/lib/client.ts", import.meta.url).href;
    const { GuestClient } = await import(moduleUrl) as CanaryClientModule;
    if (typeof GuestClient !== "function") throw new CanaryFailure("embedded client is unavailable");
    async function joinGuest(access: "view" | "control"): Promise<CanaryGuestClient> {
      const link = await reader!.link(entry!, access, generation);
      if (link.status !== "ok") throw new CanaryFailure("capability query failed");
      const guest = new GuestClient(link.value.reveal(), "upstream-canary");
      guests.add(guest);
      guest.connect();
      await waitFor(() => guest.getSnapshot().phase === "live", 30_000, "guest join timed out");
      if (guest.getSnapshot().readOnly !== (access === "view")) throw new CanaryFailure("guest access mismatch");
      return guest;
    }
    function closeGuests(): void {
      for (const guest of guests) {
        guest.close();
        guests.delete(guest);
      }
    }
    async function promptSettled(guest: CanaryGuestClient, marker: string): Promise<void> {
      await waitFor(() => {
        const current = guest.getSnapshot();
        return current.phase === "live" && !current.working && hasCanaryPrompt(current.entries, marker);
      }, 30_000, "prompt transcript timed out");
    }
    async function currentView(): Promise<CanaryGuestClient> {
      const control = await reader!.link(entry!, "control", generation);
      if (control.status !== "ok") throw new CanaryFailure("control capability query failed");
      return joinGuest("view");
    }
    async function rotate(commandText: "/new" | "/fork"): Promise<CanaryGuestClient> {
      const previous = entry!;
      const previousGeneration = generation;
      closeGuests();
      submit(host, commandText);
      await waitFor(async () => {
        const candidate = (await reader!.listEntries()).find(value => value.instanceId === previous.instanceId);
        if (candidate === undefined) return false;
        const next = await reader!.snapshot(candidate);
        if (next.status !== "ok" || next.value.generation !== previousGeneration + 1) return false;
        entry = candidate;
        generation = next.value.generation;
        return true;
      }, 30_000, "generation rotation timed out");
      // Sampling cannot prove the revoke/publication ordering; require refusal once new is visible.
      for (const access of ["view", "control"] as const) {
        if ((await reader!.link(entry!, access, previousGeneration)).status !== "refused") throw new CanaryFailure("old generation was not refused");
      }
      return currentView();
    }

    await joinGuest("view");
    stage = "control";
    const controlGuest = await joinGuest("control");
    let resumeMarker = `upstream-canary-${crypto.randomUUID()}`;
    controlGuest.sendPrompt(resumeMarker);
    await promptSettled(controlGuest, resumeMarker);

    if (!windows) {
      stage = "new-generation";
      let viewGuest = await rotate("/new");

      stage = "fork";
      const earlierMarker = `upstream-canary-earlier-${crypto.randomUUID()}`;
      const laterMarker = `upstream-canary-later-${crypto.randomUUID()}`;
      submit(host, earlierMarker);
      await promptSettled(viewGuest, earlierMarker);
      submit(host, laterMarker);
      await promptSettled(viewGuest, laterMarker);
      // Stock /fork immediately copies the session; it does not open a message selector.
      viewGuest = await rotate("/fork");
      if (!hasCanaryPrompt(viewGuest.getSnapshot().entries, earlierMarker)
        || !hasCanaryPrompt(viewGuest.getSnapshot().entries, laterMarker)) throw new CanaryFailure("fork history missing");

      stage = "branch-rewind";
      submit(host, "/branch");
      await waitFor(() => paneMatches(host, pane => /^\s*↶ Rewind · pick the point to continue from\s*$/mu.test(pane)), 10_000, "rewind selector timed out");
      keys(host, "Up", "Enter");
      // Guest snapshots replicate every entry, including sibling branches, not the active leaf.
      // A fresh guest therefore cannot prove rewind by the absence of an old message.
      await waitFor(() => paneMatches(host, hasRewindConfirmation), 10_000, "rewind confirmation timed out");
      const rewound = await reader.snapshot(entry);
      if (rewound.status !== "ok" || rewound.value.instanceId !== entry.instanceId
        || rewound.value.generation !== generation) throw new CanaryFailure("rewind identity or generation changed");
      closeGuests();
      viewGuest = await currentView();
      // A new exact prompt proves Home/kill-to-end cleared the draft restored by the rewind.
      resumeMarker = `upstream-canary-resume-${crypto.randomUUID()}`;
      submit(host, resumeMarker);
      await promptSettled(viewGuest, resumeMarker);
      keys(host, "C-a", "C-k");
    }

    stage = "continue";
    const previousEntry = entry;
    const previousGeneration = generation;
    closeGuests();
    stopHost(host);
    await waitFor(async () => hostExited(host) && ((await reader!.snapshot(previousEntry)).status === "gone"
      || !(await reader!.listEntries()).some(candidate => candidate.instanceId === previousEntry.instanceId)), 30_000, "previous host unregister timed out");
    host = await launchHost(binary, fixtureArgs, true);
    await waitFor(async () => {
      const candidate = (await reader!.listEntries()).find(value => value.pid === host.pid && value.instanceId !== previousEntry.instanceId);
      if (candidate === undefined) return false;
      const resumed = await reader!.snapshot(candidate);
      if (resumed.status !== "ok") return false;
      if (resumed.value.generation !== 1) throw new CanaryFailure("resumed generation was not one");
      entry = candidate;
      generation = resumed.value.generation;
      return true;
    }, 90_000, "resumed publication timed out");
    for (const access of ["view", "control"] as const) {
      const oldLink = await reader.link(previousEntry, access, previousGeneration);
      if (oldLink.status !== "refused" && oldLink.status !== "gone") throw new CanaryFailure("previous host capability was not revoked");
    }
    const resumedGuest = await currentView();
    if (!hasCanaryPrompt(resumedGuest.getSnapshot().entries, resumeMarker)) throw new CanaryFailure("resumed session marker missing");

    stage = "unregister";
    closeGuests();
    stopHost(host);
    await waitFor(observeStoppedHosts, 30_000, "unregister timed out");
    if (interrupted) throw new CanaryFailure("interrupted");
  } catch (error) {
    failedStage = stage;
    // Never forward exceptions from OMP, the reader, or GuestClient: they may contain bearer data.
    reason = error instanceof CanaryFailure ? error.message : "operation failed";
  } finally {
    // The primary outcome is already captured above; cleanup appends its own redacted verdict.
    let cleanupFailed = false;
    for (const guest of guests) {
      try { guest.close(); } catch { cleanupFailed = true; }
    }
    for (const host of hosts) {
      try {
        stopHost(host);
        await waitFor(() => hostExited(host), 10_000, "host stop timed out", true);
      } catch { cleanupFailed = true; }
      if (host.session !== undefined) {
        command(["tmux", "kill-session", "-t", `=${host.session}`], "session cleanup failed", true);
        if (command(["tmux", "has-session", "-t", `=${host.session}`], "session cleanup failed", true) !== undefined) cleanupFailed = true;
      }
    }
    try {
      await waitFor(observeStoppedHosts, 30_000, "discovery cleanup timed out", true);
      // The verdict above is already fixed. Let OMP, never the gateway, prune its dead publication.
      if (reader !== undefined && !discoveryFileRemoved && stockBinary !== undefined) {
        ompCommand(stockBinary, ["collab", "list"], "OMP-owned cleanup failed");
      }
      // Refuse to recursively remove a surviving discovery file, including one the reader rejected.
      // OMP alone owns unregistering; rmdir succeeds only once its discovery directory is empty.
      let discoveryRemoved = true;
      if (discoveryDirectory !== undefined) {
        discoveryRemoved = await rmdir(discoveryDirectory).then(() => true, (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
      }
      if (!discoveryRemoved) cleanupFailed = true;
      else if (root !== undefined) await rm(root, { recursive: true, force: true });
    } catch { cleanupFailed = true; }
    if (cleanupFailed) {
      failedStage ??= "unregister";
      reason = reason === undefined ? "cleanup failed" : `${reason}; cleanup failed`;
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  return { summary: canarySummary(ompVersion, Math.round(performance.now() - started), failedStage, discoveryFileRemoved, windows ? "windows" : "posix"), ...(reason === undefined ? {} : { reason }) };
}

if (import.meta.main) {
  // The vendored client can warn with raw frame errors. This CLI's only diagnostics are the
  // allowlisted report and fixed stage reasons below; never expose upstream console arguments.
  for (const method of ["log", "info", "warn", "error", "debug", "dir", "trace", "table"] as const) console[method] = () => {};
  const { summary, reason } = await runCanary(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.failedStage !== undefined) process.stderr.write(`${summary.failedStage}: ${reason}\n`);
  process.exitCode = summary.failedStage === undefined ? 0 : 1;
}
