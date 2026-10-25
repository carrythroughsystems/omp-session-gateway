import { chmod, link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  LOCAL_FLEET_SOURCE_ID,
  MAX_FLEET_SOURCES,
  MAX_FLEET_TARGETS,
  ProtocolValidationError,
  parseFleetLabel,
  parseFleetOrigin,
  parseFleetSourceId,
  type FleetSource,
} from "@omp-session-gateway/protocol";
import { resolveOmpDiscoveryDirectory } from "./omp-registry.ts";

export type AuthMode = "tailscale-serve" | "dev-localhost";
export const FLEET_CONFIG_SINCE_VERSION = "0.8.0";

export interface TernProfile {
  readonly id: string;
  readonly label: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export interface TernWorkingCopy {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}
export interface TernConfig {
  readonly executable?: string;
  readonly projects?: readonly { readonly id: string; readonly label: string; readonly workingCopies: readonly TernWorkingCopy[] }[];
  readonly profiles?: readonly TernProfile[];
}

export interface GatewayConfig {
  readonly tern?: TernConfig;
  readonly http: {
    readonly hostname: "127.0.0.1" | "::1";
    readonly port: number;
    readonly publicOrigin: string;
    readonly trustedDashboardOrigins: readonly string[];
  };
  readonly fleet: {
    readonly label: string;
    readonly targets: readonly FleetSource[];
  };
  readonly speech: {
    readonly browserRecognition: boolean;
  };
  readonly auth: {
    readonly mode: AuthMode;
    readonly allowedLogins: readonly string[];
    /**
     * Declares that no tailnet can reach this host, so an identity header from a loopback peer must
     * have come from Serve. Absent means the gateway measures the host instead and refuses to
     * believe the header when no interface owns a tailnet address.
     *
     * This exists for loopback-only harnesses that exercise the production identity path on machines
     * with no Tailscale installed. Setting it on a host running `tailscaled
     * --tun=userspace-networking` asserts something false and restores the remote authentication
     * bypass in #98, so `doctor` reports it as a finding.
     */
    readonly trustIdentityWithoutTailnetDevice?: boolean;
  };
  readonly registry: {
    /** Seconds between discovery polls of OMP's collaboration host directory. */
    readonly heartbeatSeconds: number;
    /** Seconds a published host may stay unreadable before its card is dropped. */
    readonly ttlSeconds: number;
    /** Admitted discovery hosts; the gateway observes hosts rather than accepting connections. */
    readonly maxSessions: number;
  };
  readonly omp: {
    /** OMP's own collaboration host directory; the gateway only ever reads it. */
    readonly discoveryDir: string;
    /** Per-host query budget for one `snapshot` or `link` round trip. */
    readonly queryTimeoutMs: number;
  };
  readonly paths: {
    readonly configDir: string;
    readonly stateDir: string;
    readonly runtimeDir: string;
    readonly tokenPath: string;
    readonly configPath: string;
  };
}

export function loopbackHttpOrigin(hostname: GatewayConfig["http"]["hostname"], port: number): string {
  const host = hostname === "::1" ? "[::1]" : hostname;
  return `http://${host}:${port}`;
}

export interface ConfigOverrides {
  readonly mode?: AuthMode;
  readonly configPath?: string;
  readonly publicOrigin?: string;
  readonly port?: number;
}

const MIN_HEARTBEAT_SECONDS = 2;
const MAX_HEARTBEAT_SECONDS = 60;
const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 300;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function currentUserId(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("current user ID is unavailable");
  return uid;
}

/**
 * Environment for the ACL helper. `PSModulePath` is dropped so a writable module directory inherited
 * from the caller cannot inject code into the helper; every other variable is inherited because
 * `powershell.exe` needs `SystemRoot` and friends to start at all.
 */
function windowsPowerShellEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== "psmodulepath") environment[key] = value;
  }
  return environment;
}

/**
 * Newline-delimited JSON request loop: `apply` writes a path's owner and protected DACL, and
 * `inspect` reads them back through `Get-Acl`.
 *
 * Starting `powershell.exe` measured 1.8-2.1 s on a 2-vCPU Windows Server 2025 host, and the daemon
 * secures or verifies five private paths before it can bind its loopback listener, so one process per
 * path consumed more than the whole `install` readiness budget and every install was torn back down
 * (#90). One process answers every request of a run instead.
 *
 * `apply` builds a fresh `DirectorySecurity` or `FileSecurity` holding only the owner and the DACL,
 * and .NET's `SetAccessControl` persists only the sections a security object has changed, so no
 * apply ever writes the SACL. It used to round-trip the path through `Get-Acl`/`Set-Acl`, and
 * `Set-Acl` first tries to write the SACL as well. Without `SeSecurityPrivilege`, which a standard
 * user's token does not hold, it retries without the SACL only when the new descriptor's
 * audit-protection flag equals the target's DACL-protection flag. Once a path's DACL was protected
 * those never matched, so every command after the first failed for a non-elevated user (#293).
 *
 * Paths arrive as JSON data and are never spliced into the script, so a hostile path cannot become
 * code. Each reply carries its request id back, so a failure can only be attributed to the path that
 * produced it. Reply text is squeezed to printable ASCII because a redirected PowerShell writes
 * stdout in the console code page, which would otherwise corrupt the framing.
 */
