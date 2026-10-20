/**
 * The stable campaign's `deviceCloud` lane (ADR-032): the exact signed candidate on real cloud
 * iPhone, iPad and Android devices, through the retained Mac's candidate gateway.
 *
 * Each device runs the directory, View, Control, prompt and return journey plus the self-verifying
 * capability-sink sweep on the campaign's live OMP session, the one the Pixel's core lane drives.
 * The iPhone also installs the Home Screen app, enables background alerts with a real tap, and taps
 * an attention alert from the lane's own stock-OMP fixture into Control. Afterwards every
 * vendor-retained test record is searched for both sessions' live View and Control links.
 *
 * The lane holds the Pixel lease from its first effect until it has released every session, the
 * tunnel, the fixture, and its workspace. Its prompts and alert raise Web Push to every subscription
 * on the candidate gateway, which would land in the middle of the Pixel lanes. The cleanup lane
 * repeats that release only for an attempt that stopped before finishing it.
 */
import { createHash, randomUUID } from "node:crypto";
import { isRecord } from "../packages/collab-client/upstream/src/tool-render/util.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import { fixtureModelError } from "./omp-fixture.ts";
import type { OmpPins, PixelLease } from "./stable-qualification.ts";
import { TESTINGBOT_TUNNEL } from "./testingbot.ts";
import { TESTINGBOT_SESSION_ID, BROWSERSTACK_SESSION_ID } from "./device-cloud-webdriver.ts";
import type { TestRecord, DeviceCloudVendor } from "./device-cloud-common.ts";
import { BROWSERSTACK_LOCAL, BROWSERSTACK_MODELS, browserStackModel } from "./browserstack.ts";

export interface DeviceCloudIdentity {
  readonly tag: string;
  readonly candidate: { readonly tag: string; readonly sourceCommit: string; readonly archiveSha256: string; readonly archivePath: string };
  readonly omp: OmpPins;
  /** The candidate gateway's Tailscale Serve origin on the retained Mac. */
  readonly origin: string;
}

export const DEVICE_CLOUD_TARGETS = ["iphone", "ipad", "android"] as const;
export type DeviceCloudTarget = (typeof DEVICE_CLOUD_TARGETS)[number];

export const DEVICE_CLOUD_VENDOR_POLICY = {
  iphone: ["testingbot"], ipad: ["testingbot", "browserstack"], android: ["testingbot", "browserstack"],
} as const;

export interface DeviceCloudSessionRef {
  readonly vendor: DeviceCloudVendor;
  readonly target: DeviceCloudTarget;
  readonly sessionId: string;
}

export interface DeviceCloudResource {
  vendor: DeviceCloudVendor;
  target: DeviceCloudTarget;
  /** Absent means creation was intended but its outcome is not known. Never infer absence. */
  sessionId?: string;
  ended: boolean;
  audited: boolean;
  recordRemoved: boolean;
}

export interface DeviceProfile {
  readonly platform: "iOS" | "Android";
  readonly browser: "safari" | "chrome";
  /** In preference order; the first one free is used, and the evidence names it. */
  readonly models: readonly string[];
  readonly minimumOsMajor: number;
  /** Catalog members awaiting a bounded, capability-free allocation proof. */
  readonly disabledModels: readonly string[];
  readonly homeScreenAlerts: boolean;
}

export const DEVICE_CLOUD_PROFILES: Readonly<Record<DeviceCloudTarget, DeviceProfile>> = {
  iphone: { platform: "iOS", browser: "safari", models: ["iPhone 17 Pro Max", "iPhone 17 Pro", "iPhone 16", "iPhone 16 Pro", "iPhone Air", "iPhone 17"], minimumOsMajor: 26, disabledModels: [], homeScreenAlerts: true },
  ipad: { platform: "iOS", browser: "safari", models: ["iPad (9th generation)"], minimumOsMajor: 26, disabledModels: [], homeScreenAlerts: false },
  android: { platform: "Android", browser: "chrome", models: ["Galaxy S26", "Galaxy S25", "Galaxy S24", "Galaxy A55"], minimumOsMajor: 14, disabledModels: ["Galaxy A55"], homeScreenAlerts: false },
};

export const SAMSUNG_MODEL_CODES: Readonly<Record<string, readonly string[]>> = {
  "Galaxy S24": ["SM-S921B"],
  "Galaxy S25": ["SM-S931B"],
  "Galaxy S26": ["SM-S942B"],
};

