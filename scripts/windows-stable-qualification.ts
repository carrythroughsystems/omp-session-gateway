import { createHash } from "node:crypto";
import { createWindowsRuntime, windowsDevelopmentCli, windowsTransportStability } from "./windows-qualification-runtime.ts";
import pins from "./windows-qualification-pins.json";
import upstream from "../UPSTREAM.lock.json";
import type { OmpPins } from "./stable-qualification.ts";
import { firewallEligibility, instanceEligibility, QUAL_LABEL_PREFIX } from "./vultr-target.ts";
import { FAILURE_LIMITS, FAILURE_REASONS, parseLaneFailure, QualificationFailure } from "./qualification-failure.ts";
import type { FailureObservations, LaneStep, OperationDisposition } from "./qualification-failure.ts";
import { pixelUnrestored } from "./restoration.ts";

/** Structurally shared with the orchestrator; cleanup receives its own fresh execution. */
export interface WindowsExecutionContext { readonly signal: AbortSignal; readonly deadline: number; readonly nextFailureId: () => number }
let standaloneFailureId = 0;
export function windowsFailure(reason: keyof typeof FAILURE_REASONS.windows, step: LaneStep<"windows">,
  operation: OperationDisposition, observations: FailureObservations = {}, execution?: WindowsExecutionContext, elapsedMs = 0): QualificationFailure {
  return new QualificationFailure(parseLaneFailure({ id: execution?.nextFailureId() ?? ++standaloneFailureId,
    lane: "windows", step, reason, class: FAILURE_REASONS.windows[reason], operation, observations, elapsedMs }));
}
export function assertWindowsExecution(execution?: WindowsExecutionContext, operation: OperationDisposition = "not_started"): void {
  if (execution === undefined) return;
  const expired = performance.now() >= execution.deadline;
  if (execution.signal.aborted || expired) {
    throw windowsFailure("deadline_exceeded", "command", operation, { controllerDeadline: expired }, execution);
  }
}
/** One snapshot decides whether any positive millisecond of this local budget remains. */
export function windowsRemaining(started: number, deadline: number, now: number, execution?: WindowsExecutionContext,
  operation: OperationDisposition = "read_only"): number {
  assertWindowsExecution(execution, operation);
  const remaining = Math.floor(deadline - now);
  if (remaining <= 0) {
    const elapsedMs = Math.min(FAILURE_LIMITS.elapsedMs, Math.max(0, now - started));
    const waitedMs = Math.floor(elapsedMs);
    const timeoutMs = Math.min(FAILURE_LIMITS.elapsedMs, Math.max(0, Math.floor(deadline - started)));
    throw windowsFailure("deadline_exceeded", operation === "not_started" ? "command" : "connection", operation,
      { controllerDeadline: true, readOnlyProbe: operation === "read_only", timeoutMs, waitedMs }, execution, elapsedMs);
  }
  return remaining;
}
/** No await may separate this guard from a provider allocation or rule POST. */
export function assertWindowsAllocation(execution: WindowsExecutionContext | undefined, allocationDeadline: number | undefined, now = Date.now()): void {
  if (allocationDeadline === undefined || !Number.isFinite(allocationDeadline)) throw windowsFailure("helper_failed", "command", "not_started", {}, execution);
  windowsRemaining(allocationDeadline - 12 * 60_000, allocationDeadline, now, execution, "not_started");
}

export interface WindowsArtifact {
  readonly tag: string;
  readonly sourceCommit: string;
  readonly archiveSha256: string;
  readonly archivePath: string;
}
export interface WindowsIdentity {
  readonly tag: string;
  readonly candidate: WindowsArtifact;
  readonly predecessor: WindowsArtifact;
  readonly omp: OmpPins;
}
export interface WindowsPreflightInput { readonly identity?: WindowsIdentity; readonly epoch?: string }
export interface WindowsAdmission extends Record<string, unknown> {
  readonly admitted: true;
  readonly protectionVerified: true;
  readonly toolchainVerified: true;
}
export interface WindowsInstance {
  readonly id: string;
  readonly label?: string;
  readonly os_id: number;
  readonly region: string;
  readonly plan: string;
  readonly main_ip?: string;
  readonly default_password?: string;
  readonly status?: string;
  readonly server_status?: string;
  readonly power_status?: string;
}
export interface WindowsFirewall { readonly id: string; readonly description?: string }
export interface WindowsTransportProbe {
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly firstResponseLatencyMs: number | null;
  readonly signalAt: number | null;
  readonly exitedAt: number | null;
  readonly exitCode: number | null;
  readonly killAt?: number | null;
  readonly controllerDeadline?: boolean;
}
export interface WindowsProvider {
  instances(): Promise<WindowsInstance[]>;
  firewalls(): Promise<WindowsFirewall[]>;
  instance(id: string): Promise<WindowsInstance | undefined>;
  firewall(id: string): Promise<WindowsFirewall | undefined>;
  createFirewall(label: string, execution?: WindowsExecutionContext, allocationDeadline?: number): Promise<WindowsFirewall>;
  configureFirewall(id: string, label: string, execution?: WindowsExecutionContext, allocationDeadline?: number): Promise<void>;
  createInstance(label: string, firewall: string, execution?: WindowsExecutionContext, allocationDeadline?: number): Promise<WindowsInstance>;
  destroyInstance(id: string, label: string): Promise<void>;
  destroyFirewall(id: string, label: string): Promise<void>;
}
export interface WindowsContext {
  readonly epoch: string;
  readonly identity: WindowsIdentity;
  /** No await may separate this resource/execution admission from guest dispatch. */
  readonly assertEffect: () => void;
  readonly beforeEffect: () => Promise<void>;
  /** Durable single-shot claims for qualification; cleanup supplies its idempotent owner. */
  readonly mutation: <T>(key: string, action: () => Promise<T>) => Promise<T>;
  /** Epoch milliseconds in runtime.now()'s clock, shared by creation and admission. */
  readonly allocationDeadline?: number | undefined;
  readonly transportAdmission?: { transportStabilitySamples: number; transportStabilityDurationMs: number } | undefined;
  readonly transportProbe?: (probe: WindowsTransportProbe) => Promise<void>;
  readonly execution?: WindowsExecutionContext;
  /** True only when this invocation enters staging for the first time in this epoch. */
  readonly freshStaging?: boolean;
}
export type WindowsGuestAction = "transport" | "reconnect" | "stage" | "installPredecessor" | "upgrade" | "doctor" | "reboot" |
  "prelogin" | "ready" | "publish" | "launch" | "stopOmp" | "revoked" | "rotate" | "rollback" | "restore" |
  "uninstall" | "resetServe" | "logout" | "prepareStandardUser" | "identity" | "releaseTailnet" | "join" | "installFresh" | "state";