const WINDOWS_ACL_HELPER_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$out=[Console]::Out",
  "while($true){ $line=[Console]::In.ReadLine(); if($null -eq $line){break}; if($line.Length -eq 0){continue}; " +
    "$id=0; try{ $request=$line|ConvertFrom-Json; $id=[int]$request.i; $path=[string]$request.p; " +
    "if($request.dir -eq 1){$flags='OICI'}else{$flags=''}; " +
    "if($request.op -eq 'apply'){ " +
    "$sddl='D:P(A;'+$flags+';FA;;;SY)(A;'+$flags+';FA;;;'+$sid+')'; " +
    "if($request.dir -eq 1){$security=[System.Security.AccessControl.DirectorySecurity]::new()}" +
    "else{$security=[System.Security.AccessControl.FileSecurity]::new()}; " +
    "$security.SetSecurityDescriptorSddlForm($sddl,[System.Security.AccessControl.AccessControlSections]::Access); " +
    "$security.SetOwner([System.Security.Principal.SecurityIdentifier]::new($sid)); " +
    "if($request.dir -eq 1){[System.IO.Directory]::SetAccessControl($path,$security)}" +
    "else{[System.IO.File]::SetAccessControl($path,$security)}; $reply=[pscustomobject]@{i=$id;ok=$true} " +
    "}elseif($request.op -eq 'inspect'){ " +
    "$acl=Get-Acl -LiteralPath $path; $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; " +
    "$descriptor=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl); " +
    "$rules=@($descriptor.DiscretionaryAcl | ForEach-Object { [pscustomobject]@{ " +
    "Sid=$_.SecurityIdentifier.Value; Type=$_.AceType.ToString(); Mask=$_.AccessMask; Flags=[int]$_.AceFlags } }); " +
    "$reply=[pscustomobject]@{i=$id;ok=$true;acl=[pscustomobject]@{ " +
    "Protected=$acl.AreAccessRulesProtected; Current=$sid; Owner=$owner; Rules=@($rules) }} " +
    "}else{ throw 'unsupported private ACL operation' } " +
    "}catch{ $reply=[pscustomobject]@{i=$id;ok=$false;e=([string]$_.Exception.Message -replace '[^\\x20-\\x7E]','?')} }; " +
    "$out.WriteLine(($reply|ConvertTo-Json -Compress -Depth 6)); $out.Flush() }",
].join("; ");

interface WindowsAclHelper {
  readonly send: (line: string) => Promise<void>;
  readonly receive: () => Promise<Uint8Array | undefined>;
  readonly kill: () => void;
  /** Hold the event loop open while a reply is outstanding. */
  readonly hold: () => void;
  /** Release it again once the round trip has settled. */
  readonly release: () => void;
  readonly drainStderr: () => Promise<string>;
  readonly decoder: TextDecoder;
  buffer: string;
  nextRequestId: number;
  /** Whether this process has answered once, which proves PowerShell's start-up is behind it. */
  answered: boolean;
}

let windowsAclHelper: WindowsAclHelper | undefined;
let windowsAclRequestTail: Promise<unknown> = Promise.resolve();

/**
 * JSON restricted to printable ASCII, so the helper's stdin code page cannot mangle a path. Matching
 * per UTF-16 code unit is deliberate: each surrogate half becomes its own escape, which
 * `ConvertFrom-Json` recombines into the original code point.
 */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7E]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// A helper that accepts a request and never answers would otherwise block this check forever. During
// `install` the readiness budget bounds that, but a directly-run `serve` has no such bound, so the
// wait is capped here and reported as a timeout rather than as a hang with no diagnostic.
//
// A fresh helper's first reply includes PowerShell's own cold start, which a warm helper never pays
// again. At the first logon after install on the 2-vCPU Server 2025 qualification host, that start
// outlasted a 10 s deadline twice in a row: each replacement began just as cold, both were killed,
// and the logon-started gateway never listened. Hosted CI has recorded cold spawns over 30 s. So a
// helper's first reply may take 45 s, which still fits the 60 s Windows install readiness budget,
// and every later reply keeps the 10 s cap that bounds a helper wedged mid-request.
const WINDOWS_ACL_FIRST_REPLY_TIMEOUT_MS = 45_000;
const WINDOWS_ACL_REPLY_TIMEOUT_MS = 10_000;
const WINDOWS_ACL_ATTEMPTS = 2;

function startWindowsAclHelper(): WindowsAclHelper {
  const subprocess = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_HELPER_SCRIPT],
    { env: windowsPowerShellEnvironment(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  // Idle, the helper must not hold the daemon's event loop open: it ends by itself, because closing
  // our stdin at exit makes its `ReadLine` return null and the loop break. But `unref` alone is
  // wrong while a reply is outstanding. The pending `stdout.read()` below belongs to this child, so
  // an unref'd helper leaves the loop with nothing to keep the process alive and it exits mid-await
  // with status 0 — observed as a `install` that returned in half a second having done nothing.
  // Hold the reference for exactly the duration of a round trip instead.
  subprocess.unref();
  const stdout = subprocess.stdout.getReader();
  const stderr = subprocess.stderr as ReadableStream<Uint8Array>;
  return {
    send: async line => {
      subprocess.stdin.write(line);
      await subprocess.stdin.flush();
    },
    receive: async () => (await stdout.read()).value,
    kill: () => subprocess.kill(),
    hold: () => subprocess.ref(),
    release: () => subprocess.unref(),
    // Read only after the helper has been killed, never as a standing background task. An
    // open-ended read of this pipe is not free: a pending read keeps the process alive even though
    // the child is unref'd, which hung `bun test` on Windows for 23 minutes until CI cancelled it.
    // Killing first makes the pipe EOF, so this returns promptly; the race is a backstop only.
    // Its timer stays referenced: the helper is killed and released by now, so nothing else may hold
    // the event loop, and without it `serve` exited 0 mid-drain before starting the next helper. At
    // Windows logon the first helper missed its reply deadline and the gateway never listened.
    drainStderr: async () => {
      const collected = await Promise.race([
        new Response(stderr).text().catch(() => ""),
        new Promise<string>(resolve => setTimeout(() => resolve(""), 250)),
      ]);
      return collected.trim().slice(0, 500);
    },
    decoder: new TextDecoder(),
    buffer: "",
    nextRequestId: 1,
    answered: false,
  };
}

/**
 * Drop the cached helper process. Production calls this when a reply proves the protocol has
 * desynchronised; tests call it to guarantee the next ACL request spawns fresh, which is the only
 * way to evict a real `powershell.exe` on Windows where one is genuinely running.
 */
export function stopWindowsAclHelper(): void {
  const helper = windowsAclHelper;
  windowsAclHelper = undefined;
  if (helper === undefined) return;
  try {
    helper.kill();
  } catch {
    // Already gone; there is nothing left to reclaim.
  }
}

async function readWindowsAclReply(helper: WindowsAclHelper): Promise<string> {
  const deadline = Date.now() + (helper.answered ? WINDOWS_ACL_REPLY_TIMEOUT_MS : WINDOWS_ACL_FIRST_REPLY_TIMEOUT_MS);
  for (;;) {
    const newline = helper.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = helper.buffer.slice(0, newline).trim();
      helper.buffer = helper.buffer.slice(newline + 1);
      if (line.length > 0) return line;
      continue;
    }
    const remaining = deadline - Date.now();
    // The caller attaches the helper's stderr; these messages stay plain so there is one place that
    // decides how a failure is reported.
    if (remaining <= 0) throw new Error("the private Windows ACL helper did not reply in time");
    const chunk = await Promise.race([
      helper.receive(),
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), remaining).unref?.()),
    ]);
    if (chunk === "timeout") throw new Error("the private Windows ACL helper did not reply in time");
    if (chunk === undefined) throw new Error("the private Windows ACL helper exited before replying");
    helper.buffer += helper.decoder.decode(chunk, { stream: true });
  }
}

