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
import { createAndroidPushRuntime } from "./android-push-runtime.ts";
import { withDevelopmentPixelLease } from "./android-pixel-lease.ts";
import { executeFixture } from "./push-qualification-fixture.ts";
import { everyError, pixelUnrestored } from "./restoration.ts";

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
  preflight(input: AndroidPushPreflightInput): Promise<AndroidPushAdmission>;
  dndOff(): Promise<boolean>;
  device(): Promise<PushDeviceBaseline>;
  browser(): Promise<PushBrowserBaseline>;
  fixture(operation: "start" | PushFixtureCommand, epoch: string, role?: PushFixtureRole): Promise<void>;
  snapshot(epoch: string, role?: PushFixtureRole): Promise<SessionMetadata | undefined>;
  beginNotificationPhase(epoch: string): Promise<void>;
  assertNotificationOwnership(): Promise<void>;
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
  results: Record<string, Record<string, boolean | number | string>>;
}
interface LaneInput {
  readonly identity: AndroidPushIdentity; readonly progress: unknown;
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
  readonly pixel: <T>(owner: string, action: () => Promise<T>) => Promise<T>;
  readonly runtime?: AndroidPushRuntime;
}
const PROGRESS_KEYS = "binding,browser,cleanupRequired,device,epoch,lane,notificationTopicDigest,phase,results,secondaryNotificationTopicDigest";
const CLEANUP_STEPS: readonly PushCleanupStep[] = ["fixtureAsk", "doze", "network", "fixture", "notifications", "browser", "task"];
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
  forbidden_sinks_verified: ["clean", "detectable", "sinks", "findings", "gatewayLogsDiscarded"], evidence_complete: ["passed"],
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
      if ((key === "dndOff" && item !== true) || (key === "rearmCount" && item !== 1) ||
        (key === "rearmReason" && item !== "unowned_notification_overlap") || (key === "phaseElapsedMs" && typeof item !== "number")) throw new Error("invalid Android Push phase observation");
      if ((!["dndOff", "phaseElapsedMs", "rearmCount", "rearmReason"].includes(key) && !RESULT_FIELDS[phase as AndroidPushPhase]?.includes(key)) || !/^[a-z][A-Za-z]{0,47}$/u.test(key) || /(capability|password|secret|authKey|token|bearer)/iu.test(key) ||
        (typeof item !== "boolean" && !(typeof item === "number" && Number.isFinite(item) && item >= 0) &&
          ["delivered_while_force_stopped", "suppressed_until_relaunch", "delivered_during_doze", "delivered_after_doze_exit", "undelivered_after_doze_exit", "cellular_path_unavailable", "unowned_notification_overlap"].includes(String(item)) === false)) throw new Error("unsafe Android Push evidence");
    }
    const recorded = result as Record<string, unknown>;
    if ((recorded.rearmCount === undefined) !== (recorded.rearmReason === undefined)) throw new Error("incomplete Android Push re-arm observation");
  }
  if ((p.phase === "restored") === p.cleanupRequired) throw new Error("inconsistent Android Push cleanup state");
  return { ...p, secondaryNotificationTopicDigest: p.secondaryNotificationTopicDigest ?? null } as AndroidPushProgress;
}

export function androidPushNeedsCleanup(progress: unknown): boolean {
  return progress !== undefined && parseAndroidPushProgress(progress).cleanupRequired;
}

export async function preflightAndroidPush(input: AndroidPushPreflightInput, runtime?: AndroidPushRuntime): Promise<AndroidPushAdmission> {
  validateOrigin(input.origin);
  const host = runtime ?? createAndroidPushRuntime({ origin: input.origin,
    omp: parseQualificationPins(await readFile(join(import.meta.dir, "../UPSTREAM.lock.json"), "utf8")) });
  return host.preflight(input);
}

async function restore(input: LaneInput, runtime: AndroidPushRuntime, progress: AndroidPushProgress): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  runtime.beforeEffect = async () => { await input.checkpoint(structuredClone(progress)); };
  for (const step of CLEANUP_STEPS) {
    try { await runtime.beforeEffect(); await runtime.cleanup(step, progress); } catch { failures.push(step); }
  }
  if (failures.length > 0) throw Object.assign(new Error(`Android Push cleanup failed: ${failures.join(", ")}`), { pixelUnrestored: true });
  progress.cleanupRequired = false;
  progress.phase = "restored";
  await input.checkpoint(structuredClone(progress));
  return { epoch: progress.epoch, restored: true, deviceRestored: true, browserRestored: true, fixtureStopped: true };
}