export function eligibleDevice(profile: DeviceProfile, device: { readonly name: string; readonly platform: string; readonly version: string }): boolean {
  return device.platform === profile.platform && profile.models.includes(device.name) && !profile.disabledModels.includes(device.name) &&
    VERSION.test(device.version) && Number(device.version.split(".")[0]) >= profile.minimumOsMajor;
}

export const DEVICE_CLOUD_PHASES = [
  "attempt_started", "fixture_ready", "tunnel_ready", "iphone_verified", "ipad_verified", "android_verified",
  "records_audited", "evidence_complete", "restored",
] as const;
export type DeviceCloudPhase = (typeof DEVICE_CLOUD_PHASES)[number];

export type DeviceCloudObservation = boolean | number | string;
export type DeviceCloudResults = Partial<Record<DeviceCloudTarget | "audit", Record<string, DeviceCloudObservation>>>;

export interface DeviceCloudProgress extends Record<string, unknown> {
  lane: "deviceCloud";
  epoch: string;
  binding: string;
  phase: DeviceCloudPhase;
  cleanupRequired: boolean;
  /** Every WebDriver session this attempt created, recorded before the session is driven. */
  sessions: string[];
  /** Additive schema-3 ownership. sessions remains the TestingBot-only projection. */
  resources?: DeviceCloudResource[];
  tunnels?: DeviceCloudVendor[];
  results: DeviceCloudResults;
}

export interface DeviceCloudTargetAttempt {
  readonly epoch: string;
  /** The campaign's live OMP session, which every web journey drives. */
  readonly session: SessionMetadata;
  readonly allocating: (vendor: DeviceCloudVendor) => Promise<void>;
  readonly startingTunnel: (vendor: DeviceCloudVendor) => Promise<void>;
  /** Persists vendor-qualified identity before any subsequent command. */
  readonly created: (reference: DeviceCloudSessionRef) => Promise<void>;
}

export interface DeviceCloudRuntime {
  now(): number;
  pause(milliseconds: number): Promise<void>;
  /** Read-only: tools, credentials, and a pinned model for every target in the vendor catalog. */
  admit(): Promise<void>;
  /** The lane's own stock-OMP fixture, whose attention request the iPhone's alert carries. */
  fixture(operation: "start" | "stop", epoch: string): Promise<void>;
  fixtureSession(epoch: string): Promise<SessionMetadata | undefined>;
  liveSession(label: string): Promise<SessionMetadata | undefined>;
  tunnel(operation: "start" | "stop", epoch: string, vendor: DeviceCloudVendor): Promise<void>;
  /** Allocates a device, runs the target's journeys, and ends its session. */
  verify(target: DeviceCloudTarget, attempt: DeviceCloudTargetAttempt): Promise<Record<string, DeviceCloudObservation>>;
  endSession(reference: DeviceCloudSessionRef): Promise<void>;
  record(reference: DeviceCloudSessionRef): Promise<TestRecord | undefined>;
  removeRecord(reference: DeviceCloudSessionRef, auditClean: boolean): Promise<number>;
  /** A live capability through the candidate gateway's launch contract, for the record audit only. */
  launch(session: SessionMetadata, mode: "view" | "control"): Promise<string>;
  removeWorkspace(epoch: string): Promise<void>;
}

export interface DeviceCloudLaneInput {
  readonly identity: DeviceCloudIdentity;
  /** The label of the campaign's live OMP session, the one the Pixel's core lane also drives. */
  readonly sessionLabel: string;
  readonly progress: unknown;
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
  readonly pixel: PixelLease;
  readonly runtime: DeviceCloudRuntime;
}

const FIXTURE_PUBLICATION_MS = 2 * 60 * 1_000;
/** TestingBot finalizes a record a few seconds after its session ends. */
const RECORD_FINALIZATION_MS = 3 * 60 * 1_000;
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const OBSERVATION_NAME = /^[a-z][A-Za-z]{0,47}$/u;
const SECRET_NAME = /(capability|password|secret|authKey|token|bearer)/iu;
const VERSION = /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/u;

/**
 * The only observations that may be text, each from a fixed grammar. Vendor and device text never
 * reaches progress otherwise: a free-form field could carry a link or reflect a credential.
 */