/** The Windows account a guest action or RDP logon runs as. */
export type WindowsPrincipal = "administrator" | "standard";
export interface WindowsRuntime {
  setExecution?(execution?: WindowsExecutionContext): void;
  /** Development CLI only: retain a healthy guest for immediate repair inside its lease. */
  readonly development?: boolean;
  setExecution?(execution: WindowsExecutionContext | undefined): void;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly provider: WindowsProvider;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly uuid: () => string;
  admit(input: WindowsPreflightInput): Promise<WindowsAdmission>;
  saveAccess(epoch: string, instance: WindowsInstance): Promise<void>;
  removeAccess(epoch: string): Promise<void>;
  hasAccess?(epoch: string): Promise<boolean>;
  transportAdmission?(epoch: string): Promise<Record<string, unknown> | undefined>;
  /** Refetch the vault-bound ID even if the provider changed its label. */
  cleanupInstance?(epoch: string): Promise<WindowsInstance | undefined>;
  cleanupFirewall?(epoch: string): Promise<WindowsFirewall | undefined>;
  guest(context: WindowsContext, action: WindowsGuestAction, principal?: WindowsPrincipal): Promise<Record<string, unknown>>;
  rdp(context: WindowsContext, principal?: WindowsPrincipal): Promise<void>;
  pixel(context: WindowsContext): Promise<Record<string, unknown>>;
  restorePixel(context: WindowsContext): Promise<void>;
  deleteTailnet(context: WindowsContext): Promise<void>;
}
const PHASES = ["intent_checkpointed", "firewall_created", "instance_created", "transport_ready", "toolchain_staged",
  "predecessor_installed", "candidate_upgraded", "reboot_requested", "prelogin_verified", "postlogin_ready",
  "doctor_passed", "omp_published", "pixel_verified", "omp_revoked", "readiness_rotated", "predecessor_restored",
  "candidate_restored", "candidate_uninstalled", "standard_user_prepared", "standard_tailnet_released",
  "standard_tailnet_joined", "standard_interactive_ready", "standard_candidate_installed", "standard_reboot_requested",
  "standard_prelogin_verified", "standard_postlogin_ready", "standard_doctor_passed", "standard_readiness_rotated",
  "standard_candidate_uninstalled", "evidence_complete"] as const;
type Phase = typeof PHASES[number];
const READ_ONLY_PHASES: readonly Phase[] = ["transport_ready", "prelogin_verified", "doctor_passed", "standard_prelogin_verified", "standard_doctor_passed", "evidence_complete"];
const GUEST_MUTATIONS: readonly WindowsGuestAction[] = ["stage", "installPredecessor", "upgrade", "reboot", "publish", "stopOmp",
  "rotate", "rollback", "restore", "uninstall", "resetServe", "logout", "prepareStandardUser", "releaseTailnet", "join", "installFresh"];
const MUTATION_ACTIONS: readonly string[] = [...GUEST_MUTATIONS, "createStandardUser", "unpack", "build", "startOmp", "logon"];
const FACTS = ["preloginSamples", "preloginDurationMs", "automaticStartMs", "doctorChecks", "namedPipe", "generation",
  "viewStatus", "controlStatus", "staleViewStatus", "staleControlStatus", "noStore", "taggedNode", "tunMode", "funnelOff",
  "loopbackOnly", "pixelIdentityAccepted", "viewReadOnly", "controlWritable", "promptAccepted", "returnedToDirectory",
  "configPreserved", "readinessPreserved", "readinessChanged", "historySelected", "restored", "uninstalled", "revoked",
  "windowsBuild", "cpus", "memoryMiB", "failedPhaseAttempts", "doctorTrue", "doctorIdentityAllowed", "doctorPwa",
  "doctorSessionHealth", "doctorPublisherHealth", "doctorSecurityHeaders", "logonTrigger", "interactivePrincipal",
  "transportStabilitySamples", "transportStabilityDurationMs", "logonTriggerScoped", "standardUserNonAdmin",
  "standardUserNoSecurityPrivilege", "standardPreloginSamples", "standardPreloginDurationMs", "standardAutomaticStartMs",
  "standardDoctorChecks", "standardDoctorTrue", "standardReadinessChanged", "standardUninstalled",
  "standardConfigPreserved", "standardReadinessPreserved"] as const;
