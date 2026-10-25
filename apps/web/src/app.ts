import {
  INSTANCE_ID_PATTERN,
  MAX_FRAME_BYTES,
  MAX_SESSIONS,
  PUSH_API_VERSION,
  parseLaunchResponse,
  parseNotificationData,
  parseNotificationRoute,
  parsePushConfigResponse,
  parsePushSubscriptionRequest,
  parsePushSubscriptionResponse,
  parseSessionEvent,
  parseSessionListResponse,
  type LaunchMode,
  type NotificationLaunchIntent,
  type SessionEvent,
  type SessionMetadata as Metadata,
  type FleetSource,
  type PushDetailLevel,
} from "@omp-session-gateway/protocol";
import type {
  CollabEmbedOptions,
  CollabEmbedState,
} from "../../../packages/collab-client/upstream/src/embed-contract";
import {
  FleetTransport, loadClientConfig, sourceKey, sessionKey, recordKey, recordRef,
  readSourceRecords, boundedJson, SNAPSHOT_BYTES, HELD_KEY, DISMISSED_KEY,
  type SourceKey, type SessionRef, type HeldAsk, type DismissedSession, type SnapshotResult,
} from "./fleet";
import { sourceAvailability as describeSource, scopeCoverage as coverageForSources } from "./availability";
import { createTray, type TrayPanel } from "./tray";
import { SessionCreationController } from "./session-creation";

type SessionMetadata = Metadata & { readonly sourceKey: SourceKey };

type PathHealth = CollabEmbedState["gatewayHealth"];

type StartCollabWithCapability = (
  container: HTMLElement,
  capability: string,
  onDispose: () => void,
  options?: CollabEmbedOptions,
) => () => void;

interface CollabClientModule {
  startCollabWithCapability: StartCollabWithCapability;
}

declare const __COLLAB_CLIENT_MODULE__: string;
declare const __COLLAB_CLIENT_STYLESHEET__: string;

function importCollabClient(moduleUrl: string): Promise<CollabClientModule> {
  return import(moduleUrl) as Promise<CollabClientModule>;
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error("application shell is incomplete");
  return element;
}

const sessionList = requiredElement<HTMLElement>("#session-list");
const emptyState = requiredElement<HTMLElement>("#empty-state");
const statusBanner = requiredElement<HTMLElement>("#status-banner");
const trayHost = requiredElement<HTMLDialogElement>("#tray");
const tray = createTray(trayHost);
const recoveryPanel = requiredElement<HTMLElement>("#recovery-panel");
const notificationButton = requiredElement<HTMLButtonElement>("#notify");
const notificationDisclosure = requiredElement<HTMLElement>("#notify-note");
const directoryTitle = requiredElement<HTMLElement>("#directory-title");
const directoryCount = requiredElement<HTMLElement>("#directory-count");
const hostPicker = requiredElement<HTMLSelectElement>("#host-picker");
const hostPickerLabel = requiredElement<HTMLElement>("#host-picker-label");
const fleetStatus = requiredElement<HTMLElement>("#fleet-status");
const alertScope = requiredElement<HTMLElement>("#alert-scope");
const alertsPanel = requiredElement<HTMLElement>("#alerts-panel");
const detailPanel = requiredElement<HTMLElement>("#detail-panel");
const alertDetailButton = requiredElement<HTMLButtonElement>("#alert-detail");
const settingsButton = requiredElement<HTMLButtonElement>("#settings");
const notificationDetailOptions = requiredElement<HTMLFieldSetElement>("#notification-detail-options");
const undoPanel = requiredElement<HTMLElement>("#undo-panel");
const undoCopy = requiredElement<HTMLElement>("#undo-copy");
const undoButton = requiredElement<HTMLButtonElement>("#undo-dismissal");
const notificationDetailInputs = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="notification-detail"]'),
];

const EVENT_LIVENESS_TIMEOUT_MS = 12_000;
const SNAPSHOT_TIMEOUT_MS = 4_000;
const RECOVERY_SNAPSHOT_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const CONNECTION_EXTENDED_MS = 3_000;
const CONNECTION_RECOVERED_MS = 1_800;
const TRANSPORT_GUIDANCE_DELAY_MS = 45_000;
const LOCAL_ACTION_UNDO_MS = 5_000;
const HELD_ASKS_STORAGE_KEY = HELD_KEY;
const DISMISSED_SESSIONS_STORAGE_KEY = DISMISSED_KEY;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const FIRST_RUN_KEY = "omp.sessions.first-run.v1";
const firstRunEntry = location.pathname === "/";
type FirstRunStep = "connected" | "alerts" | "modes" | "done";
let firstRunStarted = false;
type TransportFailureKind = "offline" | "tailnet" | "desktop" | "gateway";

type LaunchPresentation = "full" | "request-tray";

const localSource = { id: "local", label: "This host", origin: location.origin } satisfies FleetSource;
const localKey = sourceKey(localSource);
const sources = new Map<SourceKey, FleetSource>([[localKey, localSource]]);
const remotes = new Map<SourceKey, FleetTransport>();
const remoteLaunchFailures = new Map<SourceKey, string>();
let selectedScope: SourceKey | "all" = "all";
let browserRecognitionEnabled = false;
let fleetBootstrapFailed = false;
let localFresh = false;
const observedAsks = new Map<string, number>();
const sessions = new Map<string, SessionMetadata>();
let heldAsks = new Map<string, HeldAsk>();
let dismissedSessions = new Map<string, DismissedSession>();
let events: EventSource | undefined;
let directoryLoaded = false;
let authorizationDenied = false;
let localObservationWithdrawn = false;
let notificationState: NotificationControlState = "checking";
let directoryEpoch = 0;
let directoryRevision = -1;
let snapshotController: AbortController | undefined;
let eventLivenessTimeout: number | undefined;
let eventStreamStale = false;
let reconnectTimeout: number | undefined;
let lastFreshAt: number | undefined;
let reconnectAttempt = 0;
let transportFailureSince: number | undefined;
let transportFailureKind: TransportFailureKind | undefined;
let transportGuidanceTimeout: number | undefined;
let notificationRegistration: ServiceWorkerRegistration | undefined;
let applicationServerKey: string | undefined;
interface LaunchAttempt {
  readonly id: number;
  readonly epoch: number;
  readonly ref: SessionRef;
  readonly mode: LaunchMode;
  readonly presentation: LaunchPresentation;
  readonly creationHandoff: boolean;
  readonly scope: SourceKey | "all";
  readonly sourceEpoch: number | undefined;
  readonly controller: AbortController;
  deadline?: number;
  settled: boolean;
}
let launchSequence = 0;
let selectionEpoch = 0;
let pendingLaunch: LaunchAttempt | undefined;
let workerUpdatePending = false;
let updateReloadTimeout: number | undefined;
let pendingDismissUndo: SessionRef | undefined;

type NotificationControlState =
  | "checking"
  | "idle"
  | "enabling"
  | "disabling"
  | "enabled"
  | "blocked"
  | "unavailable";

interface DirectoryHistoryState {
  readonly version: 2;
  readonly scope: SourceKey | "all";
  readonly order: readonly SessionRef[];
  readonly scrollY: number;
}

interface DashboardSnapshot {
  readonly children: readonly HTMLElement[];
  readonly scrollY: number;
  readonly title: string;
  readonly bodyClass: string;
  readonly historyState: DirectoryHistoryState;
  /** The list signature the cached rows show, so the first refresh after a return animates only real changes. */
  readonly signature: string | undefined;
}

interface ActiveCollabShell extends SessionRef {
  readonly scope: SourceKey | "all";
  readonly openedRequestId?: string;
  readonly mode: LaunchMode;
  presentation: LaunchPresentation;
  readonly connectionChip: HTMLElement;
  readonly triageBar: HTMLElement;
  readonly shell: HTMLElement;
  answerShown: boolean;
  answerTriageVisible: boolean;
  triageTimeout?: number;
  hasBeenLive: boolean;
  latestEmbedState?: CollabEmbedState;
  outagePath?: "gateway" | "relay";
  interruptionStartedAt?: number;
  connectionDelayTimeout?: number;
  connectionTickTimeout?: number;
  recoveredTimeout?: number;
}

interface DisposedShellResume extends SessionRef {
  readonly scope: SourceKey | "all";
  readonly mode: LaunchMode;
  readonly presentation: LaunchPresentation;
  readonly requestId?: string;
}

let dashboardSnapshot: DashboardSnapshot | undefined;
let activeCollabShell: ActiveCollabShell | undefined;
let disposeActiveCollab: (() => void) | undefined;
/**
 * `pagehide` disposes the collab client and drops its capability with it, but the shell DOM, the
 * `/client/` URL, and the document itself all survive into the bfcache. A restore of that entry is
 * an inert shell, so it can never be reconnected behind dead DOM, and never by restarting a client
 * whose capability is gone: the restore rebuilds the directory first and then relaunches from it.
 */
let collabShellDisposedOnPageHide = false;
/**
 * Which session the disposed shell was showing, so a restore can reopen it rather than stranding the
 * user in the directory (issue #198). Only a page that entered the bfcache gets here: backgrounding
 * an iPhone Home Screen app fires no `pagehide` (iOS 26.5 and 26.6 on real devices), so that page
 * and its client simply stay alive, and nothing may tear the client down on `visibilitychange`.
 *
 * This is a launch intent, never a capability. It holds only what the directory already publishes,
 * and the resume re-runs the ordinary launch fetch, so the capability is acquired fresh from OMP at
 * resume time exactly as at first launch. The bfcache preserves this heap; storage is not involved.
 */
let disposedShellResume: DisposedShellResume | undefined;
let currentNotificationDetail: PushDetailLevel = "session";

let initialPromptDraft: { ref: SessionRef; text: string } | undefined;
const sameBinding = (left: SessionRef, right: SessionRef): boolean =>
  left.sourceKey === right.sourceKey && left.instanceId === right.instanceId && left.generation === right.generation;
function clearCreationDraft(key?: SourceKey): void {
  if (key === undefined || initialPromptDraft?.ref.sourceKey === key) initialPromptDraft = undefined;
}
const creation = new SessionCreationController({
  tray,
  sources: () => [...sources.values()],
  scope: () => selectedScope,
  epoch: () => selectionEpoch,
  authoritative: () => !fleetBootstrapFailed,
  discardDraft: () => clearCreationDraft(),
  cancelOpening: () => cancelLaunch(),
  forbidden: source => {
    const key = sourceKey(source);
    clearCreationDraft(key);
    if (key !== localKey) { remotes.get(key)?.forbid(); return; }
    withdrawLocalAuthorization();
  },
  refresh: source => sourceKey(source) === localKey ? refreshAndConnect() : remotes.get(sourceKey(source))!.refresh(true),
  openReady: async (source, binding, draft, current) => {
    const key = sourceKey(source);
    if (!current() || sources.get(key) !== source || activeCollabShell !== undefined || pendingLaunch !== undefined) return false;
    const ref: SessionRef = { sourceKey: key, ...binding };
    if (initialPromptDraft !== undefined && !sameBinding(initialPromptDraft.ref, ref)) clearCreationDraft();
    const refreshed = key === localKey ? await refreshAndConnect() : await remotes.get(key)?.refresh(true) === "healthy";
    if (!refreshed || !current() || sources.get(key) !== source || activeCollabShell !== undefined || pendingLaunch !== undefined) return false;
    const session = sessions.get(sessionKey(ref));
    if (session === undefined || session.generation !== binding.generation || !session.canControl || !sourceFresh(key)) return false;
    if (draft !== "") initialPromptDraft = { ref, text: draft };
    return await launch(session, "control", undefined, undefined, selectedScope, "full", true);
  },
});

const notificationLabels: Readonly<Record<NotificationControlState, string>> = {
  checking: "Checking background alerts…",
  idle: "Enable background alerts",
  enabling: "Enabling…",
  disabling: "Disabling…",
  enabled: "Disable background alerts",
  blocked: "Notifications blocked",
  unavailable: "Background alerts unavailable",
};

function setNotificationControl(state: NotificationControlState): void {
  const changed = notificationState !== state;
  notificationState = state;
  notificationButton.dataset.state = state;
  notificationButton.textContent = notificationLabels[state];
  notificationButton.disabled =
    state === "checking" ||
    state === "enabling" ||
    state === "disabling" ||
    state === "blocked" ||
    state === "unavailable";
  notificationDetailOptions.hidden = state !== "enabled";
  alertDetailButton.hidden = state !== "enabled";
  notificationDisclosure.textContent =
    state === "blocked"
      ? "Notifications are blocked. Enable them in this site's browser settings."
      : state === "unavailable"
        ? "Background push is not available in this browser profile. On iPhone and iPad it needs OMP Sessions added to the Home Screen."
        : "Alerts work with the app closed for input requests or activity stops. After revalidation, requests open Control; activity stops open View.";
  notificationDisclosure.hidden = state === "enabled";
  // The all-clear surface repeats the alert promise, so it re-renders with the control state.
  if (changed) render();
  if (tray.id === "alerts" || tray.id === "first-run-alerts") tray.refresh();
}

function openAlerts(): void {
  if (creation.isActive) cancelLaunch();
  creation.cancel("competing");
  tray.open({ id: "alerts", title: "Background alerts", tone: "neutral", body: alertsPanel });
}

/** A missing record is fresh; malformed or inaccessible storage never forces an introduction. */
function readFirstRunStep(): FirstRunStep {
  try {
    const text = localStorage.getItem(FIRST_RUN_KEY);
    if (text === null) return "connected";
    if (text.length > 128) return "done";
    const record: unknown = JSON.parse(text);
    if (record === null || typeof record !== "object" || Array.isArray(record)) return "done";
    const value = record as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || value.version !== 1 || typeof value.step !== "string" ||
      !["alerts", "modes", "done"].includes(value.step) ||
      typeof value.updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.updatedAt) ||
      new Date(value.updatedAt).toISOString() !== value.updatedAt) return "done";
    return value.step as FirstRunStep;
  } catch { return "done"; }
}

function writeFirstRunStep(step: FirstRunStep): void {
  try {
    // Connected has no persisted record: returning to it is a fresh, skippable introduction.
    if (step === "connected") localStorage.removeItem(FIRST_RUN_KEY);
    else localStorage.setItem(FIRST_RUN_KEY, JSON.stringify({ version: 1, step, updatedAt: new Date().toISOString() }));
  } catch { /* This document still remembers completion when storage is unavailable. */ }
}

function firstRunPanel(step: Exclude<FirstRunStep, "done">): TrayPanel {
  const body = document.createElement("div");
  body.className = `first-run-body first-run-${step}`;
  const next = document.createElement("button");
  next.type = "button";
  next.className = "first-run-next";
  next.textContent = step === "modes" ? "Done" : "Next";
  const advance = (): void => {
    if (step === "modes") tray.close();
    else tray.push(firstRunPanel(step === "connected" ? "alerts" : "modes"));
  };
  next.addEventListener("click", advance);
  if (step === "connected") {
    const mark = requiredElement<SVGElement>("#gateway-mark").cloneNode(true) as SVGElement;
    mark.removeAttribute("id");
    mark.setAttribute("width", "32");
    mark.setAttribute("height", "32");
    const count = scopedSessions().filter(session => sourceFresh(session.sourceKey)).length;
    body.append(mark, createTextElement("p", "first-run-copy",
      `This phone is on your tailnet. ${count === 0 ? "No live sessions are listed yet" : `${count} live session${count === 1 ? " is" : "s are"} listed across the checked hosts`}.`),
    createTextElement("p", "first-run-note", "Capabilities are requested only when you tap an action."));
  } else if (step === "alerts") {
    const notNow = document.createElement("button");
    notNow.type = "button";
    notNow.className = "first-run-not-now";
    notNow.textContent = "Not now";
    notNow.addEventListener("click", advance);
    body.append(alertsPanel, notNow);
  } else {
    for (const [label, glyph, copy] of [
      ["View", "◉", "Watch a session live. Nothing you do reaches it."],
      ["Control", "›", "Answer requests and send prompts. Opens only when you tap it."],
    ]) {
      const row = document.createElement("div");
      row.className = "first-run-mode";
      const icon = createTextElement("span", "first-run-glyph", glyph!);
      icon.setAttribute("aria-hidden", "true");
      const text = document.createElement("div");
      text.append(createTextElement("h3", "", label!), createTextElement("p", "", copy!));
      row.append(icon, text);
      body.append(row);
    }
  }
  return {
    id: `first-run-${step}`,
    title: step === "connected" ? "Connected" : step === "alerts" ? "Background alerts" : "View or Control",
    tone: "neutral", body, actions: [next],
    ...(step === "connected" ? { leadingLabel: "Skip introduction" } : {}),
    onShow: () => writeFirstRunStep(step),
  };
}