const OBSERVATION_TEXT: Readonly<Record<string, (value: string) => boolean>> = {
  device: value => Object.values(DEVICE_CLOUD_PROFILES).some(profile => profile.models.includes(value)) ||
    Object.values(BROWSERSTACK_MODELS).some(models => models.some(model => model.canonical === value)),
  model: value => /^SM-[A-Z0-9]{1,12}$/u.test(value),
  os: value => VERSION.test(value),
  browser: value => value === "safari" || value === "chrome",
  browserVersion: value => VERSION.test(value),
  pushServiceHost: value => value === "web.push.apple.com",
  vendor: value => value === "TestingBot" || value === "BrowserStack",
  tunnelVersion: value => value === TESTINGBOT_TUNNEL.version || value === BROWSERSTACK_LOCAL.version,
};

function safeObservations(result: Record<string, unknown>): boolean {
  return Object.entries(result).every(([name, item]) =>
    OBSERVATION_NAME.test(name) && !SECRET_NAME.test(name) && (
      typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item) && item >= 0) ||
      (typeof item === "string" && Object.hasOwn(OBSERVATION_TEXT, name) && OBSERVATION_TEXT[name]!(item))
    ));
}

/** Parsed inside the page; raw user agents and arbitrary client hints never enter vendor results. */
export interface BrowserAllocationReport {
  readonly family: "iphone" | "ipad" | "android" | "unknown";
  readonly browser: "safari" | "chrome" | "unknown";
  readonly browserVersion: string;
  readonly os: string;
  readonly model: string;
}

export const ALLOCATION_REPORT_EXPRESSION = `(async () => {
  const ua = navigator.userAgent;
  const version = value => typeof value === "string" && /^[0-9]{1,4}(?:\\.[0-9]{1,4}){0,3}$/.test(value) ? value : "";
  const family = /\\biPhone\\b/.test(ua) ? "iphone" :
    /\\biPad\\b/.test(ua) || (/\\bMacintosh\\b/.test(ua) && navigator.maxTouchPoints > 1) ? "ipad" :
    /\\bAndroid\\b/.test(ua) ? "android" : "unknown";
  const safari = /\\bVersion\\/([0-9.]{1,24}) (?:Mobile\\/\\S+ )?Safari\\//.exec(ua)?.[1];
  const isSafari = safari !== undefined && !/\\b(?:CriOS|FxiOS|EdgiOS)\\//.test(ua);
  const isChrome = /\\bChrome\\//.test(ua) && !/\\b(?:SamsungBrowser|EdgA|OPR|Firefox)\\//.test(ua);
  const hints = isChrome ? await navigator.userAgentData?.getHighEntropyValues?.(["uaFullVersion", "platformVersion", "model"]).catch(() => undefined) : undefined;
  return {
    family, browser: isSafari ? "safari" : isChrome ? "chrome" : "unknown",
    browserVersion: version(isSafari ? safari : hints?.uaFullVersion),
    os: version(isSafari ? safari?.split(".").slice(0, 2).join(".") : hints?.platformVersion),
    model: typeof hints?.model === "string" && /^SM-[A-Z0-9]{1,12}$/.test(hints.model) ? hints.model : "",
  };
})()`;

export interface AllocationReport {
  /** The capabilities the selected vendor returned for its allocated session. */
  readonly capabilities: Record<string, unknown>;
  readonly browser: BrowserAllocationReport;
  readonly vendorRecord?: { readonly device: string; readonly os: string; readonly osVersion: string; readonly browser: string };
}

/**
 * The device as its session and browser report it, refused unless it is the requested platform,
 * kind of device, browser, and OS release, so evidence never names hardware nobody observed. An
 * iPhone or iPad reports its model only through TestingBot's session and its release through
 * Safari's version, which ships in lockstep with iOS. A Galaxy reports its model code and release
 * through Chrome's client hints, and its evidence names the requested model beside that code.
 */
