import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { executeFixture, type FixtureExecutor } from "./push-qualification-fixture.ts";
import { findCapabilityLeaks } from "./capability-leak-rules.ts";
import { findIdentifierLeaks } from "./identifier-leak-rules.ts";

export const FLEET_PUSH_SOURCE_ID = "push-qualification";
export const FLEET_PUSH_SOURCE_LABEL = "Qualification source";
export const FLEET_PUSH_LOCAL_LABEL = "Qualification home";
export const FLEET_PUSH_HTTPS_PORT = 10443;
export const FLEET_PUSH_BACKEND_PORT = 14318;
export type FleetFixtureOperation = "prepare" | "source-down" | "source-up" | "coordinator-down" | "coordinator-up" | "audit" | "restore";

export function fleetPushSource(origin: string) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:" || url.port !== "") throw new Error("invalid fleet qualification coordinator origin");
  url.port = String(FLEET_PUSH_HTTPS_PORT);
  const sourceOrigin = url.origin;
  const binding = createHash("sha256").update(`omp-fleet-binding-v1\0${FLEET_PUSH_SOURCE_ID}\0${sourceOrigin}`).digest("base64url").slice(0, 22);
  return { id: FLEET_PUSH_SOURCE_ID, label: FLEET_PUSH_SOURCE_LABEL, origin: sourceOrigin, binding };
}

