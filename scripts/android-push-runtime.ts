import { basename, join, posix, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parsePushConfigResponse, parseSessionListResponse } from "../packages/protocol/src/validation.ts";
import { PUSH_API_VERSION, type PushDetailLevel, type SessionMetadata } from "../packages/protocol/src/types.ts";
import { AndroidBrowserCleanupError, withAndroidChrome, requireSingleDevice, parseAndroidPackageVersion, parseAlternateBouncerFocused, requireAndroidDevicePreconditions, parseKeyguardShowing, readAndroidRadioBaseline, restoreAndroidRadios, readAndroidQualificationPin, resolveAndroidBrowserTarget,
  runAdb, wakeAndroidDisplay, unlockAndroidKeyguard, showAndroidPinBouncer, type AndroidAdbCommand, type AndroidChromeDriver, type AndroidExecution } from "./android-device.ts";
import { closeWebApk, openWebApk, requireWebApk, webApkTasks } from "./android-webapk.ts";
import { readAndroidUi, findAndroidNotification, tapAndroidNotification, readAndroidNotificationRecords, notificationMatchesDigest, trackUnchangedNotificationPost, NotificationOverlapError, type AndroidUiNode, type NotificationExpectation } from "./android-notification.ts";
import { commandPushFixture, executeFixture, type FixtureExecutor, type PushFixtureLocation } from "./push-qualification-fixture.ts";
import { PUSH_FIXTURE_ASK_BODY, PUSH_FIXTURE_ASK_TITLE } from "./fixtures/push-qualification-extension.ts";
import { PAGE_PRELUDE } from "./android-leak-probe.ts";
import type { AndroidPushIdentity, AndroidPushPhase, AndroidPushRuntime, PushBrowserBaseline, PushDeviceBaseline, PushExecution, PushFixtureRole, PushTapObservation, TriageObservation } from "./android-push-qualification.ts";
import { everyError, pixelUnrestored, runWithRestoration } from "./restoration.ts";
import type { QualificationLogs } from "./qualification-logs.ts";
import { QualificationFailure, type PushBrowserStep } from "./qualification-failure.ts";

export interface AndroidPushRuntimeOptions {
  readonly fixtureBase?: string;
  readonly fixtureBinary?: string;
  readonly fixtureBun?: string;
  readonly fixtureScripts?: string;
  readonly execute?: FixtureExecutor;
  readonly executeWithContext?: (argv: readonly string[], execution: PushExecution | undefined) => ReturnType<FixtureExecutor>;
  readonly gatewayLogsDiscarded?: () => Promise<boolean>;
  readonly qualificationLogs?: Pick<QualificationLogs, "begin" | "end" | "healthy">;
  readonly browserFailure?: QualificationLogs["browserFailure"];
  readonly execution?: PushExecution;
  readonly nextFailureId?: () => number;
}

export async function gatewayRawLogsDiscarded(execute: FixtureExecutor): Promise<boolean> {
  const home = await execute(["python3", "-c", "import os; print(os.path.expanduser('~'))"]);
  const directory = home.stdout.trim();
  if (home.exitCode !== 0 || !/^\/[^\r\n\0]+$/u.test(directory) || directory.length > 4096) return false;
  const plist = posix.join(directory, "Library/LaunchAgents/omp-session-gateway.plist");
  const stdout = await execute(["plutil", "-extract", "StandardOutPath", "raw", "-o", "-", plist]);
  const stderr = await execute(["plutil", "-extract", "StandardErrorPath", "raw", "-o", "-", plist]);
  return stdout.exitCode === 0 && stderr.exitCode === 0 && stdout.stdout.trim() === "/dev/null" && stderr.stdout.trim() === "/dev/null";
}

export function matchesPushDeliverySnapshot(session: SessionMetadata, candidates: readonly (SessionMetadata | undefined)[]): boolean {
  return session.ask !== undefined && candidates.some(current => current?.instanceId === session.instanceId &&
    current.generation === session.generation && current.ask?.requestId === session.ask?.requestId);
}

export function qualificationPushAliasFor(session: SessionMetadata, candidates: readonly (SessionMetadata | undefined)[]): number | undefined {
  const matches = candidates.filter(current => current !== undefined && current.inputRequired && current.canControl &&
    matchesPushDeliverySnapshot(session, [current]));
  const alias = matches.length === 1 ? matches[0]?.qualificationPushAlias : undefined;
  return typeof alias === "number" && Number.isSafeInteger(alias) && alias > 0 ? alias : undefined;
}

/** Diagnostic/fallback paths must not turn typed failures or unresolved cleanup into success. */
export function rethrowPushSafetyFailure(error: unknown): void {
  if (pixelUnrestored(error) || !everyError(error, nested =>
    !(nested instanceof QualificationFailure) && !(nested instanceof NotificationOverlapError))) throw error;
}

/** An independent cleanup failure is a harness root; only its containment consequence is collateral. */
export function pushBrowserCleanupFailure(error: AndroidBrowserCleanupError, nextFailureId: () => number): AggregateError {
  const observations = { remainingResources: error.remainingResources, cleanupVerified: false, mutationReconciled: false };
  const origin = new QualificationFailure({ id: nextFailureId(), lane: "androidPushCleanup", step: "browser",
    class: "harness", reason: "containment_unproven", operation: "unknown", elapsedMs: 0, observations });
  const collateral = new QualificationFailure({ id: nextFailureId(), lane: "androidPushCleanup", step: "containment",
    class: "collateral", reason: "dependency_failed", originIds: [origin.evidence.id], operation: "unknown", elapsedMs: 0, observations });
  return Object.assign(new AggregateError([...error.errors, origin, collateral], "Android Push browser containment unproven", { cause: error }), { pixelUnrestored: true });
}

/** Reads only an existing worker; no page navigation or fabricated notification can satisfy this. */
export async function observePushDeliveryRequest(driver: Pick<AndroidChromeDriver, "browserSend" | "sessionSend">,
  origin: string, session: SessionMetadata): Promise<boolean> {
  if (session.ask === undefined) return false;
  const inventory = await driver.browserSend("Target.getTargets");
  const workers = Array.isArray(inventory.targetInfos) ? inventory.targetInfos.filter((target: Record<string, unknown>) =>
    target.type === "service_worker" && typeof target.url === "string" && target.url.startsWith(`${origin}/`)) : [];
  if (workers.length !== 1 || typeof workers[0].targetId !== "string") return false;
  const attached = await driver.browserSend("Target.attachToTarget", { targetId: workers[0].targetId, flatten: true });
  if (typeof attached.sessionId !== "string") return false;
  try {
    const response = await driver.sessionSend(attached.sessionId, "Runtime.evaluate", {
      expression: `(async()=>{const ns=await self.registration.getNotifications({tag:${JSON.stringify(`omp-attention-${session.instanceId}`)}});return ns.length===1&&ns[0].data?.type==='attention'&&ns[0].data?.instanceId===${JSON.stringify(session.instanceId)}&&ns[0].data?.requestId===${JSON.stringify(session.ask.requestId)};})()`,
      awaitPromise: true, returnByValue: true,
    });
    return response.exceptionDetails === undefined && typeof response.result === "object" && response.result !== null && "value" in response.result && response.result.value === true;
  } finally { await driver.browserSend("Target.detachFromTarget", { sessionId: attached.sessionId }); }
}

export function isPushNotificationRoute(value: unknown, origin: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === origin && (url.pathname === "/collab" || url.pathname.startsWith("/collab/"));
  } catch { return false; }
}

export function observePushLaunch(session: Pick<SessionMetadata, "generation" | "ask">, kind: "attention" | "activity_stop", postData: unknown):
  { currentGeneration: boolean; currentRequest: boolean; modeMatches: boolean } {
  const invalid = { currentGeneration: false, currentRequest: false, modeMatches: false };
  if (typeof postData !== "string") return invalid;
  let body: unknown;
  try { body = JSON.parse(postData); } catch { return invalid; }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid;
  return { currentGeneration: "generation" in body && body.generation === session.generation,
    currentRequest: kind === "activity_stop" || (session.ask !== undefined && "requestId" in body && body.requestId === session.ask.requestId),
    modeMatches: "mode" in body && body.mode === (kind === "attention" ? "control" : "view") };
}

type PermissionConnection = (run: (driver: Pick<AndroidChromeDriver, "browserSend">) => Promise<void>, execution?: AndroidExecution) => Promise<void>;

export function ownedPushForwards(list: string, serial: string, socket: string): string[] {
  const forwards: string[] = [];
  for (const line of list.split("\n")) {
    const [device, port, target] = line.trim().split(/\s+/u);
    if (port !== "tcp:9237" && port !== "tcp:9238") continue;
    if (device !== serial || target !== socket) throw new Error("Android Push debug forward belongs to another connection");
    forwards.push(port);
  }
  return forwards;
}

/**
 * Waits until an attached page answers `Runtime.evaluate`. A WebAPK that was just opened or
 * relaunched swaps its document under the attachment, and Chrome answers "Cannot find default
 * execution context" until the new document's context exists. Only that answer is retried; any
 * other failure, and the deadline, surface unchanged.
 */
