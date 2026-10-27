import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAndroidPush, runAndroidPushReadiness, waitForPushDelivery, emptyPushDeliveryMetrics, cleanupAndroidPush, parseAndroidPushProgress, androidPushNeedsCleanup,
  type AndroidPushIdentity, type AndroidPushRuntime, type PushDeviceBaseline, type PushBrowserBaseline, type PushCleanupStep, type TriageAction, type TriageObservation } from "./android-push-qualification.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import { observeNotificationDump, parseAndroidUi, NotificationOverlapError, findAndroidNotification, tapAndroidNotification, notificationTopicDigest, notificationMatchesDigest, trackUnchangedNotificationPost } from "./android-notification.ts";
import { requireAndroidPushDevice } from "./android-push-runtime.ts";
import { webApkTasks, closeWebApk, setupAndroidWebApk, withWebApkSetupRestoration } from "./android-webapk.ts";
import pushQualificationExtension, { parseFixtureCommand } from "./fixtures/push-qualification-extension.ts";
import { withDevelopmentPixelLease } from "./android-pixel-lease.ts";
import { runFixtureOperation, type FixtureExecutor } from "./push-qualification-fixture.ts";
import { authenticateAndroidNotification, awaitPageExecutionContext, isPushNotificationRoute, holdAndroidNotificationDenial, ownedPushForwards, observePushLaunch } from "./android-push-runtime.ts";
import { pixelUnrestored } from "./restoration.ts";
import { QualificationFailure, normalizeQualificationFailures, privateQualificationFailureDiagnostic } from "./qualification-failure.ts";

const identity: AndroidPushIdentity = { tag: "v0.6.0-prealpha.1", candidate: { tag: "v0.6.0-prealpha.1", sourceCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archivePath: "synthetic.tar" },
  omp: { version: "18.3.0", bunVersion: "1.4.0", sourceCommit: "c".repeat(40), sourceTree: "d".repeat(40), nativeTarballSha256: "e".repeat(64), nativeBinarySha256: "f".repeat(64) }, origin: "https://gateway.example.test" };
const baseline: PushDeviceBaseline = { wifi: true, mobile: true, airplane: false, forcedDoze: false, batteryOverride: false, awake: true, locked: false, webApkTask: false, chromeNotificationsAllowed: true, webApkNotificationsAllowed: true };
const browserBaseline: PushBrowserBaseline = { subscribed: true, permission: "granted", detail: "session" };
/** `staleSocket`: after a radio change brings the phone online (`after: "airplane"`, only the return from Airplane mode), Play Services' fresh push socket delivers what it held, then dies silently; pushes sent within `ms` of the change wait until it reconnects. */
interface FakeOptions { failAfter?: number; forceDelivery?: boolean; dozeDelivery?: boolean; dozeHeld?: boolean; deferredAfterDoze?: boolean; staleSocket?: { ms: number; after: "airplane" | "any" }; cellular?: boolean; duplicate?: boolean; wrongTap?: boolean; cleanupFail?: PushCleanupStep; dndFlipAfter?: number; overlaps?: number; frozenHeartbeat?: boolean; browserPermission?: PushBrowserBaseline["permission"]; shutdownNotification?: boolean;
  /** Holds delivery after the denied-to-granted permission transition. */ permissionRecoveryMs?: number;
  /** The directory shows the waiting asks newest first. */ wrongOrder?: boolean; /** That triage control reaches the gateway. */ triageMutation?: TriageAction["kind"]; /** A delayed stale tap still launches. */ staleLaunch?: boolean;
  /** A foreign post arrives while an owned activity-stop notice is showing. */ foreignDuringStop?: boolean }
const SECONDARY = "synthetic-secondary";
function fake(options: FakeOptions = {}) {
  let overlaps = options.overlaps ?? 0; let foreignDuringStop = options.foreignDuringStop === true;
  let time = 0; let effects = 0; let started = false; let generation = 1; let request = 0; let askedAt = 0;
  let asking = false; let busy = false; let stopped = false; let forced = false; let asleep = false; let offline = false; let dozed = false; let deferredClear = false;
  let socketStaleUntil = -Infinity; let heldAsk = false; let heldClear = false;
  let shown: "attention" | "activity_stop" | undefined;
  // The subscription detail each notice was sent at: a Private notice has no body.
  let shownDetail = browserBaseline.detail;
  // `clearing`: the gateway's clear for a removed host's ask is still in flight to the device.
  const second = { started: false, asking: false, request: 0, askedAt: 0, shown: false, clearing: false, detail: browserBaseline.detail };
  // The installed app's device-local Hold and Hide records, keyed as the app keys them.
  const held = new Set<string>(); const hidden: string[] = []; let toastUntil = -Infinity;
  const initialBrowser = { ...browserBaseline, permission: options.browserPermission ?? browserBaseline.permission };
  let browser = { ...initialBrowser }; let device = { ...baseline }; let pending = false;
  const cleanup: PushCleanupStep[] = []; const checkpoints: Record<string, unknown>[] = [];
  const since = (at: number) => new Date(Date.UTC(2026, 0, 1) + at).toISOString();
  const primarySnapshot = (): SessionMetadata | undefined => started ? { instanceId: "synthetic-instance", generation, title: "Synthetic fixture", cwdLabel: "synthetic-project", canView: true, canControl: true,
    inputRequired: asking, busy, startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: since(options.frozenHeartbeat ? 0 : Math.floor(time / 10_000) * 10_000),
    ...(asking ? { ask: { requestId: `synthetic-request-${request}`, since: since(askedAt) } } : {}) } : undefined;
  const secondarySnapshot = (): SessionMetadata | undefined => second.started ? { instanceId: SECONDARY, generation: 1, title: "Synthetic fixture", cwdLabel: "synthetic-secondary-project", canView: true, canControl: true,
    inputRequired: second.asking, busy: false, startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: since(Math.floor(time / 10_000) * 10_000),
    ...(second.asking ? { ask: { requestId: `synthetic-secondary-request-${second.request}`, since: since(second.askedAt) } } : {}) } : undefined;
  const sessions = () => [primarySnapshot(), secondarySnapshot()].filter((session): session is SessionMetadata => session !== undefined);
  const heldKey = (session: SessionMetadata) => `${session.instanceId}:${session.ask?.requestId}`;
  const hiddenKey = (session: SessionMetadata) => `${session.instanceId}:${session.generation}`;
  // As the app does on every snapshot: a record outlives neither its request nor its generation.
  const reconcile = () => {
    for (const key of held) if (!sessions().some(session => session.inputRequired && heldKey(session) === key)) held.delete(key);
    for (const key of [...hidden]) if (!sessions().some(session => !session.inputRequired && hiddenKey(session) === key)) hidden.splice(hidden.indexOf(key), 1);
  };
  const directory = (mutations: number): TriageObservation => {
    reconcile();
    const bySince = (left: SessionMetadata, right: SessionMetadata) => (left.ask?.since ?? "").localeCompare(right.ask?.since ?? "");
    const isHeld = (session: SessionMetadata) => session.inputRequired && held.has(heldKey(session));
    const waiting = sessions().filter(session => session.inputRequired && !isHeld(session)).sort(bySince).map(session => session.instanceId);
    const heldIds = sessions().filter(isHeld).sort(bySince).map(session => session.instanceId);
    const working = sessions().filter(session => !session.inputRequired && !hidden.includes(hiddenKey(session))).map(session => session.instanceId);
    const attention = waiting.length + heldIds.length;
    return { waiting: options.wrongOrder ? [...waiting].reverse() : waiting, held: heldIds, working, hidden: hidden.length, allHeld: waiting.length === 0 && heldIds.length > 0,
      pending: attention, heldCount: heldIds.length, live: attention > 0 ? 0 : working.length + hidden.length, toast: time < toastUntil, mutations };
  };
  const show = () => {
    if (!asking || browser.permission !== "granted" || offline || (forced && !options.forceDelivery) || (asleep && !options.dozeDelivery)) return;
    if (time < socketStaleUntil) heldAsk = true; else { shown = "attention"; shownDetail = browser.detail; }
  };
  const effect = async (action: () => void) => { await runtime.beforeEffect(); effects++; action(); if (effects === options.failAfter) throw new Error("synthetic interruption"); };
  const runtime: AndroidPushRuntime = {
    now: () => time, beforeEffect: async () => {},
    deliveryOwnership: async () => 1,
    subscriptionCount: async () => 1,
    gcmReadiness: async () => ({ gcmConnected: true, gcmRemedyApplied: false }),
    pause: async milliseconds => {
      time += milliseconds;
      if (time < socketStaleUntil) return;
      // The reconnected socket delivers in send order: a held ask, then its clear.
      if (heldAsk) { heldAsk = false; show(); }
      if (heldClear) { heldClear = false; shown = undefined; }
    },
    preflight: async () => ({ android: "17", browser: "153.0.8010.52", webApk: true, dndOff: true }),
    dndOff: async () => options.dndFlipAfter === undefined || effects < options.dndFlipAfter,
    beginNotificationPhase: async () => {}, assertNotificationOwnership: async () => { if (overlaps > 0) { overlaps--; throw new NotificationOverlapError(); } },
    device: async () => ({ ...device }), browser: async () => ({ ...browser }),
    async fixture(operation, _epoch, role = "primary") { await effect(() => {
      if (role === "secondary") {
        if (operation === "start") second.started = true;
        else if (operation === "ask") { second.asking = true; second.request++; second.askedAt = time; second.shown = browser.permission === "granted"; second.detail = browser.detail; }
        else if (operation === "answer") { second.asking = false; second.shown = false; }
        else if (operation === "stop") { second.clearing = second.shown; second.started = false; second.asking = false; }
        else throw new Error("synthetic secondary operation unsupported");
        return;
      }
      if (operation === "start") started = true;
      if (operation === "ask") { asking = true; request++; askedAt = time; pending = true; show(); }
      if (operation === "answer") { asking = false; pending = false; if (shown === "attention") { if (options.deferredAfterDoze && dozed) deferredClear = true; else if (time < socketStaleUntil) heldClear = true; else shown = undefined; } }
      if (operation === "busy") { busy = true; stopped = false; }
      if (operation === "release") { busy = false; stopped = true; shown = "activity_stop"; shownDetail = browser.detail; }
      if (operation === "replace") generation++;
      if (operation === "stop") started = false;
    }); },
    snapshot: async (_epoch, role = "primary") => role === "secondary" ? secondarySnapshot() : primarySnapshot(),
    detail: async level => { await effect(() => { browser.detail = level; browser.subscribed = true; }); },
    closePwa: async () => { await effect(() => { device.webApkTask = false; }); },
    openPwa: async () => { await effect(() => { device.webApkTask = true; forced = false; if (deferredClear) { shown = undefined; deferredClear = false; } show(); }); },
    lock: async () => { await effect(() => { device.locked = true; device.awake = false; }); },
    observe: async (session, kind, detail) => {
      // Waiting lets an in-flight removal clear land.
      if (session.instanceId === SECONDARY && second.clearing) { second.shown = false; second.clearing = false; }
      // As on the device, a host has one owned tag, whichever kind of notice it shows.
      const notice = session.instanceId === SECONDARY ? second.shown ? "attention" : undefined : shown;
      const sentPrivate = (session.instanceId === SECONDARY ? second.detail : shownDetail) === "private";
      if (notice === "activity_stop" && foreignDuringStop) { foreignDuringStop = false; throw new NotificationOverlapError(); }
      return { count: notice === undefined ? 0 : options.duplicate ? 2 : 1, titleMatches: notice === kind, bodyMatches: notice === kind && sentPrivate === (detail === "private"), forbiddenFound: false };
    },
    dismissOwned: async () => { await effect(() => { shown = undefined; second.shown = false; second.clearing = false; }); },
    presentation: async () => device.locked && shown === "attention",
    async tap(session, kind, stale) { await effect(() => { if (session.instanceId === SECONDARY) second.shown = false; else shown = undefined; device.webApkTask = true; });
      const live = sessions().find(item => item.instanceId === session.instanceId);
      const current = live !== undefined && live.generation === session.generation && (kind === "activity_stop" || live.ask?.requestId === session.ask?.requestId);
      const launches = current || (stale && kind === "attention" && options.staleLaunch === true) ? 1 : 0;
      return { launches, successful: launches, currentGeneration: current, currentRequest: current,
        scrubbedBeforeNetwork: true, writable: current && (kind === "attention" || options.wrongTap === true), readOnly: current && kind === "activity_stop", expired: stale && !current };
    },
    async triage(action) {
      let mutations = 0;
      if (action !== undefined) await effect(() => {
        const session = sessions().find(item => "instanceId" in action && item.instanceId === action.instanceId);
        if (action.kind === "hold") {
          if (session === undefined || directory(0).waiting[0] !== session.instanceId) throw new Error("synthetic Hold is offered only for the next ask");
          held.add(heldKey(session));
          if (session.instanceId === SECONDARY) second.shown = false; else if (shown === "attention") shown = undefined;
        }
        if (action.kind === "requeue" && (session === undefined || !held.delete(heldKey(session)))) throw new Error("synthetic requeue unavailable");
        if (action.kind === "hide") {
          if (session === undefined || session.inputRequired) throw new Error("synthetic Hide unavailable");
          hidden.push(hiddenKey(session)); toastUntil = time + 5_000;
        }
        if (action.kind === "undo") { if (time >= toastUntil) throw new Error("synthetic Undo expired"); hidden.pop(); toastUntil = -Infinity; }
        if (action.kind === "showAll") { hidden.length = 0; toastUntil = -Infinity; }
        if (options.triageMutation === action.kind) mutations++;
      });
      time += action?.settleMs ?? 1_500;
      return directory(mutations);
    },
    replay: async session => {
      // As on the device: launching the app re-saves its subscription, and the gateway re-sends each
      // current ask, replacing a replay on the same tag. The runtime refuses that state.
      const live = sessions().find(item => item.instanceId === session.instanceId);
      if (!device.webApkTask && live?.ask !== undefined && live.ask.requestId !== session.ask?.requestId) throw new Error("Android Push replay over a newer ask needs the app already open");
      // A removal clear that lands after the replay closes it: the same request.
      if (session.instanceId === SECONDARY && second.clearing) throw new Error("Android Push replayed notification unavailable");
      await effect(() => { if (session.instanceId === SECONDARY) { second.shown = true; second.detail = browser.detail; } else { shown = "attention"; shownDetail = browser.detail; } device.webApkTask = false; });
    },
    answer: async () => { await effect(() => { asking = false; shown = undefined; }); },
    forceStop: async () => { await effect(() => { forced = true; shown = undefined; }); },
    permission: async value => { await effect(() => {
      if (browser.permission === "denied" && value === "granted" && options.permissionRecoveryMs !== undefined) socketStaleUntil = time + options.permissionRecoveryMs;
      browser.permission = value;
    }); },
    doze: async enabled => { await effect(() => { asleep = enabled; device.forcedDoze = enabled; device.batteryOverride = enabled; if (!enabled) dozed = true; if (!enabled && !options.dozeHeld) show(); }); },
    network: async value => { await effect(() => {
      const next = { airplane: value === "airplane", wifi: value === "wifi", mobile: value !== "airplane" };
      const changed = next.airplane !== device.airplane || next.wifi !== device.wifi || next.mobile !== device.mobile;
      const returning = device.airplane && !next.airplane;
      offline = next.airplane; device.airplane = next.airplane; device.wifi = next.wifi; device.mobile = next.mobile;
      if (!offline && pending) show();
      const stale = options.staleSocket;
      if (stale !== undefined && changed && !offline && (stale.after === "any" || returning)) socketStaleUntil = time + stale.ms;
    }); return value !== "cellular" || options.cellular !== false; },
    sinks: async () => ({ clean: true, detectable: true, gatewayLogsDiscarded: true, gatewayStructuredLogsSafe: true }),
    async cleanup(step) { cleanup.push(step);
      if (step === options.cleanupFail) throw new Error("synthetic cleanup failure");
      if (step === "fixtureAsk") { asking = false; second.asking = false; }
      if (step === "notifications") { shown = undefined; second.shown = false; second.clearing = false; reconcile(); }
      if (step === "browser") browser = { ...initialBrowser };
      if (step === "doze") { device.forcedDoze = false; device.batteryOverride = false; }
      if (step === "network") { device.wifi = baseline.wifi; device.mobile = baseline.mobile; device.airplane = baseline.airplane; }
      if (step === "task") { device.webApkTask = baseline.webApkTask; device.locked = baseline.locked; device.awake = baseline.awake; }
      if (step === "fixture") { started = false; second.started = false; if (options.shutdownNotification) shown = "activity_stop"; }
    },
  };
  return { runtime, cleanup, checkpoints, state: () => ({ started, asking, browser, device, shown, effects, stopped, secondaryStarted: second.started, localRecords: held.size + hidden.length }),
    input: { identity, progress: undefined, runtime, checkpoint: async (p: Record<string, unknown>) => { checkpoints.push(structuredClone(p)); }, pixel: async <T>(_owner: string, action: () => Promise<T>) => action() } };
}