function maybeStartFirstRun(): void {
  if (!firstRunEntry || firstRunStarted || !directoryLoaded || !localFresh || location.pathname !== "/" ||
    document.visibilityState !== "visible" || trayHost.open || activeCollabShell !== undefined ||
    pendingLaunch !== undefined || pendingNotificationRoute || navigationTransition !== undefined) return;
  const step = readFirstRunStep();
  if (step === "done") return;
  firstRunStarted = true;
  const parents = step === "connected" ? [] : [firstRunPanel("connected")];
  if (step === "modes") parents.push(firstRunPanel("alerts"));
  tray.open(firstRunPanel(step), { parents, onClose: () => writeFirstRunStep("done") });
}

function isNotificationSupportResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("version") &&
    record.type === "omp-notification-support-response" &&
    record.version === PUSH_API_VERSION
  );
}

async function checkNotificationWorker(registration: ServiceWorkerRegistration): Promise<boolean> {
  const active = registration.active;
  if (active === null) return false;
  const channel = new MessageChannel();
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const finish = (supported: boolean): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    channel.port1.close();
    try {
      channel.port2.close();
    } catch {
      // The worker may already own the transferred port.
    }
    resolve(supported);
  };
  const timeout = window.setTimeout(() => finish(false), 2_000);
  channel.port1.onmessage = event => finish(isNotificationSupportResponse(event.data));
  channel.port1.start();
  try {
    active.postMessage({ type: "omp-notification-support-request", version: PUSH_API_VERSION }, [channel.port2]);
  } catch {
    finish(false);
  }
  return promise;
}

async function savePushSubscription(
  subscription: PushSubscription,
  detailLevel?: PushDetailLevel,
): Promise<PushDetailLevel> {
  const request = parsePushSubscriptionRequest({
    version: PUSH_API_VERSION,
    ...(detailLevel === undefined ? {} : { detailLevel }),
    subscription: subscription.toJSON(),
  });
  const response = await fetch("/api/v1/push/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("push subscription was rejected");
  return parsePushSubscriptionResponse(await response.json()).detailLevel;
}

function selectNotificationDetail(detailLevel: PushDetailLevel): void {
  currentNotificationDetail = detailLevel;
  for (const input of notificationDetailInputs) input.checked = input.value === detailLevel;
  alertDetailButton.textContent = `Alert detail · ${detailLevel[0]!.toUpperCase()}${detailLevel.slice(1)} ›`;
}

function clearUpdateReloadTimeout(): void {
  if (updateReloadTimeout === undefined) return;
  window.clearTimeout(updateReloadTimeout);
  updateReloadTimeout = undefined;
}

/** ADR-018's bounded fallback: reload only an idle directory, never a pending or mounted launch. */
function applyActivatedWorkerUpdate(): void {
  clearUpdateReloadTimeout();
  if (
    !workerUpdatePending ||
    creation.isActive ||
    pendingLaunch !== undefined ||
    pendingNotificationRoute ||
    activeCollabShell !== undefined ||
    location.pathname === "/client/"
  ) {
    return;
  }
  workerUpdatePending = false;
  location.reload();
}

function isNotificationRouteRequest(value: unknown): value is { readonly data: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 3 &&
    keys.includes("type") &&
    keys.includes("version") &&
    keys.includes("data") &&
    record.type === "omp-notification-route" &&
    record.version === PUSH_API_VERSION
  );
}

/**
 * The worker hands a tapped notification to this page instead of navigating it, so a live
 * collaboration is never reloaded. The intent takes the same path as a routed load: fresh directory
 * metadata, exact generation or request, then an in-place launch.
 */
function acceptNotificationRoute(event: MessageEvent): void {
  if (!isNotificationRouteRequest(event.data)) return;
  const intent = parseNotificationData(event.data.data);
  if (intent === undefined) return;
  event.ports[0]?.postMessage({ type: "omp-notification-route-accepted", version: PUSH_API_VERSION });
  selectionEpoch += 1;
  creation.cancel("competing");
  clearCreationDraft();
  cancelLaunch();
  pendingNotificationLaunch = intent;
  pendingNotificationRoute = true;
  notificationRouteStatusLocked = true;
  void refreshAndConnect();
}

async function initializeApplicationWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!isSecureContext || !("serviceWorker" in navigator)) return undefined;
  const serviceWorker = navigator.serviceWorker;
  serviceWorker.addEventListener("message", acceptNotificationRoute);
  serviceWorker.startMessages();
  let currentController = serviceWorker.controller;
  serviceWorker.addEventListener("controllerchange", () => {
    const nextController = serviceWorker.controller;
    if (currentController === null) {
      currentController = nextController;
      return;
    }
    if (nextController === currentController) return;
    currentController = nextController;
    workerUpdatePending = true;
    clearUpdateReloadTimeout();
    updateReloadTimeout = window.setTimeout(applyActivatedWorkerUpdate, 1_000);
  });
  try {
    return await serviceWorker.register("/service-worker.js", { scope: "/" });
  } catch {
    return undefined;
  }
}

async function initializeNotifications(
  workerRegistration: Promise<ServiceWorkerRegistration | undefined>,
): Promise<void> {
  setNotificationControl("checking");
  if (
    !isSecureContext ||
    typeof Notification === "undefined" ||
    typeof PushManager === "undefined"
  ) {
    setNotificationControl("unavailable");
    return;
  }
  try {
    const [registered, configResponse] = await Promise.all([
      workerRegistration,
      fetch("/api/v1/push/config", { cache: "no-store", credentials: "same-origin" }),
    ]);
    if (registered === undefined) {
      setNotificationControl("unavailable");
      return;
    }
    const registration = registered.active === null ? await navigator.serviceWorker.ready : registered;
    if (
      !configResponse.ok ||
      typeof registration.showNotification !== "function" ||
      !(await checkNotificationWorker(registration))
    ) {
      setNotificationControl("unavailable");
      return;
    }
    const config = parsePushConfigResponse(await configResponse.json());
    notificationRegistration = registration;
    applicationServerKey = config.applicationServerKey;
    if (Notification.permission === "denied") {
      setNotificationControl("blocked");
      return;
    }
    const existing = await registration.pushManager.getSubscription();
    if (existing === null) {
      setNotificationControl("idle");
      return;
    }
    selectNotificationDetail(await savePushSubscription(existing));
    setNotificationControl("enabled");
  } catch {
    setNotificationControl("unavailable");
  }
}

async function disableBackgroundNotifications(): Promise<void> {
  const registration = notificationRegistration;
  if (registration === undefined) return;
  const existing = await registration.pushManager.getSubscription();
  if (existing === null) {
    setNotificationControl("idle");
    return;
  }
  setNotificationControl("disabling");
  const endpoint = existing.endpoint;
  try {
    await existing.unsubscribe();
    await fetch("/api/v1/push/subscription", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: PUSH_API_VERSION, endpoint }),
      cache: "no-store",
      credentials: "same-origin",
    });
    setNotificationControl("idle");
  } catch {
    setNotificationControl("unavailable");
  }
}

/** The toggle lives inside the Settings sheet: idle enables, enabled disables in place. */
async function toggleBackgroundNotifications(): Promise<void> {
  if (notificationState === "enabled") {
    await disableBackgroundNotifications();
    return;
  }
  const registration = notificationRegistration;
  const publicKey = applicationServerKey;
  if (registration === undefined || publicKey === undefined) return;

  setNotificationControl("enabling");
  try {
    const permission =
      Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      setNotificationControl(permission === "denied" ? "blocked" : "idle");
      return;
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    });
    try {
      selectNotificationDetail(await savePushSubscription(subscription, "session"));
    } catch (error) {
      await subscription.unsubscribe().catch(() => false);
      throw error;
    }
    setNotificationControl("enabled");
  } catch {
    setNotificationControl(Notification.permission === "denied" ? "blocked" : "unavailable");
  }
}

function readPendingNotificationLaunch(): NotificationLaunchIntent | undefined {
  const intent = parseNotificationRoute(new URL(location.href));
  if (location.pathname === "/collab" || location.pathname.startsWith("/collab/")) {
    history.replaceState(null, "", "/");
  }
  return intent;
}

let pendingNotificationRoute = location.pathname === "/collab" || location.pathname.startsWith("/collab/");
let notificationRouteStatusLocked = pendingNotificationRoute;
let pendingNotificationLaunch = readPendingNotificationLaunch();

if (location.pathname === "/update/" || location.pathname === "/client/") {
  history.replaceState(null, "", "/");
}

type StatusKind = "ready" | "offline" | "tailnet" | "desktop" | "gateway" | "configuration" | "unauthorized" | "expired" | "loading";

function writeBanner(kind: StatusKind, content: HTMLElement): void {
  statusBanner.dataset.kind = kind;
  statusBanner.replaceChildren(content);
  statusBanner.hidden = kind === "ready";
}

function setStatus(kind: StatusKind, message: string): void {
  // Presentation changes are not evidence that the local connection recovered.
  if (kind !== "unauthorized" && (authorizationDenied || transportFailureKind !== undefined)) return;
  const content = createTextElement("span", "status-copy", message);
  if (kind === "ready" && fleetBootstrapFailed) {
    kind = "configuration";
    content.append(
      createTextElement("strong", "status-title", "Fleet configuration unavailable"),
      createTextElement("span", "status-detail", "The local list is available. Try again to check the configured hosts."),
    );
    const retry = createTextElement("button", "status-action", "Try again");
    retry.addEventListener("click", () => void refreshAndConnect());
    content.append(retry);
  }
  writeBanner(kind, content);
}

function parseDirectoryHistoryState(value: unknown): DirectoryHistoryState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const directory = (value as Record<string, unknown>).ompDirectory;
  if (typeof directory !== "object" || directory === null || Array.isArray(directory)) return undefined;
  const record = directory as Record<string, unknown>;
  if (
    !Array.isArray(record.order) ||
    record.order.length > MAX_SESSIONS * sources.size ||
    typeof record.scrollY !== "number" ||
    !Number.isFinite(record.scrollY) ||
    record.scrollY < 0
  ) {
    return undefined;
  }
  const order: SessionRef[] = [];
  for (const item of record.order) {
    if (record.version === undefined && typeof item === "string" && INSTANCE_ID_PATTERN.test(item)) {
      const session = sessions.get(sessionKey({ sourceKey: localKey, instanceId: item }));
      if (session !== undefined) order.push({ sourceKey: localKey, instanceId: item, generation: session.generation });
    } else if (record.version === 2 && typeof item === "object" && item !== null &&
      typeof item.sourceKey === "string" && sources.has(item.sourceKey) &&
      typeof item.instanceId === "string" && INSTANCE_ID_PATTERN.test(item.instanceId) &&
      Number.isSafeInteger(item.generation) && item.generation > 0) {
      order.push({ sourceKey: item.sourceKey, instanceId: item.instanceId, generation: item.generation });
    } else return undefined;
  }
  return { version: 2, scope: typeof record.scope === "string" && sources.has(record.scope) ? record.scope : "all", order, scrollY: record.scrollY };
}

function resetTransportGuidance(): void {
  if (transportGuidanceTimeout !== undefined) {
    window.clearTimeout(transportGuidanceTimeout);
    transportGuidanceTimeout = undefined;
  }
  transportFailureSince = undefined;
  if (tray.id === "recovery") tray.close();
}

function clearLocalTransportFailure(): void {
  resetTransportGuidance();
  transportFailureKind = undefined;
}

function transportGuidanceVisible(kind: TransportFailureKind): boolean {
  return (
    kind !== "offline" &&
    transportFailureSince !== undefined &&
    Date.now() - transportFailureSince >= TRANSPORT_GUIDANCE_DELAY_MS &&
    document.visibilityState === "visible"
  );
}

function scheduleTransportGuidance(): void {
  if (transportFailureSince === undefined || transportGuidanceTimeout !== undefined) return;
  const remaining = TRANSPORT_GUIDANCE_DELAY_MS - (Date.now() - transportFailureSince);
  if (remaining <= 0) return;
  transportGuidanceTimeout = window.setTimeout(() => {
    transportGuidanceTimeout = undefined;
    const kind = transportFailureKind;
    if (kind !== undefined && document.visibilityState === "visible") showTransportFailure(kind);
  }, remaining);
}
function showTransportFailure(kind: TransportFailureKind): void {
  const tracksVisibleFailure = kind !== "offline" && document.visibilityState === "visible";
  if (tracksVisibleFailure) {
    if (transportFailureSince === undefined) transportFailureSince = Date.now();
    transportFailureKind = kind;
  } else {
    resetTransportGuidance();
  }
  transportFailureKind = kind;
  directoryRevision = -1;
  render();
  const freshness = sourceAvailability(localKey);
  const asOf = freshness.time;
  const listCopy = asOf === undefined ? freshness.copy
    : sources.size > 1 ? `${localSource.label}: ${freshness.copy}`
      : `Showing the list as of ${asOf}.`;
  const copy: Record<TransportFailureKind, readonly [string, string]> = {
    offline: [
      "You're offline",
      `This device has no connection. ${listCopy} Retries automatically.`,
    ],
    tailnet: [
      "Tailnet unreachable",
      "This device is online, but your tailnet isn't answering. Check that Tailscale is connected.",
    ],
    desktop: [
      "Desktop unreachable",
      `The desktop isn't answering. Check that it is awake and the gateway is running. ${listCopy}`,
    ],
    gateway: [
      "Gateway unavailable",
      sources.size === 1 && asOf !== undefined
        ? `Live updates paused; showing the list as of ${asOf}. Reconnects automatically.`
        : `Live updates paused. ${listCopy} Reconnects automatically.`,
    ],
  };
  const [title, body] = copy[kind];
  const text = document.createElement("span");
  text.className = "status-copy";
  text.append(
    createTextElement("strong", "status-title", title),
    createTextElement("span", "status-detail", body),
  );
  if (kind === "tailnet") {
    text.append(createTextElement("span", "status-freshness", listCopy));
  }

  const extended = transportGuidanceVisible(kind);
  if (extended) {
    text.append(
      createTextElement(
        "span",
        "status-guidance",
        "Still unreachable? The browser may be stuck after sleep or a network change. Fully close the browser hosting OMP Sessions, then reopen OMP Sessions.",
      ),
    );
  }

  if (kind === "desktop" || extended) {
    const actions = document.createElement("span");
    actions.className = "status-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "status-action";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => void refreshAndConnect());
    actions.append(retry);
    if (extended) {
      const troubleshooting = document.createElement("button");
      troubleshooting.type = "button";
      troubleshooting.className = "status-action";
      troubleshooting.textContent = "Troubleshooting";
      troubleshooting.addEventListener("click", () => {
        if (creation.isActive) cancelLaunch();
        creation.cancel("competing");
        tray.open({ id: "recovery", title: "Troubleshooting", tone: "neutral", body: recoveryPanel });
      });
      actions.append(troubleshooting);
    }
    text.append(actions);
  }
  writeBanner(kind, text);
  if (tracksVisibleFailure) scheduleTransportGuidance();
}

function clearEventLiveness(): void {
  if (eventLivenessTimeout === undefined) return;
  window.clearTimeout(eventLivenessTimeout);
  eventLivenessTimeout = undefined;
}

function clearReconnectTimeout(): void {
  if (reconnectTimeout === undefined) return;
  window.clearTimeout(reconnectTimeout);
  reconnectTimeout = undefined;
}

/**
 * True only when the event stream has demonstrably been heard from inside the liveness window.
 *
 * Neither `events !== undefined` nor `eventStreamStale` survives a freeze. Chrome freezes the
 * renderer while the display is off, so a page that resumes still holds an `EventSource` that
 * reports open and a liveness timeout that never ran, however long the stream has been dead.
 * Wall-clock freshness is the one signal a frozen page cannot have faked.
 */
function directoryStreamIsLive(): boolean {
  if (events === undefined || eventStreamStale || lastFreshAt === undefined) return false;
  return Date.now() - lastFreshAt < EVENT_LIVENESS_TIMEOUT_MS;
}

function scheduleReconnect(): void {
  if (authorizationDenied || reconnectTimeout !== undefined) return;
  const exponent = Math.min(reconnectAttempt, 5);
  const cap = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS);
  const floor = Math.floor(cap / 2);
  const delay = floor + Math.floor(Math.random() * (cap - floor));
  reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
  reconnectTimeout = window.setTimeout(() => {
    reconnectTimeout = undefined;
    void refreshAndConnect(false);
  }, delay);
}
function markEventStreamInterrupted(source: EventSource, epoch: number): boolean {
  if (events !== source || epoch !== directoryEpoch) return false;
  localFresh = false;
  clearEventLiveness();
  eventStreamStale = true;
  render();
  showTransportFailure(navigator.onLine === false ? "offline" : "gateway");
  scheduleReconnect();
  return true;
}