export function attestAllocation(
  vendor: DeviceCloudVendor,
  target: DeviceCloudTarget,
  requested: { readonly name: string; readonly version: string },
  report: AllocationReport,
): Record<string, DeviceCloudObservation> {
  const profile = DEVICE_CLOUD_PROFILES[target];
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const leading = (version: string, parts: number) => version.split(".").slice(0, parts).join(".");
  const { capabilities, browser } = report;
  const fallback = vendor === "browserstack" && target !== "iphone"
    ? browserStackModel(target, { ...requested, platform: target === "ipad" ? "ios" : "android" }) : undefined;
  if (vendor === "browserstack") {
    const allocation = report.vendorRecord;
    if (fallback === undefined || allocation === undefined || allocation.device !== requested.name ||
      allocation.os !== fallback.platform || !VERSION.test(allocation.osVersion) ||
      leading(allocation.osVersion, 1) !== leading(requested.version, 1) ||
      allocation.browser !== (target === "ipad" ? "ipad" : "chrome_android")) {
      throw new Error("BrowserStack allocation does not match the pinned target, model, OS and browser");
    }
  } else if (!eligibleDevice(profile, { ...requested, platform: profile.platform })) throw new Error(`the ${target} requested model or OS is not eligible`);
  if (
    text(capabilities.platformName).toLowerCase() !== profile.platform.toLowerCase() ||
    text(capabilities.browserName).toLowerCase() !== profile.browser
  ) {
    throw new Error(`TestingBot allocated the ${target} session on another platform or browser`);
  }
  if (!isRecord(browser) || Object.keys(browser).sort().join(",") !== "browser,browserVersion,family,model,os" || browser.family !== target) {
    throw new Error(`the ${target} session's browser reports another kind of device`);
  }
  if (profile.browser === "safari") {
    const safari = browser.browserVersion;
    if (browser.browser !== "safari" || typeof safari !== "string" || !VERSION.test(safari) || !VERSION.test(browser.os)) {
      throw new Error(`the ${target} session's browser is not Safari`);
    }
    const model = text(capabilities.deviceName);
    if (model !== requested.name) throw new Error(`TestingBot allocated another model for the ${target}`);
    const parts = vendor === "browserstack" ? requested.version.split(".").length : 2;
    if (leading(safari, parts) !== leading(requested.version, parts) || browser.os !== leading(safari, 2)) throw new Error(`the ${target} runs another iOS release`);
    return { device: fallback?.canonical ?? model, os: leading(safari, 2), browser: "safari", browserVersion: safari };
  }
  const version = text(browser.browserVersion);
  const release = text(browser.os);
  const model = text(browser.model);
  if (!VERSION.test(version) || browser.browser !== "chrome") {
    throw new Error(`the ${target} session's browser is not Chrome`);
  }
  if (!VERSION.test(release) || leading(release, 1) !== leading(requested.version, 1)) throw new Error(`the ${target} runs another Android release`);
  if (!/^SM-[A-Z0-9]{1,12}$/u.test(model)) throw new Error(`the ${target} is not a Galaxy phone`);
  const canonical = fallback?.canonical ?? requested.name;
  if (!SAMSUNG_MODEL_CODES[canonical]?.includes(model)) throw new Error(`the ${target} Galaxy hardware does not match its canonical model`);
  return { device: canonical, model, os: release, browser: "chrome", browserVersion: version };
}

/** Binds progress to the candidate, OMP, origin, device profiles, and tunnel it was recorded against. */
function binding(identity: DeviceCloudIdentity): string {
  const origin = new URL(identity.origin);
  if (origin.origin !== identity.origin || origin.protocol !== "https:") throw new Error("invalid device-cloud origin");
  if (
    identity.tag !== identity.candidate.tag || !/^[a-f0-9]{64}$/u.test(identity.candidate.archiveSha256) ||
    !/^[a-f0-9]{40}$/u.test(identity.candidate.sourceCommit) || !/^[a-f0-9]{40}$/u.test(identity.omp.sourceCommit) ||
    !/^[a-f0-9]{40}$/u.test(identity.omp.sourceTree)
  ) {
    throw new Error("invalid device-cloud identity");
  }
  return createHash("sha256").update(JSON.stringify([
    identity.tag, identity.candidate.sourceCommit, identity.candidate.archiveSha256, identity.omp, identity.origin,
    DEVICE_CLOUD_PROFILES, SAMSUNG_MODEL_CODES, TESTINGBOT_TUNNEL.sha256,
    DEVICE_CLOUD_VENDOR_POLICY, BROWSERSTACK_MODELS, BROWSERSTACK_LOCAL.sha256, "connect-policy-2",
  ])).digest("hex");
}

