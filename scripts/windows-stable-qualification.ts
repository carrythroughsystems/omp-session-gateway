import { createHash } from "node:crypto";
import { createWindowsRuntime, windowsDevelopmentCli } from "./windows-qualification-runtime.ts";
import pins from "./windows-qualification-pins.json";
import upstream from "../UPSTREAM.lock.json";
import type { OmpPins } from "./stable-qualification.ts";
import { firewallEligibility, instanceEligibility, QUAL_LABEL_PREFIX } from "./vultr-target.ts";

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
}
export interface WindowsProvider {
  instances(): Promise<WindowsInstance[]>;
  firewalls(): Promise<WindowsFirewall[]>;
  instance(id: string): Promise<WindowsInstance | undefined>;
  firewall(id: string): Promise<WindowsFirewall | undefined>;
  createFirewall(label: string): Promise<WindowsFirewall>;
  configureFirewall(id: string, label: string): Promise<void>;
  createInstance(label: string, firewall: string): Promise<WindowsInstance>;
  destroyInstance(id: string, label: string): Promise<void>;
  destroyFirewall(id: string, label: string): Promise<void>;
}
export interface WindowsContext {
  readonly epoch: string;
  readonly identity: WindowsIdentity;
  readonly beforeEffect: () => Promise<void>;
  readonly transportProbe?: (probe: WindowsTransportProbe) => Promise<void>;
}
export type WindowsGuestAction = "transport" | "stage" | "installPredecessor" | "upgrade" | "doctor" | "reboot" |
  "prelogin" | "ready" | "publish" | "launch" | "stopOmp" | "revoked" | "rotate" | "rollback" | "restore" |
  "uninstall" | "resetServe" | "logout" | "prepareStandardUser" | "identity" | "releaseTailnet" | "join" | "installFresh" | "state";