interface FixtureState {
  epoch: string; origin: string; commit: string; config: string; changedConfig: string;
  plist: string; bun: string; cli: string; serve: string; fleetStateAbsent: boolean;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
class FleetSourceOwnershipError extends Error {}

/** Private helper response, consumed in memory by the controller; never receipt evidence. */
export function fleetFixtureDiagnostic(error: unknown): { message: string; stack: string }[] {
  const seen = new Set<Error>(), entries: { message: string; stack: string }[] = [];
  const redact = (text: string) => {
    if (Buffer.byteLength(text) > 4096) return "[oversized helper diagnostic withheld]";
    return text.split("\n").map(line => {
      while (line.includes("identifier-leak-allow")) line = line.replaceAll("identifier-leak-allow", "");
      if (findCapabilityLeaks(line).length) return "[capability-bearing helper diagnostic withheld]";
      for (const finding of findIdentifierLeaks(line)) line = line.replaceAll(finding.match, `[redacted ${finding.label}]`);
      return line;
    }).join("\n");
  };
  const visit = (value: unknown) => {
    if (entries.length >= 16 || !(value instanceof Error) || seen.has(value)) return;
    seen.add(value);
    entries.push({ message: redact(value.message), stack: redact(value.stack ?? value.message) });
    visit(value.cause);
    if (value instanceof AggregateError) for (const child of value.errors) visit(child);
  };
  visit(error);
  return entries;
}

/** Runs on the lane host. No grants, subscriptions, capabilities or raw daemon output are copied. */
export async function fleetPushFixture(operation: FleetFixtureOperation, root: string, epoch: string, origin: string,
  commit: string, execute: FixtureExecutor = executeFixture, homeDirectory = homedir()): Promise<void> {
  if (root !== resolve(root) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(epoch) ||
    !/^[0-9a-f]{40}$/u.test(commit) || basename(root) !== `fleet-${epoch}`) throw new Error("invalid fleet fixture identity");
  const source = fleetPushSource(origin);
  const statePath = join(root, "owner.json"), home = join(root, "home");
  const configPath = join(homeDirectory, ".config/omp-session-gateway/config.json");
  const fleetStatePath = join(homeDirectory, ".local/state/omp-session-gateway/fleet-notifications.json");
  const sourceConfigPath = join(home, ".config/omp-session-gateway/config.json");
  const run = async (argv: readonly string[]) => {
    const result = await execute(argv);
    if (result.exitCode !== 0) throw new Error(`fleet fixture ${argv[0]} command exited ${result.exitCode}`);
    return result.stdout;
  };
  const serve = async () => run(["tailscale", "serve", "status", "--json"]);
  const serveKey = `${new URL(origin).hostname}:${FLEET_PUSH_HTTPS_PORT}`;
  const ownsServe = (raw: string): boolean => {
    const value = JSON.parse(raw);
    return value.TCP?.[FLEET_PUSH_HTTPS_PORT]?.HTTPS === true &&
      value.Web?.[serveKey]?.Handlers?.["/"]?.Proxy === `http://127.0.0.1:${FLEET_PUSH_BACKEND_PORT}`;
  };
  const service = async (start: boolean, state: FixtureState) => {
    const uid = (await run(["id", "-u"])).trim();
    if (!/^(?:0|[1-9]\d*)$/u.test(uid)) throw new Error("fleet service account identity unavailable");
    const domain = `gui/${uid}`;
    const status = await execute(["launchctl", "print", `${domain}/omp-session-gateway`]);
    if (start && status.exitCode !== 0) await run(["launchctl", "bootstrap", domain, state.plist]);
    if (!start && status.exitCode === 0) await run(["launchctl", "bootout", domain, state.plist]);
  };
  const atomic = async (path: string, text: string) => {
    await writeFile(`${path}.tmp`, text, { mode: 0o600 }); await rename(`${path}.tmp`, path);
  };
  let state: FixtureState | undefined;
  try { state = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (!absent(error)) throw error; }
  if (state !== undefined && (state.epoch !== epoch || state.origin !== origin || state.commit !== commit)) throw new Error("fleet fixture owner changed");
  if (operation === "prepare") {
    if (state !== undefined) throw new Error("fleet fixture requires restoration before another prepare");
    const config = await readFile(configPath, "utf8"), document = JSON.parse(config);
    // Never widen an existing user's fleet or take ownership of their enrollment records.
    if (document.http?.publicOrigin !== origin || document.auth?.mode === "dev-localhost" ||
      (document.fleet?.targets?.length ?? 0) !== 0 || (document.notifications?.sources?.length ?? 0) !== 0 ||
      (document.notifications?.coordinators?.length ?? 0) !== 0) throw new Error("fleet qualification requires an isolated home-only candidate");
    const plist = join(homeDirectory, "Library/LaunchAgents/omp-session-gateway.plist");
    const args = JSON.parse(await run(["plutil", "-extract", "ProgramArguments", "json", "-o", "-", plist])) as unknown;
    if (!Array.isArray(args) || typeof args[0] !== "string" || typeof args[1] !== "string" || args[2] !== "serve") throw new Error("fleet candidate service identity unavailable");
    const cli = args[1], bun = args[0];
    if (!cli.endsWith(`${sep}${join("apps", "gateway", "src", "cli.js")}`)) throw new Error("fleet requires an installed candidate runtime");
    const manifest = JSON.parse(await readFile(join(cli, "../../../..", "release-info.json"), "utf8"));
    if (manifest.sourceCommit !== commit) throw new Error("fleet gateway is not the lane candidate");
    // Never copy or overwrite a pre-existing credential ledger, even an unused one.
    const priorFleetState = await readFile(fleetStatePath).catch(error => { if (absent(error)) return undefined; throw error; });
    if (priorFleetState !== undefined) throw new Error("fleet qualification requires no prior enrollment ledger");
    const beforeServe = await serve(), mapping = JSON.parse(beforeServe);
    if (mapping.TCP?.[FLEET_PUSH_HTTPS_PORT] !== undefined || mapping.Web?.[serveKey] !== undefined) throw new Error("fleet source Serve port already owned");
    const listener = await execute(["lsof", "-nP", `-iTCP:${FLEET_PUSH_BACKEND_PORT}`, "-sTCP:LISTEN"]);
    if (listener.exitCode !== 1 || listener.stdout.trim() !== "") throw new Error("fleet source backend ownership unavailable");
    await mkdir(root, { mode: 0o700 });
    const changedConfig = JSON.stringify({ ...document,
      fleet: { label: FLEET_PUSH_LOCAL_LABEL, targets: [{ id: source.id, label: source.label, origin: source.origin }] },
      notifications: { sources: [source.id] } });
    state = { epoch, origin, commit, config, changedConfig, plist, bun, cli, serve: beforeServe, fleetStateAbsent: true };
    // Persist restoration authority before touching the service, config, or Serve mapping.
    const pendingOwner = `${statePath}.tmp`;
    const owner = await open(pendingOwner, "wx", 0o600);
    try {
      await owner.writeFile(JSON.stringify(state));
      await owner.sync();
    } finally { await owner.close(); }
    await rename(pendingOwner, statePath);
    // Same NTFS boundary as config.ts writePrivateTextFile: directory handles cannot be
    // fsynced on Windows. The physical macOS host always requires this directory sync.
    if (process.platform !== "win32") {
      const directory = await open(root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    await mkdir(join(home, ".config/omp-session-gateway"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, ".omp/run/collab-hosts"), { recursive: true, mode: 0o700 });
    await atomic(sourceConfigPath, JSON.stringify({ http: { hostname: "127.0.0.1", port: FLEET_PUSH_BACKEND_PORT,
      publicOrigin: source.origin, trustedDashboardOrigins: [origin] }, auth: document.auth,
      fleet: { label: source.label, targets: [] }, notifications: { coordinators: [{ id: "qualification-home", origin }] },
      omp: { discoveryDir: join(home, ".omp/run/collab-hosts") } }));
    await service(false, state);
    await atomic(configPath, changedConfig);
    await run(["tailscale", "serve", "--bg", `--https=${FLEET_PUSH_HTTPS_PORT}`, `http://127.0.0.1:${FLEET_PUSH_BACKEND_PORT}`]);
    if (!ownsServe(await serve())) throw new Error("fleet Serve mapping did not match");
    await service(true, state);
  }
  if (state === undefined) {
    if (operation !== "restore") throw new Error("fleet fixture owner unavailable");
    // A pre-owner interruption owns only an empty directory.
    await rmdir(root).catch(error => { if (!absent(error)) throw error; });
    return;
  }
  const sourcePidPath = join(root, "source.pid"), childPidPath = join(root, "source-child.pid");
  const sourceCommand = `${state.bun} ${state.cli} serve`;
  const alive = async (path: string, command: string): Promise<number | undefined> => {
    let text: string;
    try { text = await readFile(path, "utf8"); } catch (error) { if (absent(error)) return; throw error; }
    if (!/^[1-9]\d*$/u.test(text)) throw new Error("invalid fleet source PID");
    const pid = Number(text);
    const result = await execute(["ps", "-ww", "-p", text, "-o", "stat=,command="]);
    if (result.exitCode === 1 && result.stdout.trim() === "") return;
    if (result.exitCode !== 0) throw new Error("fleet source process probe failed");
    if (result.stdout.trimStart().startsWith("Z")) return;
    if (!result.stdout.includes(command)) throw new FleetSourceOwnershipError("fleet source process ownership changed");
    return pid;
  };
  const sourceAlive = () => alive(sourcePidPath, join(root, "source.sh"));
  const childAlive = () => alive(childPidPath, sourceCommand);
  const backendAbsent = async () => {
    const listener = await execute(["lsof", "-nP", `-iTCP:${FLEET_PUSH_BACKEND_PORT}`, "-sTCP:LISTEN"]);
    if (listener.exitCode === 1 && listener.stdout.trim() === "") return true;
    if (listener.exitCode !== 0) throw new Error("fleet source backend probe failed");
    return false;
  };
  const stopSource = async () => {
    const pid = await sourceAlive();
    if (pid === undefined) {
      const processes = await run(["ps", "-ww", "-axo", "command="]);
      if (processes.includes(join(root, "source.sh"))) throw new Error("fleet source dispatch has no settled PID owner");
    }
    if (pid !== undefined) await run(["kill", "-TERM", String(pid)]);
    const deadline = Date.now() + 30_000;
    let childSignalled = false;
    for (;;) {
      let unsettled: unknown, parentGone = false, childGone = false;
      try { parentGone = await sourceAlive() === undefined; }
      catch (error) {
        // Command loss while exiting is not exit proof or permission to signal that PID again.
        if (!(error instanceof FleetSourceOwnershipError)) throw error;
        unsettled = error;
      }
      try {
        const child = await childAlive();
        childGone = child === undefined;
        if (parentGone && child !== undefined && !childSignalled) {
          await run(["kill", "-TERM", String(child)]);
          childSignalled = true;
        }
      } catch (error) {
        if (!(error instanceof FleetSourceOwnershipError)) throw error;
        unsettled = error;
      }
      if (parentGone && childGone && await backendAbsent()) break;
      if (Date.now() >= deadline) throw new Error("fleet source did not stop", { cause: unsettled });
      await Bun.sleep(100);
    }
    await rm(sourcePidPath, { force: true });
    await rm(childPidPath, { force: true });
  };
  if (operation === "source-down" || operation === "restore") await stopSource();
  if (operation === "coordinator-down") await service(false, state);
  if (operation === "coordinator-up") await service(true, state);
  if (operation === "source-up" || operation === "prepare") {
    if (await sourceAlive() !== undefined || await childAlive() !== undefined || !await backendAbsent()) throw new Error("fleet source already running");
    const script = join(root, "source.sh");
    // Keep a uniquely owned parent process; its trap terminates and waits for the daemon child.
    await atomic(script, ["#!/bin/sh", "child=",
      "stop() {", "  trap '' TERM INT", "  trap - EXIT", '  child=${child:-$!}',
      '  if [ -n "$child" ]; then',
      `    printf %s "$child" > ${quote(`${childPidPath}.tmp`)} && mv ${quote(`${childPidPath}.tmp`)} ${quote(childPidPath)}`,
      `    case "$(ps -ww -p "$child" -o command=)" in`,
      `      ${quote(sourceCommand)}) kill -TERM "$child" 2>/dev/null ;;`,
      "    esac", '    wait "$child" 2>/dev/null', "  fi", "  exit", "}",
      "trap stop TERM INT EXIT",
      `printf %s $$ > ${quote(`${sourcePidPath}.tmp`)} && mv ${quote(`${sourcePidPath}.tmp`)} ${quote(sourcePidPath)} || exit 1`,
      `env -u XDG_RUNTIME_DIR HOME=${quote(home)} XDG_CONFIG_HOME=${quote(join(home, ".config"))} XDG_STATE_HOME=${quote(join(home, ".local/state"))} ${quote(state.bun)} ${quote(state.cli)} serve &`,
      'child=$!',
      `printf %s "$child" > ${quote(`${childPidPath}.tmp`)} && mv ${quote(`${childPidPath}.tmp`)} ${quote(childPidPath)} || exit 1`,
      'wait "$child"', ""].join("\n"));
    // Like the existing OMP fixture holder, leave the SSH session before exec. nohup alone
    // does not keep this supervisor alive when the remote command's session is torn down.
    const detach = 'import os,sys; os.setsid(); os.execv("/bin/sh", ["sh", sys.argv[1]])';
    await run(["sh", "-c", `nohup python3 -c ${quote(detach)} ${quote(script)} </dev/null >/dev/null 2>&1 &`]);
    const deadline = Date.now() + 30_000;
    while (true) {
      const result = await execute(["curl", "--silent", "--fail", "--max-time", "2", `http://127.0.0.1:${FLEET_PUSH_BACKEND_PORT}/api/v1/health`]);
      if (result.exitCode === 0 && await sourceAlive() !== undefined && await childAlive() !== undefined) break;
      if (Date.now() >= deadline) throw new Error("fleet source readiness unavailable");
      await Bun.sleep(100);
    }
  }
  if (operation === "audit") {
    const marker = `https://synthetic.example.test/#synthetic-fleet.${"SYNTHETIC_CANARY_".repeat(3).slice(0, 43)}`;
    const control = join(root, "audit-control.json");
    try {
      await writeFile(control, JSON.stringify({ synthetic: marker }), { mode: 0o600, flag: "wx" });
      if (findCapabilityLeaks(await readFile(control, "utf8")).length === 0) throw new Error("fleet persistence scan control was not detectable");
    } finally { await rm(control, { force: true }); }
    for (const target of [homeDirectory, home]) {
      for (const name of ["push-state.json", "fleet-notifications.json", "notification-grants.json"]) {
        const bytes = await readFile(join(target, ".local/state/omp-session-gateway", name), "utf8")
          .catch(error => { if (absent(error)) return ""; throw error; });
        if (findCapabilityLeaks(bytes).length > 0) throw new Error("fleet gateway persistence leak");
      }
      const archive = join(root, target === home ? "source-diagnostics.tar" : "home-diagnostics.tar");
      try {
        await execute(["env", "-u", "XDG_RUNTIME_DIR", `HOME=${target}`, `XDG_CONFIG_HOME=${join(target, ".config")}`,
          `XDG_STATE_HOME=${join(target, ".local/state")}`, state.bun, state.cli, "doctor", "--bundle", "--output", archive]);
        // A representative source has no installed user service; its doctor can fail checks while
        // still exporting the actual support archive. The archive's existence and bytes are required.
        if (findCapabilityLeaks(await readFile(archive, "utf8")).length > 0) throw new Error("fleet diagnostics leak");
      } finally { await rm(archive, { force: true }); }
    }
  }
  if (operation === "restore") {
    const current = await readFile(configPath, "utf8");
    if (current !== state.config && current !== state.changedConfig) throw new Error("coordinator configuration changed outside fleet lane");
    await service(false, state);
    const ledger = await readFile(fleetStatePath, "utf8").catch(error => { if (absent(error)) return undefined; throw error; });
    if (ledger !== undefined) {
      const parsed = JSON.parse(ledger);
      if (state.fleetStateAbsent !== true || parsed.version !== 1 || !Array.isArray(parsed.grants) || parsed.grants.length !== 0 ||
        !Array.isArray(parsed.recipients) || parsed.recipients.length !== 0) throw new Error("fleet grants or recipients remain enrolled");
      await rm(fleetStatePath);
    }
    const processes = await run(["ps", "-ww", "-axo", "command="]);
    if (processes.includes(join(root, "omp-push-remote/fixture.yml"))) throw new Error("fleet OMP fixture remains active");
    await atomic(configPath, state.config);
    const currentServe = await serve();
    if (ownsServe(currentServe)) await run(["tailscale", "serve", `--https=${FLEET_PUSH_HTTPS_PORT}`, "off"]);
    else if (JSON.parse(currentServe).TCP?.[FLEET_PUSH_HTTPS_PORT] !== undefined) throw new Error("fleet Serve ownership changed");
    if (JSON.stringify(JSON.parse(await serve())) !== JSON.stringify(JSON.parse(state.serve))) throw new Error("Serve baseline was not restored");
    await service(true, state);
    if (await readFile(configPath, "utf8") !== state.config) throw new Error("coordinator baseline was not restored");
    await rm(root, { recursive: true });
  }
}

if (import.meta.main) {
  const [operation, root, epoch, origin, commit, ...extra] = process.argv.slice(2);
  try {
    if (!operation || !["prepare", "source-down", "source-up", "coordinator-down", "coordinator-up", "audit", "restore"].includes(operation) ||
      !root || !epoch || !origin || !commit || extra.length) throw new Error("invalid fleet fixture arguments");
    await fleetPushFixture(operation as FleetFixtureOperation, root, epoch, origin, commit);
    console.log(JSON.stringify({ completed: true }));
  } catch (error) {
    console.log(JSON.stringify({ completed: false, diagnostic: fleetFixtureDiagnostic(error) }));
    console.error("Fleet Push fixture operation failed"); process.exitCode = 1;
  }
}