function failEventStream(source: EventSource, epoch: number): void {
  if (!markEventStreamInterrupted(source, epoch)) return;
  source.close();
  events = undefined;
}

function armEventLiveness(source: EventSource, epoch: number): void {
  clearEventLiveness();
  eventLivenessTimeout = window.setTimeout(() => {
    eventLivenessTimeout = undefined;
    failEventStream(source, epoch);
  }, EVENT_LIVENESS_TIMEOUT_MS);
}


function sessionTitle(session: SessionMetadata): string {
  return session.title || session.cwdLabel || "OMP session";
}

/** Nerd Font icons (Private Use Area) in OMP titles. Tern lifts a leading icon into a tile beside the title; so does the directory. */
const GLYPH_RUN_PATTERN = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+/gu;
const LEADING_GLYPH_PATTERN = /^[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+ ?/u;

type SessionTileState = "working" | "idle" | "unknown" | "waiting" | "held";

/** Text with every icon run spoken as a space; empty when the label was icons only. */
function spokenText(value: string): string {
  return value.replace(GLYPH_RUN_PATTERN, " ").replace(/\s+/gu, " ").trim();
}

/** The title text after its leading icon; the icon belongs to the tile. */
function titleText(session: SessionMetadata): string {
  return sessionTitle(session).replace(LEADING_GLYPH_PATTERN, "") || spokenText(session.cwdLabel ?? "") || "OMP session";
}

/** Icon tile: the title's leading Nerd Font icon, else a monogram, with the session's state as a badge. */
function createSessionTile(session: SessionMetadata, state?: SessionTileState): HTMLElement {
  const tile = createTextElement("span", "session-tile", "");
  tile.setAttribute("aria-hidden", "true");
  // One icon cell only: a host-controlled run of icons never grows past the tile.
  const icon = [...(LEADING_GLYPH_PATTERN.exec(sessionTitle(session))?.[0] ?? "")][0];
  tile.append(icon === undefined
    ? createTextElement("span", "tile-monogram", [...titleText(session)][0]?.toLocaleUpperCase() ?? "")
    : createTextElement("span", "glyph", icon));
  if (state !== undefined) tile.dataset.state = sourceFresh(session.sourceKey) ? state : "unknown";
  return tile;
}

/** Renders the title text; any icon run inside it still draws as an icon cell with a terminal's padding space folded into the cell gap. */
function createTitleElement(tagName: string, className: string, session: SessionMetadata): HTMLElement {
  const element = createTextElement(tagName, className, "");
  const title = titleText(session);
  let index = 0;
  for (const match of title.matchAll(GLYPH_RUN_PATTERN)) {
    if (match.index > index) element.append(title.slice(index, match.index));
    const glyph = createTextElement("span", "glyph", match[0]);
    glyph.setAttribute("aria-hidden", "true");
    element.append(glyph);
    index = match.index + match[0].length;
    if (title[index] === " ") index += 1;
  }
  if (index < title.length) element.append(title.slice(index));
  return element;
}

/** The title for accessible names, the document title, and other surfaces that cannot draw icon cells. */
function spokenTitle(session: SessionMetadata): string {
  return spokenText(sessionTitle(session)) || spokenText(session.cwdLabel ?? "") || "OMP session";
}

function activityState(session: SessionMetadata): SessionTileState {
  return session.busy === true ? "working" : session.busy === false ? "idle" : "unknown";
}

/** Host names only discriminate when more than one host is in view. */
function hostVisible(): boolean {
  return sources.size > 1 && selectedScope === "all";
}

function localRecordKey(ref: Pick<SessionRef, "sourceKey" | "instanceId">, suffix: string | number): string {
  return `${sessionKey(ref)}\0${suffix}`;
}

function writeLocalRecords(key: string, records: Iterable<HeldAsk | DismissedSession>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify([...records]));
  } catch {
    // Local routing state is optional; keep the live in-memory decision for this page.
  }
}

function setBoundedLocalRecord<RecordType>(map: Map<string, RecordType>, key: string, record: RecordType): void {
  map.delete(key);
  map.set(key, record);
  while (map.size > MAX_SESSIONS) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function isHeld(session: SessionMetadata): boolean {
  return (
    session.inputRequired &&
    session.ask !== undefined &&
    heldAsks.has(localRecordKey(session, session.ask.requestId))
  );
}

function isDismissed(session: SessionMetadata): boolean {
  return (
    !session.inputRequired &&
    dismissedSessions.has(localRecordKey(session, session.generation))
  );
}

function cancelPendingDismissUndo(): void {
  pendingDismissUndo = undefined;
  if (tray.id === "undo") tray.close(true, true);
}

function reconcileLocalRecords(authority: SourceKey = localKey): void {
  let heldChanged = false;
  for (const [key, held] of heldAsks) {
    const ref = recordRef(held);
    if (ref.sourceKey !== authority) continue;
    const session = sessions.get(sessionKey(ref));
    if (!session?.inputRequired || session.ask?.requestId !== held.requestId) {
      heldAsks.delete(key);
      heldChanged = true;
    }
  }
  let dismissedChanged = false;
  for (const [key, dismissed] of dismissedSessions) {
    const ref = recordRef(dismissed);
    if (ref.sourceKey !== authority) continue;
    const session = sessions.get(sessionKey(ref));
    if (
      session === undefined ||
      session.generation !== dismissed.generation ||
      session.inputRequired
    ) {
      dismissedSessions.delete(key);
      dismissedChanged = true;
    }
  }
  if (heldChanged) writeLocalRecords(HELD_ASKS_STORAGE_KEY, heldAsks.values());
  if (dismissedChanged) writeLocalRecords(DISMISSED_SESSIONS_STORAGE_KEY, dismissedSessions.values());

  if (pendingDismissUndo !== undefined && pendingDismissUndo.sourceKey === authority) {
    const session = sessions.get(sessionKey(pendingDismissUndo));
    if (
      session === undefined ||
      session.generation !== pendingDismissUndo.generation ||
      session.inputRequired
    ) {
      cancelPendingDismissUndo();
    }
  }
}

function replaceSessionSnapshot(nextSessions: readonly Metadata[], authority: SourceKey = localKey, fresh = true): void {
  for (const [key, session] of sessions) {
    if (session.sourceKey === authority) sessions.delete(key);
  }
  for (const metadata of nextSessions) {
    const session = { ...metadata, sourceKey: authority };
    sessions.set(sessionKey(session), session);
    observeAsk(session);
  }
  if (fresh) reconcileLocalRecords(authority);
  const currentAsks = new Set([...sessions.values()].flatMap(session =>
    session.ask === undefined ? [] : [localRecordKey(session, session.ask.requestId)]));
  for (const key of observedAsks.keys()) if (!currentAsks.has(key)) observedAsks.delete(key);
}

function observeAsk(session: SessionMetadata): void {
  if (session.ask === undefined) return;
  const key = localRecordKey(session, session.ask.requestId);
  if (!observedAsks.has(key)) observedAsks.set(key, Date.now());
}

function scopedSessions(scope = selectedScope): SessionMetadata[] {
  return [...sessions.values()].filter(session => scope === "all" || session.sourceKey === scope);
}

function sourceFresh(key: SourceKey): boolean {
  return key === localKey ? localFresh && !authorizationDenied && !localObservationWithdrawn : remotes.get(key)?.status === "fresh";
}

function sourceAvailability(key: SourceKey) {
  if (key !== localKey) {
    const remote = remotes.get(key);
    return describeSource(remote?.status ?? "unavailable", remote?.freshAt);
  }
  return describeSource(
    authorizationDenied ? "forbidden" : localObservationWithdrawn ? "withdrawn" : localFresh ? "fresh"
      : transportFailureKind !== undefined ? directoryLoaded ? "stale" : "unavailable"
        : directoryLoaded ? "refreshing" : "loading",
    lastFreshAt,
  );
}

function scopeCoverage(scope = selectedScope) {
  return coverageForSources(
    [...sources.keys()].filter(key => scope === "all" || key === scope).map(sourceAvailability),
    fleetBootstrapFailed,
  );
}

function scopeComplete(scope = selectedScope): boolean {
  return scopeCoverage(scope).complete;
}

function hostLabel(ref: Pick<SessionRef, "sourceKey">): string {
  return sources.get(ref.sourceKey)?.label ?? "Unavailable host";
}

let localProbe: Promise<SnapshotResult> | undefined;
async function probeSource(key: SourceKey, signal: AbortSignal): Promise<SnapshotResult> {
  if (signal.aborted) return "unavailable";
  if (key !== localKey) return await remotes.get(key)?.probe(signal) ?? "unavailable";
  localProbe ??= (async (): Promise<SnapshotResult> => {
    const epoch = directoryEpoch;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch("/api/v1/sessions", {
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
      });
      if (response.status === 403) {
        if (epoch === directoryEpoch) withdrawLocalAuthorization();
        return "forbidden";
      }
      if (!response.ok) return "unavailable";
      parseSessionListResponse(await boundedJson(response, SNAPSHOT_BYTES));
      return "healthy";
    } catch { return "unavailable"; }
    finally { window.clearTimeout(timeout); localProbe = undefined; }
  })();
  const { promise, resolve } = Promise.withResolvers<SnapshotResult>();
  const abort = (): void => { signal.removeEventListener("abort", abort); resolve("unavailable"); };
  signal.addEventListener("abort", abort, { once: true });
  void localProbe.then(result => {
    signal.removeEventListener("abort", abort);
    resolve(signal.aborted ? "unavailable" : result);
  });
  return await promise;
}

function withdrawLocalAuthorization(): void {
  authorizationDenied = true;
  localFresh = false;
  directoryLoaded = false;
  localObservationWithdrawn = true;
  lastFreshAt = undefined;
  directoryEpoch += 1;
  directoryRevision = -1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  events = undefined;
  clearEventLiveness();
  clearReconnectTimeout();
  eventStreamStale = false;
  clearLocalTransportFailure();
  replaceSessionSnapshot([], localKey, false);
  creation.cancel("forbidden", localKey);
  clearCreationDraft(localKey);
  cancelLaunch(localKey);
  if (activeCollabShell?.sourceKey === localKey) void restoreDirectory(undefined, undefined, false);
  render();
  setStatus("unauthorized", "This tailnet identity is not authorized.");
}

function cancelLaunch(source?: SourceKey, restore = true): void {
  if (pendingLaunch === undefined || (source !== undefined && pendingLaunch.ref.sourceKey !== source)) return;
  const cancelled = pendingLaunch;
  cancelled.settled = true;
  if (cancelled.deadline !== undefined) window.clearTimeout(cancelled.deadline);
  cancelled.controller.abort();
  pendingLaunch = undefined;
  if (cancelled.presentation === "request-tray" && activeCollabShell === undefined && tray.id === "request") {
    if (restore && dashboardSnapshot !== undefined) {
      // Consume the preview's snapshot without reverting a newer host selection or retrying.
      void restoreDirectory({ ompDirectory: { ...dashboardSnapshot.historyState, scope: selectedScope } }, cancelled.ref, false);
    } else tray.close(true, true);
    if (statusBanner.dataset.kind === "loading" && directoryLoaded && localFresh) setStatus("ready", "");
  }
  if (cancelled.creationHandoff && activeCollabShell === undefined && statusBanner.dataset.kind === "loading") setStatus("ready", "");
}

function remoteChanged(remote: FleetTransport): void {
  if (remote.status === "fresh" || remote.status === "forbidden") remoteLaunchFailures.delete(remote.key);
  replaceSessionSnapshot(remote.snapshot?.sessions ?? [], remote.key, remote.status === "fresh");
  if (remote.status === "forbidden") {
    creation.cancel("forbidden", remote.key);
    clearCreationDraft(remote.key);
    cancelLaunch(remote.key);
    if (activeCollabShell?.sourceKey === remote.key) returnToDirectory();
  }
  render();
  if (remote.status === "fresh") reconcileActiveCollabShell();
  if (remote.status === "forbidden") applyActivatedWorkerUpdate();
}

function renderFleetStatus(): void {
  fleetStatus.replaceChildren();
  // The banner owns this gateway; only independent remote failures belong here.
  for (const [key, remote] of remotes) {
    const availability = sourceAvailability(key);
    const launchFailure = remoteLaunchFailures.get(key);
    if ((selectedScope !== "all" && selectedScope !== key) || (!availability.failed && launchFailure === undefined) ||
      (navigator.onLine === false && remote.status !== "forbidden")) continue;
    const detail = remote.status === "forbidden" ? "Access withdrawn."
      : availability.failed ? `Host unavailable. ${availability.copy}` : launchFailure!;
    const row = document.createElement("div");
    row.className = "fleet-status-row";
    row.append(createTextElement("span", "fleet-status-copy", `${remote.source.label}: ${detail}`));
    row.dataset.sourceKey = key;
    row.dataset.state = availability.failed ? remote.status : "launch-failed";
    if (availability.retry || launchFailure !== undefined) {
      const retry = createTextElement("button", "status-action", availability.failed ? "Retry" : "Refresh host");
      retry.addEventListener("click", () => void remote.refresh(true));
      row.append(retry);
    }
    fleetStatus.append(row);
  }
  fleetStatus.hidden = fleetStatus.childElementCount === 0;
}

async function initializeFleet(): Promise<void> {
  try {
    const config = await loadClientConfig(location.origin);
    if (config !== undefined) {
      // Identity is already origin-bound. Keep in-flight creation intents on this same source.
      localSource.label = config.local.label;
      browserRecognitionEnabled = config.speech.browserRecognition;
      for (const target of config.targets) {
        const key = sourceKey(target);
        sources.set(key, target);
        remotes.set(key, new FleetTransport(target, remoteChanged));
      }
    }
    fleetBootstrapFailed = false;
  } catch { fleetBootstrapFailed = true; }
  if (typeof localStorage !== "undefined") {
    const configured = [...sources.values()];
    heldAsks = readSourceRecords(localStorage, HELD_KEY, configured, !fleetBootstrapFailed) as Map<string, HeldAsk>;
    dismissedSessions = readSourceRecords(localStorage, DISMISSED_KEY, configured, !fleetBootstrapFailed) as Map<string, DismissedSession>;
  }
  hostPicker.replaceChildren();
  for (const [key, label] of [["all", "All hosts"], ...[...sources].map(([key, source]) => [key, source.label])] as [string, string][]) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    hostPicker.append(option);
  }
  hostPicker.value = selectedScope;
  hostPickerLabel.hidden = sources.size === 1;
  alertScope.textContent = `Alerts cover this host (${localSource.label}) only. Remote hosts need their own installed PWA for alerts.`;
  for (const remote of remotes.values()) remote.setVisible(document.visibilityState === "visible");
  renderFleetStatus();
}

