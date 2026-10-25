import { afterAll, describe, expect, mock, test } from "bun:test";
import { MAX_FRAME_BYTES, MAX_SESSIONS, type SessionMetadata } from "@omp-session-gateway/protocol";
import fc, { type AsyncCommand } from "fast-check";
import type { CollabEmbedOptions } from "../../../packages/collab-client/upstream/src/embed-contract";

let embedStart: (options: CollabEmbedOptions) => () => void;
mock.module("fleet-test-collab", () => ({
  startCollabWithCapability(_container: unknown, _capability: string, _dispose: () => void, options: CollabEmbedOptions): () => void {
    return embedStart(options);
  },
}));

const GLOBAL_NAMES = [
  "window",
  "document",
  "location",
  "navigator",
  "Notification",
  "MessageChannel",
  "PushManager",
  "history",
  "EventSource",
  "fetch",
  "localStorage",
  "HTMLElement",
  "__COLLAB_CLIENT_MODULE__",
  "__COLLAB_CLIENT_STYLESHEET__",
] as const;
const nativeGlobals = Object.fromEntries(
  GLOBAL_NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
) as Record<(typeof GLOBAL_NAMES)[number], PropertyDescriptor | undefined>;

// A frozen renderer runs no timers while wall-clock time keeps moving, so the test clock has to
// advance independently of the fake timers.
const nativeNow = Date.now;
let clockOffset = 0;

