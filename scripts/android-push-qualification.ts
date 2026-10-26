import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadGatewayConfig } from "../apps/gateway/src/config.ts";
import { currentInstalledRuntime } from "../apps/gateway/src/installation.ts";
import { parseQualificationPins } from "./stable-qualification.ts";
import type { OmpPins } from "./stable-qualification.ts";
import type { PushDetailLevel, SessionMetadata } from "../packages/protocol/src/types.ts";
import type { PushFixtureCommand } from "./fixtures/push-qualification-extension.ts";
import { NotificationOverlapError, notificationTopicDigest, type NotificationObservation } from "./android-notification.ts";
import { createAndroidPushRuntime, rethrowPushSafetyFailure } from "./android-push-runtime.ts";
import { withDevelopmentPixelLease } from "./android-pixel-lease.ts";
import { executeFixture } from "./push-qualification-fixture.ts";
import { everyError, pixelUnrestored } from "./restoration.ts";
import { FAILURE_LIMITS, PUSH_BROWSER_STEPS, normalizeQualificationFailures, QualificationFailure } from "./qualification-failure.ts";
import type { QualificationLogWindow, PushDeliveryTelemetry } from "./qualification-logs.ts";

export interface PushExecution { readonly signal: AbortSignal; readonly deadline: number; readonly nextFailureId: () => number }
export interface PushDeliveryMetrics {
  firstDeliveryMs: number; secondDeliveryMs: number; deliveryRearmCount: number; deliveryRearmReason: number;
  subscriptionCount: number; sendCount: number; ackCount: number; latePostCount: number; latePostMs: number; clearMs: number;
  /** Ordered [first, second] millisecond pairs, one pair per delivery; zero second means no re-arm. */
  deliveryTimings: number[];
}
export function emptyPushDeliveryMetrics(): PushDeliveryMetrics {
  return { firstDeliveryMs: 0, secondDeliveryMs: 0, deliveryRearmCount: 0, deliveryRearmReason: 0, subscriptionCount: 0, sendCount: 0, ackCount: 0, latePostCount: 0, latePostMs: 0, clearMs: 0, deliveryTimings: [] };
}

/** Every success boundary checks both the execution budget and its own observation window. */
function pushBudgetExpired(runtime: AndroidPushRuntime, execution: PushExecution | undefined, start?: number, timeout = Infinity): boolean {
  return execution !== undefined && (execution.signal.aborted || performance.now() >= execution.deadline) ||
    start !== undefined && runtime.now() - start >= timeout;
}

function pushMilliseconds(value: number): number {
  const elapsed = Math.round(value);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > FAILURE_LIMITS.elapsedMs) throw new Error("invalid bounded Push duration");
  return elapsed;
}

async function checkedDelivery(runtime: AndroidPushRuntime, session: SessionMetadata, kind: "attention" | "activity_stop",
  detail: PushDetailLevel, privacyFailed: () => never): Promise<NotificationObservation> {
  await runtime.assertNotificationOwnership();
  const observed = await runtime.observe(session, kind, detail);
  if (observed.count > 1 || observed.forbiddenFound || observed.count === 1 && (!observed.titleMatches || !observed.bodyMatches)) privacyFailed();
  return observed;
}

function lateDeliveryObserver(observe: () => Promise<NotificationObservation>, now: () => number,
  started: number, metrics: PushDeliveryMetrics, seen = false): () => Promise<void> {
  return async () => {
    if ((await observe()).count === 1 && !seen) {
      seen = true; metrics.latePostCount++; metrics.latePostMs = pushMilliseconds(now() - started);
    }
  };
}

/** A fresh ask is issued only after a typed service failure and an authoritative old-ask clear. */
export async function waitForPushDelivery(options: {
  runtime: AndroidPushRuntime; session: SessionMetadata; detail: PushDetailLevel; kind: "attention" | "activity_stop";
  phase: AndroidPushPhase; timeout: number; metrics: PushDeliveryMetrics; window?: QualificationLogWindow;
  rearm?: (old: SessionMetadata, late: () => Promise<void>) => Promise<{ session: SessionMetadata; window?: QualificationLogWindow }>;
  execution?: PushExecution;
  onTimeout?: (sample: (() => Promise<void>) | undefined) => void;
}): Promise<SessionMetadata> {
  const { runtime, metrics } = options;
  let session = options.session, window = options.window;
  const fail = (reason: "privacy_failed" | "delivery_timeout" | "invalid_evidence" | "push_service_failure", elapsedMs: number, status = 0, cause?: unknown): never => {
    const errorOptions = cause !== undefined ? { cause } :
      options.execution?.signal.aborted ? { cause: options.execution.signal.reason } : undefined;
    const common = { id: options.execution?.nextFailureId() ?? 1, lane: "androidPush" as const, step: options.phase, elapsedMs: pushMilliseconds(elapsedMs),
      operation: "read_only" as const, observations: { firstDeliveryMs: metrics.firstDeliveryMs, secondDeliveryMs: metrics.secondDeliveryMs,
        rearmCount: metrics.deliveryRearmCount, latePostCount: metrics.latePostCount, latePostMs: metrics.latePostMs, clearMs: metrics.clearMs,
        subscriptionCount: metrics.subscriptionCount, sendCount: metrics.sendCount, ackCount: metrics.ackCount } };
    if (reason === "privacy_failed") throw new QualificationFailure({ ...common, reason, class: "product" }, errorOptions);
    if (reason === "push_service_failure") throw new QualificationFailure({ ...common, reason, class: "infra_transient",
      observations: { ...common.observations, pushServiceFailure: true, retryableStatus: true, httpStatus: status } }, errorOptions);
    if (reason === "invalid_evidence") throw new QualificationFailure({ ...common, reason, class: "harness" }, errorOptions);
    throw new QualificationFailure({ ...common, reason: "delivery_timeout", class: "harness" }, errorOptions);
  };
  const checked = (target: SessionMetadata) => checkedDelivery(runtime, target, options.kind, options.detail, () => fail("privacy_failed", 0));
  const timing = metrics.deliveryTimings.length;
  if (timing >= 128) fail("invalid_evidence", 0);
  metrics.deliveryTimings.push(0, 0);
  const exhausted = () => pushBudgetExpired(runtime, options.execution);
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = runtime.now();
    let delivered = false;
    let pollError: unknown;
    try {
      while (!pushBudgetExpired(runtime, options.execution, start, options.timeout)) {
        if ((await checked(session)).count === 1 && !pushBudgetExpired(runtime, options.execution, start, options.timeout)) {
          delivered = true;
          options.onTimeout?.(undefined);
          break;
        }
        await runtime.pause(Math.min(500, Math.max(0, options.timeout - (runtime.now() - start))));
      }
    } catch (error) {
      rethrowPushSafetyFailure(error);
      if (!exhausted() || error instanceof QualificationFailure || error instanceof NotificationOverlapError) throw error;
      pollError = error;
    }
    const elapsed = pushMilliseconds(runtime.now() - start);
    metrics.deliveryTimings[timing + attempt] = elapsed;
    if (attempt === 0 && timing === 0) metrics.firstDeliveryMs = elapsed;
    if (attempt === 1) metrics.secondDeliveryMs = elapsed;
    const timedOutSession = session;
    const late = lateDeliveryObserver(() => checked(timedOutSession), runtime.now, start, metrics, delivered);
    const requireTime = (cause?: unknown) => {
      if (!pushBudgetExpired(runtime, options.execution, start, options.timeout)) return;
      const duration = pushMilliseconds(runtime.now() - start);
      metrics.deliveryTimings[timing + attempt] = duration;
      if (attempt === 0 && timing === 0) metrics.firstDeliveryMs = duration;
      if (attempt === 1) metrics.secondDeliveryMs = duration;
      options.onTimeout?.(delivered ? undefined : late);
      fail("delivery_timeout", duration, 0, cause);
    };
    if (!delivered) {
      options.onTimeout?.(late);
      // Register cleanup sampling before telemetry I/O can fail.
      if (exhausted()) fail("delivery_timeout", elapsed, 0, pollError);
      await late();
    }
    let telemetry: PushDeliveryTelemetry | undefined;
    try { telemetry = window === undefined || runtime.deliveryTelemetry === undefined ? undefined : await runtime.deliveryTelemetry(window); }
    catch (error) { rethrowPushSafetyFailure(error); if (exhausted()) requireTime(error); return fail("invalid_evidence", elapsed, 0, error); }
    metrics.subscriptionCount = Math.max(metrics.subscriptionCount, telemetry?.subscriptionCount ?? 0);
    metrics.sendCount += telemetry?.sends ?? 0;
    metrics.ackCount += telemetry?.acknowledgements ?? 0;
    if (delivered) {
      if (options.kind === "attention" && metrics.deliveryRearmCount > 0) {
        let matches = false;
        try { matches = await runtime.deliveryRequestMatches?.(session) ?? false; }
        catch (error) { rethrowPushSafetyFailure(error); if (exhausted()) requireTime(error); throw error; }
        requireTime();
        if (!matches) fail("invalid_evidence", elapsed);
      }
      requireTime();
      options.onTimeout?.(undefined);
      return session;
    }
    if (telemetry === undefined || !telemetry.sufficient && !telemetry.retryable) return fail("delivery_timeout", elapsed);
    if (!telemetry.retryable) fail("delivery_timeout", elapsed);
    let ownedAlias: number | undefined;
    await checked(session);
    try {
      ownedAlias = await runtime.deliveryOwnership?.(session);
    } catch (error) { rethrowPushSafetyFailure(error); if (exhausted()) requireTime(error); return fail("invalid_evidence", elapsed, 0, error); }
    if (exhausted()) requireTime();
    if (ownedAlias === undefined || ownedAlias !== telemetry.requestAlias) return fail("invalid_evidence", elapsed);
    if (metrics.deliveryRearmCount !== 0 || attempt !== 0 || options.rearm === undefined) return fail("push_service_failure", elapsed, telemetry.httpStatus);
    metrics.deliveryRearmCount = 1; metrics.deliveryRearmReason = 1; // 1 = provider 429/retryable 5xx
    const fresh = await options.rearm({ ...session, qualificationPushAlias: ownedAlias }, late);
    // Rearm settled the old ask and may have installed the fresh ask's sampler; do not
    // overwrite that observer with the old timed-out request on a late return.
    if (exhausted()) fail("delivery_timeout", runtime.now() - start);
    if (fresh.session.instanceId !== session.instanceId || fresh.session.generation !== session.generation ||
      fresh.session.ask === undefined || fresh.session.ask.requestId === session.ask?.requestId) fail("invalid_evidence", elapsed);
    session = fresh.session; window = fresh.window;
  }
  throw new Error("unreachable push recovery state");
}