export async function awaitPageExecutionContext(
  evaluate: () => Promise<unknown>,
  pause: (milliseconds: number) => Promise<void> = milliseconds => Bun.sleep(milliseconds),
  deadlineMs = 15_000,
  now: () => number = Date.now,
): Promise<void> {
  const deadline = now() + deadlineMs;
  for (;;) {
    try { await evaluate(); return; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Cannot find default execution context") || now() >= deadline) throw error;
      await pause(250);
    }
  }
}
// Chrome removes CDP permission overrides when their browser connection closes.
// Keep this browser-only connection (no page target) alive for the negative window.
export async function holdAndroidNotificationDenial(origin: string, connect: PermissionConnection = (run, execution) =>
  withAndroidChrome(run, { port: 9237, launchBrowser: false, ...(execution === undefined ? {} : { execution }) }),
  execution?: AndroidExecution): Promise<() => Promise<void>> {
  const ready = Promise.withResolvers<() => Promise<void>>();
  const release = Promise.withResolvers<void>();
  const session = connect(async driver => {
    await driver.browserSend("Browser.setPermission", { permission: { name: "notifications" }, setting: "denied", origin });
    let closing: Promise<void> | undefined;
    ready.resolve(() => closing ??= runWithRestoration("Android notification permission", async () => {
      await driver.browserSend("Browser.getVersion");
    }, [async () => { release.resolve(); await session; }]));
    const cancel = () => release.resolve();
    execution?.signal.addEventListener("abort", cancel, { once: true });
    const timer = execution === undefined ? undefined : setTimeout(cancel, Math.max(1, execution.deadline - performance.now()));
    if (execution?.signal.aborted) cancel();
    try { await release.promise; }
    finally { clearTimeout(timer); execution?.signal.removeEventListener("abort", cancel); }
  }, execution);
  void session.catch(error => ready.reject(error));
  return ready.promise;
}

interface NotificationAuthenticationRuntime {
  readonly command: AndroidAdbCommand;
  readonly revealPin: () => Promise<void>;
  readonly unlock: () => Promise<void>;
  readonly wait: (test: () => Promise<boolean>, name: string, milliseconds: number) => Promise<void>;
}

/** Authenticate the tap-created bouncer without replacing its pending notification action. */
export async function authenticateAndroidNotification(runtime: NotificationAuthenticationRuntime): Promise<void> {
  const locked = async () => parseKeyguardShowing(await runtime.command("shell", "dumpsys", "window"));
  if (!await locked()) return;
  const surface = async (): Promise<AndroidUiNode[] | undefined> => {
    if (!await locked()) return;
    let nodes: AndroidUiNode[];
    try { nodes = await readAndroidUi(runtime.command); }
    catch (error) { rethrowPushSafetyFailure(error); if (!await locked()) return; throw error; }
    // Authentication can finish while UIAutomator is capturing the old bouncer.
    return await locked() ? nodes : undefined;
  };
  let alternate = false;
  await runtime.wait(async () => {
    const nodes = await surface();
    if (nodes === undefined) return true;
    // The View keyguard marks its fingerprint bouncer; the Compose keyguard shows it as its own window.
    alternate = nodes.some(node => node.resource === "com.android.systemui:id/alternate_bouncer") ||
      parseAlternateBouncerFocused(await runtime.command("shell", "dumpsys", "window"));
    return alternate || nodes.filter(node => node.systemInput).length === 1;
  }, "notification authentication surface", 15_000);
  if (!await locked()) return;
  if (alternate) await runtime.revealPin();
  await runtime.wait(async () => {
    const nodes = await surface();
    return nodes === undefined || nodes.filter(node => node.systemInput).length === 1;
  }, "notification PIN bouncer", 15_000);
  if (!await locked()) return;
  await runtime.unlock();
  await runtime.wait(async () => !await locked(), "notification keyguard dismissal", 20_000);
}

/** The installed app's device-local triage controls; `$ID` is the row's escaped instance ID. */
const TRIAGE_CONTROLS = {
  hold: '#tray[data-panel="options"] .hero-hold',
  requeue: 'div.held-row[data-instance-id="$ID"] .held-requeue',
  hide: '.working-row-frame:has(> button.working-row[data-instance-id="$ID"]) .dismiss-session',
  undo: '#tray[open][data-panel="undo"] #undo-dismissal',
  showAll: "aside.dismissed-control > button",
} as const;
/** The app's Hold and Hide stores (apps/web/src/app.ts); records carry instance IDs, never capabilities. */
const LOCAL_TRIAGE_KEYS = ["omp.sessions.held-asks.v1", "omp.sessions.dismissed.v1", "omp.sessions.held-asks.v2", "omp.sessions.dismissed.v2"];
const DIRECTORY_STATE = `(() => {
  const ids = selector => [...document.querySelectorAll(selector)].map(element => element.dataset.instanceId ?? "");
  const pill = document.querySelector("#directory-count");
  const count = pill === null || pill.hidden ? "" : pill.textContent ?? "";
  const waiting = /^(\\d+) waiting(?: · (\\d+) held)?$/u.exec(count);
  const live = /^Live · (\\d+)$/u.exec(count);
  const hidden = /^(\\d+) hidden on this device$/u.exec(document.querySelector("aside.dismissed-control > span")?.textContent ?? "");
  return { waiting: [...ids("article.queue-hero"), ...ids("button.queue-row")], held: ids("div.held-row"), working: ids("button.working-row"),
    hidden: hidden === null ? 0 : Number(hidden[1]), allHeld: document.querySelector(".all-held-summary") !== null,
    pending: waiting === null ? 0 : Number(waiting[1]), heldCount: waiting?.[2] === undefined ? 0 : Number(waiting[2]),
    live: live === null ? 0 : Number(live[1]), toast: document.querySelector('#tray[open][data-panel="undo"]') !== null };
})()`;

/**
 * Admission is the fleet contract, not one handset: any identified Pixel on Android 13+ (runtime
 * POST_NOTIFICATIONS exists from 13). The orchestrator's own device gate uses the same prefix test;
 * the first version pinned the exact model of the first phone, and the next phone was refused by a
 * message blaming notification permissions.
 */
export function requireAndroidPushDevice(model: string, androidRelease: string): void {
  if (!model.startsWith("Pixel ")) throw new Error(`Android Push requires a Pixel; attached model is ${JSON.stringify(model)}`);
  const major = Number.parseInt(androidRelease, 10);
  if (!Number.isInteger(major) || major < 13) throw new Error(`Android Push requires Android 13 or newer for runtime notification permissions; attached release is ${JSON.stringify(androidRelease)}`);
}