Date.now = (): number => nativeNow() + clockOffset;
class FakeStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeElement extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  checked = false;
  className = "";
  disabled = false;
  hidden = false;
  id = "";
  open = false;
  type = "";
  value = "";
  parent: FakeElement | undefined;

  constructor(readonly tagName: string, private ownText = "") {
    super();
  }

  /** Text lives in `#text` children, as in the DOM, so mixed text and element children read back whole. */
  get textContent(): string | null {
    if (this.tagName === "#text") return this.ownText;
    return this.children.map(child => child.textContent ?? "").join("");
  }

  set textContent(value: string | null) {
    this.children.splice(0, this.children.length);
    if (value !== null && value !== "") this.append(value);
  }

  get childElementCount(): number {
    return this.children.filter(child => child.tagName !== "#text").length;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeElement("#text", node) : node;
      this.children.push(child);
      child.parent = this;
      if (child.tagName === "link") queueMicrotask(() => child.dispatchEvent(new Event("load")));
    }
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  remove(): void {
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.children.splice(index, 1);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  toggleAttribute(name: string, force?: boolean): void {
    const present = force ?? !this.attributes.has(name);
    if (present) this.attributes.set(name, "");
    else this.attributes.delete(name);
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement): boolean => {
      if (selector.startsWith(".")) return element.className.split(/\s+/u).includes(selector.slice(1));
      if (selector.startsWith("#")) return element.id === selector.slice(1);
      if (selector === "[data-instance-id]") return element.dataset.instanceId !== undefined;
      if (selector === "link[data-omp-collab-styles]") return element.tagName === "link" && element.dataset.ompCollabStyles !== undefined;
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const found: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (matches(element)) found.push(element);
      for (const child of element.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return found;
  }
}

class FakeMessagePort {
  peer: FakeMessagePort | undefined;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  close(): void {}

  start(): void {}

  postMessage(data: unknown): void {
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class FakeWindow extends EventTarget {
  readonly opened: string[] = [];
  readonly timers = new Map<number, { readonly callback: () => void; readonly delay: number }>();
  scrollY = 0;
  #nextTimer = 1;

  matchMedia(): { matches: boolean; addEventListener(): void } {
    return { matches: false, addEventListener(): void {} };
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  setTimeout(callback: () => void, delay = 0): number {
    const handle = this.#nextTimer;
    this.#nextTimer += 1;
    this.timers.set(handle, { callback, delay });
    return handle;
  }

  runTimers(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const timer of pending) timer.callback();
  }

  runTimersWithDelay(delay: number): void {
    for (const [handle, timer] of [...this.timers]) {
      if (timer.delay !== delay) continue;
      this.timers.delete(handle);
      timer.callback();
    }
  }

  pendingDelays(): number[] {
    return [...this.timers.values()].map(timer => timer.delay);
  }

  /** Handles are monotonic, so a mark separates timers armed before an action from those it armed. */
  timerMark(): number {
    return this.#nextTimer;
  }

  pendingDelaysSince(mark: number): number[] {
    return [...this.timers].filter(([handle]) => handle >= mark).map(([, timer]) => timer.delay);
  }

  runTimersSince(mark: number): void {
    for (const [handle, timer] of [...this.timers]) {
      if (handle < mark) continue;
      this.timers.delete(handle);
      timer.callback();
    }
  }

  scrollTo(_x: number, y: number): void {
    this.scrollY = y;
  }

  open(url?: string | URL): null {
    this.opened.push(String(url));
    return null;
  }
}

class FakeDocument extends EventTarget {
  readonly head = new FakeElement("head");
  readonly body = new FakeElement("body");
  title = "OMP Sessions";
  readonly documentElement = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  };
  visibilityState: "visible" | "hidden" = "visible";

  constructor(
    readonly bySelector: Record<string, FakeElement>,
    readonly detailInputs: readonly FakeElement[],
  ) {
    super();
    this.body.append(...Object.values(bySelector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.bySelector[selector] ?? this.head.querySelector(selector) ?? this.body.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === 'input[name="notification-detail"]' ? [...this.detailInputs] : [];
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  /** Chrome on Android hides a backgrounded page at once and freezes it about a minute later. */
  setVisibility(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }

  freeze(): void {
    this.dispatchEvent(new Event("freeze"));
  }
}

class FakeEventSource extends EventTarget {
  static readonly instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "snapshot" | "session_upsert" | "session_remove" | "keepalive", payload: unknown): void {
    const event = new Event(type);
    Object.defineProperty(event, "data", { value: JSON.stringify(payload) });
    this.dispatchEvent(event);
  }
}

class FakeBrowserNotification {
  closed = false;

  constructor(
    readonly tag: string,
    readonly data: unknown,
  ) {}

  close(): void {
    this.closed = true;
  }
}

interface BrowserHarness {
  readonly elements: {
    readonly sessionList: FakeElement;
    readonly notificationButton: FakeElement;
    readonly notificationDisclosure: FakeElement;
    readonly notificationSettings: FakeElement;
    readonly networkRecoveryHelp: FakeElement;
    readonly settingsButton: FakeElement;
    readonly notificationDetailOptions: FakeElement;
    readonly emptyState: FakeElement;
    readonly notificationDetailInputs: readonly FakeElement[];
    readonly statusBanner: FakeElement;
    readonly directoryTitle: FakeElement;
    readonly directoryCount: FakeElement;
    readonly hostPicker: FakeElement;
    readonly fleetStatus: FakeElement;
    readonly localActionToast: FakeElement;
    readonly localActionToastCopy: FakeElement;
    readonly localActionToastUndo: FakeElement;
  };
  disconnectEvents(): void;
  expireEventLiveness(): void;
  runTimers(): void;
  runUndoTimer(): void;
  pendingDelays(): number[];
  timerMark(): number;
  pendingDelaysSince(mark: number): number[];
  runTimersSince(mark: number): void;
  setVisibility(state: "visible" | "hidden"): void;
  freeze(): void;
  advanceClock(milliseconds: number): void;
  hangNextListRequest(): void;
  failNextListRequest(): void;
  setOnline(online: boolean): void;
  activateWorker(): void;
  readonly reloads: { count: number };
  readonly fetchPaths: string[];
  readonly fetchLocations: string[];
  readonly permissionRequests: { count: number };
  readonly subscriptionRequests: unknown[];
  readonly unsubscribeRequests: unknown[];
  readonly subscriptionCalls: { subscribe: number; unsubscribe: number };
  readonly workerMessages: unknown[];
  readonly replacedPaths: readonly string[];
  readonly window: FakeWindow;
  readonly localStorage: FakeStorage;
  readonly notifications: readonly FakeBrowserNotification[];
  readonly body: FakeElement;
  readonly launchRequests: { path: string; init: RequestInit }[];
  readonly embedCalls: CollabEmbedOptions[];
  readonly disposals: { count: number };
  setRemoteStatus(status: number): void;
  notify(data: unknown): void;
  addNotification(tag: string, data: unknown): FakeBrowserNotification;
  emit(type: "snapshot" | "session_upsert" | "session_remove" | "keepalive", payload: unknown): void;
  setList(revision: number, sessions: readonly SessionMetadata[], status?: number): void;
}

function session(
  instanceId: string,
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  const merged = {
    instanceId,
    generation: 1,
    title: instanceId,
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-21T10:00:00.000Z",
    lastSeenAt: "2026-07-21T10:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
    ...overrides,
  };
  if (!merged.inputRequired || merged.ask !== undefined) return merged;
  return {
    ...merged,
    ask: {
      requestId: `request-${instanceId.replaceAll(/[^A-Za-z0-9_-]/gu, "-")}`,
      since: merged.lastSeenAt,
    },
  };
}

async function settleUntil(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("dashboard state did not settle");
}

async function bootApp(options: {
  readonly permission: NotificationPermission;
  readonly initialSessions: readonly SessionMetadata[];
  readonly workerResponse?: unknown;
  readonly permissionResult?: NotificationPermission;
  readonly existingSubscription?: boolean;
  /** WebKit's `toJSON()` omits `expirationTime` when it is null; Chromium includes it. */
  readonly webkitSubscriptionJson?: boolean;
  readonly pathname?: string;
  readonly search?: string;
  readonly storage?: FakeStorage;
  readonly clientConfig?: unknown;
  readonly clientConfigStatus?: number;
  readonly remoteSessions?: readonly SessionMetadata[];
  readonly remotePayload?: unknown;
  readonly launchGate?: Promise<void>;
  readonly launchResponse?: (path: string, init: RequestInit) => Promise<Response>;
  readonly suffix: string;
}): Promise<BrowserHarness> {
  FakeEventSource.instances.length = 0;
  clockOffset = 0;
  const sessionList = new FakeElement("section");
  const emptyState = new FakeElement("section");
  const statusBanner = new FakeElement("div");
  const notificationButton = new FakeElement("button");
  notificationButton.textContent = "Checking background alerts…";
  notificationButton.disabled = true;
  const notificationDisclosure = new FakeElement("p");
  const notificationSettings = new FakeElement("dialog");
  const networkRecoveryHelp = new FakeElement("dialog");
  const networkRecoveryHelpClose = new FakeElement("button");
  const notificationSettingsClose = new FakeElement("button");
  const settingsButton = new FakeElement("button");
  const notificationDetailOptions = new FakeElement("fieldset");
  notificationDetailOptions.hidden = true;
  const localActionToast = new FakeElement("aside");
  localActionToast.hidden = true;
  const localActionToastCopy = new FakeElement("span");
  const localActionToastUndo = new FakeElement("button");
  const notificationDetailInputs = (["private", "session", "preview"] as const).map(value => {
    const input = new FakeElement("input");
    input.type = "radio";
    input.value = value;
    input.checked = value === "session";
    return input;
  });
  const directoryTitle = new FakeElement("h1");
  directoryTitle.textContent = "Sessions";
  const directoryCount = new FakeElement("p");
  directoryCount.hidden = true;
  const hostPicker = new FakeElement("select");
  const fleetStatus = new FakeElement("section");
  const bySelector: Record<string, FakeElement> = {
    "#session-list": sessionList,
    "#empty-state": emptyState,
    "#status-banner": statusBanner,
    "#notify": notificationButton,
    "#notify-note": notificationDisclosure,
    "#directory-title": directoryTitle,
    "#directory-count": directoryCount,
    "#host-picker": hostPicker,
    "#host-picker-label": new FakeElement("label"),
    "#fleet-status": fleetStatus,
    "#alert-scope": new FakeElement("p"),
    "#local-action-toast": localActionToast,
    "#local-action-toast-copy": localActionToastCopy,
    "#local-action-toast-undo": localActionToastUndo,
    "#notification-settings": notificationSettings,
    "#notification-settings-close": notificationSettingsClose,
    "#settings": settingsButton,
    "#notification-detail-options": notificationDetailOptions,
    "#network-recovery-help": networkRecoveryHelp,
    "#network-recovery-help-close": networkRecoveryHelpClose,
  };
  const document = new FakeDocument(bySelector, notificationDetailInputs);
  const window = new FakeWindow();
  const localStorage = options.storage ?? new FakeStorage();
  const reloads = { count: 0 };
  const location = {
    origin: "https://sessions.example",
    pathname: options.pathname ?? "/",
    search: options.search ?? "",
    get href(): string { return `${this.origin}${this.pathname}${this.search}`; },
    reload(): void { reloads.count += 1; },
    replace(path: string): void {
      location.pathname = path;
      location.search = "";
    },
  };
  const history = {
    replaced: [] as string[],
    state: null as unknown,
    replaceState(data: unknown, _unused: string, path: string): void {
      this.replaced.push(path);
      this.state = data;
      location.pathname = path;
      location.search = "";
    },
    pushState(data: unknown, _unused: string, path: string): void {
      this.state = data;
      location.pathname = path;
      location.search = "";
    },
    back(): void {},
  };
  const fetchPaths: string[] = [];
  const fetchLocations: string[] = [];
  let listRevision = 1;
  let listSessions = [...options.initialSessions];
  let listStatus = 200;
  let remoteStatus = 200;
  const launchRequests: { path: string; init: RequestInit }[] = [];
  const embedCalls: CollabEmbedOptions[] = [];
  const disposals = { count: 0 };
  embedStart = options => {
    embedCalls.push(options);
    return () => { disposals.count += 1; };
  };
  const workerMessages: unknown[] = [];
  let hangingListRequests = 0;
  let failedListRequests = 0;
  const permissionRequests = { count: 0 };
  const subscriptionRequests: unknown[] = [];
  const unsubscribeRequests: unknown[] = [];
  const subscriptionCalls = { subscribe: 0, unsubscribe: 0 };
  const notificationApi = {
    permission: options.permission,
    async requestPermission(): Promise<NotificationPermission> {
      permissionRequests.count += 1;
      this.permission = options.permissionResult ?? "granted";
      return this.permission;
    },
  };
  const pushSubscriptionJson = {
    endpoint: "https://push.example.test/send/browser-device",
    expirationTime: null,
    keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
  };
  let currentSubscription: PushSubscription | null = null;
  const createPushSubscription = (): PushSubscription => ({
    endpoint: pushSubscriptionJson.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey(): ArrayBuffer | null {
      return null;
    },
    toJSON(): PushSubscriptionJSON {
      if (options.webkitSubscriptionJson !== true) return pushSubscriptionJson;
      const { expirationTime: _omitted, ...webkit } = pushSubscriptionJson;
      return webkit;
    },
    async unsubscribe(): Promise<boolean> {
      subscriptionCalls.unsubscribe += 1;
      currentSubscription = null;
      return true;
    },
  });
  if (options.existingSubscription === true) currentSubscription = createPushSubscription();
  const pushManager = {
    async getSubscription(): Promise<PushSubscription | null> {
      return currentSubscription;
    },
    async subscribe(): Promise<PushSubscription> {
      subscriptionCalls.subscribe += 1;
      currentSubscription = createPushSubscription();
      return currentSubscription;
    },
  };
  const notifications: FakeBrowserNotification[] = [];
  const registration = {
    active: {
      postMessage(message: unknown, transfer: readonly MessagePort[]): void {
        workerMessages.push(message);
        const response = options.workerResponse ?? {
          type: "omp-notification-support-response",
          version: 2,
        };
        transfer[0]?.postMessage(response);
      },
    },
    pushManager,
    async getNotifications(options: { readonly tag?: string } = {}): Promise<FakeBrowserNotification[]> {
      return notifications.filter(notification =>
        !notification.closed && (options.tag === undefined || notification.tag === options.tag),
      );
    },
    async showNotification(): Promise<void> {},
  };
  const serviceWorker = new EventTarget() as EventTarget & {
    controller: object | null;
    readonly ready: Promise<typeof registration>;
    register(): Promise<typeof registration>;
    startMessages(): void;
  };
  serviceWorker.controller = {};
  Object.defineProperties(serviceWorker, {
    ready: { value: Promise.resolve(registration) },
    register: {
      async value(): Promise<typeof registration> {
        return registration;
      },
    },
    startMessages: { value(): void {} },
  });
  const navigator = { serviceWorker, onLine: true };
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    fetchPaths.push(path);
    fetchLocations.push(location.pathname + location.search);
    if (path === "/api/v1/client-config") {
      if (options.clientConfigStatus !== undefined) return new Response(null, { status: options.clientConfigStatus });
      return options.clientConfig === undefined ? new Response(null, { status: 404 }) : Response.json(options.clientConfig);
    }
    if (path === "https://remote.example/api/v1/sessions") {
      if (remoteStatus !== 200) return new Response(null, { status: remoteStatus });
      return Response.json(options.remotePayload ?? { revision: 1, sessions: options.remoteSessions ?? [] });
    }
    if (path.endsWith("/launch")) {
      launchRequests.push({ path, init });
      if (options.launchResponse !== undefined) return await options.launchResponse(path, init);
      await options.launchGate;
      const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
      return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
    }
    if (path === "/api/v1/push/config") {
      return Response.json({ version: 2, applicationServerKey: "V".repeat(87) });
    }
    if (path === "/api/v1/push/subscription") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (init.method === "DELETE") {
        unsubscribeRequests.push(body);
        return new Response(null, { status: 204 });
      }
      subscriptionRequests.push(body);
      return Response.json({
        version: 2,
        detailLevel: body.detailLevel ?? "session",
      });
    }
    if (path !== "/api/v1/sessions") throw new Error(`unexpected fetch: ${path}`);
    if (failedListRequests > 0) {
      failedListRequests -= 1;
      throw new TypeError("network request failed");
    }
    if (hangingListRequests > 0) {
      hangingListRequests -= 1;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        const abort = (): void => reject(new DOMException("snapshot timed out", "AbortError"));
        if (signal?.aborted === true) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (listStatus !== 200) return new Response("", { status: listStatus });
    return Response.json({ revision: listRevision, sessions: listSessions });
  };

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    location: { configurable: true, value: location },
    history: { configurable: true, value: history },
    navigator: { configurable: true, value: navigator },
    localStorage: { configurable: true, value: localStorage },
    Notification: { configurable: true, value: notificationApi },
    PushManager: { configurable: true, value: class {} },
    MessageChannel: { configurable: true, value: FakeMessageChannel },
    EventSource: { configurable: true, value: FakeEventSource },
    fetch: { configurable: true, value: fetch },
    isSecureContext: { configurable: true, value: true },
    HTMLElement: { configurable: true, value: class extends EventTarget {} },
    __COLLAB_CLIENT_MODULE__: {
      configurable: true,
      value: "fleet-test-collab",
    },
    __COLLAB_CLIENT_STYLESHEET__: { configurable: true, value: "/test-client.css" },
  });

  // app.ts bootstraps at import time, so a cache-busted test module is required for an isolated page.
  await import(`../src/app.ts?${options.suffix}`);
  await settleUntil(() => notificationButton.textContent !== "Checking background alerts…");
  await settleUntil(() => FakeEventSource.instances.length === 1);
  if (options.pathname?.startsWith("/collab/") === true) {
    await settleUntil(() => statusBanner.dataset.kind === "expired", 100);
  }

  return {
    elements: {
      sessionList,
      statusBanner,
      notificationButton,
      notificationDisclosure,
      notificationSettings,
      networkRecoveryHelp,
      settingsButton,
      notificationDetailOptions,
      emptyState,
      notificationDetailInputs,
      directoryTitle,
      directoryCount,
      hostPicker,
      fleetStatus,
      localActionToast,
      localActionToastCopy,
      localActionToastUndo,
    },
    fetchPaths,
    fetchLocations,
    permissionRequests,
    subscriptionRequests,
    unsubscribeRequests,
    subscriptionCalls,
    workerMessages,
    replacedPaths: history.replaced,
    reloads,
    window,
    localStorage,
    notifications,
    body: document.body,
    launchRequests,
    embedCalls,
    disposals,
    setRemoteStatus(status): void { remoteStatus = status; },
    notify(data): void {
      serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "omp-notification-route", version: 2, data } }));
    },
    addNotification(tag, data): FakeBrowserNotification {
      const notification = new FakeBrowserNotification(tag, data);
      notifications.push(notification);
      return notification;
    },
    emit(type, payload): void {
      const source = FakeEventSource.instances.at(-1);
      if (source === undefined) throw new Error("missing event source");
      source.emit(type, payload);
    },
    disconnectEvents(): void {
      const source = FakeEventSource.instances.at(-1);
      if (source === undefined) throw new Error("missing event source");
      source.onerror?.();
    },
    expireEventLiveness(): void {
      window.runTimers();
    },
    runTimers(): void {
      window.runTimers();
    },
    runUndoTimer(): void {
      window.runTimersWithDelay(5_000);
    },
    pendingDelays(): number[] {
      return window.pendingDelays();
    },
    timerMark(): number {
      return window.timerMark();
    },
    pendingDelaysSince(mark): number[] {
      return window.pendingDelaysSince(mark);
    },
    runTimersSince(mark): void {
      window.runTimersSince(mark);
    },
    setVisibility(state): void {
      document.setVisibility(state);
    },
    freeze(): void {
      document.freeze();
    },
    advanceClock(milliseconds): void {
      clockOffset += milliseconds;
    },
    hangNextListRequest(): void {
      hangingListRequests += 1;
    },
    failNextListRequest(): void {
      failedListRequests += 1;
    },
    setOnline(online): void {
      navigator.onLine = online;
    },
    activateWorker(): void {
      serviceWorker.controller = {};
      serviceWorker.dispatchEvent(new Event("controllerchange"));
    },
    setList(revision, sessions, status = 200): void {
      listRevision = revision;
      listSessions = [...sessions];
      listStatus = status;
    },
  };
}

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    const descriptor = nativeGlobals[name];
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  Date.now = nativeNow;
});