export interface AndroidPushIdentity {
  readonly tag: string;
  readonly candidate: { readonly tag: string; readonly sourceCommit: string; readonly archiveSha256: string; readonly archivePath: string };
  readonly omp: OmpPins;
  readonly origin: string;
}
export interface AndroidPushPreflightInput { readonly origin: string }
export interface AndroidPushAdmission { readonly android: string; readonly browser: string; readonly webApk: true; readonly dndOff: true }
export interface PushDeviceBaseline {
  readonly wifi: boolean; readonly mobile: boolean; readonly airplane: boolean;
  readonly forcedDoze: boolean; readonly batteryOverride: boolean;
  readonly awake: boolean; readonly locked: boolean; readonly webApkTask: boolean;
  readonly chromeNotificationsAllowed: boolean; readonly webApkNotificationsAllowed: boolean;
}
export interface PushBrowserBaseline {
  readonly subscribed: boolean; readonly detail: PushDetailLevel; readonly permission: "granted" | "denied" | "default";
}
export interface PushTapObservation {
  readonly launches: number; readonly successful: number; readonly currentGeneration: boolean;
  readonly currentRequest: boolean; readonly scrubbedBeforeNetwork: boolean;
  readonly writable: boolean; readonly readOnly: boolean; readonly expired: boolean;
}
export type PushNetwork = "wifi" | "cellular" | "airplane";
export type PushCleanupStep = "fixtureAsk" | "notifications" | "browser" | "doze" | "network" | "task" | "fixture";
/** The lane owns two disposable hosts; the secondary exists only for the queue-order and expiry checks. */
export type PushFixtureRole = "primary" | "secondary";
/** One device-local triage control in the installed app. `settleMs` keeps observing before the read. */
export type TriageAction =
  | { readonly kind: "hold" | "requeue" | "hide"; readonly instanceId: string; readonly settleMs?: number }
  | { readonly kind: "undo" | "showAll"; readonly settleMs?: number };
/** The rendered directory, by instance ID in display order. Volatile: never persisted or reported. */
export interface TriageObservation {
  readonly waiting: readonly string[]; readonly held: readonly string[]; readonly working: readonly string[];
  readonly hidden: number; readonly allHeld: boolean; readonly pending: number; readonly heldCount: number; readonly live: number;
  readonly toast: boolean;
  /** Non-GET requests the page sent to the gateway while the action ran and settled. */
  readonly mutations: number;
}
export interface AndroidPushRuntime {
  now(): number;
  pause(milliseconds: number): Promise<void>;
  beforeEffect: () => Promise<void>;
  beginCleanup?(execution?: PushExecution): void;
  preflight(input: AndroidPushPreflightInput): Promise<AndroidPushAdmission>;
  dndOff(): Promise<boolean>;
  device(): Promise<PushDeviceBaseline>;
  browser(): Promise<PushBrowserBaseline>;
  fixture(operation: "start" | PushFixtureCommand, epoch: string, role?: PushFixtureRole, expectedOwner?: SessionMetadata): Promise<void>;
  snapshot(epoch: string, role?: PushFixtureRole): Promise<SessionMetadata | undefined>;
  beginNotificationPhase(epoch: string, phase?: AndroidPushPhase): Promise<void>;
  assertNotificationOwnership(): Promise<void>;
  beginDeliveryTelemetry?(phase: AndroidPushPhase | "readiness"): Promise<QualificationLogWindow>;
  deliveryTelemetry?(window: QualificationLogWindow): Promise<PushDeliveryTelemetry>;
  deliveryOwnership?(session: SessionMetadata): Promise<number | undefined>;
  deliveryRequestMatches?(session: SessionMetadata): Promise<boolean>;
  subscriptionCount(): Promise<number>;
  detail(level: PushDetailLevel): Promise<void>;
  closePwa(): Promise<void>;
  openPwa(): Promise<void>;
  lock(): Promise<void>;
  observe(session: SessionMetadata, kind: "attention" | "activity_stop", detail: PushDetailLevel): Promise<NotificationObservation>;
  presentation(session: SessionMetadata, detail: PushDetailLevel): Promise<boolean>;
  tap(session: SessionMetadata, kind: "attention" | "activity_stop", stale: boolean): Promise<PushTapObservation>;
  /** Reads the installed app's directory, after performing `action` when one is given. */
  triage(action?: TriageAction): Promise<TriageObservation>;
  /**
   * Re-presents the attention notification `session` would have shown, with its metadata-only data,
   * so a later tap exercises the delayed-tap path after its clear already ran. Closes the app after.
   * While a newer ask exists on the instance, the app must already be open: launching it re-sends
   * current asks, which would replace the replay.
   */
  replay(session: SessionMetadata): Promise<void>;
  /** Closes every notification for the hosts this phase owns, then waits until the OS shows none. */
  dismissOwned(): Promise<void>;
  answer(): Promise<void>;
  forceStop(): Promise<void>;
  permission(value: "granted" | "denied" | "default"): Promise<void>;
  doze(enabled: boolean): Promise<void>;
  network(value: PushNetwork): Promise<boolean>;
  sinks(epoch: string): Promise<Record<string, boolean | number>>;
  cleanup(step: PushCleanupStep, progress: AndroidPushProgress): Promise<void>;
}

/**
 * The bound for push waits after radio changes or notification-permission restoration.
 * A radio change gives Play Services a fresh push socket, which can deliver what it held and then
 * die silently until its next reconnect: in the first v0.6.1-prealpha.1 campaign a clear sent right
 * after the Airplane recovery arrived 61 s after the answer, 0.4 s after the socket reconnected.
 * Steady-state waits keep the one-minute bound.
 */
const PUSH_RECOVERY_MS = 160_000;

export const ANDROID_PUSH_PHASES = ["baseline_captured", "subscription_ready", "private_verified", "session_verified", "preview_verified",
  "attention_tap_verified", "activity_stop_verified", "stale_generation_verified", "clear_verified", "triage_verified", "stale_taps_verified",
  "force_stop_verified", "permission_verified", "lock_resume_verified", "network_verified", "doze_verified", "forbidden_sinks_verified",
  "evidence_complete", "restored"] as const;
export type AndroidPushPhase = (typeof ANDROID_PUSH_PHASES)[number];
export interface AndroidPushProgress extends Record<string, unknown> {
  lane: "androidPush"; epoch: string; binding: string; phase: AndroidPushPhase; cleanupRequired: boolean;
  device: PushDeviceBaseline; browser: PushBrowserBaseline | null;
  notificationTopicDigest: string | null;
  /** The secondary host's topic, for cleanup of an interrupted triage or expiry check. */
  secondaryNotificationTopicDigest: string | null;
  results: Record<string, Record<string, boolean | number | string | number[]>>;
}
interface LaneInput {
  readonly identity: AndroidPushIdentity; readonly progress: unknown;
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
  readonly pixel: <T>(owner: string, action: () => Promise<T>) => Promise<T>;
  readonly runtime?: AndroidPushRuntime;
  readonly execution?: PushExecution;
}
const PROGRESS_KEYS = "binding,browser,cleanupRequired,device,epoch,lane,notificationTopicDigest,phase,results,secondaryNotificationTopicDigest";
const CLEANUP_STEPS: readonly PushCleanupStep[] = ["fixtureAsk", "doze", "network", "fixture", "notifications", "browser", "task"];
const DELIVERY_FIELDS = Object.keys(emptyPushDeliveryMetrics()).filter(key => key !== "deliveryTimings");
const RESULT_FIELDS: Partial<Record<AndroidPushPhase, readonly string[]>> = {
  subscription_ready: ["enabled"],
  private_verified: ["delivered", "locked", "singleNotification", "detailMatched", "elapsedMs"],
  session_verified: ["delivered", "locked", "singleNotification", "detailMatched", "elapsedMs"],
  preview_verified: ["delivered", "locked", "singleNotification", "detailMatched", "elapsedMs"],
  attention_tap_verified: ["control", "revalidated", "scrubbed"], activity_stop_verified: ["knownBusyPolls", "viewOnly"],
  stale_generation_verified: ["sameInstance", "generationIncrement", "launches", "scrubbed"],
  clear_verified: ["authoritativeClear", "freshRequestRetained"],
  triage_verified: ["fifo", "holdAdvanced", "heldNotificationClosed", "pendingRetained", "requeued", "allHeld", "staleHoldReleased",
    "undoRestored", "undoExpired", "attentionRestored", "shownAll", "mutations"],
  stale_taps_verified: ["resolved", "rearmed", "replaced", "expired", "launches", "scrubbed", "replayed"],
  force_stop_verified: ["variant", "freshDelivery"],
  permission_verified: ["suppressed", "freshDelivery"], lock_resume_verified: ["lockedDelivery", "resumed"],
  doze_verified: ["variant"], network_verified: ["blocked", "wifiDelivery", "cellularDelivery", "airplaneSuppressed", "recovered"],
  forbidden_sinks_verified: ["clean", "detectable", "sinks", "findings", "gatewayLogsDiscarded", "gatewayStructuredLogsSafe"], evidence_complete: ["passed"],
};