/** Refuses anything but the exact progress shape, and any evidence that could carry a secret. */
export function parseDeviceCloudProgress(value: unknown): DeviceCloudProgress {
  if (
    !isRecord(value) || Object.keys(value).some(key => !["binding", "cleanupRequired", "epoch", "lane", "phase", "results", "sessions", "resources", "tunnels"].includes(key)) ||
    value.lane !== "deviceCloud" || typeof value.epoch !== "string" || !EPOCH.test(value.epoch) ||
    typeof value.binding !== "string" || !/^[a-f0-9]{64}$/u.test(value.binding) || typeof value.cleanupRequired !== "boolean" ||
    !DEVICE_CLOUD_PHASES.some(phase => phase === value.phase)
  ) {
    throw new Error("invalid device-cloud progress");
  }
  if (value.resources !== undefined || value.tunnels !== undefined) {
    if (!Array.isArray(value.resources) || value.resources.length > 3 || !Array.isArray(value.tunnels) ||
      value.tunnels.length > 2 || new Set(value.tunnels).size !== value.tunnels.length ||
      value.tunnels.some(vendor => vendor !== "testingbot" && vendor !== "browserstack")) throw new Error("invalid device-cloud vendor ownership");
    const targets = new Set<string>();
    const references = new Set<string>();
    for (const resource of value.resources) {
      if (!isRecord(resource) || Object.keys(resource).sort().join(",") !==
        (resource.sessionId === undefined ? "audited,ended,recordRemoved,target,vendor" : "audited,ended,recordRemoved,sessionId,target,vendor") ||
        (resource.vendor !== "testingbot" && resource.vendor !== "browserstack") ||
        !DEVICE_CLOUD_TARGETS.some(target => target === resource.target) || typeof resource.target !== "string" ||
        (resource.vendor === "browserstack" && resource.target === "iphone") ||
        typeof resource.ended !== "boolean" || typeof resource.audited !== "boolean" || typeof resource.recordRemoved !== "boolean" ||
        targets.has(resource.target)) throw new Error("invalid device-cloud allocation resource");
      targets.add(resource.target);
      if (resource.sessionId === undefined) {
        if (resource.ended || resource.audited || resource.recordRemoved || value.cleanupRequired !== true) throw new Error("inconsistent pending cloud allocation");
      } else {
        if (typeof resource.sessionId !== "string" || !(resource.vendor === "testingbot" ? TESTINGBOT_SESSION_ID : BROWSERSTACK_SESSION_ID).test(resource.sessionId) ||
          references.has(`${resource.vendor}:${resource.sessionId}`)) throw new Error("invalid vendor-qualified cloud session");
        references.add(`${resource.vendor}:${resource.sessionId}`);
      }
      if (!value.tunnels.includes(resource.vendor) || (resource.recordRemoved && (!resource.ended || resource.vendor !== "browserstack"))) throw new Error("inconsistent cloud resource lifecycle");
      if (value.cleanupRequired === false && (!resource.ended || (resource.vendor === "browserstack" && !resource.recordRemoved))) throw new Error("unreleased cloud resource");
    }
    const projected = value.resources.filter(resource => resource.vendor === "testingbot" && resource.sessionId !== undefined).map(resource => resource.sessionId);
    if (JSON.stringify(projected) !== JSON.stringify(value.sessions)) throw new Error("invalid legacy cloud session projection");
  }
  const sessions = value.sessions;
  if (
    !Array.isArray(sessions) || sessions.length > DEVICE_CLOUD_TARGETS.length ||
    sessions.some(id => typeof id !== "string" || !TESTINGBOT_SESSION_ID.test(id))
  ) {
    throw new Error("invalid device-cloud session record");
  }
  if (!isRecord(value.results)) throw new Error("invalid device-cloud results");
  for (const [key, result] of Object.entries(value.results)) {
    if ((key !== "audit" && !DEVICE_CLOUD_TARGETS.some(target => target === key)) || !isRecord(result)) {
      throw new Error("invalid device-cloud result");
    }
    if (!safeObservations(result)) throw new Error("unsafe device-cloud evidence");
    if (key !== "audit" && Array.isArray(value.resources)) {
      const resource = value.resources.find(resource => resource.target === key);
      if (resource === undefined || result.vendor !== (resource.vendor === "testingbot" ? "TestingBot" : "BrowserStack")) throw new Error("device-cloud evidence vendor does not match its owned session");
    }
  }
  if ((value.phase === "restored") === value.cleanupRequired) throw new Error("inconsistent device-cloud cleanup state");
  return value as DeviceCloudProgress;
}

export function deviceCloudNeedsCleanup(progress: unknown): boolean {
  return progress !== undefined && parseDeviceCloudProgress(progress).cleanupRequired;
}

function ownedResources(progress: DeviceCloudProgress): DeviceCloudResource[] {
  return progress.resources ?? progress.sessions.map((sessionId, index) => ({
    vendor: "testingbot", target: DEVICE_CLOUD_TARGETS[index]!, sessionId, ended: false, audited: false, recordRemoved: false,
  }));
}