describe("dashboard attention and notifications", () => {
  test("renders the boolean-only triage queue without prompting or notifying on the initial list", async () => {
    const harness = await bootApp({
      permission: "default",
      suffix: "initial-attention",
      initialSessions: [
        session("ordinary-newest-0003", { startedAt: "2026-07-21T12:00:00.000Z" }),
        session("attention-viewonly-002", {
          startedAt: "2026-07-21T09:00:00.000Z",
          canControl: false,
          inputRequired: true,
        }),
        session("attention-control-0001", { inputRequired: true }),
      ],
    });

    expect(harness.elements.directoryTitle.textContent).toBe("Needs you");
    expect(harness.elements.directoryCount.textContent).toBe("2 waiting");
    expect(harness.elements.directoryCount.className).toContain("count-pill-waiting");
    const hero = harness.elements.sessionList.querySelector(".queue-hero");
    expect(hero?.querySelector("h2")?.textContent).toBe("attention-control-0001");
    expect(hero?.querySelector(".ask-preview")?.textContent).toBe("Waiting for your input");
    expect(hero?.querySelector(".action-request")?.textContent).toBe("Open request");
    expect(hero?.querySelectorAll(".hero-alt").map(action => action.textContent)).toEqual([
      "Hold for desk",
      "Transcript",
    ]);
    const waitingRows = harness.elements.sessionList.querySelectorAll(".queue-row");
    expect(waitingRows.map(row => row.querySelector(".row-title")?.textContent)).toEqual([
      "attention-viewonly-002",
    ]);
    expect(waitingRows[0]?.getAttribute("aria-label")).toBe("View attention-viewonly-002");
    expect(
      harness.elements.sessionList.querySelectorAll(".working-row").map(
        row => row.querySelector(".row-title")?.textContent,
      ),
    ).toEqual(["ordinary-newest-0003"]);
    expect(harness.elements.sessionList.querySelector(".attention")).toBeNull();
    expect(harness.permissionRequests.count).toBe(0);
    expect(harness.workerMessages).toEqual([{ type: "omp-notification-support-request", version: 2 }]);
    expect(harness.elements.notificationButton.textContent).toBe("Enable background alerts");
    expect(harness.elements.notificationButton.dataset.state).toBe("idle");
    expect(harness.elements.notificationDisclosure.hidden).toBeFalse();
  });

  test("renders the exact all-clear resting state", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "all-clear",
      initialSessions: [
        session("working-session-0001", { startedAt: "2026-07-21T10:00:00.000Z" }),
        session("working-session-0002", { startedAt: "2026-07-21T11:00:00.000Z" }),
      ],
    });

    expect(harness.elements.directoryTitle.textContent).toBe("Sessions");
    expect(harness.elements.directoryCount.textContent).toBe("Live · 2");
    expect(harness.elements.sessionList.querySelector(".all-clear-title")?.textContent).toBe("All clear");
    // Blocked alerts must not promise a ping; the hint chip routes to Settings instead.
    expect(harness.elements.sessionList.querySelector(".all-clear-copy")?.textContent).toBe(
      "Nothing needs you.",
    );
    expect(harness.elements.sessionList.querySelector(".alerts-hint")?.textContent).toBe(
      "Alerts blocked · Settings",
    );
    expect(
      harness.elements.sessionList
        .querySelectorAll(".working-row")
        .map(row => row.querySelector(".row-title")?.textContent),
    ).toEqual(["working-session-0002", "working-session-0001"]);
    const firstWorking = harness.elements.sessionList.querySelector(".working-row");
    expect(firstWorking?.querySelector(".session-tile")?.dataset.state).toBe("unknown");
    expect(firstWorking?.querySelector(".tile-monogram")?.textContent).toBe("W");
    expect(
      firstWorking?.querySelector(".row-meta")?.querySelectorAll(".fact").map(fact => [fact.className, fact.textContent]),
    ).toEqual([
      ["fact working-context", "project"],
      ["fact session-activity", "Activity unknown"],
      ["fact row-time", expect.stringMatching(/^up \d+d/u)],
      ["fact working-model", "model"],
    ]);
    const hide = harness.elements.sessionList.querySelector(".dismiss-session");
    expect(hide?.querySelector("svg")).not.toBeNull();
    expect(hide?.textContent).toBe("");
    expect(hide?.getAttribute("aria-label")).toBe("Hide working-session-0002 on this device");
  });

  test("lifts a leading Nerd Font icon into the tile and keeps icons out of spoken names", async () => {
    const iconTitle = "\u{F04E6} SYNC: fix the \u{E0B0} catalogue parsing";
    const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
    const harness = await bootApp({
      permission: "denied",
      suffix: "tile-icons",
      initialSessions: [
        session("tile-icons-0001", { title: iconTitle, busy: true, startedAt: minutesAgo(5) }),
        session("tile-icons-0002", { title: "omp-session-gateway", cwdLabel: "omp-session-gateway", busy: false, startedAt: minutesAgo((3 * 24 + 4) * 60 + 7) }),
      ],
    });
    const [iconRow, plainRow] = harness.elements.sessionList.querySelectorAll(".working-row");
    const iconTile = iconRow?.querySelector(".session-tile");
    expect(iconTile?.querySelector(".glyph")?.textContent).toBe("\u{F04E6}");
    expect(iconTile?.getAttribute("aria-hidden")).toBe("true");
    expect(iconTile?.dataset.state).toBe("working");
    const title = iconRow?.querySelector(".row-title");
    expect(title?.textContent).toBe("SYNC: fix the \u{E0B0}catalogue parsing");
    expect(title?.querySelector(".glyph")?.textContent).toBe("\u{E0B0}");
    expect(iconRow?.getAttribute("aria-label")).toBe("View SYNC: fix the catalogue parsing");
    expect(harness.elements.sessionList.querySelector(".dismiss-session")?.getAttribute("aria-label")).toBe(
      "Hide SYNC: fix the catalogue parsing on this device",
    );
    expect(iconRow?.querySelector(".row-meta")?.querySelectorAll(".fact").map(fact => fact.textContent)).toEqual(["project", "Working", "up 5m", "model"]);
    // A title that already names the project does not repeat it; days replace long hour counts.
    expect(plainRow?.querySelector(".tile-monogram")?.textContent).toBe("O");
    expect(plainRow?.querySelector(".session-tile")?.dataset.state).toBe("idle");
    expect(plainRow?.querySelector(".row-meta")?.querySelectorAll(".fact").map(fact => fact.textContent)).toEqual(["Idle", "up 3d 4h", "model"]);
  });

  test("bounds a host-controlled icon run to one tile cell and keeps icon-only labels out of spoken names", async () => {
    const run = "\u{F04E6}".repeat(64);
    const harness = await bootApp({
      permission: "denied",
      suffix: "icon-runs",
      initialSessions: [
        session("icon-runs-0001", { title: `${run} Flooded`, startedAt: "2026-07-21T12:00:00.000Z" }),
        session("icon-runs-0002", { title: "\u{F011C}", cwdLabel: "\u{F0493} tools", startedAt: "2026-07-21T11:00:00.000Z" }),
      ],
    });
    const [flooded, iconsOnly] = harness.elements.sessionList.querySelectorAll(".working-row");
    expect(flooded?.querySelector(".session-tile")?.querySelector(".glyph")?.textContent).toBe("\u{F04E6}");
    expect(flooded?.querySelector(".row-title")?.textContent).toBe("Flooded");
    expect(flooded?.getAttribute("aria-label")).toBe("View Flooded");
    expect(iconsOnly?.querySelector(".session-tile")?.querySelector(".glyph")?.textContent).toBe("\u{F011C}");
    expect(iconsOnly?.querySelector(".row-title")?.textContent).toBe("tools");
    expect(iconsOnly?.getAttribute("aria-label")).toBe("View tools");
    expect(harness.elements.sessionList.querySelectorAll(".dismiss-session")[1]?.getAttribute("aria-label")).toBe("Hide tools on this device");
  });

  test("shows host facts only while several hosts are in view", async () => {
    const single = await bootApp({
      permission: "denied",
      suffix: "host-facts-single",
      initialSessions: [session("host-facts-0001")],
    });
    expect(single.elements.sessionList.querySelector(".host-label")).toBeNull();
    const fleet = await bootApp({
      permission: "denied",
      suffix: "host-facts-fleet",
      initialSessions: [session("host-facts-0002")],
      clientConfig: {
        version: 1,
        local: { id: "local", label: "Home", origin: "https://sessions.example" },
        targets: [{ id: "remote", label: "Remote", origin: "https://remote.example" }],
        speech: { browserRecognition: false },
      },
    });
    await settleUntil(() => fleet.elements.sessionList.querySelector(".host-label") !== null, 100);
    const facts = fleet.elements.sessionList.querySelector(".row-meta")?.querySelectorAll(".fact").map(fact => fact.textContent);
    expect(facts).toEqual(["Home", "project", "Activity unknown", expect.stringMatching(/^up /u), "model"]);
    fleet.setVisibility("hidden");
  });

  test("shows the empty state instead of a zero-count all-clear when nothing is live", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "empty-directory",
      initialSessions: [],
    });

    expect(harness.elements.emptyState.hidden).toBeFalse();
    expect(harness.elements.directoryTitle.textContent).toBe("Sessions");
    expect(harness.elements.directoryCount.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelector(".all-clear-title")).toBeNull();

    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 2,
      session: session("empty-then-live-0001"),
    });
    expect(harness.elements.emptyState.hidden).toBeTrue();
    expect(harness.elements.directoryCount.hidden).toBeFalse();

    harness.emit("session_remove", {
      type: "session_remove",
      revision: 3,
      instanceId: "empty-then-live-0001",
      generation: 1,
    });
    expect(harness.elements.emptyState.hidden).toBeFalse();
    expect(harness.elements.directoryCount.hidden).toBeTrue();
  });

  test("activity samples distinguish working, idle, and unknown across metadata updates", async () => {
    const base = session("activity-samples-0001", { busy: true });
    const harness = await bootApp({
      permission: "denied", suffix: "activity-samples", initialSessions: [base],
    });
    const activity = (): string | null | undefined =>
      harness.elements.sessionList.querySelector(".session-activity")?.textContent;
    expect(activity()).toContain("Working");
    harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: { ...base, busy: false } });
    expect(activity()).toContain("Idle");
    harness.emit("session_upsert", { type: "session_upsert", revision: 3, session: session(base.instanceId) });
    expect(activity()).toContain("Activity unknown");
    expect(harness.elements.directoryCount.textContent).toBe("Live · 1");
    expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();
  });

  test("scrubs malformed notification routes before any fetch without attempting a launch", async () => {
    const harness = await bootApp({
      permission: "denied",
      pathname: "/collab/activity-session-0001",
      search: "?activity=stopped&generation=01",
      suffix: "malformed-notification-route",
      initialSessions: [session("activity-session-0001")],
    });
    expect(harness.fetchLocations.every(path => path === "/")).toBeTrue();
    expect(harness.replacedPaths).toEqual(["/"]);
    expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();
    harness.emit("keepalive", { type: "keepalive", revision: 1 });
    expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
  });

  test("rejects changed, gone, and unavailable activity-stop sessions without launching", async () => {
    for (const [name, current] of [
      ["changed", session("activity-session-0001", { generation: 2 })],
      ["gone", undefined],
      ["unavailable", session("activity-session-0001", { canView: false, canControl: false })],
    ] as const) {
      const harness = await bootApp({
        permission: "denied",
        pathname: "/collab/activity-session-0001",
        search: "?activity=stopped&generation=1",
        suffix: `stale-activity-${name}`,
        initialSessions: current === undefined ? [] : [current],
      });
      expect(harness.fetchLocations.every(path => path === "/")).toBeTrue();
      expect(harness.fetchPaths.some(path => path.endsWith("/launch"))).toBeFalse();
      expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
      harness.emit("keepalive", { type: "keepalive", revision: 1 });
      expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
    }
  });

  test("scrubs stale notification routes and keeps their expired state visible", async () => {
    const harness = await bootApp({
      permission: "denied",
      pathname: "/collab/stale-attention-0001",
      search: "?request=stale-request-0001",
      suffix: "stale-attention-route",
      initialSessions: [],
    });

    expect(harness.replacedPaths).toEqual(["/"]);
    expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
    harness.emit("snapshot", { type: "snapshot", revision: 2, sessions: [] });
    expect(harness.elements.statusBanner.dataset.kind).toBe("expired");
  });

  test("reloads an idle directory after an updated worker activates", async () => {
    const harness = await bootApp({
      permission: "denied",
      suffix: "worker-activation",
      initialSessions: [session("worker-update-0001")],
    });

    harness.activateWorker();
    expect(harness.reloads.count).toBe(0);
    harness.runTimers();
    expect(harness.reloads.count).toBe(1);
  });

  test("closes a silent SSE stream and resyncs without manual refresh", async () => {
    const base = session("liveness-session-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "sse-liveness",
      initialSessions: [base],
    });

    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    harness.expireEventLiveness();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.elements.statusBanner.dataset.kind).toBe("gateway");
    expect(harness.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "Gateway unavailable",
    );
    expect(FakeEventSource.instances[0]?.closed).toBeTrue();

    harness.setList(2, [base]);
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 2);
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1);
    await settleUntil(() => FakeEventSource.instances.length === 2);
    expect(harness.elements.statusBanner.hidden).toBe(true);
  });
  test("recovers through the native event stream when browser timers are lost", async () => {
    const base = session("native-reconnect-0001");
    const recovered = session("native-reconnect-0001", { title: "Recovered natively" });
    const harness = await bootApp({
      permission: "denied",
      suffix: "native-eventsource-reconnect",
      initialSessions: [base],
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing initial event stream");

    harness.disconnectEvents();
    expect(source.closed).toBeFalse();

    source.onopen?.();
    source.emit("snapshot", { type: "snapshot", revision: 2, sessions: [recovered] });
    await settleUntil(() => harness.elements.statusBanner.hidden);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(harness.elements.sessionList.querySelector(".row-title")?.textContent).toBe(
      "Recovered natively",
    );
  });



  test("keeps the last directory while distinguishing device and tailnet outages", async () => {
    const offlineBase = session("offline-session-0001");
    const offline = await bootApp({
      permission: "denied",
      suffix: "phone-offline",
      initialSessions: [offlineBase],
    });
    offline.setOnline(false);
    offline.window.dispatchEvent(new Event("offline"));
    expect(offline.elements.statusBanner.dataset.kind).toBe("offline");
    expect(offline.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "You're offline",
    );
    expect(offline.elements.statusBanner.querySelector(".status-detail")?.textContent).toContain(
      "Showing the list as of",
    );
    expect(offline.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);

    const tailnetBase = session("tailnet-session-0001");
    const tailnet = await bootApp({
      permission: "denied",
      suffix: "tailnet-offline",
      initialSessions: [tailnetBase],
    });
    tailnet.failNextListRequest();
    tailnet.disconnectEvents();
    tailnet.runTimers();
    await settleUntil(() => tailnet.elements.statusBanner.dataset.kind === "tailnet");
    expect(tailnet.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "Tailnet unreachable",
    );
    expect(tailnet.elements.statusBanner.querySelector(".status-detail")?.textContent).toBe(
      "This device is online, but your tailnet isn't answering — Tailscale is off or logged out here.",
    );
    expect(tailnet.elements.statusBanner.querySelector(".status-freshness")?.textContent).toContain(
      "Last seen",
    );
    expect(tailnet.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("releases the directory stream when the hidden page freezes and rebuilds it on return", async () => {
    const base = session("frozen-directory-0001");
    const harness = await bootApp({ permission: "denied", suffix: "frozen-directory", initialSessions: [base] });
    const source = FakeEventSource.instances.at(-1);
    if (source === undefined) throw new Error("missing event source");
    const listReads = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;
    const readsBeforeFreeze = listReads();

    // A short app switch keeps the stream.
    harness.setVisibility("hidden");
    expect(source.closed).toBeFalse();

    harness.freeze();
    expect(source.closed).toBeTrue();
    expect(harness.pendingDelays()).toEqual([]);
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);

    harness.setVisibility("visible");
    await settleUntil(() => FakeEventSource.instances.at(-1) !== source);
    expect(listReads()).toBe(readsBeforeFreeze + 1);
    expect(FakeEventSource.instances.at(-1)?.closed).toBeFalse();
  });

  test("offers local browser recovery help only after a prolonged visible outage", async () => {
    const base = session("prolonged-outage-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "prolonged-outage",
      initialSessions: [base],
    });

    harness.failNextListRequest();
    harness.disconnectEvents();
    harness.runTimers();
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();

    harness.setVisibility("hidden");
    harness.advanceClock(45_000);
    harness.failNextListRequest();
    harness.setVisibility("visible");
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();

    harness.advanceClock(45_000);
    harness.failNextListRequest();
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.querySelector(".status-guidance") !== null);
    expect(harness.elements.statusBanner.querySelector(".status-guidance")?.textContent).toContain(
      "The browser may be stuck after sleep or a network change",
    );
    const troubleshooting = harness.elements.statusBanner
      .querySelectorAll(".status-action")
      .find(element => element.tagName === "button" && element.textContent === "Troubleshooting");
    troubleshooting?.dispatchEvent(new Event("click"));
    expect(harness.elements.networkRecoveryHelp.open).toBeTrue();

    harness.setList(2, [base]);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.hidden);
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();
    expect(harness.elements.networkRecoveryHelp.open).toBeFalse();
  });
  test("times out a hung snapshot and keeps retrying automatically", async () => {
    const base = session("snapshot-timeout-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "snapshot-timeout",
      initialSessions: [base],
    });

    harness.hangNextListRequest();
    harness.disconnectEvents();
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 2);

    expect(harness.pendingDelays()).toContain(20_000);
    harness.runTimers();

    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "desktop");
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "Desktop unreachable",
    );

    harness.setList(2, [base]);
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 3);
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1);
    expect(harness.elements.statusBanner.hidden).toBe(true);
  });
  test("backs off repeated visible network failures instead of churning connections", async () => {
    const nativeRandom = Math.random;
    Math.random = () => 0.999;
    try {
      const base = session("network-backoff-0001");
      const harness = await bootApp({
        permission: "denied",
        suffix: "network-backoff",
        initialSessions: [base],
      });
      const snapshots = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;
      const retryDelays: number[] = [];

      harness.disconnectEvents();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await settleUntil(() => harness.pendingDelays().some(delay => delay < 45_000));
        retryDelays.push(Math.min(...harness.pendingDelays().filter(delay => delay < 45_000)));
        harness.failNextListRequest();
        harness.runTimers();
        await settleUntil(() => snapshots() === attempt + 2);
      }

      expect(retryDelays).toEqual([999, 1_999, 3_998, 7_996, 15_992]);
    } finally {
      Math.random = nativeRandom;
    }
  });

  test("creates and removes a persistent push subscription only after explicit user actions", async () => {
    const base = session("transition-session-001", { title: "PROMPT_CONTENT_CANARY" });
    const harness = await bootApp({
      permission: "default",
      permissionResult: "granted",
      suffix: "background-subscription",
      initialSessions: [base],
    });

    expect(harness.subscriptionRequests).toHaveLength(0);
    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.notificationButton.textContent === "Disable background alerts");
    expect(harness.elements.notificationButton.dataset.state).toBe("enabled");
    expect(harness.elements.notificationButton.disabled).toBeFalse();
    expect(harness.permissionRequests.count).toBe(1);
    expect(harness.subscriptionCalls.subscribe).toBe(1);
    expect(harness.subscriptionRequests).toHaveLength(1);
    expect(JSON.stringify(harness.subscriptionRequests)).not.toContain("CONTENT_CANARY");

    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 2,
      session: session(base.instanceId, { ...base, inputRequired: true }),
    });
    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 3,
      session: { ...base, inputRequired: false },
    });
    await Promise.resolve();
    expect(harness.subscriptionRequests).toHaveLength(1);

    // The toggle lives in the Settings sheet and now disables in place.
    expect(harness.elements.notificationDetailOptions.hidden).toBeFalse();
    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.notificationButton.textContent === "Enable background alerts");
    expect(harness.subscriptionCalls.unsubscribe).toBe(1);
    expect(harness.unsubscribeRequests).toEqual([
      { version: 2, endpoint: "https://push.example.test/send/browser-device" },
    ]);
  });

  // #274: no iPhone or iPad could enable background alerts. WebKit omits a null `expirationTime`
  // from `PushSubscription.toJSON()`, and the exact subscription check rejected that shape before
  // any request, so the new subscription was removed and the control read unavailable.
  test("enables background alerts when WebKit omits a null subscription expiration", async () => {
    const harness = await bootApp({
      permission: "default",
      permissionResult: "granted",
      webkitSubscriptionJson: true,
      suffix: "webkit-subscription",
      initialSessions: [session("webkit-session-001")],
    });

    harness.elements.notificationButton.dispatchEvent(new Event("click"));
    const settled = () => harness.elements.notificationButton.dataset.state;
    await settleUntil(() => settled() === "enabled" || settled() === "unavailable");
    expect(settled()).toBe("enabled");
    expect(harness.subscriptionCalls.unsubscribe).toBe(0);
    expect(harness.subscriptionRequests).toEqual([
      expect.objectContaining({ subscription: expect.objectContaining({ expirationTime: null }) }),
    ]);
  });

  test("restores an existing browser subscription without requesting permission again", async () => {
    const base = session("reconnect-session-001");
    const harness = await bootApp({
      permission: "granted",
      existingSubscription: true,
      suffix: "background-subscription-restore",
      initialSessions: [base],
    });

    expect(harness.elements.notificationButton.textContent).toBe("Disable background alerts");
    expect(harness.permissionRequests.count).toBe(0);
    expect(harness.subscriptionCalls.subscribe).toBe(0);
    expect(harness.subscriptionRequests).toHaveLength(1);

    harness.disconnectEvents();
    harness.setList(2, [session(base.instanceId, { ...base, inputRequired: true })]);
    harness.runTimers();
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length >= 2);
    expect(harness.subscriptionRequests).toHaveLength(1);
  });


  test("updates notification detail for the existing device subscription", async () => {
    const harness = await bootApp({
      permission: "granted",
      existingSubscription: true,
      suffix: "notification-detail",
      initialSessions: [session("notification-detail-0001")],
    });

    expect(harness.subscriptionRequests).toHaveLength(1);
    harness.elements.settingsButton.dispatchEvent(new Event("click"));
    expect(harness.elements.notificationSettings.open).toBeTrue();
    expect(harness.elements.notificationDetailOptions.hidden).toBeFalse();
    const preview = harness.elements.notificationDetailInputs.find(input => input.value === "preview");
    expect(preview).toBeDefined();
    if (preview === undefined) throw new Error("missing preview detail input");
    for (const input of harness.elements.notificationDetailInputs) input.checked = input === preview;
    preview.dispatchEvent(new Event("change"));
    await settleUntil(() => harness.subscriptionRequests.length === 2);
    expect(harness.subscriptionRequests[1]).toMatchObject({
      version: 2,
      detailLevel: "preview",
    });
  });
  test("uses only bounded metadata bodies and fails closed for denied or invalid worker support", async () => {
    const denied = await bootApp({
      permission: "denied",
      suffix: "notifications-denied",
      initialSessions: [session("denied-session-0001")],
    });
    expect(denied.elements.notificationButton.textContent).toBe("Notifications blocked");
    expect(denied.elements.notificationButton.dataset.state).toBe("blocked");
    expect(denied.elements.notificationButton.disabled).toBeTrue();
    expect(denied.elements.notificationDisclosure.textContent).toContain("browser settings");
    denied.elements.notificationButton.dispatchEvent(new Event("click"));
    expect(denied.permissionRequests.count).toBe(0);

    const unavailable = await bootApp({
      permission: "default",
      workerResponse: { type: "omp-notification-support-response", version: 2, extra: true },
      suffix: "notifications-invalid-worker",
      initialSessions: [session("unavailable-session-01")],
    });
    expect(unavailable.elements.notificationButton.textContent).toBe("Background alerts unavailable");
    expect(unavailable.elements.notificationButton.dataset.state).toBe("unavailable");
    expect(unavailable.elements.notificationButton.disabled).toBeTrue();
  });

  test("rebuilds a frozen directory connection on resume instead of trusting the old one", async () => {
    const base = session("resume-session-00001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "frozen-resume",
      initialSessions: [base],
    });
    const snapshots = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(snapshots()).toBe(1);
    const frozen = FakeEventSource.instances[0];

    // #65's reproduction recipe: display off freezes the renderer, so no timer runs and the liveness
    // watchdog never fires, while wall-clock time passes and the stream silently dies. The
    // EventSource still reports open because nothing in the page ran to notice otherwise.
    harness.setVisibility("hidden");
    harness.advanceClock(45_000);
    harness.setList(2, [base]);
    harness.setVisibility("visible");

    // No timer is flushed anywhere below: resume alone has to produce the fresh connection.
    expect(frozen?.closed).toBeTrue();
    await settleUntil(() => FakeEventSource.instances.length === 2);
    await settleUntil(() => snapshots() === 2);
    expect(FakeEventSource.instances[1]?.closed).toBeFalse();
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("keeps a bounded retry pending when the phone reports offline and no online event follows", async () => {
    const base = session("offline-retry-000001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "offline-retry",
      initialSessions: [base],
    });
    const snapshots = (): number => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;

    expect(snapshots()).toBe(1);
    harness.setOnline(false);
    harness.window.dispatchEvent(new Event("offline"));
    expect(harness.elements.statusBanner.querySelector(".status-title")?.textContent).toBe(
      "You're offline",
    );

    // The offline state must carry its own way out: #65 measured `navigator.onLine` reporting true
    // through a total outage, so an `online` event is not a wake-up the page can count on. One
    // retry is pending, and it is scheduled inside the backoff ceiling.
    expect(harness.pendingDelays()).toHaveLength(1);
    expect(harness.pendingDelays()[0]).toBeLessThanOrEqual(4_000);

    harness.setOnline(true);
    harness.setList(2, [base]);
    harness.runTimers();
    await settleUntil(() => snapshots() === 2);
    await settleUntil(() => FakeEventSource.instances.length === 2);
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("does not count offline time toward browser recovery guidance", async () => {
    const base = session("offline-guidance-001");
    const harness = await bootApp({
      permission: "denied",
      suffix: "offline-guidance",
      initialSessions: [base],
    });

    harness.setOnline(false);
    harness.window.dispatchEvent(new Event("offline"));
    harness.advanceClock(60_000);
    harness.setOnline(true);
    harness.failNextListRequest();
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();
  });

  test("holds an ask locally, closes only its notification, and preserves FIFO across reload", async () => {
    const storage = new FakeStorage();
    const first = session("hold-first-session-0001", {
      inputRequired: true,
      ask: {
        requestId: "hold-first-request-0001",
        since: "2026-07-21T10:00:00.000Z",
      },
    });
    const second = session("hold-second-session-002", {
      inputRequired: true,
      ask: {
        requestId: "hold-second-request-002",
        since: "2026-07-21T10:01:00.000Z",
      },
    });
    const harness = await bootApp({
      permission: "denied",
      suffix: "hold-local",
      storage,
      initialSessions: [second, first],
    });
    const tag = `omp-attention-${first.instanceId}`;
    const matching = harness.addNotification(tag, { requestId: first.ask?.requestId });
    const unrelatedRequest = harness.addNotification(tag, { requestId: second.ask?.requestId });
    const unrelatedTag = harness.addNotification("omp-attention-unrelated-session", {
      requestId: first.ask?.requestId,
    });

    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    await settleUntil(() => matching.closed);

    expect(unrelatedRequest.closed).toBeFalse();
    expect(unrelatedTag.closed).toBeFalse();
    expect(harness.elements.directoryCount.textContent).toBe("2 waiting · 1 held");
    expect(harness.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      second.instanceId,
    );
    expect(harness.elements.sessionList.querySelector(".held-row")?.dataset.instanceId).toBe(
      first.instanceId,
    );
    const stored = JSON.parse(storage.getItem("omp.sessions.held-asks.v2") ?? "null") as unknown;
    expect(stored).toEqual([
      {
        instanceId: first.instanceId,
        requestId: first.ask?.requestId,
        heldAt: expect.any(String),
        sourceId: "local",
        sourceOrigin: "https://sessions.example",
      },
    ]);
    expect(Object.keys((stored as Record<string, unknown>[])[0] ?? {}).sort()).toEqual([
      "heldAt",
      "instanceId",
      "requestId",
      "sourceId",
      "sourceOrigin",
    ]);

    const reloaded = await bootApp({
      permission: "denied",
      suffix: "hold-local-reload",
      storage,
      initialSessions: [first, second],
    });
    expect(reloaded.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      second.instanceId,
    );
    reloaded.elements.sessionList.querySelector(".held-requeue")?.dispatchEvent(new Event("click"));
    expect(reloaded.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      first.instanceId,
    );
    expect(storage.getItem("omp.sessions.held-asks.v2")).toBe("[]");
  });

  test("shows an all-held queue and forgets a hold when the exact ask changes", async () => {
    const first = session("all-held-session-0001", {
      inputRequired: true,
      ask: {
        requestId: "all-held-request-0001",
        since: "2026-07-21T10:00:00.000Z",
      },
    });
    const second = session("all-held-session-0002", {
      inputRequired: true,
      ask: {
        requestId: "all-held-request-0002",
        since: "2026-07-21T10:01:00.000Z",
      },
    });
    const harness = await bootApp({
      permission: "denied",
      suffix: "all-held-local",
      initialSessions: [first, second],
    });

    const staleFirstHold = harness.elements.sessionList.querySelector(".hero-hold");
    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    expect(harness.elements.directoryCount.textContent).toBe("2 waiting · 2 held");
    expect(harness.elements.sessionList.querySelector(".queue-hero")).toBeNull();
    expect(harness.elements.sessionList.querySelector(".all-held-summary")?.querySelector("strong")?.textContent).toBe(
      "Queue clear · 2 on hold — handle at desk",
    );
    expect(harness.elements.sessionList.querySelectorAll(".held-row")).toHaveLength(2);

    const replacement = session(first.instanceId, {
      generation: first.generation,
      inputRequired: true,
      ask: {
        requestId: "replacement-request-0001",
        since: "2026-07-21T10:00:30.000Z",
      },
    });
    harness.emit("session_upsert", {
      type: "session_upsert",
      revision: 2,
      session: replacement,
    });

    expect(harness.elements.directoryCount.textContent).toBe("2 waiting · 1 held");
    expect(harness.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      first.instanceId,
    );
    expect(JSON.parse(harness.localStorage.getItem("omp.sessions.held-asks.v2") ?? "null")).toEqual([
      expect.objectContaining({
        instanceId: second.instanceId,
        requestId: second.ask?.requestId,
      }),
    ]);
    expect(staleFirstHold).not.toBeNull();
    staleFirstHold?.dispatchEvent(new Event("click"));
    expect(harness.elements.directoryCount.textContent).toBe("2 waiting · 1 held");
    expect(harness.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      first.instanceId,
    );
  });

  test("dismisses only on this device with undo, expiry, and an explicit restore surface", async () => {
    const first = session("dismiss-session-00001", { title: "Dismiss One" });
    const second = session("dismiss-session-00002", { title: "Keep Two" });
    const harness = await bootApp({
      permission: "denied",
      suffix: "dismiss-local",
      initialSessions: [first, second],
    });
    const networkCalls = harness.fetchPaths.length;

    harness.elements.sessionList.querySelectorAll(".dismiss-session")[0]?.dispatchEvent(new Event("click"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.elements.directoryCount.textContent).toBe("Live · 2");
    expect(harness.elements.sessionList.querySelector(".all-clear-copy")?.textContent).toBe("Nothing needs you.");
    expect(harness.elements.localActionToast.hidden).toBeFalse();
    expect(harness.elements.localActionToastCopy.textContent).toStartWith("Hidden “Dismiss One”");
    const stored = JSON.parse(
      harness.localStorage.getItem("omp.sessions.dismissed.v2") ?? "null",
    ) as Record<string, unknown>[];
    expect(stored).toEqual([
      {
        instanceId: first.instanceId,
        generation: first.generation,
        dismissedAt: expect.any(String),
        sourceId: "local",
        sourceOrigin: "https://sessions.example",
      },
    ]);
    expect(Object.keys(stored[0] ?? {}).sort()).toEqual([
      "dismissedAt",
      "generation",
      "instanceId",
      "sourceId",
      "sourceOrigin",
    ]);

    harness.elements.localActionToastUndo.dispatchEvent(new Event("click"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(2);
    expect(harness.localStorage.getItem("omp.sessions.dismissed.v2")).toBe("[]");

    harness.elements.sessionList.querySelectorAll(".dismiss-session")[0]?.dispatchEvent(new Event("click"));
    harness.runUndoTimer();
    expect(harness.elements.localActionToast.hidden).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.fetchPaths).toHaveLength(networkCalls);
    const restore = harness.elements.sessionList
      .querySelector(".dismissed-control")
      ?.querySelector("button");
    expect(
      harness.elements.sessionList.querySelector(".dismissed-control")?.querySelector("span")?.textContent,
    ).toBe("1 hidden on this device");
    expect(restore?.textContent).toBe("Show all");
    restore?.dispatchEvent(new Event("click"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(2);
    expect(harness.localStorage.getItem("omp.sessions.dismissed.v2")).toBe("[]");
  });

  test("scopes dismissals to one generation and never hides a later attention request", async () => {
    const storage = new FakeStorage();
    const initial = session("generation-dismiss-001", { title: "Generation one" });
    const firstPage = await bootApp({
      permission: "denied",
      suffix: "dismiss-generation-first",
      storage,
      initialSessions: [initial],
    });
    firstPage.elements.sessionList.querySelector(".dismiss-session")?.dispatchEvent(new Event("click"));
    firstPage.runUndoTimer();

    const reloaded = await bootApp({
      permission: "denied",
      suffix: "dismiss-generation-reload",
      storage,
      initialSessions: [initial],
    });
    expect(reloaded.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
    expect(reloaded.elements.sessionList.querySelector(".dismissed-control")).not.toBeNull();

    const replacement = session(initial.instanceId, {
      generation: 2,
      title: "Generation two",
    });
    reloaded.emit("session_upsert", {
      type: "session_upsert",
      revision: 2,
      session: replacement,
    });
    expect(reloaded.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(storage.getItem("omp.sessions.dismissed.v2")).toBe("[]");

    reloaded.elements.sessionList.querySelector(".dismiss-session")?.dispatchEvent(new Event("click"));
    const attention = session(initial.instanceId, {
      generation: 2,
      inputRequired: true,
      ask: {
        requestId: "attention-after-dismiss-0001",
        since: "2026-07-21T11:00:00.000Z",
      },
    });
    reloaded.emit("session_upsert", {
      type: "session_upsert",
      revision: 3,
      session: attention,
    });
    expect(reloaded.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      initial.instanceId,
    );
    expect(reloaded.elements.localActionToast.hidden).toBeTrue();
    expect(storage.getItem("omp.sessions.dismissed.v2")).toBe("[]");
  });

  test("sanitizes malformed, oversized, and excess local routing records", async () => {
    const heldSession = session("sanitized-hold-session-001", {
      inputRequired: true,
      ask: {
        requestId: "sanitized-hold-request-001",
        since: "2026-07-21T10:00:00.000Z",
      },
    });
    const dismissedSession = session("sanitized-dismiss-session-01");
    const heldRecord = {
      instanceId: heldSession.instanceId,
      requestId: heldSession.ask?.requestId,
      heldAt: "2026-07-21T10:01:00.000Z",
    };
    const dismissedRecord = {
      instanceId: dismissedSession.instanceId,
      generation: dismissedSession.generation,
      dismissedAt: "2026-07-21T10:01:00.000Z",
    };
    const sanitizedStorage = new FakeStorage();
    sanitizedStorage.setItem(
      "omp.sessions.held-asks.v1",
      JSON.stringify([
        heldRecord,
        { ...heldRecord, title: "LOCAL_STORAGE_TITLE_CANARY" },
        { ...heldRecord, heldAt: "not-canonical" },
      ]),
    );
    sanitizedStorage.setItem(
      "omp.sessions.dismissed.v1",
      JSON.stringify([dismissedRecord, { ...dismissedRecord, generation: 0 }]),
    );

    const sanitized = await bootApp({
      permission: "denied",
      suffix: "sanitize-local-records",
      storage: sanitizedStorage,
      initialSessions: [heldSession, dismissedSession],
    });
    expect(sanitized.elements.sessionList.querySelectorAll(".held-row")).toHaveLength(1);
    expect(sanitized.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
    expect(JSON.parse(sanitizedStorage.getItem("omp.sessions.held-asks.v2") ?? "null")).toEqual([
      { ...heldRecord, sourceId: "local", sourceOrigin: "https://sessions.example" },
    ]);
    expect(JSON.parse(sanitizedStorage.getItem("omp.sessions.dismissed.v2") ?? "null")).toEqual([
      { ...dismissedRecord, sourceId: "local", sourceOrigin: "https://sessions.example" },
    ]);
    expect(sanitizedStorage.getItem("omp.sessions.held-asks.v1")).toBeNull();
    expect(sanitizedStorage.getItem("omp.sessions.dismissed.v1")).toBeNull();

    const oversizedStorage = new FakeStorage();
    oversizedStorage.setItem("omp.sessions.held-asks.v1", "x".repeat(512_001));
    const oversized = await bootApp({
      permission: "denied",
      suffix: "oversized-local-records",
      storage: oversizedStorage,
      initialSessions: [heldSession],
    });
    expect(oversizedStorage.getItem("omp.sessions.held-asks.v1")).toBeNull();
    expect(oversized.elements.sessionList.querySelector(".queue-hero")?.dataset.instanceId).toBe(
      heldSession.instanceId,
    );

    const excessStorage = new FakeStorage();
    excessStorage.setItem(
      "omp.sessions.dismissed.v1",
      JSON.stringify(Array.from({ length: MAX_SESSIONS + 1 }, () => dismissedRecord)),
    );
    const excess = await bootApp({
      permission: "denied",
      suffix: "excess-local-records",
      storage: excessStorage,
      initialSessions: [dismissedSession],
    });
    expect(excessStorage.getItem("omp.sessions.dismissed.v1")).toBeNull();
    expect(excess.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
  });

  test("retains local routing choices when an authoritative refresh is unavailable", async () => {
    const waiting = session("transport-hold-session-001", {
      inputRequired: true,
      ask: {
        requestId: "transport-hold-request-001",
        since: "2026-07-21T10:00:00.000Z",
      },
    });
    const working = session("transport-dismiss-session-01");
    const harness = await bootApp({
      permission: "denied",
      suffix: "transport-local-records",
      initialSessions: [waiting, working],
    });
    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    harness.elements.sessionList.querySelector(".dismiss-session")?.dispatchEvent(new Event("click"));
    const heldBefore = harness.localStorage.getItem("omp.sessions.held-asks.v2");
    const dismissedBefore = harness.localStorage.getItem("omp.sessions.dismissed.v2");

    harness.failNextListRequest();
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet");

    expect(harness.localStorage.getItem("omp.sessions.held-asks.v2")).toBe(heldBefore);
    expect(harness.localStorage.getItem("omp.sessions.dismissed.v2")).toBe(dismissedBefore);
    expect(harness.elements.sessionList.querySelectorAll(".held-row")).toHaveLength(1);
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
  });
});

describe("fleet directory bindings", () => {
  const config = {
    version: 1,
    local: { id: "local", label: "Home", origin: "https://sessions.example" },
    targets: [{ id: "remote", label: "Remote", origin: "https://remote.example" }],
    speech: { browserRecognition: false },
  };

  test("404 is silent local-only; malformed and mismatched configuration keep the local directory with Reload", async () => {
    const local = session("bootstrap-local-0001");
    const older = await bootApp({ permission: "denied", initialSessions: [local], suffix: "bootstrap-404" });
    expect(older.elements.fleetStatus.hidden).toBeTrue();
    for (const [index, clientConfig] of [
      { ...config, version: 2 },
      { ...config, local: { ...config.local, origin: "https://wrong.example" } },
      { ...config, extra: true },
    ].entries()) {
      const harness = await bootApp({ permission: "denied", initialSessions: [local], clientConfig, suffix: `bootstrap-invalid-${index}` });
      expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
      expect(harness.elements.fleetStatus.children[0]?.textContent).toStartWith("Fleet configuration unavailable — reload this app");
      harness.elements.fleetStatus.querySelector("button")?.dispatchEvent(new Event("click"));
      expect(harness.reloads.count).toBe(1);
      expect(harness.fetchPaths.some(path => path.startsWith("https://remote.example"))).toBeFalse();
    }
  });

  test("failed configuration preserves inert remote Hold and Hide records until an authoritative bootstrap", async () => {
    const waiting = session("bootstrap-held-0001", { inputRequired: true });
    const working = session("bootstrap-hidden-0001");
    const held = {
      sourceId: "remote", sourceOrigin: "https://remote.example", instanceId: waiting.instanceId,
      requestId: waiting.ask!.requestId, heldAt: "2026-07-21T10:00:00.000Z",
    };
    const dismissed = {
      sourceId: "remote", sourceOrigin: "https://remote.example", instanceId: working.instanceId,
      generation: working.generation, dismissedAt: "2026-07-21T10:00:00.000Z",
    };
    const storage = new FakeStorage();
    const heldBytes = JSON.stringify([held], null, 2);
    const dismissedBytes = JSON.stringify([dismissed], null, 2);
    storage.setItem("omp.sessions.held-asks.v2", heldBytes);
    storage.setItem("omp.sessions.dismissed.v2", dismissedBytes);
    const failed = await bootApp({
      permission: "denied", initialSessions: [waiting, working], storage,
      clientConfigStatus: 500, suffix: "bootstrap-preserve-remote",
    });
    expect(storage.getItem("omp.sessions.held-asks.v2")).toBe(heldBytes);
    expect(storage.getItem("omp.sessions.dismissed.v2")).toBe(dismissedBytes);
    expect(failed.elements.sessionList.querySelectorAll(".held-row")).toHaveLength(0);
    expect(failed.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(failed.elements.sessionList.querySelector(".queue-hero")?.dataset.sourceKey).toBe("local\0https://sessions.example");
    expect(failed.fetchPaths.some(path => path.startsWith("https://remote.example"))).toBeFalse();
    // A local action must also preserve the inert remote records in the whole-map write.
    failed.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    failed.elements.sessionList.querySelector(".dismiss-session")?.dispatchEvent(new Event("click"));
    expect(JSON.parse(storage.getItem("omp.sessions.held-asks.v2")!)).toContainEqual(held);
    expect(JSON.parse(storage.getItem("omp.sessions.dismissed.v2")!)).toContainEqual(dismissed);
    const recovered = await bootApp({
      permission: "denied", initialSessions: [waiting, working], remoteSessions: [waiting, working],
      storage, clientConfig: config, suffix: "bootstrap-rebind-remote",
    });
    await settleUntil(() => recovered.elements.sessionList.querySelectorAll(".held-row").length === 2, 100);
    recovered.elements.hostPicker.value = "remote\0https://remote.example";
    recovered.elements.hostPicker.dispatchEvent(new Event("change"));
    expect(recovered.elements.sessionList.querySelectorAll(".held-row")).toHaveLength(1);
    expect(recovered.elements.sessionList.querySelector(".held-row")?.dataset.sourceKey).toBe("remote\0https://remote.example");
    expect(recovered.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
    expect(recovered.elements.sessionList.querySelector(".dismissed-control")?.querySelector("span")?.textContent).toBe("1 hidden on this device");
    recovered.setVisibility("hidden");
  });

  test("oversized local and remote launch bodies fail without mounting and leave the directory usable", async () => {
    for (const source of ["local", "remote"]) {
      const current = session("bounded-launch-0001");
      let oversized = true;
      const harness = await bootApp({
        permission: "denied", initialSessions: [current], remoteSessions: [current],
        clientConfig: config, suffix: `launch-body-bound-${source}`,
        async launchResponse(_path, init): Promise<Response> {
          const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
          return Response.json({
            mode: body.mode, generation: body.generation,
            capability: oversized ? "x".repeat(MAX_FRAME_BYTES + 1) : ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__"),
          });
        },
      });
      await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 2, 100);
      harness.elements.hostPicker.value = source === "local" ? "local\0https://sessions.example" : "remote\0https://remote.example";
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      let mark = harness.timerMark();
      harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.elements.statusBanner.dataset.kind === "offline", 100);
      expect(harness.elements.statusBanner.textContent).toBe("The gateway returned an invalid launch response.");
      expect(harness.embedCalls).toHaveLength(0);
      expect(harness.elements.sessionList.querySelector(".working-row")?.disabled).toBeFalse();
      expect(harness.pendingDelaysSince(mark)).not.toContain(10_000);
      oversized = false;
      mark = harness.timerMark();
      harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.embedCalls.length === 1, 100);
      expect(harness.pendingDelaysSince(mark)).not.toContain(10_000);
      harness.window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("remote launch deadlines abort stalled headers and bodies through the gateway-unavailable path", async () => {
    for (const stage of ["headers", "body"]) {
      const current = session("stalled-launch-0001");
      let bodyStarted = false;
      const harness = await bootApp({
        permission: "denied", initialSessions: [], remoteSessions: [current],
        clientConfig: config, suffix: `launch-timeout-${stage}`,
        async launchResponse(_path, init): Promise<Response> {
          if (stage === "headers") {
            const { promise, reject } = Promise.withResolvers<Response>();
            init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            return await promise;
          }
          return new Response(new ReadableStream<Uint8Array>({
            start(controller): void {
              bodyStarted = true;
              init.signal!.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
            },
          }));
        },
      });
      await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1, 100);
      const mark = harness.timerMark();
      harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.launchRequests.length === 1, 100);
      if (stage === "body") await settleUntil(() => bodyStarted, 100);
      expect(harness.pendingDelaysSince(mark)).toContain(10_000);
      harness.runTimersSince(mark);
      await settleUntil(() => harness.elements.statusBanner.dataset.kind === "offline", 100);
      expect(harness.launchRequests[0]?.init.signal?.aborted).toBeTrue();
      expect(harness.elements.statusBanner.textContent).toBe("Gateway unavailable. Check your tailnet connection and try again.");
      expect(harness.embedCalls).toHaveLength(0);
      expect(harness.elements.sessionList.querySelector(".working-row")?.disabled).toBeFalse();
      expect(harness.pendingDelaysSince(mark)).not.toContain(10_000);
      harness.setVisibility("hidden");
    }
  });

  test("a forbidden remote Next ask preserves the local shell and offers an explicit return to Sessions", async () => {
    const home = session("withdrawn-home-0001", { inputRequired: true });
    const remote = session("withdrawn-remote-0001", { inputRequired: true });
    const harness = await bootApp({
      permission: "denied", initialSessions: [home], remoteSessions: [remote],
      clientConfig: config, suffix: "withdrawn-next-host",
      async launchResponse(path, init): Promise<Response> {
        if (path.startsWith("https://remote.example")) return new Response(null, { status: 403 });
        const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
        return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
      },
    });
    await settleUntil(() => harness.elements.directoryCount.textContent === "2 waiting", 100);
    const hero = harness.elements.sessionList.querySelector(".queue-hero");
    const openHome = hero?.dataset.sourceKey === "local\0https://sessions.example"
      ? hero.querySelector(".action-request")
      : harness.elements.sessionList.querySelectorAll(".queue-row").find(row => row.dataset.sourceKey === "local\0https://sessions.example");
    expect(openHome).toBeDefined();
    openHome?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.embedCalls.length === 1, 100);
    const health = { state: "healthy" as const, rttMs: 1, lastSuccessAt: Date.now(), failureSince: null, retryAt: null };
    harness.embedCalls[0]?.onStateChange?.({
      phase: "live", endedReason: null, requestPending: true, responsePending: false,
      gatewayHealth: health, relayHealth: health,
    });
    const answered = session(home.instanceId);
    harness.setList(2, [answered]);
    harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: answered });
    expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Next ask →");
    harness.body.querySelector(".triage-action")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.body.querySelector(".triage-copy")?.textContent === "Access withdrawn on Remote. Choose another session.", 100);
    expect(harness.disposals.count).toBe(0);
    expect(harness.embedCalls).toHaveLength(1);
    expect(harness.body.querySelector(".shell-host")?.textContent).toBe("Home");
    expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Sessions");
    harness.body.querySelector(".triage-action")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.fleetStatus.children.some(row => row.dataset.state === "forbidden"), 100);
    expect(harness.body.querySelector(".gateway-shell")).toBeNull();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    harness.setVisibility("hidden");
  });

  test("a same-source forbidden Control upgrade still disposes the remote shell", async () => {
    let launches = 0;
    const harness = await bootApp({
      permission: "denied", initialSessions: [], remoteSessions: [session("withdrawn-upgrade-0001")],
      clientConfig: config, suffix: "withdrawn-same-host",
      async launchResponse(_path, init): Promise<Response> {
        if (++launches === 2) return new Response(null, { status: 403 });
        const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
        return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
      },
    });
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1, 100);
    harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.embedCalls.length === 1, 100);
    const mark = harness.timerMark();
    harness.body.querySelector(".shell-control")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.disposals.count === 1, 100);
    expect(harness.embedCalls).toHaveLength(1);
    expect(harness.body.querySelector(".gateway-shell")).toBeNull();
    expect(harness.elements.fleetStatus.children.some(row => row.dataset.state === "forbidden")).toBeTrue();
    expect(harness.pendingDelaysSince(mark)).not.toContain(10_000);
    harness.setVisibility("hidden");
  });

  test("colliding ids have independent held records and remote Hold never closes home notifications", async () => {
    const waiting = session("fleet-collision-0001", { inputRequired: true });
    const harness = await bootApp({
      permission: "denied", initialSessions: [waiting], remoteSessions: [waiting],
      clientConfig: config, suffix: "fleet-held-collision",
    });
    await settleUntil(() => harness.elements.directoryCount.textContent === "2 waiting", 100);
    const notification = harness.addNotification(`omp-attention-${waiting.instanceId}`, { requestId: waiting.ask?.requestId });
    harness.elements.hostPicker.value = "remote\0https://remote.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    expect(harness.elements.directoryCount.textContent).toBe("1 waiting");
    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    await Promise.resolve();
    expect(notification.closed).toBeFalse();
    harness.elements.hostPicker.value = "local\0https://sessions.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    expect(harness.elements.sessionList.querySelector(".queue-hero")).not.toBeNull();
    harness.elements.sessionList.querySelector(".hero-hold")?.dispatchEvent(new Event("click"));
    await settleUntil(() => notification.closed);
    const held = JSON.parse(harness.localStorage.getItem("omp.sessions.held-asks.v2")!);
    expect(held.map((record: { sourceId: string }) => record.sourceId).sort()).toEqual(["local", "remote"]);
    harness.elements.hostPicker.value = "all";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    expect(harness.elements.sessionList.querySelectorAll(".held-row")).toHaveLength(2);
    harness.setVisibility("hidden");
  });

  test("colliding dismissals, Undo, and picker counts stay source-scoped", async () => {
    const same = session("fleet-dismiss-0001");
    const harness = await bootApp({
      permission: "denied", initialSessions: [same], remoteSessions: [same],
      clientConfig: config, suffix: "fleet-dismiss-collision",
    });
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 2, 100);
    harness.elements.hostPicker.value = "remote\0https://remote.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    harness.elements.sessionList.querySelector(".dismiss-session")?.dispatchEvent(new Event("click"));
    harness.elements.hostPicker.value = "all";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
    expect(harness.elements.sessionList.querySelector(".working-row")?.dataset.sourceKey).toBe("local\0https://sessions.example");
    harness.elements.localActionToastUndo.dispatchEvent(new Event("click"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(2);
    harness.setVisibility("hidden");
  });

  test("malformed remote data cannot assert fleet all-clear or erase home rows", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [session("fleet-home-0001")],
      clientConfig: config, remotePayload: { malformed: true }, suffix: "fleet-incomplete",
    });
    await settleUntil(() => harness.elements.fleetStatus.children[0]?.dataset.state === "unavailable", 100);
    expect(harness.elements.sessionList.querySelector(".all-clear-title")?.textContent).toBe("Host coverage incomplete");
    expect(harness.elements.sessionList.querySelector(".all-clear-copy")?.textContent).toBe("Unavailable: Remote.");
    harness.elements.hostPicker.value = "local\0https://sessions.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    expect(harness.elements.sessionList.querySelector(".all-clear-title")?.textContent).toBe("All clear");
    harness.setVisibility("hidden");
  });

  test("remote launch freezes the origin and options; 403 disposes only its active shell", async () => {
    const same = session("fleet-launch-0001");
    const harness = await bootApp({
      permission: "denied", initialSessions: [same], remoteSessions: [same],
      clientConfig: config, suffix: "fleet-launch-origin",
    });
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 2, 100);
    harness.elements.hostPicker.value = "remote\0https://remote.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.embedCalls.length === 1, 100);
    expect(harness.embedCalls).toHaveLength(1);
    expect(harness.launchRequests[0]).toMatchObject({
      path: `https://remote.example/api/v1/sessions/${same.instanceId}/launch`,
      init: { mode: "cors", credentials: "omit", cache: "no-store", redirect: "error" },
    });
    expect(harness.body.querySelector(".shell-host")?.textContent).toBe("Remote");
    expect(harness.embedCalls[0]?.probeGateway).toBeFunction();
    expect(harness.embedCalls[0]?.browserRecognitionEnabled).toBeFalse();
    harness.setRemoteStatus(403);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.disposals.count === 1, 100);
    expect(harness.body.querySelector(".gateway-shell")).toBeNull();
    expect(harness.elements.fleetStatus.children[0]?.dataset.state).toBe("forbidden");
    harness.setVisibility("hidden");
  });

  test("a changed selection discards a late launch result and notification intents never bind a remote collision", async () => {
    const gate = Promise.withResolvers<void>();
    const same = session("fleet-late-0001");
    const harness = await bootApp({
      permission: "denied", initialSessions: [same], remoteSessions: [same],
      clientConfig: config, suffix: "fleet-launch-late", launchGate: gate.promise,
    });
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 2, 100);
    harness.elements.hostPicker.value = "remote\0https://remote.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.launchRequests.length === 1, 100);
    harness.elements.hostPicker.value = "local\0https://sessions.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    gate.resolve();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(harness.embedCalls).toHaveLength(0);
    harness.elements.hostPicker.value = "remote\0https://remote.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    harness.notify({ version: 2, type: "activity_stop", instanceId: same.instanceId, generation: 1 });
    await settleUntil(() => harness.embedCalls.length === 1, 100);
    expect(harness.embedCalls).toHaveLength(1);
    expect(harness.launchRequests[1]?.path).toBe(`/api/v1/sessions/${same.instanceId}/launch`);
    expect(harness.body.querySelector(".shell-host")?.textContent).toBe("Home");
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  test("remote bfcache resume keeps its binding even when the home directory is forbidden", async () => {
    const same = session("fleet-resume-0001");
    const harness = await bootApp({
      permission: "denied", initialSessions: [same], remoteSessions: [same],
      clientConfig: config, suffix: "fleet-remote-resume",
    });
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 2, 100);
    harness.elements.hostPicker.value = "remote\0https://remote.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.embedCalls.length === 1, 100);
    harness.window.dispatchEvent(new Event("pagehide"));
    harness.setList(2, [], 403);
    const show = new Event("pageshow");
    Object.defineProperty(show, "persisted", { value: true });
    harness.window.dispatchEvent(show);
    await settleUntil(() => harness.embedCalls.length === 2, 100);
    expect(harness.launchRequests.map(request => request.path)).toEqual([
      `https://remote.example/api/v1/sessions/${same.instanceId}/launch`,
      `https://remote.example/api/v1/sessions/${same.instanceId}/launch`,
    ]);
    expect(harness.body.querySelector(".shell-host")?.textContent).toBe("Remote");
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  test("a foreground epoch change rejects an older launch even after fresh metadata arrives", async () => {
    const gate = Promise.withResolvers<void>();
    const same = session("fleet-epoch-0001");
    const harness = await bootApp({
      permission: "denied", initialSessions: [], remoteSessions: [same],
      clientConfig: config, suffix: "fleet-launch-epoch", launchGate: gate.promise,
    });
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1, 100);
    harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.launchRequests.length === 1, 100);
    harness.setVisibility("hidden");
    harness.setVisibility("visible");
    await settleUntil(() => harness.elements.fleetStatus.hidden, 100);
    gate.resolve();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(harness.embedCalls).toHaveLength(0);
    harness.setVisibility("hidden");
  });

  test("Hold-to-next crosses colliding host identities only in its captured All hosts scope", async () => {
    for (const scope of ["all", "local\0https://sessions.example"]) {
      const same = session("fleet-hold-next-0001", { inputRequired: true });
      const harness = await bootApp({
        permission: "denied", initialSessions: [same], remoteSessions: [same],
        clientConfig: config, suffix: `fleet-hold-next-${scope === "all" ? "all" : "local"}`,
      });
      await settleUntil(() => harness.elements.directoryCount.textContent === "2 waiting", 100);
      harness.elements.hostPicker.value = scope;
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      harness.elements.sessionList.querySelector(".action-request")?.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.embedCalls.length === 1, 100);
      const health = { state: "healthy" as const, rttMs: 1, lastSuccessAt: Date.now(), failureSince: null, retryAt: null };
      harness.embedCalls[0]?.onStateChange?.({
        phase: "live", endedReason: null, requestPending: true, responsePending: false,
        gatewayHealth: health, relayHealth: health,
      });
      expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Hold → next");
      harness.body.querySelector(".triage-action")?.dispatchEvent(new Event("click"));
      if (scope === "all") {
        await settleUntil(() => harness.embedCalls.length === 2, 100);
        expect(harness.launchRequests.map(request => request.path).sort()).toEqual([
          `/api/v1/sessions/${same.instanceId}/launch`,
          `https://remote.example/api/v1/sessions/${same.instanceId}/launch`,
        ]);
      } else {
        expect(harness.embedCalls).toHaveLength(1);
        expect(harness.body.querySelector(".triage-copy")?.textContent).toBe("Queue clear · 1 on hold — handle at desk");
      }
      harness.window.dispatchEvent(new Event("pagehide"));
    }
  });
});