test.each(["unknown", "accepted", "ambiguous", "privacy", "late", "transient", "old-request", "exhausted"] as const)(
  "delivery recovery refuses unsupported attribution and records %s evidence", async scenario => {
    const host = fake();
    const metrics = emptyPushDeliveryMetrics();
    const window = { lane: "androidPush" as const, phase: "private_verified", after: 0, ordinal: 1 };
    let now = 0, rearms = 0, reads = 0;
    let lateObserver: (() => Promise<void>) | undefined;
    const session: SessionMetadata = { instanceId: "volatile-only", generation: 1, title: "SYNTHETIC-PRIVATE-TITLE", cwdLabel: "SYNTHETIC-PATH",
      canView: true, canControl: true, inputRequired: true, startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z",
      ask: { requestId: "SYNTHETIC-OLD", since: "2026-01-01T00:00:00.000Z" } };
    host.runtime.now = () => now;
    host.runtime.pause = async milliseconds => { now += milliseconds; };
    host.runtime.observe = async () => {
      reads++;
      const present = rearms > 0 || scenario === "late" && now >= 60_000;
      return { count: scenario === "privacy" ? 2 : present ? 1 : 0, titleMatches: true, bodyMatches: true, forbiddenFound: false };
    };
    host.runtime.deliveryTelemetry = async () => ({ sufficient: scenario === "accepted",
      subscriptionCount: scenario === "ambiguous" ? 2 : 1, sends: scenario === "ambiguous" ? 2 : 1, acknowledgements: scenario === "accepted" ? 1 : 0,
      failures: scenario === "accepted" ? 0 : 1, retryable: !["unknown", "accepted", "ambiguous", "late"].includes(scenario), httpStatus: 503, requestAlias: 1 });
    host.runtime.deliveryRequestMatches = async () => scenario !== "old-request";
    if (scenario === "exhausted") metrics.deliveryRearmCount = 1;
    let failure: unknown;
    try {
      await waitForPushDelivery({ runtime: host.runtime, session, detail: "private", kind: "attention", phase: "private_verified", timeout: 60_000,
        metrics, window, onTimeout: value => { lateObserver = value; }, rearm: async (_old, late) => {
          expect(lateObserver).toBeDefined();
          await late(); rearms++;
          return { session: { ...session, ask: { requestId: "SYNTHETIC-NEW", since: "2026-01-01T00:01:01.000Z" } }, window };
        } });
    } catch (error) { failure = error; }
    if (scenario === "transient") expect(failure).toBeUndefined();
    else {
      expect(failure).toBeInstanceOf(QualificationFailure);
      expect((failure as QualificationFailure).evidence.class).toBe(scenario === "privacy" ? "product" : scenario === "exhausted" ? "infra_transient" : "harness");
    }
    expect(rearms).toBe(["transient", "old-request"].includes(scenario) ? 1 : 0);
    expect(metrics.firstDeliveryMs).toBe(scenario === "privacy" ? 0 : 60_000);
    expect(metrics.latePostCount).toBe(scenario === "late" ? 1 : 0);
    if (scenario === "late") expect(metrics.latePostMs).toBe(60_000);
    expect(reads).toBeGreaterThan(0);
    expect(JSON.stringify(metrics)).not.toContain("SYNTHETIC");
  });

test("effectful readiness restores its exact baseline without awarding qualification phases", async () => {
  const host = fake();
  host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: true, subscriptionCount: 1, sends: 1, acknowledgements: 1, failures: 0, retryable: false, httpStatus: 0, requestAlias: 1 });
  expect(await runAndroidPushReadiness(host.input)).toMatchObject({
    delivered: true, acknowledged: true, gcmConnected: true, gcmRemedyApplied: false,
    subscriptionCount: 1, sendCount: 1, ackCount: 1, cleanup: { restored: true },
  });
  expect(host.state().device).toEqual(baseline);
  expect(host.checkpoints.at(-1)).toMatchObject({ phase: "restored", results: {} });
});

test("GCM refusal precedes browser and fixture effects and restores the checkpointed radios", async () => {
  const host = fake();
  let fixtureCalls = 0, browserCalls = 0;
  host.runtime.browser = async () => { browserCalls++; return browserBaseline; };
  host.runtime.fixture = async () => { fixtureCalls++; };
  host.runtime.gcmReadiness = async () => {
    expect(host.checkpoints.at(-1)).toMatchObject({ phase: "baseline_captured", device: baseline });
    await host.runtime.network("cellular");
    throw new QualificationFailure({ id: 1, lane: "rigReadiness", step: "pixel_push", reason: "gcm_disconnected",
      class: "infra_transient", elapsedMs: 32_000, operation: "read_only",
      observations: { gcmConnected: false, gcmRemedyApplied: true } },
    { cause: new Error("GcmService censored sample: Is client connected: false; Reconnect Scheduler Alarm: OFF") });
  };
  const error = await runAndroidPushReadiness(host.input).catch(error => error);
  expect(normalizeQualificationFailures(error)).toMatchObject([{
    reason: "gcm_disconnected", class: "infra_transient", observations: { gcmConnected: false, gcmRemedyApplied: true },
  }]);
  expect(browserCalls).toBe(0);
  expect(fixtureCalls).toBe(0);
  expect(host.state().device).toEqual(baseline);
  expect(host.checkpoints.at(-1)).toMatchObject({ phase: "restored", results: {} });
});

test.each(["poll", "telemetry", "ownership", "request"] as const)("509 round2 ordinary %s failures survive expiry and conversion", async stage => {
  const host = fake(), metrics = emptyPushDeliveryMetrics(), controller = new AbortController();
  const raw = new Error(`synthetic private ${stage} failure`);
  const session: SessionMetadata = { instanceId: "synthetic", generation: 1, canView: true, canControl: true, inputRequired: true,
    startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
  const fail = async (): Promise<never> => { controller.abort(); throw raw; };
  host.runtime.observe = stage === "poll" ? fail : async () => ({
    count: stage === "ownership" ? 0 : 1, titleMatches: true, bodyMatches: true, forbiddenFound: false,
  });
  host.runtime.deliveryTelemetry = stage === "telemetry" ? fail : async () => ({
    sufficient: false, subscriptionCount: 1, sends: 1, acknowledgements: 0, failures: 1, retryable: true, httpStatus: 503, requestAlias: 1,
  });
  if (stage === "ownership") host.runtime.deliveryOwnership = fail;
  if (stage === "request") { metrics.deliveryRearmCount = 1; host.runtime.deliveryRequestMatches = fail; }
  const error = await waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "private", kind: "attention",
    phase: "private_verified", timeout: 1, window: { lane: "androidPush", phase: "private_verified", after: 0, ordinal: 1 },
    execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 } }).catch(error => error);
  expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(raw.message);
  expect(normalizeQualificationFailures(error)).toMatchObject([{ reason: "delivery_timeout" }]);
});

test.each(["browser", "restoration"] as const)("509 round2 readiness remaps nested %s failures and attaches final metrics", async stage => {
  const host = fake(), raw = new Error("synthetic aggregate provenance");
  const typed = new QualificationFailure({ id: 70, lane: "androidPush", step: "browser_context", reason: "browser_baseline_failed",
    class: "harness", operation: "unknown", elapsedMs: 1, observations: {} }, { cause: raw });
  const deadline = new QualificationFailure({ id: 71, lane: "androidPush", step: "baseline_captured", reason: "deadline_exceeded",
    class: "harness", operation: "unknown", elapsedMs: 1, observations: { controllerDeadline: true } });
  const aggregate = new AggregateError([typed, new AggregateError([deadline])]);
  host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: true, subscriptionCount: 1, sends: 1, acknowledgements: 1,
    failures: 0, retryable: false, httpStatus: 0, requestAlias: 1 });
  if (stage === "browser") host.runtime.browser = async () => { throw aggregate; };
  else {
    const cleanup = host.runtime.cleanup;
    host.runtime.cleanup = async (...args) => { await cleanup(...args); if (args[0] === "browser") throw aggregate; };
  }
  const error = await runAndroidPushReadiness(host.input).catch(error => error);
  const leaves = normalizeQualificationFailures(error);
  expect(leaves).toHaveLength(2);
  for (const leaf of leaves) expect(leaf).toMatchObject({ lane: "rigReadiness", observations: {
    subscriptionCount: stage === "browser" ? 0 : 1, sendCount: stage === "browser" ? 0 : 1,
    ackCount: stage === "browser" ? 0 : 1, latePostCount: 0, latePostMs: 0,
  } });
  expect(leaves[0]?.step).toBe("browser_context");
  expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(raw.message);
  expect(host.cleanup).toHaveLength(7);
  expect(pixelUnrestored(error)).toBe(stage === "restoration");
});

test("506 council readiness returns counters from the final acknowledged snapshot", async () => {
  const host = fake();
  let reads = 0;
  host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => ++reads === 1 ?
    { sufficient: false, subscriptionCount: 0, sends: 0, acknowledgements: 0, failures: 0, retryable: false, httpStatus: 0 } :
    { sufficient: true, subscriptionCount: 2, sends: 2, acknowledgements: 2, failures: 0, retryable: false, httpStatus: 0, requestAlias: 1 };
  expect(await runAndroidPushReadiness(host.input)).toMatchObject({
    delivered: true, acknowledged: true, subscriptionCount: 2, sendCount: 2, ackCount: 2,
  });
  expect(reads).toBe(2);
});

test("506 council readiness cannot substitute a posted record for lock-screen presentation", async () => {
  const host = fake();
  host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: true, subscriptionCount: 1, sends: 1, acknowledgements: 1,
    failures: 0, retryable: false, httpStatus: 0, requestAlias: 1 });
  let presented = false;
  host.runtime.presentation = async () => { presented = true; return false; };
  await expect(runAndroidPushReadiness(host.input)).rejects.toMatchObject({
    evidence: { lane: "rigReadiness", reason: "assertion_failed", class: "product" },
  });
  expect(presented).toBe(true);
  expect(host.cleanup).toHaveLength(7);
});

test.each(["elapsed", "typed"] as const)("506 council readiness preserves %s browser deadline attribution", async variant => {
  const host = fake();
  let id = 0;
  const execution = { signal: new AbortController().signal, deadline: performance.now() + 60_000, nextFailureId: () => ++id };
  host.runtime.browser = async () => {
    execution.deadline = 0;
    if (variant === "typed") throw new QualificationFailure({ id: 1, lane: "androidPush", step: "browser_forward",
      reason: "deadline_exceeded", class: "harness", elapsedMs: 1, operation: "unknown", observations: { controllerDeadline: true } });
    throw new Error("synthetic elapsed browser execution");
  };
  const error = await runAndroidPushReadiness({ ...host.input, execution }).catch(error => error);
  expect(normalizeQualificationFailures(error)).toContainEqual(expect.objectContaining({
    lane: "rigReadiness", reason: variant === "typed" ? "deadline_exceeded" : "delivery_timeout",
  }));
  if (variant === "elapsed") expect(normalizeQualificationFailures(error)).toContainEqual(expect.objectContaining({ reason: "browser_baseline_failed" }));
  expect(host.cleanup).toHaveLength(7);
});

test("readiness refuses stale subscriptions before any fixture ask and restores the baseline", async () => {
  const host = fake(), fixture = host.runtime.fixture;
  host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
  host.runtime.subscriptionCount = async () => 2;
  let asks = 0;
  host.runtime.fixture = async (...args) => { if (args[0] === "ask") asks++; await fixture(...args); };
  await expect(runAndroidPushReadiness(host.input)).rejects.toMatchObject({
    evidence: { lane: "rigReadiness", reason: "stale_subscriptions", class: "harness", observations: { subscriptionCount: 2 } },
  });
  expect(asks).toBe(0);
  expect(host.cleanup).toHaveLength(7);
  expect(host.checkpoints.at(-1)).toMatchObject({ phase: "restored", cleanupRequired: false });
});

test("readiness checkpoints before browser capture and classifies an untyped baseline failure", async () => {
  const host = fake();
  host.runtime.browser = async () => {
    expect(host.checkpoints.at(-1)).toMatchObject({ phase: "baseline_captured", cleanupRequired: true, browser: null });
    throw new Error("SYNTHETIC-PRIVATE-CDP-ERROR");
  };
  let failure: unknown;
  try { await runAndroidPushReadiness(host.input); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ evidence: { lane: "rigReadiness", step: "browser_capture", reason: "browser_baseline_failed", class: "harness" } });
  expect(JSON.stringify(normalizeQualificationFailures(failure))).not.toContain("SYNTHETIC-PRIVATE-CDP-ERROR");
  expect(host.cleanup).toHaveLength(7);
});