function sessionReference(resource: DeviceCloudResource): DeviceCloudSessionRef {
  if (resource.sessionId === undefined) throw new Error("an ambiguous cloud allocation requires operator reconciliation");
  return { vendor: resource.vendor, target: resource.target, sessionId: resource.sessionId };
}

async function waitFor<T>(
  runtime: DeviceCloudRuntime,
  name: string,
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = runtime.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (runtime.now() >= deadline) throw new Error(`device-cloud ${name} timed out`);
    await runtime.pause(2_000);
  }
}

/**
 * Searches every record the vendor kept for the live View and Control links of both sessions the
 * devices opened. The links exist only in this function's memory: nothing derived from them is
 * returned, saved, or logged. A generation change would make the search look for the wrong links,
 * so it fails instead.
 */
async function auditRecords(
  runtime: DeviceCloudRuntime,
  progress: DeviceCloudProgress,
  driven: readonly (readonly [SessionMetadata, () => Promise<SessionMetadata | undefined>])[],
  save: () => Promise<void>,
): Promise<Record<string, DeviceCloudObservation>> {
  const records: { resource: DeviceCloudResource; record: TestRecord }[] = [];
  const failures: Error[] = [];
  for (const resource of ownedResources(progress)) {
    try {
      const record = await waitFor(runtime, "test record finalization", async () => {
        const record = await runtime.record(sessionReference(resource));
        return record?.complete === true ? record : undefined;
      }, RECORD_FINALIZATION_MS);
      records.push({ resource, record });
    } catch {
      failures.push(new Error("a device-cloud retained record could not be audited"));
    }
  }
  const needles: string[] = [];
  for (const [before, reread] of driven) {
    const current = await reread();
    if (current === undefined || current.instanceId !== before.instanceId || current.generation !== before.generation) {
      throw new Error("a device-cloud session changed generation before its vendor records were audited");
    }
    for (const mode of ["view", "control"] as const) {
      const link = await runtime.launch(current, mode);
      needles.push(link);
    }
  }
  const windows = new Set<string>();
  for (const link of needles) {
    for (let index = 0; index + 16 <= link.length; index += 1) windows.add(link.slice(index, index + 16));
  }
  let exposing = 0;
  let withMedia = 0;
  let lingeringSignedArtifacts = 0;
  for (const { resource, record } of records) {
    let leaks = false;
    if (needles.some(link => record.text.includes(link))) leaks = true;
    for (let index = 0; index + 16 <= record.text.length; index += 1) {
      if (windows.has(record.text.slice(index, index + 16))) { leaks = true; break; }
    }
    const media = record.video || record.screenshots > 0;
    if (leaks) exposing += 1;
    if (media) withMedia += 1;
    resource.audited = !leaks && !media;
    try { await save(); } catch { failures.push(new Error("a cloud record audit could not be checkpointed")); }
    if (resource.vendor === "browserstack" && resource.ended) {
      try {
        lingeringSignedArtifacts += await runtime.removeRecord(sessionReference(resource), resource.audited);
        resource.recordRemoved = true;
        await save();
      } catch { failures.push(new Error("BrowserStack record removal could not be verified")); }
    }
  }
  const audit = {
    records: records.length, recordsExposingLinks: exposing, recordsWithMedia: withMedia, lingeringSignedArtifacts,
    testingbotRecords: records.filter(({ resource }) => resource.vendor === "testingbot").length,
    browserstackRecords: records.filter(({ resource }) => resource.vendor === "browserstack").length,
  };
  progress.results.audit = audit;
  await save();
  if (exposing > 0) failures.push(new Error(`${exposing} of ${records.length} cloud test records contain a live View or Control link`));
  if (withMedia > 0) failures.push(new Error(`cloud vendors kept video or screenshots for ${withMedia} of ${records.length} sessions`));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "device-cloud retained-record audits failed");
  return audit;
}

export async function preflightDeviceCloud(runtime: DeviceCloudRuntime): Promise<void> {
  await runtime.admit();
}