interface Progress extends Record<string, unknown> {
  schemaVersion: 1;
  lane: "windows";
  epoch: string;
  binding: string;
  phase: Phase;
  settled: boolean;
  cleanupRequired: boolean;
  startedAt: number;
  timings: Partial<Record<Phase, number>>;
  facts: Partial<Record<typeof FACTS[number], number | boolean>>;
  /** Older immutable receipts predate this additive diagnostic field. */
  transportProbes?: WindowsTransportProbe[];
  mutationClaims?: Record<string, "started" | "complete">;
  allocationDeadline?: number;
  retirementPending?: boolean;
}
export interface WindowsLaneInput {
  readonly identity: WindowsIdentity;
  readonly progress: unknown;
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
  readonly pixel: <T>(owner: string, action: () => Promise<T>, execution?: WindowsExecutionContext) => Promise<T>;
  readonly runtime?: WindowsRuntime;
  readonly execution?: WindowsExecutionContext;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requireFact(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function requireProduct(value: unknown, message: string): asserts value {
  if (value) return;
  const failure = windowsFailure("assertion_failed", "output", "confirmed");
  // Assertion messages are controller-authored constants/closed check names, never guest output.
  failure.message = message; throw failure;
}
export function verifyWindowsDoctor(result: Record<string, unknown>): Record<string, number | boolean> {
  const checks = result.checks;
  // A logon trigger without the installing account fires on anyone's logon, and needs an administrator to register (#294).
  requireProduct(record(checks) && result.loopbackOnly === true && result.logonTrigger === true && result.interactivePrincipal === true && result.logonTriggerScoped === true, "invalid Windows doctor/listener/task observation");
  for (const name of ["assets", "compatibility", "config", "daemon", "discoveryReadable", "funnelDisabled",
    "listenerLoopbackOnly", "loopbackTrustSound", "permissions", "relay", "serveMapping", "serviceActive", "serviceInstalled", "tailscaleConnected"]) {
    requireProduct(checks[name] === true, `Windows doctor host check failed: ${name}`);
  }
  const health = Object.hasOwn(checks, "sessionHealth") ? "sessionHealth" : "publisherHealth";
  const expectedFalse = new Set(["identityAllowed", "pwa", health]);
  requireProduct([...expectedFalse].every(name => checks[name] === false) && typeof checks.securityHeaders === "boolean", "Windows tagged-node denial checks differ");
  if (checks.securityHeaders === false) expectedFalse.add("securityHeaders");
  const entries = Object.entries(checks);
  requireProduct(entries.every(([name, value]) => typeof value === "boolean" && (value || expectedFalse.has(name))), "unexpected Windows doctor failure");
  return { doctorChecks: entries.length, doctorTrue: entries.filter(([, value]) => value === true).length,
    doctorIdentityAllowed: false, doctorPwa: false, [health === "sessionHealth" ? "doctorSessionHealth" : "doctorPublisherHealth"]: false,
    doctorSecurityHeaders: checks.securityHeaders, loopbackOnly: true, logonTrigger: true, interactivePrincipal: true, logonTriggerScoped: true };
}
export function assertWindowsPins(omp: Pick<OmpPins, "version" | "sourceCommit" | "sourceTree" | "bunVersion">): void {
  requireFact(omp.version === pins.omp.version && omp.sourceCommit === pins.omp.sourceCommit && omp.sourceTree === pins.omp.sourceTree && omp.bunVersion === pins.bunVersion,
    "Windows OMP pins differ from the requested baseline");
  requireFact(upstream.packageVersion === pins.omp.version && upstream.commit === pins.omp.sourceCommit && upstream.tree === pins.omp.sourceTree && upstream.bunVersion === pins.bunVersion,
    "Windows pins must be refreshed with UPSTREAM.lock.json");
}
function binding(identity: WindowsIdentity): string {
  assertWindowsPins(identity.omp);
  requireFact(/^v\d+\.\d+\.\d+(?:-prealpha\.\d+)?$/u.test(identity.tag) && identity.tag === identity.candidate.tag && identity.predecessor.tag !== identity.tag, "invalid Windows release identity");
  for (const artifact of [identity.candidate, identity.predecessor]) {
    requireFact(/^v\d+\.\d+\.\d+(?:-prealpha\.\d+)?$/u.test(artifact.tag) && /^[0-9a-f]{40}$/u.test(artifact.sourceCommit) && SHA.test(artifact.archiveSha256) && typeof artifact.archivePath === "string" && artifact.archivePath.length > 0, "invalid Windows archive identity");
  }
  return createHash("sha256").update(JSON.stringify([identity.tag, identity.candidate.sourceCommit, identity.candidate.archiveSha256,
    identity.predecessor.tag, identity.predecessor.sourceCommit, identity.predecessor.archiveSha256, pins.omp, pins.bunVersion])).digest("hex");
}
function parseProgress(value: unknown, expected?: string): Progress {
  requireFact(record(value), "invalid Windows progress");
  const keys = ["binding", "cleanupRequired", "epoch", "facts", "lane", "phase", "schemaVersion", "settled", "startedAt", "timings"];
  for (const key of ["transportProbes", "mutationClaims", "allocationDeadline", "retirementPending"]) if (Object.hasOwn(value, key)) keys.push(key);
  requireFact(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort()), "unknown Windows progress fields");
  requireFact(value.schemaVersion === 1 && value.lane === "windows" && typeof value.epoch === "string" && UUID.test(value.epoch) &&
    typeof value.binding === "string" && SHA.test(value.binding) && (expected === undefined || value.binding === expected) &&
    PHASES.includes(value.phase as Phase) && typeof value.settled === "boolean" && typeof value.cleanupRequired === "boolean" &&
    typeof value.startedAt === "number" && Number.isSafeInteger(value.startedAt) && value.startedAt > 0, "foreign or malformed Windows progress");
  requireFact(record(value.timings) && record(value.facts), "invalid Windows observations");
  const timings = value.timings;
  const phaseIndex = PHASES.indexOf(value.phase as Phase);
  const observedPhases = PHASES.slice(1, phaseIndex + (value.settled ? 1 : 0));
  requireFact(Object.keys(timings).length === observedPhases.length && observedPhases.every(phase => Object.hasOwn(timings, phase)), "incomplete Windows phase history");
  for (const [key, item] of Object.entries(value.timings)) requireFact(PHASES.includes(key as Phase) && typeof item === "number" && Number.isFinite(item) && item >= 0, "invalid Windows timing");
  for (const [key, item] of Object.entries(value.facts)) requireFact(FACTS.includes(key as typeof FACTS[number]) && (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item) && item >= 0)), "invalid Windows observation");
  if (value.allocationDeadline !== undefined) requireFact(Number.isSafeInteger(value.allocationDeadline) && Number(value.allocationDeadline) > Number(value.startedAt), "invalid Windows allocation deadline");
  if (value.retirementPending !== undefined) requireFact(typeof value.retirementPending === "boolean" && value.cleanupRequired === false, "invalid Windows retirement state");
  if (value.mutationClaims !== undefined) {
    requireFact(record(value.mutationClaims), "invalid Windows mutation claims");
    for (const [key, state] of Object.entries(value.mutationClaims)) {
      const [phase, kind, principal, action, extra] = key.split(":");
      requireFact(PHASES.includes(phase as Phase) && ["guest", "ps", "rdp"].includes(kind ?? "") &&
        ["administrator", "standard"].includes(principal ?? "") && MUTATION_ACTIONS.includes(action ?? "") &&
        extra === undefined && (state === "started" || state === "complete"), "invalid Windows mutation claim");
    }
  }
  if (value.transportProbes !== undefined) {
    requireFact(Array.isArray(value.transportProbes), "invalid Windows transport probes");
    for (const probe of value.transportProbes) {
      requireFact(record(probe) && JSON.stringify(Object.keys(probe).sort()) === JSON.stringify(
        ["exitCode", "exitedAt", "firstResponseLatencyMs", "signalAt", "startedAt", "timeoutMs",
          ...(Object.hasOwn(probe, "killAt") ? ["killAt"] : []), ...(Object.hasOwn(probe, "controllerDeadline") ? ["controllerDeadline"] : [])].sort()), "unknown Windows transport probe fields");
      const integer = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item);
      requireFact(integer(probe.startedAt) && probe.startedAt > 0 && integer(probe.timeoutMs) && probe.timeoutMs >= 1 && probe.timeoutMs <= 180_000,
        "invalid Windows transport probe start");
      for (const key of ["signalAt", "exitedAt"] as const) requireFact(probe[key] === null || (integer(probe[key]) && probe[key] >= probe.startedAt), "invalid Windows transport probe timestamp");
      requireFact((probe.exitedAt === null) === (probe.exitCode === null) && (probe.exitCode === null || integer(probe.exitCode)), "invalid Windows transport probe exit");
      requireFact(probe.firstResponseLatencyMs === null || (integer(probe.firstResponseLatencyMs) && probe.firstResponseLatencyMs >= 0 &&
        (probe.exitedAt === null || probe.firstResponseLatencyMs <= Number(probe.exitedAt) - probe.startedAt)), "invalid Windows transport first response");
      requireFact(probe.signalAt === null || probe.exitedAt === null || Number(probe.signalAt) <= Number(probe.exitedAt), "Windows transport signal follows exit");
      if (probe.controllerDeadline !== undefined) requireFact(typeof probe.controllerDeadline === "boolean", "invalid transport deadline observation");
      if (probe.killAt !== undefined && probe.killAt !== null) requireFact(integer(probe.killAt) && probe.signalAt !== null &&
        probe.killAt >= Number(probe.signalAt) && (probe.exitedAt === null || probe.killAt <= Number(probe.exitedAt)), "invalid transport kill observation");
    }
  }
  return structuredClone(value) as Progress;
}
export function windowsNeedsCleanup(progress: unknown): boolean {
  return progress === undefined ? false : parseProgress(progress).cleanupRequired;
}
export function windowsCampaignLabel(epoch: string): string {
  requireFact(UUID.test(epoch), "invalid Windows resource epoch");
  return `${QUAL_LABEL_PREFIX}${epoch}`;
}
export async function preflightWindows(input: WindowsPreflightInput, runtime?: WindowsRuntime): Promise<WindowsAdmission> {
  if (input.identity) binding(input.identity);
  else assertWindowsPins({ version: upstream.packageVersion, sourceCommit: upstream.commit, sourceTree: upstream.tree, bunVersion: upstream.bunVersion });
  return (runtime ?? await createWindowsRuntime()).admit(input);
}
function assertInstance(item: WindowsInstance, label: string, runtime: WindowsRuntime): void {
  if (!(instanceEligibility(item.id, item.label, runtime.environment).eligible && item.label === label && item.os_id === pins.osId && item.region === pins.region && item.plan === pins.plan)) {
    throw windowsFailure("ownership_changed", "connection", "not_started");
  }
}
function assertFirewall(item: WindowsFirewall, label: string, runtime: WindowsRuntime): void {
  if (!(firewallEligibility(item.id, item.description, runtime.environment).eligible && item.description === label)) {
    throw windowsFailure("ownership_changed", "connection", "not_started");
  }
}
async function waitFor(runtime: WindowsRuntime, action: () => Promise<boolean>, timeout: number, name: string, observed?: () => Record<string, unknown>, execution?: WindowsExecutionContext): Promise<void> {
  const start = runtime.now();
  const remaining = () => {
    try { return windowsRemaining(start, start + timeout, runtime.now(), execution); }
    catch (error) {
      if (error instanceof QualificationFailure && error.evidence.reason === "deadline_exceeded") {
        const last = observed === undefined ? "" : `; last ${JSON.stringify(Object.fromEntries(Object.entries(observed()).filter(([, value]) => typeof value === "boolean" || typeof value === "number")))}`;
        error.message = `${name} timed out${last}`;
      }
      throw error;
    }
  };
  while (true) {
    remaining();
    let succeeded: boolean;
    try { succeeded = await action(); }
    catch (error) { remaining(); throw error; }
    const budget = remaining();
    if (succeeded) return;
    await runtime.sleep(Math.min(5_000, budget));
  }
}
/** Only positively identified product failures may retain an initial development guest. */
function retainWindowsForRepair(error: unknown, prior: Progress | undefined, progress: Progress, runtime: WindowsRuntime,
  repairable: boolean, execution?: WindowsExecutionContext): boolean {
  if (prior !== undefined || !repairable || !runtime.development ||
    !(error instanceof QualificationFailure) || error.evidence.lane !== "windows" || error.evidence.class !== "product" ||
    error.evidence.reason !== "assertion_failed" || error.evidence.operation === "unknown" ||
    PHASES.indexOf(progress.phase) < PHASES.indexOf("transport_ready")) return false;
  try { windowsRemaining(progress.startedAt, progress.startedAt + 3 * 60 * 60_000, runtime.now(), execution); }
  catch { return false; }
  return true;
}
function evidence(progress: Progress, identity: WindowsIdentity): Record<string, unknown> {
  const artifact = ({ tag, sourceCommit, archiveSha256 }: WindowsArtifact) => ({ tag, sourceCommit, archiveSha256 });
  return { epoch: progress.epoch, candidate: artifact(identity.candidate), predecessor: artifact(identity.predecessor),
    omp: pins.omp, bunVersion: pins.bunVersion, timings: progress.timings, observations: progress.facts,
    transportProbes: progress.transportProbes ?? [],
    doctor: { true: progress.facts.doctorTrue, total: progress.facts.doctorChecks,
      falseChecks: [["identityAllowed", "doctorIdentityAllowed"], ["pwa", "doctorPwa"], ["sessionHealth", "doctorSessionHealth"],
        ["publisherHealth", "doctorPublisherHealth"], ["securityHeaders", "doctorSecurityHeaders"]].filter(([, key]) => progress.facts[key as typeof FACTS[number]] === false).map(([name]) => name) } };
}