export async function cleanupAndroidPush(input: LaneInput): Promise<Record<string, unknown>> {
  const progress = parseAndroidPushProgress(input.progress);
  if (progress.binding !== binding(input.identity)) throw new Error("Android Push progress belongs to a different candidate or origin");
  if (!progress.cleanupRequired) return { epoch: progress.epoch, restored: true };
  const runtime = input.runtime ?? createAndroidPushRuntime(input.identity);
  return input.pixel("androidPush-cleanup", () => restore(input, runtime, progress));
}

export async function runAndroidPush(input: LaneInput): Promise<Record<string, unknown>> {
  const bind = binding(input.identity);
  if (input.progress !== undefined) {
    const previous = parseAndroidPushProgress(input.progress);
    if (previous.binding !== bind) throw new Error("Android Push progress belongs to a different candidate or origin");
    if (previous.cleanupRequired) throw new Error("Android Push attempt requires cleanup before a fresh run");
  }
  const runtime = input.runtime ?? createAndroidPushRuntime(input.identity);
  const admission = await preflightAndroidPush({ origin: input.identity.origin }, runtime);
  return input.pixel("androidPush", async () => {
    const progress: AndroidPushProgress = { lane: "androidPush", epoch: randomUUID(), binding: bind, phase: "baseline_captured", cleanupRequired: true,
      device: await runtime.device(), browser: null, notificationTopicDigest: null, secondaryNotificationTopicDigest: null, results: {} };
    const save = async () => { await input.checkpoint(structuredClone(progress)); };
    runtime.beforeEffect = save;
    await save();
    let primary: unknown;
    let phaseStarted = runtime.now();
    const wait = async <T>(name: string, observe: () => Promise<T | undefined>, timeout = 60_000): Promise<T> => {
      const deadline = runtime.now() + timeout;
      while (runtime.now() < deadline) {
        const result = await observe();
        if (result !== undefined) return result;
        await runtime.pause(500);
      }
      throw new Error(`Android Push ${name} timed out`);
    };
    const snapshot = async (predicate: (s: SessionMetadata) => boolean, role: PushFixtureRole = "primary") => wait("metadata", async () => {
      const session = await runtime.snapshot(progress.epoch, role);
      return session !== undefined && predicate(session) ? session : undefined;
    }, 90_000);
    const assertDndOff = async () => { if (!await runtime.dndOff()) throw new Error("turn Do Not Disturb off on the Pixel for the qualification window"); };
    const fixture = async (operation: "start" | PushFixtureCommand, role: PushFixtureRole = "primary") => {
      if (!["answer", "stop"].includes(operation)) await assertDndOff();
      await save(); await runtime.fixture(operation, progress.epoch, role);
    };
    const finish = async (phase: AndroidPushPhase, result: Record<string, boolean | number | string>) => {
      await assertDndOff();
      if (phase !== "subscription_ready" && phase !== "evidence_complete") await runtime.assertNotificationOwnership();
      const now = runtime.now();
      progress.phase = phase; progress.results[phase] = { ...progress.results[phase], ...result, dndOff: true, phaseElapsedMs: now - phaseStarted };
      phaseStarted = now; await save();
    };
    const clear = async (timeout = 60_000, role: PushFixtureRole = "primary") => {
      await fixture("answer", role);
      const current = await snapshot(s => !s.inputRequired, role);
      await wait("authoritative clear", async () => (await runtime.observe(current, "attention", "private")).count === 0 ? true : undefined, timeout);
    };
    const delivered = async (session: SessionMetadata, kind: "attention" | "activity_stop" = "attention", detail: PushDetailLevel = "session", timeout = 60_000) => {
      const seen = await wait("notification delivery", async () => {
        const observation = await runtime.observe(session, kind, detail);
        if (observation.count > 1 || observation.forbiddenFound) throw new Error("Android Push duplicate or forbidden notification");
        return observation.count === 1 ? observation : undefined;
      }, timeout);
      if (!seen.titleMatches || !seen.bodyMatches) throw new Error("Android Push notification detail mismatch");
    };
    const delivery = async (detail: PushDetailLevel, kind: "attention" | "activity_stop" = "attention", arm = true, timeout = 60_000) => {
      if (arm) { await runtime.detail(detail); await runtime.closePwa(); await runtime.lock(); }
      if (arm) await fixture("ask");
      const session = await snapshot(s => kind === "attention" ? s.inputRequired : s.busy === false);
      const start = runtime.now();
      await delivered(session, kind, detail, timeout);
      return { session, milliseconds: runtime.now() - start };
    };
    const attempt = async (phase: AndroidPushPhase, action: () => Promise<void>): Promise<void> => {
      for (let index = 0; index < 2; index += 1) {
        await runtime.beginNotificationPhase(progress.epoch);
        try { await action(); return; }
        catch (error) {
          if (!everyError(error, nested => nested instanceof NotificationOverlapError)) throw new Error(`Android Push ${phase}: ${error instanceof Error ? error.message : "phase failed"}`, { cause: error });
          if (index !== 0) throw error;
          progress.results[phase] = { rearmCount: 1, rearmReason: "unowned_notification_overlap" };
          await save();
          // Re-arm only for an observed foreign post, never for a missing required event.
          await runtime.beginNotificationPhase(progress.epoch);
          await runtime.doze(false);
          if (!await runtime.network("wifi")) throw new Error("Android Push overlap recovery needs the Wi-Fi tailnet path");
          await runtime.permission("granted");
          await fixture("release");
          // Settle every owned ask and let its authoritative clear land, then dismiss what remains: an
          // activity-stop notice has no clear, so waiting for its tag to empty never ends.
          for (const role of ["primary", "secondary"] as const) {
            const host = await runtime.snapshot(progress.epoch, role);
            if (host === undefined) continue;
            if (host.inputRequired) await fixture("answer", role);
            const settled = await snapshot(s => !s.inputRequired && s.busy === false, role);
            await wait("authoritative clear", async () => {
              const observation = await runtime.observe(settled, "attention", "private");
              return observation.count === 0 || !observation.titleMatches ? true : undefined;
            }, PUSH_RECOVERY_MS);
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
          if (!await runtime.presentation(observed.session, level)) throw new Error("Android Push lock-screen presentation did not match selected detail");
          await runtime.pause(21_000);
          const duplicate = await runtime.observe(observed.session, "attention", level);
          if (duplicate.count !== 1 || !duplicate.titleMatches || !duplicate.bodyMatches || duplicate.forbiddenFound) throw new Error("Android Push repeated delivery changed presentation");
          await clear();
          await finish(`${level}_verified`, { delivered: true, locked: true, singleNotification: true, detailMatched: true, elapsedMs: observed.milliseconds });
        });
      }
      await attempt("attention_tap_verified", async () => {
        const attention = await delivery("session");
        const tapped = await runtime.tap(attention.session, "attention", false);
        if (tapped.launches !== 1 || tapped.successful !== 1 || !tapped.currentGeneration || !tapped.currentRequest || !tapped.scrubbedBeforeNetwork || !tapped.writable) {
          throw new Error(`Android Push attention tap did not revalidate into Control: ${JSON.stringify({ launches: tapped.launches, successful: tapped.successful, generation: tapped.currentGeneration, request: tapped.currentRequest, scrubbed: tapped.scrubbedBeforeNetwork, control: tapped.writable })}`);
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
          if (continued?.busy !== true || continued.generation !== busy.generation) throw new Error("Android Push busy changed before a second poll");
          return continued.lastSeenAt !== busy.lastSeenAt ? true : undefined;
        }, 90_000);
        await fixture("release");
        return delivery("session", "activity_stop", false);
      };
      await attempt("activity_stop_verified", async () => {
        const stopped = await stop();
        const stopTap = await runtime.tap(stopped.session, "activity_stop", false);
        if (stopTap.launches !== 1 || stopTap.successful !== 1 || !stopTap.currentGeneration || !stopTap.scrubbedBeforeNetwork || !stopTap.readOnly || stopTap.writable) throw new Error("Android Push stop tap did not open View only");
        await finish("activity_stop_verified", { knownBusyPolls: 2, viewOnly: true });
      });
      await attempt("stale_generation_verified", async () => {
        const old = await stop(); await fixture("replace");
        const replacement = await snapshot(s => s.generation === old.session.generation + 1);
        if (replacement.instanceId !== old.session.instanceId) throw new Error("Android Push replacement changed instance");
        const stale = await runtime.tap(old.session, "activity_stop", true);
        if (stale.launches !== 0 || !stale.scrubbedBeforeNetwork || !stale.expired || stale.writable || stale.readOnly) throw new Error("Android Push stale tap did not fail closed");
        await finish("stale_generation_verified", { sameInstance: true, generationIncrement: 1, launches: 0, scrubbed: true });
      });
      await attempt("clear_verified", async () => {
        await delivery("private"); await clear();
        const rearmed = await delivery("private");
        await runtime.pause(21_000);
        if ((await runtime.observe(rearmed.session, "attention", "private")).count !== 1) throw new Error("Android Push fresh request did not remain visible");
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
        if (!same(view.waiting, [first.instanceId, second.instanceId]) || view.pending !== 2 || view.heldCount !== 0) throw new Error("Android Push directory did not queue asks in arrival order");
        view = await runtime.triage({ kind: "hold", instanceId: first.instanceId });
        if (!same(view.waiting, [second.instanceId]) || !same(view.held, [first.instanceId]) || view.pending !== 2 || view.heldCount !== 1 || view.mutations !== 0) throw new Error("Android Push Hold did not advance the queue on this device alone");
        if (!await pending()) throw new Error("Android Push Hold changed the authoritative asks");
        await wait("held notification close", async () => (await runtime.observe(first, "attention", "session")).count === 0 ? true : undefined, 15_000);
        if ((await runtime.observe(second, "attention", "session")).count !== 1) throw new Error("Android Push Hold closed another ask's notification");
        view = await runtime.triage({ kind: "requeue", instanceId: first.instanceId });
        if (!same(view.waiting, [first.instanceId, second.instanceId]) || view.held.length !== 0 || view.mutations !== 0) throw new Error("Android Push requeue did not restore arrival order");
        view = await runtime.triage({ kind: "hold", instanceId: first.instanceId });
        view = await runtime.triage({ kind: "hold", instanceId: second.instanceId });
        if (!view.allHeld || view.waiting.length !== 0 || !same(view.held, [first.instanceId, second.instanceId]) || view.pending !== 2 || view.heldCount !== 2 || view.mutations !== 0) throw new Error("Android Push Hold-all did not report a held queue");
        if (!await pending()) throw new Error("Android Push Hold-all changed the authoritative asks");
        // A replaced request is a new ask: only its stale hold goes.
        await clear(60_000, "secondary");
        await fixture("ask", "secondary");
        const renewed = await snapshot(s => s.inputRequired && s.ask !== undefined && s.ask.requestId !== second.ask?.requestId, "secondary");
        await delivered(renewed);
        view = await runtime.triage();
        if (!same(view.waiting, [renewed.instanceId]) || !same(view.held, [first.instanceId]) || view.pending !== 2 || view.heldCount !== 1) throw new Error("Android Push replaced request kept its stale hold");
        await runtime.triage({ kind: "requeue", instanceId: first.instanceId });
        await clear(); await clear(60_000, "secondary");
        // Hide is device-local: Undo inside its window, then no mutation when the window expires.
        view = await runtime.triage({ kind: "hide", instanceId: first.instanceId });
        // The live total still counts the hidden row: the OMP process keeps running.
        if (view.working.includes(first.instanceId) || view.hidden !== 1 || !view.toast || view.live !== view.working.length + 1 || view.mutations !== 0) throw new Error("Android Push Hide did not hide the row on this device alone");
        view = await runtime.triage({ kind: "undo" });
        if (!view.working.includes(first.instanceId) || view.hidden !== 0 || view.toast || view.mutations !== 0) throw new Error("Android Push Undo did not restore the hidden row");
        view = await runtime.triage({ kind: "hide", instanceId: first.instanceId, settleMs: 6_500 });
        if (view.working.includes(first.instanceId) || view.hidden !== 1 || view.toast || view.live !== view.working.length + 1 || view.mutations !== 0) throw new Error("Android Push expired Undo window changed state");
        await fixture("ask");
        const returned = await snapshot(s => s.inputRequired);
        view = await runtime.triage();
        if (!same(view.waiting, [returned.instanceId]) || view.hidden !== 0) throw new Error("Android Push attention did not restore the hidden row");
        await clear();
        await runtime.triage({ kind: "hide", instanceId: secondary.instanceId });
        view = await runtime.triage({ kind: "showAll" });
        if (owned.some(id => !view.working.includes(id)) || view.hidden !== 0 || view.mutations !== 0) throw new Error("Android Push Show all did not restore hidden rows");
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
          if (tapped.launches !== 0 || !tapped.scrubbedBeforeNetwork || !tapped.expired || tapped.writable || tapped.readOnly) throw new Error(`Android Push ${cause} request tap did not fail closed`);
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
        if (replacement.instanceId !== replaced.session.instanceId) throw new Error("Android Push replacement changed instance");
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
          if (observation.count > 1 || observation.forbiddenFound || (observation.count === 1 && (!observation.titleMatches || !observation.bodyMatches))) throw new Error("Android Push force-stop privacy failure");
          whileStopped ||= observation.count === 1; await runtime.pause(500);
        }
        await runtime.openPwa(); await clear(); await delivery("private"); await clear();
        await finish("force_stop_verified", { variant: whileStopped ? "delivered_while_force_stopped" : "suppressed_until_relaunch", freshDelivery: true });
      });
      await attempt("permission_verified", async () => {
        await runtime.permission("denied"); await runtime.closePwa(); await fixture("ask");
        const denied = await snapshot(s => s.inputRequired);
        for (let elapsed = 0; elapsed < 30_000; elapsed += 500) {
          if ((await runtime.observe(denied, "attention", "private")).count !== 0) throw new Error("Android Push permission revocation did not suppress notification");
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
        await fixture("ask");
        const offline = await snapshot(s => s.inputRequired);
        for (let elapsed = 0; elapsed < 30_000; elapsed += 500) {
          if ((await runtime.observe(offline, "attention", "private")).count !== 0) throw new Error("Android Push delivered while offline");
          await runtime.pause(500);
        }
        if (!await runtime.network("wifi")) throw new Error("Android Push restored Wi-Fi tailnet path unavailable");
        await wait("Airplane recovery", async () => {
          const observed = await runtime.observe(offline, "attention", "private");
          if (observed.count > 1 || observed.forbiddenFound || (observed.count === 1 && (!observed.titleMatches || !observed.bodyMatches))) throw new Error("Android Push Airplane recovery privacy failure");
          return observed.count === 1 ? true : undefined;
        }, PUSH_RECOVERY_MS);
        await clear(PUSH_RECOVERY_MS);
        await finish("network_verified", { wifiDelivery: true, ...(cellular ? { cellularDelivery: true } : { blocked: "cellular_path_unavailable" }), airplaneSuppressed: true, recovered: true });
      });
      await attempt("doze_verified", async () => {
        await runtime.closePwa(); await runtime.doze(true); await fixture("ask");
        const sleeping = await snapshot(s => s.inputRequired);
        let duringDoze = false;
        for (let elapsed = 0; elapsed < 30_000; elapsed += 500) {
          const observation = await runtime.observe(sleeping, "attention", "private");
          if (observation.count > 1 || observation.forbiddenFound || (observation.count === 1 && (!observation.titleMatches || !observation.bodyMatches))) throw new Error("Android Push Doze privacy failure");
          duringDoze ||= observation.count === 1; await runtime.pause(500);
        }
        await runtime.doze(false);
        // Forced Doze is an observed variant, never a delivery guarantee (ADR-031): FCM has held a push
        // for minutes after Doze ended. Privacy holds for anything that arrives; the ask is settled either way.
        let afterExit = false;
        const deadline = runtime.now() + 60_000;
        while (!duringDoze && !afterExit && runtime.now() < deadline) {
          const observed = await runtime.observe(sleeping, "attention", "private");
          if (observed.count > 1 || observed.forbiddenFound || (observed.count === 1 && (!observed.titleMatches || !observed.bodyMatches))) throw new Error("Android Push Doze recovery privacy failure");
          afterExit = observed.count === 1;
          if (!afterExit) await runtime.pause(500);
        }
        // After forced Doze the phone's frozen browser can defer pushes until it runs again: in both
        // prealpha.3 campaigns an ask or clear waited minutes, until another lane opened Chrome. The
        // variant above is observed with the app closed; resuming it once lets a deferred ask or clear
        // run here rather than on the owner's phone after the lane. Doze is therefore the last delivery phase.
        await fixture("answer");
        const settled = await snapshot(s => !s.inputRequired);
        await runtime.openPwa();
        await wait("authoritative clear after Doze", async () => (await runtime.observe(settled, "attention", "private")).count === 0 ? true : undefined);
        await runtime.closePwa();
        await finish("doze_verified", { variant: duringDoze ? "delivered_during_doze" : afterExit ? "delivered_after_doze_exit" : "undelivered_after_doze_exit" });
      });
      await attempt("forbidden_sinks_verified", async () => {
        await runtime.network("wifi");
        const sinks = await runtime.sinks(progress.epoch);
        if (sinks.clean !== true || sinks.detectable !== true || sinks.gatewayLogsDiscarded !== true) throw new Error("Android Push forbidden-sink proof failed");
        await finish("forbidden_sinks_verified", sinks);
      });
      await finish("evidence_complete", { passed: !progress.results.network_verified?.blocked });
    } catch (error) { primary = error; }
    let cleanup: Record<string, unknown>;
    try { cleanup = await restore(input, runtime, progress); }
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
    if (error instanceof AggregateError) console.error(error.errors.map(item => item instanceof Error ? item.message : "Push run failed").join("; "));
    else console.error(error instanceof Error ? error.message : "Push run failed");
    process.exitCode = 1;
  }
}