/** Drives one attempt from its fixture to its record audit; the caller releases it either way. */
async function drive(input: DeviceCloudLaneInput, progress: DeviceCloudProgress, save: () => Promise<void>): Promise<Record<string, unknown>> {
  const { runtime } = input;
  const driven: (readonly [SessionMetadata, () => Promise<SessionMetadata | undefined>])[] = [];
  const failures: unknown[] = [];
  const advance = async (phase: DeviceCloudPhase) => {
    progress.phase = phase;
    await save();
  };
  try {
    await runtime.fixture("start", progress.epoch);
    const fixture = await waitFor(runtime, "fixture publication", () => runtime.fixtureSession(progress.epoch), FIXTURE_PUBLICATION_MS);
    const live = await waitFor(runtime, "live session", () => runtime.liveSession(input.sessionLabel), FIXTURE_PUBLICATION_MS);
    for (const session of [fixture, live]) {
      const modelError = fixtureModelError(session);
      if (modelError !== undefined) throw new Error(modelError);
      if (!session.canView || !session.canControl) throw new Error("a device-cloud session does not offer View and Control");
    }
    driven.push([live, () => runtime.liveSession(input.sessionLabel)], [fixture, () => runtime.fixtureSession(progress.epoch)]);
    await advance("fixture_ready");
    progress.tunnels!.push("testingbot");
    await save();
    await runtime.tunnel("start", progress.epoch, "testingbot");
    await advance("tunnel_ready");
    for (const target of DEVICE_CLOUD_TARGETS) {
      const targetFailures: unknown[] = [];
      let observations: Record<string, DeviceCloudObservation> | undefined;
      try {
        observations = await runtime.verify(target, {
          epoch: progress.epoch,
          session: live,
          allocating: async vendor => {
            if (progress.resources!.some(resource => resource.target === target) || (target === "iphone" && vendor !== "testingbot")) throw new Error("invalid cloud allocation intent");
            progress.resources!.push({ vendor, target, ended: false, audited: false, recordRemoved: false });
            await save();
          },
          startingTunnel: async vendor => {
            if (!progress.tunnels!.includes(vendor)) { progress.tunnels!.push(vendor); await save(); }
          },
          created: async reference => {
            const resource = progress.resources!.find(resource => resource.target === target);
            if (resource === undefined || resource.vendor !== reference.vendor || reference.target !== target || resource.sessionId !== undefined ||
              !(reference.vendor === "testingbot" ? TESTINGBOT_SESSION_ID : BROWSERSTACK_SESSION_ID).test(reference.sessionId) ||
              progress.resources!.some(owned => owned.vendor === reference.vendor && owned.sessionId === reference.sessionId)) throw new Error("cloud session does not match its allocation intent");
            resource.sessionId = reference.sessionId;
            if (reference.vendor === "testingbot") progress.sessions.push(reference.sessionId);
            await save();
          },
        });
      } catch (error) { targetFailures.push(error); }
      // Targets are sequential: never retain active devices behind the next allocation.
      for (const resource of ownedResources(progress).filter(resource => resource.target === target && !resource.ended)) {
        try { await runtime.endSession(sessionReference(resource)); resource.ended = true; await save(); }
        catch { targetFailures.push(new Error("a device-cloud target session did not end before the next allocation")); }
      }
      if (targetFailures.length === 1) throw targetFailures[0];
      if (targetFailures.length > 1) throw new AggregateError(targetFailures, "device-cloud target and session release failed");
      if (observations === undefined) throw new Error("device-cloud target returned no observations");
      if (!safeObservations(observations)) throw new Error(`unsafe device-cloud evidence from the ${target}`);
      progress.results[target] = observations;
      await advance(`${target}_verified`);
    }
  } catch (error) {
    failures.push(error);
  }
  // The retained record is finalized only after end; still inspect every record on partial attempts.
  for (const resource of ownedResources(progress)) {
    if (resource.ended) continue;
    try { await runtime.endSession(sessionReference(resource)); resource.ended = true; await save(); }
    catch { failures.push(new Error("a device-cloud session did not end before its record audit")); }
  }
  let audit: Record<string, DeviceCloudObservation> | undefined;
  try {
    audit = ownedResources(progress).length === 0 ? { records: 0, recordsExposingLinks: 0, recordsWithMedia: 0 } :
      await auditRecords(runtime, progress, driven, save);
    await advance("records_audited");
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "the device-cloud journey, session end or record audit failed");
  await advance("evidence_complete");
  return {
    passed: true,
    vendor: progress.resources!.every(resource => resource.vendor === "testingbot") ? "TestingBot" : "mixed",
    tunnelVersion: progress.resources!.every(resource => resource.vendor === "testingbot") ? TESTINGBOT_TUNNEL.version : "per-target",
    targets: Object.fromEntries(DEVICE_CLOUD_TARGETS.map(target => [target, progress.results[target]])),
    audit,
  };
}