function validateOrigin(origin: string): void {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:" || url.port !== "") throw new Error("invalid Android Push origin");
}

function binding(identity: AndroidPushIdentity): string {
  validateOrigin(identity.origin);
  if (identity.tag !== identity.candidate.tag ||
    !/^[a-f0-9]{64}$/u.test(identity.candidate.archiveSha256) || !/^[a-f0-9]{40}$/u.test(identity.candidate.sourceCommit) ||
    !/^[a-f0-9]{40}$/u.test(identity.omp.sourceCommit) || !/^[a-f0-9]{40}$/u.test(identity.omp.sourceTree)) throw new Error("invalid Android Push identity");
  return createHash("sha256").update(JSON.stringify([identity.tag, identity.candidate.sourceCommit, identity.candidate.archiveSha256,
    identity.omp, identity.origin])).digest("hex");
}

export function parseAndroidPushProgress(value: unknown): AndroidPushProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid Android Push progress");
  const p = value as Record<string, unknown>;
  const keys = Object.keys(p).sort().join(",");
  // Progress written before the secondary host existed has no secondary topic, and cleans up the same way.
  if (![PROGRESS_KEYS, PROGRESS_KEYS.replace(",secondaryNotificationTopicDigest", "")].includes(keys) || p.lane !== "androidPush" ||
    typeof p.epoch !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(p.epoch) ||
    typeof p.binding !== "string" || !/^[a-f0-9]{64}$/u.test(p.binding) || typeof p.cleanupRequired !== "boolean" ||
    !ANDROID_PUSH_PHASES.includes(p.phase as AndroidPushPhase)) throw new Error("invalid Android Push progress");
  for (const digest of [p.notificationTopicDigest, p.secondaryNotificationTopicDigest ?? null]) {
    if (digest !== null && (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest))) throw new Error("invalid Android Push notification ownership");
  }
  const device = p.device;
  if (typeof device !== "object" || device === null || Array.isArray(device) ||
    Object.keys(device).sort().join(",") !== "airplane,awake,batteryOverride,chromeNotificationsAllowed,forcedDoze,locked,mobile,webApkNotificationsAllowed,webApkTask,wifi" ||
    Object.values(device).some(v => typeof v !== "boolean")) throw new Error("invalid Android Push baseline");
  const browser = p.browser;
  if (browser !== null && (typeof browser !== "object" || Array.isArray(browser) ||
    Object.keys(browser).sort().join(",") !== "detail,permission,subscribed" || !("subscribed" in browser) || typeof browser.subscribed !== "boolean" ||
    !("detail" in browser) || !["private", "session", "preview"].includes(String(browser.detail)) ||
    !("permission" in browser) || !["granted", "denied", "default"].includes(String(browser.permission)))) throw new Error("invalid Android Push browser baseline");
  if (typeof p.results !== "object" || p.results === null || Array.isArray(p.results)) throw new Error("invalid Android Push results");
  // Evidence never accepts arbitrary strings or unbounded/nested records from a saved receipt.
  for (const [phase, result] of Object.entries(p.results)) {
    if (!ANDROID_PUSH_PHASES.includes(phase as AndroidPushPhase) || typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("invalid Android Push result phase");
    for (const [key, item] of Object.entries(result)) {
      if (key === "deliveryTimings") {
        if (!Array.isArray(item) || item.length > 128 || item.length % 2 !== 0 ||
          item.some(value => !Number.isSafeInteger(value) || value < 0 || value > 86_400_000)) throw new Error("invalid per-delivery timing evidence");
        continue;
      }
      if ((key === "dndOff" && item !== true) || (key === "rearmCount" && item !== 1) ||
        (key === "rearmReason" && item !== "unowned_notification_overlap") ||
        (key === "phaseElapsedMs" && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0 || item > FAILURE_LIMITS.elapsedMs))) throw new Error("invalid Android Push phase observation");
      if ((!["dndOff", "phaseElapsedMs", "rearmCount", "rearmReason", ...DELIVERY_FIELDS].includes(key) && !RESULT_FIELDS[phase as AndroidPushPhase]?.includes(key)) || !/^[a-z][A-Za-z]{0,47}$/u.test(key) || /(capability|password|secret|authKey|token|bearer)/iu.test(key) ||
        (typeof item !== "boolean" && !(typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= FAILURE_LIMITS.elapsedMs) &&
          ["delivered_while_force_stopped", "suppressed_until_relaunch", "delivered_during_doze", "delivered_after_doze_exit", "undelivered_after_doze_exit", "cellular_path_unavailable", "unowned_notification_overlap"].includes(String(item)) === false)) throw new Error("unsafe Android Push evidence");
    }
    const recorded = result as Record<string, unknown>;
    if (DELIVERY_FIELDS.some(key => recorded[key] !== undefined && (typeof recorded[key] !== "number" || !Number.isSafeInteger(recorded[key]) || (recorded[key] as number) < 0 || (recorded[key] as number) > FAILURE_LIMITS.elapsedMs)) ||
      (recorded.deliveryRearmCount !== undefined && ![0, 1].includes(recorded.deliveryRearmCount as number)) ||
      (recorded.deliveryRearmReason !== undefined && ![0, 1].includes(recorded.deliveryRearmReason as number))) throw new Error("invalid delivery timing evidence");
    if ((recorded.rearmCount === undefined) !== (recorded.rearmReason === undefined)) throw new Error("incomplete Android Push re-arm observation");
  }
  if ((p.phase === "restored") === p.cleanupRequired) throw new Error("inconsistent Android Push cleanup state");
  return { ...p, secondaryNotificationTopicDigest: p.secondaryNotificationTopicDigest ?? null } as AndroidPushProgress;
}

export function androidPushNeedsCleanup(progress: unknown): boolean {
  return progress !== undefined && parseAndroidPushProgress(progress).cleanupRequired;
}

async function checkpointPushProgress(input: LaneInput, progress: AndroidPushProgress): Promise<void> {
  await input.checkpoint(structuredClone(parseAndroidPushProgress(progress)));
}

export async function preflightAndroidPush(input: AndroidPushPreflightInput, runtime?: AndroidPushRuntime): Promise<AndroidPushAdmission> {
  validateOrigin(input.origin);
  const host = runtime ?? createAndroidPushRuntime({ origin: input.origin,
    omp: parseQualificationPins(await readFile(join(import.meta.dir, "../UPSTREAM.lock.json"), "utf8")) });
  return host.preflight(input);
}

async function restore(input: LaneInput, runtime: AndroidPushRuntime, progress: AndroidPushProgress, sampleLate?: () => Promise<void>): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const errors: unknown[] = [];
  const priorPhase = progress.phase;
  const persistenceErrors: unknown[] = [];
  // Persistence fences new mutations, not restoration of an already captured baseline.
  runtime.beforeEffect = async () => {
    try { await checkpointPushProgress(input, progress); }
    catch (error) { persistenceErrors.push(error); }
  };
  for (const step of CLEANUP_STEPS) {
    try { await runtime.beforeEffect(); await runtime.cleanup(step, progress); } catch (error) { failures.push(step); errors.push(error); }
    if (["fixtureAsk", "doze", "network"].includes(step)) await sampleLate?.();
  }
  if (failures.length === 0 && persistenceErrors.length === 0) {
    progress.cleanupRequired = false;
    progress.phase = "restored";
  }
  await runtime.beforeEffect();
  if (persistenceErrors.length > 0) {
    progress.cleanupRequired = true;
    progress.phase = priorPhase;
  }
  if (persistenceErrors.length > 0) errors.push(new QualificationFailure({
    id: input.execution?.nextFailureId() ?? 1, lane: "androidPushCleanup", step: "containment",
    reason: "invalid_evidence", class: "harness", operation: "unknown", elapsedMs: 0, observations: { persistenceFailed: true },
  }, { cause: new AggregateError(persistenceErrors, "Android Push checkpoint persistence failed") }));
  if (errors.length > 0) throw Object.assign(new AggregateError(errors, "Android Push restoration or persistence failed"), { pixelUnrestored: true });
  return { epoch: progress.epoch, restored: true, deviceRestored: true, browserRestored: true, fixtureStopped: true };
}

export async function cleanupAndroidPush(input: LaneInput): Promise<Record<string, unknown>> {
  const progress = parseAndroidPushProgress(input.progress);
  if (progress.binding !== binding(input.identity)) throw new Error("Android Push progress belongs to a different candidate or origin");
  if (!progress.cleanupRequired) return { epoch: progress.epoch, restored: true };
  const runtime = input.runtime ?? createAndroidPushRuntime(input.identity, input.execution === undefined ? {} : { execution: input.execution });
  runtime.beginCleanup?.(input.execution);
  return input.pixel("androidPush-cleanup", () => restore(input, runtime, progress));
}