function elapsedLabel(startedAt: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  if (elapsedMinutes < 1) return "<1m";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) {
    const minutes = elapsedMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

function waitingLabel(session: SessionMetadata): string {
  const since = Date.parse(session.ask?.since ?? session.lastSeenAt);
  return `waiting ${elapsedLabel(Number.isNaN(since) ? Date.now() : since)}`;
}

function uptimeLabel(session: SessionMetadata): string {
  const startedAt = Date.parse(session.startedAt);
  return `up ${elapsedLabel(Number.isNaN(startedAt) ? Date.now() : startedAt)}`;
}

function modelSlug(model: string): string {
  const separator = model.lastIndexOf("/");
  return separator >= 0 && separator + 1 < model.length ? model.slice(separator + 1) : model;
}

function compareWaiting(left: SessionMetadata, right: SessionMetadata, scope = selectedScope): number {
  if (scope === "all" && sources.size > 1) {
    const first = observedAsks.get(localRecordKey(left, left.ask?.requestId ?? "")) ?? 0;
    const second = observedAsks.get(localRecordKey(right, right.ask?.requestId ?? "")) ?? 0;
    return first - second || left.sourceKey.localeCompare(right.sourceKey) || left.instanceId.localeCompare(right.instanceId);
  }
  const leftSince = left.ask?.since ?? left.lastSeenAt;
  const rightSince = right.ask?.since ?? right.lastSeenAt;
  return leftSince === rightSince
    ? left.instanceId.localeCompare(right.instanceId)
    : leftSince.localeCompare(rightSince);
}

function orderedWaitingSessions(scope = selectedScope): SessionMetadata[] {
  return scopedSessions(scope).filter(session => session.inputRequired && !isHeld(session))
    .sort((left, right) => compareWaiting(left, right, scope));
}

function orderedHeldSessions(scope = selectedScope): SessionMetadata[] {
  return scopedSessions(scope).filter(isHeld).sort((left, right) => compareWaiting(left, right, scope));
}

function orderedWorkingSessions(scope = selectedScope): SessionMetadata[] {
  return scopedSessions(scope)
    .filter(session => !session.inputRequired && !isDismissed(session))
    .sort((left, right) => {
      const started = right.startedAt.localeCompare(left.startedAt);
      return started === 0 ? left.instanceId.localeCompare(right.instanceId) : started;
    });
}

function orderedDismissedSessions(): SessionMetadata[] {
  return scopedSessions().filter(isDismissed).sort((left, right) =>
    left.instanceId.localeCompare(right.instanceId),
  );
}
function createTextElement(tagName: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function createQueueKicker(label: string, detail?: string): HTMLElement {
  const kicker = createTextElement("p", "queue-kicker", label);
  if (detail !== undefined) {
    kicker.append(createTextElement("span", "queue-wait", detail));
  }
  return kicker;
}

type Fact = readonly [className: string, value: string | undefined];

/** Metadata under a title as groups of discrete facts, one group per line; a group never wraps. */
function createRowMeta(groups: readonly (readonly Fact[])[]): HTMLElement | undefined {
  const meta = document.createElement("span");
  meta.className = "row-meta";
  for (const facts of groups) {
    const group = document.createElement("span");
    group.className = "fact-group";
    for (const [className, value] of facts) {
      if (value !== undefined && value.length > 0) group.append(createTextElement("span", `fact ${className}`, value));
    }
    if (group.childElementCount > 0) meta.append(group);
  }
  return meta.childElementCount > 0 ? meta : undefined;
}

/** Where a session runs: its host (only while several are in view) and its project, unless the title already is the project. */
function contextFacts(session: SessionMetadata): Fact[] {
  return [
    ["host-label", hostVisible() ? hostLabel(session) : undefined],
    ["working-context", session.cwdLabel === sessionTitle(session) ? undefined : session.cwdLabel],
  ];
}

function freshnessFacts(session: SessionMetadata): Fact[] {
  const availability = sourceAvailability(session.sourceKey);
  return availability.current ? [] : [["session-freshness", availability.failed ? availability.copy : "Updating…"]];
}

function createSessionSummary(session: SessionMetadata): HTMLElement {
  return createRowMeta([
    contextFacts(session),
    sourceFresh(session.sourceKey) ? [["working-model", session.model === undefined ? undefined : modelSlug(session.model)]] : freshnessFacts(session),
  ]) ?? createTextElement("span", "row-meta", "Live OMP session");
}

function createHideIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  for (const [name, attributes] of [
    ["path", { d: "M2.6 10c1.9-3 4.4-4.5 7.4-4.5s5.5 1.5 7.4 4.5c-1.9 3-4.4 4.5-7.4 4.5S4.5 13 2.6 10Z", "stroke-linejoin": "round" }],
    ["circle", { cx: "10", cy: "10", r: "2.4" }],
    ["path", { d: "M4.5 15.5l11-11", "stroke-linecap": "round" }],
  ] as const) {
    const shape = document.createElementNS(SVG_NAMESPACE, name);
    shape.setAttribute("stroke", "currentColor");
    shape.setAttribute("stroke-width", "1.6");
    for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, value);
    svg.append(shape);
  }
  return svg;
}

function createExpandIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", "M12 3h5v5M17 3l-6 6M8 17H3v-5M3 17l6-6");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

async function closeHeldAskNotification(held: HeldAsk): Promise<void> {
  if (recordRef(held).sourceKey !== localKey) return;
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = notificationRegistration ?? (await navigator.serviceWorker.ready);
    const notifications = await registration.getNotifications({
      tag: `omp-attention-${held.instanceId}`,
    });
    for (const notification of notifications) {
      const data = notification.data as { requestId?: unknown } | undefined;
      if (data?.requestId === held.requestId) notification.close();
    }
  } catch {
    // Holding remains valid when the browser cannot enumerate notifications.
  }
}

function holdSession(session: SessionMetadata, rerender = true): boolean {
  const current = sessions.get(sessionKey(session));
  const ask = current?.ask;
  if (
    current === undefined ||
    current.generation !== session.generation ||
    current.inputRequired === false ||
    ask === undefined ||
    session.ask?.requestId !== ask.requestId
  ) {
    return false;
  }
  const held: HeldAsk = {
    sourceId: sources.get(session.sourceKey)!.id,
    sourceOrigin: sources.get(session.sourceKey)!.origin,
    instanceId: current.instanceId,
    requestId: ask.requestId,
    heldAt: new Date().toISOString(),
  };
  setBoundedLocalRecord(heldAsks, recordKey(held, held.requestId), held);
  writeLocalRecords(HELD_ASKS_STORAGE_KEY, heldAsks.values());
  void closeHeldAskNotification(held);
  if (rerender) render();
  return true;
}

function requeueHeldSession(session: SessionMetadata): void {
  if (session.ask === undefined) return;
  heldAsks.delete(localRecordKey(session, session.ask.requestId));
  writeLocalRecords(HELD_ASKS_STORAGE_KEY, heldAsks.values());
  render();
}

function showDismissUndo(session: SessionMetadata): void {
  cancelPendingDismissUndo();
  undoCopy.replaceChildren(
    createTextElement("span", "undo-label", "Hidden on this device"),
    createTitleElement("span", "undo-session-title", session),
  );
  undoPanel.replaceChildren(createSessionTile(session), undoCopy, undoButton);
  const pending = {
    sourceKey: session.sourceKey,
    instanceId: session.instanceId,
    generation: session.generation,
  };
  pendingDismissUndo = pending;
  if (creation.isActive) cancelLaunch();
  creation.cancel("competing");
  tray.open({ id: "undo", title: "Hidden on this device", tone: "neutral", body: undoPanel }, {
    transientMs: LOCAL_ACTION_UNDO_MS,
    onClose: () => { if (pendingDismissUndo === pending) pendingDismissUndo = undefined; },
  });
}

function dismissSession(session: SessionMetadata): void {
  const current = sessions.get(sessionKey(session));
  if (
    current === undefined ||
    current.generation !== session.generation ||
    current.inputRequired
  ) {
    return;
  }
  const dismissed: DismissedSession = {
    sourceId: sources.get(session.sourceKey)!.id,
    sourceOrigin: sources.get(session.sourceKey)!.origin,
    instanceId: current.instanceId,
    generation: current.generation,
    dismissedAt: new Date().toISOString(),
  };
  setBoundedLocalRecord(
    dismissedSessions,
    recordKey(dismissed, dismissed.generation),
    dismissed,
  );
  writeLocalRecords(DISMISSED_SESSIONS_STORAGE_KEY, dismissedSessions.values());
  render();
  showDismissUndo(current);
}

function undoPendingDismissal(): void {
  const pending = pendingDismissUndo;
  if (pending === undefined) return;
  pendingDismissUndo = undefined;
  dismissedSessions.delete(localRecordKey(pending, pending.generation));
  writeLocalRecords(DISMISSED_SESSIONS_STORAGE_KEY, dismissedSessions.values());
  tray.close(true, true);
  render();
}

function restoreDismissedSessions(): void {
  for (const [key, record] of dismissedSessions) {
    if (selectedScope === "all" || recordRef(record).sourceKey === selectedScope) dismissedSessions.delete(key);
  }
  writeLocalRecords(DISMISSED_SESSIONS_STORAGE_KEY, dismissedSessions.values());
  cancelPendingDismissUndo();
  render();
}

function createWorkingRow(session: SessionMetadata): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "working-row-frame";
  frame.dataset.fresh = String(sourceFresh(session.sourceKey));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "working-row";
  button.dataset.instanceId = session.instanceId;
  button.dataset.sourceKey = session.sourceKey;
  button.disabled = !session.canView || !sourceFresh(session.sourceKey);
  button.setAttribute("aria-label", `View ${spokenTitle(session)}`);
  const copy = document.createElement("span");
  copy.className = "working-copy";
  copy.append(createTitleElement("span", "row-title", session));
  const details = createRowMeta([
    contextFacts(session),
    sourceFresh(session.sourceKey) ? [
      ["session-activity", session.busy === true ? "Working" : session.busy === false ? "Idle" : "Activity unknown"],
      ["row-time", uptimeLabel(session)],
      ["working-model", session.model === undefined ? undefined : modelSlug(session.model)],
    ] : freshnessFacts(session),
  ]);
  if (details !== undefined) copy.append(details);
  button.append(createSessionTile(session, activityState(session)), copy);
  button.addEventListener("click", () => void launch(session, "view", button));

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "dismiss-session";
  dismiss.title = "Hide on this device — the OMP process keeps running";
  dismiss.setAttribute("aria-label", `Hide ${spokenTitle(session)} on this device`);
  dismiss.append(createHideIcon());
  dismiss.addEventListener("click", () => dismissSession(session));
  frame.append(button, dismiss);
  return frame;
}

function createWaitingRow(session: SessionMetadata): HTMLButtonElement {
  const mode: LaunchMode = session.canControl ? "control" : "view";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "queue-row";
  button.dataset.fresh = String(sourceFresh(session.sourceKey));
  button.dataset.instanceId = session.instanceId;
  button.dataset.sourceKey = session.sourceKey;
  button.disabled = !sourceFresh(session.sourceKey) || (mode === "control" ? !session.canControl : !session.canView);
  button.setAttribute(
    "aria-label",
    session.canControl ? `Open request in ${spokenTitle(session)}` : `View ${spokenTitle(session)}`,
  );
  const copy = document.createElement("span");
  copy.className = "row-copy";
  copy.append(createTitleElement("span", "row-title", session));
  const meta = createRowMeta([contextFacts(session), freshnessFacts(session)]);
  if (meta !== undefined) copy.append(meta);
  button.append(
    createSessionTile(session, "waiting"),
    copy,
    createTextElement("span", "row-time", waitingLabel(session)),
    createTextElement("span", "row-chevron", "›"),
  );
  button.addEventListener("click", () =>
    void launch(session, mode, button, session.ask?.requestId, selectedScope, "request-tray"),
  );
  return button;
}

function createHeldRow(session: SessionMetadata): HTMLElement {
  const mode: LaunchMode = session.canControl ? "control" : "view";
  const row = document.createElement("div");
  row.className = "held-row";
  row.dataset.fresh = String(sourceFresh(session.sourceKey));
  row.dataset.instanceId = session.instanceId;
  row.dataset.sourceKey = session.sourceKey;

  const open = document.createElement("button");
  open.type = "button";
  open.className = "held-open";
  open.disabled = !sourceFresh(session.sourceKey) || (mode === "control" ? !session.canControl : !session.canView);
  open.setAttribute("aria-label", `Open held request in ${spokenTitle(session)}`);
  const copy = document.createElement("span");
  copy.className = "row-copy";
  copy.append(createTitleElement("span", "row-title", session));
  const meta = createRowMeta([contextFacts(session), freshnessFacts(session)]);
  if (meta !== undefined) copy.append(meta);
  open.append(
    createSessionTile(session, "held"),
    copy,
    createTextElement("span", "row-time", waitingLabel(session)),
  );
  open.addEventListener("click", () =>
    void launch(session, mode, open, session.ask?.requestId, selectedScope, "request-tray"),
  );

  const requeue = document.createElement("button");
  requeue.type = "button";
  requeue.className = "held-requeue";
  requeue.textContent = "Requeue";
  requeue.setAttribute("aria-label", `Return ${spokenTitle(session)} to the queue`);
  requeue.addEventListener("click", () => requeueHeldSession(session));
  row.append(open, requeue);
  return row;
}

function appendDismissedControl(dismissed: readonly SessionMetadata[]): void {
  if (dismissed.length === 0) return;
  const control = document.createElement("aside");
  control.className = "dismissed-control";
  control.append(createTextElement("span", "", `${dismissed.length} hidden on this device`));
  const restore = document.createElement("button");
  restore.type = "button";
  restore.textContent = "Show all";
  restore.addEventListener("click", restoreDismissedSessions);
  control.append(restore);
  sessionList.append(control);
}

function renderAllClear(
  working: readonly SessionMetadata[],
  dismissed: readonly SessionMetadata[],
  arrived: boolean,
): void {
  const coverage = scopeCoverage();
  const summary = document.createElement("div");
  summary.className = "all-clear-summary";
  summary.dataset.complete = String(coverage.complete);
  if (arrived) summary.dataset.arrived = "true";
  const alertsLive = notificationState === "enabled" && (sources.size === 1 || selectedScope === localKey);
  const message = document.createElement("div");
  message.className = "all-clear-message";
  message.append(
    createTextElement("h2", "all-clear-title", coverage.complete ? "All clear" : coverage.title),
    createTextElement(
      "p",
      "all-clear-copy",
      coverage.complete
        ? `Nothing needs you.${alertsLive ? " Alerts are on for input requests and activity stops." : ""}`
        : coverage.copy,
    ),
  );
  summary.append(createTextElement("span", "all-clear-dot", ""), message);
  // Keep the ping promise honest: without an active subscription, surface the path to one.
  if (coverage.complete && (sources.size === 1 || selectedScope === localKey) && (notificationState === "idle" || notificationState === "blocked")) {
    const hint = document.createElement("button");
    hint.type = "button";
    hint.className = "alerts-hint";
    hint.textContent = notificationState === "blocked" ? "Alerts blocked · Settings" : "Enable alerts to get pinged";
    hint.addEventListener("click", openAlerts);
    summary.append(hint);
  }
  sessionList.append(summary);
  if (working.length > 0) {
    sessionList.append(createQueueKicker(coverage.complete ? "Live sessions" : "Sessions"));
    for (const session of working) sessionList.append(createWorkingRow(session));
  }
  appendDismissedControl(dismissed);
}

function renderWaitingQueue(
  waiting: readonly SessionMetadata[],
  held: readonly SessionMetadata[],
  working: readonly SessionMetadata[],
  dismissed: readonly SessionMetadata[],
): void {
  if (!scopeComplete()) renderAllClear([], [], false);
  const [hero, ...remaining] = waiting;
  if (hero === undefined) {
    const summary = document.createElement("div");
    summary.className = "all-held-summary";
    summary.append(
      createTextElement("span", "row-dot row-dot-held", ""),
      createTextElement("strong", "", scopeComplete() ? `Queue clear · ${held.length} on hold — handle at desk`
        : scopeCoverage().failed ? `${held.length} on hold · some hosts unavailable` : `${held.length} on hold · checking other hosts`),
    );
    sessionList.append(summary);
  } else {
    sessionList.append(createQueueKicker("Up next", selectedScope === "all" && sources.size > 1 ? "observed waiting order" : waitingLabel(hero)));
    const article = document.createElement("article");
    article.className = "queue-hero";
    article.dataset.fresh = String(sourceFresh(hero.sourceKey));
    article.dataset.instanceId = hero.instanceId;
    article.dataset.sourceKey = hero.sourceKey;
    const askPreview = createTextElement(
      "p",
      "ask-preview",
      hero.ask?.preview === undefined
        ? hero.canControl
          ? "Waiting for your input"
          : "Waiting for your input — Control unavailable"
        : hero.ask.preview,
    );
    if (hero.ask?.optionCount !== undefined) {
      askPreview.append(
        createTextElement(
          "span",
          "ask-options",
          `${hero.ask.optionCount} ${hero.ask.optionCount === 1 ? "option" : "options"} to pick from`,
        ),
      );
    }
    const identity = document.createElement("div");
    identity.className = "hero-identity";
    const heading = document.createElement("div");
    heading.className = "row-copy";
    heading.append(createTitleElement("h2", "", hero), createSessionSummary(hero));
    identity.append(createSessionTile(hero, "waiting"), heading);
    article.append(identity, askPreview);

    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "action action-request";
    primary.textContent = hero.canControl ? "Open request" : "View transcript";
    primary.disabled = !sourceFresh(hero.sourceKey) || (hero.canControl ? false : !hero.canView);
    primary.addEventListener("click", () => {
      const mode: LaunchMode = hero.canControl ? "control" : "view";
      void launch(hero, mode, primary, hero.ask?.requestId, selectedScope, "request-tray");
    });
    article.append(primary);

    const options = document.createElement("button");
    options.type = "button";
    options.className = "hero-options";
    options.textContent = "Options";
    options.setAttribute("aria-haspopup", "dialog");
    options.addEventListener("click", () => {
      const choices = document.createElement("div");
      const hold = document.createElement("button");
      hold.type = "button";
      hold.className = "tray-choice hero-hold";
      hold.textContent = "Hold for desk";
      hold.addEventListener("click", () => {
        tray.close(true);
        holdSession(hero);
      });
      choices.append(hold);
      if (hero.canView) {
        const transcript = document.createElement("button");
        transcript.type = "button";
        transcript.className = "tray-choice";
        transcript.textContent = "View transcript";
        transcript.disabled = !sourceFresh(hero.sourceKey);
        transcript.addEventListener("click", () => {
          tray.close(true);
          void launch(hero, "view", transcript);
        });
        choices.append(transcript);
      }
      if (creation.isActive) cancelLaunch();
      creation.cancel("competing");
      tray.open({ id: "options", title: "This request", tone: "attention", body: choices });
    });
    article.append(options);
    sessionList.append(article);
  }

  if (remaining.length > 0) {
    sessionList.append(createQueueKicker("Then"));
    for (const session of remaining) sessionList.append(createWaitingRow(session));
  }
  if (held.length > 0) {
    sessionList.append(createQueueKicker(`On hold · ${held.length}`));
    for (const session of held) sessionList.append(createHeldRow(session));
  }
  if (working.length > 0) {
    sessionList.append(createQueueKicker(`${scopeComplete() ? "Live sessions" : "Sessions"} · ${working.length}`));
    for (const session of working) sessionList.append(createWorkingRow(session));
  }
  appendDismissedControl(dismissed);
}

