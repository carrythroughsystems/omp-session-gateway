import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import pins from "./windows-qualification-pins.json";
import { assertWindowsAllocation, assertWindowsExecution, cleanupWindows, preflightWindows, runWindows, windowsCampaignLabel, windowsContainmentExecution, windowsFailure, windowsNeedsCleanup, windowsRemaining } from "./windows-stable-qualification.ts";
import type { WindowsAdmission, WindowsArtifact, WindowsContext, WindowsExecutionContext, WindowsFirewall, WindowsIdentity, WindowsInstance, WindowsLaneInput, WindowsPreflightInput, WindowsPrincipal, WindowsRuntime, WindowsTransportProbe } from "./windows-stable-qualification.ts";
import { QualificationFailure } from "./qualification-failure.ts";
import { parseCandidateTagArgs, parseQualificationPins, releaseArchivePath, verifyRelease, waitForPublishedSession, waitForRevocation } from "./stable-qualification.ts";
import { windowsHostScript } from "./upstream-canary.ts";
import { OMP_FIXTURE_ARGS, OMP_FIXTURE_ENV } from "./omp-fixture.ts";
import { runAdb as androidAdb, parseKeyguardShowing, requireSingleDevice as androidDevice, withAndroidChrome } from "./android-device.ts";
import { runAndroidCollabSmoke } from "./android-collab-smoke.ts";
import { releaseVersion } from "./release-policy.ts";
import { firewallEligibility, instanceEligibility, QUAL_LABEL_PREFIX } from "./vultr-target.ts";
import { confirmAbsence, readProvider } from "./provider-read.ts";
import { pixelUnrestored } from "./restoration.ts";

const root = resolve(import.meta.dir, "..");
const privateRoot = join(homedir(), ".local/share/omp-session-gateway/qualification");
const devRoot = join(privateRoot, "dev/windows");
const python = join(privateRoot, "venv/bin/python");
const SHA = /^[0-9a-f]{64}$/u;
const sessionLabel = "omp-winqual-fixture";
interface Access extends Record<string, unknown> {
  instance: string;
  firewall?: string;
  host: string;
  password: string;
  origin?: string;
  machine?: string;
  configDigest?: string;
  credentialDigest?: string;
  ompPath?: string;
  ompPid?: number;
  pixelState?: { serial: string; component: string; launcherPackage: string; launcherCategory: string; wakefulness: string; keyguard: boolean };
  /** The standard account the non-elevated sub-lane installs as; its password exists only here and in encrypted WinRM input. */
  standardUser?: { account: string; password: string };
  standardConfigDigest?: string;
  standardCredentialDigest?: string;
  uploads?: Partial<Record<"candidate.tar" | "predecessor.tar" | "source.tar", "started" | "complete">>;
}
/** The WinRM and RDP account for `principal`, refusing the standard one before it exists. */
function account(access: Access, principal: WindowsPrincipal): { readonly account: string; readonly password: string } {
  if (principal === "administrator") return { account: "Administrator", password: access.password };
  if (!access.standardUser) throw new Error("the standard account has not been prepared");
  return access.standardUser;
}
/**
 * The foreground restoration returns to. An idle charging Pixel shows its screensaver, a dream task
 * over whatever it covers. The dream stands for the topmost task beneath it: restoration relaunches
 * that task and turns the display off, as it does for a sleeping Pixel.
 */