/** Effectful readiness only: this does not manufacture any qualification phase pass. */
export async function runAndroidPushReadiness(input: LaneInput): Promise<Record<string, unknown>> {
  const runtime = input.runtime ?? createAndroidPushRuntime(input.identity, input.execution === undefined ? {} : { execution: input.execution });
  await preflightAndroidPush({ origin: input.identity.origin }, runtime);
  return input.pixel("androidPush-readiness", async () => {
    const progress: AndroidPushProgress = { lane: "androidPush", epoch: randomUUID(), binding: binding(input.identity), phase: "baseline_captured",
      cleanupRequired: true, device: await runtime.device(), browser: null, notificationTopicDigest: null, secondaryNotificationTopicDigest: null, results: {} };
    runtime.beforeEffect = () => checkpointPushProgress(input, progress);
    let primary: unknown, delivered = false, roundTripMs = 0, deliveryStarted = runtime.now();
    let failureAt = deliveryStarted;
    let sampleLate: (() => Promise<void>) | undefined;
    const metrics = emptyPushDeliveryMetrics();
    const readinessFailure = (error: unknown, ancestors = new Set<unknown>()): unknown => {
      if (error instanceof AggregateError) {
        if (ancestors.has(error)) return error;
        ancestors.add(error);
        const mapped = Object.assign(new AggregateError(error.errors.map(child => readinessFailure(child, ancestors)),
          "Push readiness failures", { cause: error }), pixelUnrestored(error) ? { pixelUnrestored: true } : {});
        ancestors.delete(error);
        return mapped;
      }
      if (!(error instanceof QualificationFailure)) return error;
      let evidence = error.evidence;
      if (evidence.lane === "androidPush") {
        const common = { id: evidence.id, lane: "rigReadiness" as const, step: "pixel_push" as const,
          elapsedMs: pushMilliseconds(failureAt - deliveryStarted), operation: evidence.operation, observations: evidence.observations };
        evidence = evidence.reason === "browser_baseline_failed" ? { ...common,
          step: PUSH_BROWSER_STEPS.find(step => step === evidence.step) ?? "browser_capture", class: "harness", reason: "browser_baseline_failed" } :
          evidence.class === "product" ? { ...common, class: "product", reason: "assertion_failed" } :
          evidence.reason === "push_service_failure" ? { ...common, class: "infra_transient", reason: "push_service_failure" } :
          { ...common, class: "harness", reason: evidence.reason === "delivery_timeout" || evidence.reason === "deadline_exceeded" ? evidence.reason : "invalid_evidence" };
      }
      if (evidence.lane !== "rigReadiness") return error;
      return Object.assign(new QualificationFailure({ ...evidence,
        observations: { ...evidence.observations, subscriptionCount: metrics.subscriptionCount, sendCount: metrics.sendCount,
          ackCount: metrics.ackCount, latePostCount: metrics.latePostCount, latePostMs: metrics.latePostMs } }, { cause: error }),
        pixelUnrestored(error) ? { pixelUnrestored: true } : {});
    };
    const finalFailure = (error: unknown): unknown => {
      try { return readinessFailure(error); }
      catch (normalizationError) {
        return Object.assign(new AggregateError([error, normalizationError], "Push readiness evidence normalization failed"),
          pixelUnrestored(error) ? { pixelUnrestored: true } : {});
      }
    };
    let budgetStart: number | undefined;
    const requireBudget = () => {
      if (!pushBudgetExpired(runtime, input.execution, budgetStart, PUSH_RECOVERY_MS)) return;
      throw new QualificationFailure({ id: input.execution?.nextFailureId() ?? 1, lane: "rigReadiness", step: "pixel_push",
        class: "harness", reason: "delivery_timeout", operation: "read_only",
        elapsedMs: budgetStart === undefined ? 0 : pushMilliseconds(runtime.now() - budgetStart),
        observations: { latePostCount: metrics.latePostCount, latePostMs: metrics.latePostMs } });
    };
    const waitSnapshot = async (predicate: (session: SessionMetadata) => boolean) => {
      const start = runtime.now(), deadline = start + 90_000;
      while (runtime.now() < deadline) {
        requireBudget();
        const session = await runtime.snapshot(progress.epoch);
        requireBudget();
        if (pushBudgetExpired(runtime, input.execution, start, 90_000)) break;
        if (session !== undefined && predicate(session)) return session;
        await runtime.pause(500);
      }
      requireBudget();
      throw new QualificationFailure({ id: input.execution?.nextFailureId() ?? 1, lane: "rigReadiness", step: "pixel_push",
        class: "harness", reason: "delivery_metadata_timeout", operation: "read_only", elapsedMs: pushMilliseconds(runtime.now() - start),
        observations: { timeoutMs: 90_000 } });
    };
    try {
      await runtime.beforeEffect(); requireBudget();
      try { progress.browser = await runtime.browser(); }
      catch (error) {
        rethrowPushSafetyFailure(error);
        const failure = new QualificationFailure({ id: input.execution?.nextFailureId() ?? 1, lane: "rigReadiness", step: "browser_capture",
          class: "harness", reason: "browser_baseline_failed", operation: "unknown",
          elapsedMs: pushMilliseconds(runtime.now() - deliveryStarted), observations: {} }, { cause: error });
        try { requireBudget(); }
        catch (deadline) { throw new AggregateError([failure, deadline], "Push baseline failed at readiness deadline"); }
        throw failure;
      }
      requireBudget();
      await runtime.beforeEffect(); requireBudget();
      if (progress.browser.permission !== "granted") throw new Error("Push readiness permission prerequisite");
      await runtime.fixture("start", progress.epoch); requireBudget();
      const published = await waitSnapshot(session => session.canView && session.canControl && !session.inputRequired);
      progress.notificationTopicDigest = notificationTopicDigest(`omp-attention-${published.instanceId}`);
      await runtime.beforeEffect(); requireBudget();
      await runtime.beginNotificationPhase(progress.epoch, "private_verified"); requireBudget();
      await runtime.detail("private"); requireBudget();
      await runtime.closePwa(); requireBudget();
      await runtime.lock(); requireBudget();
      const window = await runtime.beginDeliveryTelemetry?.("readiness");
      requireBudget();
      if (window === undefined) throw new Error("Push readiness telemetry unavailable");
      let subscriptionCount: number;
      try { subscriptionCount = await runtime.subscriptionCount(); }
      catch (error) {
        rethrowPushSafetyFailure(error);
        throw new QualificationFailure({ id: input.execution?.nextFailureId() ?? 1, lane: "rigReadiness", step: "pixel_push",
          class: "harness", reason: "invalid_evidence", operation: "read_only",
          elapsedMs: pushMilliseconds(runtime.now() - deliveryStarted), observations: {} }, { cause: error });
      }
      requireBudget();
      if (!Number.isSafeInteger(subscriptionCount) || subscriptionCount < 0 || subscriptionCount > 8) throw new QualificationFailure({
        id: input.execution?.nextFailureId() ?? 1, lane: "rigReadiness", step: "pixel_push", class: "harness", reason: "invalid_evidence",
        operation: "read_only", elapsedMs: pushMilliseconds(runtime.now() - deliveryStarted), observations: {} });
      metrics.subscriptionCount = subscriptionCount;
      if (subscriptionCount !== 1) throw new QualificationFailure({
        id: input.execution?.nextFailureId() ?? 1, lane: "rigReadiness", step: "pixel_push", class: "harness",
        reason: subscriptionCount > 1 ? "stale_subscriptions" : "prerequisite_failed", operation: "read_only",
        elapsedMs: pushMilliseconds(runtime.now() - deliveryStarted), observations: { subscriptionCount, sendCount: 0, ackCount: 0 } });
      deliveryStarted = runtime.now();
      budgetStart = deliveryStarted;
      sampleLate = lateDeliveryObserver(() => checkedDelivery(runtime, published, "attention", "private", () => {
        throw new QualificationFailure({ id: input.execution?.nextFailureId() ?? 1, lane: "rigReadiness", step: "pixel_push",
          class: "product", reason: "assertion_failed", operation: "read_only", elapsedMs: 0, observations: {} });
      }), runtime.now, deliveryStarted, metrics);
      await runtime.fixture("ask", progress.epoch, "primary", published); requireBudget();
      const session = await waitSnapshot(session => session.inputRequired);
      const remaining = PUSH_RECOVERY_MS - (runtime.now() - deliveryStarted);
      await waitForPushDelivery({ runtime, session, detail: "private", kind: "attention", phase: "private_verified",
        timeout: Math.max(0, remaining), metrics, window, onTimeout: sample => { sampleLate = sample; },
        ...(input.execution === undefined ? {} : { execution: input.execution }) });
      requireBudget();
      const telemetry = await runtime.deliveryTelemetry?.(window);
      requireBudget();
      const ownedAlias = await runtime.deliveryOwnership?.(session);
      requireBudget();
      roundTripMs = pushMilliseconds(runtime.now() - deliveryStarted);
      if (telemetry?.sufficient !== true || telemetry.sends < 1 || telemetry.acknowledgements !== telemetry.sends || ownedAlias === undefined ||
        ownedAlias !== telemetry.requestAlias) throw new QualificationFailure({
        id: input.execution?.nextFailureId() ?? 1, lane: "rigReadiness", step: "pixel_push", class: "harness", reason: "invalid_evidence",
        elapsedMs: roundTripMs, operation: "read_only", observations: {} });
      // This cumulative window, not the earlier delivery poll, owns the final receipt counters.
      metrics.subscriptionCount = telemetry.subscriptionCount;
      metrics.sendCount = telemetry.sends;
      metrics.ackCount = telemetry.acknowledgements;
      const presented = await runtime.presentation(session, "private");
      requireBudget();
      if (!presented) throw new QualificationFailure({
        id: input.execution?.nextFailureId() ?? 1, lane: "rigReadiness", step: "pixel_push", class: "product", reason: "assertion_failed",
        elapsedMs: pushMilliseconds(runtime.now() - deliveryStarted), operation: "read_only", observations: {} });
      const start = runtime.now();
      budgetStart = start;
      await runtime.fixture("answer", progress.epoch); requireBudget();
      const settled = await waitSnapshot(session => !session.inputRequired);
      while (true) {
        const observed = await runtime.observe(settled, "attention", "private");
        requireBudget();
        if (observed.count === 0) break;
        await runtime.pause(500);
        requireBudget();
      }
      metrics.clearMs = pushMilliseconds(runtime.now() - start);
      requireBudget();
      delivered = true;
    } catch (error) {
      primary = error;
      failureAt = runtime.now();
    }
    runtime.beginCleanup?.();
    let cleanup: Record<string, unknown>;
    try { cleanup = await restore(input, runtime, progress, async () => {
      if (sampleLate === undefined) return;
      try { await sampleLate(); }
      catch (error) {
        primary = new AggregateError(primary === undefined ? [error] : [primary, error], "Push readiness and late observation failed");
        sampleLate = undefined;
      }
    }); }
    catch (error) {
      if (primary === undefined) failureAt = runtime.now();
      throw finalFailure(Object.assign(new AggregateError(primary === undefined ? [error] : [primary, error], "Push readiness restoration failed"), { pixelUnrestored: true }));
    }
    if (primary !== undefined) throw finalFailure(primary);
    return { delivered, acknowledged: true, elapsedMs: roundTripMs, clearMs: metrics.clearMs,
      subscriptionCount: metrics.subscriptionCount, sendCount: metrics.sendCount, ackCount: metrics.ackCount, cleanup };
  });
}