interface RecoveryModel {
  revision: number;
  title: string;
  interrupted: boolean;
  online: boolean;
}

interface RecoveryReal {
  readonly harness: BrowserHarness;
  readonly instanceId: string;
  readonly capabilityCanary: string;
}

type RecoveryCommand = AsyncCommand<RecoveryModel, RecoveryReal>;

function activeModelStreams(): FakeEventSource[] {
  return FakeEventSource.instances.filter(source => !source.closed);
}

async function assertRecoveryInvariants(model: RecoveryModel, real: RecoveryReal): Promise<void> {
  await Promise.resolve();
  expect(activeModelStreams()).toHaveLength(1);

  const retryDelays = real.harness.pendingDelays().filter(delay => delay <= 30_000);
  expect(retryDelays.length).toBeLessThanOrEqual(1);
  expect(retryDelays.every(delay => delay >= 0 && delay <= 30_000)).toBeTrue();
  expect(real.harness.reloads.count).toBe(0);

  const observableSinks = JSON.stringify({
    fetchPaths: real.harness.fetchPaths,
    opened: real.harness.window.opened,
    replacedPaths: real.harness.replacedPaths,
    rowTitle: real.harness.elements.sessionList.querySelector(".row-title")?.textContent,
    status: real.harness.elements.statusBanner.textContent,
    workerMessages: real.harness.workerMessages,
  });
  expect(observableSinks).not.toContain(real.capabilityCanary);

  if (!model.interrupted) {
    expect(real.harness.elements.statusBanner.hidden).toBeTrue();
    expect(real.harness.elements.sessionList.querySelector(".row-title")?.textContent).toBe(
      model.title,
    );
  }
}