/* ——— Motion ——————————————————————————————————————————————————————
   Motion runs only on user-initiated transitions and genuine state changes (ADR-040): a
   same-document view transition wraps a DOM commit when the browser supports typed transitions,
   the document is visible, no dialog holds the top layer, and the user has not asked for reduced
   motion. Routine SSE refreshes render without one because `render()` compares a structural
   signature first. The update callback always runs, so every caller's DOM commit is the same
   with or without motion. */
type MotionType = "forward" | "back" | "list";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const rowNames = new Map<string, string>();

function motionAllowed(): boolean {
  return typeof document.startViewTransition === "function" &&
    typeof ViewTransition !== "undefined" && "types" in ViewTransition.prototype &&
    !reducedMotion.matches && document.visibilityState === "visible" &&
    document.querySelector("dialog[open]") === null;
}

function transitionDocument(type: MotionType, update: () => void): ViewTransition | undefined {
  if (!motionAllowed()) {
    update();
    return undefined;
  }
  const transition = document.startViewTransition({ update, types: [type] });
  // A skipped transition (duplicate name, hidden page, newer transition) still ran `update`.
  transition.ready.catch(() => undefined);
  return transition;
}

/** One stable, opaque transition name per session so a row keeps its identity across rebuilds. */
function rowName(key: string): string {
  let name = rowNames.get(key);
  if (name === undefined) {
    name = `omp-row-${rowNames.size + 1}`;
    rowNames.set(key, name);
  }
  return name;
}

/** Names the directory rows for one list transition; names are inline so they exist only while it runs. */
function nameDirectoryRows(named: boolean): void {
  for (const child of sessionList.children) {
    const element = child as HTMLElement;
    const keyed = element.matches("[data-instance-id]") ? element : element.querySelector<HTMLElement>("[data-instance-id]");
    if (keyed === null) continue;
    element.style.setProperty("view-transition-name", named ? rowName(`${keyed.dataset.sourceKey ?? ""}\0${keyed.dataset.instanceId ?? ""}`) : "");
    element.style.setProperty("view-transition-class", named ? "omp-row" : "");
  }
}

/** What the directory shows, minus everything that changes on a routine refresh (clock labels, freshness copy). */
function directorySignature(): string {
  if (!directoryLoaded && sessions.size === 0) return "loading";
  const visible = scopedSessions();
  const identity = (session: SessionMetadata, state: SessionTileState): unknown[] =>
    [session.sourceKey, session.instanceId, session.generation, state, session.ask?.requestId ?? null];
  return JSON.stringify([
    selectedScope,
    orderedWaitingSessions().map(session => identity(session, "waiting")),
    orderedHeldSessions().map(session => identity(session, "held")),
    orderedWorkingSessions().map(session => identity(session, activityState(session))),
    orderedDismissedSessions().map(session => [session.sourceKey, session.instanceId, session.generation]),
    visible.length === 0 ? ["empty", scopeComplete()] : "populated",
  ]);
}

/** Signatures are generated here, never supplied by storage or a server. Include held requests. */
function allClearArrival(previous: string | undefined, next: string): boolean {
  if (previous === undefined || previous === "loading" || next === "loading") return false;
  const [oldScope, oldWaiting, oldHeld] = JSON.parse(previous) as [string, unknown[], unknown[]];
  const [scope, waiting, held] = JSON.parse(next) as [string, unknown[], unknown[]];
  return oldScope === scope && oldWaiting.length + oldHeld.length > 0 && waiting.length + held.length === 0;
}

let renderedSignature: string | undefined;
/** A navigation transition in flight: renders wait for it, or a refresh would destroy the travelling tile. */
let navigationTransition: ViewTransition | undefined;
let renderHeld = false;

function transitionNavigation(type: "forward" | "back", update: () => void): ViewTransition | undefined {
  const transition = transitionDocument(type, update);
  if (transition === undefined) return undefined;
  navigationTransition = transition;
  transition.finished.finally(() => {
    if (navigationTransition === transition) navigationTransition = undefined;
    if (renderHeld) {
      renderHeld = false;
      render();
    }
  });
  return transition;
}

function render(): void {
  if (activeCollabShell !== undefined) return;
  if (navigationTransition !== undefined) {
    renderHeld = true;
    return;
  }
  const signature = directorySignature();
  // The first populated render settles in place; afterwards only structural changes animate.
  const animate = renderedSignature !== undefined && renderedSignature !== "loading" && renderedSignature !== signature && motionAllowed();
  const arrived = animate && scopeComplete() && allClearArrival(renderedSignature, signature);
  renderedSignature = signature;
  if (!animate) {
    renderDirectory();
    maybeStartFirstRun();
    return;
  }
  nameDirectoryRows(true);
  const transition = transitionDocument("list", () => {
    renderDirectory(arrived);
    nameDirectoryRows(true);
  });
  transition?.finished.finally(() => { nameDirectoryRows(false); maybeStartFirstRun(); });
}

function renderDirectory(arrived = false): void {
  const focused = document.activeElement;
  const keyed = focused?.matches(".action-request, .queue-row, .held-open")
    ? focused.closest<HTMLElement>("[data-instance-id]") : null;
  const focusRef = keyed?.dataset.instanceId === undefined ? undefined : {
    sourceKey: keyed.dataset.sourceKey ?? localKey,
    instanceId: keyed.dataset.instanceId,
  };
  renderDirectoryContents(arrived);
  // Snapshot/SSE refreshes replace row nodes even when there is no structural animation.
  if (focusRef !== undefined) focusDirectoryRequest(focusRef);
}

function renderEmptyState(): void {
  emptyState.querySelector(".empty-state-detail")?.remove();
  const coverage = scopeCoverage();
  const filtered = selectedScope !== "all";
  const observations = [...sources.keys()].filter(key => !filtered || key === selectedScope).map(sourceAvailability);
  const observation = observations.length === 1 ? observations[0] : undefined;
  const withdrawn = observations.some(source => source.status === "withdrawn");
  const expired = observations.some(source => source.status === "expired");
  const denied = observations.every(source => source.status === "forbidden");
  const retainedEmpty = observations.every(source => source.time !== undefined &&
    (source.status === "fresh" || source.status === "refreshing" || source.status === "stale"));
  const sharedTime = observations[0]?.time;
  emptyState.dataset.state = coverage.complete && !filtered ? "empty" : "limited";
  if (emptyState.dataset.state === "empty") return;
  const body = document.createElement("div");
  body.className = "empty-state-detail";
  const title = denied ? "Sessions are hidden"
    : withdrawn ? "Session list withdrawn"
    : coverage.complete ? "No sessions on this host"
      : expired ? observation === undefined ? "Session lists expired" : "Session list expired"
        : retainedEmpty ? observations.every(source => source.time === sharedTime)
          ? `No sessions as of ${sharedTime}` : "No sessions in the last received lists"
          : !coverage.failed ? "Checking for sessions"
            : observation !== undefined ? "This host has not been checked" : "No sessions to show yet";
  const detail = denied ? "Ask the gateway operator to restore access."
    : withdrawn ? "A fresh authorized list is needed before showing sessions."
    : coverage.complete ? "Choose another host or start a session here."
    : !coverage.failed ? retainedEmpty ? "Checking for updates before confirming this list is still empty."
      : "Waiting for the remaining hosts before confirming this list is empty."
      : observation !== undefined ? "Its sessions may appear when the connection returns."
        : "Some hosts could not be checked. Sessions may appear when they reconnect.";
  body.append(createTextElement("h2", "", title), createTextElement("p", "", detail));
  if (!denied) body.append(createTextElement("p", "empty-coverage", coverage.complete ? "No live sessions are listed here." : coverage.copy));
  if (filtered) {
    const all = createTextElement("button", "status-action", "All hosts");
    all.addEventListener("click", () => {
      hostPicker.value = "all";
      hostPicker.dispatchEvent(new Event("change"));
    });
    body.append(all);
  }
  emptyState.append(body);
}

function renderDirectoryContents(arrived = false): void {
  renderFleetStatus();
  sessionList.replaceChildren();
  sessionList.setAttribute("aria-label", scopeComplete() ? "Live OMP sessions" : "Listed OMP sessions");
  if (sessions.size === 0 && !scopeCoverage().failed &&
    ![...sources.keys()].some(key => (selectedScope === "all" || key === selectedScope) && sourceAvailability(key).time !== undefined)) {
    emptyState.hidden = true;
    directoryTitle.textContent = "Sessions";
    directoryCount.hidden = true;
    return;
  }
  const visibleSessions = scopedSessions();
  emptyState.hidden = visibleSessions.length > 0;
  if (visibleSessions.length === 0) {
    renderEmptyState();
    directoryTitle.textContent = "Sessions";
    directoryCount.hidden = true;
    sessionList.className = "session-list";
    sessionList.setAttribute("aria-label", scopeComplete() ? "Live OMP sessions" : "Listed OMP sessions");
    if (arrived) renderAllClear([], [], true);
    return;
  }

  const waiting = orderedWaitingSessions();
  const held = orderedHeldSessions();
  const working = orderedWorkingSessions();
  const dismissed = orderedDismissedSessions();
  const attentionCount = waiting.length + held.length;
  directoryCount.hidden = false;
  if (attentionCount > 0) {
    directoryTitle.textContent = "Needs you";
    directoryCount.className = "count-pill count-pill-waiting";
    directoryCount.textContent =
      held.length === 0
        ? `${attentionCount} waiting`
        : `${attentionCount} waiting · ${held.length} held`;
    sessionList.className = "session-list queue";
    sessionList.setAttribute("aria-label", "Sessions waiting for input");
    renderWaitingQueue(waiting, held, working, dismissed);
    return;
  }

  directoryTitle.textContent = "Sessions";
  directoryCount.className = `count-pill ${scopeComplete() ? "count-pill-live" : "count-pill-listed"}`;
  const liveWorkingCount = working.length + dismissed.length;
  directoryCount.textContent = `${scopeComplete() ? "Live" : "Listed"} · ${liveWorkingCount}`;
  sessionList.className = "session-list all-clear";
  sessionList.setAttribute("aria-label", scopeComplete() ? "Live OMP sessions" : "Listed OMP sessions");
  renderAllClear(working, dismissed, arrived);
}

function setConnectionState(
  chip: HTMLElement,
  state: "connected" | "connecting" | "reconnecting" | "offline" | "forbidden",
  copy?: string,
): void {
  const label = copy ?? (state === "connected" ? "Connected" : state === "connecting" ? "Connecting…" : state === "reconnecting" ? "Reconnecting…" : "Offline");
  const compact = state === "connected" && copy === undefined ? "true" : "false";
  if (chip.dataset.state !== state) chip.dataset.state = state;
  if (chip.dataset.compact !== compact) chip.dataset.compact = compact;
  if (chip.textContent !== label) {
    chip.textContent = label;
    chip.setAttribute("aria-label", label);
    chip.title = label;
  }
}

function sessionEndedCopy(reason: string | null): string {
  const exitCode = reason?.match(/\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s+(-?\d+)\b/iu)?.[1];
  return exitCode === undefined ? "Session ended" : `Session ended · exit ${exitCode}`;
}

function hideTriageBar(shell: ActiveCollabShell, rerenderConnection = true): void {
  const hidAnswerTriage = shell.answerTriageVisible;
  if (shell.triageTimeout !== undefined) {
    window.clearTimeout(shell.triageTimeout);
    delete shell.triageTimeout;
  }
  shell.answerTriageVisible = false;
  shell.triageBar.hidden = true;
  delete shell.triageBar.dataset.dismissible;
  delete shell.shell.dataset.triageVisible;
  if (hidAnswerTriage && rerenderConnection) renderConnectionState(shell);
}

function showTriageBar(
  shell: ActiveCollabShell,
  kind: "next" | "clear" | "hold" | "sending" | "reconnecting" | "launch-failed" | "ended",
  copy: string,
  actionLabel?: string,
  action?: () => void,
): void {
  const drawCheck = kind === "clear" && copy.startsWith("✓ Answered — all clear") &&
    shell.triageBar.dataset.kind !== "clear";
  hideTriageBar(shell, false);
  shell.triageBar.dataset.kind = kind;
  shell.answerTriageVisible = kind === "next" || kind === "clear";
  const message = createTextElement("span", "triage-copy", drawCheck ? copy.slice(2) : copy);
  if (drawCheck) {
    const check = document.createElementNS(SVG_NAMESPACE, "svg");
    check.setAttribute("class", "triage-check");
    check.setAttribute("viewBox", "0 0 20 20");
    check.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", "M4 10l4 4 8-8");
    path.setAttribute("pathLength", "1");
    check.append(path);
    message.prepend(check);
    if (!reducedMotion.matches && document.visibilityState === "visible") check.dataset.arrived = "true";
  }
  if (actionLabel !== undefined && action !== undefined) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      kind === "next" || kind === "hold"
        ? "triage-action triage-action-next"
        : "triage-action";
    button.textContent = actionLabel;
    button.addEventListener("click", action);
    shell.triageBar.replaceChildren(message, button);
  } else {
    shell.triageBar.replaceChildren(message);
  }
  shell.triageBar.hidden = false;
  shell.shell.dataset.triageVisible = "true";
  if (kind === "next" || kind === "clear") {
    shell.triageBar.dataset.dismissible = "true";
    shell.triageTimeout = window.setTimeout(() => hideTriageBar(shell), 8_000);
  }
}

function clearConnectionTimers(shell: ActiveCollabShell): void {
  if (shell.connectionDelayTimeout !== undefined) {
    window.clearTimeout(shell.connectionDelayTimeout);
    delete shell.connectionDelayTimeout;
  }
  if (shell.connectionTickTimeout !== undefined) {
    window.clearTimeout(shell.connectionTickTimeout);
    delete shell.connectionTickTimeout;
  }
  if (shell.recoveredTimeout !== undefined) {
    window.clearTimeout(shell.recoveredTimeout);
    delete shell.recoveredTimeout;
  }
}

function pathInterrupted(health: PathHealth): boolean {
  return (
    health.state === "degraded" ||
    health.state === "unreachable" ||
    (health.state === "checking" && health.failureSince !== null)
  );
}

function retryingCopy(path: "gateway" | "relay", state: CollabEmbedState): string {
  const retryAt = path === "gateway" ? state.gatewayHealth.retryAt : state.relayHealth.retryAt;
  if (retryAt === null) return "Reconnecting automatically…";
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
  return seconds > 0 ? `Retrying in ${seconds}s` : "Reconnecting automatically…";
}

function scheduleConnectionRender(shell: ActiveCollabShell, delay: number, kind: "delay" | "tick"): void {
  const existing = kind === "delay" ? shell.connectionDelayTimeout : shell.connectionTickTimeout;
  if (existing !== undefined) window.clearTimeout(existing);
  const timeout = window.setTimeout(() => {
    if (kind === "delay") delete shell.connectionDelayTimeout;
    else delete shell.connectionTickTimeout;
    renderConnectionState(shell);
  }, delay);
  if (kind === "delay") shell.connectionDelayTimeout = timeout;
  else shell.connectionTickTimeout = timeout;
}