export async function runAndroidPush(input: LaneInput): Promise<Record<string, unknown>> {
  const bind = binding(input.identity);
  if (input.progress !== undefined) {
    const previous = parseAndroidPushProgress(input.progress);
    if (previous.binding !== bind) throw new Error("Android Push progress belongs to a different candidate or origin");
    if (previous.cleanupRequired) throw new Error("Android Push attempt requires cleanup before a fresh run");
  }
  const runtime = input.runtime ?? createAndroidPushRuntime(input.identity, input.execution === undefined ? {} : { execution: input.execution });
  const admission = await preflightAndroidPush({ origin: input.identity.origin }, runtime);
  return input.pixel("androidPush", async () => {
    const progress: AndroidPushProgress = { lane: "androidPush", epoch: randomUUID(), binding: bind, phase: "baseline_captured", cleanupRequired: true,
      device: await runtime.device(), browser: null, notificationTopicDigest: null, secondaryNotificationTopicDigest: null, results: {} };
    const save = async () => { await checkpointPushProgress(input, progress); };
    runtime.beforeEffect = save;
    await save();
    let primary: unknown;
    let phaseStarted = runtime.now();
    let activePhase: AndroidPushPhase = "subscription_ready";
    let metrics = emptyPushDeliveryMetrics();
    let lateDelivery: (() => Promise<void>) | undefined;
    const phaseElapsed = () => {
      try { return pushMilliseconds(runtime.now() - phaseStarted); }
      catch (error) { throw new QualificationFailure({
          id: input.execution?.nextFailureId() ?? 1, lane: "androidPush", step: activePhase, class: "harness", reason: "invalid_evidence",
          elapsedMs: 0, operation: "read_only", observations: {} }, { cause: error }); }
    };
    const requireExecution = () => {
      if (pushBudgetExpired(runtime, input.execution)) throw new QualificationFailure({
        id: input.execution?.nextFailureId() ?? 1, lane: "androidPush", step: activePhase, class: "harness", reason: "delivery_timeout",
        elapsedMs: phaseElapsed(), operation: "read_only", observations: {} },
        input.execution?.signal.aborted ? { cause: input.execution.signal.reason } : undefined);
    };
    const assertion = (message: string) => Object.assign(new QualificationFailure({
      id: input.execution?.nextFailureId() ?? 1, lane: "androidPush", step: activePhase, class: "product",
      reason: "assertion_failed", operation: "read_only", elapsedMs: pushMilliseconds(runtime.now() - phaseStarted), observations: {},
    }), { message });
    const wait = async <T>(name: string, observe: () => Promise<T | undefined>, timeout = 60_000, start = runtime.now()): Promise<T> => {
      const deadline = start + timeout;
      while (runtime.now() < deadline) {
        requireExecution();
        const result = await observe();
        requireExecution();
        if (pushBudgetExpired(runtime, input.execution, start, timeout)) break;
        if (result !== undefined) return result;
        await runtime.pause(500);
      }
      requireExecution();
      const evidence = { id: input.execution?.nextFailureId() ?? 1, lane: "androidPush" as const, step: activePhase,
        class: "harness" as const, operation: "read_only" as const,
        elapsedMs: pushMilliseconds(runtime.now() - start), observations: { timeoutMs: timeout } };
      if (name === "metadata") throw new QualificationFailure({ ...evidence, reason: "delivery_metadata_timeout" });
      throw new QualificationFailure({ ...evidence, reason: "delivery_timeout" });
    };
    const snapshot = async (predicate: (s: SessionMetadata) => boolean, role: PushFixtureRole = "primary") => wait("metadata", async () => {
      const session = await runtime.snapshot(progress.epoch, role);
      return session !== undefined && predicate(session) ? session : undefined;
    }, 90_000);
    const assertDndOff = async () => { if (!await runtime.dndOff()) throw new Error("turn Do Not Disturb off on the Pixel for the qualification window"); };
    const fixture = async (operation: "start" | PushFixtureCommand, role: PushFixtureRole = "primary", expectedOwner?: SessionMetadata) => {
      if (!["answer", "stop"].includes(operation)) await assertDndOff();
      await save();
      requireExecution();
      let verifiedOwner: SessionMetadata | undefined;
      if (expectedOwner !== undefined) {
        const owner = await runtime.snapshot(progress.epoch, role);
        requireExecution();
        if (owner === undefined || owner.instanceId !== expectedOwner.instanceId || owner.generation !== expectedOwner.generation ||
          owner.inputRequired || !owner.canControl) throw new QualificationFailure({
          id: input.execution?.nextFailureId() ?? 1, lane: "androidPush", step: activePhase, class: "harness", reason: "invalid_evidence",
          operation: "read_only", elapsedMs: phaseElapsed(), observations: {} });
        verifiedOwner = owner;
      }
      await runtime.fixture(operation, progress.epoch, role, verifiedOwner);
      requireExecution();
    };
    const finish = async (phase: AndroidPushPhase, result: Record<string, boolean | number | string>) => {
      await assertDndOff();
      requireExecution();
      if (phase !== "subscription_ready" && phase !== "evidence_complete") await runtime.assertNotificationOwnership();
      requireExecution();
      const now = runtime.now();
      progress.phase = phase; progress.results[phase] = { ...progress.results[phase], ...metrics, ...result, dndOff: true, phaseElapsedMs: phaseElapsed() };
      phaseStarted = now; await save(); requireExecution();
    };
    const clear = async (timeout = 60_000, role: PushFixtureRole = "primary") => {
      const start = runtime.now();
      await fixture("answer", role);
      await wait("authoritative clear", async () => {
        const current = await runtime.snapshot(progress.epoch, role);
        if (current === undefined || current.inputRequired) return undefined;
        return (await runtime.observe(current, "attention", "private")).count === 0 ? true : undefined;
      }, timeout, start);
      metrics.clearMs = pushMilliseconds(metrics.clearMs + runtime.now() - start);
    };
    const delivered = async (session: SessionMetadata, kind: "attention" | "activity_stop" = "attention", detail: PushDetailLevel = "session", timeout = 60_000) => {
      // Caller-issued/overlapping asks have no unique send window and cannot authorize re-arm.
      await waitForPushDelivery({ runtime, session, kind, detail, timeout, phase: activePhase, metrics,
        onTimeout: sample => { lateDelivery = sample; },
        ...(input.execution === undefined ? {} : { execution: input.execution }) });
    };
    const delivery = async (detail: PushDetailLevel, kind: "attention" | "activity_stop" = "attention", arm = true, timeout = 60_000, existingWindow?: QualificationLogWindow) => {
      if (arm) { await runtime.detail(detail); await runtime.closePwa(); await runtime.lock(); }
      const window = arm ? await runtime.beginDeliveryTelemetry?.(activePhase) : existingWindow;
      const owner = await runtime.snapshot(progress.epoch);
      lateDelivery = owner === undefined ? undefined : lateDeliveryObserver(() => checkedDelivery(runtime, owner, kind, detail, () => {
        throw new QualificationFailure({ id: input.execution?.nextFailureId() ?? 1, lane: "androidPush", step: activePhase,
          class: "product", reason: "privacy_failed", operation: "read_only", elapsedMs: phaseElapsed(), observations: {} });
      }), runtime.now, runtime.now(), metrics);
      if (arm) await fixture("ask");
      const session = await snapshot(s => kind === "attention" ? s.inputRequired : s.busy === false);
      const start = runtime.now();
      const observed = await waitForPushDelivery({ runtime, session, kind, detail, timeout, phase: activePhase, metrics,
        onTimeout: sample => { lateDelivery = sample; },
        ...(window === undefined ? {} : { window }), ...(input.execution === undefined ? {} : { execution: input.execution }),
        ...((arm || existingWindow !== undefined) && kind === "attention" ? { rearm: async (old: SessionMetadata, late: () => Promise<void>) => {
          const clearing = runtime.now();
          const clearWindow = await runtime.beginDeliveryTelemetry?.(activePhase);
          await fixture("answer");
          const settled = await wait("authoritative clear before re-arm", async () => {
            await late();
            const current = await runtime.snapshot(progress.epoch);
            if (current === undefined || current.inputRequired) return undefined;
            const telemetry = clearWindow === undefined ? undefined : await runtime.deliveryTelemetry?.(clearWindow);
            return telemetry?.clearAcknowledged === true && telemetry.requestAlias === old.qualificationPushAlias &&
              (await runtime.observe(current, "attention", detail)).count === 0 ? current : undefined;
          }, timeout, clearing);
          lateDelivery = undefined;
          metrics.clearMs = pushMilliseconds(metrics.clearMs + runtime.now() - clearing);
          const nextWindow = await runtime.beginDeliveryTelemetry?.(activePhase);
          lateDelivery = lateDeliveryObserver(() => checkedDelivery(runtime, settled, "attention", detail, () => {
            throw new QualificationFailure({ id: input.execution?.nextFailureId() ?? 1, lane: "androidPush", step: activePhase,
              class: "product", reason: "privacy_failed", operation: "read_only", elapsedMs: phaseElapsed(), observations: {} });
          }), runtime.now, runtime.now(), metrics);
          await fixture("ask", "primary", old);
          const fresh = await snapshot(s => s.inputRequired && s.ask?.requestId !== old.ask?.requestId);
          return { session: fresh, ...(nextWindow === undefined ? {} : { window: nextWindow }) };
        } } : {}) });
      return { session: observed, milliseconds: pushMilliseconds(runtime.now() - start) };
    };
    const attempt = async (phase: AndroidPushPhase, action: () => Promise<void>): Promise<void> => {
      activePhase = phase; phaseStarted = runtime.now(); metrics = emptyPushDeliveryMetrics();
      for (let index = 0; index < 2; index += 1) {
        try { await runtime.beginNotificationPhase(progress.epoch, phase); requireExecution(); await action(); requireExecution(); return; }
        catch (error) {
          try {
            progress.results[phase] = { ...progress.results[phase], ...metrics, phaseElapsedMs: phaseElapsed() };
            await save();
          } catch (persistenceError) { throw new AggregateError([error, persistenceError], "Android Push phase and checkpoint failed"); }
          if (!everyError(error, nested => nested instanceof NotificationOverlapError)) throw error;
          if (index !== 0) throw error;
          lateDelivery = undefined;
          progress.results[phase] = { ...progress.results[phase], rearmCount: 1, rearmReason: "unowned_notification_overlap" };
          await save();
          // Re-arm only for an observed foreign post, never for a missing required event.
          await runtime.beginNotificationPhase(progress.epoch, phase);
          await runtime.doze(false);
          if (!await runtime.network("wifi")) throw new Error("Android Push overlap recovery needs the Wi-Fi tailnet path");
          await runtime.permission("granted");
          await fixture("release");
          // Settle every owned ask and let its authoritative clear land, then dismiss what remains: an
          // activity-stop notice has no clear, so waiting for its tag to empty never ends.
          for (const role of ["primary", "secondary"] as const) {
            const clearing = runtime.now();
            const host = await runtime.snapshot(progress.epoch, role);
            if (host === undefined) continue;
            if (host.inputRequired) await fixture("answer", role);
            await wait("authoritative clear", async () => {
              const settled = await runtime.snapshot(progress.epoch, role);
              if (settled === undefined || settled.inputRequired || settled.busy !== false) return undefined;
              const observation = await runtime.observe(settled, "attention", "private");
              return observation.count === 0 || !observation.titleMatches ? true : undefined;
            }, PUSH_RECOVERY_MS, clearing);
          }
          await runtime.dismissOwned();
          await runtime.closePwa();
        }
      }
    };
    try {
      progress.browser = await runtime.browser();
      await save();
      if (progress.browser.permission !== "granted") throw new Error("grant origin notification permission before Android Push qualification");
      await fixture("start");
      const published = await snapshot(s => s.canView && s.canControl && s.busy === false);
      progress.notificationTopicDigest = notificationTopicDigest(`omp-attention-${published.instanceId}`);
      await save();
      await runtime.detail("private");
      await finish("subscription_ready", { enabled: true });
      for (const level of ["private", "session", "preview"] as const) {
        await attempt(`${level}_verified`, async () => {
          const observed = await delivery(level);
          if (!await runtime.presentation(observed.session, level)) throw assertion("Android Push lock-screen presentation did not match selected detail");
          await runtime.pause(21_000);
          const duplicate = await runtime.observe(observed.session, "attention", level);
          if (duplicate.count !== 1 || !duplicate.titleMatches || !duplicate.bodyMatches || duplicate.forbiddenFound) throw assertion("Android Push repeated delivery changed presentation");
          await clear();
          await finish(`${level}_verified`, { delivered: true, locked: true, singleNotification: true, detailMatched: true, elapsedMs: observed.milliseconds });
        });
      }
      await attempt("attention_tap_verified", async () => {
        const attention = await delivery("session");
        const tapped = await runtime.tap(attention.session, "attention", false);
        if (tapped.launches !== 1 || tapped.successful !== 1 || !tapped.currentGeneration || !tapped.currentRequest || !tapped.scrubbedBeforeNetwork || !tapped.writable) {
          throw assertion("Android Push attention tap did not revalidate into Control");
        }
        await runtime.answer(); await snapshot(s => !s.inputRequired); await clear();
        await finish("attention_tap_verified", { control: true, revalidated: true, scrubbed: true });
      });
      const stop = async () => {
        await runtime.detail("session");
        await fixture("busy");
        const busy = await snapshot(s => s.busy === true);
        await runtime.closePwa();
        await runtime.pause(21_000);
        await wait("second known-busy poll", async () => {
          const continued = await runtime.snapshot(progress.epoch);
          if (continued?.busy !== true || continued.generation !== busy.generation) throw assertion("Android Push busy changed before a second poll");
          return continued.lastSeenAt !== busy.lastSeenAt ? true : undefined;
        }, 90_000);
        await fixture("release");
        return delivery("session", "activity_stop", false);
      };
      await attempt("activity_stop_verified", async () => {
        const stopped = await stop();
        const stopTap = await runtime.tap(stopped.session, "activity_stop", false);
        if (stopTap.launches !== 1 || stopTap.successful !== 1 || !stopTap.currentGeneration || !stopTap.scrubbedBeforeNetwork || !stopTap.readOnly || stopTap.writable) throw assertion("Android Push stop tap did not open View only");
        await finish("activity_stop_verified", { knownBusyPolls: 2, viewOnly: true });
      });
      await attempt("stale_generation_verified", async () => {
        const old = await stop(); await fixture("replace");
        const replacement = await snapshot(s => s.generation === old.session.generation + 1);
        if (replacement.instanceId !== old.session.instanceId) throw assertion("Android Push replacement changed instance");
        const stale = await runtime.tap(old.session, "activity_stop", true);
        if (stale.launches !== 0 || !stale.scrubbedBeforeNetwork || !stale.expired || stale.writable || stale.readOnly) throw assertion("Android Push stale tap did not fail closed");
        await finish("stale_generation_verified", { sameInstance: true, generationIncrement: 1, launches: 0, scrubbed: true });
      });
      await attempt("clear_verified", async () => {
        await delivery("private"); await clear();
        const rearmed = await delivery("private");
        await runtime.pause(21_000);
        if ((await runtime.observe(rearmed.session, "attention", "private")).count !== 1) throw assertion("Android Push fresh request did not remain visible");
        await clear();
        await finish("clear_verified", { authoritativeClear: true, freshRequestRetained: true });
      });
      // Both checks below need the second owned host, and a re-armed attempt starts from settled asks.
      const prepareSecondary = async () => {
        if (await runtime.snapshot(progress.epoch, "secondary") === undefined) await fixture("start", "secondary");
        const host = await snapshot(s => s.canView && s.canControl && s.busy === false, "secondary");
        progress.secondaryNotificationTopicDigest = notificationTopicDigest(`omp-attention-${host.instanceId}`);
        await save();
        for (const role of ["primary", "secondary"] as const) {
          if ((await runtime.snapshot(progress.epoch, role))?.inputRequired === true) await clear(60_000, role);
        }
        await runtime.detail("session");
        // The secondary's posts are owned from here on.
        await runtime.beginNotificationPhase(progress.epoch);
        return host;
      };
      const same = (actual: readonly string[], expected: readonly string[]) => actual.length === expected.length && actual.every((id, index) => id === expected[index]);
      await attempt("triage_verified", async () => {
        const secondary = await prepareSecondary();
        const primary = await snapshot(s => !s.inputRequired);
        const owned = [primary.instanceId, secondary.instanceId];
        let view = await runtime.triage();
        for (const id of view.held.filter(held => owned.includes(held))) view = await runtime.triage({ kind: "requeue", instanceId: id });
        if (owned.some(id => !view.working.includes(id))) view = await runtime.triage({ kind: "showAll" });
        // Order, Hold and Show all act on the whole device-local directory, so nothing else may wait or be hidden.
        if (view.waiting.length > 0 || view.held.length > 0 || view.hidden > 0) throw new Error("Android Push triage needs a directory where no other session waits for input or is hidden");
        await runtime.closePwa();
        await fixture("ask");
        const first = await snapshot(s => s.inputRequired);
        // A distinct ask time makes the queue order observable rather than an instance-ID tie-break.
        await runtime.pause(1_500);
        await fixture("ask", "secondary");
        const second = await snapshot(s => s.inputRequired, "secondary");
        if (first.ask === undefined || second.ask === undefined || first.ask.since >= second.ask.since) throw new Error("Android Push fixture asks are not ordered in time");
        await delivered(first); await delivered(second);
        const pending = async () => {
          const [left, right] = [await runtime.snapshot(progress.epoch), await runtime.snapshot(progress.epoch, "secondary")];
          return left?.ask?.requestId === first.ask?.requestId && right?.ask?.requestId === second.ask?.requestId;
        };
        view = await runtime.triage();
        if (!same(view.waiting, [first.instanceId, second.instanceId]) || view.pending !== 2 || view.heldCount !== 0) throw assertion("Android Push directory did not queue asks in arrival order");
        view = await runtime.triage({ kind: "hold", instanceId: first.instanceId });
        if (!same(view.waiting, [second.instanceId]) || !same(view.held, [first.instanceId]) || view.pending !== 2 || view.heldCount !== 1 || view.mutations !== 0) throw assertion("Android Push Hold did not advance the queue on this device alone");
        if (!await pending()) throw assertion("Android Push Hold changed the authoritative asks");
        await wait("held notification close", async () => (await runtime.observe(first, "attention", "session")).count === 0 ? true : undefined, 15_000);
        if ((await runtime.observe(second, "attention", "session")).count !== 1) throw assertion("Android Push Hold closed another ask's notification");
        view = await runtime.triage({ kind: "requeue", instanceId: first.instanceId });
        if (!same(view.waiting, [first.instanceId, second.instanceId]) || view.held.length !== 0 || view.mutations !== 0) throw assertion("Android Push requeue did not restore arrival order");
        view = await runtime.triage({ kind: "hold", instanceId: first.instanceId });
        view = await runtime.triage({ kind: "hold", instanceId: second.instanceId });
        if (!view.allHeld || view.waiting.length !== 0 || !same(view.held, [first.instanceId, second.instanceId]) || view.pending !== 2 || view.heldCount !== 2 || view.mutations !== 0) throw assertion("Android Push Hold-all did not report a held queue");
        if (!await pending()) throw assertion("Android Push Hold-all changed the authoritative asks");
        // A replaced request is a new ask: only its stale hold goes.
        await clear(60_000, "secondary");
        await fixture("ask", "secondary");
        const renewed = await snapshot(s => s.inputRequired && s.ask !== undefined && s.ask.requestId !== second.ask?.requestId, "secondary");
        await delivered(renewed);
        view = await runtime.triage();
        if (!same(view.waiting, [renewed.instanceId]) || !same(view.held, [first.instanceId]) || view.pending !== 2 || view.heldCount !== 1) throw assertion("Android Push replaced request kept its stale hold");
        await runtime.triage({ kind: "requeue", instanceId: first.instanceId });
        await clear(); await clear(60_000, "secondary");
        // Hide is device-local: Undo inside its window, then no mutation when the window expires.
        view = await runtime.triage({ kind: "hide", instanceId: first.instanceId });
        // The live total still counts the hidden row: the OMP process keeps running.
        if (view.working.includes(first.instanceId) || view.hidden !== 1 || !view.toast || view.live !== view.working.length + 1 || view.mutations !== 0) throw assertion("Android Push Hide did not hide the row on this device alone");
        view = await runtime.triage({ kind: "undo" });
        if (!view.working.includes(first.instanceId) || view.hidden !== 0 || view.toast || view.mutations !== 0) throw assertion("Android Push Undo did not restore the hidden row");
        view = await runtime.triage({ kind: "hide", instanceId: first.instanceId, settleMs: 6_500 });
        if (view.working.includes(first.instanceId) || view.hidden !== 1 || view.toast || view.live !== view.working.length + 1 || view.mutations !== 0) throw assertion("Android Push expired Undo window changed state");
        await fixture("ask");
        const returned = await snapshot(s => s.inputRequired);
        view = await runtime.triage();
        if (!same(view.waiting, [returned.instanceId]) || view.hidden !== 0) throw assertion("Android Push attention did not restore the hidden row");
        await clear();
        await runtime.triage({ kind: "hide", instanceId: secondary.instanceId });
        view = await runtime.triage({ kind: "showAll" });
        if (owned.some(id => !view.working.includes(id)) || view.hidden !== 0 || view.mutations !== 0) throw assertion("Android Push Show all did not restore hidden rows");
        await runtime.closePwa();
        await finish("triage_verified", { fifo: true, holdAdvanced: true, heldNotificationClosed: true, pendingRetained: true, requeued: true, allHeld: true,
          staleHoldReleased: true, undoRestored: true, undoExpired: true, attentionRestored: true, shownAll: true, mutations: 0 });
      });
      await attempt("stale_taps_verified", async () => {
        await prepareSecondary();
        // Each delayed tap re-presents a notification whose clear already ran, then taps it on the lock screen.
        const staleTap = async (stale: SessionMetadata, cause: string) => {
          await runtime.replay(stale);
          const tapped = await runtime.tap(stale, "attention", true);
          if (tapped.launches !== 0 || !tapped.scrubbedBeforeNetwork || !tapped.expired || tapped.writable || tapped.readOnly) throw assertion(`Android Push ${cause} request tap did not fail closed`);
        };
        const resolved = await delivery("session"); await clear();
        await staleTap(resolved.session, "resolved");
        // Launching the app re-saves its subscription, and the gateway then re-sends every current ask,
        // which would replace a replay on the same tag. Open and settle the app before the newer ask.
        const newer = async (stale: SessionMetadata) => {
          await runtime.openPwa();
          await fixture("ask");
          await delivered(await snapshot(s => s.inputRequired && s.ask !== undefined && s.ask.requestId !== stale.ask?.requestId));
        };
        const earlier = await delivery("session"); await clear();
        await newer(earlier.session);
        await staleTap(earlier.session, "re-armed");
        await clear();
        const replaced = await delivery("session"); await clear();
        await fixture("replace");
        const replacement = await snapshot(s => s.generation === replaced.session.generation + 1);
        if (replacement.instanceId !== replaced.session.instanceId) throw assertion("Android Push replacement changed instance");
        await newer(replaced.session);
        await staleTap(replaced.session, "replaced-generation");
        await clear();
        await runtime.closePwa(); await runtime.lock();
        await fixture("ask", "secondary");
        const expiring = await snapshot(s => s.inputRequired, "secondary");
        await delivered(expiring);
        await fixture("stop", "secondary");
        await wait("secondary unpublication", async () => await runtime.snapshot(progress.epoch, "secondary") === undefined ? true : undefined, 45_000);
        // Removing a host with an open ask sends its clear; one landing after the replay would close it.
        await wait("secondary removal clear", async () => (await runtime.observe(expiring, "attention", "private")).count === 0 ? true : undefined, 60_000);
        await staleTap(expiring, "expired-host");
        await finish("stale_taps_verified", { resolved: true, rearmed: true, replaced: true, expired: true, launches: 0, scrubbed: true, replayed: true });
      });
      await attempt("force_stop_verified", async () => {
        // Its privacy check reads Private notices; the triage and delayed-tap phases leave Session.
        await runtime.detail("private"); await runtime.forceStop(); await fixture("ask");
        const forced = await snapshot(s => s.inputRequired);
        let whileStopped = false;
        for (let elapsed = 0; elapsed < 30_000; elapsed += 500) {
          const observation = await runtime.observe(forced, "attention", "private");
          if (observation.count > 1 || observation.forbiddenFound || (observation.count === 1 && (!observation.titleMatches || !observation.bodyMatches))) throw assertion("Android Push force-stop privacy failure");
          requireExecution();
          whileStopped ||= observation.count === 1; await runtime.pause(500);
        }
        await runtime.openPwa(); await clear(); await delivery("private"); await clear();
        await finish("force_stop_verified", { variant: whileStopped ? "delivered_while_force_stopped" : "suppressed_until_relaunch", freshDelivery: true });
      });
      await attempt("permission_verified", async () => {
        await runtime.permission("denied"); await runtime.closePwa(); await fixture("ask");
        const denied = await snapshot(s => s.inputRequired);
        for (let elapsed = 0; elapsed < 30_000; elapsed += 500) {
          if ((await runtime.observe(denied, "attention", "private")).count !== 0) throw assertion("Android Push permission revocation did not suppress notification");
          requireExecution();
          await runtime.pause(500);
        }
        await fixture("answer"); await snapshot(s => !s.inputRequired);
        await runtime.permission("granted");
        // Permission restoration reopens the app and reconciles its subscription:
        // the first background delivery is recovery, not steady state.
        await delivery("private", "attention", true, PUSH_RECOVERY_MS); await clear();
        await finish("permission_verified", { suppressed: true, freshDelivery: true });
      });
      await attempt("lock_resume_verified", async () => {
        await runtime.lock(); await delivery("private"); await runtime.openPwa(); await clear();
        await finish("lock_resume_verified", { lockedDelivery: true, resumed: true });
      });
      await attempt("network_verified", async () => {
        // Each push wait here follows a radio change, so it allows the recovery window.
        if (!await runtime.network("wifi")) throw new Error("Android Push Wi-Fi tailnet path unavailable");
        await delivery("private", "attention", true, PUSH_RECOVERY_MS); await clear(PUSH_RECOVERY_MS);
        const cellular = await runtime.network("cellular");
        if (cellular) {
          await delivery("private", "attention", true, PUSH_RECOVERY_MS); await clear(PUSH_RECOVERY_MS);
        }
        // Missing cellular service blocks that sub-phase, not the independent offline/recovery proof.
        if (!await runtime.network("airplane")) throw new Error("Android Push Airplane state unavailable");
        const offlineWindow = await runtime.beginDeliveryTelemetry?.(activePhase);
        await fixture("ask");
        const offline = await snapshot(s => s.inputRequired);
        for (let elapsed = 0; elapsed < 30_000; elapsed += 500) {
          if ((await runtime.observe(offline, "attention", "private")).count !== 0) throw assertion("Android Push delivered while offline");
          requireExecution();
          await runtime.pause(500);
        }
        if (offlineWindow !== undefined) await runtime.deliveryTelemetry?.(offlineWindow);
        if (!await runtime.network("wifi")) throw new Error("Android Push restored Wi-Fi tailnet path unavailable");
        // Restoring the WebAPK may replay its subscription; that is not the original send.
        const restoredWindow = await runtime.beginDeliveryTelemetry?.(activePhase);
        await delivery("private", "attention", false, PUSH_RECOVERY_MS, restoredWindow);
        await clear(PUSH_RECOVERY_MS);
        await finish("network_verified", { wifiDelivery: true, ...(cellular ? { cellularDelivery: true } : { blocked: "cellular_path_unavailable" }), airplaneSuppressed: true, recovered: true });
      });
      await attempt("doze_verified", async () => {
        await runtime.closePwa(); await runtime.doze(true); await fixture("ask");
        const sleeping = await snapshot(s => s.inputRequired);
        let duringDoze = false;
        for (let elapsed = 0; elapsed < 30_000; elapsed += 500) {
          const observation = await runtime.observe(sleeping, "attention", "private");
          if (observation.count > 1 || observation.forbiddenFound || (observation.count === 1 && (!observation.titleMatches || !observation.bodyMatches))) throw assertion("Android Push Doze privacy failure");
          requireExecution();
          duringDoze ||= observation.count === 1; await runtime.pause(500);
        }
        await runtime.doze(false);
        // Forced Doze is an observed variant, never a delivery guarantee (ADR-031): FCM has held a push
        // for minutes after Doze ended. Privacy holds for anything that arrives; the ask is settled either way.
        let afterExit = false;
        const observationStart = runtime.now();
        while (!duringDoze && !afterExit && !pushBudgetExpired(runtime, input.execution, observationStart, 60_000)) {
          const observed = await runtime.observe(sleeping, "attention", "private");
          if (observed.count > 1 || observed.forbiddenFound || (observed.count === 1 && (!observed.titleMatches || !observed.bodyMatches))) throw assertion("Android Push Doze recovery privacy failure");
          requireExecution();
          if (pushBudgetExpired(runtime, input.execution, observationStart, 60_000)) break;
          afterExit = observed.count === 1;
          if (!afterExit) await runtime.pause(500);
        }
        // After forced Doze the phone's frozen browser can defer pushes until it runs again: in both
        // prealpha.3 campaigns an ask or clear waited minutes, until another lane opened Chrome. The
        // variant above is observed with the app closed; resuming it once lets a deferred ask or clear
        // run here rather than on the owner's phone after the lane. Doze is therefore the last delivery phase.
        const clearing = runtime.now();
        await fixture("answer");
        const settled = await wait("authoritative clear after Doze", async () => {
          const current = await runtime.snapshot(progress.epoch);
          return current !== undefined && !current.inputRequired ? current : undefined;
        }, 60_000, clearing);
        await runtime.openPwa();
        await wait("authoritative clear after Doze", async () => (await runtime.observe(settled, "attention", "private")).count === 0 ? true : undefined, 60_000, clearing);
        await runtime.closePwa();
        await finish("doze_verified", { variant: duringDoze ? "delivered_during_doze" : afterExit ? "delivered_after_doze_exit" : "undelivered_after_doze_exit" });
      });
      await attempt("forbidden_sinks_verified", async () => {
        await runtime.network("wifi");
        const sinks = await runtime.sinks(progress.epoch);
        if (sinks.gatewayStructuredLogsSafe !== true) throw new QualificationFailure({
          id: input.execution?.nextFailureId() ?? 1, lane: "androidPush", step: activePhase, class: "harness", reason: "invalid_evidence",
          operation: "read_only", elapsedMs: pushMilliseconds(runtime.now() - phaseStarted), observations: {} });
        if (sinks.clean !== true || sinks.detectable !== true || sinks.gatewayLogsDiscarded !== true) throw new QualificationFailure({
          id: input.execution?.nextFailureId() ?? 1, lane: "androidPush", step: activePhase, class: "product", reason: "privacy_failed",
          operation: "read_only", elapsedMs: pushMilliseconds(runtime.now() - phaseStarted), observations: {} });
        await finish("forbidden_sinks_verified", sinks);
      });
      await finish("evidence_complete", { passed: !progress.results.network_verified?.blocked });
    } catch (error) { primary = error; }
    let cleanup: Record<string, unknown>;
    runtime.beginCleanup?.();
    try { cleanup = await restore(input, runtime, progress, async () => {
      if (lateDelivery === undefined) return;
      try { await lateDelivery(); } catch (error) {
        primary = new AggregateError(primary === undefined ? [error] : [primary, error], "Push delivery and late observation failed");
        lateDelivery = undefined;
      }
      progress.results[activePhase] = { ...progress.results[activePhase], ...metrics };
    }); }
    catch (error) {
      const failure = new AggregateError(primary === undefined ? [error] : [primary, error], "Android Push run/cleanup failed");
      if (pixelUnrestored(error)) Object.assign(failure, { pixelUnrestored: true });
      throw failure;
    }
    if (primary !== undefined) throw primary;
    return { epoch: progress.epoch, binding: bind, passed: progress.results.evidence_complete?.passed === true,
      platform: admission, ompVersion: input.identity.omp.version, bunVersion: input.identity.omp.bunVersion, phases: progress.results, cleanup };
  });
}