test.each(["baseline", "mutation", "restoration"] as const)(
  "council498 readiness %s persistence failure cannot skip any restoration owner", async point => {
    const host = fake();
    let cleaning = false, id = 80;
    host.runtime.beginCleanup = () => { cleaning = true; };
    host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
    host.runtime.deliveryTelemetry = async () => ({ sufficient: true, subscriptionCount: 1, sends: 1, acknowledgements: 1, failures: 0, retryable: false, httpStatus: 0, requestAlias: 1 });
    const checkpoint = host.input.checkpoint;
    const error = await runAndroidPushReadiness({ ...host.input,
      execution: { signal: new AbortController().signal, deadline: performance.now() + 5_000, nextFailureId: () => ++id },
      checkpoint: async value => {
        await checkpoint(value);
        if (point === "baseline" || (point === "mutation" && host.state().effects > 1) || cleaning) throw new Error("synthetic checkpoint failure");
      },
    }).catch(error => error);
    expect(host.cleanup).toEqual(["fixtureAsk", "doze", "network", "fixture", "notifications", "browser", "task"]);
    expect(host.state()).toMatchObject({ started: false, asking: false, browser: browserBaseline, device: baseline });
    expect(normalizeQualificationFailures(error).some(item => item.observations.persistenceFailed === true)).toBe(true);
    expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain("synthetic checkpoint failure");
    expect(androidPushNeedsCleanup(host.checkpoints.at(-1))).toBe(true);
  });

test.each(["fixture", "telemetry", "invalid-clock"] as const)("500 readiness restores after pre-ask %s failure", async stage => {
  const host = fake(), now = host.runtime.now, fixture = host.runtime.fixture;
  host.runtime.now = () => 1_000_000_000 + now();
  const failure = new QualificationFailure({ id: 1, lane: "androidPush", step: "private_verified",
    class: "harness", reason: "invalid_evidence", elapsedMs: 0, operation: "read_only", observations: {} });
  host.runtime.fixture = async (...args) => {
    await fixture(...args);
    if (args[0] === "start" && stage !== "telemetry") {
      await host.runtime.pause(stage === "invalid-clock" ? 86_400_001 : 11);
      throw failure;
    }
  };
  host.runtime.beginDeliveryTelemetry = async () => { await host.runtime.pause(11); throw failure; };
  let surfaced: unknown;
  try { await runAndroidPushReadiness(host.input); } catch (error) { surfaced = error; }
  expect(host.cleanup).toHaveLength(7);
  expect(androidPushNeedsCleanup(host.checkpoints.at(-1))).toBe(false);
  if (stage === "invalid-clock") expect(surfaced).toBeInstanceOf(AggregateError);
  else expect(surfaced).toMatchObject({ evidence: { lane: "rigReadiness", reason: "invalid_evidence", elapsedMs: 11 } });
});

test.each([false, true])("500 request attestation preserves containment after expiry (aggregate=%s)", async aggregate => {
  const host = fake(), controller = new AbortController(), metrics = emptyPushDeliveryMetrics();
  await host.runtime.fixture("start", "epoch"); await host.runtime.fixture("ask", "epoch");
  const session = (await host.runtime.snapshot("epoch"))!;
  const contained = Object.assign(new Error("synthetic unresolved target"), { pixelUnrestored: true });
  const failure = aggregate ? new AggregateError([contained], "synthetic nested containment") : contained;
  metrics.deliveryRearmCount = 1;
  host.runtime.deliveryRequestMatches = async () => { controller.abort(); throw failure; };
  await expect(waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "session", kind: "attention",
    phase: "private_verified", timeout: 60_000,
    execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 } })).rejects.toBe(failure);
});

test.each(["readiness-error", "readiness-deadline", "qualification-error", "qualification-deadline"])(
  "500 metadata preserves the actual %s failure", async scenario => {
    const host = fake(), snapshot = host.runtime.snapshot, controller = new AbortController();
    const failure = new Error("synthetic snapshot transport failure");
    host.runtime.beginDeliveryTelemetry = async phase => ({ lane: phase === "readiness" ? "rigReadiness" : "androidPush", phase, after: 0, ordinal: 1 });
    host.runtime.snapshot = async (...args) => {
      const session = await snapshot(...args);
      if (session?.inputRequired) {
        if (scenario.endsWith("error")) throw failure;
        controller.abort(); return undefined;
      }
      return session;
    };
    const input = { ...host.input, execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 } };
    const run = scenario.startsWith("readiness") ? runAndroidPushReadiness(input) : runAndroidPush(input);
    if (scenario.endsWith("error")) await expect(run).rejects.toBe(failure);
    else await expect(run).rejects.toMatchObject({ evidence: { reason: "delivery_timeout" } });
    expect(host.cleanup).toHaveLength(7);
  });

test.each(["normal", "rearm", "doze"] as const)("500 %s clear includes metadata in its original budget", async stage => {
  const host = fake(), fixture = host.runtime.fixture, snapshot = host.runtime.snapshot, observe = host.runtime.observe;
  let phase: string | undefined, clearing = false, delayed = false, asks = 0;
  host.runtime.beginNotificationPhase = async (_epoch, value) => { phase = value; };
  host.runtime.fixture = async (...args) => {
    await fixture(...args);
    if (args[0] === "ask") asks++;
    if (args[0] === "answer" && phase === (stage === "doze" ? "doze_verified" : "private_verified")) clearing = true;
  };
  host.runtime.snapshot = async (...args) => {
    if (clearing && !delayed) { delayed = true; await host.runtime.pause(60_001); }
    return snapshot(...args);
  };
  if (stage === "rearm") {
    host.runtime.observe = async (...args) => asks === 1 && !clearing ?
      { count: 0, titleMatches: true, bodyMatches: true, forbiddenFound: false } : observe(...args);
    host.runtime.beginDeliveryTelemetry = async phase => ({ lane: "androidPush", phase, after: 0, ordinal: 1 });
    host.runtime.deliveryTelemetry = async () => ({ sufficient: false, subscriptionCount: 1, sends: 1, acknowledgements: 0, failures: 1,
      retryable: true, httpStatus: 503, requestAlias: 1, clearAcknowledged: true });
    host.runtime.deliveryRequestMatches = async () => true;
  }
  await expect(runAndroidPush(host.input)).rejects.toMatchObject({ evidence: { reason: "delivery_timeout" } });
  expect(delayed).toBe(true);
  expect(host.cleanup).toHaveLength(7);
  if (stage !== "doze") expect(asks).toBe(1);
});

test("500 timed-out ask keeps its sampler until rearm clear settlement", async () => {
  const host = fake(), metrics = emptyPushDeliveryMetrics();
  await host.runtime.fixture("start", "epoch"); await host.runtime.fixture("ask", "epoch");
  const session = (await host.runtime.snapshot("epoch"))!;
  let arrived = false, sample: (() => Promise<void>) | undefined;
  host.runtime.observe = async () => ({ count: arrived ? 1 : 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: false, subscriptionCount: 1, sends: 1, acknowledgements: 0, failures: 1,
    retryable: true, httpStatus: 503, requestAlias: 1 });
  const failure = new Error("synthetic clear failure");
  await expect(waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "private", kind: "attention",
    phase: "private_verified", timeout: 1, window: { lane: "androidPush", phase: "private_verified", after: 0, ordinal: 1 },
    onTimeout: value => { sample = value; }, rearm: async () => { throw failure; } })).rejects.toBe(failure);
  expect(sample).toBeDefined();
  arrived = true; await sample?.();
  expect(metrics.latePostCount).toBe(1);
});

test("500 delivered ask disarms its pre-ask sampler before telemetry", async () => {
  const host = fake(), metrics = emptyPushDeliveryMetrics();
  await host.runtime.fixture("start", "epoch"); await host.runtime.fixture("ask", "epoch");
  const session = (await host.runtime.snapshot("epoch"))!;
  let sample: (() => Promise<void>) | undefined = async () => {};
  host.runtime.deliveryTelemetry = async () => { throw new Error("synthetic telemetry failure"); };
  await expect(waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "session", kind: "attention",
    phase: "private_verified", timeout: 60_000, window: { lane: "androidPush", phase: "private_verified", after: 0, ordinal: 1 },
    onTimeout: value => { sample = value; } })).rejects.toMatchObject({ evidence: { reason: "invalid_evidence" } });
  expect(sample).toBeUndefined();
});

test("500 expiry after a settled rearm cannot reinstate the old ask sampler", async () => {
  const host = fake(), metrics = emptyPushDeliveryMetrics(), controller = new AbortController();
  await host.runtime.fixture("start", "epoch"); await host.runtime.fixture("ask", "epoch");
  const session = (await host.runtime.snapshot("epoch"))!;
  let sample: (() => Promise<void>) | undefined;
  const freshSampler = async () => {};
  host.runtime.observe = async () => ({ count: 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: false, subscriptionCount: 1, sends: 1, acknowledgements: 0, failures: 1,
    retryable: true, httpStatus: 503, requestAlias: 1 });
  await expect(waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "private", kind: "attention",
    phase: "private_verified", timeout: 1, window: { lane: "androidPush", phase: "private_verified", after: 0, ordinal: 1 },
    execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 },
    onTimeout: value => { sample = value; }, rearm: async () => {
      sample = freshSampler; controller.abort();
      return { session: { ...session, ask: { requestId: "fresh", since: session.ask!.since } } };
    } })).rejects.toMatchObject({ evidence: { reason: "delivery_timeout" } });
  expect(sample).toBe(freshSampler);
});

test("500 overlap retry discards ambiguous late attribution without resetting its rearm budget", async () => {
  const host = fake({ overlaps: 1 });
  let phases = 0;
  const failure = new Error("synthetic overlap recovery failure");
  host.runtime.beginNotificationPhase = async () => { if (++phases === 2) throw failure; };
  await expect(runAndroidPush(host.input)).rejects.toBe(failure);
  expect(parseAndroidPushProgress(host.checkpoints.at(-1)).results.private_verified).toMatchObject({ latePostCount: 0, deliveryRearmCount: 0 });
  expect(host.cleanup).toHaveLength(7);
});
test.each(["telemetry", "ownership", "answer", "clear"] as const)(
  "495 round2 readiness rejects its expired delivery budget after %s awaits", async stage => {
    const host = fake();
    const telemetry = { sufficient: true, subscriptionCount: 1, sends: 1, acknowledgements: 1, failures: 0, retryable: false, httpStatus: 0, requestAlias: 1 };
    let reads = 0, answered = false, delayed = false;
    host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
    const delay = async () => { if (!delayed) { delayed = true; await host.runtime.pause(160_001); } };
    host.runtime.deliveryTelemetry = async () => { if (++reads === 2 && stage === "telemetry") await delay(); return telemetry; };
    host.runtime.deliveryOwnership = async () => { if (stage === "ownership") await delay(); return 1; };
    const fixture = host.runtime.fixture, observe = host.runtime.observe;
    host.runtime.fixture = async (...args) => {
      await fixture(...args);
      if (args[0] === "answer") { answered = true; if (stage === "answer") await delay(); }
    };
    host.runtime.observe = async (...args) => {
      if (answered && stage === "clear") await delay();
      return observe(...args);
    };
    await expect(runAndroidPushReadiness(host.input)).rejects.toMatchObject({ evidence: { reason: "delivery_timeout", class: "harness" } });
    expect(host.cleanup).toHaveLength(7);
  });

test("495 round2 all persisted delivery durations are bounded integers", async () => {
  const host = fake(), now = host.runtime.now;
  let fraction = 0;
  host.runtime.now = () => now() + fraction++ / 1_000;
  await runAndroidPush(host.input);
  const progress = parseAndroidPushProgress(host.checkpoints.at(-1));
  for (const result of Object.values(progress.results)) {
    for (const value of Object.values(result)) if (typeof value === "number") expect(Number.isSafeInteger(value)).toBe(true);
  }
  for (const key of ["elapsedMs", "firstDeliveryMs", "secondDeliveryMs", "clearMs", "latePostMs"]) {
    for (const value of [0.125, 86_400_001, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseAndroidPushProgress({ ...progress, results: { private_verified: { [key]: value } } })).toThrow();
    }
  }
});

test.each(["metadata", "phase"] as const)("495 round2 qualification checks the %s success boundary after awaits", async stage => {
  const host = fake(), controller = new AbortController(), snapshot = host.runtime.snapshot, sinks = host.runtime.sinks;
  let delayed = false;
  if (stage === "metadata") host.runtime.snapshot = async (...args) => {
    const current = await snapshot(...args);
    if (current?.inputRequired && !delayed) { delayed = true; await host.runtime.pause(90_001); }
    return current;
  };
  else host.runtime.sinks = async (...args) => { const result = await sinks(...args); controller.abort(); return result; };
  await expect(runAndroidPush({ ...host.input, execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 } }))
    .rejects.toMatchObject({ evidence: { class: "harness", reason: stage === "metadata" ? "delivery_metadata_timeout" : "delivery_timeout" } });
  expect(host.cleanup).toHaveLength(7);
});

test("R1 fractional monotonic measurements remain typed and R4 telemetry errors retain late sampling", async () => {
  const host = fake(), metrics = emptyPushDeliveryMetrics();
  await host.runtime.fixture("start", "synthetic"); await host.runtime.fixture("ask", "synthetic");
  const session = (await host.runtime.snapshot("synthetic"))!;
  const now = host.runtime.now;
  host.runtime.now = () => now() * 1.001;
  let late: (() => Promise<void>) | undefined, arrived = false;
  host.runtime.observe = async () => ({ count: arrived ? 1 : 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.deliveryTelemetry = async () => { throw new Error("SYNTHETIC-RAW-ERROR"); };
  await expect(waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "private", kind: "attention",
    phase: "private_verified", timeout: 501, window: { lane: "androidPush", phase: "private_verified", after: 0, ordinal: 1 },
    onTimeout: sample => { late = sample; } })).rejects.toMatchObject({ evidence: { class: "harness", reason: "invalid_evidence" } });
  expect(late).toBeDefined();
  arrived = true; await late?.();
  expect(metrics.latePostCount).toBe(1);
  expect(Number.isSafeInteger(metrics.firstDeliveryMs)).toBe(true);
  expect(Number.isSafeInteger(metrics.latePostMs)).toBe(true);
});

test("R2 a foreign failed send cannot invoke the fixture re-arm callback", async () => {
  const host = fake(), metrics = emptyPushDeliveryMetrics();
  await host.runtime.fixture("start", "synthetic"); await host.runtime.fixture("ask", "synthetic");
  const session = (await host.runtime.snapshot("synthetic"))!;
  host.runtime.observe = async () => ({ count: 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: false, subscriptionCount: 1, sends: 1, acknowledgements: 0, failures: 1, retryable: true, httpStatus: 503, requestAlias: 2 });
  let rearms = 0;
  await expect(waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "private", kind: "attention",
    phase: "private_verified", timeout: 1, window: { lane: "androidPush", phase: "private_verified", after: 0, ordinal: 1 },
    rearm: async () => { rearms++; throw new Error("foreign send caused mutation"); } })).rejects.toMatchObject({ evidence: { class: "harness", reason: "invalid_evidence" } });
  expect(rearms).toBe(0);
});

test("R2 a product failure after telemetry still stops before re-arm", async () => {
  const host = fake(), metrics = emptyPushDeliveryMetrics();
  await host.runtime.fixture("start", "synthetic"); await host.runtime.fixture("ask", "synthetic");
  const session = (await host.runtime.snapshot("synthetic"))!;
  let duplicate = false, rearms = 0;
  host.runtime.observe = async () => ({ count: duplicate ? 2 : 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.deliveryTelemetry = async () => {
    duplicate = true; return { sufficient: false, subscriptionCount: 1, sends: 1, acknowledgements: 0, failures: 1, retryable: true, httpStatus: 503, requestAlias: 1 };
  };
  await expect(waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "private", kind: "attention",
    phase: "private_verified", timeout: 1, window: { lane: "androidPush", phase: "private_verified", after: 0, ordinal: 1 },
    rearm: async () => { rearms++; throw new Error("product failure caused mutation"); } })).rejects.toMatchObject({ evidence: { class: "product", reason: "privacy_failed" } });
  expect(rearms).toBe(0);
});

