import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConfig } from "./config.ts";
import { assertQualificationLogDirectory } from "./logger.ts";
type ServicePathConfig = Pick<GatewayConfig, "paths">;

export interface ServiceDefinition {
  readonly identifier: "omp-session-gateway";
  readonly path: string;
  readonly content: string;
}

export interface UserServiceStatus {
  readonly installed: boolean;
  readonly active: boolean;
}

function serviceArgv(installedCli?: string, readinessInstance?: string, qualificationLogDirectory?: string): readonly string[] {
  const fallbackSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const cliSource = resolve(installedCli ?? process.argv[1] ?? fallbackSource);
  const argv = basename(process.execPath).startsWith("bun")
    ? [process.execPath, cliSource, "serve"]
    : [process.execPath, "serve"];
  if (readinessInstance !== undefined) argv.push("--readiness-instance", readinessInstance);
  if (qualificationLogDirectory !== undefined) argv.push("--qualification-log-dir", qualificationLogDirectory);
  return argv;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Every form in which a rendered service definition can embed `path`: raw, XML-escaped (LaunchAgent
 * plist and Windows task XML), or JSON-escaped (systemd `ExecStart`). Readers match all of them.
 */
export function serializedPathForms(path: string): readonly string[] {
  return [...new Set([path, xmlEscape(path), JSON.stringify(path).slice(1, -1)])];
}

/** Where `platform`'s service definition lives. Needs no installing user, unlike its content. */
export function serviceDefinitionPath(
  config: ServicePathConfig,
  platform = process.platform,
  homeDirectory = homedir(),
): string {
  if (platform === "linux") {
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", "omp-session-gateway.service");
  }
  if (platform === "darwin") return join(homeDirectory, "Library", "LaunchAgents", "omp-session-gateway.plist");
  if (platform === "win32") return join(config.paths.configDir, "omp-session-gateway-task.xml");
  throw new Error(`unsupported platform: ${platform}`);
}

const WINDOWS_SID = /^S-1-\d+(?:-\d+)+$/u;

/**
 * `windowsUserSid` is the installing account, which the Windows task's logon trigger names: a
 * `<LogonTrigger>` without a `<UserId>` fires on any user's logon, and only an administrator may
 * register one, so a standard user's install was refused with "Access is denied" (#294).
 */
export function serviceDefinition(
  config: ServicePathConfig,
  platform = process.platform,
  installedCli?: string,
  readinessInstance?: string,
  homeDirectory = homedir(),
  windowsUserSid?: string,
  qualificationLogDirectory?: string,
): ServiceDefinition {
  if (readinessInstance !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(readinessInstance)) {
    throw new Error("invalid service readiness instance");
  }
  if (qualificationLogDirectory !== undefined) assertQualificationLogDirectory(qualificationLogDirectory);
  const argv = serviceArgv(installedCli, readinessInstance, qualificationLogDirectory);
  if (platform === "linux") {
    const command = argv.map(value => JSON.stringify(value)).join(" ");
    // systemd refuses to start a unit whose ReadWritePaths= names a path that does not exist, and
    // the runtime directory does not exist until the daemon binds its socket. That is invisible at
    // install time, when a previous run has already created it, and fatal after a reboot: the user
    // manager comes up, the unit fails, and the gateway silently never returns. Let systemd own the
    // directory instead. RuntimeDirectory= creates it before start and it is implicitly writable,
    // so it must not also appear in ReadWritePaths=. The mode is explicit because systemd defaults
    // to 0755 while the gateway asserts a private runtime directory and would refuse to start.
    const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
    const runtimeManagedBySystemd =
      xdgRuntimeDir !== undefined && config.paths.runtimeDir === join(xdgRuntimeDir, "omp-session-gateway");
    const readWritePaths = [config.paths.configDir, config.paths.stateDir];
    if (qualificationLogDirectory !== undefined) readWritePaths.push(qualificationLogDirectory);
    if (!runtimeManagedBySystemd) readWritePaths.push(config.paths.runtimeDir);
    const runtimeDirectory = runtimeManagedBySystemd
      ? "RuntimeDirectory=omp-session-gateway\nRuntimeDirectoryMode=0700\n"
      : "";
    return {
      identifier: "omp-session-gateway",
      path: serviceDefinitionPath(config, platform, homeDirectory),
      content: `[Unit]\nDescription=OMP Session Gateway\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\n${qualificationLogDirectory === undefined ? "" : "StandardOutput=null\nStandardError=null\n"}NoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\n${runtimeDirectory}ReadWritePaths=${readWritePaths.map(value => JSON.stringify(value)).join(" ")}\n\n[Install]\nWantedBy=default.target\n`,
    };
  }
  if (platform === "darwin") {
    const argumentsXml = argv.map(value => `      <string>${xmlEscape(value)}</string>`).join("\n");
    return {
      identifier: "omp-session-gateway",
      path: serviceDefinitionPath(config, platform, homeDirectory),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key><string>omp-session-gateway</string>\n    <key>ProgramArguments</key>\n    <array>\n${argumentsXml}\n    </array>\n    <key>RunAtLoad</key><true/>\n    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n    <key>ProcessType</key><string>Background</string>\n    <key>StandardOutPath</key><string>/dev/null</string>\n    <key>StandardErrorPath</key><string>/dev/null</string>\n  </dict>\n</plist>\n`,
    };
  }
  if (platform === "win32") {
    const executable = argv[0];
    if (executable === undefined) throw new Error("service executable is unavailable");
    if (windowsUserSid === undefined || !WINDOWS_SID.test(windowsUserSid)) {
      throw new Error("a Windows task definition needs the installing user's SID");
    }
    const argumentsXml = argv
      .slice(1)
      .map(value => `&quot;${xmlEscape(value)}&quot;`)
      .join(" ");
    return {
      identifier: "omp-session-gateway",
      path: serviceDefinitionPath(config, platform, homeDirectory),
      content: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${windowsUserSid}</UserId></LogonTrigger></Triggers>\n  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><AllowHardTerminate>true</AllowHardTerminate><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>\n  <Actions Context="Author"><Exec><Command>${xmlEscape(executable)}</Command><Arguments>${argumentsXml}</Arguments></Exec></Actions>\n</Task>\n`,
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

async function run(command: readonly string[]): Promise<void> {
  const subprocess = Bun.spawn([...command], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(subprocess.stderr).text();
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(`${command[0] ?? "service command"} failed: ${stderr.trim()}`);
}

async function commandSucceeds(command: readonly string[]): Promise<boolean> {
  try {
    const subprocess = Bun.spawn([...command], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await subprocess.exited) === 0;
  } catch {
    return false;
  }
}

async function commandOutput(command: readonly string[]): Promise<string | undefined> {
  try {
    const subprocess = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(subprocess.stdout).text();
    return (await subprocess.exited) === 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The installing account's SID, from its own token. The SID rather than `DOMAIN\user`: `whoami`
 * writes the name in the console code page, which mangles a non-ASCII account name, and a SID is
 * ASCII everywhere.
 */
async function installingWindowsUserSid(host: ServiceHost): Promise<string> {
  const output = await host.output(["whoami.exe", "/user", "/fo", "csv", "/nh"]);
  const sid = output === undefined ? undefined : /"(S-1-\d+(?:-\d+)+)"\s*$/u.exec(output)?.[1];
  if (sid === undefined) throw new Error("cannot determine the installing Windows user's SID");
  return sid;
}

/**
 * The OS surface the service verbs read and mutate: the running platform and the service-manager
 * commands.
 *
 * Injectable because the ownership rules below cannot be exercised any other way. A service manager
 * keys its registry on identity no filesystem override can scope, so producing a *foreign* holder of
 * the label on the machine running the suite would mean loading a real unit there — and the refusals
 * have to be proven to fire before the first byte is written and before the first mutating command.
 */
export interface ServiceHost {
  readonly platform: typeof process.platform;
  /** Injectable only so macOS file-only ownership can be exercised outside the real home. */
  readonly homeDirectory?: string;
  /** Stdout of a command that exited zero; undefined when it failed or could not be spawned. */
  readonly output: (command: readonly string[]) => Promise<string | undefined>;
  readonly succeeds: (command: readonly string[]) => Promise<boolean>;
  /** Runs a command that must succeed, surfacing its stderr otherwise. */
  readonly run: (command: readonly string[]) => Promise<void>;
}

const systemServiceHost: ServiceHost = {
  platform: process.platform,
  homeDirectory: homedir(),
  output: commandOutput,
  succeeds: commandSucceeds,
  run,
};

/**
 * Whether a service manager's rendering of a loaded unit names a program under `stateDir`.
 *
 * Installed runtimes live at `<stateDir>/installation/versions/<id>/...`, so the install root is a
 * path prefix of the program the OS is actually executing. The trailing separator matters: without
 * it `/tmp/x/state/omp-session-gateway` would match a sibling root like
 * `/tmp/x/state/omp-session-gateway-2`.
 */
export function serviceProgramBelongsTo(programText: string | undefined, stateDir: string): boolean {
  if (programText === undefined) return false;
  return ["/", "\\"].some(separator => {
    const prefix = `${stateDir}${separator}`;
    const jsonEncoded = JSON.stringify(prefix).slice(1, -1);
    const xmlEncoded = xmlEscape(prefix);
    return programText.includes(prefix) || programText.includes(jsonEncoded) || programText.includes(xmlEncoded);
  });
}

type ServiceProgramLookup =
  | { readonly status: "found"; readonly rendered: string }
  | { readonly status: "absent" }
  | { readonly status: "unavailable" };

/**
 * What the service manager would execute for the gateway's label, running or not.
 *
 * Registration, not activity: systemd answers for a unit it has loaded but never started, Task
 * Scheduler for a task sitting idle, launchd for any loaded job. Installing and uninstalling are
 * destructive to all of those, so ownership is read from the manager's own metadata rather than from
 * an activity probe. A failed Linux query is distinct from an absent unit because systemctl reports
 * an unknown unit successfully with an empty ExecStart; failing open on an unavailable user manager
 * would permit a definition write before the later mutation reports the real error.
 */
async function loadedServiceProgram(host: ServiceHost): Promise<ServiceProgramLookup> {
  const query =
    host.platform === "linux"
      ? ["systemctl", "--user", "show", "-p", "ExecStart", "--value", "omp-session-gateway.service"]
      : host.platform === "darwin"
        ? ["launchctl", "print", `gui/${process.getuid?.() ?? 0}/omp-session-gateway`]
        : ["schtasks.exe", "/Query", "/TN", "OMP Session Gateway", "/XML"];
  const rendered = await host.output(query);
  if (rendered === undefined) {
    if (host.platform === "linux") return { status: "unavailable" };
    const managerAvailable =
      host.platform === "darwin"
        ? await host.succeeds(["launchctl", "print", `gui/${process.getuid?.() ?? 0}`])
        : await host.succeeds(["schtasks.exe", "/Query"]);
    return managerAvailable ? { status: "absent" } : { status: "unavailable" };
  }
  return rendered.trim() === "" ? { status: "absent" } : { status: "found", rendered };
}

/**
 * Whether the service instance the OS currently has loaded was installed from *this* config root.
 *
 * Service managers key their registry on identity that no filesystem override can scope: launchd on
 * `gui/<uid>/<label>`, systemd on the user unit name, Task Scheduler on the task name. Pointing
 * `HOME`/`XDG_CONFIG_HOME` at a sandbox therefore isolates every file this program writes and none
 * of the state it reads back, so an install rooted in a temp directory observes the real service and
 * reports it as its own. On 2026-08-19 that cost a live daemon: an isolated archive smoke saw
 * `active: true` from the production service and `rotate-readiness-token` booted it out.
 *
 * The loaded service's own program path is the one piece of identity that does carry the root, so
 * compare against it rather than trusting the label. Returns false when nothing is loaded.
 */
async function loadedServiceIsOurs(config: ServicePathConfig, host: ServiceHost): Promise<boolean> {
  // launchd has no activity gate: a job it has loaded is a job it is keeping alive.
  if (host.platform === "linux") {
    if (!(await host.succeeds(["systemctl", "--user", "is-active", "omp-session-gateway.service"]))) return false;
  } else if (host.platform !== "darwin" && !(await windowsTaskActive(host))) return false;
  const lookup = await loadedServiceProgram(host);
  return lookup.status === "found" && serviceProgramBelongsTo(lookup.rendered, config.paths.stateDir);
}

function serviceRegistryName(host: ServiceHost): string {
  return host.platform === "linux"
    ? "systemd user unit name"
    : host.platform === "darwin"
      ? "launchd label"
      : "scheduled task name";
}

async function existingServiceDefinition(config: ServicePathConfig, host: ServiceHost): Promise<string | undefined> {
  const path = serviceDefinitionPath(config, host.platform, host.homeDirectory);
  try {
    const bytes = await readFile(path);
    if (host.platform !== "win32") return bytes.toString("utf8");
    const offset = bytes[0] === 0xff && bytes[1] === 0xfe ? 2 : 0;
    return bytes.subarray(offset).toString("utf16le");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Refuses when either the manager identity or its shared definition path belongs to another root.
 *
 * The file check covers an install staged with `--no-start`, which has no manager registration yet.
 * The manager check covers loaded definitions whose source file moved or disappeared.
 */
async function assertNoForeignServiceLabel(config: ServicePathConfig, host: ServiceHost): Promise<void> {
  const registry = serviceRegistryName(host);
  const foreign = (): never => {
    throw new Error(
      `another gateway service already holds this ${registry} from a different install root; ` +
        "uninstall it from that root first",
    );
  };
  const definition = await existingServiceDefinition(config, host);
  if (definition !== undefined && !serviceProgramBelongsTo(definition, config.paths.stateDir)) foreign();

  const lookup = await loadedServiceProgram(host);
  if (lookup.status === "unavailable") {
    throw new Error(`cannot verify ${registry} ownership; refusing to modify gateway service state`);
  }
  if (lookup.status === "found" && !serviceProgramBelongsTo(lookup.rendered, config.paths.stateDir)) foreign();
}

/** Fail-closed preflight for callers that mutate service-adjacent state before invoking a verb. */
export async function assertUserServiceOwnership(
  config: ServicePathConfig,
  host: ServiceHost = systemServiceHost,
): Promise<void> {
  await assertNoForeignServiceLabel(config, host);
}


async function bootstrapLaunchAgent(domain: string, path: string, host: ServiceHost): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await host.run(["launchctl", "bootstrap", domain, path]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 19) await Bun.sleep(100);
    }
  }
  throw lastError;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
// The Task Scheduler's own COM interface, not its CIM cmdlets: WMI refuses a standard user's network
// logon (SSH, WinRM), where `Get-ScheduledTask` failed and a running task read as stopped.
const WINDOWS_SCHEDULER = "$scheduler=New-Object -ComObject Schedule.Service; $scheduler.Connect()";
const WINDOWS_TASK = "$task=$scheduler.GetFolder('\\').GetTask('OMP Session Gateway')";
// GetTask's ERROR_FILE_NOT_FOUND (0x80070002) is the one failure meaning no task carries the name.
// Anything else, such as a refused scheduler, is unknown state: rethrow it rather than report no task.
const WINDOWS_TASK_ABSENT_ONLY =
  "$e=$_.Exception; while ($e.InnerException) { $e=$e.InnerException }; if ($e.HResult -ne -2147024894) { throw }";
// State 4 is TASK_STATE_RUNNING.
const WINDOWS_TASK_STATE_SCRIPT = `$ErrorActionPreference='Stop'; ${WINDOWS_SCHEDULER}; try { ${WINDOWS_TASK} } catch { ${WINDOWS_TASK_ABSENT_ONLY}; 'absent'; exit 0 }; if ($task.State -eq 4) { 'running' } else { 'stopped' }`;
// Ending a task reports it Ready at once, while the gateway it ran can hold its port for about 600 ms
// more (run 36291384690), so a restart inside that window failed to bind. Wait for the process itself,
// through a handle opened before the stop, so a reused PID cannot stand in for it. A missing task has
// nothing to stop; an unreachable scheduler is a failed stop.
const WINDOWS_TASK_STOP_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  WINDOWS_SCHEDULER,
  `try { ${WINDOWS_TASK} } catch { ${WINDOWS_TASK_ABSENT_ONLY}; exit 0 }`,
  "$processes=@($task.GetInstances(0) | ForEach-Object { Get-Process -Id $_.EnginePID -ErrorAction SilentlyContinue })",
  "foreach ($process in $processes) { try { [void]$process.Handle } catch {} }",
  "try { $task.Stop(0) } catch {}",
  "$deadline=[DateTime]::UtcNow.AddMilliseconds(7500)",
  "foreach ($process in $processes) { if (-not $process.WaitForExit([Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds))) { exit 1 } }",
  "while ($task.State -eq 4) { if ([DateTime]::UtcNow -gt $deadline) { exit 1 }; Start-Sleep -Milliseconds 100 }",
  "exit 0",
].join("; ");

/** Whether the gateway's task is running. A scheduler that cannot be read is never a stopped task. */
async function windowsTaskActive(host: ServiceHost): Promise<boolean> {
  const state = (
    await host.output(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TASK_STATE_SCRIPT])
  )?.trim();
  if (state === "running") return true;
  if (state === "stopped" || state === "absent") return false;
  throw new Error("cannot read the Windows gateway task's state");
}

export async function assertServiceInstallPreflight(
  activate: boolean,
  host: ServiceHost = systemServiceHost,
): Promise<void> {
  if (host.platform === "win32" && !activate && (await windowsTaskActive(host))) {
    throw new Error("cannot replace an active Windows service with --no-start");
  }
}

async function stopWindowsTask(host: ServiceHost): Promise<void> {
  if (!(await host.succeeds(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TASK_STOP_SCRIPT]))) {
    throw new Error("running gateway task did not stop");
  }
}

export async function userServiceStatus(
  config: ServicePathConfig,
  host: ServiceHost = systemServiceHost,
): Promise<UserServiceStatus> {
  const definitionExists = await fileExists(serviceDefinitionPath(config, host.platform, host.homeDirectory));
  // `active` means "a service this install owns is running", never "some service holds our label".
  // Everything downstream acts on it: rotation restarts, stop boots out, uninstall refuses.
  const active = await loadedServiceIsOurs(config, host);
  if (host.platform === "linux") {
    const installed =
      definitionExists && (await host.succeeds(["systemctl", "--user", "is-enabled", "omp-session-gateway.service"]));
    return { installed, active };
  }
  if (host.platform === "darwin") return { installed: definitionExists, active };
  const installed = await host.succeeds(["schtasks.exe", "/Query", "/TN", "OMP Session Gateway"]);
  return { installed, active };
}

export async function installUserService(
  config: GatewayConfig,
  activate = true,
  installedCli?: string,
  readinessInstance?: string,
  host: ServiceHost = systemServiceHost,
  qualificationLogDirectory?: string,
): Promise<ServiceDefinition> {
  // Ownership first, before `mkdir` and before the definition write. Two roots that share a HOME
  // compute the same definition path, so the write alone replaces the other root's service, and on
  // Linux and Windows the manager mutations that follow act on a label a sandbox cannot scope.
  await assertNoForeignServiceLabel(config, host);
  await assertServiceInstallPreflight(activate, host);
  const windowsUserSid = host.platform === "win32" ? await installingWindowsUserSid(host) : undefined;
  const definition = serviceDefinition(
    config,
    host.platform,
    installedCli,
    readinessInstance,
    host.homeDirectory,
    windowsUserSid,
    qualificationLogDirectory,
  );
  if (!serviceProgramBelongsTo(definition.content, config.paths.stateDir)) {
    throw new Error("gateway service program must be staged under the configured state directory");
  }
  await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
  const serialized =
    host.platform === "win32"
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(definition.content, "utf16le")])
      : definition.content;
  await writeFile(definition.path, serialized, { mode: 0o600 });
  if (host.platform !== "win32") await chmod(definition.path, 0o600);
  if (host.platform === "linux") {
    const wasActive = await host.succeeds(["systemctl", "--user", "is-active", "omp-session-gateway.service"]);
    // Re-read ownership immediately before the manager is touched. Nothing has reloaded yet, so the
    // manager still reports the unit it holds, and an install that landed from another root while
    // this one was writing must not be reloaded, enabled or restarted out from under it.
    await assertNoForeignServiceLabel(config, host);
    await host.run(["systemctl", "--user", "daemon-reload"]);
    await host.run(["systemctl", "--user", "enable", "omp-session-gateway.service"]);
    if (activate) {
      // An explicit install/rollback is an operator request to start now. Clear systemd's start-rate
      // counter first so several successful version switches cannot deadlock the next rollback.
      await host.run(["systemctl", "--user", "reset-failed", "omp-session-gateway.service"]);
      await host.run(["systemctl", "--user", wasActive ? "restart" : "start", "omp-session-gateway.service"]);
    }
  } else if (host.platform === "darwin") {
    if (!activate) return definition;
    const target = `gui/${process.getuid?.() ?? 0}/omp-session-gateway`;
    if (await host.succeeds(["launchctl", "print", target])) {
      // Replacing our own running instance is the ordinary upgrade path. Booting out a service that
      // belongs to a different install root is how a sandboxed run kills the real daemon, so refuse
      // instead: launchd keys the label on uid alone and cannot tell the two apart for us.
      await assertNoForeignServiceLabel(config, host);
      await host.run(["launchctl", "bootout", target]);
    }
    await assertNoForeignServiceLabel(config, host);
    await bootstrapLaunchAgent(`gui/${process.getuid?.() ?? 0}`, definition.path, host);
  } else {
    const status = await userServiceStatus(config, host);
    await assertNoForeignServiceLabel(config, host);
    if (status.active) {
      await stopWindowsTask(host);
      await assertNoForeignServiceLabel(config, host);
    }
    await host.run(["schtasks.exe", "/Create", "/TN", "OMP Session Gateway", "/XML", definition.path, "/F"]);
    if (activate) await host.run(["schtasks.exe", "/Run", "/TN", "OMP Session Gateway"]);
  }
  return definition;
}

export async function stopUserService(config: ServicePathConfig, host: ServiceHost = systemServiceHost): Promise<void> {
  await assertNoForeignServiceLabel(config, host);
  const status = await userServiceStatus(config, host);
  // `active` is ownership-scoped, so a foreign holder of the label leaves nothing here to stop.
  if (!status.active) return;
  // The label can be replaced after the status probe; re-read immediately before stopping it.
  await assertNoForeignServiceLabel(config, host);
  if (host.platform === "linux") {
    await host.run(["systemctl", "--user", "stop", "omp-session-gateway.service"]);
  } else if (host.platform === "darwin") {
    const target = `gui/${process.getuid?.() ?? 0}/omp-session-gateway`;
    await host.run(["launchctl", "bootout", target]);
  } else {
    await stopWindowsTask(host);
  }
  if ((await userServiceStatus(config, host)).active) throw new Error("gateway service remained active after stop");
}

export async function uninstallUserService(
  config: ServicePathConfig,
  deactivate = true,
  host: ServiceHost = systemServiceHost,
): Promise<void> {
  // `installed` answers for the label, not for the root that owns it: `schtasks /Query` finds any
  // task carrying our name and `systemctl is-enabled` any unit carrying our unit name. Every branch
  // below acts on that — `disable --now`, `/End`, `/Delete` — and the closing `rm` targets a path
  // two roots sharing a HOME compute identically. Refuse first, so an uninstall run from one root
  // cannot stop, delete or unfile another root's service.
  await assertNoForeignServiceLabel(config, host);
  const definitionPath = serviceDefinitionPath(config, host.platform, host.homeDirectory);
  const status = await userServiceStatus(config, host);
  if (!deactivate && status.active) {
    throw new Error("cannot uninstall an active gateway with --no-stop");
  }
  // The status probes are read-only but not atomic with manager mutation; close that interleaving.
  await assertNoForeignServiceLabel(config, host);
  if (host.platform === "linux") {
    if (status.installed || status.active) {
      await host.run([
        "systemctl",
        "--user",
        "disable",
        ...(deactivate ? ["--now"] : []),
        "omp-session-gateway.service",
      ]);
    }
  } else if (host.platform === "darwin") {
    if (deactivate && status.active) {
      await host.run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/omp-session-gateway`]);
    }
  } else if (status.installed) {
    if (deactivate && status.active) {
      await stopWindowsTask(host);
      await assertNoForeignServiceLabel(config, host);
    }
    await host.run(["schtasks.exe", "/Delete", "/TN", "OMP Session Gateway", "/F"]);
  }
  await assertNoForeignServiceLabel(config, host);
  await rm(definitionPath, { force: true });
  if (host.platform === "linux") await host.run(["systemctl", "--user", "daemon-reload"]);
}