/**
 * One exchange against the cached helper, starting it when there is none. Never retries: the caller
 * decides that, because a desynchronised reply must stay fatal.
 */
async function exchangeWindowsAcl(
  operation: "apply" | "inspect",
  path: string,
  directory: boolean,
): Promise<{ readonly reply: unknown; readonly requestId: number }> {
  let active: WindowsAclHelper | undefined;
  let requestId = 0;
  try {
    const helper = (windowsAclHelper ??= startWindowsAclHelper());
    active = helper;
    requestId = helper.nextRequestId;
    helper.nextRequestId += 1;
    helper.hold();
    try {
      await helper.send(`${asciiJson({ i: requestId, op: operation, p: path, dir: directory ? 1 : 0 })}\n`);
      const reply: unknown = JSON.parse(await readWindowsAclReply(helper));
      helper.answered = true;
      return { reply, requestId };
    } finally {
      helper.release();
    }
  } catch (error) {
    // Kill first so the helper's stderr pipe reaches EOF, then read it. Reading before the kill
    // would block on a live pipe, and reading it continuously in the background keeps the process
    // alive even with the child unref'd.
    stopWindowsAclHelper();
    const captured = active === undefined ? "" : await active.drainStderr();
    const reason = error instanceof Error ? error.message : String(error);
    const suffix = captured.length > 0 && !reason.includes(captured) ? `: ${captured}` : "";
    throw new Error(`the private Windows ACL helper failed for ${path}: ${reason}${suffix}`, { cause: error });
  }
}

async function performWindowsAclRequest(
  operation: "apply" | "inspect",
  path: string,
  directory: boolean,
): Promise<unknown> {
  // The helper is a cache, and a cached process can be gone or wedged by the time the next request
  // needs it. A Windows runner showed the cost of treating that as fatal: one `powershell.exe`
  // never answered its first request, the whole check failed, and the very next request — served by
  // a freshly started helper — succeeded in under three seconds. A failed exchange therefore earns
  // one fresh helper rather than failing the caller. `exchangeWindowsAcl` has already discarded the
  // dead one, so the retry starts a new process.
  //
  // The retry fits inside the previous single-attempt bound rather than doubling it: the reply wait
  // is half what it was, so two attempts cost what one used to.
  let reply: unknown;
  let requestId = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      ({ reply, requestId } = await exchangeWindowsAcl(operation, path, directory));
      break;
    } catch (error) {
      if (attempt >= WINDOWS_ACL_ATTEMPTS) throw error;
    }
  }
  const envelope = typeof reply === "object" && reply !== null ? reply : undefined;
  if (envelope === undefined || Reflect.get(envelope, "i") !== requestId) {
    // Answering the wrong request would clear the wrong path, so a desynchronised helper is fatal.
    stopWindowsAclHelper();
    throw new Error(`the private Windows ACL helper answered out of order for ${path}`);
  }
  if (Reflect.get(envelope, "ok") !== true) {
    const failure = Reflect.get(envelope, "e");
    const detail = typeof failure === "string" && failure.length > 0 ? failure : "unknown helper failure";
    throw new Error(
      operation === "apply"
        ? `failed to secure private Windows path ${path}: ${detail}`
        : `failed to inspect private Windows ACL for ${path}: ${detail}`,
    );
  }
  return Reflect.get(envelope, "acl");
}

/**
 * Requests are strictly serialised: the helper answers one line per line it reads, so overlapping
 * writers would race for each other's replies.
 */
function windowsAclRequest(operation: "apply" | "inspect", path: string, directory: boolean): Promise<unknown> {
  const attempt = windowsAclRequestTail
    .catch(() => undefined)
    .then(() => performWindowsAclRequest(operation, path, directory));
  windowsAclRequestTail = attempt.catch(() => undefined);
  return attempt;
}

async function applyWindowsAcl(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  await windowsAclRequest("apply", path, directory);
}

