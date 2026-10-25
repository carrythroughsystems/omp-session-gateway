import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { chmod, cp, lstat, mkdir, open, opendir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type GatewayConfig, ensureRuntimeDirectories } from "./config.ts";
import { serializedPathForms } from "./service.ts";

export const GATEWAY_VERSION = "0.9.0";
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const VERSION_NAME_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?-[0-9a-f]{12}$/u;

/**
 * Retained activations, newest last. Bounds a file that only ever grows by one short name per
 * successful activation, and is far larger than any plausible rollback horizon.
 */
const ACTIVATION_HISTORY_LIMIT = 64;
const ACTIVATION_HISTORY_MAX_BYTES = 4_096;
const SERVICE_DEFINITION_MAX_BYTES = 16_384;
/** Active plus the two most recent distinct predecessors; a divergent service adds protection. */
const RUNTIME_RETENTION_LIMIT = 3;
const RUNTIME_PRUNE_ENTRY_LIMIT = 4_096;
const RUNTIME_PRUNE_DEPTH_LIMIT = 32;
const PRUNE_MARKER_PATTERN = /^\.prune-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface RuntimePruneResult {
  readonly retained: number;
  readonly removed: number;
  readonly failed: number;
}

export interface InstalledRuntime {
  readonly directory: string;
  readonly cliPath: string;
  readonly readinessProtocol: "legacy" | "instance-v1";
}

export interface StagedRuntime extends InstalledRuntime {
  readonly previous: InstalledRuntime | undefined;
}

export interface ActivationState {
  /** Version directory named by `current.json`, or `undefined` when no runtime is activated. */
  readonly pointerVersion: string | undefined;
  /** Version directory the on-disk service definition executes, if it names an installed one. */
  readonly serviceVersion: string | undefined;
  readonly serviceDefinitionPresent: boolean;
  readonly diverged: boolean;
}

export interface RollbackTarget {
  readonly runtime: InstalledRuntime;
  /** Version directory that is active now, which the rollback moves away from. */
  readonly from: string;
  readonly selection: "requested" | "recorded-predecessor";
}

interface RuntimeSourceOptions {
  readonly sourceRoot?: string;
  readonly cliSource?: string;
}

function installationRoot(config: GatewayConfig): string {
  return join(config.paths.stateDir, "installation");
}

function versionsRoot(config: GatewayConfig): string {
  return join(installationRoot(config), "versions");
}

function currentPointerPath(config: GatewayConfig): string {
  return join(installationRoot(config), "current.json");
}