function renderConnectionState(shell: ActiveCollabShell): void {
  const state = shell.latestEmbedState;
  if (state === undefined || activeCollabShell !== shell) return;
  if (state.gatewayHealth.state === "forbidden") {
    clearConnectionTimers(shell);
    setConnectionState(shell.connectionChip, "forbidden", "Access withdrawn");
    showTriageBar(shell, "ended", "This identity can no longer access the session.", "Back to Sessions", returnToDirectory);
    return;
  }

  if (state.phase === "ended") {
    clearConnectionTimers(shell);
    shell.answerShown = true;
    setConnectionState(shell.connectionChip, "offline", "Ended");
    showTriageBar(
      shell,
      "ended",
      sessionEndedCopy(state.endedReason),
      "Back to Sessions",
      returnToDirectory,
    );
    return;
  }

  const live = state.phase === "live";
  const loading = state.loading;
  let progressCopy: string | null = null;
  if (loading !== null) {
    const prefix = shell.hasBeenLive ? "Reconnecting…" : "Joining session…";
    progressCopy = prefix;
    if (Number.isFinite(loading.received) && Number.isFinite(loading.total) && loading.total > 0) {
      const percent = Math.max(0, Math.min(100, Math.floor(loading.received / loading.total * 100)));
      progressCopy = `${prefix} ${percent}%`;
    }
  }
  const gatewayInterrupted = pathInterrupted(state.gatewayHealth);
  const relayInterrupted = pathInterrupted(state.relayHealth);
  if (gatewayInterrupted || relayInterrupted) {
    if (shell.recoveredTimeout !== undefined) {
      window.clearTimeout(shell.recoveredTimeout);
      delete shell.recoveredTimeout;
    }
    shell.interruptionStartedAt ??= Date.now();
    shell.outagePath = gatewayInterrupted ? "gateway" : "relay";
    const elapsed = Date.now() - shell.interruptionStartedAt;
    if (elapsed < CONNECTION_EXTENDED_MS) {
      setConnectionState(shell.connectionChip, "reconnecting", "Reconnecting…");
      if (state.responsePending && !shell.answerTriageVisible) {
        showTriageBar(shell, "sending", "Sending…");
      } else if (!shell.answerTriageVisible && !shell.triageBar.hidden) {
        hideTriageBar(shell);
      }
      scheduleConnectionRender(shell, CONNECTION_EXTENDED_MS - elapsed, "delay");
      return;
    }
    const path = shell.outagePath ?? "relay";
    const copy = retryingCopy(path, state);
    setConnectionState(shell.connectionChip, "reconnecting", path === "gateway" ? "Gateway unavailable" : "Relay unavailable");
    if (state.responsePending && !shell.answerTriageVisible) showTriageBar(shell, "sending", "Sending…");
    else if (!shell.answerTriageVisible) showTriageBar(shell, "reconnecting", copy);
    scheduleConnectionRender(shell, 1_000, "tick");
    return;
  }

  const recovered = shell.interruptionStartedAt !== undefined;
  if (shell.connectionDelayTimeout !== undefined) {
    window.clearTimeout(shell.connectionDelayTimeout);
    delete shell.connectionDelayTimeout;
  }
  if (shell.connectionTickTimeout !== undefined) {
    window.clearTimeout(shell.connectionTickTimeout);
    delete shell.connectionTickTimeout;
  }
  delete shell.interruptionStartedAt;
  delete shell.outagePath;
  if (!shell.hasBeenLive) {
    if (!live || loading !== null) {
      setConnectionState(shell.connectionChip, "connecting", progressCopy ?? "Connecting…");
      if (shell.triageBar.dataset.kind === "reconnecting") hideTriageBar(shell);
      return;
    }
    shell.hasBeenLive = true;
  }
  if (progressCopy !== null) {
    if (shell.recoveredTimeout !== undefined) {
      window.clearTimeout(shell.recoveredTimeout);
      delete shell.recoveredTimeout;
    }
    setConnectionState(shell.connectionChip, "reconnecting", progressCopy);
    if (shell.triageBar.dataset.kind === "reconnecting") hideTriageBar(shell);
    return;
  }
  if (recovered) {
    window.clearTimeout(shell.recoveredTimeout);
    setConnectionState(shell.connectionChip, "connected", "Connected");
    shell.recoveredTimeout = window.setTimeout(() => {
      delete shell.recoveredTimeout;
      if (activeCollabShell === shell && shell.latestEmbedState?.phase === "live") {
        setConnectionState(shell.connectionChip, "connected");
      }
    }, CONNECTION_RECOVERED_MS);
  } else if (shell.recoveredTimeout === undefined) {
    setConnectionState(shell.connectionChip, "connected");
  }
  if (state.responsePending && !shell.answerTriageVisible) {
    showTriageBar(shell, "sending", "Sending…");
  } else {
    if (shell.triageBar.dataset.kind === "reconnecting" || shell.triageBar.dataset.kind === "sending") {
      hideTriageBar(shell);
    }
    reconcileActiveCollabShell();
  }
}
/** The tile of the directory row for a session, if that row is rendered. */
function directoryTile(ref: Pick<SessionRef, "sourceKey" | "instanceId">): HTMLElement | null {
  for (const keyed of sessionList.querySelectorAll<HTMLElement>("[data-instance-id]")) {
    if (keyed.dataset.instanceId !== ref.instanceId || (keyed.dataset.sourceKey ?? localKey) !== ref.sourceKey) continue;
    const row = keyed.matches(".working-row") ? keyed : keyed.closest<HTMLElement>(".queue-hero, .queue-row, .held-row") ?? keyed;
    return row.querySelector<HTMLElement>(".session-tile");
  }
  return null;
}

function focusDirectoryRequest(ref: Pick<SessionRef, "sourceKey" | "instanceId">): HTMLElement {
  for (const keyed of sessionList.querySelectorAll<HTMLElement>("[data-instance-id]")) {
    if (keyed.dataset.instanceId !== ref.instanceId || (keyed.dataset.sourceKey ?? localKey) !== ref.sourceKey) continue;
    const action = keyed.matches(".queue-row")
      ? keyed as HTMLButtonElement
      : keyed.querySelector<HTMLButtonElement>(".action-request, .held-open");
    if (action === null || action.disabled) break;
    action.focus({ preventScroll: true });
    return action;
  }
  directoryTitle.focus({ preventScroll: true });
  return directoryTitle;
}

/**
 * The interactive way back (shell Back, system back, the triage "Sessions" action): the shell
 * slides out while the directory slides in and the header tile returns to its row. Disposal and
 * recovery paths call `restoreDirectory` directly and never animate.
 */
function returnToDirectory(historyValue?: unknown): void {
  const shell = activeCollabShell;
  if (shell?.presentation === "request-tray" || tray.id === "request") {
    void restoreDirectory(historyValue);
    return;
  }
  let tile: HTMLElement | null = null;
  const transition = transitionNavigation("back", () => {
    // Another path may already have restored the directory while this commit waited for its frame.
    if (activeCollabShell !== shell || dashboardSnapshot === undefined) return;
    void restoreDirectory(historyValue);
    tile = shell === undefined ? null : directoryTile(shell);
    tile?.style.setProperty("view-transition-name", "session-tile");
  });
  transition?.finished.finally(() => tile?.style.setProperty("view-transition-name", ""));
}

/**
 * Restores the cached directory DOM synchronously — a caller that has already disposed a client
 * cannot be left waiting behind an inert shell — and resolves once the refreshed snapshot has
 * landed, so a resume can decide against current metadata rather than the pre-background copy.
 */
function restoreDirectory(historyValue?: unknown, requestRef?: Pick<SessionRef, "sourceKey" | "instanceId">, refresh = true): Promise<boolean> {
  const focusRef = activeCollabShell?.presentation === "request-tray" ? activeCollabShell
    : requestRef ?? (pendingLaunch?.presentation === "request-tray" ? pendingLaunch.ref : undefined);
  cancelLaunch(undefined, false);
  tray.close(true, true);
  selectionEpoch += 1;
  collabShellDisposedOnPageHide = false;
  disposedShellResume = undefined;
  const snapshot = dashboardSnapshot;
  if (snapshot === undefined) {
    location.replace("/");
    return Promise.resolve(false);
  }
  const historyState = parseDirectoryHistoryState(historyValue) ?? snapshot.historyState;
  selectedScope = historyState.scope;
  hostPicker.value = selectedScope;
  disposeActiveCollab?.();
  disposeActiveCollab = undefined;
  activeCollabShell = undefined;
  document.body.className = snapshot.bodyClass;
  document.body.replaceChildren(...snapshot.children);
  document.title = snapshot.title;
  dashboardSnapshot = undefined;
  // The cached rows show the list as it was at launch; the first refresh animates only what changed since.
  renderedSignature = snapshot.signature;
  history.replaceState({ ompDirectory: historyState }, "", "/");
  window.scrollTo(0, historyState.scrollY);
  render();
  const focused = focusRef === undefined ? undefined : focusDirectoryRequest(focusRef);
  if (!refresh) {
    applyActivatedWorkerUpdate();
    return Promise.resolve(false);
  }
  const epoch = selectionEpoch;
  const refreshed = Promise.all([authorizationDenied ? Promise.resolve(false) : refreshAndConnect(),
    ...[...remotes.values()].map(remote => remote.refresh())])
    .then(([local]) => {
      if (focusRef !== undefined && selectionEpoch === epoch && activeCollabShell === undefined &&
        pendingLaunch === undefined && !trayHost.open &&
        (document.activeElement === focused || document.activeElement === document.body)) {
        focusDirectoryRequest(focusRef);
      }
      return local;
    });
  applyActivatedWorkerUpdate();
  return refreshed;
}

/**
 * Reopens the session a backgrounded shell was showing, or leaves the user in the directory when the
 * card that shell was launched from no longer exists.
 *
 * Every condition the first launch checked is rechecked here against freshly polled metadata: the
 * same instance at the same generation, still offering the mode that was open. A host that restarted
 * bumped its generation and legitimately ended that session, so it falls back to the directory with
 * the ordinary stale-launch behaviour instead of silently opening its successor. The pending request
 * is carried back only while it is still the one waiting — the gateway rejects a stale `requestId`
 * outright, so an answered question must resume as a plain reopen rather than a failed launch.
 */
async function resumeDisposedCollabShell(): Promise<void> {
  const resume = disposedShellResume;
  const refresh = restoreDirectory();
  const epoch = selectionEpoch;
  const restored = await refresh;
  if (resume === undefined || (!restored && resume.sourceKey === localKey) ||
    activeCollabShell !== undefined || pendingLaunch !== undefined || selectionEpoch !== epoch || trayHost.open) return;
  selectedScope = resume.scope;
  hostPicker.value = selectedScope;
  const session = sessions.get(sessionKey(resume));
  if (session === undefined || session.generation !== resume.generation) return;
  if (!(resume.mode === "control" ? session.canControl : session.canView)) return;
  const requestId = session.ask?.requestId === resume.requestId ? resume.requestId : undefined;
  await launch(session, resume.mode, undefined, requestId, resume.scope, resume.presentation);
}

async function holdCurrentAskAndAdvance(shell: ActiveCollabShell, current: SessionMetadata): Promise<void> {
  const currentRequestId = current.ask?.requestId;
  const authoritativeCurrent = sessions.get(sessionKey(current));
  if (
    currentRequestId === undefined ||
    authoritativeCurrent?.generation !== current.generation ||
    authoritativeCurrent.ask?.requestId !== currentRequestId
  ) {
    reconcileActiveCollabShell();
    return;
  }

  const next = orderedWaitingSessions(shell.scope).find(
    session => sourceFresh(session.sourceKey) && (sessionKey(session) !== sessionKey(current) || session.ask?.requestId !== currentRequestId),
  );
  if (next !== undefined) {
    shell.answerShown = true;
    showTriageBar(shell, "sending", "Opening next request…");
    const mode: LaunchMode = next.canControl ? "control" : "view";
    const opened = await launch(next, mode, undefined, next.ask?.requestId, shell.scope);
    if (opened) {
      holdSession(current, false);
      return;
    }
    if (activeCollabShell !== shell) return;
    shell.answerShown = false;
    const latestCurrent = sessions.get(sessionKey(current));
    if (
      latestCurrent?.generation !== current.generation ||
      latestCurrent.ask?.requestId !== currentRequestId
    ) {
      reconcileActiveCollabShell();
      return;
    }
    if (next.sourceKey !== localKey &&
      (remoteLaunchFailures.has(next.sourceKey) || remotes.get(next.sourceKey)?.status === "forbidden")) return;
    showTriageBar(
      shell,
      "hold",
      "Couldn't open the next request. This one is still queued.",
      "Try again",
      () => void holdCurrentAskAndAdvance(shell, current),
    );
    return;
  }
  if (!holdSession(current, false)) return;
  shell.answerShown = true;
  const held = orderedHeldSessions(shell.scope).length;
  showTriageBar(
    shell,
    "clear",
    scopeComplete(shell.scope) ? `Queue clear · ${held} on hold — handle at desk`
      : scopeCoverage(shell.scope).failed ? `${held} on hold · some hosts unavailable` : `${held} on hold · checking other hosts`,
    "Sessions",
    returnToDirectory,
  );
}

function reconcileActiveCollabShell(): void {
  if (initialPromptDraft !== undefined) {
    const current = sessions.get(sessionKey(initialPromptDraft.ref));
    if (current === undefined || !sameBinding(current, initialPromptDraft.ref)) clearCreationDraft();
  }
  const shell = activeCollabShell;
  if (
    shell === undefined ||
    shell.answerShown ||
    shell.latestEmbedState?.responsePending === true
  ) {
    return;
  }
  if (!sourceFresh(shell.sourceKey)) return;
  const current = sessions.get(sessionKey(shell));
  if (current === undefined || current.generation !== shell.generation) {
    shell.answerShown = true;
    clearConnectionTimers(shell);
    setConnectionState(shell.connectionChip, "offline", "Ended");
    showTriageBar(shell, "ended", "Session ended", "Back to Sessions", returnToDirectory);
    return;
  }
  if (shell.openedRequestId !== undefined && current.ask?.requestId === shell.openedRequestId) {
    if (
      shell.latestEmbedState?.phase === "live" &&
      current.inputRequired &&
      isHeld(current) === false &&
      (shell.triageBar.hidden || shell.triageBar.dataset.kind !== "hold")
    ) {
      showTriageBar(shell, "hold", "Need the desk for this one?", "Hold → next", () =>
        void holdCurrentAskAndAdvance(shell, current),
      );
    }
    return;
  }
  if (shell.openedRequestId === undefined) return;

  shell.answerShown = true;
  const waiting = orderedWaitingSessions(shell.scope);
  const next = waiting.find(session => session.canControl && sourceFresh(session.sourceKey));
  if (waiting.length > 0 && next !== undefined) {
    const copy =
      waiting.length === 1
        ? "✓ Answered — 1 more needs you"
        : `✓ Answered — ${waiting.length} more need you`;
    showTriageBar(shell, "next", copy, "Next ask →", () =>
      void launch(next, "control", undefined, next.ask?.requestId, shell.scope),
    );
    return;
  }
  const working = orderedWorkingSessions(shell.scope).length;
  showTriageBar(
    shell,
    "clear",
    scopeComplete(shell.scope) ? `✓ Answered — all clear · ${working} live`
      : scopeCoverage(shell.scope).failed ? "Answered — some hosts are unavailable" : "Answered — checking other hosts",
    "Sessions",
    returnToDirectory,
  );
}

let collabStylesheetLoad: Promise<HTMLLinkElement> | undefined;
async function loadCollabStylesheet(): Promise<HTMLLinkElement> {
  if (collabStylesheetLoad !== undefined) return await collabStylesheetLoad;
  const existing = document.querySelector<HTMLLinkElement>("link[data-omp-collab-styles]");
  if (existing !== null) return existing;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = __COLLAB_CLIENT_STYLESHEET__;
  link.dataset.ompCollabStyles = "true";
  const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => reject(new Error("collaboration client stylesheet failed to load")), {
      once: true,
    });
  });
  collabStylesheetLoad = loaded;
  document.head.append(link);
  try { return await loaded; }
  catch (error) { collabStylesheetLoad = undefined; link.remove(); throw error; }
}

let collabClientWarmed = false;

/**
 * Import the pinned collaboration client while the directory idles so a later View/Control tap
 * only pays for the launch POST and relay connect. Module only: applying the client stylesheet
 * here would let its own :root/body theme rules restyle the directory, so CSS bytes are warmed by
 * the build-emitted `<link rel="preload" as="style">` and applied first at launch. Any failure
 * falls back to the launch-time import; no capability is involved.
 */
function warmCollabClient(): void {
  if (collabClientWarmed) return;
  collabClientWarmed = true;
  const idle: (callback: () => void) => unknown =
    typeof requestIdleCallback === "function" ? requestIdleCallback : queueMicrotask;
  idle(() => {
    try {
      void importCollabClient(__COLLAB_CLIENT_MODULE__).catch(() => undefined);
    } catch {
      // Environments without the module define (unit harness) keep the launch-time import path.
    }
  });
}