async function assertWindowsAclPrivate(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  const value = await windowsAclRequest("inspect", path, directory);
  const protectedAcl = typeof value === "object" && value !== null ? Reflect.get(value, "Protected") : undefined;
  const current = typeof value === "object" && value !== null ? Reflect.get(value, "Current") : undefined;
  const owner = typeof value === "object" && value !== null ? Reflect.get(value, "Owner") : undefined;
  const rules = typeof value === "object" && value !== null ? Reflect.get(value, "Rules") : undefined;
  const allowedSids = new Set([current, "S-1-5-18"]);
  const seenSids = new Set<string>();
  const expectedFlags = directory ? 3 : 0;
  const rulesValid =
    Array.isArray(rules) &&
    rules.length >= allowedSids.size &&
    rules.length <= 2 &&
    rules.every(rule => {
      if (typeof rule !== "object" || rule === null) return false;
      const sid = Reflect.get(rule, "Sid");
      if (typeof sid !== "string" || !allowedSids.has(sid)) return false;
      seenSids.add(sid);
      return (
        Reflect.get(rule, "Type") === "AccessAllowed" &&
        Reflect.get(rule, "Mask") === 2_032_127 &&
        Reflect.get(rule, "Flags") === expectedFlags
      );
    }) &&
    seenSids.size === allowedSids.size;
  if (protectedAcl !== true || typeof current !== "string" || owner !== current || !rulesValid) {
    const ruleDiagnostics = Array.isArray(rules)
      ? rules.map(rule => {
          const sid = typeof rule === "object" && rule !== null ? Reflect.get(rule, "Sid") : undefined;
          return {
            sid: sid === current ? "current" : sid === "S-1-5-18" ? "system" : "other",
            type: typeof rule === "object" && rule !== null ? Reflect.get(rule, "Type") : undefined,
            mask: typeof rule === "object" && rule !== null ? Reflect.get(rule, "Mask") : undefined,
            flags: typeof rule === "object" && rule !== null ? Reflect.get(rule, "Flags") : undefined,
          };
        })
      : "not-array";
    throw new Error(
      `unsafe private Windows ACL for ${path} (protected=${String(protectedAcl)}, ownerMatches=${String(owner === current)}, currentIsSystem=${String(current === "S-1-5-18")}, rules=${JSON.stringify(ruleDiagnostics)})`,
    );
  }
}

function privateRuntimeDir(): string {
  if (process.platform === "linux" && process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, "omp-session-gateway");
  }
  if (process.platform === "darwin") {
    return join(process.env.TMPDIR ?? tmpdir(), `omp-session-gateway-${process.getuid?.() ?? "user"}`);
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "omp-session-gateway", "run");
}

export function defaultGatewayPaths(): GatewayConfig["paths"] {
  const windowsBase = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const configDir =
    process.platform === "win32"
      ? join(windowsBase, "OMP Session Gateway")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "omp-session-gateway");
  const stateDir =
    process.platform === "win32"
      ? join(windowsBase, "OMP Session Gateway", "state")
      : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "omp-session-gateway");
  const runtimeDir = process.platform === "win32" ? stateDir : privateRuntimeDir();
  return {
    configDir,
    stateDir,
    runtimeDir,
    // Proves loopback readiness to the CLI. Nothing publishes to the gateway any more, so this is
    // the gateway's own health secret rather than a credential handed to another process.
    tokenPath: join(configDir, "readiness-token"),
    configPath: join(configDir, "config.json"),
  };
}

async function assertPrivateDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe private directory: ${path}`);
  if (process.platform === "win32") {
    if (create) await applyWindowsAcl(path, true);
    await assertWindowsAclPrivate(path, true);
    return;
  }
  if (info.uid !== currentUserId() || (info.mode & 0o077) !== 0) {
    throw new Error(`unsafe private directory: ${path}`);
  }
}

async function assertPrivateRegularFile(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe private file: ${path}`);
  if (process.platform === "win32") {
    await assertWindowsAclPrivate(path, false);
    return info.size;
  }
  if (info.uid !== currentUserId() || (info.mode & 0o077) !== 0) {
    throw new Error(`unsafe private file permissions: ${path}`);
  }
  return info.size;
}

function validatePort(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error("http.port must be an integer from 1 to 65535");
  }
  return value as number;
}

function validateBoundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function normalizeLogin(value: string): string {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || /[\0\r\n,]/u.test(normalized) || normalized.includes("*")) {
    throw new Error("invalid Tailscale login allowlist entry");
  }
  return normalized;
}

/** An override must be an absolute path; a relative one would resolve against the daemon's cwd. */
function requireDiscoveryDir(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new Error("omp.discoveryDir must be an absolute path");
  }
  return value;
}

function configSection(record: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = record[name] === undefined ? {} : record[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("config sections must be objects");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) throw new Error(`${name}.${key} must not be null`);
  }
  return value as Record<string, unknown>;
}

function fleetValue<T>(value: unknown, parse: (value: unknown) => T, message: string): T {
  try {
    return parse(value);
  } catch (error) {
    if (!(error instanceof ProtocolValidationError)) throw error;
    throw new Error(message);
  }
}

function fleetOrigin(value: unknown, mode: AuthMode, label: string): string {
  const message = `${label} must be a canonical ${mode === "tailscale-serve" ? "https origin" : "https or loopback http origin"}`;
  const origin = fleetValue(value, parseFleetOrigin, message);
  if (mode === "tailscale-serve" && !origin.startsWith("https:")) throw new Error(message);
  return origin;
}

function defaultFleetLabel(publicOrigin: string): string {
  const host = new URL(publicOrigin).hostname;
  return host === "127.0.0.1" || host === "[::1]" ? host : (host.split(".")[0] ?? host);
}

function trustedDashboardOrigins(value: unknown, mode: AuthMode, publicOrigin: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_FLEET_SOURCES) {
    throw new Error(`http.trustedDashboardOrigins must be an array of at most ${MAX_FLEET_SOURCES} origins`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const label = `http.trustedDashboardOrigins[${index}]`;
    const origin = fleetOrigin(entry, mode, label);
    if (origin === publicOrigin) throw new Error(`${label} must not equal http.publicOrigin`);
    if (seen.has(origin)) throw new Error(`${label} duplicates another trusted dashboard origin`);
    seen.add(origin);
    return origin;
  });
}