class InterruptStreamCommand implements RecoveryCommand {
  constructor(private readonly reportedOnline: boolean) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return !model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    real.harness.setOnline(this.reportedOnline);
    real.harness.disconnectEvents();
    model.interrupted = true;
    model.online = this.reportedOnline;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `SSE error (navigator.onLine=${String(this.reportedOnline)}, no online event)`;
  }
}

class RepeatStreamFailureCommand implements RecoveryCommand {
  constructor(private readonly repetitions: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing interrupted native stream");
    for (let index = 0; index < this.repetitions; index += 1) source.onerror?.();
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `repeat SSE error x${String(this.repetitions)}`;
  }
}

class LoseTimersCommand implements RecoveryCommand {
  constructor(private readonly elapsedMs: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    real.harness.advanceClock(this.elapsedMs);
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `freeze timers for ${String(this.elapsedMs)}ms`;
  }
}

class SetReportedOnlineWithoutEventCommand implements RecoveryCommand {
  constructor(private readonly online: boolean) {}

  check(): boolean {
    return true;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    real.harness.setOnline(this.online);
    model.online = this.online;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `set navigator.onLine=${String(this.online)} without event`;
  }
}

class NativeReopenCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing native stream to reopen");
    const revision = model.revision + 1;
    const title = `native-reopen-${String(this.titleId)}-r${String(revision)}`;
    source.onopen?.();
    source.emit("snapshot", {
      type: "snapshot",
      revision,
      sessions: [session(real.instanceId, { title })],
    });
    await settleUntil(() => real.harness.elements.statusBanner.hidden);
    model.revision = revision;
    model.title = title;
    model.interrupted = false;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `native SSE reopen ${String(this.titleId)}`;
  }
}

class SnapshotFallbackCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const revision = model.revision + 1;
    const title = `snapshot-fallback-${String(this.titleId)}-r${String(revision)}`;
    const fetchesBefore = real.harness.fetchPaths.length;
    real.harness.setList(revision, [session(real.instanceId, { title })]);
    real.harness.runTimers();
    await settleUntil(() => real.harness.fetchPaths.length > fetchesBefore);
    await settleUntil(() => activeModelStreams().length === 1);
    model.revision = revision;
    model.title = title;
    model.interrupted = false;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `snapshot retry ${String(this.titleId)}`;
  }
}

class HideResumeCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const revision = model.revision + 1;
    const title = `resume-${String(this.titleId)}-r${String(revision)}`;
    const fetchesBefore = real.harness.fetchPaths.length;
    real.harness.setList(revision, [session(real.instanceId, { title })]);
    real.harness.setVisibility("hidden");
    real.harness.advanceClock(45_000);
    real.harness.setVisibility("visible");
    await settleUntil(() => real.harness.fetchPaths.length > fetchesBefore);
    await settleUntil(() => activeModelStreams().length === 1);
    model.revision = revision;
    model.title = title;
    model.interrupted = false;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `hide/resume ${String(this.titleId)}`;
  }
}

class FreshStreamSnapshotCommand implements RecoveryCommand {
  constructor(private readonly titleId: number) {}