export async function runWindows(input: WindowsLaneInput): Promise<Record<string, unknown>> {
  const digest = binding(input.identity);
  const runtime = input.runtime ?? await createWindowsRuntime(input.execution === undefined ? {} : { execution: input.execution });
  runtime.setExecution?.(input.execution);
  const prior = input.progress === undefined ? undefined : parseProgress(input.progress, digest);
  let activeProgress = prior, repairable = false;
  // Establish containment ownership before any retained-state rejection or preflight work.
  const cleanupExecution = { signal: new AbortController().signal, deadline: performance.now() + 30 * 60_000,
    nextFailureId: input.execution?.nextFailureId ?? (() => ++standaloneFailureId) };
  try {
  assertWindowsExecution(input.execution);
  let resumed: Progress | undefined;
  if (prior !== undefined) {
    if (prior.phase === "evidence_complete" && prior.settled) { assertWindowsExecution(input.execution); return evidence(prior, input.identity); }
    if (runtime.development && prior.cleanupRequired && runtime.now() - prior.startedAt < 3 * 60 * 60_000) {
      if (!prior.settled && !READ_ONLY_PHASES.includes(prior.phase)) {
        throw windowsFailure("mutation_unconfirmed", prior.phase, "unknown", {}, input.execution);
      }
      resumed = prior;
    }
    else {
      // The protected exit reconciles interrupted effects instead of replaying mutations.
      throw new Error("interrupted Windows attempt cleaned; start a fresh epoch");
    }
  }
  await preflightWindows({ identity: input.identity, ...(resumed ? { epoch: resumed.epoch } : {}) }, runtime);
  const progress: Progress = resumed ?? { schemaVersion: 1, lane: "windows", epoch: runtime.uuid(), binding: digest,
    phase: "intent_checkpointed", settled: true, cleanupRequired: true, startedAt: runtime.now(), timings: {}, facts: {}, transportProbes: [] };
  activeProgress = progress;
  const durableAdmission = windowsTransportStability(progress.facts) ??
    (resumed ? windowsTransportStability(await runtime.transportAdmission?.(resumed.epoch)) : undefined);
  let admissionComplete = durableAdmission !== undefined;
  const save = async () => { parseProgress(progress, digest); await input.checkpoint(structuredClone(progress)); };
  const assertAllocation = () => {
    if (PHASES.indexOf(progress.phase) <= PHASES.indexOf("transport_ready") &&
      !(progress.phase === "transport_ready" && admissionComplete) &&
      progress.allocationDeadline !== undefined) {
      assertWindowsAllocation(input.execution, progress.allocationDeadline, runtime.now());
    }
  };
  const assertEffect = (maximumAge = 3 * 60 * 60_000) => {
    windowsRemaining(progress.startedAt, progress.startedAt + maximumAge, runtime.now(), input.execution, "not_started");
    assertAllocation();
  };
  if (resumed && !admissionComplete && PHASES.indexOf(resumed.phase) <= PHASES.indexOf("transport_ready") && progress.allocationDeadline === undefined) {
    throw windowsFailure("mutation_unconfirmed", resumed.phase, "unknown", {}, input.execution);
  }
  const context: WindowsContext = { epoch: progress.epoch, identity: input.identity, assertEffect,
    freshStaging: resumed === undefined || PHASES.indexOf(resumed.phase) < PHASES.indexOf("toolchain_staged"),
    get allocationDeadline() { return progress.allocationDeadline; },
    ...(durableAdmission === undefined ? {} : { transportAdmission: durableAdmission }),
    ...(input.execution === undefined ? {} : { execution: input.execution }),
    beforeEffect: async () => {
      assertEffect();
      await save();
      assertEffect();
    },
    mutation: async (key, action) => {
      const claims = progress.mutationClaims ??= {};
      const claim = `${progress.phase}:${key}`;
      if (claims[claim] !== undefined) throw windowsFailure("mutation_unconfirmed", progress.phase, "unknown", {}, input.execution);
      await context.beforeEffect();
      claims[claim] = "started"; await save(); assertEffect();
      let result;
      try { result = await action(); }
      catch (error) {
        if (!(error instanceof QualificationFailure && ["deadline_exceeded", "ownership_changed"].includes(error.evidence.reason))) {
          assertWindowsExecution(input.execution, "unknown");
        }
        throw error;
      }
      claims[claim] = "complete"; await save(); assertEffect();
      return result;
    },
    transportProbe: async probe => {
      requireFact(!progress.settled, "transport observation outside active step");
      const probes = progress.transportProbes ??= [];
      if (probes.at(-1)?.startedAt === probe.startedAt) probes[probes.length - 1] = { ...probe };
      else probes.push({ ...probe });
      await save();
    },
  };
  const label = windowsCampaignLabel(progress.epoch);
  await save();
  const resumeIndex = resumed ? PHASES.indexOf(resumed.phase) : -1;
  const resumeSettled = resumed?.settled;
  const step = async (phase: Phase, action: () => Promise<void>) => {
    const index = PHASES.indexOf(phase);
    if (index < resumeIndex || (index === resumeIndex && resumeSettled)) return;
    if (index === resumeIndex && !resumeSettled) progress.facts.failedPhaseAttempts = Number(progress.facts.failedPhaseAttempts ?? 0) + 1;
    // Reserve the Pixel queue/action window and, independently, time for VM destruction.
    const maximumAge = (phase === "pixel_verified" ? 2 : 3) * 60 * 60_000;
    assertEffect(maximumAge);
    progress.phase = phase; progress.settled = false; await save();
    const start = runtime.now();
    try { assertEffect(maximumAge); await action(); }
    catch (error) {
      if (!(error instanceof QualificationFailure && ["deadline_exceeded", "ownership_changed"].includes(error.evidence.reason))) {
        assertWindowsExecution(input.execution, "unknown");
      }
      if (error instanceof QualificationFailure) {
        const failure = new QualificationFailure(parseLaneFailure({ ...error.evidence, id: input.execution?.nextFailureId() ?? error.evidence.id,
          ...(error.evidence.lane === "windows" ? { step: phase } : {}), elapsedMs: runtime.now() - start }),
          error.cause === undefined ? undefined : { cause: error.cause });
        failure.message = error.message; throw failure;
      }
      if (error instanceof AggregateError) throw error;
      const failure = windowsFailure("unclassified_failure", phase, "unknown", {}, input.execution, runtime.now() - start);
      if (pixelUnrestored(error)) Object.assign(failure, { pixelUnrestored: true });
      throw failure;
    }
    progress.timings[phase] = runtime.now() - start; progress.settled = true; await save();
    assertEffect(maximumAge);
  };
  const guest = (action: WindowsGuestAction, principal?: WindowsPrincipal) => {
    assertEffect();
    return GUEST_MUTATIONS.includes(action)
      ? context.mutation(`guest:${principal ?? "administrator"}:${action}`, () => runtime.guest(context, action, principal))
      : runtime.guest(context, action, principal);
  };
  const rdp = (principal: WindowsPrincipal = "administrator") => context.mutation(`rdp:${principal}:logon`, () => runtime.rdp(context, principal));
  const facts = (values: Record<string, unknown>) => {
    for (const key of FACTS) if (values[key] !== undefined) {
      const value = values[key];
      requireFact(typeof value === "number" || typeof value === "boolean", "unsafe Windows observation");
      progress.facts[key] = value;
    }
  };
  const prelogin = async () => {
    await guest("transport"); const start = runtime.now(); let samples = 0;
    do {
      const state = await guest("prelogin");
      requireProduct(state.taskPresent === true && state.taskRunning === false && state.gatewayProcesses === 0 && state.listeners === 0 &&
        state.logonTrigger === true && state.interactivePrincipal === true && state.logonTriggerScoped === true, "pre-login task/process/listener invariant failed");
      samples += 1; if (runtime.now() - start >= 30_000 && samples >= 3) break;
      await runtime.sleep(15_000);
    } while (true);
    return { samples, durationMs: runtime.now() - start };
  };
  const postlogin = async (principal: WindowsPrincipal) => {
    const start = runtime.now(); await rdp(principal);
    let last: Record<string, unknown> = {};
    await waitFor(runtime, async () => (last = await guest("ready", principal)).ready === true, 180_000,
      `${principal === "standard" ? "standard " : ""}automatic LogonTrigger startup`, () => last, input.execution);
    return runtime.now() - start;
  };
    repairable = true;
    let firewall: WindowsFirewall | undefined = resumed ? (await runtime.provider.firewalls()).find(item => item.description === label) : undefined;
    await step("firewall_created", async () => {
      progress.allocationDeadline = runtime.now() + 12 * 60_000; await save();
      assertWindowsAllocation(input.execution, progress.allocationDeadline, runtime.now());
      firewall = await runtime.provider.createFirewall(label, input.execution, progress.allocationDeadline);
      const fresh = await runtime.provider.firewall(firewall.id);
      requireFact(fresh, "created firewall missing"); assertFirewall(fresh, label, runtime);
      await save(); assertWindowsAllocation(input.execution, progress.allocationDeadline, runtime.now());
      await runtime.provider.configureFirewall(fresh.id, label, input.execution, progress.allocationDeadline);
    });
    await step("instance_created", async () => {
      requireFact(firewall, "firewall is missing");
      requireFact((await runtime.provider.instances()).every(item => !item.label?.startsWith(QUAL_LABEL_PREFIX)), "another Windows qualification instance exists");
      assertWindowsAllocation(input.execution, progress.allocationDeadline, runtime.now());
      const instance = await runtime.provider.createInstance(label, firewall.id, input.execution, progress.allocationDeadline);
      assertInstance(instance, label, runtime);
      // A failed write reaches finally cleanup, which independently lists/refetches the exact label.
      await save();
      assertWindowsExecution(input.execution); await runtime.saveAccess(progress.epoch, instance);
    });
    await step("transport_ready", async () => {
      const result = await guest("transport");
      requireProduct(typeof result.transportStabilitySamples === "number" && result.transportStabilitySamples >= 3 &&
        typeof result.transportStabilityDurationMs === "number" && result.transportStabilityDurationMs >= 60_000, "authenticated WinRM stability window incomplete");
      facts(result);
      admissionComplete = true;
    });
    await step("toolchain_staged", async () => { await save(); await rdp(); facts(await guest("stage")); });
    await step("predecessor_installed", async () => { requireProduct((await guest("installPredecessor")).ready === true, "predecessor did not become ready"); });
    await step("candidate_upgraded", async () => {
      const result = await guest("upgrade"); requireProduct(result.ready === true && result.configPreserved === true && result.readinessPreserved === true, "upgrade changed private state or readiness failed"); facts(result);
      facts(verifyWindowsDoctor(await guest("doctor")));
    });
    await step("reboot_requested", async () => { await guest("reboot"); });
    await step("prelogin_verified", async () => {
      const observed = await prelogin(); facts({ preloginSamples: observed.samples, preloginDurationMs: observed.durationMs });
    });
    await step("postlogin_ready", async () => { facts({ automaticStartMs: await postlogin("administrator") }); });
    await step("doctor_passed", async () => { facts(verifyWindowsDoctor(await guest("doctor"))); });
    await step("omp_published", async () => {
      const result = await guest("publish"); requireProduct(result.namedPipe === true && result.generation === 1, "OMP did not publish its named pipe"); facts(result);
      const launch = await guest("launch");
      requireProduct(launch.viewStatus === 200 && launch.controlStatus === 200 && launch.staleViewStatus === 409 && launch.staleControlStatus === 409 && launch.noStore === true, "generation/launch contract failed"); facts(launch);
    });
    await step("pixel_verified", async () => {
      const result = await input.pixel("windows", () => { assertEffect(2 * 60 * 60_000); return runtime.pixel(context); }, input.execution);
      for (const key of ["pixelIdentityAccepted", "viewReadOnly", "controlWritable", "promptAccepted", "returnedToDirectory"]) requireProduct(result[key] === true, `Pixel ${key} failed`);
      facts(result);
    });
    await step("omp_revoked", async () => { await guest("stopOmp"); const result = await guest("revoked"); requireProduct(result.revoked === true, "OMP revocation failed"); facts(result); });
    await step("readiness_rotated", async () => { const result = await guest("rotate"); requireProduct(result.ready === true && result.readinessChanged === true && result.configPreserved === true, "readiness rotation invariant failed"); facts(result); });
    await step("predecessor_restored", async () => { const result = await guest("rollback"); requireProduct(result.ready === true && result.historySelected === true && result.configPreserved === true && result.readinessPreserved === true, "history-selected rollback invariant failed"); facts(result); });
    await step("candidate_restored", async () => { const result = await guest("restore"); requireProduct(result.ready === true && result.restored === true && result.configPreserved === true && result.readinessPreserved === true, "candidate restoration invariant failed"); facts(result); });
    await step("candidate_uninstalled", async () => { const result = await guest("uninstall"); requireProduct(result.uninstalled === true && result.configPreserved === true && result.readinessPreserved === true, "uninstall preservation invariant failed"); facts(result); });
    // The same candidate, freshly installed by an account with no administrative rights (#293, #294).
    await step("standard_user_prepared", async () => {
      requireProduct((await guest("prepareStandardUser")).prepared === true, "standard account preparation failed");
      const token = await guest("identity", "standard");
      requireProduct(token.standardUserNonAdmin === true && token.standardUserNoSecurityPrivilege === true, "the standard account's token is privileged");
      facts({ standardUserNonAdmin: true, standardUserNoSecurityPrivilege: true });
    });
    await step("standard_tailnet_released", async () => {
      requireProduct((await guest("releaseTailnet")).released === true, "the Administrator did not release Tailscale");
      assertEffect(); await runtime.deleteTailnet(context);
    });
    await step("standard_tailnet_joined", async () => {
      const joined = await guest("join", "standard");
      requireProduct(joined.taggedNode === true && joined.tunMode === true && joined.funnelOff === true, "standard tagged Tailscale join failed");
    });
    // The account acts; the Administrator observes its task, processes and listener, because WMI
    // refuses a standard account's network logon.
    await step("standard_interactive_ready", async () => { await rdp("standard"); });
    await step("standard_candidate_installed", async () => {
      const result = await guest("installFresh", "standard"); const state = await guest("state");
      requireProduct(result.ready === true && state.loopbackOnly === true, "standard fresh install did not become ready");
    });
    await step("standard_reboot_requested", async () => { await guest("reboot"); });
    await step("standard_prelogin_verified", async () => {
      const observed = await prelogin(); facts({ standardPreloginSamples: observed.samples, standardPreloginDurationMs: observed.durationMs });
    });
    await step("standard_postlogin_ready", async () => { facts({ standardAutomaticStartMs: await postlogin("standard") }); });
    await step("standard_doctor_passed", async () => {
      const { checks } = await guest("doctor", "standard"); const state = await guest("state");
      const doctor = verifyWindowsDoctor({ checks, loopbackOnly: state.loopbackOnly, logonTrigger: state.logonTrigger,
        interactivePrincipal: state.interactivePrincipal, logonTriggerScoped: state.logonTriggerScoped });
      facts({ standardDoctorChecks: doctor.doctorChecks, standardDoctorTrue: doctor.doctorTrue });
    });
    await step("standard_readiness_rotated", async () => {
      const result = await guest("rotate", "standard");
      requireProduct(result.ready === true && result.readinessChanged === true && result.configPreserved === true, "standard readiness rotation invariant failed");
      facts({ standardReadinessChanged: true });
    });
    await step("standard_candidate_uninstalled", async () => {
      const result = await guest("uninstall", "standard"); const state = await guest("state");
      requireProduct(state.taskPresent === false && state.gatewayProcesses === 0 && state.listeners === 0 && result.configPreserved === true && result.readinessPreserved === true,
        "standard uninstall preservation invariant failed");
      facts({ standardUninstalled: true, standardConfigPreserved: true, standardReadinessPreserved: true });
    });
    await step("evidence_complete", async () => {});
    assertWindowsExecution(input.execution);
    return evidence(progress, input.identity);
  } catch (error) {
    if (activeProgress === undefined) throw error;
    if (retainWindowsForRepair(error, prior, activeProgress, runtime, repairable, input.execution)) throw error;
    // A failed primary's cancellation must not disable owned-resource containment.
    cleanupExecution.deadline = performance.now() + 30 * 60_000;
    try { await cleanupWindows({ ...input, progress: activeProgress, runtime, execution: cleanupExecution }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Windows lane and cleanup failed"); }
    throw error;
  }
}

export async function cleanupWindows(input: WindowsLaneInput): Promise<Record<string, unknown>> {
  if (input.progress === undefined) return { noAttempt: true };
  const progress = parseProgress(input.progress, binding(input.identity));
  const runtime = input.runtime ?? await createWindowsRuntime();
  runtime.setExecution?.(input.execution);
  const containmentCommitted = !progress.cleanupRequired;
  const label = windowsCampaignLabel(progress.epoch);
  const failures: string[] = [];
  const causes: Error[] = [];
  let guestFailures = 0, instanceAbsent = false, guestCommandsSkipped = true, ownershipChanged = false;
  const failed = (name: string, error: unknown) => {
    if (error instanceof QualificationFailure && error.evidence.reason === "ownership_changed") ownershipChanged = true;
    failures.push(name);
    const failure = new QualificationFailure(parseLaneFailure({
      id: input.execution?.nextFailureId() ?? ++standaloneFailureId, lane: "windowsCleanup", step: "containment",
      class: "harness", reason: error instanceof QualificationFailure && error.evidence.reason === "ownership_changed" ? "ownership_changed" : "containment_unproven",
      operation: "unknown", elapsedMs: 0, observations: {},
    }));
    if (pixelUnrestored(error)) Object.assign(failure, { pixelUnrestored: true });
    causes.push(failure);
  };
  const save = async () => {
    try { await input.checkpoint(structuredClone(progress)); }
    catch (error) {
      if (!failures.includes("checkpoint")) {
        failed("checkpoint", error);
      }
    }
  };
  // Teardown is idempotent and independently ownership-checked. A broken receipt
  // disk must be reported, but must not prevent destruction of the owned VM.
  const beforeEffect = async () => { await save(); assertWindowsExecution(input.execution); };
  const context: WindowsContext = { epoch: progress.epoch, identity: input.identity, beforeEffect,
    assertEffect: () => assertWindowsExecution(input.execution),
    mutation: async (_key, action) => { await beforeEffect(); return action(); },
    ...(input.execution === undefined ? {} : { execution: input.execution }) };
  const attempt = async (name: string, action: () => Promise<void>) => {
    try { await beforeEffect(); await action(); }
    catch (error) {
      failed(name, error);
    }
  };
  if (progress.cleanupRequired) {
    if (runtime.hasAccess && (PHASES.indexOf(progress.phase) > PHASES.indexOf("instance_created") ||
      (progress.phase === "instance_created" && progress.settled))) {
      await attempt("vaultState", async () => { requireFact(await runtime.hasAccess!(progress.epoch), "uncommitted cleanup lacks recovery vault"); });
    }
    const owned = new Map<string, WindowsInstance>();
    let inventoryVerified = false, guestAccessAvailable = true;
    await attempt("guestInventory", async () => {
      guestAccessAvailable = runtime.hasAccess === undefined || await runtime.hasAccess(progress.epoch);
      const bound = await runtime.cleanupInstance?.(progress.epoch);
      if (bound) { assertInstance(bound, label, runtime); owned.set(bound.id, bound); }
      let listing = await runtime.provider.instances();
      if (!listing.some(item => item.label === label) && !bound) {
        // One empty provider page is not proof that the exact guest is gone.
        await runtime.sleep(5_000); listing = await runtime.provider.instances();
      }
      for (const match of listing.filter(item => item.label === label)) {
        const fresh = await runtime.provider.instance(match.id);
        if (fresh) { assertInstance(fresh, label, runtime); owned.set(fresh.id, fresh); }
      }
      inventoryVerified = true;
    });
    const guestAttempt = async (action: "reconnect" | "stopOmp" | "uninstall" | "resetServe" | "logout", owner?: WindowsPrincipal) => {
      try { await beforeEffect(); await runtime.guest(context, action, owner); return true; }
      catch (error) {
        if (error instanceof QualificationFailure && error.evidence.reason === "ownership_changed") failed(action, error);
        else guestFailures += 1;
        return false;
      }
    };
    if (inventoryVerified && guestAccessAvailable && owned.size > 0 && await guestAttempt("reconnect")) {
      guestCommandsSkipped = false;
      // After the handover Windows refuses the Administrator's Tailscale CLI while the standard account
      // operates it, and the Administrator's gateway is already uninstalled.
      const handedOver = PHASES.indexOf(progress.phase) > PHASES.indexOf("standard_tailnet_released") ||
        (progress.phase === "standard_tailnet_released" && progress.settled);
      const owner: WindowsPrincipal = handedOver ? "standard" : "administrator";
      for (const action of ["stopOmp", "uninstall", "resetServe", "logout"] as const) {
        if (!await guestAttempt(action, action === "stopOmp" ? undefined : owner)) { guestCommandsSkipped = true; break; }
      }
    }
    await attempt("tailnetDelete", () => runtime.deleteTailnet(context));
    await attempt("instances", async () => {
      requireFact(!ownershipChanged, "instance ownership changed");
      for (const match of (await runtime.provider.instances()).filter(item => item.label === label)) owned.set(match.id, match);
      for (const match of owned.values()) {
        await attempt("instanceDelete", async () => {
          const fresh = await runtime.provider.instance(match.id);
          if (!fresh) return;
          if (fresh.id !== match.id) throw windowsFailure("ownership_changed", "connection", "not_started");
          assertInstance(fresh, label, runtime); await beforeEffect(); await runtime.provider.destroyInstance(fresh.id, label);
          await waitFor(runtime, async () => await runtime.provider.instance(fresh.id) === undefined, 180_000, "instance deletion", undefined, input.execution);
        });
      }
      requireFact(inventoryVerified && !failures.includes("instanceDelete"), "instance containment unresolved");
      for (const item of owned.values()) requireFact(await runtime.provider.instance(item.id) === undefined, "instance still exists");
      instanceAbsent = true;
    });
    await attempt("firewalls", async () => {
      const ownedFirewalls = new Map<string, WindowsFirewall>();
      const bound = await runtime.cleanupFirewall?.(progress.epoch);
      if (bound) { assertFirewall(bound, label, runtime); ownedFirewalls.set(bound.id, bound); }
      for (const match of (await runtime.provider.firewalls()).filter(item => item.description === label)) ownedFirewalls.set(match.id, match);
      for (const match of ownedFirewalls.values()) {
        await attempt("firewallDelete", async () => {
          const fresh = await runtime.provider.firewall(match.id);
          if (!fresh) return;
          if (fresh.id !== match.id) throw windowsFailure("ownership_changed", "connection", "not_started");
          assertFirewall(fresh, label, runtime); await beforeEffect(); await runtime.provider.destroyFirewall(fresh.id, label);
          await waitFor(runtime, async () => await runtime.provider.firewall(fresh.id) === undefined, 180_000, "firewall deletion", undefined, input.execution);
        });
      }
    });
    // Device recovery can wait for another lane's lease; paid infrastructure must not.
    if (PHASES.indexOf(progress.phase) >= PHASES.indexOf("pixel_verified")) {
      await attempt("pixelRestore", () => input.pixel("windows-cleanup", () => { assertWindowsExecution(input.execution); return runtime.restorePixel(context); }, input.execution));
    }
  } else {
    progress.retirementPending = true; await save();
    await attempt("tailnetDelete", () => runtime.deleteTailnet(context));
  }
  // Provider listings may lag accepted creates/deletes; final containment requires a new
  // inventory after the same five-second settling interval used for confirmed lookup absence.
  await runtime.sleep(5_000);
  await attempt("instanceResidue", async () => { requireFact(!(await runtime.provider.instances()).some(item => item.label?.startsWith(QUAL_LABEL_PREFIX)), "instance residue"); });
  await attempt("firewallResidue", async () => { requireFact(!(await runtime.provider.firewalls()).some(item => item.description?.startsWith(QUAL_LABEL_PREFIX)), "firewall residue"); });
  if (guestFailures > 0 && !instanceAbsent) failed("guestContainment", undefined);
  if (!containmentCommitted) progress.cleanupRequired = failures.length > 0;
  if (!progress.cleanupRequired) progress.retirementPending = true;
  await save();
  if (failures.length) throw new AggregateError(causes, `Windows cleanup failed: ${failures.join(", ")}`);
  // Completion is durable before deleting the last recovery state. If unlink fails or the
  // controller dies afterward, the committed false checkpoint lets cleanup finish without
  // attempting Pixel restoration from a vault that may already be absent.
  try { assertWindowsExecution(input.execution); await runtime.removeAccess(progress.epoch); }
  catch { throw new QualificationFailure(parseLaneFailure({ id: input.execution?.nextFailureId() ?? ++standaloneFailureId,
    lane: "windowsCleanup", step: "vault", reason: "containment_unproven", class: "harness",
    elapsedMs: 0, operation: "unknown", observations: {} })); }
  progress.retirementPending = false; await save();
  if (failures.length) throw new AggregateError(causes, `Windows retirement failed: ${failures.join(", ")}`);
  return { epoch: progress.epoch, instancesRemaining: 0, firewallsRemaining: 0, tailnetDeleted: true, vaultRemoved: true,
    guestCleanupFailures: guestFailures, guestCommandsSkipped };
}

if (import.meta.main) {
  await windowsDevelopmentCli(process.argv.slice(2));
}