function defaultSourceRoot(): string {
  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

function defaultCliSource(): string {
  return resolve(process.argv[1] ?? fileURLToPath(new URL("./cli.ts", import.meta.url)));
}

async function copyRequiredFile(sourceRoot: string, staging: string, path: string): Promise<void> {
  const source = join(sourceRoot, path);
  const destination = join(staging, path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination);
}

async function copyOptionalFile(sourceRoot: string, staging: string, path: string): Promise<void> {
  try {
    await copyRequiredFile(sourceRoot, staging, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function prepareCli(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (extname(source) === ".ts") {
    const build = await Bun.build({
      entrypoints: [source],
      outdir: dirname(destination),
      naming: basename(destination),
      target: "bun",
      format: "esm",
      minify: true,
      sourcemap: "none",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!build.success) throw new AggregateError(build.logs, "failed to build installed gateway CLI");
  } else {
    await cp(source, destination);
  }
  await chmod(destination, 0o700);
}

async function payloadDigest(directory: string): Promise<string> {
  const paths: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        if (relative(directory, path) !== "installation.json") paths.push(path);
      } else throw new Error(`installed payload contains unsupported entry: ${entry.name}`);
    }
  };
  await visit(directory);
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(relative(directory, path).replaceAll(sep, "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function writeInstallationFile(config: GatewayConfig, name: string, content: string): Promise<void> {
  const root = installationRoot(config);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, join(root, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeCurrentPointer(config: GatewayConfig, versionDirectory: string): Promise<void> {
  await writeInstallationFile(config, "current.json", `${JSON.stringify({ versionDirectory })}\n`);
}

async function validatedRuntime(directory: string): Promise<InstalledRuntime> {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("unsafe installed runtime directory");
  }
  const manifestPath = join(directory, "installation.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 1_024) {
    throw new Error("unsafe installed runtime manifest");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const version = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : undefined;
  const sha256 = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "sha256") : undefined;
  const readinessProtocolValue =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "readinessProtocol") : undefined;
  if (
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version) ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(sha256) ||
    basename(directory) !== `${version}-${sha256.slice(0, 12)}`
  ) {
    throw new Error("invalid installed runtime manifest");
  }
  if (readinessProtocolValue !== undefined && readinessProtocolValue !== "instance-v1") {
    throw new Error("invalid installed runtime readiness protocol");
  }
  const cliPath = join(directory, "apps", "gateway", "src", "cli.js");
  const cliInfo = await lstat(cliPath);
  if (!cliInfo.isFile() || cliInfo.isSymbolicLink()) throw new Error("unsafe installed gateway CLI");
  if ((await payloadDigest(directory)) !== sha256) throw new Error("installed runtime payload failed its content hash");
  return {
    directory,
    cliPath,
    readinessProtocol: readinessProtocolValue === "instance-v1" ? "instance-v1" : "legacy",
  };
}

async function readCurrentPointer(config: GatewayConfig): Promise<string | undefined> {
  let parsed: unknown;
  try {
    const pointer = currentPointerPath(config);
    const info = await lstat(pointer);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_024) throw new Error("unsafe installed runtime pointer");
    parsed = JSON.parse(await readFile(pointer, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const versionDirectory =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "versionDirectory") : undefined;
  if (typeof versionDirectory !== "string" || !VERSION_NAME_PATTERN.test(versionDirectory)) {
    throw new Error("invalid installed runtime pointer");
  }
  return versionDirectory;
}

export async function currentInstalledRuntime(config: GatewayConfig): Promise<InstalledRuntime | undefined> {
  const versionDirectory = await readCurrentPointer(config);
  if (versionDirectory === undefined) return undefined;
  return validatedRuntime(join(versionsRoot(config), versionDirectory));
}

/**
 * Version directories that successfully became active, oldest first.
 *
 * Ordering is recorded rather than inferred. Directory mtime is the tempting alternative and is
 * wrong twice over: re-installing an already-staged payload hits `EEXIST` and reuses the existing
 * directory untouched, so mtime tracks first staging rather than last activation, and it cannot
 * distinguish a version that was staged from one that was ever run.
 */
export async function activationHistory(config: GatewayConfig): Promise<readonly string[]> {
  let parsed: unknown;
  try {
    const path = join(installationRoot(config), "history.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > ACTIVATION_HISTORY_MAX_BYTES) {
      throw new Error("unsafe installed runtime activation history");
    }
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const activations = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "activations") : undefined;
  if (!Array.isArray(activations) || activations.length > ACTIVATION_HISTORY_LIMIT) {
    throw new Error("invalid installed runtime activation history");
  }
  const history: string[] = [];
  for (const entry of activations) {
    if (typeof entry !== "string" || !VERSION_NAME_PATTERN.test(entry)) {
      throw new Error("invalid installed runtime activation history");
    }
    history.push(entry);
  }
  return history;
}

async function installedVersions(config: GatewayConfig): Promise<readonly string[]> {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(versionsRoot(config), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && VERSION_NAME_PATTERN.test(entry.name)) names.push(entry.name);
  }
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return names;
}

export async function stageRuntimePayload(
  config: GatewayConfig,
  options: RuntimeSourceOptions = {},
): Promise<StagedRuntime> {
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot());
  const cliSource = resolve(options.cliSource ?? defaultCliSource());
  const versions = versionsRoot(config);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const staging = join(versions, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await prepareCli(cliSource, join(staging, "apps", "gateway", "src", "cli.js"));
    await cp(join(sourceRoot, "apps", "web", "dist"), join(staging, "apps", "web", "dist"), {
      recursive: true,
    });
    await cp(join(sourceRoot, "licenses"), join(staging, "licenses"), { recursive: true });
    await mkdir(join(staging, "licenses", "collab-web"), { recursive: true, mode: 0o700 });
    await copyOptionalFile(sourceRoot, staging, "licenses/collab-web/LICENSE");
    try {
      await lstat(join(staging, "licenses", "collab-web", "LICENSE"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await copyRequiredFile(sourceRoot, staging, "packages/collab-client/upstream/LICENSE");
      await rename(
        join(staging, "packages", "collab-client", "upstream", "LICENSE"),
        join(staging, "licenses", "collab-web", "LICENSE"),
      );
      await rm(join(staging, "packages"), { recursive: true, force: true });
    }
    for (const path of ["LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "UPSTREAM.lock.json", "bun.lock"]) {
      await copyRequiredFile(sourceRoot, staging, path);
    }
    for (const path of ["package.json", "release-info.json", "SBOM.spdx.json"]) {
      await copyOptionalFile(sourceRoot, staging, path);
    }

    const digest = await payloadDigest(staging);
    const versionDirectory = `${GATEWAY_VERSION}-${digest.slice(0, 12)}`;
    await writeFile(
      join(staging, "installation.json"),
      `${JSON.stringify({ version: GATEWAY_VERSION, sha256: digest, readinessProtocol: "instance-v1" })}\n`,
      { mode: 0o600 },
    );
    const directory = join(versions, versionDirectory);
    try {
      await rename(staging, directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const targetIsDirectory = await lstat(directory).then(
        info => info.isDirectory(),
        () => false,
      );
      if (!targetIsDirectory || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(code ?? "")) throw error;
      await rm(staging, { recursive: true, force: true });
    }
    const installed = await validatedRuntime(directory);
    return { ...installed, previous: await currentInstalledRuntime(config) };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Records a realized activation, after the pointer has committed it.
 *
 * Appending before the pointer write would be fail-before-commit but would let a failed install
 * leave a phantom predecessor: `install` reverts by re-activating the prior runtime, so a version
 * that never ran would sit between two real activations and `rollback` would target it. History
 * therefore describes what ran, never what was attempted. The cost is that a write failure here
 * surfaces as a failed activation whose pointer already moved, which `install` reports and reverts.
 */
async function appendActivation(config: GatewayConfig, versionDirectory: string): Promise<void> {
  let history: readonly string[];
  try {
    history = await activationHistory(config);
  } catch {
    // An unreadable history is advisory metadata, not authority. Restarting it at the version that
    // is now active costs automatic predecessor selection once; refusing would brick every install.
    history = [];
  }
  // Idempotent re-installs are the common case. Without this, a run of identical entries would
  // evict genuine predecessors from the retained window.
  if (history[history.length - 1] === versionDirectory) return;
  const activations = [...history, versionDirectory].slice(-ACTIVATION_HISTORY_LIMIT);
  await writeInstallationFile(config, "history.json", `${JSON.stringify({ activations })}\n`);
}

export async function activateRuntime(config: GatewayConfig, runtime: InstalledRuntime): Promise<void> {
  const versionDirectory = basename(runtime.directory);
  if (!VERSION_NAME_PATTERN.test(versionDirectory) || dirname(runtime.directory) !== versionsRoot(config)) {
    throw new Error("refusing to activate an untrusted runtime path");
  }
  const validated = await validatedRuntime(runtime.directory);
  if (validated.cliPath !== runtime.cliPath) throw new Error("refusing to activate an untrusted gateway CLI path");
  await writeCurrentPointer(config, versionDirectory);
  await appendActivation(config, versionDirectory);
}

async function readServiceDefinition(path: string): Promise<string | undefined> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > SERVICE_DEFINITION_MAX_BYTES) {
    throw new Error("unsafe gateway service definition");
  }
  const bytes = await readFile(path);
  // Windows task XML is UTF-16LE with a BOM; the LaunchAgent plist and systemd unit are UTF-8.
  return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString("utf16le", 2) : bytes.toString("utf8");
}

/**
 * The version directory whose CLI a rendered service definition executes.
 *
 * Matched against this install's own versions root rather than by a generic path shape, so a
 * definition left behind by a different install root reads as "no installed version" instead of
 * being mistaken for one of ours.
 */
function serviceDefinitionVersion(config: GatewayConfig, content: string): string | undefined {
  for (const marker of serializedPathForms(versionsRoot(config) + sep)) {
    const start = content.indexOf(marker);
    if (start < 0) continue;
    const remainder = content.slice(start + marker.length);
    const end = remainder.indexOf(sep);
    if (end < 0) return undefined;
    const name = remainder.slice(0, end);
    return VERSION_NAME_PATTERN.test(name) ? name : undefined;
  }
  return undefined;
}

/**
 * Whether the installed service definition and `current.json` still agree.
 *
 * INVARIANT: `current.json` is the sole authority for which installed runtime the service must
 * execute. The service definition — LaunchAgent plist, systemd user unit, or Windows task XML —
 * is a derived artifact that embeds an absolute path into exactly one version directory. When the
 * two disagree the definition is rewritten from the pointer, never the reverse.
 *
 * `install` and `rollback` write the definition first and advance the pointer only after the new
 * runtime has proven loopback readiness, so nothing becomes authoritative until it has been
 * observed working. The two writes are not atomic, so exactly one divergence direction remains
 * reachable: a crash between them leaves the definition naming a *newer* version than the pointer,
 * and repair conservatively returns the service to the older version that was proven ready. The
 * opposite direction — a pointer naming a version the definition does not — is unreachable through
 * these commands, because none of them writes the pointer before the definition.
 *
 * Detection is read-only on purpose: `status` reports divergence and mutates nothing. Repair
 * happens on the next `install` or `rollback`, each of which rewrites the definition from the
 * runtime the pointer names.
 */
export async function activationState(
  config: GatewayConfig,
  serviceDefinitionPath: string,
): Promise<ActivationState> {
  const [pointerVersion, content] = await Promise.all([
    readCurrentPointer(config),
    readServiceDefinition(serviceDefinitionPath),
  ]);
  const serviceVersion = content === undefined ? undefined : serviceDefinitionVersion(config, content);
  return {
    pointerVersion,
    serviceVersion,
    serviceDefinitionPresent: content !== undefined,
    diverged: content !== undefined && serviceVersion !== pointerVersion,
  };
}

async function recordedPredecessor(
  config: GatewayConfig,
  active: string,
  installed: readonly string[],
): Promise<string> {
  const history = await activationHistory(config);
  const guidance = `pass --to <version-directory>; installed: ${installed.join(", ")}`;
  const index = history.lastIndexOf(active);
  if (index < 0) {
    throw new Error(`refusing to guess a rollback target: no activation of the active version ${active} is recorded; ${guidance}`);
  }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = history[cursor];
    if (candidate === undefined || candidate === active) continue;
    if (!installed.includes(candidate)) {
      throw new Error(`refusing rollback: recorded predecessor ${candidate} is no longer installed; ${guidance}`);
    }
    return candidate;
  }
  throw new Error(`refusing to guess a rollback target: no activation is recorded before ${active}; ${guidance}`);
}

/**
 * The installed runtime a rollback must activate.
 *
 * "Previous" means the activation recorded immediately before the active one, so repeating
 * `rollback` oscillates between two versions the way any previous-revision undo does. Every
 * ambiguity refuses instead of guessing: an install that predates the activation history has no
 * recorded predecessor and must name `--to` explicitly.
 */
export async function resolveRollbackTarget(config: GatewayConfig, requested?: string): Promise<RollbackTarget> {
  const active = await readCurrentPointer(config);
  if (active === undefined) throw new Error("refusing rollback without an active installed runtime");
  const installed = await installedVersions(config);
  if (installed.length < 2) {
    throw new Error(`refusing rollback: ${active} is the only installed version, so no predecessor is retained`);
  }
  let target: string;
  let selection: RollbackTarget["selection"];
  if (requested === undefined) {
    target = await recordedPredecessor(config, active, installed);
    selection = "recorded-predecessor";
  } else {
    if (!VERSION_NAME_PATTERN.test(requested)) {
      throw new Error(`refusing rollback to a malformed version directory: ${requested}`);
    }
    if (requested === active) throw new Error(`refusing rollback to the active version: ${active}`);
    if (!installed.includes(requested)) {
      throw new Error(`refusing rollback to a version that is not installed: ${requested}; installed: ${installed.join(", ")}`);
    }
    target = requested;
    selection = "requested";
  }
  return { runtime: await validatedRuntime(join(versionsRoot(config), target)), from: active, selection };
}

/** Best-effort cleanup; only a ready, committed install calls this, never rollback or its repair. */
export async function pruneSupersededRuntimes(
  config: GatewayConfig,
  serviceDefinitionPath: string,
): Promise<RuntimePruneResult> {
  const result = { retained: 0, removed: 0, failed: 0 };
  try {
    // Reuse the state-root privacy check (including Windows ACLs). Descendants are created inside
    // that private root; reject redirected roots rather than following them during recursive rm.
    await ensureRuntimeDirectories(config);
    const root = versionsRoot(config);
    for (const path of [installationRoot(config), root]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
        throw new Error("unsafe runtime pruning root");
      }
    }
    const state = await activationState(config, serviceDefinitionPath);
    const history = await activationHistory(config);
    const active = state.pointerVersion;
    // An unrecognized/escaped definition must defer cleanup, not guess which runtime it uses.
    if (active === undefined || history.at(-1) !== active || state.serviceVersion === undefined) {
      throw new Error("runtime activation has not committed");
    }
    const retained = new Set([active]);
    // Walking distinct entries, not the last three rows, preserves A/B/A rollback oscillations.
    // The first distinct entry before active is exactly recordedPredecessor's selection.
    for (let index = history.length - 2; index >= 0 && retained.size < RUNTIME_RETENTION_LIMIT; index -= 1) {
      const version = history[index];
      if (version !== undefined) retained.add(version);
    }
    retained.add(state.serviceVersion);

    // Root enumeration and victim inspection have separate budgets, so an interrupted marker that
    // fits the traversal bound is always finished, however many siblings the root gains.
    let rootEntriesLeft = RUNTIME_PRUNE_ENTRY_LIMIT;
    let treeEntriesLeft = RUNTIME_PRUNE_ENTRY_LIMIT;
    const victims: string[] = [];
    for await (const entry of await opendir(root)) {
      if (rootEntriesLeft-- <= 0) throw new Error("runtime pruning entry limit reached");
      if (!entry.isDirectory()) continue;
      if (VERSION_NAME_PATTERN.test(entry.name)) {
        if (retained.has(entry.name)) result.retained += 1;
        else victims.push(entry.name);
      } else if (PRUNE_MARKER_PATTERN.test(entry.name)) victims.push(entry.name);
    }
    // Refuse links/special files anywhere in a victim, and bound traversal before recursive rm.
    // The private root excludes other users; concurrent same-user filesystem mutation is outside
    // the gateway threat model, just as it is for staging and activation.
    const inspectTree = async (path: string, depth: number): Promise<void> => {
      if (depth > RUNTIME_PRUNE_DEPTH_LIMIT) throw new Error("runtime pruning depth limit reached");
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe runtime pruning directory");
      for await (const entry of await opendir(path)) {
        if (treeEntriesLeft-- <= 0) throw new Error("runtime pruning entry limit reached");
        if (entry.isDirectory()) await inspectTree(join(path, entry.name), depth + 1);
        else if (!entry.isFile()) throw new Error("unsafe runtime pruning entry");
      }
    };
    // Finish interrupted removals first so repeated bounded passes do not accumulate markers.
    victims.sort((left, right) => Number(PRUNE_MARKER_PATTERN.test(right)) - Number(PRUNE_MARKER_PATTERN.test(left)));
    for (const name of victims) {
      try {
        const path = join(root, name);
        await inspectTree(path, 0);
        const marker = PRUNE_MARKER_PATTERN.test(name) ? path : join(root, `.prune-${randomUUID()}`);
        if (marker !== path) await rename(path, marker);
        await rm(marker, { recursive: true });
        result.removed += 1;
      } catch {
        result.failed += 1;
        if (treeEntriesLeft <= 0) break;
      }
    }
  } catch {
    result.failed += 1;
  }
  return result;
}