/** The Windows account a guest action or RDP logon runs as. */
export type WindowsPrincipal = "administrator" | "standard";
export interface WindowsRuntime {
  /** Development CLI only: retain a healthy guest for immediate repair inside its lease. */
  readonly development?: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly provider: WindowsProvider;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly uuid: () => string;
  admit(input: WindowsPreflightInput): Promise<WindowsAdmission>;
  saveAccess(epoch: string, instance: WindowsInstance): Promise<void>;
  removeAccess(epoch: string): Promise<void>;
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
}
export interface WindowsLaneInput {
  readonly identity: WindowsIdentity;
  readonly progress: unknown;
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
  readonly pixel: <T>(owner: string, action: () => Promise<T>) => Promise<T>;
  readonly runtime?: WindowsRuntime;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requireFact(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function verifyWindowsDoctor(result: Record<string, unknown>): Record<string, number | boolean> {
  const checks = result.checks;
  // A logon trigger without the installing account fires on anyone's logon, and needs an administrator to register (#294).
  requireFact(record(checks) && result.loopbackOnly === true && result.logonTrigger === true && result.interactivePrincipal === true && result.logonTriggerScoped === true, "invalid Windows doctor/listener/task observation");
  for (const name of ["assets", "compatibility", "config", "daemon", "discoveryReadable", "funnelDisabled",
    "listenerLoopbackOnly", "loopbackTrustSound", "permissions", "relay", "serveMapping", "serviceActive", "serviceInstalled", "tailscaleConnected"]) {
    requireFact(checks[name] === true, `Windows doctor host check failed: ${name}`);
  }
  const health = Object.hasOwn(checks, "sessionHealth") ? "sessionHealth" : "publisherHealth";
  const expectedFalse = new Set(["identityAllowed", "pwa", health]);
  requireFact([...expectedFalse].every(name => checks[name] === false) && typeof checks.securityHeaders === "boolean", "Windows tagged-node denial checks differ");
  if (checks.securityHeaders === false) expectedFalse.add("securityHeaders");
  const entries = Object.entries(checks);
  requireFact(entries.every(([name, value]) => typeof value === "boolean" && (value || expectedFalse.has(name))), "unexpected Windows doctor failure");
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
  if (Object.hasOwn(value, "transportProbes")) keys.push("transportProbes");
  requireFact(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys), "unknown Windows progress fields");
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
  if (value.transportProbes !== undefined) {
    requireFact(Array.isArray(value.transportProbes), "invalid Windows transport probes");
    for (const probe of value.transportProbes) {
      requireFact(record(probe) && JSON.stringify(Object.keys(probe).sort()) === JSON.stringify(
        ["exitCode", "exitedAt", "firstResponseLatencyMs", "signalAt", "startedAt", "timeoutMs"]), "unknown Windows transport probe fields");
      const integer = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item);
      requireFact(integer(probe.startedAt) && probe.startedAt > 0 && integer(probe.timeoutMs) && probe.timeoutMs >= 1 && probe.timeoutMs <= 180_000,
        "invalid Windows transport probe start");
      for (const key of ["signalAt", "exitedAt"] as const) requireFact(probe[key] === null || (integer(probe[key]) && probe[key] >= probe.startedAt), "invalid Windows transport probe timestamp");
      requireFact((probe.exitedAt === null) === (probe.exitCode === null) && (probe.exitCode === null || integer(probe.exitCode)), "invalid Windows transport probe exit");
      requireFact(probe.firstResponseLatencyMs === null || (integer(probe.firstResponseLatencyMs) && probe.firstResponseLatencyMs >= 0 &&
        (probe.exitedAt === null || probe.firstResponseLatencyMs <= Number(probe.exitedAt) - probe.startedAt)), "invalid Windows transport first response");
      requireFact(probe.signalAt === null || probe.exitedAt === null || Number(probe.signalAt) <= Number(probe.exitedAt), "Windows transport signal follows exit");
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
  requireFact(instanceEligibility(item.id, item.label, runtime.environment).eligible && item.label === label && item.os_id === pins.osId && item.region === pins.region && item.plan === pins.plan, "refusing foreign or protected Windows instance");
}
function assertFirewall(item: WindowsFirewall, label: string, runtime: WindowsRuntime): void {
  requireFact(firewallEligibility(item.id, item.description, runtime.environment).eligible && item.description === label, "refusing foreign or protected Windows firewall");
}
async function waitFor(runtime: WindowsRuntime, action: () => Promise<boolean>, timeout: number, name: string, observed?: () => Record<string, unknown>): Promise<void> {
  const start = runtime.now();
  do { if (await action()) return; await runtime.sleep(5_000); } while (runtime.now() - start < timeout);
  // Name which predicate held out through the last observation's booleans and counts, never guest strings.
  const last = observed === undefined ? "" : `; last ${JSON.stringify(Object.fromEntries(Object.entries(observed()).filter(([, value]) => typeof value === "boolean" || typeof value === "number")))}`;
  throw new Error(`${name} timed out${last}`);
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
  const runtime = input.runtime ?? await createWindowsRuntime();
  let resumed: Progress | undefined;
  if (input.progress !== undefined) {
    const prior = parseProgress(input.progress, digest);
    if (prior.phase === "evidence_complete" && prior.settled) return evidence(prior, input.identity);
    if (runtime.development && prior.cleanupRequired && runtime.now() - prior.startedAt < 3 * 60 * 60_000) resumed = prior;
    else {
      // Stable campaigns reconcile interrupted effects instead of replaying mutations.
      await cleanupWindows({ ...input, runtime });
      throw new Error("interrupted Windows attempt cleaned; start a fresh epoch");
    }
  }
  await preflightWindows({ identity: input.identity, ...(resumed ? { epoch: resumed.epoch } : {}) }, runtime);
  const progress: Progress = resumed ?? { schemaVersion: 1, lane: "windows", epoch: runtime.uuid(), binding: digest,
    phase: "intent_checkpointed", settled: true, cleanupRequired: true, startedAt: runtime.now(), timings: {}, facts: {}, transportProbes: [] };
  const save = async () => { parseProgress(progress, digest); await input.checkpoint(structuredClone(progress)); };
  const context: WindowsContext = { epoch: progress.epoch, identity: input.identity,
    beforeEffect: async () => {
      requireFact(runtime.now() - progress.startedAt < 3 * 60 * 60_000, "Windows resource lifetime bound reached");
      await save();
    },
    transportProbe: async probe => {
      requireFact(progress.phase === "transport_ready" && !progress.settled, "transport observation outside admission");
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
    requireFact(runtime.now() - progress.startedAt < maximumAge, "Windows resource lifetime bound reached");
    progress.phase = phase; progress.settled = false; await save();
    const start = runtime.now(); await action();
    progress.timings[phase] = runtime.now() - start; progress.settled = true; await save();
  };
  const guest = (action: WindowsGuestAction, principal?: WindowsPrincipal) => runtime.guest(context, action, principal);
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
      requireFact(state.taskPresent === true && state.taskRunning === false && state.gatewayProcesses === 0 && state.listeners === 0 &&
        state.logonTrigger === true && state.interactivePrincipal === true && state.logonTriggerScoped === true, "pre-login task/process/listener invariant failed");
      samples += 1; if (runtime.now() - start >= 30_000 && samples >= 3) break;
      await runtime.sleep(15_000);
    } while (true);
    return { samples, durationMs: runtime.now() - start };
  };
  const postlogin = async (principal: WindowsPrincipal) => {
    const start = runtime.now(); await runtime.rdp(context, principal);
    let last: Record<string, unknown> = {};
    await waitFor(runtime, async () => (last = await guest("ready", principal)).ready === true, 180_000,
      `${principal === "standard" ? "standard " : ""}automatic LogonTrigger startup`, () => last);
    return runtime.now() - start;
  };
  try {
    let firewall: WindowsFirewall | undefined = resumed ? (await runtime.provider.firewalls()).find(item => item.description === label) : undefined;
    await step("firewall_created", async () => {
      firewall = await runtime.provider.createFirewall(label);
      const fresh = await runtime.provider.firewall(firewall.id);
      requireFact(fresh, "created firewall missing"); assertFirewall(fresh, label, runtime);
      await save(); await runtime.provider.configureFirewall(fresh.id, label);
    });
    await step("instance_created", async () => {
      requireFact(firewall, "firewall is missing");
      requireFact((await runtime.provider.instances()).every(item => !item.label?.startsWith(QUAL_LABEL_PREFIX)), "another Windows qualification instance exists");
      const instance = await runtime.provider.createInstance(label, firewall.id);
      assertInstance(instance, label, runtime);
      // A failed write reaches finally cleanup, which independently lists/refetches the exact label.
      await save();
      await runtime.saveAccess(progress.epoch, instance);
    });
    await step("transport_ready", async () => {
      const result = await guest("transport");
      requireFact(typeof result.transportStabilitySamples === "number" && result.transportStabilitySamples >= 3 &&
        typeof result.transportStabilityDurationMs === "number" && result.transportStabilityDurationMs >= 60_000, "authenticated WinRM stability window incomplete");
      facts(result);
    });
    await step("toolchain_staged", async () => { await save(); await runtime.rdp(context); facts(await guest("stage")); });
    await step("predecessor_installed", async () => { requireFact((await guest("installPredecessor")).ready === true, "predecessor did not become ready"); });
    await step("candidate_upgraded", async () => {
      const result = await guest("upgrade"); requireFact(result.ready === true && result.configPreserved === true && result.readinessPreserved === true, "upgrade changed private state or readiness failed"); facts(result);
      facts(verifyWindowsDoctor(await guest("doctor")));
    });
    await step("reboot_requested", async () => { await guest("reboot"); });
    await step("prelogin_verified", async () => {
      const observed = await prelogin(); facts({ preloginSamples: observed.samples, preloginDurationMs: observed.durationMs });
    });
    await step("postlogin_ready", async () => { facts({ automaticStartMs: await postlogin("administrator") }); });
    await step("doctor_passed", async () => { facts(verifyWindowsDoctor(await guest("doctor"))); });
    await step("omp_published", async () => {
      const result = await guest("publish"); requireFact(result.namedPipe === true && result.generation === 1, "OMP did not publish its named pipe"); facts(result);
      const launch = await guest("launch");
      requireFact(launch.viewStatus === 200 && launch.controlStatus === 200 && launch.staleViewStatus === 409 && launch.staleControlStatus === 409 && launch.noStore === true, "generation/launch contract failed"); facts(launch);
    });
    await step("pixel_verified", async () => {
      const result = await input.pixel("windows", () => runtime.pixel(context));
      for (const key of ["pixelIdentityAccepted", "viewReadOnly", "controlWritable", "promptAccepted", "returnedToDirectory"]) requireFact(result[key] === true, `Pixel ${key} failed`);
      facts(result);
    });
    await step("omp_revoked", async () => { await guest("stopOmp"); const result = await guest("revoked"); requireFact(result.revoked === true, "OMP revocation failed"); facts(result); });
    await step("readiness_rotated", async () => { const result = await guest("rotate"); requireFact(result.ready === true && result.readinessChanged === true && result.configPreserved === true, "readiness rotation invariant failed"); facts(result); });
    await step("predecessor_restored", async () => { const result = await guest("rollback"); requireFact(result.ready === true && result.historySelected === true && result.configPreserved === true && result.readinessPreserved === true, "history-selected rollback invariant failed"); facts(result); });
    await step("candidate_restored", async () => { const result = await guest("restore"); requireFact(result.ready === true && result.restored === true && result.configPreserved === true && result.readinessPreserved === true, "candidate restoration invariant failed"); facts(result); });
    await step("candidate_uninstalled", async () => { const result = await guest("uninstall"); requireFact(result.uninstalled === true && result.configPreserved === true && result.readinessPreserved === true, "uninstall preservation invariant failed"); facts(result); });
    // The same candidate, freshly installed by an account with no administrative rights (#293, #294).
    await step("standard_user_prepared", async () => {
      requireFact((await guest("prepareStandardUser")).prepared === true, "standard account preparation failed");
      const token = await guest("identity", "standard");
      requireFact(token.standardUserNonAdmin === true && token.standardUserNoSecurityPrivilege === true, "the standard account's token is privileged");
      facts({ standardUserNonAdmin: true, standardUserNoSecurityPrivilege: true });
    });
    await step("standard_tailnet_released", async () => {
      requireFact((await guest("releaseTailnet")).released === true, "the Administrator did not release Tailscale");
      await runtime.deleteTailnet(context);
    });
    await step("standard_tailnet_joined", async () => {
      const joined = await guest("join", "standard");
      requireFact(joined.taggedNode === true && joined.tunMode === true && joined.funnelOff === true, "standard tagged Tailscale join failed");
    });
    // The account acts; the Administrator observes its task, processes and listener, because WMI
    // refuses a standard account's network logon.
    await step("standard_interactive_ready", async () => { await runtime.rdp(context, "standard"); });
    await step("standard_candidate_installed", async () => {
      const result = await guest("installFresh", "standard"); const state = await guest("state");
      requireFact(result.ready === true && state.loopbackOnly === true, "standard fresh install did not become ready");
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
      requireFact(result.ready === true && result.readinessChanged === true && result.configPreserved === true, "standard readiness rotation invariant failed");
      facts({ standardReadinessChanged: true });
    });
    await step("standard_candidate_uninstalled", async () => {
      const result = await guest("uninstall", "standard"); const state = await guest("state");
      requireFact(state.taskPresent === false && state.gatewayProcesses === 0 && state.listeners === 0 && result.configPreserved === true && result.readinessPreserved === true,
        "standard uninstall preservation invariant failed");
      facts({ standardUninstalled: true, standardConfigPreserved: true, standardReadinessPreserved: true });
    });
    await step("evidence_complete", async () => {});
    return evidence(progress, input.identity);
  } catch (error) {
    if (runtime.development && PHASES.indexOf(progress.phase) >= PHASES.indexOf("transport_ready") && runtime.now() - progress.startedAt < 3 * 60 * 60_000) throw error;
    try { await cleanupWindows({ ...input, progress, runtime }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Windows lane and cleanup failed"); }
    throw error;
  }
}

export async function cleanupWindows(input: WindowsLaneInput): Promise<Record<string, unknown>> {
  if (input.progress === undefined) return { noAttempt: true };
  const progress = parseProgress(input.progress, binding(input.identity));
  const runtime = input.runtime ?? await createWindowsRuntime();
  const label = windowsCampaignLabel(progress.epoch);
  const failures: string[] = [];
  const causes: Error[] = [];
  const save = async () => {
    try { await input.checkpoint(structuredClone(progress)); }
    catch (error) {
      if (!failures.includes("checkpoint")) {
        failures.push("checkpoint"); causes.push(new Error(`checkpoint: ${error instanceof Error ? error.message : "write failed"}`));
      }
    }
  };
  // Teardown is idempotent and independently ownership-checked. A broken receipt
  // disk must be reported, but must not prevent destruction of the owned VM.
  const context: WindowsContext = { epoch: progress.epoch, identity: input.identity, beforeEffect: save };
  const attempt = async (name: string, action: () => Promise<void>) => {
    try { await save(); await action(); }
    catch (error) {
      failures.push(name);
      causes.push(new Error(`${name}: ${error instanceof Error ? error.message : "operation failed"}`));
    }
  };
  if (progress.cleanupRequired) {
    let ownedGuest = false;
    await attempt("guestInventory", async () => { ownedGuest = (await runtime.provider.instances()).some(item => item.label === label); });
    if (ownedGuest) {
      // After the handover Windows refuses the Administrator's Tailscale CLI while the standard account
      // operates it, and the Administrator's gateway is already uninstalled.
      const handedOver = PHASES.indexOf(progress.phase) > PHASES.indexOf("standard_tailnet_released") ||
        (progress.phase === "standard_tailnet_released" && progress.settled);
      const owner: WindowsPrincipal = handedOver ? "standard" : "administrator";
      await attempt("stopOmp", async () => { await runtime.guest(context, "stopOmp"); });
      for (const action of ["uninstall", "resetServe", "logout"] as const) await attempt(action, async () => { await runtime.guest(context, action, owner); });
    }
    await attempt("tailnetDelete", () => runtime.deleteTailnet(context));
    await attempt("instances", async () => {
      for (const match of (await runtime.provider.instances()).filter(item => item.label === label)) {
        await attempt("instanceDelete", async () => {
          const fresh = await runtime.provider.instance(match.id);
          if (!fresh) return;
          assertInstance(fresh, label, runtime); await save(); await runtime.provider.destroyInstance(fresh.id, label);
          await waitFor(runtime, async () => await runtime.provider.instance(fresh.id) === undefined, 180_000, "instance deletion");
        });
      }
    });
    await attempt("firewalls", async () => {
      for (const match of (await runtime.provider.firewalls()).filter(item => item.description === label)) {
        await attempt("firewallDelete", async () => {
          const fresh = await runtime.provider.firewall(match.id);
          if (!fresh) return;
          assertFirewall(fresh, label, runtime); await save(); await runtime.provider.destroyFirewall(fresh.id, label);
          await waitFor(runtime, async () => await runtime.provider.firewall(fresh.id) === undefined, 180_000, "firewall deletion");
        });
      }
    });
    // Device recovery can wait for another lane's lease; paid infrastructure must not.
    if (PHASES.indexOf(progress.phase) >= PHASES.indexOf("pixel_verified")) {
      await attempt("pixelRestore", () => input.pixel("windows-cleanup", () => runtime.restorePixel(context)));
    }
    await attempt("vault", async () => {
      requireFact(!failures.includes("pixelRestore"), "Pixel recovery state must be retained");
      requireFact(!(await runtime.provider.instances()).some(item => item.label === label), "instance still exists");
      await runtime.removeAccess(progress.epoch);
    });
  } else {
    await attempt("tailnetDelete", () => runtime.deleteTailnet(context));
    await attempt("vault", () => runtime.removeAccess(progress.epoch));
  }
  await attempt("instanceResidue", async () => { requireFact(!(await runtime.provider.instances()).some(item => item.label?.startsWith(QUAL_LABEL_PREFIX)), "instance residue"); });
  await attempt("firewallResidue", async () => { requireFact(!(await runtime.provider.firewalls()).some(item => item.description?.startsWith(QUAL_LABEL_PREFIX)), "firewall residue"); });
  progress.cleanupRequired = failures.length > 0; await save();
  if (failures.length) { progress.cleanupRequired = true; throw new AggregateError(causes, `Windows cleanup failed: ${failures.join(", ")}`); }
  return { epoch: progress.epoch, instancesRemaining: 0, firewallsRemaining: 0, tailnetDeleted: true, vaultRemoved: true };
}

if (import.meta.main) {
  await windowsDevelopmentCli(process.argv.slice(2));
}