function fleetTargets(value: unknown, mode: AuthMode, publicOrigin: string): readonly FleetSource[] {
  if (!Array.isArray(value) || value.length > MAX_FLEET_TARGETS) {
    throw new Error(`fleet.targets must be an array of at most ${MAX_FLEET_TARGETS} sources`);
  }
  const ids = new Set<string>([LOCAL_FLEET_SOURCE_ID]);
  const origins = new Set([publicOrigin]);
  return value.map((entry: unknown, index) => {
    const label = `fleet.targets[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }
    const target = entry as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      if (!["id", "label", "origin"].includes(key)) throw new Error(`unknown ${label} config key: ${key}`);
    }
    const id = fleetValue(target.id, parseFleetSourceId, `${label}.id must match ^[a-z][a-z0-9-]{0,31}$`);
    if (ids.has(id)) throw new Error(`${label}.id must be unique and must not be local`);
    const displayLabel = fleetValue(target.label, parseFleetLabel, `${label}.label must contain 1 to 64 display characters`);
    const origin = fleetOrigin(target.origin, mode, `${label}.origin`);
    if (origins.has(origin)) throw new Error(`${label}.origin must be unique and must not equal http.publicOrigin`);
    ids.add(id);
    origins.add(origin);
    return { id, label: displayLabel, origin };
  });
}

/** Remove only the authored keys older runtimes cannot parse; never mutate the parsed document. */
export function projectPreFleetConfig(document: unknown): {
  readonly document: Record<string, unknown>;
  readonly removedKeys: readonly string[];
} {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("config must be an object");
  }
  const record = document as Record<string, unknown>;
  const projected = { ...record };
  const removedKeys: string[] = [];
  if (record.http !== undefined) {
    const http = configSection(record, "http");
    if (Object.hasOwn(http, "trustedDashboardOrigins")) {
      const { trustedDashboardOrigins: _trustedOrigins, ...legacyHttp } = http;
      projected.http = legacyHttp;
      removedKeys.push("http.trustedDashboardOrigins");
    }
  }
  for (const key of ["fleet", "speech"]) {
    if (Object.hasOwn(record, key)) {
      delete projected[key];
      removedKeys.push(key);
    }
  }
  return { document: projected, removedKeys };
}

/** Empty authored sections are preserved but unavailable; partial execution recipes are refused. */
export function parseTernConfig(value: unknown): TernConfig {
  const invalid = (): never => { throw new Error("invalid tern configuration"); };
  const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
    const result = value as Record<string, unknown>;
    if (Object.keys(result).some(key => !keys.includes(key))) return invalid();
    return result;
  };
  const text = (value: unknown, maximum: number, absolute = false): string => {
    if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > maximum ||
        (absolute && !isAbsolute(value))) return invalid();
    return value;
  };
  const list = <T extends { readonly id: string }>(value: unknown, maximum: number, parse: (entry: unknown) => T): T[] => {
    if (!Array.isArray(value) || value.length < 1 || value.length > maximum) return invalid();
    const entries = value.map(parse);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) return invalid();
    return entries;
  };
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) return invalid();
    const record = object(value, ["executable", "projects", "profiles"]);
    if (Object.keys(record).length === 0) return {};
    const executable = text(record.executable, 4096, true);
    const projects = list(record.projects, 16, value => {
      const project = object(value, ["id", "label", "workingCopies"]);
      return { id: parseFleetSourceId(project.id), label: parseFleetLabel(project.label),
        workingCopies: list(project.workingCopies, 8, value => {
          const copy = object(value, ["id", "label", "path"]);
          return { id: parseFleetSourceId(copy.id), label: parseFleetLabel(copy.label), path: text(copy.path, 4096, true) };
        }) };
    });
    const profiles = list(record.profiles, 8, value => {
      const profile = object(value, ["id", "label", "argv", "env"]);
      if (!Array.isArray(profile.argv) || profile.argv.length < 1 || profile.argv.length > 32) return invalid();
      const argv = profile.argv.map((arg, index) => text(arg, index === 0 ? 4096 : 1024, index === 0));
      if (Buffer.byteLength(JSON.stringify(argv)) > 8192) return invalid();
      if (typeof profile.env !== "object" || profile.env === null || Array.isArray(profile.env)) return invalid();
      const entries = Object.entries(profile.env);
      if (entries.length > 16 || Buffer.byteLength(JSON.stringify(profile.env)) > 8192) return invalid();
      const env: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [key, value] of entries) {
        if (!/^[A-Z_][A-Z0-9_]{0,63}$/u.test(key)) return invalid();
        env[key] = text(value, 1024);
      }
      text(env.HOME, 1024, true);
      if (typeof env.PATH !== "string" || env.PATH.split(process.platform === "win32" ? ";" : ":")
        .some(part => part.length === 0 || !isAbsolute(part))) return invalid();
      return { id: parseFleetSourceId(profile.id), label: parseFleetLabel(profile.label), argv, env };
    });
    return { executable, projects, profiles };
  } catch {
    return invalid();
  }
}

export function projectPreTernConfig(document: unknown): {
  readonly document: Record<string, unknown>; readonly removedKeys: readonly string[];
} {
  if (typeof document !== "object" || document === null || Array.isArray(document)) throw new Error("config must be an object");
  const projected = { ...document } as Record<string, unknown>;
  const removedKeys = Object.hasOwn(projected, "tern") ? ["tern"] : [];
  delete projected.tern;
  return { document: projected, removedKeys };
}

function parseConfigObject(raw: unknown, defaults: GatewayConfig): GatewayConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("config must be an object");
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["http", "auth", "registry", "omp", "fleet", "speech", "tern"].includes(key)) throw new Error(`unknown config key: ${key}`);
  }
  const http = configSection(record, "http");
  const auth = configSection(record, "auth");
  const registry = configSection(record, "registry");
  const omp = configSection(record, "omp");
  const fleet = configSection(record, "fleet");
  const speech = configSection(record, "speech");
  for (const key of Object.keys(http)) {
    if (!["hostname", "port", "publicOrigin", "trustedDashboardOrigins"].includes(key)) {
      throw new Error(`unknown http config key: ${key}`);
    }
  }
  for (const key of Object.keys(auth)) {
    if (!["mode", "allowedLogins", "trustIdentityWithoutTailnetDevice"].includes(key)) {
      throw new Error(`unknown auth config key: ${key}`);
    }
  }
  for (const key of Object.keys(registry)) {
    // `maxPublishers` bounded inbound publisher connections, which no longer exist. A fork-era
    // config file still carries it, and installing over one must not fail on a key whose value is
    // now meaningless, so it is accepted, ignored, and dropped the next time the file is written.
    if (!["heartbeatSeconds", "ttlSeconds", "maxPublishers", "maxSessions"].includes(key)) {
      throw new Error(`unknown registry config key: ${key}`);
    }
  }
  for (const key of Object.keys(omp)) {
    if (!["discoveryDir", "queryTimeoutMs"].includes(key)) throw new Error(`unknown omp config key: ${key}`);
  }
  for (const key of Object.keys(fleet)) {
    if (!["label", "targets"].includes(key)) throw new Error(`unknown fleet config key: ${key}`);
  }
  for (const key of Object.keys(speech)) {
    if (key !== "browserRecognition") throw new Error(`unknown speech config key: ${key}`);
  }
  const hostname = http.hostname ?? defaults.http.hostname;
  if (hostname !== "127.0.0.1" && hostname !== "::1") throw new Error("http.hostname must be loopback");
  const port = validatePort(http.port ?? defaults.http.port);
  const publicOriginValue = http.publicOrigin ?? defaults.http.publicOrigin;
  if (typeof publicOriginValue !== "string") throw new Error("http.publicOrigin must be a URL origin");
  const publicOrigin = new URL(publicOriginValue);
  if (publicOrigin.origin !== publicOriginValue || !["http:", "https:"].includes(publicOrigin.protocol)) {
    throw new Error("http.publicOrigin must be an exact HTTP(S) origin");
  }
  const mode = auth.mode ?? defaults.auth.mode;
  if (mode !== "tailscale-serve" && mode !== "dev-localhost") throw new Error("invalid auth.mode");
  if (mode === "tailscale-serve" && publicOrigin.protocol !== "https:") {
    throw new Error("tailscale-serve mode requires an exact HTTPS public origin");
  }
  if (mode === "dev-localhost" && publicOrigin.origin !== loopbackHttpOrigin(hostname, port)) {
    throw new Error("dev-localhost mode requires the configured loopback HTTP origin");
  }
  const allowedRaw = auth.allowedLogins ?? defaults.auth.allowedLogins;
  if (!Array.isArray(allowedRaw) || allowedRaw.some(value => typeof value !== "string")) {
    throw new Error("auth.allowedLogins must be an array of login strings");
  }
  const allowedLogins = [...new Set((allowedRaw as string[]).map(normalizeLogin))];
  if (mode === "tailscale-serve" && allowedLogins.length === 0) {
    throw new Error("tailscale-serve mode requires at least one allowed login");
  }
  const declaredTrust = auth.trustIdentityWithoutTailnetDevice ?? false;
  if (typeof declaredTrust !== "boolean") {
    throw new Error("auth.trustIdentityWithoutTailnetDevice must be a boolean");
  }
  const heartbeatSeconds = validateBoundedInteger(
    registry.heartbeatSeconds ?? defaults.registry.heartbeatSeconds,
    MIN_HEARTBEAT_SECONDS,
    MAX_HEARTBEAT_SECONDS,
    "registry.heartbeatSeconds",
  );
  const ttlSeconds = validateBoundedInteger(
    registry.ttlSeconds ?? defaults.registry.ttlSeconds,
    MIN_TTL_SECONDS,
    MAX_TTL_SECONDS,
    "registry.ttlSeconds",
  );
  if (ttlSeconds <= heartbeatSeconds * 2) throw new Error("registry.ttlSeconds must exceed two heartbeat intervals");
  const browserRecognition = speech.browserRecognition ?? false;
  if (typeof browserRecognition !== "boolean") throw new Error("speech.browserRecognition must be a boolean");
  return {
    http: {
      hostname,
      port,
      publicOrigin: publicOrigin.origin,
      trustedDashboardOrigins: trustedDashboardOrigins(http.trustedDashboardOrigins ?? [], mode, publicOrigin.origin),
    },
    fleet: {
      label: fleetValue(fleet.label ?? defaultFleetLabel(publicOrigin.origin), parseFleetLabel, "fleet.label must contain 1 to 64 display characters"),
      targets: fleetTargets(fleet.targets ?? [], mode, publicOrigin.origin),
    },
    speech: { browserRecognition },
    ...(Object.hasOwn(record, "tern") ? { tern: parseTernConfig(record.tern) } : {}),
    // Written only when asserted, so an ordinary config keeps the shape it had before this field
    // existed and the safe reading is the absent one.
    auth: { mode, allowedLogins, ...(declaredTrust ? { trustIdentityWithoutTailnetDevice: true } : {}) },
    registry: {
      heartbeatSeconds,
      ttlSeconds,
      maxSessions: validateBoundedInteger(
        registry.maxSessions ?? defaults.registry.maxSessions,
        1,
        1_000,
        "registry.maxSessions",
      ),
    },
    // A service-managed daemon does not inherit the operator's `PI_CONFIG_DIR`, so the discovery
    // directory is derivable but also overridable. Absent means "derive it", which is the default
    // every ordinary install keeps.
    omp: {
      discoveryDir: requireDiscoveryDir(omp.discoveryDir) ?? defaults.omp.discoveryDir,
      queryTimeoutMs: validateBoundedInteger(
        omp.queryTimeoutMs ?? defaults.omp.queryTimeoutMs,
        250,
        10_000,
        "omp.queryTimeoutMs",
      ),
    },
    paths: defaults.paths,
  };
}

export async function loadGatewayConfig(overrides: ConfigOverrides = {}): Promise<GatewayConfig> {
  const paths = defaultGatewayPaths();
  const defaults: GatewayConfig = {
    http: {
      hostname: "127.0.0.1",
      port: overrides.port ?? 4317,
      publicOrigin: overrides.publicOrigin ?? `http://127.0.0.1:${overrides.port ?? 4317}`,
      trustedDashboardOrigins: [],
    },
    fleet: { label: "127.0.0.1", targets: [] },
    speech: { browserRecognition: false },
    auth: { mode: overrides.mode ?? "tailscale-serve", allowedLogins: [] },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 100 },
    omp: { discoveryDir: resolveOmpDiscoveryDirectory(), queryTimeoutMs: 1_500 },
    paths: { ...paths, configPath: overrides.configPath ?? paths.configPath },
  };
  const configPath = overrides.configPath ?? paths.configPath;
  let loaded: unknown = {};
  try {
    const configBytes = await assertPrivateRegularFile(configPath);
    if (configBytes > 64 * 1_024) throw new Error("config file exceeds size limit");
    loaded = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = parseConfigObject(loaded, defaults);
  const mode = overrides.mode ?? config.auth.mode;
  const port = overrides.port === undefined ? config.http.port : validatePort(overrides.port);
  const publicOriginValue =
    overrides.publicOrigin ??
    (mode === "dev-localhost" && (overrides.mode !== undefined || overrides.port !== undefined)
      ? loopbackHttpOrigin(config.http.hostname, port)
      : config.http.publicOrigin);
  const publicOrigin = new URL(publicOriginValue);
  if (publicOrigin.origin !== publicOriginValue) throw new Error("http.publicOrigin must be an exact URL origin");
  if (mode === "tailscale-serve" && publicOrigin.protocol !== "https:") {
    throw new Error("tailscale-serve mode requires an exact HTTPS public origin");
  }
  if (mode === "dev-localhost" && publicOrigin.origin !== loopbackHttpOrigin(config.http.hostname, port)) {
    throw new Error("dev-localhost mode requires the configured loopback HTTP origin");
  }
  if (mode === "tailscale-serve" && config.auth.allowedLogins.length === 0) {
    throw new Error("tailscale-serve mode requires at least one allowed login");
  }
  const authoredFleet = configSection(loaded as Record<string, unknown>, "fleet");
  return {
    ...config,
    auth: { ...config.auth, mode },
    http: {
      ...config.http,
      port,
      publicOrigin: publicOrigin.origin,
      trustedDashboardOrigins: trustedDashboardOrigins(config.http.trustedDashboardOrigins, mode, publicOrigin.origin),
    },
    fleet: {
      label: authoredFleet.label === undefined
        ? fleetValue(defaultFleetLabel(publicOrigin.origin), parseFleetLabel, "fleet.label must contain 1 to 64 display characters")
        : config.fleet.label,
      targets: fleetTargets(config.fleet.targets, mode, publicOrigin.origin),
    },
    paths: { ...paths, configPath },
  };
}