function captureDirectorySnapshot(): DashboardSnapshot {
  if (dashboardSnapshot === undefined) {
    // Reattaching cached rows must not replay a completed or interrupted arrival.
    const arrived = sessionList.querySelector<HTMLElement>(".all-clear-summary");
    if (arrived !== null) delete arrived.dataset.arrived;
    const historyState: DirectoryHistoryState = {
      version: 2,
      scope: selectedScope,
      scrollY: window.scrollY,
      order: [...sessionList.querySelectorAll<HTMLElement>("[data-instance-id]")]
        .flatMap(element => {
          const current = sessions.get(sessionKey({
            sourceKey: element.dataset.sourceKey ?? localKey, instanceId: element.dataset.instanceId ?? "",
          }));
          return current === undefined ? [] : [{ sourceKey: current.sourceKey, instanceId: current.instanceId, generation: current.generation }];
        }),
    };
    dashboardSnapshot = {
      children: [...document.body.children] as HTMLElement[],
      scrollY: historyState.scrollY,
      title: document.title,
      bodyClass: document.body.className,
      historyState,
      signature: renderedSignature,
    };
  }
  return dashboardSnapshot;
}

function enterCollabClient(
  capability: string,
  startCollabWithCapability: StartCollabWithCapability,
  session: SessionMetadata,
  mode: LaunchMode,
  requestId?: string,
  originTile: HTMLElement | null = null,
  presentation: LaunchPresentation = "full",
): void {
  setStatus("ready", "");
  const fromDirectory = activeCollabShell === undefined;
  const snapshot = captureDirectorySnapshot();
  const previousShell = activeCollabShell;
  // A successor may have waited through promotion; placement belongs to the live predecessor,
  // not to the presentation captured when its launch request began.
  presentation = previousShell?.presentation ?? presentation;
  disposeActiveCollab?.();
  if (presentation === "request-tray") previousShell?.shell.remove();

  const shell = document.createElement("div");
  shell.className = "gateway-shell";
  const bar = document.createElement("header");
  bar.className = "shell-bar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "shell-back";
  back.textContent = "← Sessions";
  back.addEventListener("click", () => {
    if (shellState.presentation === "request-tray") returnToDirectory();
    else history.back();
  });
  const title = createTitleElement("span", "shell-title", session);
  const control = document.createElement("button");
  control.type = "button";
  control.className = "shell-control";
  control.textContent = "Control";
  control.hidden = mode === "control" || !session.canControl;
  control.addEventListener("click", () => {
    const current = sessions.get(sessionKey(session)) ?? session;
    void launch(current, "control", control, current.ask?.requestId, shellState.scope);
  });
  const connection = createTextElement("span", "conn-chip", "Connecting…");
  setConnectionState(connection, "connecting", "Connecting…");
  connection.setAttribute("role", "status");
  connection.setAttribute("aria-live", "polite");
  connection.setAttribute("aria-atomic", "true");
  const shellActions = document.createElement("span");
  shellActions.className = "shell-actions";
  shellActions.append(control, connection);
  const headingCopy = document.createElement("span");
  headingCopy.className = "shell-heading-copy";
  headingCopy.append(title);
  if (sources.size > 1) headingCopy.append(createTextElement("span", "host-label shell-host", hostLabel(session)));
  const heading = document.createElement("span");
  heading.className = "shell-heading";
  heading.append(createSessionTile(session), headingCopy);
  bar.append(back, heading, shellActions);

  const container = document.createElement("div");
  container.id = "root";
  container.setAttribute("role", "application");
  container.setAttribute("aria-label", "OMP collaboration session");
  const triageBar = document.createElement("aside");
  triageBar.className = "triage-bar";
  triageBar.hidden = true;
  shell.append(bar, container, triageBar);
  let triageSwipeStart: number | undefined;
  shell.addEventListener("pointerdown", event => {
    if (
      triageBar.dataset.dismissible === "true" &&
      event.target !== null &&
      !triageBar.contains(event.target as Node)
    ) {
      hideTriageBar(activeCollabShell ?? shellState);
    }
  });
  shell.addEventListener("keydown", event => {
    // A client-owned chooser can consume Escape by restoring focus without cancelling its
    // default action. Do not turn that same gesture into a native dialog close request.
    if (event.key === "Escape" && event.target !== document.activeElement) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && triageBar.dataset.dismissible === "true") {
      event.preventDefault();
      hideTriageBar(activeCollabShell ?? shellState);
    }
  });
  triageBar.addEventListener("pointerdown", event => {
    triageSwipeStart = triageBar.dataset.dismissible === "true" ? event.clientY : undefined;
  });
  triageBar.addEventListener("pointerup", event => {
    if (triageSwipeStart !== undefined && Math.abs(event.clientY - triageSwipeStart) >= 32) {
      hideTriageBar(activeCollabShell ?? shellState);
    }
    triageSwipeStart = undefined;
  });
  triageBar.addEventListener("pointercancel", () => {
    triageSwipeStart = undefined;
  });

  if (session.sourceKey === localKey) {
    snapshotController?.abort();
    snapshotController = undefined;
    clearReconnectTimeout();
    reconnectAttempt = 0;
  }
  const commitHistory = location.pathname !== "/client/";
  const commit = (): void => {
    originTile?.style.setProperty("view-transition-name", "");
    if (presentation === "request-tray") {
      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "tray-expand";
      expand.setAttribute("aria-label", "Expand to full screen");
      expand.append(createExpandIcon());
      const promote = (): void => tray.promote(() => {
        if (activeCollabShell !== shellState || shellState.presentation !== "request-tray") return;
        if (shellState.latestEmbedState?.gatewayHealth.state === "forbidden") {
          void restoreDirectory();
          return;
        }
        // Reparent, never remount: the client, relay and unsent composer draft stay alive.
        shellState.presentation = "full";
        shellActions.append(connection);
        document.body.append(shell);
        tray.close(true, true);
        document.body.className = "collab-shell-active";
        document.body.replaceChildren(shell);
        // The same history shape as a full launch, so system back returns to the directory.
        history.replaceState({ ompDirectory: snapshot.historyState }, "", "/");
        history.pushState({ ompCollab: true }, "", "/client/");
      });
      expand.addEventListener("click", promote);
      tray.replace({
        id: "request", title: spokenTitle(session), tone: "attention", body: shell,
        icon: createSessionTile(session), actions: [connection, expand], layout: "expanded",
      });
      tray.heading?.addEventListener("click", promote);
      history.replaceState({ ompCollab: true }, "", "/");
      document.title = `${spokenTitle(session)} · OMP Sessions`;
      return;
    }
    tray.close(true, tray.id === "request" || tray.id?.startsWith("creation-") === true);
    if (commitHistory) {
      history.replaceState({ ompDirectory: snapshot.historyState }, "", "/");
      history.pushState({ ompCollab: true }, "", "/client/");
    }
    document.body.className = "collab-shell-active";
    document.body.replaceChildren(shell);
    document.title = `${spokenTitle(session)} · OMP Sessions`;
  };
  // Only a launch from the directory travels: the row's tile becomes the header tile while the
  // directory slides out. Shell-to-shell launches (Control, Next) replace the shell in place.
  if (fromDirectory) {
    originTile?.style.setProperty("view-transition-name", "session-tile");
    transitionNavigation("forward", commit);
  } else {
    commit();
  }

  const shellState: ActiveCollabShell = {
    sourceKey: session.sourceKey,
    scope: selectedScope,
    instanceId: session.instanceId,
    generation: session.generation,
    ...(requestId === undefined ? {} : { openedRequestId: requestId }),
    mode,
    presentation,
    connectionChip: connection,
    triageBar,
    shell,
    answerShown: false,
    answerTriageVisible: false,
    hasBeenLive: false,
  };
  activeCollabShell = shellState;
  // A live shell supersedes any disposed predecessor, so the bfcache restore path must not fire.
  collabShellDisposedOnPageHide = false;
  disposedShellResume = undefined;

  const updateConnection = (state: CollabEmbedState): void => {
    shellState.latestEmbedState = state;
    renderConnectionState(shellState);
    reconcileActiveCollabShell();
  };

  let disposeClient = (): void => undefined;
  const removeLifecycleListeners = (): void => {
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("popstate", handlePopState);
  };
  const dispose = (): void => {
    if (initialPromptDraft !== undefined && sameBinding(initialPromptDraft.ref, shellState)) clearCreationDraft();
    hideTriageBar(shellState, false);
    clearConnectionTimers(shellState);
    removeLifecycleListeners();
    disposeClient();
    disposeClient = (): void => undefined;
    if (activeCollabShell === shellState) activeCollabShell = undefined;
    if (disposeActiveCollab === dispose) disposeActiveCollab = undefined;
  };
  const handlePageHide = (): void => {
    collabShellDisposedOnPageHide = true;
    disposedShellResume = {
      sourceKey: session.sourceKey,
      scope: shellState.scope,
      instanceId: session.instanceId,
      generation: session.generation,
      mode,
      presentation: shellState.presentation,
      ...(requestId === undefined ? {} : { requestId }),
    };
    dispose();
  };
  const handlePopState = (event: PopStateEvent): void => {
    returnToDirectory(event.state);
  };
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("popstate", handlePopState);
  try {
    disposeClient = startCollabWithCapability(
      container,
      capability,
      () => {
        // The client has already unmounted itself. Restore the cached directory synchronously so a
        // failed location.replace() cannot strand an inert shell without lifecycle listeners.
        disposeClient = (): void => undefined;
        returnToDirectory();
      },
      {
        focusPendingRequest: requestId !== undefined,
        shellOwnsLifecycle: true,
        onStateChange: updateConnection,
        browserRecognitionEnabled,
        takeInitialPromptDraft: () => {
          const holder = initialPromptDraft;
          if (holder === undefined || !sameBinding(holder.ref, shellState)) return undefined;
          clearCreationDraft();
          return holder.text;
        },
        probeGateway: signal => probeSource(session.sourceKey, signal),
      },
    );
    disposeActiveCollab = dispose;
  } catch (error) {
    dispose();
    returnToDirectory();
    throw error;
  }
}