/**
 * Ends every recorded session, stops the tunnel and fixture, and removes the workspace. Each step
 * runs even if another fails, and only a complete release marks the attempt restored.
 */
async function release(runtime: DeviceCloudRuntime, progress: DeviceCloudProgress, save: () => Promise<void>): Promise<Record<string, unknown>> {
  try {
    const failures: string[] = [];
    const attempt = async (step: string, action: () => Promise<void>) => {
      try {
        await action();
      } catch {
        // Raw errors can carry vendor identifiers; the step name is the evidence.
        failures.push(step);
      }
    };
    await attempt("sessions", async () => {
      let ended = 0;
      for (const resource of ownedResources(progress)) {
        try {
          if (!resource.ended) { await runtime.endSession(sessionReference(resource)); resource.ended = true; await save(); }
          if (resource.vendor === "browserstack" && !resource.recordRemoved) {
            await runtime.removeRecord(sessionReference(resource), resource.audited);
            resource.recordRemoved = true;
            await save();
          }
          ended += 1;
        } catch {
          // Keep ending the others.
        }
      }
      if (ended !== ownedResources(progress).length) throw new Error("a cloud session or record was not released");
    });
    for (const vendor of progress.tunnels ?? ["testingbot"]) {
      await attempt(`${vendor}Tunnel`, () => runtime.tunnel("stop", progress.epoch, vendor));
    }
    await attempt("fixture", () => runtime.fixture("stop", progress.epoch));
    if (!ownedResources(progress).some(resource => resource.sessionId === undefined)) await attempt("workspace", () => runtime.removeWorkspace(progress.epoch));
    if (failures.length > 0) throw new Error(`device-cloud cleanup failed: ${failures.join(", ")}`);
    progress.cleanupRequired = false;
    progress.phase = "restored";
    await save();
    return { epoch: progress.epoch, restored: true, sessionsEnded: ownedResources(progress).length, tunnelStopped: true, fixtureStopped: true };
  } catch (error) {
    // createPixelLease's existing restoration helper recognizes this flag through aggregates.
    throw Object.assign(error instanceof Error ? error : new Error("device-cloud cleanup failed"), { pixelUnrestored: true });
  }
}

export async function runDeviceCloud(input: DeviceCloudLaneInput): Promise<Record<string, unknown>> {
  const bind = binding(input.identity);
  if (input.progress !== undefined) {
    const previous = parseDeviceCloudProgress(input.progress);
    if (previous.binding !== bind) throw new Error("device-cloud progress belongs to a different candidate, origin, or device profile");
    // A driven session cannot be resumed mid-journey: release everything, then start a fresh attempt.
    if (previous.cleanupRequired) throw new Error("device-cloud attempt requires cleanup before a fresh run");
  }
  const { runtime } = input;
  await runtime.admit();
  // One lease turn covers the attempt and its release, so no Pixel lane starts while its sessions,
  // tunnel, or fixture remain.
  return input.pixel("deviceCloud", async () => {
    const progress: DeviceCloudProgress = {
      lane: "deviceCloud", epoch: randomUUID(), binding: bind, phase: "attempt_started", cleanupRequired: true, sessions: [], resources: [], tunnels: [], results: {},
    };
    // Only progress the parser accepts is saved, so the cleanup lane can always read it back.
    const save = async () => { await input.checkpoint(structuredClone(parseDeviceCloudProgress(progress))); };
    await save();
    let result: Record<string, unknown> | undefined;
    let failure: unknown;
    try {
      result = await drive(input, progress, save);
    } catch (error) {
      failure = error;
    }
    try {
      await release(runtime, progress, save);
    } catch (releaseError) {
      failure = Object.assign(failure === undefined ? releaseError as Error : new AggregateError([failure, releaseError], "the device-cloud attempt and its release failed"), { pixelUnrestored: true });
    }
    if (result === undefined || failure !== undefined) throw failure;
    return result;
  });
}

/** Releases an attempt that stopped before its own release finished. */
export async function cleanupDeviceCloud(input: DeviceCloudLaneInput): Promise<Record<string, unknown>> {
  const progress = parseDeviceCloudProgress(input.progress);
  if (progress.binding !== binding(input.identity)) throw new Error("device-cloud progress belongs to a different candidate, origin, or device profile");
  if (!progress.cleanupRequired) return { epoch: progress.epoch, restored: true };
  return input.pixel("deviceCloud-cleanup", () =>
    release(input.runtime, progress, async () => { await input.checkpoint(structuredClone(parseDeviceCloudProgress(progress))); }));
}