export function windowsPixelForeground(activities: string): string | undefined {
  const resumed = /(?:topResumedActivity|mResumedActivity|ResumedActivity).*?\bu\d+\s+([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)(?:\s+t(\d+)\b)?/u.exec(activities);
  const types = new Map<string, string>();
  for (const [, task, type] of activities.matchAll(/Task\{[^}]*?#(\d+) type=(\w+)/gu)) if (task && type) types.set(task, type);
  if (!resumed?.[2] || types.get(resumed[2]) !== "dream") return resumed?.[1];
  // Tasks are listed top to bottom, and each task's history from its top activity down.
  for (const [, component, task] of activities.matchAll(/\* Hist\s+#\d+: ActivityRecord\{[^}]*?\bu\d+\s+([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s+t(\d+)\b/gu)) {
    if (task && types.get(task) !== "dream") return component;
  }
  return undefined;
}
/** What restoration relaunches: the app that owns the foreground task, or the home app when the Pixel sat at home. */
export function windowsPixelLauncher(activities: string, component: string): { packageName: string; category: string } {
  const lines = activities.split(/\r?\n/u);
  const tasks = new Set(lines.filter(line => line.includes(` ${component} `)).flatMap(line => /\bt(\d+)\b/u.exec(line)?.[1] ?? []));
  const launchers = new Map<string, string>();
  for (const line of lines) {
    const task = /Task\{[^}]*#(\d+)\b/u.exec(line)?.[1];
    if (!task || !tasks.has(task)) continue;
    // A home task has no affinity, so Android prints its intent component instead, and the home
    // app answers the HOME category: `monkey` finds no LAUNCHER activity in it.
    const home = /\btype=home\b/u.test(line);
    const name = /\bA=\d+:([A-Za-z0-9_.]+)/u.exec(line)?.[1] ?? (home ? /\bI=([A-Za-z0-9_.]+)\//u.exec(line)?.[1] : undefined);
    if (name) launchers.set(name, home ? "android.intent.category.HOME" : "android.intent.category.LAUNCHER");
  }
  const [launcher] = launchers;
  if (launchers.size !== 1 || !launcher) throw new Error("Pixel foreground launcher is ambiguous");
  return { packageName: launcher[0], category: launcher[1] };
}
/** Recognize only the helper's fixed, credential-free event; never retain raw stderr. */
async function firstWinrmResponse(stream: ReadableStream<Uint8Array>, observed: (at: number) => void): Promise<void> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let pending = "", discarded = false, seen = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const part of decoder.decode(value, { stream: true }).split(/(\n)/u)) {
        if (part === "\n") {
          const match = !discarded && !seen ? /^WINRM_FIRST_RESPONSE ([0-9]{13})$/u.exec(pending) : null;
          if (match) { seen = true; observed(Number(match[1])); }
          pending = ""; discarded = false;
        } else if (!discarded && pending.length + part.length <= 80) pending += part;
        else discarded = true;
      }
    }
  } finally { reader.releaseLock(); }
}
type WindowsTermination = "command_deadline" | "execution_deadline" | "external";
export class WindowsCommandFailure extends Error {
  constructor(readonly exitCode: number, readonly termination: WindowsTermination | null, readonly signal: number,
    readonly elapsedMs: number, readonly timeoutMs: number, options?: ErrorOptions) {
    super("Windows command failed; output withheld", options);
  }
  get controllerDeadline(): boolean { return this.termination === "command_deadline" || this.termination === "execution_deadline"; }
}
export function classifyWindowsCommandFailure(error: WindowsCommandFailure, readOnly: boolean, connectionProbe: boolean,
  execution?: WindowsExecutionContext): QualificationFailure {
  const expired = execution !== undefined && performance.now() >= execution.deadline;
  const stopped = error.termination === "execution_deadline" || expired || execution?.signal.aborted;
  return windowsFailure(stopped ? "deadline_exceeded" : readOnly && connectionProbe && error.controllerDeadline ? "probe_deadline" : readOnly ? "helper_failed" : "mutation_unconfirmed",
    "command", readOnly ? "read_only" : "unknown",
    { controllerDeadline: error.controllerDeadline || expired, readOnlyProbe: readOnly && connectionProbe,
      exitCode: Math.max(0, Math.min(255, error.exitCode)), signal: error.signal, timeoutMs: error.timeoutMs }, execution, error.elapsedMs, { cause: error });
}
/** Preserve secondary diagnostic provenance without adding a sanitized failure leaf. */
function retainWindowsCause(error: unknown, cause: unknown): unknown {
  if (error === cause) return error;
  if (!(error instanceof Error)) return new AggregateError([error, cause], "Windows operation and diagnostic failed");
  error.cause = new AggregateError([cause, ...(error.cause === undefined ? [] : [error.cause])], "Windows operation diagnostics");
  return error;
}
export async function command(argv: readonly string[], options: {
  cwd?: string; input?: string; timeoutMs?: number; allowedExitCodes?: readonly number[];
  transportProbe?: (probe: WindowsTransportProbe) => Promise<void>;
  /** Synchronous final resource-lifetime admission, after the last awaited checkpoint. */
  beforeSpawn?: () => void;
  execution?: WindowsExecutionContext;
  terminationGraceMs?: number;
} = {}): Promise<string> {
  const started = performance.now(), timeoutMs = options.timeoutMs ?? 120_000;
  assertWindowsExecution(options.execution);
  const budgetDeadline = Math.min(started + timeoutMs, options.execution?.deadline ?? Infinity);
  const initialBudget = windowsRemaining(started, budgetDeadline, started, options.execution, "not_started");
  let stopChild: ((origin: WindowsTermination) => void) | undefined;
  const origin = options.execution && options.execution.deadline <= started + timeoutMs ? "execution_deadline" : "command_deadline";
  const deadline = setTimeout(() => stopChild?.(origin), initialBudget);
  const abort = () => stopChild?.("external");
  options.execution?.signal.addEventListener("abort", abort, { once: true });
  try {
  let probe: WindowsTransportProbe | undefined = options.transportProbe === undefined ? undefined : {
    startedAt: Date.now(), timeoutMs: options.timeoutMs ?? 120_000, firstResponseLatencyMs: null, signalAt: null, exitedAt: null, exitCode: null,
  };
  if (probe) await options.transportProbe!({ ...probe });
  let updates = Promise.resolve(), checkpointFailed = false, checkpointFailure: unknown;
  const record = (patch: Partial<WindowsTransportProbe>) => {
    if (!probe) return;
    probe = { ...probe, ...patch };
    const snapshot = probe;
    updates = updates.then(() => options.transportProbe!(snapshot)).catch(error => {
      if (!checkpointFailed) { checkpointFailed = true; checkpointFailure = error; }
    });
  };
  // The checkpoint owns an await: neither cancellation nor its elapsed budget permits spawn.
  options.beforeSpawn?.();
  windowsRemaining(started, budgetDeadline, performance.now(), options.execution, "not_started");
  const proc = Bun.spawn([...argv], { cwd: options.cwd ?? root, stdin: options.input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  let termination: WindowsTermination | null = null, sentSignal = 0, grace: ReturnType<typeof setTimeout> | undefined;
  const terminate = (origin: WindowsTermination) => {
    if (proc.exitCode !== null) return;
    if (sentSignal !== 0) return;
    termination = origin; sentSignal = 15;
    const signalAt = Date.now();
    proc.kill("SIGTERM");
    record({ signalAt, controllerDeadline: origin !== "external" });
    grace = setTimeout(() => {
      if (proc.exitCode !== null) return;
      sentSignal = 9; proc.kill("SIGKILL"); record({ killAt: Date.now() });
    }, options.terminationGraceMs ?? 5_000);
  };
  stopChild = terminate;
  if (options.execution?.signal.aborted) abort();
  const exited = proc.exited.then(code => { clearTimeout(deadline); clearTimeout(grace); return { code, at: Date.now() }; });
  // Start drains before writing stdin, including when writing input itself fails.
  const drained = Promise.all([exited, new Response(proc.stdout).text(), probe === undefined
    ? new Response(proc.stderr).arrayBuffer()
    : firstWinrmResponse(proc.stderr, at => record({ firstResponseLatencyMs: Math.max(0, at - probe!.startedAt) }))]);
  try {
    let inputFailed = false, inputFailure: unknown;
    try {
      if (options.input !== undefined) {
        if (proc.stdin === undefined || typeof proc.stdin === "number") throw new Error("subprocess input pipe unavailable");
        proc.stdin.write(options.input); proc.stdin.end();
      }
    } catch (error) { inputFailed = true; inputFailure = error; terminate("external"); }
    const [exit, out] = await drained;
    record({ exitedAt: exit.at, exitCode: exit.code });
    await updates;
    if (checkpointFailed) throw checkpointFailure;
    if (inputFailed || sentSignal !== 0 || !(options.allowedExitCodes ?? [0]).includes(exit.code)) {
      throw new WindowsCommandFailure(exit.code, termination, sentSignal, performance.now() - started, timeoutMs,
        inputFailed ? { cause: inputFailure } : options.execution?.signal.aborted ? { cause: options.execution.signal.reason } : undefined);
    }
    assertWindowsExecution(options.execution, "unknown");
    return out.trim();
  } finally {
    terminate("external");
    await exited;
    await drained.catch(() => {});
    clearTimeout(deadline); clearTimeout(grace);
  }
  } finally {
    clearTimeout(deadline);
    options.execution?.signal.removeEventListener("abort", abort);
  }
}
async function privateFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("qualification input must be a private current-user regular file");
  return readFile(path, "utf8");
}
async function atomicPrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new Error("unsafe qualification vault directory");
  const temporary = `${path}.${randomUUID()}`;
  try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
function digest(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function vaultPath(epoch: string): string { windowsCampaignLabel(epoch); return join(privateRoot, "windows-vault", `${epoch}.json`); }
async function loadAccess(epoch: string): Promise<Access> {
  const text = await privateFile(vaultPath(epoch));
  try { return JSON.parse(text) as Access; }
  catch (error) { throw new Error("qualification vault is malformed", { cause: error }); }
}
/**
 * The epoch's vault, or undefined once cleanup has removed it. Cleanup removes the vault only after the
 * Pixel is restored and the VM is gone, so a repeated cleanup finds nothing left to restore.
 */
async function existingAccess(epoch: string): Promise<Access | undefined> {
  try { return await loadAccess(epoch); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Failure text is independent of HTTP bodies, which can contain credentials and identifiers. */
export async function request<T>(url: string, headers: Record<string, string>, method = "GET", body?: unknown,
  execution?: WindowsExecutionContext, deadline?: number): Promise<T | undefined> {
  const started = performance.now();
  assertWindowsExecution(execution);
  const operationDeadline = Math.min(execution?.deadline ?? Infinity, deadline ?? Infinity);
  if (operationDeadline <= performance.now()) throw windowsFailure("deadline_exceeded", "connection", "not_started", {}, execution);
  const owner = new AbortController();
  const signal = execution === undefined ? owner.signal : AbortSignal.any([owner.signal, execution.signal]);
  const timer = Number.isFinite(operationDeadline) ? setTimeout(() => owner.abort(), Math.max(0, operationDeadline - performance.now())) : undefined;
  const send = (readSignal: AbortSignal = signal) => {
    assertWindowsExecution(execution);
    if (deadline !== undefined) windowsRemaining(started, deadline, performance.now(), execution, "not_started");
    return fetch(url, { method, headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body), signal: AbortSignal.any([readSignal, AbortSignal.timeout(60_000)]) });
  };
  try {
    const response = method === "GET" ? await readProvider(send, { signal, deadline: operationDeadline }) : await send();
    assertWindowsExecution(execution, method === "GET" ? "read_only" : "unknown");
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) {
      await response.body?.cancel();
      if (method === "GET" && (response.status === 429 || response.status >= 500)) {
        throw windowsFailure("retryable_service_failure", "connection", "read_only", { httpStatus: response.status }, execution);
      }
      throw windowsFailure(response.status === 401 || response.status === 403 ? "authentication_failed" : "helper_failed",
        "connection", method === "GET" ? "read_only" : "unknown", { httpStatus: response.status }, execution);
    }
    const text = response.status === 204 ? "" : await response.text();
    signal.throwIfAborted();
    try { return text === "" ? undefined : JSON.parse(text) as T; }
    catch (error) { throw windowsFailure("helper_failed", "output", method === "GET" ? "read_only" : "unknown", {}, execution, 0, { cause: error }); }
  }
  catch (error) {
    if (signal.aborted || performance.now() >= operationDeadline) {
      throw windowsFailure("deadline_exceeded", "connection", method === "GET" ? "read_only" : "unknown", {}, execution, 0, { cause: error });
    }
    if (error instanceof QualificationFailure) throw error;
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (method === "GET") {
      if (code === "ECONNRESET") throw windowsFailure("connection_reset", "connection", "read_only", { transportFailure: true }, execution, 0, { cause: error });
      if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") throw windowsFailure("connection_timeout", "connection", "read_only", { transportFailure: true }, execution, 0, { cause: error });
      if (error instanceof DOMException && error.name === "TimeoutError") throw windowsFailure("read_timeout", "connection", "read_only", { transportFailure: true }, execution, 0, { cause: error });
    }
    throw windowsFailure(method === "GET" ? "helper_failed" : "mutation_unconfirmed", "connection", method === "GET" ? "read_only" : "unknown", {}, execution, 0, { cause: error });
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Same launch predicates as the shared verifier, with typed Windows assertion boundaries. */
async function observeWindowsLaunch(origin: string, session: Record<string, unknown>, expected: "live" | "stale",
  fetcher: (url: string, options: RequestInit) => Promise<Response>, execution?: WindowsExecutionContext, guard?: () => void): Promise<void> {
  if (typeof session.instanceId !== "string" || typeof session.generation !== "number") throw windowsFailure("helper_failed", "output", "read_only");
  const assertion = () => {
    const failure = windowsFailure("assertion_failed", "output", "confirmed");
    failure.message = expected === "stale" ? "stale generation did not fail closed with 409" : "OMP launch contract failed";
    return failure;
  };
  for (const mode of ["view", "control"] as const) {
    let response: Response;
    try {
      assertWindowsExecution(execution);
      guard?.();
      response = await fetcher(`${origin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`, {
        method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ mode, generation: session.generation + (expected === "stale" ? 1 : 0) }),
        cache: "no-store", signal: AbortSignal.timeout(expected === "stale" ? 30_000 : 10_000),
      });
    } catch (error) { if (error instanceof QualificationFailure) throw error; throw windowsFailure("helper_failed", "connection", "read_only", {}, execution, 0, { cause: error }); }
    if (response.status !== (expected === "stale" ? 409 : 200) || !response.headers.get("cache-control")?.includes("no-store")) {
      const failure = assertion();
      try { await response.body?.cancel(); } catch (error) { throw retainWindowsCause(failure, error); }
      throw failure;
    }
    let payload: unknown;
    try { payload = await response.json(); } catch (error) { throw windowsFailure("helper_failed", "output", "read_only", {}, execution, 0, { cause: error }); }
    if (!object(payload)) throw windowsFailure("helper_failed", "output", "read_only");
    const released = Object.hasOwn(payload, "capability");
    const valuePresent = typeof payload.capability === "string" && payload.capability !== "";
    delete payload.capability;
    if (expected === "stale" ? released || payload.code !== "generation_mismatch"
      : !valuePresent || payload.mode !== mode || payload.generation !== session.generation) throw assertion();
  }
}
export async function verifyWindowsLaunchContracts(origin: string, session: Record<string, unknown>, fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch, execution?: WindowsExecutionContext, guard?: () => void): Promise<void> {
  await observeWindowsLaunch(origin, session, "live", fetcher, execution, guard);
}
/** Checks stale View and Control independently and discards launch values before returning. */
export async function verifyWindowsStaleLaunch(origin: string, session: Record<string, unknown>, fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch, execution?: WindowsExecutionContext, guard?: () => void): Promise<Record<string, unknown>> {
  await observeWindowsLaunch(origin, session, "stale", fetcher, execution, guard);
  return { staleViewStatus: 409, staleControlStatus: 409 };
}

/** Pixel measurement must leave the final hour of the resource lifetime for containment. */
export function assertWindowsPixelDispatch(context: WindowsContext): void {
  context.assertEffect(2 * 60 * 60_000);
}

export async function windowsCreationClaim(counterPath: string, creations: number, execution: WindowsExecutionContext | undefined, allocationDeadline: number | undefined): Promise<void> {
  assertWindowsAllocation(execution, allocationDeadline);
  await atomicPrivate(counterPath, creations + 1);
}

/** Both admission and creation use the current owner's closed refusal and ID allocator. */
export function windowsCreationAllowance(creations: number, limit: number, execution?: WindowsExecutionContext): number {
  assertWindowsExecution(execution);
  if (!Number.isSafeInteger(creations) || creations < 0 || creations >= limit) {
    throw windowsFailure("helper_failed", "preflight", "not_started", {}, execution);
  }
  return limit - creations;
}

/** Awaited preparation cannot authorize attaching a firewall whose ownership has changed. */
export async function windowsAttachedFirewallGuard(read: () => Promise<WindowsFirewall | undefined>, id: string, label: string,
  environment: Readonly<Record<string, string | undefined>>, execution?: WindowsExecutionContext): Promise<void> {
  const fresh = await read();
  if (!fresh || fresh.id !== id || fresh.description !== label || !firewallEligibility(fresh.id, fresh.description, environment).eligible) {
    throw windowsFailure("ownership_changed", "connection", "not_started", {}, execution);
  }
}

export async function configureWindowsFirewallRules(options: {
  id: string; label: string; environment: Readonly<Record<string, string | undefined>>;
  read: () => Promise<WindowsFirewall | undefined>; post: (port: string) => Promise<void>;
  execution?: WindowsExecutionContext | undefined; allocationDeadline?: number | undefined; now?: () => number;
}): Promise<void> {
  for (const port of ["3389", "5985"]) {
    assertWindowsAllocation(options.execution, options.allocationDeadline, (options.now ?? Date.now)());
    await windowsAttachedFirewallGuard(options.read, options.id, options.label, options.environment, options.execution);
    assertWindowsAllocation(options.execution, options.allocationDeadline, (options.now ?? Date.now)());
    await options.post(port);
  }
}

export async function waitForStableWindowsTransport(
  probe: (timeoutMs: number) => Promise<Record<string, unknown>>,
  clock: Pick<WindowsRuntime, "now" | "sleep">,
  deadline: number,
  execution?: WindowsExecutionContext,
): Promise<Record<string, unknown>> {
  const started = clock.now();
  let samples = 0; let firstSuccess = 0;
  let lastFailure: unknown;
  const remaining = () => {
    try { return windowsRemaining(started, deadline, clock.now(), execution); }
    catch (error) { throw lastFailure === undefined ? error : retainWindowsCause(error, lastFailure); }
  };
  while (true) {
    const budget = remaining();
    let observation: Record<string, unknown>;
    try {
      observation = await probe(Math.min(180_000, budget));
    } catch (error) {
      lastFailure = error;
      const nextBudget = remaining();
      if (!(error instanceof QualificationFailure) || error.evidence.class !== "infra_transient") throw error;
      samples = 0; firstSuccess = 0;
      await clock.sleep(Math.min(30_000, nextBudget));
      continue;
    }
    const observedAt = clock.now();
    const nextBudget = windowsRemaining(started, deadline, observedAt, execution);
    if (samples === 0) firstSuccess = observedAt;
    samples += 1;
    if (samples >= 3 && observedAt - firstSuccess >= 60_000) {
      return { ...observation, transportStabilitySamples: samples, transportStabilityDurationMs: observedAt - firstSuccess };
    }
    await clock.sleep(Math.min(30_000, nextBudget));
  }
}

/** A legacy admitted boolean is not a durable observation of the stability window. */
export function windowsTransportStability(value: unknown): { transportStabilitySamples: number; transportStabilityDurationMs: number } | undefined {
  if (!object(value) || !Number.isSafeInteger(value.transportStabilitySamples) || Number(value.transportStabilitySamples) < 3 ||
    typeof value.transportStabilityDurationMs !== "number" || !Number.isFinite(value.transportStabilityDurationMs) ||
    value.transportStabilityDurationMs < 60_000) return undefined;
  return { transportStabilitySamples: Number(value.transportStabilitySamples), transportStabilityDurationMs: value.transportStabilityDurationMs };
}

export function windowsGuestAccessAvailable(value: unknown): boolean {
  return object(value) && typeof value.instance === "string" && value.instance !== "" &&
    typeof value.password === "string" && value.password !== "";
}

export async function pollWindows(action: () => Promise<boolean>, ms: number, name: string, execution?: WindowsExecutionContext,
  clock: Pick<WindowsRuntime, "now" | "sleep"> = { now: performance.now, sleep: Bun.sleep }): Promise<void> {
  const started = clock.now(), deadline = started + ms;
  const remaining = () => {
    try { return windowsRemaining(started, deadline, clock.now(), execution); }
    catch (error) {
      if (error instanceof QualificationFailure && error.evidence.reason === "deadline_exceeded") error.message = `${name} timed out`;
      throw error;
    }
  };
  while (true) {
    remaining();
    let succeeded: boolean;
    try { succeeded = await action(); }
    catch (error) {
      try { remaining(); } catch (expiry) { throw retainWindowsCause(expiry, error); }
      throw error;
    }
    const budget = remaining();
    if (succeeded) return;
    await clock.sleep(Math.min(5_000, budget));
  }
}

/** Own the child from its first stdin operation until exit, including write/end rejection. */
export async function settleWindowsRdp(child: {
  readonly stdin: { write(input: string): unknown; end(): unknown };
  readonly exitCode: number | null;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
  readonly exited: Promise<number>;
}, input: string, observe: () => Promise<void>, execution?: WindowsExecutionContext): Promise<void> {
  let grace: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const terminate = () => {
    if (stopped) return;
    stopped = true;
    grace = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5_000);
    child.kill("SIGTERM");
  };
  execution?.signal.addEventListener("abort", terminate, { once: true });
  try {
    assertWindowsExecution(execution);
    if (execution) {
      const now = performance.now();
      deadline = setTimeout(terminate, windowsRemaining(now, execution.deadline, now, execution, "not_started"));
    }
    await child.stdin.write(input); assertWindowsExecution(execution);
    await child.stdin.end(); assertWindowsExecution(execution);
    await observe();
  } finally {
    try {
      try { terminate(); } finally { await child.exited; }
    } finally {
      clearTimeout(grace); clearTimeout(deadline);
      execution?.signal.removeEventListener("abort", terminate);
    }
  }
}

type WindowsUploadStep = "existence/hash" | "remove" | "stream";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const interruptedUploadTransports = new WeakSet<QualificationFailure>();
/** Helper diagnostics are already redacted in Python; keep their bounded shape out of evidence. */
function withWinrmDiagnostic(error: QualificationFailure, value: Record<string, unknown>): QualificationFailure {
  if (typeof value.diagnostic !== "string" || value.diagnostic.length > 512) return error;
  const exception = value.exception;
  if (exception !== undefined) {
    if (!object(exception) || Object.keys(exception).sort().join(",") !== "frames,message,type,uploadStep" ||
      typeof exception.type !== "string" || !/^[A-Za-z0-9_]{1,120}$/u.test(exception.type) ||
      typeof exception.message !== "string" || exception.message.length > 2048 ||
      !(exception.uploadStep === null || ["existence/hash", "remove", "stream"].includes(String(exception.uploadStep))) ||
      !Array.isArray(exception.frames) || exception.frames.length > 16 || exception.frames.some(frame =>
        !object(frame) || Object.keys(frame).sort().join(",") !== "file,function,line" ||
        typeof frame.file !== "string" || !/^[A-Za-z0-9_.<>-]{1,120}$/u.test(frame.file) ||
        typeof frame.function !== "string" || !/^[A-Za-z0-9_.<>-]{1,120}$/u.test(frame.function) ||
        !Number.isSafeInteger(frame.line) || Number(frame.line) < 1)) return error;
  }
  return new QualificationFailure(error.evidence, { cause: new Error(windowsWinrmDiagnostic(value as Parameters<typeof windowsWinrmDiagnostic>[0]), { cause: error }) });
}
/** Only closed helper evidence is classification; diagnostics stay outside the failure record. */
export function windowsWinrmResult(value: unknown, readOnly: boolean, execution?: WindowsExecutionContext, upload = false): Record<string, unknown> {
  const invalid = (options?: ErrorOptions) => windowsFailure("helper_failed", "output", readOnly ? "read_only" : "unknown", {}, execution, 0, options);
  if (!object(value) || !Number.isInteger(value.exitCode) || typeof value.stdout !== "string" ||
    value.stdout.length > 1024 * 1024 || !object(value.teardown) ||
    Object.keys(value.teardown).sort().join(",") !== "commandAttempted,commandStopped,shellAttempted,shellClosed" ||
    Object.values(value.teardown).some(item => typeof item !== "boolean")) throw invalid();
  if (value.exitCode === 0 && value.failure === null) {
    // Both attempts imply that open_shell and run_command returned real identities.
    if (value.teardown.commandAttempted !== true || value.teardown.shellAttempted !== true) throw invalid();
    try {
      const observation: unknown = JSON.parse(value.stdout);
      if (!object(observation)) throw invalid();
      return observation;
    } catch (error) { throw invalid({ cause: error }); }
  }
  const failure = value.failure;
  if (!object(failure) || Object.keys(failure).sort().join(",") !== "condition,disposition,httpStatus,kind,stage" ||
    !["transport", "guest", "helper"].includes(String(failure.kind)) ||
    !["connection", "command", "output", "upload"].includes(String(failure.stage)) ||
    !["not_started", "read_only", "confirmed", "unknown"].includes(String(failure.disposition)) ||
    !(failure.httpStatus === null || (Number.isInteger(failure.httpStatus) && Number(failure.httpStatus) >= 100 && Number(failure.httpStatus) <= 599)) ||
    (failure.kind === "guest" ? Number(value.exitCode) <= 0 || Number(value.exitCode) > 255 || failure.condition !== "guest_failure"
      : value.exitCode !== -1) || (failure.kind === "helper" && failure.condition !== "helper_failure")) throw invalid();
  const step = failure.stage as "connection" | "command" | "output" | "upload";
  if (failure.kind === "transport" && (
    (["connection_timeout", "connection_reset", "read_timeout"].includes(String(failure.condition)) && failure.httpStatus !== null) ||
    (failure.condition === "authentication" && failure.httpStatus !== null && failure.httpStatus !== 401 && failure.httpStatus !== 403) ||
    ((failure.httpStatus === 401 || failure.httpStatus === 403) && failure.condition !== "authentication") ||
    (failure.condition === "retryable_http" && !(failure.httpStatus === 429 || Number(failure.httpStatus) >= 500))
  )) throw invalid();
  if (failure.kind === "transport" && failure.condition === "authentication") {
    throw withWinrmDiagnostic(windowsFailure("authentication_failed", step, readOnly ? "read_only" : "unknown", {}, execution), value);
  }
  if (readOnly && failure.kind === "transport") {
    if (["connection_timeout", "connection_reset", "read_timeout"].includes(String(failure.condition))) {
      throw withWinrmDiagnostic(windowsFailure(failure.condition as "connection_timeout" | "connection_reset" | "read_timeout",
        step, "read_only", { transportFailure: true }, execution), value);
    }
    if (failure.condition === "retryable_http" && (failure.httpStatus === 429 || Number(failure.httpStatus) >= 500)) {
      throw withWinrmDiagnostic(windowsFailure("retryable_service_failure", step, "read_only", { httpStatus: Number(failure.httpStatus) }, execution), value);
    }
  }
  const error = withWinrmDiagnostic(windowsFailure(readOnly || failure.kind !== "transport" ? "helper_failed" : "mutation_unconfirmed", step,
    readOnly ? "read_only" : failure.disposition === "not_started" ? "not_started" : failure.disposition === "confirmed" ? "confirmed" : "unknown", {}, execution), value);
  if (upload && !readOnly && failure.kind === "transport" && failure.disposition !== "confirmed" &&
    (["connection_timeout", "connection_reset", "read_timeout"].includes(String(failure.condition)) ||
      (failure.condition === "retryable_http" && (failure.httpStatus === 429 || Number(failure.httpStatus) >= 500)))) {
    interruptedUploadTransports.add(error);
  }
  throw error;
}

export async function reconnectWindowsTransport<T>(probe: (timeoutMs: number) => Promise<T>,
  clock: Pick<WindowsRuntime, "now" | "sleep">, execution?: WindowsExecutionContext): Promise<T> {
  const started = clock.now(), deadline = started + 90_000;
  const delays = [2_000, 4_000, 8_000, 16_000];
  let lastFailure: unknown;
  const remaining = () => {
    try { return Math.min(windowsRemaining(started, deadline, clock.now(), execution),
      execution === undefined ? Infinity : windowsRemaining(execution.deadline - 90_000, execution.deadline, performance.now(), execution)); }
    catch (error) { throw lastFailure === undefined ? error : retainWindowsCause(error, lastFailure); }
  };
  for (let attempt = 0; ; attempt += 1) {
    const budget = remaining();
    let result: T;
    try {
      result = await probe(budget);
    }
    catch (error) {
      lastFailure = error;
      const budget = remaining();
      if (!(error instanceof QualificationFailure) || error.evidence.class !== "infra_transient") throw error;
      const delay = delays[attempt];
      if (delay === undefined || delay >= budget) throw error;
      if (execution === undefined) await clock.sleep(delay);
      else {
        // Await every owned sleep; never abandon a Promise.race loser on cancellation.
        let left = delay;
        while (left > 0) {
          const slice = Math.min(left, 100, remaining());
          await clock.sleep(slice); left -= slice;
          remaining();
        }
      }
      continue;
    }
    remaining();
    return result;
  }
}

/** The stream runs once. Recovery observes exclusively opened bytes before reusing/removing them. */
export async function reconcileWindowsUpload(operations: {
  stream: () => Promise<unknown>;
  inspect: () => Promise<{ exists: boolean; matches: boolean; writerEnded: boolean }>;
  remove: () => Promise<unknown>;
}, execution?: WindowsExecutionContext): Promise<void> {
  try { assertWindowsExecution(execution); await operations.stream(); return; }
  catch (error) {
    if (!(error instanceof QualificationFailure) || !interruptedUploadTransports.has(error)) throw error;
    try {
      assertWindowsExecution(execution);
      const found = await operations.inspect();
      if (found.writerEnded && found.matches) return;
      if (found.writerEnded && found.exists) { assertWindowsExecution(execution); await operations.remove(); }
      throw windowsFailure("mutation_unconfirmed", "upload", "unknown",
        { mutationReconciled: found.writerEnded }, execution);
    } catch (recoveryError) { throw retainWindowsCause(recoveryError, error); }
  }
}

/** A durable started claim fences same-epoch development re-entry, including unknown exits. */
export async function windowsUploadOnce(operations: {
  allowFresh: boolean;
  state: () => Promise<"started" | "complete" | undefined>;
  checkpoint: (state: "started" | "complete") => Promise<void>;
  upload: () => Promise<void>;
  verify: () => Promise<boolean>;
}, execution?: WindowsExecutionContext): Promise<void> {
  const state = await operations.state();
  assertWindowsExecution(execution);
  if (state !== undefined && state !== "started" && state !== "complete") throw windowsFailure("helper_failed", "upload", "unknown", {}, execution);
  if (state === "started") throw windowsFailure("mutation_unconfirmed", "upload", "unknown", {}, execution);
  if (state === "complete") {
    if (await operations.verify()) return;
    throw windowsFailure("mutation_unconfirmed", "upload", "unknown", {}, execution);
  }
  if (operations.allowFresh !== true) throw windowsFailure("mutation_unconfirmed", "upload", "unknown", {}, execution);
  await operations.checkpoint("started");
  assertWindowsExecution(execution);
  await operations.upload();
  await operations.checkpoint("complete");
  assertWindowsExecution(execution);
}

/** Add only the Python helper's redacted message and source-free traceback to its legacy diagnostic. */
export function windowsWinrmDiagnostic(result: {
  diagnostic: string;
  exception?: {
    type: string; message: string; uploadStep: WindowsUploadStep | null;
    frames: { file: string; line: number; function: string }[];
  };
}): string {
  return result.diagnostic + (result.exception === undefined ? "" : `; ${JSON.stringify(result.exception)}`);
}

/** Label an upload failure without replaying a possibly accepted remote write. */
export async function windowsUploadStep<T>(step: WindowsUploadStep, action: (step: WindowsUploadStep) => Promise<T>): Promise<T> {
  try { return await action(step); }
  catch (error) {
    if (error instanceof QualificationFailure) throw error;
    throw windowsFailure("helper_failed", "upload", "unknown", {}, undefined, 0, { cause: error });
  }
}

/** Resolve the current owner at dispatch; cleanup replaces the cancelled primary execution. */
export function windowsAndroidCommands(owner: () => WindowsExecutionContext | undefined) {
  const runAdb: typeof androidAdb = (serial, args, settings = {}) => {
    const execution = owner();
    assertWindowsExecution(execution);
    if (execution === undefined) return androidAdb(serial, args, settings);
    const remaining = execution.deadline - performance.now();
    if (remaining <= 0) throw windowsFailure("deadline_exceeded", "pixel_verified", "not_started", {}, execution);
    return androidAdb(serial, args, { ...settings,
      signal: settings.signal === undefined ? execution.signal : AbortSignal.any([execution.signal, settings.signal]),
      timeoutMs: Math.min(settings.timeoutMs ?? Infinity, Math.ceil(remaining)),
    });
  };
  const requireSingleDevice: typeof androidDevice = command => {
    assertWindowsExecution(owner());
    return androidDevice(command ?? ((...args) => runAdb(undefined, args)));
  };
  return { runAdb, requireSingleDevice };
}

export async function createWindowsRuntime(options: { development?: boolean; execution?: WindowsExecutionContext } = {}): Promise<WindowsRuntime> {
  let execution = options.execution;
  const hostCommand = (argv: readonly string[], settings: Parameters<typeof command>[1] = {}) =>
    command(argv, { ...settings, ...(execution === undefined ? {} : { execution }) });
  const { runAdb, requireSingleDevice } = windowsAndroidCommands(() => execution);
  const environment: Record<string, string | undefined> = { ...process.env };
  const vultrKey = (await privateFile(join(homedir(), ".vultr-apikey"))).trim();
  let joinValue = ""; let apiValue = "";
  for (const name of [".ts-qual-authkey", ".ts-authkey-qual", ".ts-qual-apikey"]) {
    let value: string;
    try { value = (await privateFile(join(homedir(), name))).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (value.startsWith("tskey-auth-")) joinValue = value;
    if (value.startsWith("tskey-api-")) apiValue = value;
  }
  if (!joinValue || !apiValue) throw new Error("tagged join credential and tailnet API credential are required");
  const headers = { Authorization: `Bearer ${vultrKey}` };
  const tsHeaders = { Authorization: `Bearer ${apiValue}` };
  const api = <T>(path: string, method = "GET", body?: unknown, owner = execution, deadline?: number) =>
    request<T>(`https://api.vultr.com/v2/${path}`, headers, method, body, owner, deadline);
  const list = async <T>(path: string, key: string): Promise<T[]> => {
    let cursor = ""; const items: T[] = [];
    do {
      const url = `${path}?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      // Vultr has answered a listing without its array while the lane polled for allocation
      // (2026-09-29), as it once answered a lookup: an invalid page is final only if a second read agrees.
      const page = await confirmAbsence(async () => {
        const read = await api<Record<string, unknown>>(url);
        return read !== undefined && Array.isArray(read[key]) ? read : undefined;
      }, execution ?? {});
      if (!page) throw new Error("invalid provider listing");
      items.push(...page[key] as T[]);
      cursor = ((page.meta as { links?: { next?: string } } | undefined)?.links?.next ?? "");
    } while (cursor);
    return items;
  };
  let egress = "";
  let activeTag = "";
  const provider = {
    instances: () => list<WindowsInstance>("instances", "instances"),
    firewalls: () => list<WindowsFirewall>("firewalls", "firewall_groups"),
    instance: (id: string) => confirmAbsence(async () => (await api<{ instance: WindowsInstance }>(`instances/${encodeURIComponent(id)}`))?.instance, execution ?? {}),
    firewall: (id: string, owner = execution, deadline?: number) => confirmAbsence(async () =>
      (await api<{ firewall_group: WindowsFirewall }>(`firewalls/${encodeURIComponent(id)}`, "GET", undefined, owner, deadline))?.firewall_group,
      { ...owner, deadline: Math.min(owner?.deadline ?? Infinity, deadline ?? Infinity) }),
    async createFirewall(label: string, owner = execution, allocationDeadline?: number) {
      if (!egress) throw new Error("Windows preflight was not performed");
      const deadline = allocationDeadline === undefined ? undefined : performance.now() + Math.max(0, allocationDeadline - Date.now());
      assertWindowsAllocation(owner, allocationDeadline);
      const item = await api<{ firewall_group: WindowsFirewall }>("firewalls", "POST", { description: label }, owner, deadline);
      if (!item) throw new Error("firewall create response lost");
      // Preserve the exact ID before configuring it; a later label change must not become absence.
      await atomicPrivate(vaultPath(label.slice(QUAL_LABEL_PREFIX.length)), { firewall: item.firewall_group.id });
      return item.firewall_group;
    },
    async configureFirewall(id: string, label: string, owner = execution, allocationDeadline?: number) {
      const deadline = allocationDeadline === undefined ? undefined : performance.now() + Math.max(0, allocationDeadline - Date.now());
      await configureWindowsFirewallRules({ id, label, environment, execution: owner, allocationDeadline,
        read: () => provider.firewall(id, owner, deadline),
        post: async port => { await api(`firewalls/${id}/rules`, "POST", { ip_type: "v4", protocol: "tcp", subnet: egress, subnet_size: 32, port, notes: "qualification operator" }, owner, deadline); },
      });
    },
    async createInstance(label: string, firewall: string, owner = execution, allocationDeadline?: number) {
      const deadline = allocationDeadline === undefined ? undefined : performance.now() + Math.max(0, allocationDeadline - Date.now());
      await windowsAttachedFirewallGuard(() => provider.firewall(firewall, owner, deadline), firewall, label, environment, owner);
      const counterPath = join(devRoot, `creations-${activeTag}.json`);
      let creations = 0;
      try { creations = JSON.parse(await privateFile(counterPath)) as number; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const creationLimit = options.development ? 6 : 4;
      windowsCreationAllowance(creations, creationLimit, owner);
      await windowsCreationClaim(counterPath, creations, owner, allocationDeadline);
      await windowsAttachedFirewallGuard(() => provider.firewall(firewall, owner, deadline), firewall, label, environment, owner);
      assertWindowsAllocation(owner, allocationDeadline);
      const item = await api<{ instance: WindowsInstance }>("instances", "POST", { region: pins.region, plan: pins.plan, os_id: pins.osId, label, hostname: label, firewall_group_id: firewall, backups: "disabled", enable_ipv6: false }, owner, deadline);
      if (!item) throw new Error("instance create response lost"); return item.instance;
    },
    async destroyInstance(id: string, label: string) {
      const fresh = await provider.instance(id);
      if (!fresh) return;
      if (fresh.id !== id || fresh.label !== label || fresh.os_id !== pins.osId || fresh.region !== pins.region || fresh.plan !== pins.plan || !instanceEligibility(id, fresh.label, environment).eligible) throw windowsFailure("ownership_changed", "connection", "not_started");
      await api(`instances/${id}`, "DELETE");
    },
    async destroyFirewall(id: string, label: string) {
      const fresh = await provider.firewall(id);
      if (!fresh) return;
      if (fresh.id !== id || fresh.description !== label || !firewallEligibility(id, fresh.description, environment).eligible) throw windowsFailure("ownership_changed", "connection", "not_started");
      await api(`firewalls/${id}`, "DELETE");
    },
  };
  const guestScript = await readFile(join(import.meta.dir, "windows-qualification-guest.ps1"), "utf8");
  const winrm = async (context: WindowsContext, script: string, input?: unknown, timeoutMs = 300_000, upload?: { sourcePath: string; destinationPath: string }, mutation = true, principal: WindowsPrincipal = "administrator", transportProbe?: WindowsContext["transportProbe"], uploadStep?: WindowsUploadStep): Promise<Record<string, unknown>> => {
    const started = performance.now();
    const owner = context.execution ?? execution;
    const access = await loadAccess(context.epoch);
    assertWindowsExecution(owner);
    if (!windowsGuestAccessAvailable(access)) throw windowsFailure("helper_failed", "command", "not_started", {}, owner);
    if (mutation || !access.host) {
      const current = await provider.instance(access.instance);
      if (!current) throw windowsFailure("ownership_changed", "connection", "not_started", {}, owner);
      const mismatches = [current.id !== access.instance && "identity", current.label !== windowsCampaignLabel(context.epoch) && "label", current.os_id !== pins.osId && "image", current.plan !== pins.plan && "plan", current.region !== pins.region && "region", !instanceEligibility(current.id, current.label, environment).eligible && "protection"].filter(Boolean);
      if (mismatches.length) throw windowsFailure("ownership_changed", "connection", "not_started", {}, owner);
      if (!current.main_ip) throw windowsFailure("helper_failed", "connection", "not_started", {}, owner);
      if (access.host !== current.main_ip) {
        access.host = current.main_ip; await context.beforeEffect(); await atomicPrivate(vaultPath(context.epoch), access);
      }
    }
    const credential = account(access, principal);
    try {
      const result: unknown = JSON.parse(await command([python, join(import.meta.dir, "windows-winrm.py")], {
        beforeSpawn: context.assertEffect,
        input: JSON.stringify({ host: access.host, username: credential.account, password: credential.password, script, input, upload, uploadStep,
          readOnly: !mutation, observeTransport: transportProbe !== undefined }),
        timeoutMs: windowsRemaining(started, started + timeoutMs, performance.now(), owner, "not_started"), allowedExitCodes: [0, 1], ...(transportProbe === undefined ? {} : { transportProbe }),
        ...(owner === undefined ? {} : { execution: owner }),
      }));
      return windowsWinrmResult(result, !mutation, owner, upload !== undefined);
    } catch (error) {
      if (error instanceof WindowsCommandFailure) {
        throw classifyWindowsCommandFailure(error, !mutation, object(input) && input.action === "transport", owner);
      }
      if (error instanceof QualificationFailure && ["deadline_exceeded", "ownership_changed"].includes(error.evidence.reason)) throw error;
      try { assertWindowsExecution(owner, mutation ? "unknown" : "read_only"); }
      catch (expiry) { throw retainWindowsCause(expiry, error); }
      if (error instanceof QualificationFailure) throw error;
      throw windowsFailure("helper_failed", "output", mutation ? "unknown" : "read_only", {}, owner, 0, { cause: error });
    }
  };
  const ps = async (context: WindowsContext, action: string, extra: Record<string, unknown> = {}, timeoutMs?: number, principal: WindowsPrincipal = "administrator") => {
    const access = await loadAccess(context.epoch);
    // The standard account has its own gateway state; it reaches the pinned OMP build only for doctor's version probe.
    const identity = principal === "administrator"
      ? { configDigest: access.configDigest, credentialDigest: access.credentialDigest, ompPath: access.ompPath, ompPid: access.ompPid }
      : { configDigest: access.standardConfigDigest, credentialDigest: access.standardCredentialDigest, ompPath: access.ompPath, principal, account: account(access, principal).account };
    const readOnly = ["transport", "prelogin", "state", "ready", "interactive", "publication", "fingerprint", "identity", "doctor", "inspectPredecessor"].includes(action);
    const execute = (budget?: number) => winrm(context, guestScript, { origin: access.origin, ...identity, ...extra, action, epoch: context.epoch, pins,
        candidateVersion: releaseVersion(context.identity.candidate.tag), previousVersion: releaseVersion(context.identity.predecessor.tag),
        login: environment.OMP_STABLE_WINDOWS_LOGIN ?? "alphastorm@github" }, budget ?? timeoutMs, undefined, !readOnly, principal,
        action === "transport" ? context.transportProbe : undefined);
    if (!readOnly) return context.mutation(`ps:${principal}:${action}`, execute);
    return action !== "transport" ? reconnectWindowsTransport(execute,
      { now: performance.now, sleep: Bun.sleep }, context.execution ?? execution) : execute();
  };
  const upload = async (context: WindowsContext, local: string, name: "candidate.tar" | "predecessor.tar" | "source.tar") => {
    const expected = digest(await readFile(local));
    const destinationPath = `C:\\omp-winqual-${context.epoch}\\${name}`;
    const inspect = async () => {
      const found = await reconnectWindowsTransport(budget => winrm(context, `param($p)
$exists = Test-Path -LiteralPath $p.path
$matches = $false; $ended = $false
if ($exists) {
  try {
    $file = [IO.File]::Open($p.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
      $hash = [Security.Cryptography.SHA256]::Create()
      try { $matches = ([BitConverter]::ToString($hash.ComputeHash($file))).Replace('-', '').ToLowerInvariant() -eq $p.digest }
      finally { $hash.Dispose() }
      $ended = $true
    } finally { $file.Dispose() }
  } catch [IO.IOException] { }
}
@{ exists=$exists; matches=$matches; writerEnded=$ended } | ConvertTo-Json -Compress`,
      { path: destinationPath, digest: expected }, budget, undefined, false, "administrator", undefined, "existence/hash"),
      { now: performance.now, sleep: Bun.sleep }, context.execution ?? execution);
      if (typeof found.exists !== "boolean" || typeof found.matches !== "boolean" || typeof found.writerEnded !== "boolean") {
        throw windowsFailure("helper_failed", "upload", "read_only", {}, context.execution);
      }
      return { exists: found.exists, matches: found.matches, writerEnded: found.writerEnded };
    };
    const remove = async () => {
      await context.beforeEffect();
      return windowsUploadStep("remove", step => winrm(context, "param($p)\nRemove-Item -LiteralPath $p.path -Force\n'{\"removed\":true}'",
        { path: destinationPath }, undefined, undefined, true, "administrator", undefined, step));
    };
    await windowsUploadOnce({
      allowFresh: context.freshStaging === true,
      state: async () => (await loadAccess(context.epoch)).uploads?.[name],
      checkpoint: async state => {
        await context.beforeEffect();
        const access = await loadAccess(context.epoch);
        await atomicPrivate(vaultPath(context.epoch), { ...access, uploads: { ...access.uploads, [name]: state } });
      },
      verify: async () => { const found = await inspect(); return found.matches && found.writerEnded; },
      upload: async () => {
        const found = await inspect();
        if (found.matches && found.writerEnded) return;
        if (found.exists) {
          if (!found.writerEnded) throw windowsFailure("mutation_unconfirmed", "upload", "unknown", {}, context.execution);
          await remove();
        }
        await context.beforeEffect();
        await reconcileWindowsUpload({ inspect, remove,
          stream: () => windowsUploadStep("stream", step => winrm(context, "", undefined, 900_000, { sourcePath: local, destinationPath }, true, "administrator", undefined, step)),
        }, context.execution ?? execution);
      },
    }, context.execution ?? execution);
  };
  const restorePixel = async (context: WindowsContext) => {
    const owner = context.execution ?? execution;
    const access = await existingAccess(context.epoch);
    const baseline = access?.pixelState;
    if (!access) throw Object.assign(new Error("Windows Pixel recovery state is missing"), { pixelUnrestored: true });
    if (!baseline) return;
    try {
    const serial = await requireSingleDevice();
    if (serial !== baseline.serial) throw new Error("Pixel changed during Windows attempt");
    await context.beforeEffect();
    await withAndroidChrome(async driver => {
      assertWindowsExecution(context.execution ?? execution);
      const targets = await driver.send("Target.getTargets");
      for (const target of (targets.targetInfos ?? []) as Array<{ targetId: string; type: string; url: string }>) {
        if (target.type === "page" && target.url.startsWith(`${access.origin}/`)) {
          assertWindowsExecution(context.execution ?? execution); await driver.send("Target.closeTarget", { targetId: target.targetId });
        }
      }
    }, owner === undefined ? {} : { execution: owner });
    await context.beforeEffect();
    await runAdb(serial, ["shell", "monkey", "-p", baseline.launcherPackage, "-c", baseline.launcherCategory, "1"], { timeoutMs: 30_000 });
    if (baseline.keyguard || baseline.wakefulness !== "Awake") {
      await context.beforeEffect(); await runAdb(serial, ["shell", "input", "keyevent", "223"], { timeoutMs: 120_000 });
      if (baseline.wakefulness === "Awake") {
        await context.beforeEffect(); await runAdb(serial, ["shell", "input", "keyevent", "224"], { timeoutMs: 120_000 });
      }
    }
    const restoredKeyguard = parseKeyguardShowing(await runAdb(serial, ["shell", "dumpsys", "window"], { timeoutMs: 120_000 }));
    const power = await runAdb(serial, ["shell", "dumpsys", "power"], { timeoutMs: 120_000 });
    const awake = /mWakefulness=Awake/u.test(power);
    if (restoredKeyguard !== baseline.keyguard || awake !== (baseline.wakefulness === "Awake")) throw new Error("Pixel display baseline restoration failed");
    const activities = await runAdb(serial, ["shell", "dumpsys", "activity", "activities"], { timeoutMs: 120_000 });
    const component = windowsPixelForeground(activities);
    if (component !== baseline.component) throw new Error("Pixel foreground baseline restoration failed");
    delete access.pixelState; await atomicPrivate(vaultPath(context.epoch), access);
    } catch (error) {
      throw Object.assign(error instanceof QualificationFailure || error instanceof AggregateError ? error :
        new Error("Windows Pixel baseline restoration failed", { cause: error }), { pixelUnrestored: true });
    }
  };
  return {
    development: options.development === true, environment, provider, now: Date.now, sleep: Bun.sleep, uuid: randomUUID,
    setExecution: owner => { execution = owner; },
    async admit(input: WindowsPreflightInput): Promise<WindowsAdmission> {
      if (process.platform !== "darwin" || Bun.version !== pins.bunVersion) throw new Error("Windows controller requires macOS and pinned Bun");
      activeTag = input.identity?.tag ?? "preflight";
      const external = await readProvider((signal) => {
        assertWindowsExecution(execution);
        return fetch("https://api.ipify.org", { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      }, execution ?? {});
      egress = (await external.text()).trim();
      if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(egress) || egress.split(".").some(part => Number(part) > 255)) throw new Error("operator IPv4 egress unavailable");
      if (environment.OMP_STABLE_WINDOWS_OPERATOR_CIDR && environment.OMP_STABLE_WINDOWS_OPERATOR_CIDR !== `${egress}/32`) throw new Error("operator egress no longer matches admitted /32");
      const instances = await provider.instances(); const groups = await provider.firewalls();
      const ownLabel = input.epoch && options.development ? windowsCampaignLabel(input.epoch) : undefined;
      if (instances.some(item => item.label?.startsWith(QUAL_LABEL_PREFIX) && item.label !== ownLabel) || groups.some(item => item.description?.startsWith(QUAL_LABEL_PREFIX) && item.description !== ownLabel)) throw new Error("unreconciled Windows qualification resources exist");
      environment.OMP_QUAL_PROTECTED_INSTANCES = [...new Set([...(environment.OMP_QUAL_PROTECTED_INSTANCES ?? "").split(",").filter(Boolean), ...instances.filter(item => item.label !== ownLabel).map(item => item.id)])].join(",");
      environment.OMP_QUAL_PROTECTED_FIREWALLS = [...new Set([...(environment.OMP_QUAL_PROTECTED_FIREWALLS ?? "").split(",").filter(Boolean), ...groups.filter(item => item.description !== ownLabel).map(item => item.id)])].join(",");
      const os = await list<{ id: number; name: string }>("os", "os");
      if (!os.some(item => item.id === pins.osId && item.name === pins.osName)) throw new Error("pinned Windows image unavailable");
      const availability = await api<{ available_plans: string[] }>(`regions/${pins.region}/availability`);
      if (!availability?.available_plans.includes(pins.plan)) throw new Error("pinned Vultr plan unavailable");
      if ((await hostCommand([python, "-c", "import importlib.metadata; print(importlib.metadata.version('pywinrm'))"])) !== pins.pywinrmVersion) throw new Error("pywinrm version mismatch");
      const rdpHelp = await hostCommand(["sdl-freerdp", "/help"]);
      if (!rdpHelp.includes("/from-stdin") || !rdpHelp.includes("fingerprint:<hash>")) throw new Error("FreeRDP pin/stdin support missing");
      const rdpVersion = await hostCommand(["sdl-freerdp", "/version"]);
      if (!rdpVersion.includes(`version ${pins.freerdpVersion} `)) throw new Error("FreeRDP version mismatch");
      await requireSingleDevice(); // Read-only device enumeration; navigation is behind pixel().
      const tailnet = await request<{ devices: unknown[] }>("https://api.tailscale.com/api/v2/tailnet/-/devices", tsHeaders, "GET", undefined, execution);
      if (!tailnet || !Array.isArray(tailnet.devices)) throw new Error("qualification tailnet admission failed");
      if (input.identity) for (const artifact of [input.identity.candidate, input.identity.predecessor]) {
        const info = await lstat(artifact.archivePath);
        if (!info.isFile() || info.isSymbolicLink() || digest(await readFile(artifact.archivePath)) !== artifact.archiveSha256) throw new Error("verified gateway archive changed or is not a regular file");
      }
      let creations = 0;
      try { creations = JSON.parse(await privateFile(join(devRoot, `creations-${activeTag}.json`))) as number; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const limit = options.development ? 6 : 4;
      const localCreationAllowance = windowsCreationAllowance(creations, limit, execution);
      return { admitted: true, protectionVerified: true, toolchainVerified: true,
        localCreationAllowance, providerQuotaObservable: false };
    },
    async saveAccess(epoch, instance) {
      if (!instance.default_password) throw new Error("create response lacks guest access; destroy required");
      await atomicPrivate(vaultPath(epoch), { ...await existingAccess(epoch), instance: instance.id, host: instance.main_ip ?? "", password: instance.default_password });
    },
    async removeAccess(epoch) { await rm(vaultPath(epoch), { force: true }); },
    async hasAccess(epoch) { return windowsGuestAccessAvailable(await existingAccess(epoch)); },
    async transportAdmission(epoch) { return windowsTransportStability((await existingAccess(epoch))?.transportAdmission); },
    async cleanupInstance(epoch) {
      const access = await existingAccess(epoch);
      if (!access?.instance) return undefined;
      const instance = await provider.instance(access.instance);
      if (instance && instance.id !== access.instance) throw windowsFailure("ownership_changed", "connection", "not_started");
      return instance;
    },
    async cleanupFirewall(epoch) {
      const access = await existingAccess(epoch);
      if (!access?.firewall) return undefined;
      const firewall = await provider.firewall(access.firewall);
      if (firewall && firewall.id !== access.firewall) throw windowsFailure("ownership_changed", "connection", "not_started");
      return firewall;
    },
    async guest(context, action, principal = "administrator") {
      const access = await loadAccess(context.epoch);
      const save = async (changes: Record<string, unknown>) => atomicPrivate(vaultPath(context.epoch), { ...await loadAccess(context.epoch), ...changes });
      if (action === "prepareStandardUser") {
        // The account derives from the epoch and its password stays in the vault, so a resumed attempt reconciles the same account.
        const standardUser = access.standardUser ?? { account: `ompstd${context.epoch.replaceAll("-", "").slice(0, 8)}`, password: `Omp!${randomBytes(18).toString("base64url")}7a` };
        if (!access.standardUser) { await context.beforeEffect(); await save({ standardUser }); }
        await context.beforeEffect();
        return ps(context, "createStandardUser", { account: standardUser.account, accountSecret: standardUser.password });
      }
      if (action === "join") {
        await context.beforeEffect(); const joined = await ps(context, "join", { joinValue }, 300_000, principal);
        // A new node answers under the name the deleted one had; take its identity from the join, never from the vault.
        await save({ origin: joined.origin, machine: joined.machine });
        return { taggedNode: joined.taggedNode, tunMode: joined.tunMode, funnelOff: joined.funnelOff };
      }
      if (action === "installFresh") {
        await context.beforeEffect(); const installed = await ps(context, "installFresh", {}, 300_000, principal);
        await save({ standardConfigDigest: installed.configDigest, standardCredentialDigest: installed.credentialDigest });
        return { ready: installed.ready };
      }
      if (action === "reconnect") {
        // Cleanup never restarts the allocation/stability window.
        if (!windowsGuestAccessAvailable(access)) throw windowsFailure("helper_failed", "connection", "not_started", {}, context.execution);
        const fresh = await provider.instance(access.instance);
        if (!fresh || fresh.id !== access.instance || fresh.label !== windowsCampaignLabel(context.epoch) ||
          fresh.os_id !== pins.osId || fresh.plan !== pins.plan || fresh.region !== pins.region ||
          !instanceEligibility(fresh.id, fresh.label, environment).eligible) {
          throw windowsFailure("ownership_changed", "connection", "not_started", {}, context.execution);
        }
        if (!fresh.main_ip) throw windowsFailure("helper_failed", "connection", "not_started", {}, context.execution);
        await context.beforeEffect(); await save({ host: fresh.main_ip });
        return reconnectWindowsTransport(timeoutMs => ps(context, "transport", {}, timeoutMs),
          { now: performance.now, sleep: Bun.sleep }, context.execution ?? execution);
      }
      if (action === "transport") {
        const admitted = windowsTransportStability(context.transportAdmission) ?? windowsTransportStability(access.transportAdmission);
        if (admitted) {
          const current = await reconnectWindowsTransport(timeoutMs => ps(context, "transport", {}, timeoutMs),
            { now: performance.now, sleep: Bun.sleep }, context.execution ?? execution);
          return { ...current, ...admitted };
        }
        if (context.allocationDeadline === undefined) throw windowsFailure("helper_failed", "connection", "not_started", {}, context.execution);
        const remaining = windowsRemaining(context.allocationDeadline - 12 * 60_000, context.allocationDeadline, Date.now(), context.execution ?? execution);
        const started = performance.now(), deadline = started + remaining;
        // Creation can return a provisional address. Wait for provider allocation,
        // then authenticate the guest at that freshly observed address.
        await pollWindows(async () => {
          const current = (await provider.instances()).find(item => item.id === access.instance);
          if (!current || current.label !== windowsCampaignLabel(context.epoch) || current.os_id !== pins.osId || current.plan !== pins.plan || current.region !== pins.region || !instanceEligibility(current.id, current.label, environment).eligible) throw windowsFailure("ownership_changed", "connection", "not_started", {}, context.execution);
          if (current.status !== "active" || current.server_status !== "ok" || current.power_status !== "running" || !current.main_ip) return false;
          await context.beforeEffect(); await save({ host: current.main_ip });
          return true;
        }, windowsRemaining(started, deadline, performance.now(), context.execution ?? execution), "provider Windows allocation", context.execution ?? execution);
        const observed = await waitForStableWindowsTransport(
          timeoutMs => ps(context, "transport", {}, timeoutMs),
          { now: performance.now, sleep: Bun.sleep }, deadline, context.execution ?? execution,
        );
        await context.beforeEffect(); await save({ transportAdmission: windowsTransportStability(observed) });
        return observed;
      }
      if (action === "stage") {
        if (access.toolsReady !== true) {
          await context.beforeEffect(); await ps(context, "stage", {}, 600_000); await save({ toolsReady: true });
        }
        const sourceDir = join(devRoot, "source");
        try { await lstat(join(sourceDir, "HEAD")); }
        catch { await context.beforeEffect(); await hostCommand(["git", "clone", "--bare", "--filter=blob:none", "https://github.com/can1357/oh-my-pi.git", sourceDir], { timeoutMs: 600_000 }); }
        await context.beforeEffect(); await hostCommand(["git", "--git-dir", sourceDir, "fetch", "origin", pins.omp.sourceCommit], { timeoutMs: 300_000 });
        const commit = await hostCommand(["git", "--git-dir", sourceDir, "rev-parse", `${pins.omp.sourceCommit}^{commit}`]);
        const tree = await hostCommand(["git", "--git-dir", sourceDir, "rev-parse", `${commit}^{tree}`]);
        if (commit !== pins.omp.sourceCommit || tree !== pins.omp.sourceTree) throw new Error("locked OMP source identity mismatch");
        const archive = join(devRoot, "source.tar.gz");
        await context.beforeEffect(); await hostCommand(["git", "--git-dir", sourceDir, "archive", "--format=tar.gz", "--prefix=source/", `--output=${archive}`, commit], { timeoutMs: 300_000 });
        await upload(context, context.identity.candidate.archivePath, "candidate.tar");
        await upload(context, context.identity.predecessor.archivePath, "predecessor.tar");
        await upload(context, archive, "source.tar");
        if (access.unpacked !== true) {
          await context.beforeEffect(); await ps(context, "unpack", { candidate: context.identity.candidate.archiveSha256, predecessor: context.identity.predecessor.archiveSha256, source: digest(await readFile(archive)) });
          await save({ unpacked: true });
        }
        await context.beforeEffect(); const joined = await ps(context, "join", { joinValue }, 300_000);
        await save({ origin: joined.origin, machine: joined.machine });
        if (!access.ompPath) {
          await context.beforeEffect(); const built = await ps(context, "build", {}, 1_200_000); await save(built);
        }
        return { taggedNode: joined.taggedNode, tunMode: joined.tunMode, funnelOff: joined.funnelOff };
      }
      if (action === "reboot") {
        await context.beforeEffect(); const result = await ps(context, "reboot");
        await Bun.sleep(20_000);
        return result;
      }
      if (action === "publish") {
        if (!access.ompPath) throw new Error("owned OMP build is absent");
        const inherited = await winrm(context, `@{ SystemRoot=$env:SystemRoot; SystemDrive=$env:SystemDrive; windir=$env:windir; ComSpec=$env:ComSpec; PATHEXT=$env:PATHEXT; PROCESSOR_ARCHITECTURE=$env:PROCESSOR_ARCHITECTURE; NUMBER_OF_PROCESSORS=$env:NUMBER_OF_PROCESSORS; PATH=$env:PATH; USERPROFILE=$env:USERPROFILE; HOME=$env:USERPROFILE; TEMP=$env:TEMP; TMP=$env:TMP; APPDATA=$env:APPDATA; LOCALAPPDATA=$env:LOCALAPPDATA } | ConvertTo-Json -Compress`, undefined, undefined, undefined, false);
        const environment = { ...inherited, ...OMP_FIXTURE_ENV } as Record<string, string>;
        const script = windowsHostScript(access.ompPath, OMP_FIXTURE_ARGS, `C:\\omp-winqual-${context.epoch}\\${sessionLabel}`, environment);
        await context.beforeEffect();
        const started = await ps(context, "startOmp", { launcher: script });
        await save({ ompPid: started.ompPid });
        assertWindowsExecution(context.execution ?? execution);
        const session = await waitForPublishedSession(String(access.origin), sessionLabel);
        const publication = await ps(context, "publication");
        return { namedPipe: publication.namedPipe, generation: session.generation };
      }
      if (action === "launch") {
        assertWindowsExecution(context.execution ?? execution);
        const session = await waitForPublishedSession(String(access.origin), sessionLabel);
        await verifyWindowsLaunchContracts(String(access.origin), session, fetch, context.execution ?? execution, () => context.assertEffect());
        return { viewStatus: 200, controlStatus: 200, noStore: true, ...await verifyWindowsStaleLaunch(String(access.origin), session, fetch, context.execution ?? execution, () => context.assertEffect()) };
      }
      if (action === "revoked") { assertWindowsExecution(context.execution ?? execution); await waitForRevocation(String(access.origin), sessionLabel); return { revoked: true }; }
      await context.beforeEffect(); const result = await ps(context, action, {}, undefined, principal);
      // The guest's post-mutation status window is observed, not silent: record every read past the first.
      if (typeof result.statusReads === "number" && result.statusReads > 1) console.log(`Windows ${action}: status settled after ${result.statusReads} reads`);
      if (principal === "standard" && action === "rotate") await save({ standardCredentialDigest: result.credentialDigest });
      else if (action === "installPredecessor" || action === "rotate") await save({ configDigest: result.configDigest ?? access.configDigest, credentialDigest: result.credentialDigest });
      return result;
    },
    async rdp(context, principal = "administrator") {
      const access = await loadAccess(context.epoch);
      const credential = account(access, principal);
      const cert = await ps(context, "fingerprint");
      if (typeof cert.fingerprint !== "string" || !SHA.test(cert.fingerprint)) throw new Error("RDP certificate SHA-256 unavailable");
      await context.beforeEffect();
      context.assertEffect();
      const child = Bun.spawn(["sdl-freerdp", `/v:${access.host}`, `/u:${credential.account}`, "/from-stdin:force", `/cert:fingerprint:sha256:${cert.fingerprint}`, "/size:800x600", "/log-level:OFF"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      // A new account's first logon builds its profile before Explorer starts, which the provider's Administrator never waits for.
      const session = principal === "administrator" ? {} : { account: credential.account };
      await settleWindowsRdp(child, `${credential.password}\n`, () => pollWindows(
        async () => (await ps(context, "interactive", session)).interactive === true, principal === "administrator" ? 120_000 : 240_000,
        "certificate-pinned interactive RDP", context.execution ?? execution), context.execution ?? execution);
    },
    async pixel(context) {
      const access = await loadAccess(context.epoch);
      const serial = await requireSingleDevice();
      const activities = await runAdb(serial, ["shell", "dumpsys", "activity", "activities"], { timeoutMs: 120_000 });
      const component = windowsPixelForeground(activities);
      const power = await runAdb(serial, ["shell", "dumpsys", "power"], { timeoutMs: 120_000 });
      const wakefulness = /mWakefulness=(Awake|Asleep|Dozing|Dreaming)/u.exec(power)?.[1];
      const keyguard = parseKeyguardShowing(await runAdb(serial, ["shell", "dumpsys", "window"], { timeoutMs: 120_000 }));
      if (!component || !wakefulness) throw new Error("Pixel baseline is incomplete");
      const launcher = windowsPixelLauncher(activities, component);
      if ((await runAdb(undefined, ["forward", "--list"], { timeoutMs: 120_000 })).includes("tcp:9222")) throw new Error("Pixel debugging port already has an owner");
      await context.beforeEffect(); await atomicPrivate(vaultPath(context.epoch), { ...access, pixelState: { serial, component, launcherPackage: launcher.packageName, launcherCategory: launcher.category, wakefulness, keyguard } });
      let result: Record<string, unknown> | undefined;
      let primary: unknown;
      try {
        assertWindowsExecution(context.execution ?? execution);
        const owner = context.execution ?? execution;
        assertWindowsPixelDispatch(context);
        const smoke = await runAndroidCollabSmoke({ origin: String(access.origin), label: sessionLabel, allowDisposableTarget: true,
          ...(owner === undefined ? {} : { execution: owner }) });
        // Serve must supply the user identity for this exact-login, production-mode gateway.
        result = { pixelIdentityAccepted: true, viewReadOnly: smoke.viewReadOnly, controlWritable: smoke.controlWritable, promptAccepted: smoke.promptAccepted, returnedToDirectory: smoke.returnedToDirectory };
      } catch (error) {
        primary = error instanceof QualificationFailure || error instanceof AggregateError || pixelUnrestored(error) ? error :
          new Error("Windows physical client failed", { cause: error });
      }
      try { await restorePixel(context); }
      catch (error) {
        if (primary) throw Object.assign(new AggregateError([primary, error], "Windows Pixel and restoration failed"), { pixelUnrestored: true });
        throw error;
      }
      if (primary) throw primary;
      if (!result) throw new Error("Windows Pixel produced no observation");
      return result;
    },
    restorePixel,
    async deleteTailnet(context) {
      const owner = context.execution ?? execution;
      const listing = await request<{ devices: Array<{ id: string; hostname: string }> }>("https://api.tailscale.com/api/v2/tailnet/-/devices", tsHeaders, "GET", undefined, owner);
      if (!listing) throw new Error("tailnet listing failed");
      const matches = listing.devices.filter(item => item.hostname === windowsCampaignLabel(context.epoch));
      for (const match of matches) {
        const fresh = await confirmAbsence(() => request<{ id: string; hostname: string }>(`https://api.tailscale.com/api/v2/device/${encodeURIComponent(match.id)}`, tsHeaders, "GET", undefined, owner), owner ?? {});
        if (!fresh) continue;
        if (fresh.hostname !== windowsCampaignLabel(context.epoch)) throw new Error("tailnet ownership changed");
        await context.beforeEffect(); await request(`https://api.tailscale.com/api/v2/device/${encodeURIComponent(match.id)}`, tsHeaders, "DELETE", undefined, owner);
      }
      const after = await request<{ devices: Array<{ hostname: string }> }>("https://api.tailscale.com/api/v2/tailnet/-/devices", tsHeaders, "GET", undefined, owner);
      if (!after || after.devices.some(item => item.hostname === windowsCampaignLabel(context.epoch))) throw new Error("tailnet node remains");
    },
  };
}

/** The campaign's own release verification, so the probe installs exactly the bytes a campaign would. */
async function verifiedDevelopmentArtifact(tag: string, stable: boolean, ghToken: string): Promise<WindowsArtifact> {
  const directory = join(devRoot, "assets", tag);
  const release = await verifyRelease(tag, directory, stable, ghToken);
  const archivePath = releaseArchivePath(directory, tag);
  await chmod(directory, 0o700); await chmod(archivePath, 0o600);
  return { tag, sourceCommit: release.sourceCommit, archivePath, archiveSha256: release.archiveSha256 };
}

/** Retire the old epoch even when only vault removal remains after durable containment. */
export async function retireWindowsDevelopmentEpoch(input: WindowsLaneInput): Promise<void> {
  if (input.progress === undefined) return;
  if (windowsNeedsCleanup(input.progress)) throw windowsFailure("mutation_unconfirmed", "preflight", "unknown", {}, input.execution);
  await cleanupWindows(input);
}

/** Development lease custody, isolated from credential loading and physical-device operations. */
export function createWindowsDevelopmentPixelLease(options: {
  lock: string; epoch: () => string; recoverExitedOwner: boolean;
  recoveryPending: (epoch: string) => Promise<boolean>;
  clock?: Pick<WindowsRuntime, "now" | "sleep">;
}): WindowsLaneInput["pixel"] {
  const clock = options.clock ?? { now: Date.now, sleep: Bun.sleep };
  let held: { epoch: string; claim: string } | undefined, active = false;
  const releaseRestored = async (epoch: string, claim: string, execution?: WindowsExecutionContext) => {
    if (await options.recoveryPending(epoch)) return;
    if (await readFile(join(options.lock, "owner"), "utf8") !== claim) {
      throw windowsFailure("ownership_changed", "command", "not_started", {}, execution);
    }
    await rm(options.lock, { recursive: true });
    held = undefined;
  };
  return async <T>(caller: string, action: () => Promise<T>, execution?: WindowsExecutionContext): Promise<T> => {
    if (active) throw windowsFailure("helper_failed", "command", "not_started", {}, execution);
    active = true;
    try {
    const lock = options.lock, started = clock.now(), deadline = started + 60 * 60_000;
    const epoch = options.epoch(), monotonicStarted = performance.now();
    const remaining = () => Math.min(windowsRemaining(started, deadline, clock.now(), execution, "not_started"),
      execution === undefined ? Infinity : windowsRemaining(monotonicStarted, execution.deadline, performance.now(), execution, "not_started"));
    let previous: string | undefined, inherited = false, recovered: string | undefined;
    while (true) {
      remaining();
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = await readFile(join(lock, "owner"), "utf8").catch(() => "");
        if (caller === "windows-cleanup" && held?.epoch === epoch && held.claim === owner) {
          previous = owner; inherited = true; break;
        }
        const fields = owner.trim().split(" ");
        if (caller === "windows-cleanup" && options.recoverExitedOwner && fields[0] === "WindowsLane" && fields[2] === epoch && /^\d+$/u.test(fields[3] ?? "")) {
          try { process.kill(Number(fields[3]), 0); }
          catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === "ESRCH") {
              const takeover = `WindowsLane ${new Date().toISOString()} ${epoch} ${process.pid}\n`;
              // Retain this exclusive fence until lock retirement: a delayed stale reader
              // must never unlink a winning cleanup's new owner file.
              const fence = join(lock, `recovery-${createHash("sha256").update(owner).digest("hex").slice(0, 32)}`);
              try { await writeFile(fence, takeover, { flag: "wx", mode: 0o600 }); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                await clock.sleep(Math.min(5_000, remaining())); continue;
              }
              if (await readFile(join(lock, "owner"), "utf8") !== owner) {
                throw windowsFailure("ownership_changed", "command", "not_started", {}, execution);
              }
              await rm(join(lock, "owner"), { force: true });
              try { await writeFile(join(lock, "owner"), takeover, { flag: "wx", mode: 0o600 }); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                await clock.sleep(Math.min(5_000, remaining())); continue;
              }
              recovered = takeover; break;
            }
          }
        }
        await clock.sleep(Math.min(5_000, remaining()));
      }
    }
    if (previous !== undefined && await readFile(join(lock, "owner"), "utf8") !== previous) {
      throw windowsFailure("ownership_changed", "command", "not_started", {}, execution);
    }
    const claim = recovered ?? (inherited ? previous! : `WindowsLane ${new Date().toISOString()} ${epoch} ${process.pid}\n`);
    if (!inherited && recovered === undefined) await writeFile(join(lock, "owner"), claim, { mode: 0o600 });
    held = { epoch, claim };
    let restored = false;
    try {
      remaining();
      const result = await action();
      restored = true;
      if (await options.recoveryPending(epoch)) throw new Error("Pixel restoration incomplete; owned lease retained for cleanup");
      return result;
    } finally {
      if (restored) await releaseRestored(epoch, claim, execution);
    }
    } finally { active = false; }
  };
}