test("R2 a foreign clear acknowledgement cannot release a fresh fixture ask", async () => {
  const host = fake(), fixture = host.runtime.fixture;
  let asks = 0, answered = false;
  host.runtime.fixture = async (...args) => {
    if (args[0] === "ask") asks++;
    if (args[0] === "answer") answered = true;
    await fixture(...args);
  };
  host.runtime.observe = async () => ({ count: 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.beginDeliveryTelemetry = async phase => ({ lane: "androidPush", phase, after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: answered, subscriptionCount: 1, sends: 1, acknowledgements: answered ? 1 : 0,
    failures: answered ? 0 : 1, retryable: !answered, httpStatus: 503, clearAcknowledged: answered, requestAlias: answered ? 2 : 1 });
  await expect(runAndroidPush(host.input)).rejects.toMatchObject({ evidence: { class: "harness", reason: "delivery_timeout" } });
  expect(asks).toBe(1);
});

test("R2 deadline expiry records elapsed time and installs the late-post observer", async () => {
  const host = fake(), metrics = emptyPushDeliveryMetrics();
  await host.runtime.fixture("start", "synthetic"); await host.runtime.fixture("ask", "synthetic");
  const session = (await host.runtime.snapshot("synthetic"))!;
  host.runtime.observe = async () => ({ count: 1, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  let late: (() => Promise<void>) | undefined;
  const failure = waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "private", kind: "attention",
    phase: "private_verified", timeout: 60_000,
    execution: { signal: new AbortController().signal, deadline: performance.now() - 1, nextFailureId: () => 1 },
    onTimeout: sample => { late = sample; } });
  await expect(failure).rejects.toMatchObject({ evidence: { class: "harness", reason: "delivery_timeout" } });
  expect(late).toBeDefined();
  await late?.();
  expect(metrics.latePostCount).toBe(1);
  expect(metrics.deliveryTimings).toEqual([0, 0]);
});

test("R2 readiness preserves a late delivery observed during restoration", async () => {
  const host = fake();
  let arrived = false;
  host.runtime.observe = async () => ({ count: arrived ? 1 : 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: false, subscriptionCount: 0, sends: 0, acknowledgements: 0, failures: 0, retryable: false, httpStatus: 0 });
  const cleanup = host.runtime.cleanup;
  host.runtime.cleanup = async (...args) => { await cleanup(...args); if (args[0] === "fixtureAsk") { arrived = true; await host.runtime.pause(500); } };
  await expect(runAndroidPushReadiness(host.input)).rejects.toMatchObject({
    evidence: { lane: "rigReadiness", class: "harness", reason: "delivery_timeout", observations: { latePostCount: 1, latePostMs: 160_500 } },
  });
});

test.each(["telemetry", "request"] as const)("495 R6 cancellation during %s cannot finish a delivery", async stage => {
  const host = fake(), metrics = emptyPushDeliveryMetrics(), controller = new AbortController();
  await host.runtime.fixture("start", "synthetic"); await host.runtime.fixture("ask", "synthetic");
  const session = (await host.runtime.snapshot("synthetic"))!;
  host.runtime.observe = async () => ({ count: 1, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.deliveryTelemetry = async () => {
    if (stage === "telemetry") controller.abort();
    return { sufficient: true, subscriptionCount: 1, sends: 1, acknowledgements: 1, failures: 0, retryable: false, httpStatus: 0, requestAlias: 1 };
  };
  host.runtime.deliveryRequestMatches = async () => { controller.abort(); return true; };
  if (stage === "request") metrics.deliveryRearmCount = 1;
  let sample: (() => Promise<void>) | undefined;
  await expect(waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "private", kind: "attention", phase: "private_verified",
    timeout: 60_000, window: { lane: "androidPush", phase: "private_verified", after: 0, ordinal: 1 },
    execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 },
    onTimeout: value => { sample = value; } })).rejects.toMatchObject({ evidence: { reason: "delivery_timeout", class: "harness" } });
  // The post arrived within budget; later cancellation must not reclassify it as late.
  expect(sample).toBeUndefined();
  expect(metrics.latePostCount).toBe(0);
});

test.each(["instance", "generation"] as const)("495 R4 %s changes after clearing stop before the next ask", async variant => {
  const host = fake(), fixture = host.runtime.fixture, snapshot = host.runtime.snapshot;
  let asks = 0, answered = false;
  host.runtime.fixture = async (...args) => {
    if (args[0] === "ask") asks++;
    if (args[0] === "answer") answered = true;
    await fixture(...args);
  };
  host.runtime.snapshot = async (...args) => {
    const session = await snapshot(...args);
    return session === undefined || !answered ? session : { ...session,
      ...(variant === "instance" ? { instanceId: "foreign-instance" } : { generation: session.generation + 1 }) };
  };
  host.runtime.observe = async () => ({ count: 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.beginDeliveryTelemetry = async phase => ({ lane: "androidPush", phase, after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: answered, subscriptionCount: 1, sends: 1, acknowledgements: answered ? 1 : 0,
    failures: answered ? 0 : 1, retryable: !answered, httpStatus: 503, clearAcknowledged: answered, requestAlias: 1 });
  await expect(runAndroidPush(host.input)).rejects.toMatchObject({ evidence: { class: "harness", reason: "invalid_evidence" } });
  expect(asks).toBe(1);
});

test.each(["readiness", "qualification"] as const)("495 R5 %s metadata timeout retains late-post evidence", async lane => {
  const host = fake(), snapshot = host.runtime.snapshot, cleanup = host.runtime.cleanup;
  let late = false;
  host.runtime.snapshot = async (...args) => {
    const session = await snapshot(...args);
    return session?.inputRequired ? undefined : session;
  };
  host.runtime.observe = async () => ({ count: late ? 1 : 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.beginDeliveryTelemetry = async phase => ({ lane: phase === "readiness" ? "rigReadiness" : "androidPush", phase, after: 0, ordinal: 1 });
  host.runtime.cleanup = async (...args) => {
    await cleanup(...args);
    if (args[0] === "fixtureAsk") { late = true; await host.runtime.pause(500); }
  };
  const failure = lane === "readiness" ? runAndroidPushReadiness(host.input) : runAndroidPush(host.input);
  await expect(failure).rejects.toMatchObject({ evidence: { reason: "delivery_metadata_timeout", class: "harness" } });
  if (lane === "readiness") await expect(failure).rejects.toMatchObject({ evidence: { observations: { latePostCount: 1, latePostMs: 90_500 } } });
  else expect(parseAndroidPushProgress(host.checkpoints.at(-1)).results.private_verified).toMatchObject({ latePostCount: 1, latePostMs: 90_500 });
  expect(androidPushNeedsCleanup(host.checkpoints.at(-1))).toBe(false);
});

test("495 A1 readiness late-observer failure cannot skip subsequent restoration owners", async () => {
  const host = fake(), cleanup = host.runtime.cleanup;
  let cleaning = false;
  host.runtime.observe = async () => {
    if (cleaning) throw new Error("synthetic late observer failure");
    return { count: 0, titleMatches: true, bodyMatches: true, forbiddenFound: false };
  };
  host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: false, subscriptionCount: 0, sends: 0, acknowledgements: 0, failures: 0, retryable: false, httpStatus: 0 });
  host.runtime.cleanup = async (...args) => { cleaning = true; await cleanup(...args); };
  let failure: unknown;
  try { await runAndroidPushReadiness(host.input); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(host.cleanup).toEqual(["fixtureAsk", "doze", "network", "fixture", "notifications", "browser", "task"]);
  expect(pixelUnrestored(failure)).toBe(false);
  expect(androidPushNeedsCleanup(host.checkpoints.at(-1))).toBe(false);
});

test("495 R7 phase durations are bounded integer observations on write and read", async () => {
  const host = fake(), now = host.runtime.now;
  let fraction = 0;
  host.runtime.now = () => now() + fraction++ / 1_000;
  await runAndroidPush(host.input);
  const progress = parseAndroidPushProgress(host.checkpoints.at(-1));
  for (const phase of Object.values(progress.results)) {
    expect(Number.isSafeInteger(phase.phaseElapsedMs)).toBe(true);
    expect(phase.phaseElapsedMs as number).toBeLessThanOrEqual(86_400_000);
  }
  for (const phaseElapsedMs of [0.125, -1, 86_400_001, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseAndroidPushProgress({ ...progress, results: { private_verified: { phaseElapsedMs } } })).toThrow();
  }
});

test("R3 each delivery keeps its own first and second timing in a multi-delivery phase", async () => {
  const host = fake(), metrics = emptyPushDeliveryMetrics();
  await host.runtime.fixture("start", "synthetic"); await host.runtime.fixture("ask", "synthetic");
  const session = (await host.runtime.snapshot("synthetic"))!;
  let at = 500;
  host.runtime.observe = async () => ({ count: host.runtime.now() >= at ? 1 : 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  const deliver = () => waitForPushDelivery({ runtime: host.runtime, session, metrics, detail: "private", kind: "attention", phase: "clear_verified", timeout: 60_000 });
  await deliver(); at = 1_500; await deliver();
  expect(metrics).toMatchObject({ firstDeliveryMs: 500, deliveryTimings: [500, 0, 1_000, 0] });
});

test("R3 offline recovery closes the original send window before subscription restoration", async () => {
  const host = fake();
  const network = host.runtime.network;
  let offline = false, windowOpen = false, restored = false, postRestoreWindow = false;
  host.runtime.beginDeliveryTelemetry = async phase => {
    if (restored) postRestoreWindow = true;
    windowOpen = true; return { lane: "androidPush", phase, after: 0, ordinal: 1 };
  };
  host.runtime.deliveryTelemetry = async () => {
    windowOpen = false; return { sufficient: true, subscriptionCount: 1, sends: 1, acknowledgements: 1, failures: 0, retryable: false, httpStatus: 0, requestAlias: 1 };
  };
  host.runtime.network = async value => {
    if (offline && value === "wifi") { expect(windowOpen).toBe(false); restored = true; }
    offline = value === "airplane"; return network(value);
  };
  await runAndroidPush(host.input);
  expect(postRestoreWindow).toBe(true);
});

test("R6 an absent phone notification does not prove outbound clear before re-arm", async () => {
  const host = fake(); let asks = 0;
  const fixture = host.runtime.fixture;
  host.runtime.fixture = async (...args) => { if (args[0] === "ask") asks++; await fixture(...args); };
  host.runtime.observe = async () => ({ count: 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.beginDeliveryTelemetry = async phase => ({ lane: "androidPush", phase, after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: false, subscriptionCount: 1, sends: 1, acknowledgements: 0, failures: 1, retryable: true, httpStatus: 503, clearAcknowledged: false, requestAlias: 1 });
  await expect(runAndroidPush(host.input)).rejects.toMatchObject({ evidence: { class: "harness", reason: "delivery_timeout" } });
  expect(asks).toBe(1);
});

test("R6 fresh ask waits for outbound clear acknowledgement and fresh-request ownership", async () => {
  const host = fake();
  const fixture = host.runtime.fixture, observe = host.runtime.observe;
  let asks = 0, answeredAt = 0, clearAcknowledged = false;
  host.runtime.fixture = async (...args) => {
    if (args[0] === "answer") answeredAt = host.runtime.now();
    if (args[0] === "ask") { asks++; if (asks === 2) expect(clearAcknowledged).toBe(true); }
    await fixture(...args);
  };
  host.runtime.observe = async (...args) => asks === 1 ? { count: 0, titleMatches: true, bodyMatches: true, forbiddenFound: false } : observe(...args);
  host.runtime.beginDeliveryTelemetry = async phase => ({ lane: "androidPush", phase, after: 0, ordinal: 1 });
  host.runtime.deliveryTelemetry = async () => {
    clearAcknowledged = answeredAt > 0 && host.runtime.now() - answeredAt >= 1_000;
    return { sufficient: asks > 1, subscriptionCount: 1, sends: 1, acknowledgements: asks > 1 ? 1 : 0, failures: asks > 1 ? 0 : 1,
      retryable: asks === 1, httpStatus: 503, clearAcknowledged, requestAlias: 1 };
  };
  host.runtime.deliveryRequestMatches = async () => true;
  await runAndroidPush(host.input);
  expect(parseAndroidPushProgress(host.checkpoints.at(-1)).results.private_verified).toMatchObject({ deliveryRearmCount: 1, clearMs: 1_000 });
});

test("readiness includes fixture acknowledgement time in its 160-second delivery bound", async () => {
  const host = fake();
  const fixture = host.runtime.fixture;
  host.runtime.fixture = async (...args) => {
    await fixture(...args);
    if (args[0] === "ask") await host.runtime.pause(160_000);
  };
  host.runtime.beginDeliveryTelemetry = async () => ({ lane: "rigReadiness", phase: "readiness", after: 0, ordinal: 1 });
  await expect(runAndroidPushReadiness(host.input)).rejects.toMatchObject({ evidence: { lane: "rigReadiness", step: "pixel_push", reason: "delivery_timeout" } });
  expect(parseAndroidPushProgress(host.checkpoints.at(-1)).cleanupRequired).toBe(false);
  expect(host.state().device).toEqual(baseline);
});

test("overlap recovery cannot reset the phase's consumed delivery re-arm budget", async () => {
  const host = fake();
  const fixture = host.runtime.fixture, observe = host.runtime.observe;
  let asks = 0, overlap = false;
  host.runtime.fixture = async (...args) => { if (args[0] === "ask") asks++; await fixture(...args); };
  host.runtime.observe = async (...args) => args[0].inputRequired && (asks === 1 || asks === 3) ?
    { count: 0, titleMatches: false, bodyMatches: false, forbiddenFound: false } : observe(...args);
  host.runtime.assertNotificationOwnership = async () => {
    if (asks === 2 && !overlap) { overlap = true; throw new NotificationOverlapError(); }
  };
  host.runtime.beginDeliveryTelemetry = async phase => ({ lane: "androidPush", phase, after: 0, ordinal: asks + 1 });
  host.runtime.deliveryTelemetry = async () => ({ sufficient: false, subscriptionCount: 1, sends: 1, acknowledgements: 0, failures: 1, retryable: true, httpStatus: 503, clearAcknowledged: true, requestAlias: 1 });
  host.runtime.deliveryRequestMatches = async () => true;
  await expect(runAndroidPush(host.input)).rejects.toMatchObject({ evidence: { class: "infra_transient", reason: "push_service_failure" } });
  expect(asks).toBe(3);
  expect(parseAndroidPushProgress(host.checkpoints.at(-1)).results.private_verified).toMatchObject({
    rearmCount: 1, rearmReason: "unowned_notification_overlap", deliveryRearmCount: 1, deliveryRearmReason: 1,
  });
});

test("a post arriving during timeout cleanup is recorded but never turns the missed ask into a pass", async () => {
  const host = fake();
  const cleanup = host.runtime.cleanup;
  let late = false;
  host.runtime.observe = async () => ({ count: late ? 1 : 0, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  host.runtime.cleanup = async (...args) => {
    if (args[0] === "fixtureAsk") { await host.runtime.pause(1_500); late = true; }
    await cleanup(...args);
  };
  await expect(runAndroidPush(host.input)).rejects.toMatchObject({ evidence: { class: "harness", reason: "delivery_timeout" } });
  const progress = parseAndroidPushProgress(host.checkpoints.at(-1));
  expect(progress.results.private_verified).toMatchObject({ firstDeliveryMs: 60_000, latePostCount: 1, latePostMs: 61_500, deliveryRearmCount: 0 });
  expect(progress.results.private_verified?.delivered).toBeUndefined();
  expect(progress.cleanupRequired).toBe(false);
});

test.each(["surface", "surface-unavailable", "pin", "credential"] as const)("notification authentication accepts dismissal during %s observation without application input", async boundary => {
  let locked = true, revealed = false, credentialAttempts = 0, applicationInput = false;
  let waits = 0;
  await authenticateAndroidNotification({
    command: async (...args) => {
      if (args.join(" ") === "shell dumpsys window") return `isKeyguardShowing=${locked}`;
      if (args.join(" ") !== "exec-out uiautomator dump /dev/tty") throw new Error("unexpected authentication mutation");
      if (boundary.startsWith("surface")) locked = false;
      if (boundary === "surface-unavailable") return "ERROR: no root node during dismissal";
      return `<hierarchy>${!locked ? "" : `<node package="com.android.systemui" resource-id="com.android.systemui:id/${revealed ? "pinEntry" : "alternate_bouncer"}" password="${revealed}" bounds="[0,0][40,40]"/>`}</hierarchy>`;
    },
    revealPin: async () => { if (!locked) applicationInput = true; revealed = true; if (boundary === "pin") locked = false; },
    unlock: async () => { credentialAttempts++; if (!locked) applicationInput = true; locked = false; },
    wait: async predicate => {
      waits++;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await predicate()) { if (boundary === "credential" && waits === 2) locked = false; return; }
      }
      throw new Error("synthetic observation deadline");
    },
  });
  expect(locked).toBe(false);
  expect(credentialAttempts).toBe(0);
  expect(applicationInput).toBe(false);
});

test.each(["secure-pin", "multiple-inputs", "unavailable-ui"] as const)("notification authentication handles %s without guessing a credential target", async scenario => {
  let locked = true, revealed = false, credentialAttempts = 0;
  let failure: unknown;
  try {
    await authenticateAndroidNotification({
      command: async (...args) => {
        if (args.join(" ") === "shell dumpsys window") return `isKeyguardShowing=${locked}`;
        if (args.join(" ") !== "exec-out uiautomator dump /dev/tty") throw new Error("unexpected authentication mutation");
        if (scenario === "unavailable-ui") return "ERROR: no root node while locked";
        const node = `<node package="com.android.systemui" resource-id="com.android.systemui:id/${revealed ? "pinEntry" : "alternate_bouncer"}" password="${revealed}" bounds="[0,0][40,40]"/>`;
        return `<hierarchy>${node}${revealed && scenario === "multiple-inputs" ? node : ""}</hierarchy>`;
      },
      revealPin: async () => { revealed = true; },
      unlock: async () => { credentialAttempts++; locked = false; },
      wait: async predicate => {
        for (let attempt = 0; attempt < 3; attempt++) if (await predicate()) return;
        throw new Error("synthetic observation deadline");
      },
    });
  } catch (error) { failure = error; }
  expect(credentialAttempts).toBe(scenario === "secure-pin" ? 1 : 0);
  expect(locked).toBe(scenario !== "secure-pin");
  expect(failure instanceof Error).toBe(scenario !== "secure-pin");
});

test("notification authentication reveals the PIN from Pixel's standalone fingerprint bouncer window", async () => {
  // The Compose keyguard exposes no alternate_bouncer resource; only its focused window names it.
  let locked = true, revealed = false, credentialAttempts = 0;
  await authenticateAndroidNotification({
    command: async (...args) => {
      if (args.join(" ") === "shell dumpsys window") {
        return `  mCurrentFocus=Window{9878c1f u0 ${revealed ? "NotificationShade" : "AlternateBouncerView"}}\n    isKeyguardShowing=${locked}`;
      }
      if (args.join(" ") !== "exec-out uiautomator dump /dev/tty") throw new Error("unexpected authentication mutation");
      const pin = revealed ? `<node package="com.android.systemui" resource-id="" password="true" bounds="[0,0][40,40]"/>` : "";
      return `<hierarchy><node package="com.android.systemui" resource-id="" password="false" bounds="[0,0][1080,2410]"/>${pin}</hierarchy>`;
    },
    revealPin: async () => { revealed = true; },
    unlock: async () => {
      if (!revealed) throw new Error("credential typed without a PIN field");
      credentialAttempts++;
      locked = false;
    },
    wait: async predicate => {
      for (let attempt = 0; attempt < 3; attempt++) if (await predicate()) return;
      throw new Error("synthetic observation deadline");
    },
  });
  expect(credentialAttempts).toBe(1);
  expect(locked).toBe(false);
});

test("tap authorization rejects the wrong role, stale generation, missing request, and malformed body", () => {
  const session = { generation: 2, ask: { requestId: "synthetic-current", since: "2026-01-01T00:00:00Z" } };
  const body = { mode: "control", generation: 2, requestId: "synthetic-current" };
  expect(observePushLaunch(session, "attention", JSON.stringify(body))).toEqual({ currentGeneration: true, currentRequest: true, modeMatches: true });
  expect(observePushLaunch(session, "activity_stop", JSON.stringify(body)).modeMatches).toBe(false);
  expect(observePushLaunch(session, "attention", JSON.stringify({ ...body, mode: "view" })).modeMatches).toBe(false);
  expect(observePushLaunch(session, "attention", JSON.stringify({ ...body, generation: 1 })).currentGeneration).toBe(false);
  expect(observePushLaunch({ generation: 2 }, "attention", JSON.stringify({ mode: "control", generation: 2 })).currentRequest).toBe(false);
  expect(observePushLaunch(session, "attention", JSON.stringify({ ...body, requestId: "synthetic-stale" })).currentRequest).toBe(false);
  for (const malformed of [undefined, "null", "[]", "{"]) expect(observePushLaunch(session, "attention", malformed)).toEqual({ currentGeneration: false, currentRequest: false, modeMatches: false });
});

test("notification denial survives returning to the caller and releases its browser connection", async () => {
  let allowed = true, closed = false;
  const release = await holdAndroidNotificationDenial("https://gateway.example.test", async run => {
    try { await run({ browserSend: async (method, parameters) => {
      if (method === "Browser.setPermission") allowed = parameters?.setting !== "denied";
      return {};
    } }); } finally { allowed = true; closed = true; }
  });
  expect(allowed).toBe(false); expect(closed).toBe(false);
  await release(); expect(allowed).toBe(true); expect(closed).toBe(true);
  await release(); expect(allowed).toBe(true);
});

test("orphan-forward cleanup admits only the reserved ports on the exact device and browser socket", () => {
  const socket = "localabstract:chrome_devtools_remote";
  expect(ownedPushForwards(`synthetic-device tcp:9237 ${socket}\nsynthetic-device tcp:9238 ${socket}\nother-device tcp:9999 unrelated`, "synthetic-device", socket)).toEqual(["tcp:9237", "tcp:9238"]);
  expect(() => ownedPushForwards(`other-device tcp:9237 ${socket}`, "synthetic-device", socket)).toThrow("another connection");
  expect(() => ownedPushForwards("synthetic-device tcp:9238 localabstract:foreign_browser", "synthetic-device", socket)).toThrow("another connection");
});

test("a lost denial connection remains the primary error when releasing its resources also fails", async () => {
  let closed = false;
  const primary = new Error("synthetic disconnected browser");
  const cleanup = new Error("synthetic forward cleanup failure");
  const release = await holdAndroidNotificationDenial("https://gateway.example.test", async run => {
    try { await run({ browserSend: async method => { if (method === "Browser.getVersion") throw primary; return {}; } }); }
    finally { closed = true; throw cleanup; }
  });
  await expect(release()).rejects.toMatchObject({ errors: [primary, cleanup] });
  expect(closed).toBe(true);
});

test("non-granted origin permission fails admission without starting a fixture or changing the preference", async () => {
  for (const browserPermission of ["default", "denied"] as const) {
    const state = fake({ browserPermission });
    await expect(runAndroidPush(state.input)).rejects.toThrow("grant origin notification permission");
    expect(state.state().effects).toBe(0); expect(state.state().started).toBe(false);
    expect(state.state().browser.permission).toBe(browserPermission);
    expect(state.checkpoints.at(-1)?.cleanupRequired).toBe(false);
  }
});

test("Push admission accepts any identified Pixel on Android 13+ and names what it refused", () => {
  for (const [model, release] of [["Pixel 10 Pro", "17"], ["Pixel 8 Pro", "17"], ["Pixel 7", "13"], ["Pixel 9a", "16.1"]] as const) {
    expect(() => requireAndroidPushDevice(model, release)).not.toThrow();
  }
  expect(() => requireAndroidPushDevice("SM-S928B", "17")).toThrow('Android Push requires a Pixel; attached model is "SM-S928B"');
  expect(() => requireAndroidPushDevice("Pixel 6", "12")).toThrow("Android 13 or newer");
  expect(() => requireAndroidPushDevice("Pixel 8 Pro", "")).toThrow("Android 13 or newer");
  expect(() => requireAndroidPushDevice("", "17")).toThrow("requires a Pixel");
});

test("delayed clears for distinct requests do not look like a duplicate unchanged ask", () => {
  const posts = new Map<string, { key: string; postedAt: number }>();
  const first = { generation: 1, inputRequired: true, ask: { requestId: "synthetic-first", since: "2026-01-01T00:00:00Z" } };
  const second = { ...first, ask: { ...first.ask, requestId: "synthetic-second" } };
  const resolved = { generation: 1, inputRequired: false };
  const older = { key: "synthetic-key", postedAt: 1 }, newer = { key: "synthetic-key", postedAt: 2 };
  trackUnchangedNotificationPost(posts, first, "attention", older);
  trackUnchangedNotificationPost(posts, resolved, "attention", older);
  trackUnchangedNotificationPost(posts, second, "attention", newer);
  trackUnchangedNotificationPost(posts, resolved, "attention", newer);
  trackUnchangedNotificationPost(posts, second, "attention", newer);
  expect(() => trackUnchangedNotificationPost(posts, second, "attention", { ...newer, postedAt: 3 })).toThrow("posted again for unchanged authoritative state");
});

test("opaque notification ownership survives platform prefixes but never matches a different topic", () => {
  const topic = "omp-attention-synthetic-omp-attention-fixture";
  const digest = notificationTopicDigest(topic);
  expect(notificationMatchesDigest(`platform#${topic}`, digest)).toBe(true);
  expect(notificationMatchesDigest(topic, digest)).toBe(true);
  expect(notificationMatchesDigest(`platform#${topic}-foreign`, digest)).toBe(false);
  expect(notificationMatchesDigest("platform#omp-attention-unowned-fixture", digest)).toBe(false);
  expect(notificationMatchesDigest("unrelated", digest)).toBe(false);
});

test("notification-route observation admits the query route but rejects prefix collisions and foreign origins", () => {
  const origin = "https://gateway.example.test";
  expect(isPushNotificationRoute(`${origin}/collab?generation=1`, origin)).toBe(true);
  expect(isPushNotificationRoute(`${origin}/collab/attention?generation=1`, origin)).toBe(true);
  for (const value of [`${origin}/collaborator`, "https://foreign.example.test/collab", "/collab", undefined]) expect(isPushNotificationRoute(value, origin)).toBe(false);
});

test("matrix records both force-stop and Doze variants without turning suppression into a delivery guarantee", async () => {
  for (const delivered of [false, true]) {
    const f = fake({ forceDelivery: delivered, dozeDelivery: delivered });
    const result = await runAndroidPush(f.input);
    expect(result.passed).toBe(true);
    const final = parseAndroidPushProgress(f.checkpoints.at(-1));
    expect(final.results.force_stop_verified?.variant).toBe(delivered ? "delivered_while_force_stopped" : "suppressed_until_relaunch");
    expect(final.results.doze_verified?.variant).toBe(delivered ? "delivered_during_doze" : "delivered_after_doze_exit");
    expect(final.results.permission_verified?.suppressed).toBe(true);
    expect(f.state()).toMatchObject({ started: false, asking: false, device: baseline, browser: browserBaseline, shown: undefined });
  }
});

// A campaign's push arrived minutes after forced Doze ended: FCM still held it. ADR-031 records Doze
// behavior as an observed variant, never a delivery guarantee, so a held push is an outcome, not a failure.
test("a push that forced Doze still holds after exit is recorded as undelivered, not a failure", async () => {
  const f = fake({ dozeHeld: true });
  const result = await runAndroidPush(f.input);
  expect(result.passed).toBe(true);
  const final = parseAndroidPushProgress(f.checkpoints.at(-1));
  expect(final.results.doze_verified?.variant).toBe("undelivered_after_doze_exit");
  expect(final.results.network_verified?.wifiDelivery).toBe(true);
  expect(f.state()).toMatchObject({ started: false, asking: false, device: baseline, browser: browserBaseline, shown: undefined });
});

// In both prealpha.3 campaigns the Pixel's Chrome, frozen after forced Doze, processed a push only once
// another lane opened Chrome: a clear waited minutes. So no delivery phase follows Doze, and the Doze
// phase resumes the app once, letting a deferred ask or clear run before the lane moves on.
test("a clear deferred after forced Doze is flushed by resuming the app, and no delivery phase follows Doze", async () => {
  const f = fake({ deferredAfterDoze: true });
  const result = await runAndroidPush(f.input);
  expect(result.passed).toBe(true);
  const final = parseAndroidPushProgress(f.checkpoints.at(-1));
  expect(final.results.doze_verified?.variant).toBe("delivered_after_doze_exit");
  expect(final.results.network_verified).toMatchObject({ wifiDelivery: true, recovered: true });
  expect(f.state()).toMatchObject({ started: false, asking: false, device: baseline, browser: browserBaseline, shown: undefined });
});

// In the first v0.6.1-prealpha.1 campaign, Play Services' push socket reconnected on the return from
// Airplane mode, delivered the held ask, then died silently: the clear sent right after arrived 61 s
// after the answer, 0.4 s after the socket reconnected, and the lane had stopped waiting at 60 s. Any
// radio change opens a fresh socket, so every push wait after one allows the recovery window, and a
// push held past that window still fails the lane.
test.each(["airplane", "any"] as const)("a push held while Play Services reconnects after a radio change (%s) waits within the recovery window", async after => {
  const f = fake({ staleSocket: { ms: 70_000, after } });
  expect((await runAndroidPush(f.input)).passed).toBe(true);
  const final = parseAndroidPushProgress(f.checkpoints.at(-1));
  expect(final.results.network_verified).toMatchObject({ wifiDelivery: true, cellularDelivery: true, airplaneSuppressed: true, recovered: true });
  expect(f.state()).toMatchObject({ started: false, asking: false, device: baseline, browser: browserBaseline, shown: undefined });

  const held = fake({ staleSocket: { ms: 170_000, after } });
  await expect(runAndroidPush(held.input)).rejects.toMatchObject({ evidence: { step: "network_verified", class: "harness", reason: "delivery_timeout" } });
  expect(held.state()).toMatchObject({ started: false, asking: false, device: baseline, browser: browserBaseline, shown: undefined });
});

test("permission restoration uses the bounded recovery window for its first delivery", async () => {
  const recovered = fake({ permissionRecoveryMs: 70_000 });
  expect((await runAndroidPush(recovered.input)).passed).toBe(true);
  const final = parseAndroidPushProgress(recovered.checkpoints.at(-1));
  expect(final.results.permission_verified).toMatchObject({ suppressed: true, freshDelivery: true });
  expect(androidPushNeedsCleanup(final)).toBe(false);
  expect(recovered.state()).toMatchObject({ started: false, secondaryStarted: false, asking: false, device: baseline, browser: browserBaseline, shown: undefined });

  const held = fake({ permissionRecoveryMs: 170_000 });
  await expect(runAndroidPush(held.input)).rejects.toMatchObject({ evidence: { step: "permission_verified", class: "harness", reason: "delivery_timeout", elapsedMs: 160_000 } });
  expect(androidPushNeedsCleanup(held.checkpoints.at(-1))).toBe(false);
  expect(held.state()).toMatchObject({ started: false, secondaryStarted: false, asking: false, device: baseline, browser: browserBaseline, shown: undefined });
});

test("every non-idempotent interruption restores every baseline and stops both owned fixtures", async () => {
  const successful = fake(); await runAndroidPush(successful.input);
  for (let failAfter = 1; failAfter <= successful.state().effects; failAfter++) {
    const f = fake({ failAfter });
    await expect(runAndroidPush(f.input)).rejects.toThrow("synthetic interruption");
    expect(f.state()).toMatchObject({ started: false, secondaryStarted: false, localRecords: 0, asking: false, device: baseline, browser: browserBaseline, shown: undefined });
    expect(androidPushNeedsCleanup(f.checkpoints.at(-1))).toBe(false);
  }
});

test("queue order, Hold, Hide and delayed taps pass on the device and leave no local records or second host", async () => {
  const f = fake();
  expect((await runAndroidPush(f.input)).passed).toBe(true);
  const final = parseAndroidPushProgress(f.checkpoints.at(-1));
  expect(final.results.triage_verified).toMatchObject({ fifo: true, holdAdvanced: true, allHeld: true, staleHoldReleased: true, undoExpired: true, attentionRestored: true, mutations: 0 });
  expect(final.results.stale_taps_verified).toMatchObject({ resolved: true, rearmed: true, replaced: true, expired: true, launches: 0, replayed: true });
  expect(final.secondaryNotificationTopicDigest).toBe(notificationTopicDigest(`omp-attention-${SECONDARY}`));
  expect(f.state()).toMatchObject({ started: false, secondaryStarted: false, localRecords: 0, shown: undefined, device: baseline, browser: browserBaseline });
});

test.each([
  ["a directory that does not queue asks in arrival order", { wrongOrder: true }, "arrival order"],
  ["a Hold that reaches the gateway", { triageMutation: "hold" }, "on this device alone"],
  ["an Undo that reaches the gateway", { triageMutation: "undo" }, "did not restore the hidden row"],
  ["a delayed tap on a resolved request that still launches", { staleLaunch: true }, "resolved request tap did not fail closed"],
] as const)("%s fails closed and restores both hosts and the device", async (_case, options, message) => {
  const f = fake(options);
  await expect(runAndroidPush(f.input)).rejects.toThrow(message);
  expect(f.state()).toMatchObject({ started: false, secondaryStarted: false, localRecords: 0, device: baseline, browser: browserBaseline });
  expect(androidPushNeedsCleanup(f.checkpoints.at(-1))).toBe(false);
});

test("progress written before the second host parses without its topic; a malformed one does not", async () => {
  const f = fake(); await runAndroidPush(f.input);
  const { secondaryNotificationTopicDigest: _secondary, ...earlier } = f.checkpoints.at(-1)!;
  expect(parseAndroidPushProgress(earlier).secondaryNotificationTopicDigest).toBeNull();
  expect(() => parseAndroidPushProgress({ ...earlier, secondaryNotificationTopicDigest: "not-a-digest" })).toThrow("notification ownership");
});

test("failed cleanup remains resumable and later cleanup attempts every step", async () => {
  const options: FakeOptions = { cleanupFail: "browser" };
  const f = fake(options);
  await expect(runAndroidPush(f.input)).rejects.toMatchObject({ pixelUnrestored: true });
  expect(f.state().started).toBe(false);
  const progress = f.checkpoints.at(-1);
  expect(androidPushNeedsCleanup(progress)).toBe(true);
  expect(f.state().browser).not.toEqual(browserBaseline);
  await expect(cleanupAndroidPush({ ...f.input, progress })).rejects.toMatchObject({ pixelUnrestored: true });
  delete options.cleanupFail;
  const result = await cleanupAndroidPush({ ...f.input, progress });
  expect(result.restored).toBe(true);
  expect(f.state()).toMatchObject({ started: false, device: baseline, browser: browserBaseline, shown: undefined });
});

test("a notification arriving during fixture shutdown is removed before cleanup succeeds", async () => {
  const f = fake({ shutdownNotification: true });
  await runAndroidPush(f.input);
  expect(f.state()).toMatchObject({ started: false, shown: undefined, device: baseline, browser: browserBaseline });
  expect(androidPushNeedsCleanup(f.checkpoints.at(-1))).toBe(false);
});

test("elapsed time without another host observation cannot qualify two known-busy polls", async () => {
  const f = fake({ frozenHeartbeat: true });
  await expect(runAndroidPush(f.input)).rejects.toThrow();
  const progress = parseAndroidPushProgress(f.checkpoints.at(-1));
  expect(progress.results.activity_stop_verified).toMatchObject({ phaseElapsedMs: 111_000 });
  expect(progress.results.activity_stop_verified?.knownBusyPolls).toBeUndefined();
  expect(progress.cleanupRequired).toBe(false);
  expect(f.state()).toMatchObject({ started: false, asking: false, device: baseline, browser: browserBaseline });
});

test("a DND schedule reactivating during a phase stops it and still restores the baseline", async () => {
  const f = fake({ dndFlipAfter: 3 });
  await expect(runAndroidPush(f.input)).rejects.toThrow("turn Do Not Disturb off on the Pixel for the qualification window");
  expect(f.state()).toMatchObject({ started: false, device: baseline, browser: browserBaseline });
});

test("Pixel lease retains an unrestored baseline and refuses live or foreign owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-push-lease-"));
  const lock = join(directory, "lock");
  try {
    await expect(withDevelopmentPixelLease("PushLane test", async () => { throw new Error("interrupted"); }, () => false, lock)).rejects.toThrow("interrupted");
    const marker = await readFile(join(lock, "owner"), "utf8");
    await expect(withDevelopmentPixelLease("WindowsLane test", async () => {}, () => true, lock, true)).rejects.toThrow("not owned");
    await expect(withDevelopmentPixelLease("PushLane test", async () => {}, () => true, lock, true)).rejects.toThrow("still running");
    expect(await readFile(join(lock, "owner"), "utf8")).toBe(marker);
    await rm(lock, { recursive: true });
    await withDevelopmentPixelLease("PushLane test", async () => {}, () => true, lock);
    await expect(readFile(join(lock, "owner"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(directory, { recursive: true }); }
});

test("fixture cleanup removes an interrupted empty creation but refuses an unowned tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-push-fixture-"));
  const root = join(directory, "owned");
  const location = { root, epoch: randomUUID(), binary: "synthetic", scripts: directory, bun: process.execPath };
  try {
    await mkdir(root);
    await runFixtureOperation(location, "stop");
    await runFixtureOperation(location, "stop");
    await mkdir(root);
    await writeFile(join(root, "owner"), "another owner");
    await expect(runFixtureOperation(location, "stop")).rejects.toThrow("ownership changed");
    expect(await readFile(join(root, "owner"), "utf8")).toBe("another owner");
  } finally { await rm(directory, { recursive: true }); }
});

test("fixture cleanup preserves ownership while a child outlives its holder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-push-fixture-process-"));
  const root = join(directory, "owned");
  const location = { root, epoch: randomUUID(), binary: "synthetic", scripts: directory, bun: process.execPath };
  let childAlive = true;
  const execute: FixtureExecutor = async argv => {
    if (argv[0] === "sh") {
      await writeFile(join(root, "pid"), "4242");
      await writeFile(join(root, "ack.json"), JSON.stringify({ epoch: location.epoch, sequence: 0, phase: "ready" }));
      return { exitCode: 0, stdout: "" };
    }
    if (argv[0] === "ps" && argv.includes("-p")) return { exitCode: 1, stdout: "" };
    if (argv[0] === "ps" && argv.includes("-axo")) return { exitCode: 0, stdout: childAlive ? "synthetic-omp --config " + join(root, "fixture.yml") : "" };
    throw Error("unexpected host mutation");
  };
  try {
    await runFixtureOperation(location, "start", execute);
    await expect(runFixtureOperation(location, "stop", execute)).rejects.toThrow("remained active");
    expect(await readFile(join(root, "owner"), "utf8")).toBe(location.epoch);
    childAlive = false;
    await runFixtureOperation(location, "stop", execute);
    await expect(readFile(join(root, "owner"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(directory, { recursive: true }); }
});

test("fixture cleanup never signals a reused PID or a foreign process group", async () => {
  for (const ownHolder of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "omp-push-fixture-identity-"));
    const root = join(directory, "owned");
    const location = { root, epoch: randomUUID(), binary: "synthetic", scripts: directory, bun: process.execPath };
    const execute: FixtureExecutor = async argv => {
      if (argv[0] !== "ps") throw Error("unexpected signal");
      return { exitCode: 0, stdout: argv.includes("-p") ? "9999 S " + (ownHolder ? join(root, "hold.py") : "unrelated-process") : "" };
    };
    try {
      await mkdir(root); await writeFile(join(root, "owner"), location.epoch); await writeFile(join(root, "pid"), "4242");
      if (ownHolder) {
        await expect(runFixtureOperation(location, "stop", execute)).rejects.toThrow("process group changed");
        expect(await readFile(join(root, "owner"), "utf8")).toBe(location.epoch);
      } else {
        await runFixtureOperation(location, "stop", execute);
        await expect(readFile(join(root, "owner"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await rm(directory, { recursive: true }); }
  }
});

test("multiple notifications and a stop tap that escalates to Control fail closed", async () => {
  for (const options of [{ duplicate: true }, { wrongTap: true }]) {
    const f = fake(options);
    const failed = runAndroidPush(f.input);
    await expect(failed).rejects.toThrow();
    await expect(failed).rejects.not.toMatchObject({ pixelUnrestored: true });
    expect(f.state().started).toBe(false);
    expect(f.state().device).toEqual(baseline);
  }
});

// A development run on the operator's gateway re-armed stale_generation_verified for a foreign post
// while its own activity-stop notice showed. That notice has no clear, so the re-arm waited 160 s for
// the owned tag to empty and failed the lane.
test("a foreign post while an owned activity-stop notice shows re-arms without waiting for a clear that never comes", async () => {
  const f = fake({ foreignDuringStop: true });
  expect((await runAndroidPush(f.input)).passed).toBe(true);
  expect(parseAndroidPushProgress(f.checkpoints.at(-1)).results.activity_stop_verified).toMatchObject({ rearmCount: 1, viewOnly: true });
  expect(f.state()).toMatchObject({ started: false, secondaryStarted: false, shown: undefined, device: baseline });
});

test("one foreign post re-arms its phase visibly; a second overlap fails rather than hiding it", async () => {
  const once = fake({ overlaps: 1 });
  expect((await runAndroidPush(once.input)).passed).toBe(true);
  expect(parseAndroidPushProgress(once.checkpoints.at(-1)).results.private_verified).toMatchObject({ rearmCount: 1, rearmReason: "unowned_notification_overlap", delivered: true });
  const twice = fake({ overlaps: 2 });
  await expect(runAndroidPush(twice.input)).rejects.toThrow("unowned notification overlapped");
  expect(parseAndroidPushProgress(twice.checkpoints.at(-1)).results.private_verified).toMatchObject({ rearmCount: 1, rearmReason: "unowned_notification_overlap", deliveryRearmCount: 0 });
  expect(twice.state()).toMatchObject({ started: false, device: baseline, browser: browserBaseline });
});

test("missing cellular path is a named blocked sub-phase, not a passed network matrix", async () => {
  const f = fake({ cellular: false }); const result = await runAndroidPush(f.input);
  expect(result.passed).toBe(false);
  const final = parseAndroidPushProgress(f.checkpoints.at(-1));
  expect(final.results.network_verified?.blocked).toBe("cellular_path_unavailable");
  expect(final.results.network_verified).toMatchObject({ wifiDelivery: true, airplaneSuppressed: true, recovered: true });
  expect(final.results.network_verified?.cellularDelivery).toBeUndefined();
  expect(final.results.forbidden_sinks_verified?.clean).toBe(true);
  expect(f.state().device).toEqual(baseline);
});

test("foreign, malformed, and secret-bearing checkpoints cannot drive cleanup", async () => {
  const f = fake(); await runAndroidPush(f.input);
  const valid = f.checkpoints.at(-1)!;
  for (const change of [{ epoch: "not-an-epoch" }, { phase: "unknown" }, { lane: "windows" }, { extra: true }, { notificationTopicDigest: "not-a-digest" },
    { device: { ...baseline, serial: "synthetic" } }, { results: { private_verified: { password: "SYNTHETIC-SECRET" } } }]) {
    expect(() => parseAndroidPushProgress({ ...valid, ...change })).toThrow();
  }
  await expect(cleanupAndroidPush({ ...f.input, progress: valid, identity: { ...identity, origin: "https://other.example.test" } })).rejects.toThrow("different candidate or origin");
  expect(JSON.stringify(valid)).not.toContain("gateway.example.test");
  expect(JSON.stringify(valid)).not.toContain("synthetic-instance");
  expect(JSON.stringify(valid)).not.toContain(SECONDARY);
});

test("notification observation checks exact Private, Session and Preview-fallback presentation without returning content", () => {
  const make = (body: string) => `Notification List:\n  NotificationRecord(1: pkg=org.chromium.webapk.synthetic user=0 tag=omp-attention-fixture)\n    key=synthetic-key\n    mUpdateTimeMs=1000000000000\n    android.title=String (OMP session needs attention)\n    android.text=String (${body})\nRanking Config:`;
  const expected = { packageName: "org.chromium.webapk.synthetic", tag: "omp-attention-fixture", title: "OMP session needs attention", body: "", forbidden: ["SYNTHETIC-SECRET"], originHost: "owned.example.test" };
  expect(observeNotificationDump("Current Notification Manager state:\nRanking Config:", expected).count).toBe(0);
  expect(() => observeNotificationDump("DUMP TIMEOUT", expected)).toThrow("unavailable");
  expect(observeNotificationDump(make(""), expected)).toEqual({ count: 1, titleMatches: true, bodyMatches: true, forbiddenFound: false });
  expect(observeNotificationDump(make("Synthetic session · Synthetic project"), { ...expected, body: "Synthetic session · Synthetic project" }).bodyMatches).toBe(true);
  const leaked = observeNotificationDump(make("SYNTHETIC-SECRET"), expected);
  expect(leaked.forbiddenFound).toBe(true);
  expect(JSON.stringify(leaked)).not.toContain("SYNTHETIC-SECRET");
});

test("notification ownership excludes another topic with the same visible title and an identifier prefix", () => {
  const row = (tag: string, key: string, postedAt: number) => `\n  NotificationRecord(1: pkg=org.chromium.webapk.synthetic user=0 tag=${tag})\n    key=${key}\n    mUpdateTimeMs=${postedAt}\n    android.title=String (OMP session needs attention)\n    android.text=String ()`;
  const own = row("origin#omp-attention-fixture", "synthetic-own-key", 1000000000000);
  const other = row("origin#omp-attention-fixture-other", "synthetic-other-key", 1000000000001);
  const expected = { packageName: "org.chromium.webapk.synthetic", tag: "omp-attention-fixture", title: "OMP session needs attention", body: "", forbidden: [], originHost: "owned.example.test" };
  expect(observeNotificationDump(`Notification List:${own}${other}\nRanking Config:`, expected)).toMatchObject({ count: 1, titleMatches: true, bodyMatches: true });
  expect(() => observeNotificationDump(`Notification List:${own.replace("mUpdateTimeMs=1000000000000", "mUpdateTimeMs=unknown")}\nRanking Config:`, expected)).toThrow("record identity unavailable");
});

test("notification selection expands its group and targets the child bound to the owned record", async () => {
  const expected = { packageName: "org.chromium.webapk.synthetic", tag: "omp-attention-fixture", title: "OMP session needs attention", body: "Synthetic project", forbidden: [], originHost: "owned.example.test" };
  const row = (tag: string, key: string) => `\n NotificationRecord(1: pkg=${expected.packageName} tag=${tag})\n key=${key}\n mUpdateTimeMs=1000000000000\n android.title=String (${expected.title})\n android.text=String (${tag === expected.tag ? expected.body : "Unowned project"})`;
  let expanded = false; let reads = 0; let interfere = false;
  const taps: string[][] = [];
  const command = async (...args: string[]) => {
    if (args.includes("dumpsys")) { reads++; return `Notification List:${row(expected.tag, "own-key")}${interfere && reads > 1 ? row("omp-attention-other", "other-key") : ""}\nRanking Config:`; }
    if (args.includes("size")) return "Physical size: 400x800";
    if (args.includes("tap")) { taps.push(args.slice(-2)); expanded = true; return ""; }
    if (!args.includes("uiautomator")) return "";
    return `<hierarchy><node resource-id="com.android.systemui:id/expandableNotificationRow" bounds="[0,0][400,400]">
      <node text="OMP Sessions" bounds="[20,0][200,40]"/>
      <node resource-id="android:id/expand_button" content-desc="${expanded ? "Collapse" : "Expand"}" bounds="[340,0][380,40]"/>
      <node resource-id="com.android.systemui:id/notification_children_container" bounds="[0,40][400,400]">
        <node resource-id="android:id/status_bar_latest_event_content" bounds="[0,40][400,300]">
          <node resource-id="android:id/title" text="${expected.title}" bounds="[20,40][300,80]"/>
          ${expanded ? `<node resource-id="android:id/text" text="${expected.body}" bounds="[20,80][300,120]"/>` : ""}
        </node></node></node></hierarchy>`;
  };
  const found = await findAndroidNotification(command, expected, async () => {});
  expect(taps).toEqual([["360", "20"]]);
  expect(found.target).toMatchObject({ resource: "android:id/title", x: 160, y: 60 });
  taps.length = 0; reads = 0; interfere = true;
  await expect(tapAndroidNotification(command, expected, async () => {})).rejects.toBeInstanceOf(NotificationOverlapError);
  expect(taps).toEqual([]);
});

test("private presentation excludes unowned shade content and refuses a missing child boundary", async () => {
  const expected = { packageName: "org.chromium.webapk.synthetic", tag: "omp-attention-fixture", title: "OMP session needs attention", body: "", forbidden: ["Synthetic ask canary"], originHost: "owned.example.test" };
  let boundary = true;
  const command = async (...args: string[]) => {
    if (args.includes("dumpsys")) return `Notification List:\n NotificationRecord(1: pkg=${expected.packageName} tag=${expected.tag})\n key=own-key\n mUpdateTimeMs=1000000000000\n android.title=String (${expected.title})\n android.text=String ()\nRanking Config:`;
    if (args.includes("size")) return "Physical size: 400x800";
    if (!args.includes("uiautomator")) return "";
    return `<hierarchy><node bounds="[0,0][400,800]">
      <node resource-id="${boundary ? "android:id/status_bar_latest_event_content" : "unknown"}" bounds="[0,0][400,300]">
        <node text="${expected.title}" bounds="[20,40][300,80]"/><node text="" bounds="[20,80][300,120]"/>
      </node>
      <node resource-id="android:id/status_bar_latest_event_content" bounds="[0,300][400,600]">
        <node text="Unowned message" bounds="[20,340][300,380]"/><node text="Synthetic ask canary" bounds="[20,380][300,420]"/>
      </node></node></hierarchy>`;
  };
  const found = await findAndroidNotification(command, expected, async () => {});
  expect(found.rowNodes.some(node => node.text === expected.title)).toBe(true);
  expect(found.rowNodes.some(node => node.text === "Synthetic ask canary" || node.text === "Unowned message")).toBe(false);
  boundary = false;
  await expect(findAndroidNotification(command, expected, async () => {})).rejects.toThrow("owned notification absent");
});

test("Private selection skips another OMP Sessions app's same-title rows by origin, grouped or not", async () => {
  // The operator's daily gateway app shows the same Private title. A row header names its origin;
  // a collapsed group of that app's alerts may show no origin at all.
  const expected = { packageName: "org.chromium.webapk.synthetic", tag: "omp-attention-fixture", title: "OMP session needs attention", body: "", forbidden: [], originHost: "owned.example.test" };
  let ownedVisible = true;
  let foreign: "headed" | "group" = "headed";
  const taps: string[][] = [];
  const title = (top: number) => `<node resource-id="android:id/title" text="${expected.title}" bounds="[20,${top}][300,${top + 40}]"/>`;
  const row = (origin: string, top: number) => `<node resource-id="com.android.systemui:id/expandableNotificationRow" bounds="[0,${top}][400,${top + 200}]">
      <node resource-id="android:id/status_bar_latest_event_content" bounds="[0,${top}][400,${top + 200}]">
        <node resource-id="android:id/notification_header" bounds="[0,${top}][400,${top + 40}]">
          <node resource-id="android:id/app_name_text" text="OMP Sessions" bounds="[20,${top}][160,${top + 40}]"/>
          <node resource-id="android:id/header_text" text="${origin}" bounds="[170,${top}][300,${top + 40}]"/>
          <node resource-id="android:id/expand_button" content-desc="Expand" bounds="[340,${top}][380,${top + 40}]"/>
        </node>${title(top + 40)}
      </node></node>`;
  const group = `<node resource-id="com.android.systemui:id/expandableNotificationRow" bounds="[0,0][400,260]">
      <node resource-id="com.android.systemui:id/notification_children_container" bounds="[0,40][400,260]">
        <node resource-id="com.android.systemui:id/expandableNotificationRow" bounds="[0,40][400,140]">${title(60)}</node>
        <node resource-id="com.android.systemui:id/expandableNotificationRow" bounds="[0,140][400,260]">${title(160)}</node>
      </node></node>`;
  const command = async (...args: string[]) => {
    if (args.includes("dumpsys")) return `Notification List:\n NotificationRecord(1: pkg=${expected.packageName} tag=${expected.tag})\n key=own-key\n mUpdateTimeMs=1000000000000\n android.title=String (${expected.title})\n android.text=String ()\nRanking Config:`;
    if (args.includes("size")) return "Physical size: 400x800";
    if (args.includes("tap")) { taps.push(args.slice(-2)); return ""; }
    if (!args.includes("uiautomator")) return "";
    return `<hierarchy><node bounds="[0,0][400,800]">${foreign === "headed" ? row("daily.example.test", 0) : group}${ownedVisible ? row(expected.originHost, 300) : ""}</node></hierarchy>`;
  };
  for (const layout of ["headed", "group"] as const) {
    foreign = layout;
    const found = await findAndroidNotification(command, expected, async () => {});
    expect(found.target).toMatchObject({ text: expected.title, y: 360 });
    expect(found.rowNodes.some(node => node.text === "daily.example.test")).toBe(false);
  }
  foreign = "headed"; ownedVisible = false;
  await expect(findAndroidNotification(command, expected, async () => {})).rejects.toThrow("owned notification absent");
  expect(taps).toEqual([]);
});

test("a collapsed group hides each child's template and origin, so selection expands only groups holding the owned text", async () => {
  // Observed on the Pixel (Android 17 CP3A.260905.009): an app with two notifications is grouped.
  // Collapsed, each child is one line with neither a template boundary nor its origin; expanded, each
  // child shows its own headerless template naming its origin. The lane's own app groups whenever
  // Chrome's generic background-update notification sits beside the owned alert.
  interface Child { readonly title: string; readonly body: string; readonly origin: string }
  interface Group { readonly top: number; expanded: boolean; readonly children: readonly Child[] }
  const owned = "owned.example.test";
  const generic = { title: "OMP Sessions", body: "This site has been updated in the background", origin: owned };
  let groups: Group[] = [];
  let record = { title: "", body: "" };
  const taps: string[][] = [];
  const child = (item: Child, top: number, expanded: boolean) => expanded
    ? `<node resource-id="com.android.systemui:id/expandableNotificationRow" bounds="[0,${top}][400,${top + 100}]"><node resource-id="com.android.systemui:id/expanded" bounds="[0,${top}][400,${top + 100}]">
        <node resource-id="android:id/status_bar_latest_event_content" bounds="[0,${top}][400,${top + 100}]">
          <node resource-id="android:id/notification_top_line" bounds="[20,${top}][380,${top + 40}]">
            <node resource-id="android:id/title" text="${item.title}" bounds="[20,${top}][200,${top + 40}]"/>
            <node resource-id="android:id/header_text" text="${item.origin}" bounds="[210,${top}][380,${top + 40}]"/></node>
          <node resource-id="android:id/text" text="${item.body}" bounds="[20,${top + 40}][380,${top + 80}]"/>
        </node></node></node>`
    : `<node resource-id="com.android.systemui:id/expandableNotificationRow" bounds="[0,${top}][400,${top + 40}]"><node resource-id="com.android.systemui:id/expanded" bounds="[0,${top}][400,${top + 40}]"><node bounds="[20,${top}][380,${top + 40}]">
        <node resource-id="com.android.systemui:id/notification_title" text="${item.title}" bounds="[20,${top}][200,${top + 40}]"/>
        <node resource-id="com.android.systemui:id/notification_text" text="${item.body}" bounds="[210,${top}][380,${top + 40}]"/></node></node></node>`;
  const group = (item: Group) => `<node resource-id="com.android.systemui:id/expandableNotificationRow" bounds="[0,${item.top}][400,${item.top + 300}]">
      <node resource-id="com.android.systemui:id/notification_children_container" bounds="[0,${item.top}][400,${item.top + 300}]">
        <node resource-id="android:id/notification_header" bounds="[0,${item.top}][400,${item.top + 40}]">
          <node resource-id="android:id/app_name_text" text="OMP Sessions" bounds="[20,${item.top}][160,${item.top + 40}]"/>
          <node resource-id="android:id/expand_button" content-desc="Expand" bounds="[340,${item.top}][380,${item.top + 40}]">
            <node resource-id="android:id/expand_button_number" text="${item.children.length}" bounds="[340,${item.top}][360,${item.top + 40}]"/></node>
        </node>${item.children.map((entry, index) => child(entry, item.top + 40 + index * (item.expanded ? 100 : 40), item.expanded)).join("")}
      </node></node>`;
  const command = async (...args: string[]) => {
    if (args.includes("dumpsys")) return `Notification List:\n NotificationRecord(1: pkg=org.chromium.webapk.synthetic tag=omp-attention-fixture)\n key=own-key\n mUpdateTimeMs=1000000000000\n android.title=String (${record.title})\n android.text=String (${record.body})\nRanking Config:`;
    if (args.includes("size")) return "Physical size: 400x800";
    if (args.includes("tap")) {
      taps.push(args.slice(-2));
      const [x, y] = args.slice(-2).map(Number) as [number, number];
      const hit = groups.find(item => x >= 340 && x < 380 && y >= item.top && y < item.top + 40);
      if (hit !== undefined) hit.expanded = !hit.expanded;
      return "";
    }
    if (!args.includes("uiautomator")) return "";
    return `<hierarchy><node bounds="[0,0][400,800]">${groups.map(group).join("")}</node></hierarchy>`;
  };

  // The stale activity-stop tap: the owned alert is one line of a collapsed group of the lane's app.
  const stopped = { packageName: "org.chromium.webapk.synthetic", tag: "omp-attention-fixture", title: "OMP session activity stopped", body: "Synthetic session · Synthetic project", forbidden: [], originHost: owned };
  record = { title: stopped.title, body: stopped.body };
  groups = [{ top: 400, expanded: false, children: [{ title: stopped.title, body: stopped.body, origin: owned }, generic] }];
  const found = await findAndroidNotification(command, stopped, async () => {});
  expect(taps).toEqual([["360", "420"]]);
  expect(found.target).toMatchObject({ resource: "android:id/title", text: stopped.title });
  expect(found.rowNodes.some(node => node.text === stopped.body)).toBe(true);
  expect(found.rowNodes.some(node => node.text === generic.body)).toBe(false);

  // Private: the daily app's collapsed group shows the same title. Expanding it reveals its origin, so
  // only the owned group's child is ever selected, and every tap lands on a group's expand button.
  const privately = { ...stopped, title: "OMP session needs attention", body: "" };
  record = { title: privately.title, body: "" };
  taps.length = 0;
  groups = [
    { top: 0, expanded: false, children: [{ title: privately.title, body: "", origin: "daily.example.test" }, { title: privately.title, body: "", origin: "daily.example.test" }] },
    { top: 400, expanded: false, children: [{ title: privately.title, body: "", origin: owned }, generic] },
  ];
  const selected = await findAndroidNotification(command, privately, async () => {});
  expect(taps).toEqual([["360", "20"], ["360", "420"]]);
  expect(selected.target).toMatchObject({ resource: "android:id/title", text: privately.title });
  expect(selected.target.y).toBeGreaterThan(400);
  expect(selected.rowNodes.some(node => node.text === owned)).toBe(true);
  expect(selected.rowNodes.some(node => node.text === "daily.example.test" || node.text === generic.body)).toBe(false);
});

test("an attached page is used only once its document answers; the context race is retried, nothing else is", async () => {
  // The v0.7.2-prealpha.1 campaign's third Push attempt died in stale_taps_verified with
  // "CDP Runtime.evaluate: Cannot find default execution context": the WebAPK had just been
  // reopened and its document was still being swapped under the attachment (2026-10-02).
  let clock = 0;
  const pause = async (milliseconds: number) => { clock += milliseconds; };
  let calls = 0;
  await awaitPageExecutionContext(async () => { calls++; if (calls < 3) throw new Error("CDP Runtime.evaluate: Cannot find default execution context"); return "complete"; }, pause, 15_000, () => clock);
  expect(calls).toBe(3);
  expect(clock).toBe(500);
  const other = new Error("CDP Runtime.evaluate: Execution context was destroyed");
  await expect(awaitPageExecutionContext(async () => { throw other; }, pause, 15_000, () => clock)).rejects.toBe(other);
  let attempts = 0;
  await expect(awaitPageExecutionContext(async () => { attempts++; throw new Error("CDP Runtime.evaluate: Cannot find default execution context"); }, pause, 1_000, () => clock))
    .rejects.toThrow("Cannot find default execution context");
  expect(attempts).toBe(5);
});

test("task removal ignores retained focus references and waits for active task withdrawal", async () => {
  const active = "  * Task{safe #42 type=standard A=1:org.chromium.webapk.synthetic}";
  const stale = "  mLastFocusedRootTask=Task{safe #42 type=standard A=1:org.chromium.webapk.synthetic}";
  expect(webApkTasks(stale, "org.chromium.webapk.synthetic")).toEqual([]);
  let removed = false; let polls = 0; let taskStillActive = true;
  await closeWebApk(async (...args) => {
    if (args.includes("remove")) { removed = true; return ""; }
    polls++; taskStillActive = !removed || polls < 3; return taskStillActive ? active : stale;
  }, "org.chromium.webapk.synthetic", async () => {});
  expect(removed).toBe(true); expect(taskStillActive).toBe(false);
});

for (const choiceSheet of [false, true]) test(`one-time WebAPK setup installs through ${choiceSheet ? "the choice sheet" : "direct confirmation"} and preserves an existing app`, async () => {
  let installed = false;
  let surface: "page" | "opening" | "menu" | "choice" | "confirmation" = "page";
  let taps = 0;
  const node = (text: string, resource: string, y: number, x = 0, child = "") =>
    '<node text="' + text + '" resource-id="' + resource + '" bounds="[' + x + ',' + y + '][' + (x + 40) + ',' + (y + 40) + ']">' + child + '</node>';
  const command = async (...args: string[]) => {
    if (args.includes("uninstall")) throw new Error("existing apps must be preserved");
    if (args.includes("list")) return installed ? "package:org.chromium.webapk.synthetic" : "";
    if (args.includes("package") && args.includes("dumpsys")) return 'Authority: "gateway.example.test"';
    if (args.includes("uiautomator") && surface === "opening") { surface = "menu"; return "<hierarchy></hierarchy>"; }
    if (args.includes("uiautomator")) return "<hierarchy>" + (surface === "page" ? node("", "com.android.chrome:id/menu_button", 0) :
      surface === "menu" ? node("", "com.android.chrome:id/universal_install", 40, 0, node("Install a changing application title", "com.android.chrome:id/menu_item_text", 40)) + node("Install app", "unrelated", 40, 40) :
      surface === "choice" ? node("Install", "com.android.chrome:id/option_text_install", 60) + node("Create shortcut", "com.android.chrome:id/option_text_shortcut", 60, 40) :
      node("Install", "com.android.chrome:id/positive_button", 80) + node("Cancel", "com.android.chrome:id/negative_button", 80, 40)) + "</hierarchy>";
    if (args.includes("tap")) {
      taps++;
      const [x, y] = args.slice(-2).map(Number);
      if (x !== 20) throw new Error("unrelated native action selected");
      if (surface === "page" && y === 20) surface = "opening";
      else if (surface === "menu" && y === 60) surface = choiceSheet ? "choice" : "confirmation";
      else if (surface === "choice" && y === 80) surface = "confirmation";
      else if (surface === "confirmation" && y === 100) { installed = true; surface = "page"; }
      else throw new Error("invalid installation transition");
    }
    return "";
  };
  expect(await setupAndroidWebApk(identity.origin, { command, navigate: async () => {}, pause: async () => {} })).toEqual({ alreadyInstalled: false, installed: true });
  expect(installed).toBe(true);
  const installedTaps = taps;
  expect(await setupAndroidWebApk(identity.origin, { command, navigate: async () => { throw new Error("must not navigate"); }, pause: async () => {} })).toEqual({ alreadyInstalled: true, installed: true });
  expect(taps).toBe(installedTaps);
});

test("one-time WebAPK setup scrolls Chrome's app menu to an install entry below the fold", async () => {
  // Chrome 154 on the Pixel 10 Pro lists "Install and create shortcut" two screens down; the menu
  // materializes only visible rows, so the entry is absent from the dump until the list scrolls.
  let installed = false;
  let surface: "page" | "menu" | "confirmation" = "page";
  let scrolls = 0;
  const node = (text: string, resource: string, y: number, x = 0, child = "") =>
    '<node text="' + text + '" resource-id="' + resource + '" bounds="[' + x + ',' + y + '][' + (x + 40) + ',' + (y + 40) + ']">' + child + '</node>';
  const menu = (rows: string) => '<node text="" resource-id="com.android.chrome:id/app_menu_list" bounds="[0,100][40,700]">' + rows + "</node>";
  const command = async (...args: string[]) => {
    if (args.includes("list")) return installed ? "package:org.chromium.webapk.synthetic" : "";
    if (args.includes("package") && args.includes("dumpsys")) return 'Authority: "gateway.example.test"';
    if (args.includes("uiautomator")) return "<hierarchy>" + (surface === "page" ? node("", "com.android.chrome:id/menu_button", 0) :
      surface === "menu" ? menu(scrolls < 2
        ? node("New tab", "com.android.chrome:id/new_tab_menu_id", 120) + node("History", "com.android.chrome:id/open_history_menu_id", 600)
        : node("Translate", "com.android.chrome:id/translate_id", 120) + node("", "com.android.chrome:id/universal_install", 600))
      : node("Install", "com.android.chrome:id/positive_button", 80)) + "</hierarchy>";
    if (args.includes("swipe")) {
      const [x1 = NaN, y1 = NaN, x2 = NaN, y2 = NaN] = args.slice(-5, -1).map(Number);
      if (surface !== "menu" || x1 !== x2 || !(y1 > y2)) throw new Error("scroll must move the open menu toward its lower rows");
      scrolls++;
    }
    if (args.includes("tap")) {
      const [x, y] = args.slice(-2).map(Number);
      if (x !== 20) throw new Error("unrelated native action selected");
      if (surface === "page" && y === 20) surface = "menu";
      else if (surface === "menu" && y === 620 && scrolls >= 2) surface = "confirmation";
      else if (surface === "confirmation" && y === 100) { installed = true; surface = "page"; }
      else throw new Error("invalid installation transition");
    }
    return "";
  };
  expect(await setupAndroidWebApk(identity.origin, { command, navigate: async () => {}, pause: async () => {} })).toEqual({ alreadyInstalled: false, installed: true });
  expect(scrolls).toBeGreaterThanOrEqual(2);
});

for (const closes of [true, false]) test(`failed WebAPK setup ${closes ? "closes its menu" : "poisons an unrestored native surface"}`, async () => {
  let menuOpen = false;
  const primary = new Error("setup UI unavailable");
  const runtime = { navigate: async () => {}, pause: async () => { throw primary; }, command: async (...args: string[]) => {
    if (args.includes("list")) return "";
    if (args.includes("uiautomator")) return `<hierarchy><node text="" resource-id="com.android.chrome:id/${menuOpen ? "app_menu_list" : "menu_button"}" bounds="[0,0][40,40]"/></hierarchy>`;
    if (args.includes("tap")) menuOpen = true;
    if (args.includes("keyevent") && closes) menuOpen = false;
    return "";
  } };
  let failure: unknown;
  try { await setupAndroidWebApk(identity.origin, runtime); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(menuOpen).toBe(!closes);
  expect(pixelUnrestored(failure)).toBe(!closes);
  if (closes) expect(failure).toBe(primary);
  else {
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(primary);
  }
});

test("a nested unrestored native UI error retains the development Pixel lease even when keyguard and power match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-webapk-lease-"));
  const lock = join(directory, "pixel");
  const failure = new AggregateError([new Error("install failed"), Object.assign(new Error("native UI remained open"), { pixelUnrestored: true })]);
  let restored = false;
  const keys: string[] = [];
  const runtime = { pause: async () => {}, command: async (...args: string[]) => {
    if (args.includes("window")) return "isKeyguardShowing=false";
    if (args.includes("power")) return "mWakefulness=Awake";
    if (args.includes("keyevent")) keys.push(args.at(-1)!);
    return "";
  } };
  try {
    let surfaced: unknown;
    try {
      await withDevelopmentPixelLease("WebAPK setup test", () => withWebApkSetupRestoration(identity.origin, runtime,
        async () => { throw failure; }, () => { restored = true; }), () => restored, lock);
    } catch (error) { surfaced = error; }
    expect(surfaced).toBeInstanceOf(AggregateError);
    expect((surfaced as AggregateError).errors[0]).toBe(failure);
    expect(pixelUnrestored(surfaced)).toBe(true);
    expect(restored).toBe(false);
    expect(keys).toEqual(["224"]);
    expect(JSON.parse(await readFile(join(lock, "owner"), "utf8")).owner).toBe("WebAPK setup test");
  } finally { await rm(directory, { recursive: true }); }
});

test("a changed Pixel owner refuses release without hiding the action failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-pixel-release-"));
  const lock = join(directory, "pixel");
  const primary = new Error("qualification failed");
  try {
    let failure: unknown;
    try {
      await withDevelopmentPixelLease("Pixel release test", async () => {
        await writeFile(join(lock, "owner"), "another owner");
        throw primary;
      }, () => true, lock);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(primary);
    expect((failure as AggregateError).errors[1].message).toContain("refusing release");
    expect(await readFile(join(lock, "owner"), "utf8")).toBe("another owner");
  } finally { await rm(directory, { recursive: true }); }
});

test("fixture commands are owned, bounded, and monotonically sequenced", () => {
  const epoch = randomUUID();
  expect(parseFixtureCommand({ epoch, sequence: 2, operation: "replace" }, epoch, 1)).toEqual({ sequence: 2, operation: "replace" });
  expect(parseFixtureCommand({ epoch, sequence: 2, operation: "ask", expectedSessionId: "session-before" }, epoch, 1))
    .toEqual({ sequence: 2, operation: "ask", expectedSessionId: "session-before" });
  for (const record of [{ epoch, sequence: 1, operation: "ask" }, { epoch: randomUUID(), sequence: 2, operation: "ask" },
    { epoch, sequence: 2, operation: "shell" }, { epoch, sequence: 2, operation: "ask", data: "synthetic" },
    { epoch, sequence: 2, operation: "answer", expectedSessionId: "session-before" },
    ...["", "x".repeat(129), "session/unsafe", 1].map(expectedSessionId => ({ epoch, sequence: 2, operation: "ask", expectedSessionId }))]) {
    expect(() => parseFixtureCommand(record, epoch, 1)).toThrow("invalid fixture command");
  }
});

test("495 round2 fixture controller carries its last acknowledged private session into the guarded ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "fixture-guard-")), epoch = randomUUID();
  await writeFile(join(root, "owner"), epoch);
  await writeFile(join(root, "ack.json"), JSON.stringify({ epoch, sequence: 0, phase: "ready", sessionId: "session-before" }));
  const operation = runFixtureOperation({ root, epoch, binary: "synthetic", bun: process.execPath, scripts: root }, "ask", async () => {
    throw new Error("guarded control must not launch a process");
  }, true);
  try {
    let command: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100 && command === undefined; attempt++) {
      command = await readFile(join(root, "command.json"), "utf8").then(text => JSON.parse(text)).catch(() => undefined);
      if (command === undefined) await Bun.sleep(5);
    }
    expect(command?.expectedSessionId).toBe("session-before");
  } finally {
    await writeFile(join(root, "ack.json"), JSON.stringify({ epoch, sequence: 1, phase: "accepted" }));
    await operation;
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])("495 round2 fixture requires a private command and its acknowledged session (changed=%s)", async changed => {
  const root = await mkdtemp(join(tmpdir(), "extension-guard-")), epoch = randomUUID();
  const priorRoot = process.env.OMP_PUSH_FIXTURE_ROOT, priorEpoch = process.env.OMP_PUSH_FIXTURE_EPOCH;
  process.env.OMP_PUSH_FIXTURE_ROOT = root; process.env.OMP_PUSH_FIXTURE_EPOCH = epoch;
  let handler!: Parameters<Parameters<typeof pushQualificationExtension>[0]["registerCommand"]>[1]["handler"];
  let selected = 0;
  pushQualificationExtension({ on() {}, sendUserMessage() {}, setSessionName: async () => {},
    registerCommand(_name, command) { handler = command.handler; } });
  const running = handler("", { hasUI: true, sessionManager: { getSessionId: () => changed ? "session-after" : "session-before" },
    isIdle: () => true, abort() {}, shutdown() {}, newSession: async () => ({ cancelled: false }),
    ui: { select: async () => { selected++; return undefined; } } });
  try {
    await writeFile(join(root, "command.json"), JSON.stringify({ epoch, sequence: 1, operation: "ask", expectedSessionId: "session-before" }), { mode: 0o600 });
    expect(((await stat(join(root, "command.json"))).mode & 0o077) === 0).toBe(process.platform !== "win32");
    let ack: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      ack = await readFile(join(root, "ack.json"), "utf8").then(text => JSON.parse(text)).catch(() => undefined);
      if (ack?.sequence === 1) break;
      await Bun.sleep(5);
    }
    // This retained-Mac fixture deliberately requires POSIX private files. Windows cannot make
    // this command's mode 0600; prove refusal there rather than weakening the admission check.
    const refused = changed || process.platform === "win32";
    expect(ack?.phase).toBe(refused ? "failed" : "accepted");
    expect(selected).toBe(refused ? 0 : 1);
  } finally {
    await writeFile(join(root, "command.json"), JSON.stringify({ epoch, sequence: 2, operation: "stop" }), { mode: 0o600 });
    await running;
    if (priorRoot === undefined) delete process.env.OMP_PUSH_FIXTURE_ROOT; else process.env.OMP_PUSH_FIXTURE_ROOT = priorRoot;
    if (priorEpoch === undefined) delete process.env.OMP_PUSH_FIXTURE_EPOCH; else process.env.OMP_PUSH_FIXTURE_EPOCH = priorEpoch;
    await rm(root, { recursive: true, force: true });
  }
});