export async function ensureRuntimeDirectories(config: GatewayConfig): Promise<void> {
  await assertPrivateDirectory(config.paths.configDir, true);
  await assertPrivateDirectory(config.paths.stateDir, true);
  if (process.platform !== "win32") await assertPrivateDirectory(config.paths.runtimeDir, true);
}

export interface GatewayConfigFileSnapshot {
  readonly path: string;
  readonly content: string | undefined;
}

export async function readPrivateTextFile(path: string, maximumBytes: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("invalid private file size limit");
  try {
    const bytes = await assertPrivateRegularFile(path);
    if (bytes > maximumBytes) throw new Error(`private file exceeds size limit: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writePrivateTextFile(
  path: string,
  content: string,
  options: { readonly exclusive?: boolean; readonly syncDirectory?: boolean } = {},
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.exclusive === true) {
      if (process.platform === "win32") await applyWindowsAcl(temporaryPath, false);
      // A hard link publishes the completed file atomically and, unlike rename, never replaces a
      // pre-existing rollback backup, including one another rollback created concurrently.
      await link(temporaryPath, path);
    } else {
      await rename(temporaryPath, path);
    }
    if (process.platform === "win32") await applyWindowsAcl(path, false);
    else await chmod(path, 0o600);
    if (options.syncDirectory === true) {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function captureGatewayConfigFile(
  path = defaultGatewayPaths().configPath,
): Promise<GatewayConfigFileSnapshot> {
  try {
    const bytes = await assertPrivateRegularFile(path);
    if (bytes > 64 * 1_024) throw new Error("config file exceeds size limit");
    return { path, content: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, content: undefined };
    throw error;
  }
}

export async function restoreGatewayConfigFile(snapshot: GatewayConfigFileSnapshot): Promise<void> {
  await assertPrivateDirectory(dirname(snapshot.path), true);
  if (snapshot.content !== undefined) {
    await writePrivateTextFile(snapshot.path, snapshot.content);
    return;
  }
  try {
    const info = await lstat(snapshot.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("refusing to remove an unsafe config path");
    await rm(snapshot.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function publicOriginHttpsPort(publicOrigin: string): number {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:") throw new Error("public origin must use HTTPS");
  return origin.port === "" ? 443 : Number.parseInt(origin.port, 10);
}

export async function writeGatewayConfigFile(options: {
  readonly publicOrigin: string;
  readonly allowedLogins: readonly string[];
  readonly port?: number;
  readonly mode?: AuthMode;
}): Promise<GatewayConfig> {
  const paths = defaultGatewayPaths();
  const snapshot = await captureGatewayConfigFile(paths.configPath);
  const priorConfig =
    snapshot.content === undefined ? undefined : await loadGatewayConfig({ configPath: paths.configPath });
  const priorDocument = snapshot.content === undefined
    ? undefined
    : JSON.parse(snapshot.content) as {
        readonly http?: { readonly trustedDashboardOrigins?: readonly string[] };
        readonly omp?: Partial<GatewayConfig["omp"]>;
        readonly fleet?: { readonly label?: string; readonly targets?: readonly FleetSource[] };
        readonly speech?: Partial<GatewayConfig["speech"]>;
        readonly tern?: TernConfig;
      };
  const mode = options.mode ?? "tailscale-serve";
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || (mode === "tailscale-serve" && origin.protocol !== "https:")) {
    throw new Error("production public origin must be an exact HTTPS origin");
  }
  const allowedLogins = [...new Set(options.allowedLogins.map(normalizeLogin))];
  if (mode === "tailscale-serve" && allowedLogins.length === 0) {
    throw new Error("at least one allowed Tailscale login is required");
  }
  await assertPrivateDirectory(paths.configDir, true);
  await assertPrivateDirectory(paths.stateDir, true);
  const configDocument = {
    // Preserve authored overrides without freezing home-derived defaults into a new config.
    ...(priorDocument?.omp === undefined ? {} : { omp: priorDocument.omp }),
    ...(priorDocument?.fleet === undefined ? {} : { fleet: priorDocument.fleet }),
    ...(priorDocument?.speech === undefined ? {} : { speech: priorDocument.speech }),
    ...(priorDocument?.tern === undefined ? {} : { tern: priorDocument.tern }),
    http: {
      hostname: priorConfig?.http.hostname ?? "127.0.0.1",
      port: validatePort(options.port ?? priorConfig?.http.port ?? 4317),
      publicOrigin: origin.origin,
      ...(priorDocument?.http?.trustedDashboardOrigins === undefined
        ? {}
        : { trustedDashboardOrigins: priorDocument.http.trustedDashboardOrigins }),
    },
    auth: {
      mode,
      allowedLogins,
      ...(priorConfig?.auth.trustIdentityWithoutTailnetDevice === true
        ? { trustIdentityWithoutTailnetDevice: true }
        : {}),
    },
    registry:
      priorConfig === undefined
        ? { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 100 }
        : {
            heartbeatSeconds: priorConfig.registry.heartbeatSeconds,
            ttlSeconds: priorConfig.registry.ttlSeconds,
            maxSessions: priorConfig.registry.maxSessions,
          },
  };
  const authoredConfig = parseConfigObject(configDocument, {
    ...configDocument,
    http: { ...configDocument.http, trustedDashboardOrigins: priorConfig?.http.trustedDashboardOrigins ?? [] },
    fleet: priorConfig?.fleet ?? { label: defaultFleetLabel(origin.origin), targets: [] },
    speech: priorConfig?.speech ?? { browserRecognition: false },
    omp: priorConfig?.omp ?? { discoveryDir: resolveOmpDiscoveryDirectory(), queryTimeoutMs: 1_500 },
    paths,
  });
  const unchanged =
    priorConfig !== undefined &&
    authoredConfig.http.hostname === priorConfig.http.hostname &&
    authoredConfig.http.port === priorConfig.http.port &&
    authoredConfig.http.publicOrigin === priorConfig.http.publicOrigin &&
    JSON.stringify(authoredConfig.http.trustedDashboardOrigins) === JSON.stringify(priorConfig.http.trustedDashboardOrigins) &&
    JSON.stringify(authoredConfig.fleet) === JSON.stringify(priorConfig.fleet) &&
    authoredConfig.speech.browserRecognition === priorConfig.speech.browserRecognition &&
    authoredConfig.auth.mode === priorConfig.auth.mode &&
    authoredConfig.auth.allowedLogins.length === priorConfig.auth.allowedLogins.length &&
    authoredConfig.auth.allowedLogins.every((login, index) => login === priorConfig.auth.allowedLogins[index]) &&
    authoredConfig.auth.trustIdentityWithoutTailnetDevice === priorConfig.auth.trustIdentityWithoutTailnetDevice &&
    authoredConfig.registry.heartbeatSeconds === priorConfig.registry.heartbeatSeconds &&
    authoredConfig.registry.ttlSeconds === priorConfig.registry.ttlSeconds &&
    authoredConfig.registry.maxSessions === priorConfig.registry.maxSessions;
  if (unchanged) return priorConfig;
  await writePrivateTextFile(paths.configPath, `${JSON.stringify(configDocument, null, 2)}\n`);
  return loadGatewayConfig({ configPath: paths.configPath });
}

async function writeReadinessToken(path: string, token: string): Promise<string> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("readiness token has invalid encoding or length");
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  if (process.platform === "win32") await applyWindowsAcl(path, false);
  else await chmod(path, 0o600);
  return token;
}

async function writeFreshToken(path: string): Promise<string> {
  return writeReadinessToken(path, randomBytes(32).toString("base64url"));
}

async function readExistingReadinessToken(config: GatewayConfig): Promise<string> {
  const tokenBytes = await assertPrivateRegularFile(config.paths.tokenPath);
  if (tokenBytes < 43 || tokenBytes > 45) throw new Error("readiness token has invalid encoding or length");
  const token = (await readFile(config.paths.tokenPath, "utf8")).trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error("readiness token has invalid encoding or length");
  return token;
}

export async function assertReadinessTokenPrivate(config: GatewayConfig): Promise<void> {
  await readExistingReadinessToken(config);
}

export async function loadOrCreateReadinessToken(config: GatewayConfig): Promise<string> {
  await ensureRuntimeDirectories(config);
  try {
    return await readExistingReadinessToken(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return writeFreshToken(config.paths.tokenPath);
  }
}

export async function loadReadinessToken(config: GatewayConfig): Promise<string> {
  await ensureRuntimeDirectories(config);
  return readExistingReadinessToken(config);
}

export async function rotateReadinessToken(config: GatewayConfig): Promise<string> {
  await ensureRuntimeDirectories(config);
  try {
    const existing = await lstat(config.paths.tokenPath);
    if (!existing.isFile() && !existing.isSymbolicLink()) {
      throw new Error("refusing to replace a non-file readiness token path");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return writeFreshToken(config.paths.tokenPath);
}

export function readinessTokenMatches(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const padded = Buffer.alloc(expectedBytes.length);
  suppliedBytes.copy(padded, 0, 0, expectedBytes.length);
  return timingSafeEqual(expectedBytes, padded) && suppliedBytes.length === expectedBytes.length;
}

/**
 * Mainline OMP publishes into its own directory, so the gateway holds no endpoint of its own to
 * remove. What is left is a one-time cleanup: the fork era wrote a publisher credential that no
 * process consumes any more, and a dead secret is worth deleting rather than leaving on disk.
 */
export async function removeLegacyPublisherToken(config: GatewayConfig): Promise<boolean> {
  const legacyPath = join(config.paths.configDir, "publisher-token");
  try {
    const info = await lstat(legacyPath);
    if (!info.isFile()) return false;
    await rm(legacyPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}