export function createAndroidPushRuntime(identity: Pick<AndroidPushIdentity, "origin" | "omp">, options: AndroidPushRuntimeOptions = {}): AndroidPushRuntime {
  const base = options.fixtureBase ?? join(homedir(), ".local/share/omp-session-gateway/qualification/dev/androidPush/fixtures");
  let serial: string | undefined;
  let packageName: string | undefined;
  let currentEpoch: string | undefined;
  let selectedDetail: PushDetailLevel = "private";
  let observationArmed = false;
  let observedTopics: string[] = [];
  let releasePermission: (() => Promise<void>) | undefined;
  let baselineRecords = new Map<string, number>();
  const observedPosts = new Map<string, { key: string; postedAt: number }>();
  let execution = options.execution;
  let phase: AndroidPushPhase = "baseline_captured";
  let failureId = 0;
  const localFailureId = options.nextFailureId ?? (() => ++failureId);
  const nextFailureId = () => (execution?.nextFailureId ?? localFailureId)();
  const chrome: typeof withAndroidChrome = async (run, context) => {
    try { return await withAndroidChrome(run, context); }
    catch (error) {
      if (error instanceof AndroidBrowserCleanupError) throw pushBrowserCleanupFailure(error, nextFailureId);
      throw error;
    }
  };
  const execute: FixtureExecutor = argv => options.executeWithContext === undefined ?
    (options.execute ?? executeFixture)(argv) : options.executeWithContext(argv, execution);
  const checkExecution = () => {
    if (execution === undefined) return;
    if (execution.signal.aborted) rethrowPushSafetyFailure(execution.signal.reason);
    if (execution.signal.aborted || performance.now() >= execution.deadline) throw new QualificationFailure({
      id: nextFailureId(), lane: "androidPush", step: phase, reason: "deadline_exceeded", class: "harness",
      operation: "unknown", elapsedMs: 0, observations: { controllerDeadline: true } },
      execution.signal.aborted ? { cause: execution.signal.reason } : undefined);
  };
  const deliveryTimeout = (cause: unknown) => new QualificationFailure({
    id: nextFailureId(), lane: "androidPush", step: phase, reason: "delivery_timeout", class: "harness",
    operation: "read_only", elapsedMs: 0, observations: {} }, { cause });
  const checkDeliveryExecution = (cause?: unknown) => {
    if (execution !== undefined && (execution.signal.aborted || performance.now() >= execution.deadline)) {
      throw deliveryTimeout(cause ?? (execution.signal.aborted ? execution.signal.reason : new Error("Android Push execution deadline")));
    }
  };
  const privacyFailure = (options?: ErrorOptions) => new QualificationFailure({ id: nextFailureId(), lane: "androidPush", step: phase,
    class: "product", reason: "privacy_failed", operation: "read_only", elapsedMs: 0, observations: {} }, options);
  const logEvidence = async <T>(read: () => Promise<T>): Promise<T> => {
    try { return await read(); }
    catch (error) { rethrowPushSafetyFailure(error); throw new QualificationFailure({ id: nextFailureId(), lane: "androidPush", step: phase,
      class: "harness", reason: "invalid_evidence", operation: "read_only", elapsedMs: 0, observations: {} }, { cause: error }); }
  };
  // Neither root's label is a prefix of the other's: notification bodies carry the label.
  const location = (epoch: string, role: PushFixtureRole = "primary"): PushFixtureLocation => ({
    root: join(base, role === "primary" ? `omp-push-${epoch}` : `omp-push-b-${epoch}`), epoch,
    bun: options.fixtureBun ?? process.execPath,
    binary: options.fixtureBinary ?? process.env.OMP_PUSH_FIXTURE_BINARY ?? "",
    scripts: options.fixtureScripts ?? resolve(import.meta.dir) });
  const boundedAdb = (device: string | undefined, args: readonly string[], timeoutMs?: number) => {
    checkExecution();
    const current = execution;
    return runAdb(device, args, current === undefined ? timeoutMs === undefined ? {} : { timeoutMs } : {
      timeoutMs: Math.max(1, Math.min(timeoutMs ?? Infinity, current.deadline - performance.now())),
      signal: current.signal,
    });
  };
  const selectDevice = async () => serial ??= await requireSingleDevice((...args) => boundedAdb(undefined, args));
  const command: AndroidAdbCommand = async (...args) => boundedAdb(await selectDevice(), args);
  const mutate: AndroidAdbCommand = async (...args) => { await runtime.beforeEffect(); return command(...args); };
  const wake = async () => {
    await selectDevice();
    if (await wakeAndroidDisplay(mutate, milliseconds => runtime.pause(milliseconds), () => unlockAndroidKeyguard(serial!, undefined, undefined, execution)) !== "Awake") {
      throw new Error("Android Push display did not unlock");
    }
  };
  const wait = async (test: () => Promise<boolean>, name: string, milliseconds = 60_000) => {
    const deadline = performance.now() + milliseconds;
    try {
      while (performance.now() < deadline) {
        checkDeliveryExecution();
        const passed = await test();
        checkDeliveryExecution();
        if (performance.now() >= deadline) break;
        if (passed) return;
        await runtime.pause(500);
      }
    } catch (error) {
      rethrowPushSafetyFailure(error);
      checkDeliveryExecution(error);
      throw error;
    }
    throw new Error(`Android Push ${name} unavailable`);
  };
  const targetForOrigin = async (driver: AndroidChromeDriver): Promise<string | undefined> => {
    const result = await driver.browserSend("Target.getTargets");
    if (!Array.isArray(result.targetInfos)) throw new Error("Android target inventory unavailable");
    const targets = result.targetInfos.filter((target: unknown) => typeof target === "object" && target !== null && "type" in target &&
      target.type === "page" && "url" in target && typeof target.url === "string" && target.url.startsWith(`${identity.origin}/`));
    if (targets.length > 1) throw new Error("multiple pages for the Push origin; close them before qualification");
    const target = targets[0];
    return typeof target?.targetId === "string" ? target.targetId : undefined;
  };
  const navigateRoot = async (driver: AndroidChromeDriver) => {
    await runtime.beforeEffect();
    try { await driver.navigate(`${identity.origin}/`); }
    catch (error) { rethrowPushSafetyFailure(error); throw new Error("Android Push directory did not load", { cause: error }); }
  };
  const page = async <T>(action: (driver: AndroidChromeDriver) => Promise<T>, navigate = false,
    baseline?: { step: PushBrowserStep }): Promise<T> => {
    if (baseline !== undefined) baseline.step = "browser_wake";
    await wake();
    if (baseline !== undefined) baseline.step = "browser_webapk";
    packageName ??= await requireWebApk(command, identity.origin);
    await openWebApk(mutate, packageName);
    await runtime.beforeEffect();
    if (baseline !== undefined) baseline.step = "browser_forward";
    return chrome(async driver => {
      if (baseline !== undefined) baseline.step = "browser_target";
      let target: string | undefined;
      await wait(async () => { target = await targetForOrigin(driver); return target !== undefined; }, "WebAPK target");
      if (baseline !== undefined) baseline.step = "browser_attach";
      await driver.attachTab(target!);
      if (baseline !== undefined) baseline.step = "browser_context";
      await awaitPageExecutionContext(() => driver.evaluate("document.readyState"));
      // The target keeps the origin URL while its document is a chrome-error:// page (the app
      // launched while the gateway was unreachable). Such a document has no service worker and
      // no secure context, so every page-side step would fail inside it: load the directory.
      const document = await driver.evaluate<{ href: string; secure: boolean }>("({ href: location.href, secure: window.isSecureContext })");
      if (navigate || !document.href.startsWith(`${identity.origin}/`) || !document.secure) {
        if (baseline !== undefined) baseline.step = "browser_navigation";
        await navigateRoot(driver);
      }
      if (baseline !== undefined) baseline.step = "browser_notification_state";
      return action(driver);
    }, { port: 9238, launchBrowser: false, ...(execution === undefined ? {} : { execution }) });
  };
  const browserState = async (driver: AndroidChromeDriver): Promise<PushBrowserBaseline> => {
    await wait(async () => driver.evaluate<boolean>('!["checking", undefined].includes(document.querySelector("#notify")?.dataset.state)'), "notification controls");
    return driver.evaluate<PushBrowserBaseline>(`(async () => {
      const registration = await navigator.serviceWorker.ready;
      return {subscribed: !!(await registration.pushManager.getSubscription()), permission: Notification.permission,
        detail: document.querySelector('input[name="notification-detail"]:checked')?.value ?? "session"};
    })()`);
  };
  const title = (kind: "attention" | "activity_stop") => kind === "attention" ? "OMP session needs attention" : "OMP session activity stopped";
  const expectation = (session: SessionMetadata, kind: "attention" | "activity_stop", level = selectedDetail): NotificationExpectation => ({
    packageName: packageName!, tag: `omp-attention-${session.instanceId}`, title: title(kind),
    body: level === "private" ? "" : [...[session.title, session.cwdLabel].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ")].slice(0, 256).join(""),
    forbidden: [PUSH_FIXTURE_ASK_BODY, PUSH_FIXTURE_ASK_TITLE, "Qualification benign activity canary"], originHost: new URL(identity.origin).host,
  });
  const snapshot = async (epoch: string, role: PushFixtureRole = "primary") => {
    checkExecution();
    const signal = execution === undefined ? AbortSignal.timeout(15_000) :
      AbortSignal.any([execution.signal, AbortSignal.timeout(Math.max(1, Math.min(15_000, execution.deadline - performance.now())))]);
    const response = await fetch(`${identity.origin}/api/v1/sessions`, { cache: "no-store", signal });
    if (!response.ok) throw new Error("Android Push gateway snapshot refused");
    const list = parseSessionListResponse(await response.json());
    const matches = list.sessions.filter(session => session.cwdLabel === basename(location(epoch, role).root));
    if (matches.length > 1) throw new Error("multiple owned fixture publications");
    return matches[0];
  };
  const phaseRecords = async () => {
    if (!observationArmed) throw new Error("Push notification phase has no record baseline");
    packageName ??= await requireWebApk(command, identity.origin);
    const records = await readAndroidNotificationRecords(command, packageName);
    if (records.some(record => record.tag.includes("omp-attention-") && !observedTopics.some(topic => record.tag.endsWith(topic)) && baselineRecords.get(record.key) !== record.postedAt)) throw new NotificationOverlapError();
    return records;
  };
  // A pending filesystem checkpoint must not pin the radio cycle past cancellation or its bound.
  const checkpoint = async (): Promise<void> => {
    checkExecution();
    const signal = execution?.signal;
    const bound = execution === undefined ? 30_000 : Math.max(1, Math.min(30_000, execution.deadline - performance.now()));
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      await Promise.race([
        runtime.beforeEffect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Push checkpoint persistence exceeded its bound")), bound);
          if (signal !== undefined) {
            abort = () => reject(signal.reason ?? new Error("Push execution cancelled"));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }
        }),
      ]);
    } finally { clearTimeout(timer); if (abort !== undefined) signal!.removeEventListener("abort", abort); }
    checkExecution();
  };
  const runtime: AndroidPushRuntime = {
    now: () => performance.now(),
    pause: async milliseconds => {
      checkDeliveryExecution();
      if (execution === undefined) { await Bun.sleep(milliseconds); return; }
      await new Promise<void>((resolve, reject) => {
        const signal = execution!.signal;
        const remaining = execution!.deadline - performance.now();
        const expires = milliseconds >= remaining;
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(deliveryTimeout(signal.reason)); };
        const finish = () => {
          const remaining = execution!.deadline - performance.now();
          if (expires && remaining > 0) {
            timer = setTimeout(finish, Math.max(1, Math.ceil(remaining)));
            return;
          }
          signal.removeEventListener("abort", abort);
          if (expires) reject(deliveryTimeout(new Error("Android Push execution deadline")));
          else resolve();
        };
        let timer = setTimeout(finish, Math.min(milliseconds, Math.max(1, remaining)));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      checkDeliveryExecution();
    },
    beforeEffect: async () => { throw new Error("Push runtime has no checkpoint owner"); },
    beginCleanup(context) {
      execution = context ?? { signal: new AbortController().signal, deadline: performance.now() + 15 * 60_000,
        nextFailureId: options.execution?.nextFailureId ?? localFailureId };
    },
    async preflight(input) {
      if (input.origin !== identity.origin) throw new Error("Push preflight origin differs from its runtime");
      const selected = resolveAndroidBrowserTarget(), stock = resolveAndroidBrowserTarget({});
      if (selected.packageName !== stock.packageName || selected.activity !== stock.activity || selected.devtoolsSocket !== stock.devtoolsSocket) throw new Error("Android Push requires the stock Chrome browser target");
      serial = await requireSingleDevice((...args) => boundedAdb(undefined, args));
      if (ownedPushForwards(await command("forward", "--list"), serial, selected.devtoolsSocket).length > 0) throw new Error("Android Push debug forward is occupied; clean up its owning attempt first");
      await requireAndroidDevicePreconditions(command, { switchesRadios: true, needsNotifications: true });
      packageName = await requireWebApk(command, identity.origin);
      const pin = await readAndroidQualificationPin(serial, undefined, execution);
      pin.fill(0);
      const model = (await command("shell", "getprop", "ro.product.model")).trim();
      const android = (await command("shell", "getprop", "ro.build.version.release")).trim();
      const browser = parseAndroidPackageVersion(await command("shell", "dumpsys", "package", "com.android.chrome"));
      requireAndroidPushDevice(model, android);
      if (Bun.version !== identity.omp.bunVersion) throw new Error("Push driver Bun does not match the pin");
      const device = await runtime.device();
      if (device.forcedDoze || device.batteryOverride) throw new Error("Push qualification requires no pre-existing battery/Doze override");
      return { android, browser, webApk: true, dndOff: true };
    },
    async gcmReadiness() {
      const start = runtime.now();
      let gcmRemedyApplied = false, mutationInFlight = false, reconnectObserved = false;
      let lastConnected: boolean | undefined;
      let sample = "Is client connected: unavailable; Reconnect Scheduler Alarm: unavailable";
      const observations = () => ({ gcmConnected: lastConnected === true, gcmRemedyApplied });
      const diagnostic = (cause?: unknown) => new Error(`GcmService censored sample: ${sample}`, cause === undefined ? undefined : { cause });
      const fail = (reason: "gcm_disconnected" | "invalid_evidence" | "deadline_exceeded", cause?: unknown): never => {
        const common = { id: nextFailureId(), lane: "rigReadiness" as const, step: "pixel_push" as const,
          elapsedMs: Math.round(runtime.now() - start), operation: "read_only" as const,
          observations: observations() };
        if (reason === "gcm_disconnected") throw new QualificationFailure({ ...common, reason, class: "infra_transient" }, { cause });
        throw new QualificationFailure({ ...common, reason, class: "harness" }, { cause });
      };
      const expiredWindow = (cause?: unknown): never =>
        fail(reconnectObserved && lastConnected === false ? "gcm_disconnected" : "deadline_exceeded", cause);
      const executionFailure = (error: unknown): unknown => {
        try { checkExecution(); return error; }
        catch (expiry) {
          return expiry instanceof QualificationFailure ?
            Object.assign(new QualificationFailure(expiry.evidence,
              { cause: new AggregateError([error, expiry], "GCM operation and execution failed") }),
            pixelUnrestored(expiry) ? { pixelUnrestored: true } : {}) :
            new AggregateError([error, expiry], "GCM operation and execution failed");
        }
      };
      const retain = (error: unknown, ancestors = new Set<unknown>()): Error => {
        if (error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length > 0 && !ancestors.has(error)) {
          ancestors.add(error);
          const retained = Object.assign(new AggregateError(error.errors.map(child => retain(child, ancestors)),
            "GCM readiness failures", { cause: diagnostic(error) }), pixelUnrestored(error) ? { pixelUnrestored: true } : {});
          ancestors.delete(error);
          return retained;
        }
        const evidence = error instanceof QualificationFailure ? error.evidence : {
          id: nextFailureId(), lane: "rigReadiness" as const, step: "pixel_push" as const,
          reason: "invalid_evidence" as const, class: "harness" as const, elapsedMs: Math.round(runtime.now() - start),
          operation: mutationInFlight ? "unknown" as const : "read_only" as const, observations: {},
        };
        return Object.assign(new QualificationFailure({ ...evidence,
          observations: { ...evidence.observations, ...observations() } }, { cause: diagnostic(error) }),
        pixelUnrestored(error) ? { pixelUnrestored: true } : {});
      };
      const read = async (windowDeadline?: number): Promise<boolean> => {
        checkExecution();
        const device = await selectDevice();
        if (windowDeadline !== undefined && runtime.now() >= windowDeadline) expiredWindow();
        const commandDeadline = runtime.now() + 10_000;
        const deadline = Math.min(commandDeadline, windowDeadline ?? Infinity);
        let dump: string;
        try {
          dump = await boundedAdb(device, ["shell", "dumpsys", "activity", "service", "GcmService"],
            Math.max(1, deadline - runtime.now()));
        } catch (error) {
          rethrowPushSafetyFailure(error);
          const current = executionFailure(error);
          if (current !== error) throw current;
          if (windowDeadline !== undefined && runtime.now() >= windowDeadline) expiredWindow(error);
          if (runtime.now() >= commandDeadline) fail("deadline_exceeded", error);
          throw error;
        }
        checkExecution();
        // Late output cannot replace the last observation actually made inside this window.
        if (windowDeadline !== undefined && runtime.now() >= windowDeadline) expiredWindow();
        if (runtime.now() >= commandDeadline) fail("deadline_exceeded");
        // Never retain DeviceID, app/message IDs, network names, endpoints or the raw dump.
        // Candidate detection is deliberately broader than the one accepted spelling below:
        // suffixes (including word characters), case and spacing variants must not be ignored.
        const flags = [...dump.matchAll(/^[^\S\r\n]*Is[^\S\r\n]*client[^\S\r\n]*connected[^\r\n]*\r?$/gimu)];
        const connected = flags.length === 1 ?
          /^[ \t]*Is client connected: (true|false)[ \t]*\r?$/u.exec(flags[0]![0])?.[1] ?? "unavailable" : "unavailable";
        const alarm = dump.match(/^[ \t]*Reconnect Scheduler Alarm: (OFF|in PT(?=\d)(?:\d{1,3}H)?(?:\d{1,3}M)?(?:\d{1,3}(?:\.\d{1,3})?S)?)[ \t]*\r?$/mu)?.[1] ?? "unavailable";
        sample = `Is client connected: ${connected}; Reconnect Scheduler Alarm: ${alarm}`;
        lastConnected = connected === "unavailable" ? undefined : connected === "true";
        if (connected === "unavailable") fail("invalid_evidence");
        if (windowDeadline !== undefined) reconnectObserved = true;
        return connected === "true";
      };
      try {
        if (await read()) return { observations: { gcmConnected: true, gcmRemedyApplied }, diagnostic: diagnostic() };
        // Record the attempted cycle before either mutating command; restoration owns uncertain exits.
        await checkpoint();
        gcmRemedyApplied = true; mutationInFlight = true;
        await boundedAdb(await selectDevice(), ["shell", "svc", "wifi", "disable"], 10_000);
        await runtime.pause(2_000);
        await checkpoint();
        await boundedAdb(await selectDevice(), ["shell", "svc", "wifi", "enable"], 10_000);
        mutationInFlight = false;
        const deadline = runtime.now() + 30_000;
        while (runtime.now() < deadline) {
          if (await read(deadline)) return { observations: { gcmConnected: true, gcmRemedyApplied }, diagnostic: diagnostic() };
          await runtime.pause(Math.min(500, deadline - runtime.now()));
        }
        checkExecution();
        return expiredWindow();
      } catch (error) {
        // A rejected ADB operation can mask a simultaneous cancellation. Preserve both privately,
        // without replacing a stronger typed persistence/containment failure or duplicating roots.
        if (error instanceof QualificationFailure && error.evidence.lane === "androidPush" && error.evidence.reason === "delivery_timeout" ||
          !(error instanceof QualificationFailure) && !(error instanceof AggregateError)) {
          error = executionFailure(error);
        }
        throw retain(error);
      }
    },
    dndOff: async () => (await command("shell", "settings", "get", "global", "zen_mode")).trim() === "0",
    async device() {
      packageName ??= await requireWebApk(command, identity.origin);
      const idle = await command("shell", "dumpsys", "deviceidle");
      const battery = await command("shell", "dumpsys", "battery");
      const window = await command("shell", "dumpsys", "window");
      return { ...await readAndroidRadioBaseline(command),
        forcedDoze: /mForceIdle=true/u.test(idle), batteryOverride: /UPDATES STOPPED/u.test(battery),
        awake: /mWakefulness=Awake/u.test(await command("shell", "dumpsys", "power")), locked: parseKeyguardShowing(window),
        webApkTask: webApkTasks(await command("shell", "dumpsys", "activity", "activities"), packageName).length > 0,
        chromeNotificationsAllowed: /android.permission.POST_NOTIFICATIONS: granted=true/u.test(await command("shell", "dumpsys", "package", "com.android.chrome")),
        webApkNotificationsAllowed: /android.permission.POST_NOTIFICATIONS: granted=true/u.test(await command("shell", "dumpsys", "package", packageName)) };
    },
    async browser() {
      const baseline: { step: PushBrowserStep } = { step: "browser_capture" }, started = runtime.now();
      try {
        const result = await page(browserState, true, baseline);
        checkExecution();
        return result;
      }
      catch (error) {
        let failure: Error;
        try {
          rethrowPushSafetyFailure(error);
          failure = new QualificationFailure({ id: nextFailureId(), lane: "androidPush", step: baseline.step,
            reason: "browser_baseline_failed", class: "harness", operation: "unknown",
            elapsedMs: Math.round(runtime.now() - started), observations: {} }, { cause: error });
        } catch (safetyError) { failure = safetyError as Error; }
        try { await options.browserFailure?.(baseline.step, error, Math.round(runtime.now() - started)); }
        catch (retentionError) {
          // Private diagnostic failure cannot manufacture a new sanitized failure leaf.
          failure.cause = new AggregateError(failure.cause === undefined ? [retentionError] : [failure.cause, retentionError],
            "Push browser diagnostic retention failed");
        }
        if (failure instanceof QualificationFailure && failure.evidence.reason === "deadline_exceeded") throw failure;
        try { checkExecution(); }
        catch (deadline) {
          if (deadline !== failure) throw new AggregateError([failure, deadline], "Push browser failed at execution deadline");
        }
        throw failure;
      }
    },
    async subscriptionCount() {
      checkExecution();
      const signal = execution === undefined ? AbortSignal.timeout(15_000) :
        AbortSignal.any([execution.signal, AbortSignal.timeout(Math.max(1, Math.min(15_000, execution.deadline - performance.now())))]);
      const response = await fetch(`${identity.origin}/api/v1/push/config`, { cache: "no-store", signal });
      if (!response.ok) throw new Error("Android Push subscription inventory refused");
      return parsePushConfigResponse(await response.json()).subscriptionCount;
    },
    async fixture(operation, epoch, role = "primary", expectedOwner) {
      currentEpoch = epoch;
      if (operation === "start") {
        const host = location(epoch, role);
        if (host.binary === "") throw new Error("OMP_PUSH_FIXTURE_BINARY must name the pinned OMP entrypoint");
        const bun = await execute([host.bun, "--version"]);
        if (bun.exitCode !== 0 || bun.stdout.trim() !== identity.omp.bunVersion) throw new Error("Push fixture Bun does not match the pin");
        if ((await execute(["python3", "-c", "import os; os.forkpty"])).exitCode !== 0) throw new Error("Push fixture host requires Python 3 with forkpty");
        const extension = "fixtures/push-qualification-extension.ts";
        const expected = createHash("sha256").update(await readFile(join(import.meta.dir, extension))).digest("hex");
        const staged = await execute(["shasum", "-a", "256", join(host.scripts, extension)]);
        if (staged.exitCode !== 0 || staged.stdout.trim().split(/\s+/u)[0] !== expected) throw new Error("staged Push extension differs from lane source");
        const version = await execute([...( /\.[cm]?[jt]s$/u.test(host.binary) ? [host.bun, host.binary] : [host.binary]), "--version"]);
        if (version.exitCode !== 0 || version.stdout.trim() !== `omp/${identity.omp.version}`) throw new Error("Push fixture OMP does not match the exact pin");
      }
      await runtime.beforeEffect();
      if (expectedOwner !== undefined) {
        const current = await snapshot(epoch, role);
        checkExecution();
        if (operation !== "ask" || current === undefined || !current.canControl || current.inputRequired ||
          current.instanceId !== expectedOwner.instanceId || current.generation !== expectedOwner.generation ||
          current.ask?.requestId !== expectedOwner.ask?.requestId || current.qualificationPushAlias !== expectedOwner.qualificationPushAlias) {
          throw new QualificationFailure({ id: nextFailureId(), lane: "androidPush", step: phase,
            class: "harness", reason: "invalid_evidence", operation: "read_only", elapsedMs: 0, observations: {} });
        }
      }
      await commandPushFixture(location(epoch, role), operation, execute, expectedOwner !== undefined);
    },
    snapshot,
    async beginNotificationPhase(epoch, currentPhase) {
      if (currentPhase !== undefined) phase = currentPhase;
      const [primary, secondary] = [await snapshot(epoch), await snapshot(epoch, "secondary")];
      if (primary === undefined) throw new Error("Push fixture missing before notification phase");
      packageName ??= await requireWebApk(command, identity.origin);
      observedTopics = [primary, secondary].flatMap(session => session === undefined ? [] : [`omp-attention-${session.instanceId}`]);
      baselineRecords = new Map((await readAndroidNotificationRecords(command, packageName)).map(record => [record.key, record.postedAt]));
      observedPosts.clear(); observationArmed = true;
    },
    async assertNotificationOwnership() {
      await phaseRecords();
    },
    ...(options.qualificationLogs === undefined ? {} : {
      beginDeliveryTelemetry: (phase: Parameters<NonNullable<AndroidPushRuntime["beginDeliveryTelemetry"]>>[0]) =>
        logEvidence(() => options.qualificationLogs!.begin(phase === "readiness" ? "rigReadiness" : "androidPush", phase)),
      deliveryTelemetry: (window: Parameters<QualificationLogs["end"]>[0]) => logEvidence(() => options.qualificationLogs!.end(window)),
    }),
    async deliveryOwnership(session) {
      if (currentEpoch === undefined) return undefined;
      return qualificationPushAliasFor(session, [await snapshot(currentEpoch), await snapshot(currentEpoch, "secondary")]);
    },
    async deliveryRequestMatches(session) {
      if (currentEpoch === undefined) return false;
      if (!matchesPushDeliverySnapshot(session, [await snapshot(currentEpoch), await snapshot(currentEpoch, "secondary")])) return false;
      return chrome(driver => observePushDeliveryRequest(driver, identity.origin, session),
        { port: 9238, launchBrowser: false, ...(execution === undefined ? {} : { execution }) });
    },
    async detail(level) {
      await page(async driver => {
        let state = await browserState(driver);
        if (state.permission !== "granted") throw new Error("grant origin notification permission before Android Push qualification");
        await runtime.beforeEffect();
        await driver.evaluate('document.querySelector("#settings").click()');
        if (!state.subscribed) {
          await driver.send("Runtime.evaluate", { expression: 'document.querySelector("#notify").click()', userGesture: true });
          await wait(async () => (await browserState(driver)).subscribed, "subscription");
        }
        await driver.evaluate(`document.querySelector('input[name="notification-detail"][value="${level}"]').click()`);
        await wait(async () => (await browserState(driver)).detail === level, "detail selection");
        // Reopen reconciles from the server; a checked radio alone cannot prove the save completed.
        await navigateRoot(driver);
        state = await browserState(driver);
        if (!state.subscribed || state.detail !== level) throw new Error("server did not retain selected notification detail");
        selectedDetail = level;
      }, true);
    },
    async closePwa() {
      packageName ??= await requireWebApk(command, identity.origin);
      await closeWebApk(mutate, packageName);
      await mutate("shell", "input", "keyevent", "3");
    },
    openPwa: async () => { await page(async driver => {
      await browserState(driver);
      await wait(async () => driver.evaluate<boolean>('document.readyState === "complete" && document.visibilityState === "visible" && document.querySelector("#status-banner")?.dataset.kind === "ready"'), "resumed directory");
    }); },
    async lock() {
      await mutate("shell", "input", "keyevent", "223");
      await wait(async () => parseKeyguardShowing(await command("shell", "dumpsys", "window")), "secure lock", 10_000);
    },
    async observe(session, kind, level) {
      if (!await runtime.dndOff()) throw new Error("turn Do Not Disturb off on the Pixel for the qualification window");
      const expected = expectation(session, kind, level);
      const records = (await phaseRecords()).filter(record => record.tag.endsWith(expected.tag));
      const owned = records[0];
      if (records.length === 1 && owned !== undefined) {
        if (owned.postedAt <= (baselineRecords.get(owned.key) ?? 0)) throw new Error("owned notification did not advance from its record baseline");
        try { trackUnchangedNotificationPost(observedPosts, session, kind, owned); } catch (error) { throw privacyFailure({ cause: error }); }
      }
      return { count: records.length, titleMatches: records.length === 1 && owned?.title === expected.title,
        bodyMatches: records.length === 1 && owned?.body === expected.body,
        forbiddenFound: records.some(record => expected.forbidden.some(value => record.text.includes(value))) };
    },
    async presentation(session, level) {
      await mutate("shell", "input", "keyevent", "224");
      await Bun.sleep(1_200);
      await runtime.assertNotificationOwnership();
      const expected = expectation(session, "attention", level);
      const found = await findAndroidNotification(mutate, expected);
      await wait(async () => {
        const records = (await phaseRecords()).filter(record => record.tag.endsWith(expected.tag));
        return records.length === 1 && records[0]!.seen && records[0]!.visibleSince >= records[0]!.postedAt;
      }, "owned lock-screen visibility", 10_000);
      const texts = found.rowNodes.flatMap(node => [node.text, node.description]);
      const body = [...[session.title, session.cwdLabel].filter((v, i, a) => v && a.indexOf(v) === i).join(" · ")].slice(0, 256).join("");
      const privateHidden = !texts.some(text => [session.title, session.cwdLabel].some(label => label !== undefined && text.includes(label)));
      const checked = { locked: parseKeyguardShowing(await command("shell", "dumpsys", "window")),
        title: texts.some(text => text.includes(title("attention"))),
        detail: level === "private" ? privateHidden : texts.some(text => text.includes(body)),
        privacy: !texts.some(text => expected.forbidden.some(value => text.includes(value))) };
      if (!Object.values(checked).every(Boolean)) throw privacyFailure();
      return true;
    },
    async tap(session, kind, stale) {
      await runtime.assertNotificationOwnership();
      await runtime.lock();
      const observation: PushTapObservation = await chrome(async driver => {
        let attached: Promise<void> | undefined;
        let attachedError = false;
        let observerFailure = "none";
        let observerSafetyFailure: unknown;
        const observerErrors: unknown[] = [];
        const recordFailure = (error: unknown) => {
          attachedError = true;
          observerErrors.push(error);
          try { rethrowPushSafetyFailure(error); } catch { observerSafetyFailure ??= error; }
          const message = error instanceof Error ? error.message : "";
          const method = ["Page.enable", "Runtime.enable", "Network.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger", "Page.addScriptToEvaluateOnNewDocument"].find(item => message.includes(item)) ?? "other";
          observerFailure = `${method}:${message.includes("timeout") ? "timeout" : message.includes("wasn't found") ? "unsupported" : "failed"}`;
        };
        let launches = 0;
        let successful = 0;
        let currentGeneration = false;
        let currentRequest = false;
        let modeMatches = false;
        let routeObserved = false;
        let routeScrubbed = false, apiScrubbed = true, metadataObserved = false;
        const observeRoute = (value: unknown) => {
          if (routeObserved || !isPushNotificationRoute(value, identity.origin)) return;
          routeObserved = true; routeScrubbed = false; apiScrubbed = true; metadataObserved = false;
        };
        let tabsSeen = 0, pagesSeen = 0, pausedTabs = 0, pausedPages = 0;
        const requests = new Set<string>();
        const attachedTargets = new Set<string>();
        const tabWatches: Promise<void>[] = [];
        let stage = "observer admission";
        const attach = (targetId: string, attachedSession?: string, paused = false) => {
          if (attachedTargets.has(targetId)) return;
          attachedTargets.add(targetId);
          const previous = attached ?? Promise.resolve();
          attached = previous.then(async () => {
            if (attachedSession === undefined) {
              await driver.attachTab(targetId);
              await driver.send("Network.enable");
            } else {
              await Promise.all([driver.sessionSend(attachedSession, "Network.enable"), driver.attachTab(targetId, attachedSession)]);
            }
            if (paused) await driver.send("Runtime.runIfWaitingForDebugger");
          }).catch(recordFailure);
        };
        const stopListening = driver.onEvent((method, params) => {
          if (method === "Target.targetInfoChanged" || method === "Target.targetCreated") {
            const target = params.targetInfo as { type?: string; url?: string } | undefined;
            if (target?.type === "page") observeRoute(target.url);
          }
          if (method === "Page.frameStartedNavigating" || method === "Page.navigatedWithinDocument") observeRoute(params.url);
          if (method === "Target.attachedToTarget") {
            const target = params.targetInfo as { type?: string } | undefined;
            if (target?.type === "tab") { tabsSeen++; if (params.waitingForDebugger === true) pausedTabs++; }
            if (target?.type === "page") { pagesSeen++; if (params.waitingForDebugger === true) pausedPages++; }
          }
          if (method === "Target.attachedToTarget") {
            const target = params.targetInfo;
            if (typeof target !== "object" || target === null || !("type" in target) || !("targetId" in target) || typeof target.targetId !== "string") return;
            const targetId = target.targetId;
            const attachedSession = params.sessionId;
            if (typeof attachedSession !== "string") { attachedError = true; return; }
            if (target.type === "tab") {
              // Current Chromium attaches tab targets at browser level, then their page children.
              // A removed WebAPK task may retain its tab shell, so existing tabs need child watches.
              const watching = Promise.all([
                driver.sessionSend(attachedSession, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }, { exclude: true }] }),
                ...(params.waitingForDebugger === true ? [driver.sessionSend(attachedSession, "Runtime.runIfWaitingForDebugger")] : []),
              ]).then(() => {}).catch(recordFailure);
              tabWatches.push(watching);
              return;
            }
            if (target.type !== "page") return;
            if ("url" in target && typeof target.url === "string" && target.url !== "" && target.url !== "about:blank" && !target.url.startsWith(`${identity.origin}/`)) {
              // Do not initialize Chrome's undriveable native new-tab page or unrelated web pages.
              if (params.waitingForDebugger === true) void driver.sessionSend(attachedSession, "Runtime.runIfWaitingForDebugger").catch(recordFailure);
              return;
            }
            if ("url" in target) observeRoute(target.url);
            attach(targetId, attachedSession, params.waitingForDebugger === true);
          }
          if (method === "Page.frameNavigated") {
            const frame = params.frame;
            if (typeof frame === "object" && frame !== null && "url" in frame) observeRoute(frame.url);
          }
          if (method === "Page.navigatedWithinDocument" && params.url === `${identity.origin}/`) routeScrubbed = true;
          if (method === "Network.requestWillBeSent") {
            const request = params.request;
            if (typeof request !== "object" || request === null || !("url" in request) || typeof request.url !== "string") return;
            observeRoute(request.url);
            if (routeObserved && request.url.startsWith(`${identity.origin}/api/`)) apiScrubbed &&= routeScrubbed;
            if (routeObserved && request.url === `${identity.origin}/api/v1/sessions`) metadataObserved = true;
            if (request.url !== `${identity.origin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`) return;
            launches++;
            if (typeof params.requestId === "string") requests.add(params.requestId);
            if ("postData" in request && typeof request.postData === "string") {
              ({ currentGeneration, currentRequest, modeMatches } = observePushLaunch(session, kind, request.postData));
            }
          }
          if (method === "Network.responseReceived" && typeof params.requestId === "string" && requests.has(params.requestId)) {
            const response = params.response;
            if (typeof response === "object" && response !== null && "status" in response && response.status === 200) successful++;
          }
        });
        try {
          await driver.browserSend("Target.setDiscoverTargets", { discover: true, filter: [{ type: "tab" }, { type: "page" }, { exclude: true }] });
          await driver.browserSend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "tab" }, { exclude: true }] });
          await Promise.all(tabWatches);
          if (attachedError) throw new Error("notification child observers unavailable");
          const existing = await targetForOrigin(driver);
          if (existing !== undefined) { attach(existing); await attached; }
          stage = "notification input";
          await mutate("shell", "input", "keyevent", "224");
          await Bun.sleep(1_200);
          await tapAndroidNotification(mutate, expectation(session, kind));
          stage = "keyguard authentication";
          // Menu/dismiss-keyguard would replace the notification's pending launch action.
          // Authenticate the bouncer created by the tap, without another dismiss request.
          try {
            await authenticateAndroidNotification({ command, revealPin: () => showAndroidPinBouncer(mutate),
              unlock: async () => { await runtime.beforeEffect(); await unlockAndroidKeyguard(serial!, undefined, undefined, execution); }, wait });
          } catch (error) {
            rethrowPushSafetyFailure(error);
            let nodes: AndroidUiNode[], remaining: number;
            try {
              nodes = await readAndroidUi(command);
              remaining = (await readAndroidNotificationRecords(command, packageName!)).filter(record => record.tag.endsWith(`omp-attention-${session.instanceId}`)).length;
            } catch (diagnosticError) {
              throw new Error("notification authentication diagnostics failed", { cause: new AggregateError([error, diagnosticError]) });
            }
            throw new Error(`notification authentication unavailable (owned records: ${remaining}; secure inputs: ${nodes.filter(node => node.systemInput).length})`, { cause: error });
          }
          stage = "page attachment";
          await wait(async () => { if (attachedError) throw new Error("tap observer could not attach"); return attached !== undefined; }, "notification target");
          await attached;
          if (attachedError) throw new Error("tap observer could not attach");
          stage = "client destination";
          await wait(async () => {
            if (launches > 1 || successful > 1 || (stale && launches !== 0)) throw new Error("notification tap made an unexpected launch");
            // A restored tab can briefly expose its old connected DOM before the tap navigates it.
            // Never accept that surface before this tap's own revalidation/launch is observed.
            if (stale ? !metadataObserved : launches !== 1 || successful !== 1) return false;
            return driver.evaluate<boolean>(stale ?
              'location.pathname === "/" && document.querySelector("#status-banner")?.dataset.kind === "expired"' :
              `location.pathname === "/client/" && document.querySelector(".conn-chip")?.dataset.state === "connected" && (${kind === "attention" ?
                `[...document.querySelectorAll('.sh-ask-option')].some(button => button.textContent?.includes(${JSON.stringify(PUSH_FIXTURE_ASK_BODY)}) && !button.disabled)` :
                'document.querySelector(".sh-composer-input") instanceof HTMLTextAreaElement'})`);
          }, "notification destination", 90_000);
          if (!stale && !modeMatches) throw new Error("notification tap requested the wrong authority mode");
          const surface = await driver.evaluate<{ writable: boolean; readOnly: boolean; expired: boolean; scrubbed: boolean }>(`(() => {
            const editor = document.querySelector('.sh-composer-input');
            const choices = [...document.querySelectorAll('.sh-ask-option')].filter(button => button.textContent?.includes(${JSON.stringify(PUSH_FIXTURE_ASK_BODY)}));
            return { writable: (editor instanceof HTMLTextAreaElement && !editor.disabled) || (choices.length === 1 && choices[0] instanceof HTMLButtonElement && !choices[0].disabled),
              readOnly: editor instanceof HTMLTextAreaElement && editor.disabled,
              expired: location.pathname === '/' && document.querySelector('#status-banner')?.dataset.kind === 'expired',
              scrubbed: location.search === '' && location.hash === '' };
          })()`);
          return { launches, successful, currentGeneration, currentRequest, scrubbedBeforeNetwork: routeObserved && routeScrubbed && apiScrubbed && metadataObserved && surface.scrubbed,
            writable: surface.writable, readOnly: surface.readOnly, expired: surface.expired };
        } catch (error) {
          if (observerSafetyFailure !== undefined) throw new AggregateError([observerSafetyFailure], "Android Push observer safety failure",
            { cause: new AggregateError([error, ...observerErrors], "Android Push observer diagnostics") });
          if (error instanceof Error && observerErrors.length > 0) error.cause = new AggregateError(
            [...(error.cause === undefined ? [] : [error.cause]), ...observerErrors], "Android Push observer diagnostics");
          rethrowPushSafetyFailure(error);
          if (everyError(error, nested => nested instanceof NotificationOverlapError)) throw error;
          // Already-observed closed values only: secondary device reads must not mask the cause.
          const diagnostics = { observerFailure, tabsSeen, pagesSeen, pausedTabs, pausedPages, launches, successful,
            currentGeneration, currentRequest, modeMatches, routeObserved, routeScrubbed, metadataObserved };
          throw new Error(`Android Push tap failed during ${stage}: ${JSON.stringify(diagnostics)}`, { cause: error });
        } finally {
          stopListening();
          // withAndroidChrome closes the owned CDP connection, detaching its auto-attached targets.
        }
      }, { port: 9238, launchBrowser: false, ...(execution === undefined ? {} : { execution }) });
      await runtime.assertNotificationOwnership();
      return observation;
    },
    async triage(action) {
      return page(async driver => {
        // Count only what the control causes: a starting app re-registers its push subscription.
        let counting = false;
        let mutations = 0;
        await driver.send("Network.enable");
        const stopListening = driver.onEvent((method, params) => {
          const request = params.request;
          if (counting && method === "Network.requestWillBeSent" && typeof request === "object" && request !== null && "method" in request && "url" in request &&
            request.method !== "GET" && typeof request.url === "string" && request.url.startsWith(`${identity.origin}/`)) mutations++;
        });
        try {
          // Reload only away from the directory: an open Undo window lives in page memory.
          if (!await driver.evaluate<boolean>('location.pathname === "/"')) await navigateRoot(driver);
          // That re-registration settles the notification control; wait for it and the directory.
          await wait(async () => driver.evaluate<boolean>('document.querySelector("#status-banner")?.dataset.kind === "ready" && !["checking", undefined].includes(document.querySelector("#notify")?.dataset.state)'), "ready directory");
          if (action !== undefined) {
            await runtime.beforeEffect();
            counting = true;
            const clicked = await driver.evaluate<boolean>(`(() => {
              if (${JSON.stringify(action.kind)} === "hold") {
                const options = document.querySelector('article.queue-hero[data-instance-id="' + CSS.escape(${JSON.stringify("instanceId" in action ? action.instanceId : "")}) + '"] .hero-options');
                if (!(options instanceof HTMLButtonElement) || options.disabled) return false;
                options.click();
              }
              const control = document.querySelector(${JSON.stringify(TRIAGE_CONTROLS[action.kind])}.replaceAll("$ID", CSS.escape(${JSON.stringify("instanceId" in action ? action.instanceId : "")})));
              if (!(control instanceof HTMLButtonElement) || control.disabled) return false;
              control.click(); return true;
            })()`);
            if (!clicked) throw new Error(`Android Push ${action.kind} control unavailable`);
          }
          await Bun.sleep(action?.settleMs ?? 1_500);
          return { ...await driver.evaluate<Omit<TriageObservation, "mutations">>(DIRECTORY_STATE), mutations };
        } finally {
          stopListening();
        }
      });
    },
    async replay(session) {
      if (session.ask === undefined || currentEpoch === undefined) throw new Error("Android Push replay needs the request it re-presents");
      const expected = expectation(session, "attention");
      // Launching the app re-saves its subscription, and the gateway then re-sends each current ask
      // on this tag, replacing the replay. A newer ask therefore needs the app already open.
      const live = [await snapshot(currentEpoch), await snapshot(currentEpoch, "secondary")].find(item => item?.instanceId === session.instanceId);
      if (live?.ask !== undefined && live.ask.requestId !== session.ask.requestId &&
        webApkTasks(await command("shell", "dumpsys", "activity", "activities"), expected.packageName).length === 0) {
        throw new Error("Android Push replay over a newer ask needs the app already open");
      }
      const posted = async () => (await phaseRecords()).filter(record => record.tag.endsWith(expected.tag));
      const before = Math.max(0, ...(await posted()).map(record => record.postedAt));
      // The worker's own fields for this request: metadata only, as the push that carried it.
      const options = { tag: expected.tag, icon: "/icon-192.png", badge: "/icon-192.png", ...(expected.body === "" ? {} : { body: expected.body }),
        data: { version: PUSH_API_VERSION, type: "attention", instanceId: session.instanceId, requestId: session.ask.requestId } };
      await page(async driver => {
        await runtime.beforeEffect();
        await driver.evaluate(`(async () => {
          await (await navigator.serviceWorker.ready).showNotification(${JSON.stringify(expected.title)}, ${JSON.stringify(options)});
        })()`);
      });
      try {
        await wait(async () => {
          const records = await posted();
          return records.length === 1 && records[0]!.postedAt > before && records[0]!.title === expected.title && records[0]!.body === expected.body;
        }, "replayed notification", 15_000);
      } catch (error) {
        rethrowPushSafetyFailure(error);
        // The closed values the wait saw, so a missing replay names what the device did show.
        const seen = (await posted().catch(diagnosticError => {
          throw new Error("Android Push replay diagnostics failed", { cause: new AggregateError([error, diagnosticError]) });
        })).map(record => ({ tag: record.tag.slice(-48), title: record.title, body: record.body, postedAfterBaseline: record.postedAt > before }));
        throw new Error(`${error instanceof Error ? error.message : "Android Push replayed notification unavailable"} (expected title ${JSON.stringify(expected.title)}, body ${JSON.stringify(expected.body)}; records ${JSON.stringify(seen)})`, { cause: error });
      }
      await runtime.closePwa();
    },
    async dismissOwned() {
      const topics = observedTopics;
      await page(async driver => {
        await runtime.beforeEffect();
        await driver.evaluate(`(async () => {
          const topics = ${JSON.stringify(topics)};
          for (const notice of await (await navigator.serviceWorker.ready).getNotifications()) if (topics.includes(notice.tag)) notice.close();
        })()`);
      });
      await wait(async () => (await phaseRecords()).every(record => !topics.some(topic => record.tag.endsWith(topic))), "owned notification dismissal", 15_000);
    },
    async answer() {
      await wake();
      await chrome(async driver => {
        const target = await targetForOrigin(driver);
        if (target === undefined) throw new Error("authoritative Control target unavailable");
        await driver.attachTab(target);
        await runtime.beforeEffect();
        const answered = await driver.evaluate<boolean>(`(() => {
          const buttons = [...document.querySelectorAll('.sh-ask-option')].filter(element => element.textContent?.includes(${JSON.stringify(PUSH_FIXTURE_ASK_BODY)}));
          if (buttons.length !== 1 || buttons[0].disabled) return false; buttons[0].click(); return true;
        })()`);
        if (!answered) throw new Error("authoritative Control answer unavailable");
        await wait(async () => driver.evaluate<boolean>('document.querySelector(".sh-ask-send") instanceof HTMLButtonElement && !document.querySelector(".sh-ask-send").disabled'), "selected answer submission");
        await runtime.beforeEffect();
        await driver.evaluate('document.querySelector(".sh-ask-send").click()');
      }, { port: 9238, launchBrowser: false, ...(execution === undefined ? {} : { execution }) });
    },
    async forceStop() { await runtime.closePwa(); await mutate("shell", "am", "force-stop", "com.android.chrome"); },
    async permission(value) {
      await page(async driver => {
        // Android may freeze the browser after task removal; wake it before probing
        // and releasing the retained override connection at the end of the window.
        if (value === "denied" && releasePermission === undefined) {
          await runtime.beforeEffect();
          releasePermission = await holdAndroidNotificationDenial(identity.origin, (run, context) =>
            chrome(run, { port: 9237, launchBrowser: false, ...(context === undefined ? {} : { execution: context }) }), execution);
        } else if (value !== "denied" && releasePermission !== undefined) {
          await runtime.beforeEffect();
          const release = releasePermission; releasePermission = undefined;
          await release();
        }
        await navigateRoot(driver);
        const state = await browserState(driver);
        if (state.permission !== value) throw new Error("origin notification permission did not change");
        if (value === "denied") {
          await driver.evaluate('document.querySelector("#settings").click()');
          if (!await driver.evaluate<boolean>('document.querySelector("#notify")?.dataset.state === "blocked" && document.querySelector("#notify")?.disabled === true')) throw new Error("notification Settings did not expose blocked permission");
        }
      });
    },
    async doze(enabled) {
      if (enabled) {
        await mutate("shell", "dumpsys", "battery", "unplug");
        await runtime.lock();
        await mutate("shell", "dumpsys", "deviceidle", "force-idle", "deep");
      } else {
        await mutate("shell", "dumpsys", "deviceidle", "unforce");
        await mutate("shell", "dumpsys", "battery", "reset");
      }
      const idle = await command("shell", "dumpsys", "deviceidle");
      if (/mForceIdle=true/u.test(idle) !== enabled || (enabled && !/mState=IDLE\b/u.test(idle))) throw new Error("forced Doze state mismatch");
    },
    async network(value) {
      await restoreAndroidRadios({ airplane: value === "airplane", wifi: value === "wifi", mobile: value !== "airplane" }, command, mutate);
      await Bun.sleep(5_000);
      if (value === "airplane") return (await runtime.device()).airplane;
      if (value === "cellular") {
        const connectivity = await command("shell", "dumpsys", "connectivity");
        const networks = connectivity.split(/NetworkAgentInfo/u);
        if (!networks.some(network => network.includes("Transports: CELLULAR") && network.includes("VALIDATED"))) return false;
      }
      try {
        await page(async driver => {
          await wait(async () => driver.evaluate<boolean>(`fetch('/api/v1/sessions', {cache:'no-store', signal:AbortSignal.timeout(4000)}).then(r=>r.ok).catch(()=>false)`), "tailnet network", 45_000);
        }, true);
        return true;
      } catch (error) { rethrowPushSafetyFailure(error); return false; }
    },
    async sinks(epoch) {
      const fixture = await snapshot(epoch);
      if (fixture === undefined) throw new Error("fixture missing for sink sweep");
      const result = await page(async driver => driver.evaluate<Record<string, boolean | number>>(`(async () => {
        ${PAGE_PRELUDE}
        const marker = 'SYNTHETIC-PUSH-SINK-CONTROL-53fa479c'; const key = ${JSON.stringify(`__push_sink_control_${epoch}`)};
        const registration = await navigator.serviceWorker.ready;
        const before = history.state; const url = location.href; let db;
        const found = new Set();
        try {
          localStorage.setItem(key,marker); sessionStorage.setItem(key,marker); document.cookie=key+'='+marker+';path=/';
          await (await caches.open(key)).put('/'+key,new Response(marker));
          db=await openDb(key,1,handle=>handle.createObjectStore('s'));
          await new Promise((resolve,reject)=>{const tx=db.transaction('s','readwrite');tx.objectStore('s').put(marker,'k');tx.oncomplete=resolve;tx.onerror=reject;});
          history.replaceState({control:marker},'', '/#'+marker);
          await registration.showNotification(marker,{tag:key,body:marker,data:{control:marker}});
          await scanSinks(value=>typeof value==='string'&&value.includes(marker),sink=>found.add(sink));
        } finally {
          localStorage.removeItem(key);sessionStorage.removeItem(key);document.cookie=key+'=;path=/;max-age=0';await caches.delete(key);
          db?.close();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(key);r.onsuccess=resolve;r.onerror=reject;});
          history.replaceState(before,'',url);for(const n of await registration.getNotifications({tag:key}))n.close();
        }
        const required=['localStorage','sessionStorage','cookie','cacheBody','indexedDB','locationHash','historyState','notificationTitle','notificationBody','notificationData'];
        const residual=[];await scanSinks(value=>typeof value==='string'&&value.includes(marker),sink=>residual.push(sink));
        const response=await fetch('/api/v1/sessions/'+${JSON.stringify(fixture.instanceId)}+'/launch',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',body:JSON.stringify({generation:${fixture.generation},mode:'view'})});
        if(!response.ok)throw Error('sink launch refused');
        const payload=await response.json();const raw=payload.capability;
        if(typeof raw!=='string')throw Error('sink launch missing material');
        const needles=[raw,...raw.split(/[\\/?#&=]/).filter(part=>part.length>=16)];const hits=[];
        await scanSinks(value=>typeof value==='string'&&needles.some(needle=>value.includes(needle)),sink=>hits.push(sink));
        return {detectable:required.every(sink=>found.has(sink)),clean:hits.length===0&&residual.length===0,sinks:required.length,findings:hits.length};
      })()`), true);
      const gatewayLogsDiscarded = options.gatewayLogsDiscarded ?? (() => gatewayRawLogsDiscarded(execute));
      return { ...result, gatewayLogsDiscarded: await gatewayLogsDiscarded(),
        gatewayStructuredLogsSafe: options.qualificationLogs === undefined ? false : await options.qualificationLogs.healthy() };
    },
    async cleanup(step, progress) {
      currentEpoch = progress.epoch;
      switch (step) {
        case "fixtureAsk":
          // A not-yet-started fixture has nothing to settle. Stop verifies ownership before notification cleanup.
          for (const role of ["secondary", "primary"] as const) {
            if (await snapshot(currentEpoch, role) === undefined) continue;
            await runtime.fixture("answer", currentEpoch, role);
            await wait(async () => (await snapshot(currentEpoch!, role))?.inputRequired !== true, "cleanup authoritative resolution", 90_000);
          }
          break;
        case "notifications": {
          // No fixture or sink can exist before browser capture. Do not create browser effects
          // while cleaning up an earlier GCM refusal; inconsistent ownership remains unresolved.
          if (progress.browser === null) {
            if (progress.notificationTopicDigest !== null || progress.secondaryNotificationTopicDigest !== null) {
              throw new Error("notification ownership has no captured browser baseline");
            }
            break;
          }
          const digests = [progress.notificationTopicDigest, progress.secondaryNotificationTopicDigest].filter((digest): digest is string => digest !== null);
          await page(async driver => {
            // The fixtures are stopped, so the loaded directory drops their Hold and Hide records; wait for that.
            if (digests.length > 0) await driver.evaluate(`(async()=>{
              const owned = ${JSON.stringify(digests)};
              const digest = async tag => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tag)))].map(byte => byte.toString(16).padStart(2,'0')).join('');
              for (const notice of await (await navigator.serviceWorker.ready).getNotifications()) if (owned.includes(await digest(notice.tag))) notice.close();
            })()`);
            if (digests.length > 0) await wait(async () => driver.evaluate<boolean>(`(async()=>{
              const owned = ${JSON.stringify(digests)};
              const digest = async tag => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tag)))].map(byte => byte.toString(16).padStart(2,'0')).join('');
              for (const key of ${JSON.stringify(LOCAL_TRIAGE_KEYS)}) {
                let records;
                try { records = JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return false; }
                if (!Array.isArray(records) || records.length > 1024) return false;
                for (const record of records) {
                  if (!record || typeof record.instanceId !== 'string' ||
                    key.endsWith('.v2') && (typeof record.sourceId !== 'string' || typeof record.sourceOrigin !== 'string')) return false;
                  if (owned.includes(await digest('omp-attention-' + record.instanceId))) return false;
                }
              }
              return true;
            })()`), "owned local triage records cleanup");
            await driver.evaluate(`(async()=>{
              const key=${JSON.stringify(`__push_sink_control_${currentEpoch}`)};
              for(const n of await (await navigator.serviceWorker.ready).getNotifications({tag:key}))n.close();
              localStorage.removeItem(key);sessionStorage.removeItem(key);document.cookie=key+'=;path=/;max-age=0';await caches.delete(key);
              await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(key);request.onsuccess=resolve;request.onerror=reject;request.onblocked=()=>reject(Error('owned sink database is still open'));});
            })()`);
          }, true);
          if (digests.length > 0) await wait(async () => (await readAndroidNotificationRecords(command, packageName!)).every(record => digests.every(digest => !notificationMatchesDigest(record.tag, digest))), "owned notification cleanup");
          break;
        }
        case "browser":
          await runWithRestoration("Android Push browser", async () => {
            if (progress.browser === null) return;
            // Non-granted admission is rejected before permission/subscription mutations.
            if (progress.browser.permission === "granted") await runtime.permission("granted");
            if (progress.browser.permission === "granted" && progress.browser.subscribed) await runtime.detail(progress.browser.detail);
            else if (progress.browser.permission === "granted") await page(async driver => {
              const state = await browserState(driver);
              if (state.subscribed) { await driver.evaluate('document.querySelector("#settings").click();document.querySelector("#notify").click()');
                await wait(async () => !(await browserState(driver)).subscribed, "subscription removal"); }
            }, true);
            await page(async driver => {
              const state = await browserState(driver);
              if (state.subscribed !== progress.browser!.subscribed || state.permission !== progress.browser!.permission ||
                (state.subscribed && state.detail !== progress.browser!.detail)) throw new Error("browser baseline was not restored");
            }, true);
          }, [async () => {
            // A killed driver loses the permission override but may leave its adb listener.
            // Fresh-process cleanup removes only this lane's exact device/socket forwards.
            const selected = await selectDevice();
            const ports = ownedPushForwards(await command("forward", "--list"), selected, resolveAndroidBrowserTarget().devtoolsSocket);
            await runWithRestoration("Android Push debug forwards", () => undefined, ports.map(port => () => mutate("forward", "--remove", port)));
          }]);
          break;
        case "doze": await runtime.doze(false); break;
        case "network": {
          await restoreAndroidRadios(progress.device, command, mutate);
          const after = await runtime.device();
          if (after.wifi !== progress.device.wifi || after.mobile !== progress.device.mobile || after.airplane !== progress.device.airplane) throw new Error("radio baseline was not restored");
          break;
        }
        case "task":
          // Restore the task through ADB only: browser cleanup has already contained CDP.
          if (progress.device.webApkTask) {
            packageName ??= await requireWebApk(command, identity.origin);
            await openWebApk(mutate, packageName);
          } else await runtime.closePwa();
          if (progress.device.locked || !progress.device.awake) await runtime.lock(); else await wake();
          if (progress.device.awake && progress.device.locked) await mutate("shell", "input", "keyevent", "224");
          {
            const after = await runtime.device();
            if (!Object.entries(progress.device).every(([key, value]) => after[key as keyof PushDeviceBaseline] === value)) throw new Error("device baseline was not restored");
          }
          break;
        case "fixture":
          for (const role of ["secondary", "primary"] as const) {
            await runtime.fixture("stop", currentEpoch, role);
            await wait(async () => await snapshot(currentEpoch!, role) === undefined, "fixture unpublication", 45_000);
          }
          break;
      }
    },
  };
  return runtime;
}