export async function windowsDevelopmentCli(args: readonly string[]): Promise<void> {
  const [mode = "", ...rest] = args;
  const usage = "usage: bun scripts/windows-stable-qualification.ts preflight|cleanup, or artifacts|run --tag vX.Y.Z-prealpha.N";
  if (!["preflight", "artifacts", "run", "cleanup"].includes(mode)) throw new Error(usage);
  // The campaign's tag grammar and published predecessor, without the campaign's Mac configuration: the probe never installs a pair a campaign would not.
  const options = mode === "artifacts" || mode === "run" ? parseCandidateTagArgs(rest, {}) : undefined;
  if ((options === undefined && rest.length > 0) || options?.preflight === true) throw new Error(usage);
  const runtime = await createWindowsRuntime({ development: true });
  if (mode === "preflight") { console.log(JSON.stringify(await preflightWindows({}, runtime))); return; }
  await mkdir(devRoot, { recursive: true, mode: 0o700 }); await chmod(devRoot, 0o700);
  const progressPath = join(devRoot, "progress.json"); const identityPath = join(devRoot, "identity.json");
  let progress: unknown;
  const pixel = createWindowsDevelopmentPixelLease({
    lock: "/tmp/omp-gw-pixel.lock", epoch: () => (progress as { epoch: string }).epoch, recoverExitedOwner: mode === "cleanup",
    recoveryPending: async epoch => Boolean((await existingAccess(epoch))?.pixelState),
  });
  try { progress = JSON.parse(await privateFile(progressPath)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (mode !== "cleanup" && progress !== undefined && !windowsNeedsCleanup(progress)) {
    const priorIdentity = JSON.parse(await privateFile(identityPath)) as WindowsIdentity;
    await retireWindowsDevelopmentEpoch({ identity: priorIdentity, progress, checkpoint, pixel, runtime, execution: windowsContainmentExecution() });
    await rm(progressPath);
    progress = undefined;
  }
  if (mode === "artifacts" && windowsNeedsCleanup(progress)) throw new Error("cannot replace artifact inputs while a Windows attempt needs cleanup");
  let identity: WindowsIdentity;
  if (mode === "cleanup" || windowsNeedsCleanup(progress)) {
    identity = JSON.parse(await privateFile(identityPath)) as WindowsIdentity;
    if (options !== undefined && identity.tag !== options.tag) throw new Error(`the retained attempt belongs to ${identity.tag}; run cleanup before probing ${options.tag}`);
  } else {
    if (options === undefined) throw new Error(usage);
    const ghToken = await command(["gh", "auth", "token"]);
    identity = { tag: options.tag, candidate: await verifiedDevelopmentArtifact(options.tag, false, ghToken),
      predecessor: await verifiedDevelopmentArtifact(options.previousTag, true, ghToken), omp: parseQualificationPins(await readFile(join(root, "UPSTREAM.lock.json"), "utf8")) };
    await atomicPrivate(identityPath, identity); progress = undefined;
  }
  if (mode === "artifacts") {
    console.log(JSON.stringify({ candidate: identity.candidate.tag, predecessor: identity.predecessor.tag, verified: true }));
    return;
  }
  async function checkpoint(next: Record<string, unknown>): Promise<void> { progress = next; await atomicPrivate(progressPath, next); }
  if (mode === "cleanup") { console.log(JSON.stringify(await cleanupWindows({ identity, progress, checkpoint, pixel, runtime, execution: windowsContainmentExecution() }))); return; }
  const result = await runWindows({ identity, progress, checkpoint, pixel, runtime });
  const cleanup = await cleanupWindows({ identity, progress, checkpoint, pixel, runtime, execution: windowsContainmentExecution() });
  const evidence = { claim: "tested-development-only", ...result, cleanup };
  await atomicPrivate(join(devRoot, "evidence.json"), evidence); console.log(JSON.stringify(evidence, null, 2));
}