if (import.meta.main) {
  const [mode, archive] = process.argv.slice(2);
  if (!["development", "cleanup"].includes(mode ?? "") || archive === undefined) throw new Error("usage: android-push-qualification.ts development|cleanup <published-archive>");
  const config = await loadGatewayConfig();
  const installed = await currentInstalledRuntime(config);
  if (installed === undefined) throw new Error("development run needs an installed gateway; it never installs one");
  const release = JSON.parse(await readFile(join(installed.directory, "release-info.json"), "utf8"));
  const archivePath = resolve(archive);
  const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  const entries = await executeFixture(["tar", "-tf", archivePath]);
  const manifests = entries.stdout.trim().split("\n").filter(entry => entry.endsWith("/release-info.json"));
  if (entries.exitCode !== 0 || manifests.length !== 1) throw new Error("published archive identity is unavailable");
  const manifest = await executeFixture(["tar", "-xOf", archivePath, manifests[0]!]);
  const archived = JSON.parse(manifest.stdout);
  if (manifest.exitCode !== 0 || archived.product !== "OMP Session Gateway" || archived.version !== release.version || archived.sourceCommit !== release.sourceCommit) throw new Error("published archive does not match the installed development gateway");
  const identity: AndroidPushIdentity = { tag: `v${release.version}`,
    candidate: { tag: `v${release.version}`, sourceCommit: release.sourceCommit, archiveSha256: digest, archivePath },
    omp: parseQualificationPins(await readFile(join(import.meta.dir, "../UPSTREAM.lock.json"), "utf8")), origin: config.http.publicOrigin };
  const directory = join(homedir(), ".local/share/omp-session-gateway/qualification/dev/androidPush");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "progress.json");
  let progress: unknown = await readFile(path, "utf8").then(text => JSON.parse(text)).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  // A restored attempt for another candidate, origin or OMP pin needs no cleanup: keep it beside the new one.
  if (mode === "development" && progress !== undefined) {
    const previous = parseAndroidPushProgress(progress);
    if (!previous.cleanupRequired && previous.binding !== binding(identity)) {
      await rename(path, join(directory, `progress-${previous.epoch}-restored.json`));
      progress = undefined;
    }
  }
  const checkpoint = async (next: Record<string, unknown>) => {
    await writeFile(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    if (typeof progress !== "object" || progress === null || !("phase" in progress) || next.phase !== progress.phase) console.log(JSON.stringify({ phase: next.phase }));
    progress = next;
  };
  const pixel = async <T>(_owner: string, action: () => Promise<T>): Promise<T> => {
    return withDevelopmentPixelLease("PushLane androidPush", action, () => progress === undefined || !androidPushNeedsCleanup(progress), "/tmp/omp-gw-pixel.lock", true);
  };
  try {
    const result = await (mode === "cleanup" ? cleanupAndroidPush : runAndroidPush)({ identity, progress, checkpoint, pixel });
    await writeFile(join(directory, "tested-evidence.json"), JSON.stringify({ development: true, qualified: false, gatewayVersion: release.version, result }), { mode: 0o600 });
    console.log(JSON.stringify({ development: true, qualified: false, gatewayVersion: release.version, result }));
  } catch (error) {
    console.error(JSON.stringify({ failures: normalizeQualificationFailures(error) }));
    process.exitCode = 1;
  }
}