  check(model: Readonly<RecoveryModel>): boolean {
    return !model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const revision = model.revision + 1;
    const title = `fresh-stream-${String(this.titleId)}-r${String(revision)}`;
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing live stream");
    source.emit("snapshot", {
      type: "snapshot",
      revision,
      sessions: [session(real.instanceId, { title })],
    });
    model.revision = revision;
    model.title = title;
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return `fresh stream snapshot ${String(this.titleId)}`;
  }
}

class StaleStreamSnapshotCommand implements RecoveryCommand {
  check(model: Readonly<RecoveryModel>): boolean {
    return !model.interrupted;
  }

  async run(model: RecoveryModel, real: RecoveryReal): Promise<void> {
    const source = activeModelStreams()[0];
    if (source === undefined) throw new Error("missing live stream");
    source.emit("snapshot", {
      type: "snapshot",
      revision: Math.max(0, model.revision - 1),
      sessions: [session(real.instanceId, { title: "stale-snapshot-must-not-win" })],
    });
    await assertRecoveryInvariants(model, real);
  }

  toString(): string {
    return "stale stream snapshot";
  }
}

describe("stateful directory recovery model", () => {
  test("preserves recovery invariants across generated browser lifecycle sequences", async () => {
    let modelRun = 0;
    const setup = async (): Promise<{ model: RecoveryModel; real: RecoveryReal }> => {
      modelRun += 1;
      const instanceId = `recovery-model-${String(modelRun).padStart(4, "0")}`;
      const title = "model-initial-r1";
      const harness = await bootApp({
        permission: "denied",
        suffix: `recovery-model-${String(modelRun)}`,
        initialSessions: [session(instanceId, { title })],
      });
      const model = { revision: 1, title, interrupted: false, online: true };
      const real = {
        harness,
        instanceId,
        capabilityCanary: "MODEL_CAPABILITY_CANARY_8f6b10c2",
      };
      await assertRecoveryInvariants(model, real);
      return { model, real };
    };

    await fc.asyncModelRun(setup, [
      new InterruptStreamCommand(false),
      new LoseTimersCommand(120_000),
      new SetReportedOnlineWithoutEventCommand(true),
      new NativeReopenCommand(1),
      new FreshStreamSnapshotCommand(2),
      new StaleStreamSnapshotCommand(),
    ]);

    await fc.asyncModelRun(setup, [
      new InterruptStreamCommand(true),
      new RepeatStreamFailureCommand(4),
      new HideResumeCommand(3),
      new InterruptStreamCommand(true),
      new RepeatStreamFailureCommand(2),
      new SnapshotFallbackCommand(4),
    ]);

    const commandArbitraries: fc.Arbitrary<RecoveryCommand>[] = [
      fc.boolean().map(online => new InterruptStreamCommand(online)),
      fc.integer({ min: 1, max: 5 }).map(count => new RepeatStreamFailureCommand(count)),
      fc.integer({ min: 1_000, max: 180_000 }).map(elapsed => new LoseTimersCommand(elapsed)),
      fc.boolean().map(online => new SetReportedOnlineWithoutEventCommand(online)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new NativeReopenCommand(id)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new SnapshotFallbackCommand(id)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new HideResumeCommand(id)),
      fc.integer({ min: 1, max: 1_000 }).map(id => new FreshStreamSnapshotCommand(id)),
      fc.constant(new StaleStreamSnapshotCommand()),
    ];

    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbitraries, { maxCommands: 30 }), async commands => {
        await fc.asyncModelRun(setup, commands);
      }),
      { numRuns: 50 },
    );
  });
});