async function launch(
  session: SessionMetadata,
  mode: LaunchMode,
  button?: HTMLButtonElement,
  requestId?: string,
  scope = selectedScope,
  presentation: LaunchPresentation = activeCollabShell?.presentation ?? "full",
  creationHandoff = false,
): Promise<boolean> {
  if (!creationHandoff) {
    const retryDraft = initialPromptDraft !== undefined && sameBinding(initialPromptDraft.ref, session) && mode === "control"
      ? initialPromptDraft : undefined;
    creation.cancel("competing");
    initialPromptDraft = retryDraft;
  }
  if (initialPromptDraft !== undefined && (!sameBinding(initialPromptDraft.ref, session) || mode !== "control")) clearCreationDraft();
  if (!sourceFresh(session.sourceKey)) return false;
  const source = sources.get(session.sourceKey);
  if (source === undefined) return false;
  selectedScope = scope;
  hostPicker.value = scope;
  pendingNotificationLaunch = undefined;
  pendingNotificationRoute = false;
  cancelLaunch();
  if (presentation === "request-tray" && activeCollabShell === undefined) {
    captureDirectorySnapshot();
    if (tray.id === "request") tray.close(true, true);
    const preview = document.createElement("div");
    preview.className = "request-preview";
    const requestStatus = createTextElement("p", "request-status", "Connecting…");
    requestStatus.setAttribute("role", "status");
    preview.append(createSessionSummary(session), createTextElement("p", "ask-preview", session.ask?.preview ?? "Waiting for your input"), requestStatus);
    tray.open({ id: "request", title: spokenTitle(session), tone: "attention", body: preview, icon: createSessionTile(session) }, {
      onClose: () => { void restoreDirectory(undefined, session); },
    });
  }
  const attempt: LaunchAttempt = {
    id: ++launchSequence, epoch: selectionEpoch,
    ref: { sourceKey: session.sourceKey, instanceId: session.instanceId, generation: session.generation,
      ...(requestId === undefined ? {} : { requestId }) },
    mode, presentation, creationHandoff, scope: selectedScope, sourceEpoch: remotes.get(session.sourceKey)?.epoch,
    controller: new AbortController(), settled: false,
  };
  pendingLaunch = attempt;
  const currentAttempt = (): boolean => {
    const current = sessions.get(sessionKey(attempt.ref));
    return pendingLaunch === attempt && !attempt.settled && !attempt.controller.signal.aborted &&
      selectionEpoch === attempt.epoch && selectedScope === attempt.scope &&
      remotes.get(attempt.ref.sourceKey)?.epoch === attempt.sourceEpoch &&
      sources.get(attempt.ref.sourceKey) === source && sourceFresh(attempt.ref.sourceKey) &&
      current?.generation === attempt.ref.generation &&
      (requestId === undefined || current.ask?.requestId === requestId);
  };
  const sourceShell = activeCollabShell;
  // A row keeps its tile, title and facts while it opens (they travel into the shell); only a
  // text-only action swaps its label.
  const originTile = button?.closest<HTMLElement>("[data-instance-id]")?.querySelector<HTMLElement>(".session-tile") ?? null;
  const labelOnly = button !== undefined && button.querySelector(".session-tile") === null;
  const idleLabel = button?.textContent ?? (mode === "view" ? "View" : "Control");
  if (button !== undefined) {
    button.disabled = true;
    button.dataset.busy = "true";
    button.setAttribute("aria-busy", "true");
    if (labelOnly) button.textContent = mode === "view" ? "Opening view…" : "Opening control…";
  } else if (sourceShell === undefined && session.sourceKey === localKey) {
    setStatus("loading", mode === "view" ? "Opening view…" : "Opening control…");
  }
  const settle = (): void => {
    attempt.settled = true;
    if (attempt.deadline !== undefined) {
      window.clearTimeout(attempt.deadline);
      delete attempt.deadline;
    }
    if (pendingLaunch === attempt) pendingLaunch = undefined;
  };

  const resetButton = (): void => {
    if (button === undefined) return;
    button.disabled = !sourceFresh(session.sourceKey) || (mode === "view" ? !session.canView : !session.canControl);
    delete button.dataset.busy;
    button.removeAttribute("aria-busy");
    if (labelOnly) button.textContent = idleLabel;
  };
  let stylesheet: HTMLLinkElement | undefined;
  let startCollabWithCapability: StartCollabWithCapability;
  const discard = (): false => {
    const owned = pendingLaunch === attempt;
    settle();
    resetButton();
    if (owned && creationHandoff && activeCollabShell === undefined && statusBanner.dataset.kind === "loading") setStatus("ready", "");
    if (owned && attempt.presentation === "request-tray" && activeCollabShell === undefined && tray.id === "request") {
      void restoreDirectory(undefined, session, false);
    }
    if (pendingLaunch === undefined && activeCollabShell === undefined && stylesheet !== undefined) {
      stylesheet.remove();
      collabStylesheetLoad = undefined;
    }
    applyActivatedWorkerUpdate();
    return false;
  };
  const fail = (kind: "offline" | "unauthorized" | "expired", message: string): boolean => {
    if (pendingLaunch !== attempt) return discard();
    settle();
    resetButton();
    const remoteFailure = session.sourceKey !== localKey;
    if (remoteFailure && kind !== "unauthorized") remoteLaunchFailures.set(session.sourceKey, message);
    if (sourceShell !== undefined && activeCollabShell === sourceShell) {
      if (remoteFailure) {
        showTriageBar(sourceShell, "launch-failed", kind === "unauthorized" ? message : `${source.label}: ${message}`, "Sessions",
          () => { void restoreDirectory(undefined, undefined, false); });
        return true;
      }
      showTriageBar(sourceShell, "reconnecting", message, "Try again", () => {
        showTriageBar(
          sourceShell,
          "sending",
          mode === "view" ? "Opening view…" : "Opening control…",
        );
        void launch(session, mode, button, requestId, scope, presentation);
      });
      return true;
    }
    // A concurrent launch may already have mounted a collaboration; its route and styles stay put.
    if (activeCollabShell === undefined) {
      if (location.pathname === "/client/") history.replaceState(null, "", "/");
      stylesheet?.remove();
      collabStylesheetLoad = undefined;
    }
    if (attempt.presentation === "request-tray" && activeCollabShell === undefined && tray.id === "request") {
      void restoreDirectory(undefined, session, false);
    }
    if (remoteFailure) {
      renderFleetStatus();
    } else setStatus(kind, message);
    applyActivatedWorkerUpdate();
    return false;
  };

  try {
    const [loadedStylesheet, collabClient] = await Promise.all([
      loadCollabStylesheet(),
      importCollabClient(__COLLAB_CLIENT_MODULE__),
    ]);
    stylesheet = loadedStylesheet;
    startCollabWithCapability = collabClient.startCollabWithCapability;
  } catch {
    fail("offline", "The collaboration client did not start. Try again.");
    return false;
  }

  if (!currentAttempt()) return discard();
  let response: Response;
  try {
    const remote = session.sourceKey !== localKey;
    if (remote) attempt.deadline = window.setTimeout(() => attempt.controller.abort(), 10_000);
    response = await fetch(`${remote ? source.origin : ""}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        generation: session.generation,
        ...(mode === "control" && requestId !== undefined ? { requestId } : {}),
      }),
      cache: "no-store",
      credentials: remote ? "omit" : "same-origin",
      ...(remote ? { mode: "cors" as const, redirect: "error" as const } : {}),
      signal: attempt.controller.signal,
    });
  } catch {
    fail("offline", "Gateway unavailable. Check your tailnet connection and try again.");
    return false;
  }

  if (attempt.controller.signal.aborted) {
    fail("offline", "Gateway unavailable. Check your tailnet connection and try again.");
    return false;
  }
  if (!currentAttempt()) return discard();
  if (!response.ok) {
    if (response.status === 403) {
      if (session.sourceKey === localKey) {
        withdrawLocalAuthorization();
        return discard();
      } else {
        fail("unauthorized", `Access withdrawn on ${source.label}. Choose another session.`);
        remotes.get(session.sourceKey)?.forbid();
        if (sourceShell !== undefined && activeCollabShell === sourceShell) {
          showTriageBar(sourceShell, "reconnecting", `Access withdrawn on ${source.label}. Choose another session.`, "Sessions", () => {
            void restoreDirectory();
          });
        }
        applyActivatedWorkerUpdate();
      }
    } else if (response.status === 404 || response.status === 409) {
      const preservedShell = fail("expired", "That session changed or expired. Try again.");
      if ((!preservedShell || session.sourceKey !== localKey) &&
        (session.sourceKey === localKey ? await refreshAndConnect() : await remotes.get(session.sourceKey)?.refresh() === "healthy")) {
        const message = "That session changed or expired. The list has been refreshed.";
        if (session.sourceKey === localKey) setStatus("expired", message);
        else {
          remoteLaunchFailures.set(session.sourceKey, message);
          renderFleetStatus();
          if (sourceShell !== undefined && activeCollabShell === sourceShell) {
            showTriageBar(sourceShell, "launch-failed", `${source.label}: ${message}`, "Sessions",
              () => { void restoreDirectory(undefined, undefined, false); });
          }
        }
      }
    } else {
      fail("offline", "The session could not be opened. Try again.");
    }
    return false;
  }

  let capability: string | undefined;
  try {
    const payload = parseLaunchResponse(await boundedJson(response, MAX_FRAME_BYTES));
    if (attempt.deadline !== undefined) {
      window.clearTimeout(attempt.deadline);
      delete attempt.deadline;
    }
    if (payload.mode !== mode || payload.generation !== session.generation) {
      throw new Error("invalid launch response");
    }
    if (attempt.controller.signal.aborted) {
      fail("offline", "Gateway unavailable. Check your tailnet connection and try again.");
      return false;
    }
    if (!currentAttempt()) return discard();
    if (remoteLaunchFailures.delete(session.sourceKey)) renderFleetStatus();
    capability = payload.capability;
    enterCollabClient(capability, startCollabWithCapability, session, mode, requestId, originTile, attempt.presentation);
    settle();
    capability = undefined;
    return true;
  } catch {
    capability = undefined;
    fail("offline", attempt.controller.signal.aborted
      ? "Gateway unavailable. Check your tailnet connection and try again."
      : "The gateway returned an invalid launch response.");
    return false;
  }
}

function applyEvent(event: SessionEvent, epoch: number): boolean {
  if (epoch !== directoryEpoch || event.revision < directoryRevision) return false;
  if (localObservationWithdrawn && event.type !== "snapshot") return false;
  directoryRevision = event.revision;
  authorizationDenied = false;
  directoryLoaded = true;
  localFresh = true;
  lastFreshAt = Date.now();
  clearLocalTransportFailure();
  if (event.type === "snapshot") {
    localObservationWithdrawn = false;
    replaceSessionSnapshot(event.sessions);
  } else if (event.type === "session_upsert") {
    const session = { ...event.session, sourceKey: localKey };
    const previous = sessions.get(sessionKey(session));
    if (previous?.ask !== undefined && previous.ask.requestId !== session.ask?.requestId) {
      observedAsks.delete(localRecordKey(previous, previous.ask.requestId));
    }
    sessions.set(sessionKey(session), session);
    observeAsk(session);
  } else {
    const key = sessionKey({ sourceKey: localKey, instanceId: event.instanceId });
    const current = sessions.get(key);
    if (current?.generation === event.generation) {
      if (current.ask !== undefined) observedAsks.delete(localRecordKey(current, current.ask.requestId));
      sessions.delete(key);
    }
  }
  if (event.type !== "snapshot") reconcileLocalRecords();
  render();
  reconcileActiveCollabShell();
  return true;
}

async function loadSnapshot(epoch: number): Promise<boolean> {
  const controller = new AbortController();
  snapshotController = controller;
  let timedOut = false;
  let responseReceived = false;
  const timeoutMs =
    directoryLoaded || transportFailureSince !== undefined || navigator.onLine === false
      ? RECOVERY_SNAPSHOT_TIMEOUT_MS
      : SNAPSHOT_TIMEOUT_MS;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (!directoryLoaded && transportFailureKind === undefined && !authorizationDenied && !localObservationWithdrawn) {
    setStatus("loading", "Loading sessions…");
  }
  try {
    const response = await fetch("/api/v1/sessions", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    responseReceived = true;
    if (epoch !== directoryEpoch) return false;
    if (response.status === 403) {
      withdrawLocalAuthorization();
      return false;
    }
    if (!response.ok) throw new Error("snapshot failed");
    const payload = parseSessionListResponse(await response.json());
    if (epoch !== directoryEpoch || payload.revision < directoryRevision) return false;
    directoryRevision = payload.revision;
    authorizationDenied = false;
    localObservationWithdrawn = false;
    directoryLoaded = true;
    localFresh = true;
    lastFreshAt = Date.now();
    clearLocalTransportFailure();
    replaceSessionSnapshot(payload.sessions);
    render();
    setStatus("ready", "");
    return true;
  } catch {
    if (epoch !== directoryEpoch || (controller.signal.aborted && !timedOut)) return false;
    localFresh = false;
    render();
    authorizationDenied = false;
    showTransportFailure(
      navigator.onLine === false ? "offline" : timedOut || responseReceived ? "desktop" : "tailnet",
    );
    return false;
  } finally {
    window.clearTimeout(timeout);
    if (snapshotController === controller) snapshotController = undefined;
  }
}

function connectEvents(epoch: number): void {
  if (authorizationDenied || epoch !== directoryEpoch) return;
  const source = new EventSource("/api/v1/events", { withCredentials: true });
  events = source;
  let opened = false;
  source.onopen = () => {
    if (events !== source || epoch !== directoryEpoch) return;
    if (opened) directoryRevision = -1;
    opened = true;
    clearReconnectTimeout();
    reconnectAttempt = 0;
    eventStreamStale = false;
    armEventLiveness(source, epoch);
  };
  for (const type of ["snapshot", "session_upsert", "session_remove"] as const) {
    source.addEventListener(type, event => {
      if (events !== source || epoch !== directoryEpoch) return;
      if (eventStreamStale) {
        failEventStream(source, epoch);
        return;
      }
      armEventLiveness(source, epoch);
      try {
        if (applyEvent(parseSessionEvent(JSON.parse(event.data)), epoch) && !notificationRouteStatusLocked) {
          setStatus("ready", "");
        }
      } catch {
        failEventStream(source, epoch);
      }
    });
  }
  source.addEventListener("keepalive", () => {
    if (events !== source || epoch !== directoryEpoch) return;
    if (localObservationWithdrawn) return;
    if (eventStreamStale) {
      failEventStream(source, epoch);
      return;
    }
    lastFreshAt = Date.now();
    localFresh = true;
    clearLocalTransportFailure();
    armEventLiveness(source, epoch);
    if (!notificationRouteStatusLocked) setStatus("ready", "");
  });
  source.onerror = () => {
    // Native EventSource reconnects on network restoration even when Android Chrome loses a
    // scheduled JavaScript timer. Keep that browser-owned recovery path alive; the snapshot retry
    // remains a bounded fallback and will close this source if it fires first.
    markEventStreamInterrupted(source, epoch);
  };
}

async function resolvePendingNotificationRoute(): Promise<void> {
  if (!pendingNotificationRoute) return;
  pendingNotificationRoute = false;
  const pending = pendingNotificationLaunch;
  pendingNotificationLaunch = undefined;
  const session = pending === undefined ? undefined : sessions.get(sessionKey({ sourceKey: localKey, instanceId: pending.instanceId }));
  // A tap for the collaboration this page already shows keeps it: an activity stop never
  // downgrades Control to View, and an attention tap relaunches only to gain Control.
  const shell = activeCollabShell;
  const shown =
    shell !== undefined &&
    session !== undefined &&
    shell.sourceKey === localKey &&
    shell.instanceId === session.instanceId &&
    shell.generation === session.generation;
  if (pending?.kind === "activity_stop" && session?.generation === pending.generation && session.canView) {
    if (shown) return;
    selectedScope = localKey;
    if (shell !== undefined) showTriageBar(shell, "sending", "Opening view…");
    await launch(session, "view");
  } else if (
    pending?.kind === "attention" &&
    session?.ask?.requestId === pending.requestId &&
    session.inputRequired &&
    session.canControl
  ) {
    if (shown && shell.mode === "control") return;
    selectedScope = localKey;
    if (shell !== undefined) showTriageBar(shell, "sending", "Opening control…");
    await launch(session, "control", undefined, pending.requestId);
  } else if (shell !== undefined) {
    // The collaboration stays open. The directory banner is hidden behind it, so say so in the
    // triage bar, unless that bar already holds a live prompt such as Hold for the open ask.
    if (shell.triageBar.hidden) showTriageBar(shell, "clear", "That alert changed or expired.", "Sessions", returnToDirectory);
  } else {
    setStatus("expired", "That notification changed or expired. Choose a current session.");
    applyActivatedWorkerUpdate();
  }
}

let fleetRecovery: Promise<void> | undefined;
async function refreshAndConnect(resetBackoff = true): Promise<boolean> {
  for (const remote of remotes.values()) remote.setVisible(document.visibilityState === "visible");
  if (resetBackoff) reconnectAttempt = 0;
  clearReconnectTimeout();
  const epoch = directoryEpoch + 1;
  directoryEpoch = epoch;
  directoryRevision = -1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  events = undefined;
  clearEventLiveness();
  eventStreamStale = false;
  const loaded = await loadSnapshot(epoch);
  if (loaded && epoch === directoryEpoch) {
    if (fleetBootstrapFailed) {
      fleetRecovery ??= initializeFleet().finally(() => { fleetRecovery = undefined; });
      await fleetRecovery;
      if (epoch !== directoryEpoch) return false;
      render();
      setStatus("ready", "");
    }
    reconnectAttempt = 0;
    connectEvents(epoch);
    warmCollabClient();
    await resolvePendingNotificationRoute();
    return true;
  }
  if (!authorizationDenied && epoch === directoryEpoch) scheduleReconnect();
  return false;
}
hostPicker.addEventListener("change", () => {
  creation.cancel("selection");
  clearCreationDraft();
  selectedScope = sources.has(hostPicker.value) ? hostPicker.value : "all";
  selectionEpoch += 1;
  cancelLaunch();
  pendingNotificationLaunch = undefined;
  pendingNotificationRoute = false;
  history.replaceState({ ompDirectory: { version: 2, scope: selectedScope, order: [], scrollY: window.scrollY } }, "", "/");
  render();
  applyActivatedWorkerUpdate();
});
for (const id of ["#new-session", "#empty-new-session"]) {
  requiredElement<HTMLButtonElement>(id).addEventListener("click", () => {
    cancelLaunch();
    clearCreationDraft();
    creation.open();
  });
}
settingsButton.addEventListener("click", openAlerts);
trayHost.addEventListener("close", maybeStartFirstRun);
notificationButton.addEventListener("click", () => void toggleBackgroundNotifications());
alertDetailButton.addEventListener("click", () => tray.push({
  id: "detail", title: "Alert detail", tone: "neutral", body: detailPanel,
}));
undoButton.addEventListener("click", undoPendingDismissal);
for (const input of notificationDetailInputs) {
  input.addEventListener("change", () => {
    if (!input.checked || notificationRegistration === undefined) return;
    const detailLevel = input.value as PushDetailLevel;
    if (tray.id === "detail") tray.pop();
    void (async () => {
      const subscription = await notificationRegistration?.pushManager.getSubscription();
      if (subscription === null || subscription === undefined) return;
      try {
        selectNotificationDetail(await savePushSubscription(subscription, detailLevel));
      } catch {
        selectNotificationDetail(currentNotificationDetail);
      }
    })();
  });
}
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  for (const remote of remotes.values()) remote.setVisible(document.visibilityState === "visible");
  if (collabShellDisposedOnPageHide) {
    void resumeDisposedCollabShell();
    return;
  }
  void refreshAndConnect();
});
window.addEventListener("online", () => {
  for (const remote of remotes.values()) {
    remote.setVisible(document.visibilityState === "visible");
    void remote.refresh(true);
  }
  void refreshAndConnect();
});
window.addEventListener("pagehide", () => {
  creation.cancel("pagehide");
  clearCreationDraft();
  const attempt = pendingLaunch;
  if (attempt?.presentation === "request-tray" && activeCollabShell === undefined) {
    disposedShellResume = {
      ...attempt.ref, scope: attempt.scope, mode: attempt.mode, presentation: attempt.presentation,
    };
    collabShellDisposedOnPageHide = true;
  }
  selectionEpoch += 1;
  // Keep the directory snapshot beside the metadata-only intent until persisted pageshow revalidates it.
  cancelLaunch(undefined, false);
  for (const remote of remotes.values()) remote.setVisible(false);
});
window.addEventListener("popstate", () => {
  creation.cancel("selection");
  clearCreationDraft();
  selectionEpoch += 1;
  cancelLaunch();
});
window.addEventListener("offline", () => {
  localFresh = false;
  render();
  for (const remote of remotes.values()) remote.interrupt();
  directoryEpoch += 1;
  directoryRevision = -1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  clearEventLiveness();
  clearReconnectTimeout();
  reconnectAttempt = 0;
  eventStreamStale = false;
  events = undefined;
  authorizationDenied = false;
  showTransportFailure("offline");
  // `online` is not a dependable wake-up. Issue #65 measured `navigator.onLine` reporting true
  // through a total outage on the device, so an offline state whose only exit is an `online` event
  // is a state the page can never leave. Keep the bounded retry chain running instead.
  scheduleReconnect();
});

/**
 * A frozen page cannot read the directory stream, but Chrome keeps the connection open and the
 * phone keeps waking for its five-second keepalives. On a Pixel 10 Pro (Android 17, Chrome 154) a
 * backgrounded directory received them for all of a twelve-minute measurement; the same Chrome
 * delivered `freeze` 60 seconds after the page was hidden. Release the stream then, without a
 * failure or a retry: nothing failed, and becoming visible rebuilds it from a fresh snapshot.
 */
document.addEventListener("freeze", () => {
  if (creation.isActive) cancelLaunch();
  creation.cancel("background");
  localFresh = false;
  for (const remote of remotes.values()) remote.setVisible(false);
  directoryEpoch += 1;
  directoryRevision = -1;
  snapshotController?.abort();
  snapshotController = undefined;
  events?.close();
  events = undefined;
  clearEventLiveness();
  clearReconnectTimeout();
  eventStreamStale = false;
});

/**
 * Resume is a recovery signal Android actually delivers, so treat it as one.
 *
 * A page frozen across a network change has no way to notice the change: its timers did not run and
 * its `EventSource` still reports open. `pageshow` does not cover this — it fires for a bfcache
 * restore, not for freeze/resume of the foreground page. So on resume, unless the stream can be
 * shown to be live, throw the whole connection away and build a new one now rather than waiting out
 * a timer that was frozen with it.
 */
document.addEventListener("visibilitychange", () => {
  for (const remote of remotes.values()) {
    remote.setVisible(document.visibilityState === "visible");
    if (document.visibilityState === "visible") void remote.refresh(true);
  }
  if (document.visibilityState !== "visible") {
    if (creation.isActive) cancelLaunch();
    creation.cancel("background");
    resetTransportGuidance();
    return;
  }
  maybeStartFirstRun();
  if (authorizationDenied || directoryStreamIsLive()) return;
  if (transportFailureKind !== undefined) showTransportFailure(transportFailureKind);
  localFresh = false;
  render();
  void refreshAndConnect();
});

const applicationWorkerRegistration = initializeApplicationWorker();
void initializeNotifications(applicationWorkerRegistration);
await initializeFleet();
await refreshAndConnect();
