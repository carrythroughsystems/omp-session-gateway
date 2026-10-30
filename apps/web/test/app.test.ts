import { afterAll, describe, expect, mock, test } from "bun:test";
import { MAX_FRAME_BYTES, MAX_SESSIONS, type SessionMetadata } from "@omp-session-gateway/protocol";
import fc, { type AsyncCommand } from "fast-check";
import type { CollabEmbedOptions } from "../../../packages/collab-client/upstream/src/embed-contract";
import { validInitialPromptDraft } from "../src/session-creation";
import { sourceAvailability } from "../src/availability";

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
  /** Inline properties the app sets through CSSOM (transition names); read back by tests. */
  readonly style = {
    overflow: "",
    height: "",
    bottom: "",
    transform: "",
    minHeight: "",
    maxHeight: "",
    properties: new Map<string, string>(),
    setProperty(name: string, value: string): void {
      if (value === "") this.properties.delete(name);
      else this.properties.set(name, value);
    },
    getPropertyValue(name: string): string {
      return this.properties.get(name) ?? "";
    },
  };
  checked = false;
  className = "";
  disabled = false;
  hidden = false;
  inert = false;
  tabIndex = 0;
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

  get offsetHeight(): number {
    return this.className === "tray-grip" ? 24 : 300;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeElement("#text", node) : node;
      child.remove();
      this.children.push(child);
      child.parent = this;
      if (child.tagName === "link") queueMicrotask(() => child.dispatchEvent(new Event("load")));
    }
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  prepend(...children: FakeElement[]): void {
    for (const child of [...children].reverse()) {
      child.remove();
      this.children.unshift(child);
      child.parent = this;
    }
  }

  cloneNode(deep = false): FakeElement {
    const clone = new FakeElement(this.tagName, this.ownText);
    for (const [key, value] of this.attributes) clone.setAttribute(key, value);
    if (deep) clone.append(...this.children.map(child => child.cloneNode(true)));
    return clone;
  }

  remove(): void {
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.children.splice(index, 1);
    this.parent = undefined;
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

  show(): void { this.open = true; }
  focus(): void { (document as unknown as FakeDocument).activeElement = this; }
  contains(node: FakeElement): boolean {
    return node === this || this.children.some(child => child.contains(node));
  }
  getBoundingClientRect(): { height: number; width: number; top: number; bottom: number; left: number; right: number } {
    return { height: this.className === "tray-grip" ? 24 : 300, width: 396, top: 615, bottom: 915, left: 8, right: 404 };
  }

  close(): void {
    this.open = false;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Simple selectors only (class, id, tag, the two attribute forms), optionally comma-separated. */
  matches(selector: string): boolean {
    return selector.split(",").map(part => part.trim()).some(part => {
      if (part.startsWith(".")) return this.className.split(/\s+/u).includes(part.slice(1));
      if (part.startsWith("#")) return this.id === part.slice(1);
      if (part === "[data-instance-id]") return this.dataset.instanceId !== undefined;
      if (part === "dialog[open]") return this.tagName === "dialog" && this.open;
      if (part === "link[data-omp-collab-styles]") return this.tagName === "link" && this.dataset.ompCollabStyles !== undefined;
      return this.tagName.toLowerCase() === part.toLowerCase();
    });
  }

  closest(selector: string): FakeElement | null {
    let element: FakeElement | undefined = this;
    while (element !== undefined) {
      if (element.tagName !== "#text" && element.matches(selector)) return element;
      element = element.parent;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      if (element.tagName !== "#text" && element.matches(selector)) found.push(element);
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
  innerHeight = 915;
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
  activeElement: FakeElement | null = null;

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
    readonly trayHost: FakeElement;
    readonly alertDetailButton: FakeElement;
    readonly settingsButton: FakeElement;
    readonly notificationDetailOptions: FakeElement;
    readonly emptyState: FakeElement;
    readonly notificationDetailInputs: readonly FakeElement[];
    readonly statusBanner: FakeElement;
    readonly directoryTitle: FakeElement;
    readonly directoryCount: FakeElement;
    readonly hostPicker: FakeElement;
    readonly fleetStatus: FakeElement;
    readonly undoCopy: FakeElement;
    readonly undoButton: FakeElement;
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

function openHeroOptions(harness: BrowserHarness): FakeElement | null {
  harness.elements.sessionList.querySelector(".hero-options")?.dispatchEvent(new Event("click"));
  return harness.elements.trayHost.querySelector(".hero-hold");
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
  readonly initialListStatus?: number;
  readonly listResponse?: () => Promise<Response>;
  readonly workerResponse?: unknown;
  readonly permissionResult?: NotificationPermission;
  readonly existingSubscription?: boolean;
  /** WebKit's `toJSON()` omits `expirationTime` when it is null; Chromium includes it. */
  readonly webkitSubscriptionJson?: boolean;
  readonly pathname?: string;
  readonly search?: string;
  readonly storage?: FakeStorage;
  readonly firstRun?: boolean;
  readonly clientConfig?: unknown;
  readonly clientConfigStatus?: number;
  readonly clientConfigResponse?: () => Response;
  readonly remoteSessions?: readonly SessionMetadata[];
  readonly remotePayload?: unknown;
  readonly remoteResponse?: () => Promise<Response>;
  readonly launchGate?: Promise<void>;
  readonly launchResponse?: (path: string, init: RequestInit) => Promise<Response>;
  readonly creationResponse?: (path: string, init: RequestInit) => Promise<Response>;
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
  const trayHost = new FakeElement("dialog");
  const alertDetailButton = new FakeElement("button");
  const settingsButton = new FakeElement("button");
  const notificationDetailOptions = new FakeElement("fieldset");
  notificationDetailOptions.hidden = true;
  const undoCopy = new FakeElement("span");
  const undoButton = new FakeElement("button");
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
    "#tray": trayHost,
    "#alerts-panel": new FakeElement("section"),
    "#detail-panel": new FakeElement("section"),
    "#alert-detail": alertDetailButton,
    "#undo-panel": new FakeElement("section"),
    "#undo-copy": undoCopy,
    "#undo-dismissal": undoButton,
    "#settings": settingsButton,
    "#notification-detail-options": notificationDetailOptions,
    "#recovery-panel": new FakeElement("section"),
    "#gateway-mark": new FakeElement("svg"),
    "#new-session": new FakeElement("button"),
    "#empty-new-session": new FakeElement("button"),
  };
  const document = new FakeDocument(bySelector, notificationDetailInputs);
  const window = new FakeWindow();
  const localStorage = options.storage ?? new FakeStorage();
  if (!options.firstRun) localStorage.setItem("omp.sessions.first-run.v1", JSON.stringify({
    version: 1, step: "done", updatedAt: "2026-10-24T00:00:00.000Z",
  }));
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
  let listStatus = options.initialListStatus ?? 200;
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
    if (path.includes("/session-creation")) {
      return options.creationResponse === undefined ? new Response(null, { status: 404 }) : await options.creationResponse(path, init);
    }
    if (path === "/api/v1/client-config") {
      if (options.clientConfigResponse !== undefined) return options.clientConfigResponse();
      if (options.clientConfigStatus !== undefined) return new Response(null, { status: options.clientConfigStatus });
      return options.clientConfig === undefined ? new Response(null, { status: 404 }) : Response.json(options.clientConfig);
    }
    if (path === "https://remote.example/api/v1/sessions") {
      if (options.remoteResponse !== undefined) return await options.remoteResponse();
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
      return Response.json({ version: 2, applicationServerKey: "V".repeat(87), subscriptionCount: 0 });
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
    if (options.listResponse !== undefined) return await options.listResponse();
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
  if (options.initialListStatus === undefined || options.initialListStatus === 200) {
    await settleUntil(() => FakeEventSource.instances.length === 1);
  }
  if (options.pathname?.startsWith("/collab/") === true) {
    await settleUntil(() => statusBanner.dataset.kind === "expired", 100);
  }

  return {
    elements: {
      sessionList,
      statusBanner,
      notificationButton,
      notificationDisclosure,
      trayHost,
      alertDetailButton,
      settingsButton,
      notificationDetailOptions,
      emptyState,
      notificationDetailInputs,
      directoryTitle,
      directoryCount,
      hostPicker,
      fleetStatus,
      undoCopy,
      undoButton,
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
      window.runTimersWithDelay(350);
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

describe("source-bound session creation", () => {
  const revision = "88330a3a-cc71-4de3-941a-33012d026f14";
  const operationId = "88330a3a-cc71-4de3-941a-33012d026f15";
  const choices = { version: 1, revision, available: true, projects: [
    { id: "synthetic", label: "Synthetic project", workingCopies: [{ id: "main", label: "Main" }] },
  ], profiles: [{ id: "omp", label: "OMP" }] };
  const currentPanel = (harness: BrowserHarness): FakeElement => harness.elements.trayHost.querySelectorAll("section")
    .find(element => !element.inert && element.dataset.panel === harness.elements.trayHost.dataset.panel)!;
  const click = (harness: BrowserHarness, label: string): void => {
    const target = currentPanel(harness)?.querySelectorAll("button").find(button => button.textContent === label);
    expect(target).toBeDefined();
    target!.dispatchEvent(new Event("click"));
  };
  const open = async (harness: BrowserHarness): Promise<void> => {
    document.querySelector("#new-session")!.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.trayHost.dataset.panel === "creation-project", 100);
    click(harness, "Synthetic project");
    expect(harness.elements.trayHost.dataset.panel).toBe("creation-profile");
    click(harness, "OMP");
    expect(harness.elements.trayHost.dataset.panel).toBe("creation-review");
  };
  const seed = (harness: BrowserHarness, value: string): void => {
    const textarea = currentPanel(harness).querySelector("textarea")!;
    textarea.value = value;
    textarea.dispatchEvent(new Event("input"));
  };

  for (const firstLaunchFails of [false, true]) {
    test(`counterexample: bootstrap recovery preserves an accepted creation intent (${firstLaunchFails ? "check again" : "open"})`, async () => {
      const ready = session("creation-bootstrap-bound", { generation: 7 });
      let configRecovered = false;
      let recoveredReads = 0;
      let launches = 0;
      const posted: string[] = [];
      const harness = await bootApp({
        permission: "denied", initialSessions: [], suffix: `creation-bootstrap-${firstLaunchFails}`,
        clientConfigResponse: () => {
          if (!configRecovered) return new Response(null, { status: 503 });
          recoveredReads++;
          return Response.json({
            version: 1, local: { id: "local", label: "Recovered host", origin: "https://sessions.example" },
            targets: [], speech: { browserRecognition: false },
          });
        },
        creationResponse: async (path, init) => {
          if (path.endsWith("options")) return Response.json(choices);
          if (init.method === "POST") {
            posted.push(String(init.body));
            return Response.json({ operationId, state: "accepted" });
          }
          configRecovered = true;
          return Response.json({ operationId, state: "ready", updatedAt: new Date().toISOString(),
            session: { instanceId: ready.instanceId, generation: ready.generation } });
        },
        launchResponse: async () => {
          if (++launches === 1 && firstLaunchFails) return new Response(null, { status: 503 });
          return Response.json({ mode: "control", generation: 7, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
        },
      });
      await open(harness);
      harness.setList(2, [ready]);
      click(harness, "Create and open Control");
      await settleUntil(() => recoveredReads === 1, 100);
      for (let i = 0; i < 200; i++) await Promise.resolve();
      expect(launches).toBe(1);
      if (firstLaunchFails) {
        expect(harness.elements.trayHost.dataset.panel).toBe("creation-terminal");
        currentPanel(harness).querySelector(".tray-leading")!.dispatchEvent(new Event("click"));
        harness.window.runTimersWithDelay(350);
        document.querySelector("#new-session")!.dispatchEvent(new Event("click"));
        expect(harness.elements.trayHost.dataset.panel).toBe("creation-terminal");
        click(harness, "Check creation");
        await settleUntil(() => harness.embedCalls.length === 1, 200);
        expect(launches).toBe(2);
      }
      expect(harness.embedCalls).toHaveLength(1);
      expect(posted).toHaveLength(1);
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  test("refreshes and opens only the exact ready Control binding, draining its volatile draft once", async () => {
    const ready = session("created-session-001", { generation: 7 });
    const posted: unknown[] = [];
    const harness = await bootApp({
      permission: "denied", initialSessions: [], suffix: "creation-ready",
      creationResponse: async (path, init) => {
        if (path.endsWith("options")) return Response.json(choices);
        if (init.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return Response.json({ operationId, state: "accepted" }, { status: 202 });
        }
        return Response.json({ operationId, state: "ready", updatedAt: new Date().toISOString(), session: { instanceId: ready.instanceId, generation: 7 } });
      },
    });
    await open(harness);
    const draft = ["SYNTHETIC", "FIRST_TASK", "CANARY"].join("_");
    seed(harness, draft);
    harness.setList(2, [ready]);
    click(harness, "Create and open Control");
    await settleUntil(() => harness.embedCalls.length === 1, 200);
    expect(harness.launchRequests).toHaveLength(1);
    expect(JSON.parse(String(harness.launchRequests[0]!.init.body))).toEqual({ mode: "control", generation: 7 });
    expect(harness.body.querySelector(".gateway-shell")?.dataset.presentation).not.toBe("request-tray");
    expect(harness.embedCalls[0]!.takeInitialPromptDraft?.()).toBe(draft);
    expect(harness.embedCalls[0]!.takeInitialPromptDraft?.()).toBeUndefined();
    const sinks = JSON.stringify({ posted, storage: [...harness.localStorage.values], history: history.state, requests: harness.fetchPaths });
    expect(sinks).not.toContain(draft);
    expect(sinks).not.toContain("CANARY_VALUE");
    harness.window.dispatchEvent(new Event("pagehide"));
    expect(harness.embedCalls[0]!.takeInitialPromptDraft?.()).toBeUndefined();
  });

  for (const kind of ["generation", "control", "missing"] as const) {
    test(`refuses ready handoff after ${kind} changed`, async () => {
      const ready = session("created-session-002", { generation: 2 });
      const harness = await bootApp({
        permission: "denied", initialSessions: [], suffix: `creation-stale-${kind}`,
        creationResponse: async (path, init) => Response.json(path.endsWith("options") ? choices
          : init.method === "POST" ? { operationId, state: "accepted" }
            : { operationId, state: "ready", updatedAt: new Date().toISOString(), session: { instanceId: ready.instanceId, generation: 2 } }),
      });
      await open(harness);
      harness.setList(2, kind === "missing" ? [] : [{ ...ready, generation: kind === "generation" ? 3 : 2, canControl: kind !== "control" }]);
      click(harness, "Create and open Control");
      await settleUntil(() => harness.elements.trayHost.dataset.panel === "creation-terminal", 200);
      expect(harness.launchRequests).toHaveLength(0);
      expect(currentPanel(harness).textContent).toContain("exact Control session");
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  test("lost acknowledgement requires explicit identical replay and never generates another UUID", async () => {
    const posted: string[] = [];
    const harness = await bootApp({
      permission: "denied", initialSessions: [], suffix: "creation-lost-ack",
      creationResponse: async (path, init) => {
        if (path.endsWith("options")) return Response.json(choices);
        if (init.method === "POST") {
          posted.push(String(init.body));
          if (posted.length === 1) throw new TypeError("synthetic acknowledgement lost");
          return Response.json({ operationId, state: "accepted" });
        }
        return Response.json({ operationId, state: "failed", error: "spawn_failed", updatedAt: new Date().toISOString() });
      },
    });
    await open(harness);
    click(harness, "Create and open Control");
    await settleUntil(() => harness.elements.trayHost.dataset.panel === "creation-terminal", 100);
    expect(posted).toHaveLength(1);
    expect(currentPanel(harness).textContent).toContain("response was lost");
    click(harness, "Check creation");
    await settleUntil(() => currentPanel(harness).textContent!.includes("did not start a command"), 100);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toBe(posted[1]);
    expect(harness.launchRequests).toHaveLength(0);
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  for (const age of [3_599_999, 3_600_000, 25 * 60 * 60 * 1_000]) {
    test(`creation replay is bounded at ${age}ms after a lost acknowledgement`, async () => {
      const previousNow = Date.now;
      let now = previousNow();
      Date.now = () => now;
      let harness: BrowserHarness | undefined;
      try {
        const posted: string[] = [];
        let statuses = 0;
        harness = await bootApp({
          permission: "denied", initialSessions: [], suffix: `creation-replay-age-${age}`,
          creationResponse: async (path, init) => {
            if (path.endsWith("options")) return Response.json(choices);
            if (init.method === "POST") {
              posted.push(String(init.body));
              if (posted.length === 1) throw new TypeError("synthetic acknowledgement lost");
              return Response.json({ operationId, state: "accepted" });
            }
            statuses++;
            return Response.json({ operationId, state: "failed", error: "spawn_failed", updatedAt: new Date().toISOString() });
          },
        });
        await open(harness);
        click(harness, "Create and open Control");
        await settleUntil(() => harness!.elements.trayHost.dataset.panel === "creation-terminal", 100);
        const listsBefore = harness.fetchPaths.filter(path => path === "/api/v1/sessions").length;
        now += age;
        click(harness, "Check creation");
        await settleUntil(() => harness!.elements.trayHost.dataset.panel === "creation-terminal", 200);
        if (age < 3_600_000) {
          expect(posted).toHaveLength(2);
          expect(posted[1]).toBe(posted[0]);
          expect(statuses).toBe(1);
        } else {
          expect(posted).toHaveLength(1);
          expect(statuses).toBe(0);
          expect(harness.fetchPaths.filter(path => path === "/api/v1/sessions").length).toBe(listsBefore + 1);
          expect(currentPanel(harness).textContent).toContain("acknowledgement was lost");
          expect(currentPanel(harness).textContent).toContain("session may already exist");
          click(harness, "Check creation");
          await settleUntil(() => harness!.elements.trayHost.dataset.panel === "creation-terminal", 200);
          expect(posted).toHaveLength(1);
        }
        expect(harness.pendingDelays()).not.toContain(1_000);
        expect(harness.launchRequests).toHaveLength(0);
      } finally {
        harness?.window.dispatchEvent(new Event("pagehide"));
        Date.now = previousNow;
      }
    });
  }

  test("creation replay stays GET-only for an acknowledged intent older than one hour", async () => {
    let statuses = 0;
    const harness = await bootApp({
      permission: "denied", initialSessions: [], suffix: "creation-old-known-operation",
      creationResponse: async (path, init) => {
        if (path.endsWith("options")) return Response.json(choices);
        if (init.method === "POST") return Response.json({ operationId, state: "accepted" });
        statuses++;
        return statuses === 1
          ? Response.json({ operationId, state: "awaiting_omp", updatedAt: new Date().toISOString() })
          : new Response(null, { status: 404 });
      },
    });
    await open(harness);
    click(harness, "Create and open Control");
    await settleUntil(() => statuses === 1 && harness.pendingDelays().includes(1_000), 100);
    currentPanel(harness).querySelector(".tray-leading")!.dispatchEvent(new Event("click"));
    harness.window.runTimersWithDelay(350);
    harness.advanceClock(25 * 60 * 60 * 1_000);
    document.querySelector("#new-session")!.dispatchEvent(new Event("click"));
    click(harness, "Check creation");
    await settleUntil(() => harness.elements.trayHost.dataset.panel === "creation-terminal", 100);
    expect(statuses).toBe(2);
    expect(harness.fetchPaths.filter(path => path === "/api/v1/session-creations")).toHaveLength(1);
    expect(currentPanel(harness).textContent).toContain("no longer available");
    expect(harness.pendingDelays()).not.toContain(1_000);
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  test("fresh creation after backgrounded review starts with an empty first task", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [], suffix: "creation-fresh-background-review",
      creationResponse: async () => Response.json(choices),
    });
    await open(harness);
    seed(harness, "SYNTHETIC_ABANDONED_REVIEW_TASK");
    harness.setVisibility("hidden");
    harness.setVisibility("visible");
    await open(harness);
    expect(currentPanel(harness).querySelector("textarea")!.value).toBe("");
    expect(harness.fetchPaths.filter(path => path === "/api/v1/session-creations")).toHaveLength(0);
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  test("fresh creation discards the failed ready holder even if that binding is observed again", async () => {
    let launches = 0;
    const posted: string[] = [];
    const ready = session("creation-abandoned-draft");
    const harness = await bootApp({
      permission: "denied", initialSessions: [], suffix: "creation-fresh-failed-holder",
      creationResponse: async (path, init) => {
        if (path.endsWith("options")) return Response.json(choices);
        if (init.method === "POST") {
          posted.push(String(init.body));
          return Response.json({ operationId, state: "accepted" });
        }
        return Response.json({ operationId, state: "ready", updatedAt: new Date().toISOString(),
          session: { instanceId: ready.instanceId, generation: 1 } });
      },
      launchResponse: async () => ++launches === 1 ? new Response(null, { status: 503 }) : Response.json({
        generation: 1, mode: "control", capability: ["FRESH", "CREATION", "CANARY", "0000000000000000"].join("__"),
      }),
    });
    await open(harness);
    seed(harness, "SYNTHETIC_ABANDONED_READY_TASK");
    harness.setList(2, [ready]);
    click(harness, "Create and open Control");
    await settleUntil(() => launches === 1 && harness.elements.trayHost.dataset.panel === "creation-terminal", 200);
    click(harness, "Start another session");
    await settleUntil(() => harness.elements.trayHost.dataset.panel === "creation-project", 100);
    click(harness, "Synthetic project");
    click(harness, "OMP");
    expect(currentPanel(harness).querySelector("textarea")!.value).toBe("");
    click(harness, "Create and open Control");
    await settleUntil(() => harness.embedCalls.length === 1, 200);
    expect(posted).toHaveLength(2);
    expect(JSON.parse(posted[0]!).clientOperationId).not.toBe(JSON.parse(posted[1]!).clientOperationId);
    expect(harness.embedCalls[0]!.takeInitialPromptDraft?.()).toBeUndefined();
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  for (const reason of ["close", "hidden", "discard", "offline"] as const) {
    test(`creation handoff status settles after ${reason} without replacing a newer failure`, async () => {
      const gate = Promise.withResolvers<void>();
      const ready = session("creation-banner-0001");
      const harness = await bootApp({
        permission: "denied", initialSessions: [], suffix: `creation-banner-${reason}`, launchGate: gate.promise,
        // A stale notification locks SSE status changes; the launch must settle its own banner.
        ...(reason === "discard" ? { pathname: "/collab/synthetic-expired-0001", search: "?activity=stopped&generation=1" } : {}),
        creationResponse: async (path, init) => Response.json(path.endsWith("options") ? choices
          : init.method === "POST" ? { operationId, state: "accepted" }
            : { operationId, state: "ready", updatedAt: new Date().toISOString(), session: { instanceId: ready.instanceId, generation: 1 } }),
      });
      await open(harness);
      harness.setList(2, [ready]);
      click(harness, "Create and open Control");
      await settleUntil(() => harness.launchRequests.length === 1, 200);
      expect(harness.elements.statusBanner.dataset.kind).toBe("loading");
      if (reason === "discard") {
        harness.emit("session_upsert", { type: "session_upsert", revision: 3, session: { ...ready, generation: 2 } });
        expect(harness.elements.statusBanner.dataset.kind).toBe("loading");
      } else if (reason === "hidden") harness.setVisibility("hidden");
      else {
        if (reason === "offline") harness.window.dispatchEvent(new Event("offline"));
        currentPanel(harness).querySelector(".tray-leading")!.dispatchEvent(new Event("click"));
      }
      gate.resolve();
      if (reason === "discard") await settleUntil(() => harness.elements.trayHost.dataset.panel === "creation-terminal", 200);
      else for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(harness.elements.statusBanner.dataset.kind).toBe(reason === "offline" ? "offline" : "ready");
      expect(harness.elements.statusBanner.hidden).toBe(reason !== "offline");
      expect(harness.embedCalls).toHaveLength(0);
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  for (const reason of ["hidden", "scope", "close", "pagehide", "competing"] as const) {
    test(`${reason} invalidates a late ready status and clears or suspends its draft`, async () => {
      const pending = Promise.withResolvers<Response>();
      let statusSignal: AbortSignal | null | undefined;
      const ready = session("created-session-003");
      const harness = await bootApp({
        permission: "denied", initialSessions: [], suffix: `creation-cancel-${reason}`,
        creationResponse: async (path, init) => {
          if (path.endsWith("options")) return Response.json(choices);
          if (init.method === "POST") return Response.json({ operationId, state: "accepted" });
          statusSignal = init.signal;
          return pending.promise;
        },
      });
      await open(harness);
      seed(harness, "SYNTHETIC_SUSPENDED_TASK");
      harness.setList(2, [ready]);
      click(harness, "Create and open Control");
      await settleUntil(() => statusSignal !== undefined, 100);
      if (reason === "hidden") harness.setVisibility("hidden");
      else if (reason === "scope") harness.elements.hostPicker.dispatchEvent(new Event("change"));
      else if (reason === "close") currentPanel(harness).querySelector(".tray-leading")!.dispatchEvent(new Event("click"));
      else if (reason === "competing") harness.elements.settingsButton.dispatchEvent(new Event("click"));
      else harness.window.dispatchEvent(new Event("pagehide"));
      expect(statusSignal!.aborted).toBeTrue();
      pending.resolve(Response.json({ operationId, state: "ready", updatedAt: new Date().toISOString(), session: { instanceId: ready.instanceId, generation: 1 } }));
      for (let i = 0; i < 100; i++) await Promise.resolve();
      if (reason === "hidden") harness.setVisibility("visible");
      expect(harness.launchRequests).toHaveLength(0);
      expect(harness.embedCalls).toHaveLength(0);
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  test("polling waits for completion, stops at 120 seconds, and a late manual Check is one GET", async () => {
    let statuses = 0;
    const harness = await bootApp({
      permission: "denied", initialSessions: [], suffix: "creation-deadline",
      creationResponse: async (path, init) => {
        if (path.endsWith("options")) return Response.json(choices);
        if (init.method === "POST") return Response.json({ operationId, state: "accepted" });
        statuses++;
        return Response.json({ operationId, state: "awaiting_omp", updatedAt: new Date().toISOString() });
      },
    });
    await open(harness);
    click(harness, "Create and open Control");
    await settleUntil(() => statuses === 1 && harness.pendingDelays().includes(1_000), 100);
    harness.window.runTimersWithDelay(1_000);
    await settleUntil(() => statuses === 2 && harness.pendingDelays().includes(1_000), 100);
    harness.advanceClock(120_001);
    const deadline = harness.pendingDelays().find(delay => delay > 110_000)!;
    harness.window.runTimersWithDelay(deadline);
    expect(currentPanel(harness).textContent).toContain("Stopped watching");
    click(harness, "Check creation");
    await settleUntil(() => statuses === 3 && harness.elements.trayHost.dataset.panel === "creation-terminal", 100);
    expect(harness.pendingDelays()).not.toContain(1_000);
    expect(harness.fetchPaths.filter(path => path === "/api/v1/session-creations")).toHaveLength(1);
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  test("first-task limits count Unicode code points, not UTF-16 code units", () => {
    expect(validInitialPromptDraft("𐐀".repeat(8_000))).toBeTrue();
    expect(validInitialPromptDraft("𐐀".repeat(8_001))).toBeFalse();
    expect(validInitialPromptDraft("a".repeat(8_001))).toBeFalse();
  });

  test("creation progress advances three steps and keeps Opening Control cancellable until mount", async () => {
    for (const close of [false, true]) {
      const gate = Promise.withResolvers<void>();
      const ready = session("creation-progress-001");
      let statusReads = 0;
      const states = ["accepted", "launching", "awaiting_omp", "ready"];
      const harness = await bootApp({
        permission: "denied", initialSessions: [], suffix: `creation-progress-steps-${close}`, launchGate: gate.promise,
        creationResponse: async (path, init) => {
          if (path.endsWith("options")) return Response.json(choices);
          if (init.method === "POST") return Response.json({ operationId, state: "accepted" });
          const state = states[statusReads++]!;
          return Response.json({ operationId, state, updatedAt: new Date().toISOString(),
            ...(state === "ready" ? { session: { instanceId: ready.instanceId, generation: 1 } } : {}) });
        },
      });
      await open(harness);
      seed(harness, "SYNTHETIC_PROGRESS_DRAFT");
      harness.setList(2, [ready]);
      click(harness, "Create and open Control");
      await settleUntil(() => statusReads === 1 && harness.pendingDelays().includes(1_000), 100);
      const initial = currentPanel(harness);
      const stepStates = (): (string | undefined)[] => currentPanel(harness).querySelectorAll("li").map(step => step.dataset.state);
      expect(initial.querySelectorAll("li").map(step => step.textContent)).toEqual(["Starting in Tern", "Waiting for OMP", "Opening Control"]);
      expect(stepStates()).toEqual(["active", "future", "future"]);
      harness.window.runTimersWithDelay(1_000);
      await settleUntil(() => statusReads === 2 && harness.pendingDelays().includes(1_000), 100);
      expect(currentPanel(harness)).toBe(initial);
      harness.window.runTimersWithDelay(1_000);
      await settleUntil(() => stepStates()[1] === "active", 100);
      expect(stepStates()).toEqual(["done", "active", "future"]);
      expect(currentPanel(harness).querySelector("path")?.getAttribute("d")).toBe("M4 10l4 4 8-8");
      harness.window.runTimersWithDelay(1_000);
      await settleUntil(() => harness.launchRequests.length === 1, 200);
      expect(stepStates()).toEqual(["done", "done", "active"]);
      expect(currentPanel(harness).querySelectorAll("svg")).toHaveLength(2);
      expect(harness.elements.trayHost.open).toBeTrue();
      if (close) {
        currentPanel(harness).querySelector(".tray-leading")!.dispatchEvent(new Event("click"));
        expect(harness.launchRequests[0]!.init.signal!.aborted).toBeTrue();
      }
      gate.resolve();
      if (close) {
        for (let i = 0; i < 100; i++) await Promise.resolve();
        expect(harness.embedCalls).toHaveLength(0);
      } else {
        await settleUntil(() => harness.embedCalls.length === 1, 200);
        expect(harness.elements.trayHost.open).toBeFalse();
        expect(harness.embedCalls[0]!.takeInitialPromptDraft?.()).toBe("SYNTHETIC_PROGRESS_DRAFT");
      }
      harness.window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a failed pre-mount launch retries the same binding with its draft, while explicit Close discards it", async () => {
    for (const close of [false, true]) {
      let launches = 0;
      const ready = session("created-retry-0001");
      const harness = await bootApp({
        permission: "denied", initialSessions: [], suffix: `creation-open-retry-${close}`,
        creationResponse: async (path, init) => Response.json(path.endsWith("options") ? choices
          : init.method === "POST" ? { operationId, state: "accepted" }
            : { operationId, state: "ready", updatedAt: new Date().toISOString(), session: { instanceId: ready.instanceId, generation: 1 } }),
        launchResponse: async () => ++launches === 1 ? new Response(null, { status: 503 }) : Response.json({
          generation: 1, mode: "control", capability: ["CREATION", "CANARY", "0000000000000000"].join("__"),
        }),
      });
      await open(harness);
      seed(harness, "SYNTHETIC_RETRY_DRAFT");
      harness.setList(2, [ready]);
      click(harness, "Create and open Control");
      await settleUntil(() => launches === 1 && harness.elements.trayHost.dataset.panel === "creation-terminal", 200);
      if (close) {
        currentPanel(harness).querySelector(".tray-leading")!.dispatchEvent(new Event("click"));
        harness.window.runTimersWithDelay(350);
        document.querySelector("#new-session")!.dispatchEvent(new Event("click"));
      }
      click(harness, "Check creation");
      await settleUntil(() => harness.embedCalls.length === 1, 200);
      expect(harness.embedCalls[0]!.takeInitialPromptDraft?.()).toBe(close ? undefined : "SYNTHETIC_RETRY_DRAFT");
      expect(harness.fetchPaths.filter(path => path === "/api/v1/session-creations")).toHaveLength(1);
      harness.window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("readable creation authorization loss clears the source and stops tracking", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [session("creation-forbidden-01")], suffix: "creation-forbidden",
      creationResponse: async (path, init) => path.endsWith("options") ? Response.json(choices)
        : init.method === "POST" ? Response.json({ operationId, state: "accepted" }) : new Response(null, { status: 403 }),
    });
    await open(harness);
    seed(harness, "SYNTHETIC_REVOKED_DRAFT");
    click(harness, "Create and open Control");
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "unauthorized", 100);
    expect(harness.elements.trayHost.open).toBeFalse();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
    expect(harness.launchRequests).toHaveLength(0);
    expect(harness.pendingDelays()).not.toContain(1_000);
    expect(JSON.stringify([...harness.localStorage.values])).not.toContain("SYNTHETIC_REVOKED_DRAFT");
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  test("council476: creation denial invalidates the pre-denial stream and observation", async () => {
    const oldSession = session("creation-denied-stream");
    const harness = await bootApp({
      permission: "denied", initialSessions: [oldSession], suffix: "creation-denied-old-stream",
      creationResponse: async (path, init) => path.endsWith("options") ? Response.json(choices)
        : init.method === "POST" ? Response.json({ operationId, state: "accepted" }) : new Response(null, { status: 403 }),
    });
    const oldStream = FakeEventSource.instances.at(-1)!;
    await open(harness);
    click(harness, "Create and open Control");
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "unauthorized", 100);
    oldStream.emit("session_upsert", { type: "session_upsert", revision: 99, session: oldSession });
    oldStream.emit("keepalive", {});
    oldStream.onerror?.();
    expect(harness.elements.statusBanner.dataset.kind).toBe("unauthorized");
    expect(oldStream.closed).toBeTrue();
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
    harness.setOnline(false);
    harness.window.dispatchEvent(new Event("offline"));
    expect(harness.elements.statusBanner.textContent).toContain("The previous session list was withdrawn.");
    harness.window.dispatchEvent(new Event("pagehide"));
  });
});

describe("dashboard attention and notifications", () => {
  test("first-run writes only bounded step/timestamp records, resumes, and persists native Back and skip", async () => {
    const storage = new FakeStorage();
    const options = { permission: "denied" as const, firstRun: true, storage, initialSessions: [session("intro-session-0001")] };
    const first = await bootApp({ ...options, suffix: "first-run-fresh" });
    const host = first.elements.trayHost;
    expect(host.dataset.panel).toBe("first-run-connected");
    expect(host.querySelector(".first-run-copy")?.textContent).toBe("This phone is on your tailnet. 1 live session is listed across the checked hosts.");
    expect(host.querySelector(".tray-leading")?.getAttribute("aria-label")).toBe("Skip introduction");
    expect(first.permissionRequests.count).toBe(0);
    expect(first.launchRequests).toEqual([]);
    host.querySelector(".first-run-next")?.dispatchEvent(new Event("click"));
    expect(host.dataset.panel).toBe("first-run-alerts");
    const record = JSON.parse(storage.getItem("omp.sessions.first-run.v1")!);
    expect(record).toEqual({ version: 1, step: "alerts", updatedAt: expect.any(String) });
    expect(new Date(record.updatedAt).toISOString()).toBe(record.updatedAt);
    expect(storage.getItem("omp.sessions.first-run.v1")!.length).toBeLessThanOrEqual(128);

    const resumed = await bootApp({ ...options, suffix: "first-run-resumed" });
    expect(resumed.elements.trayHost.dataset.panel).toBe("first-run-alerts");
    resumed.elements.trayHost.querySelector(".first-run-not-now")?.dispatchEvent(new Event("click"));
    expect(JSON.parse(storage.getItem("omp.sessions.first-run.v1")!).step).toBe("modes");
    resumed.elements.trayHost.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(resumed.elements.trayHost.dataset.panel).toBe("first-run-alerts");
    expect(JSON.parse(storage.getItem("omp.sessions.first-run.v1")!).step).toBe("alerts");
    resumed.elements.trayHost.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(resumed.elements.trayHost.dataset.panel).toBe("first-run-connected");
    expect(storage.getItem("omp.sessions.first-run.v1")).toBeNull();
    resumed.elements.trayHost.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(JSON.parse(storage.getItem("omp.sessions.first-run.v1")!).step).toBe("done");
    resumed.window.runTimersWithDelay(350);
    const done = await bootApp({ ...options, suffix: "first-run-done" });
    expect(done.elements.trayHost.open).toBeFalse();
  });

  test("first-run treats corrupt, oversized, unsupported and extra-field records as done", async () => {
    for (const [index, value] of [
      "{", "null", "[]", "x".repeat(129),
      JSON.stringify({ version: 2, step: "alerts", updatedAt: "2026-10-24T00:00:00.000Z" }),
      JSON.stringify({ version: 1, step: "connected", updatedAt: "2026-10-24T00:00:00.000Z" }),
      JSON.stringify({ version: 1, step: ["alerts"], updatedAt: "2026-10-24T00:00:00.000Z" }),
      JSON.stringify({ version: 1, step: "alerts", updatedAt: "invalid" }),
      JSON.stringify({ version: 1, step: "alerts", updatedAt: "2026-02-30T00:00:00.000Z" }),
      JSON.stringify({ version: 1, step: "alerts", updatedAt: "2026-10-24T00:00:00.000Z", instanceId: "not-allowed" }),
    ].entries()) {
      const storage = new FakeStorage();
      storage.setItem("omp.sessions.first-run.v1", value);
      const harness = await bootApp({ permission: "denied", firstRun: true, storage, initialSessions: [], suffix: `first-run-corrupt-${index}` });
      expect(harness.elements.trayHost.open).toBeFalse();
      expect(storage.getItem("omp.sessions.first-run.v1")).toBe(value);
    }
  });

  test("all-clear arrival is consumed once for same-scope queue clearance, including held and ended requests", async () => {
    const waiting = session("arrival-session-0001", { inputRequired: true });
    const working = session(waiting.instanceId);
    const harness = await bootApp({ permission: "denied", initialSessions: [working], suffix: "arrival-gate",
      clientConfig: { version: 1, local: { id: "local", label: "Home", origin: "https://sessions.example" }, targets: [], speech: { browserRecognition: false } },
    });
    const arrived = (): string | undefined => harness.elements.sessionList.querySelector(".all-clear-summary")?.dataset.arrived;
    expect(arrived()).toBeUndefined();
    const fakeDocument = globalThis.document as unknown as Record<string, unknown>;
    class FakeViewTransition { get types(): Set<string> { return new Set(); } }
    Object.defineProperty(globalThis, "ViewTransition", { configurable: true, value: FakeViewTransition });
    fakeDocument.startViewTransition = (options: { update: () => void }) => {
      options.update();
      return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    };
    let revision = 1;
    const upsert = (value: SessionMetadata): void => harness.emit("session_upsert", { type: "session_upsert", revision: ++revision, session: value });
    try {
      upsert(waiting);
      upsert(working);
      expect(arrived()).toBe("true");
      upsert({ ...working, lastSeenAt: "2026-07-21T10:06:00.000Z" });
      expect(arrived()).toBeUndefined();
      upsert(waiting);
      openHeroOptions(harness)?.dispatchEvent(new Event("click"));
      harness.window.runTimersWithDelay(350);
      expect(harness.elements.sessionList.querySelector(".held-row")).not.toBeNull();
      upsert(working);
      expect(arrived()).toBe("true");
      // Changing scope while the queue disappears is not an answered-request arrival.
      upsert(waiting);
      harness.elements.hostPicker.value = "local\0https://sessions.example";
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      expect(arrived()).toBeUndefined();
      upsert(working);
      expect(arrived()).toBe("true");
      harness.elements.hostPicker.value = "all";
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      expect(arrived()).toBeUndefined();
      upsert(waiting);
      harness.emit("session_remove", { type: "session_remove", revision: ++revision, instanceId: waiting.instanceId, generation: 1 });
      expect(arrived()).toBe("true");
      upsert(waiting);
      harness.setVisibility("hidden");
      upsert(working);
      expect(arrived()).toBeUndefined();
    } finally {
      delete fakeDocument.startViewTransition;
      delete (globalThis as Record<string, unknown>).ViewTransition;
    }
  });

  test("switching from an all-hosts queue to an already-clear host never arrives", async () => {
    const harness = await bootApp({
      permission: "denied", suffix: "arrival-scope",
      initialSessions: [session("arrival-local-0001")],
      remoteSessions: [session("arrival-remote-0001", { inputRequired: true })],
      clientConfig: {
        version: 1, local: { id: "local", label: "Home", origin: "https://sessions.example" },
        targets: [{ id: "remote", label: "Remote", origin: "https://remote.example" }],
        speech: { browserRecognition: false },
      },
    });
    await settleUntil(() => harness.elements.sessionList.querySelector(".queue-hero") !== null, 100);
    const fakeDocument = globalThis.document as unknown as Record<string, unknown>;
    class FakeViewTransition { get types(): Set<string> { return new Set(); } }
    Object.defineProperty(globalThis, "ViewTransition", { configurable: true, value: FakeViewTransition });
    const calls: string[] = [];
    fakeDocument.startViewTransition = (options: { update: () => void; types: string[] }) => {
      calls.push(...options.types);
      options.update();
      return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    };
    try {
      harness.elements.hostPicker.value = "local\0https://sessions.example";
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      expect(calls).toEqual(["list"]);
      expect(harness.elements.sessionList.querySelector(".all-clear-title")?.textContent).toBe("All clear");
      expect(harness.elements.sessionList.querySelector(".all-clear-summary")?.dataset.arrived).toBeUndefined();
    } finally {
      delete fakeDocument.startViewTransition;
      delete (globalThis as Record<string, unknown>).ViewTransition;
    }
  });

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
    expect(hero?.querySelector(".hero-options")?.textContent).toBe("Options");
    hero?.querySelector(".hero-options")?.dispatchEvent(new Event("click"));
    expect(harness.elements.trayHost.querySelectorAll(".tray-choice").map(action => action.textContent)).toEqual([
      "Hold for desk", "View transcript",
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

  test("animates only genuine list changes and user actions, never routine refreshes or hidden pages", async () => {
    const first = session("motion-gate-0001", { busy: true, startedAt: "2026-07-21T11:00:00.000Z" });
    const second = session("motion-gate-0002", { busy: true, startedAt: "2026-07-21T10:00:00.000Z" });
    const harness = await bootApp({ permission: "denied", suffix: "motion-gate", initialSessions: [first, second] });
    const calls: string[] = [];
    const fakeDocument = globalThis.document as unknown as Record<string, unknown>;
    class FakeViewTransition {
      get types(): Set<string> { return new Set(); }
    }
    Object.defineProperty(globalThis, "ViewTransition", { configurable: true, value: FakeViewTransition });
    fakeDocument.startViewTransition = (options: { update: () => void; types: readonly string[] }) => {
      calls.push(options.types.join());
      options.update();
      return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition(): void {} };
    };
    try {
      // Routine refresh: only lastSeenAt moved.
      harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: { ...first, lastSeenAt: "2026-07-21T10:05:00.000Z" } });
      expect(calls).toEqual([]);
      // Genuine state change: Working → Idle.
      harness.emit("session_upsert", { type: "session_upsert", revision: 3, session: { ...first, busy: false } });
      expect(calls).toEqual(["list"]);
      const rows = harness.elements.sessionList.querySelectorAll(".working-row-frame");
      expect(rows.map(row => row.style.getPropertyValue("view-transition-class"))).toEqual(["omp-row", "omp-row"]);
      const names = rows.map(row => row.style.getPropertyValue("view-transition-name"));
      expect(new Set(names).size).toBe(2);
      // User action: Hide, then Undo; the row keeps the same opaque name across both.
      harness.elements.sessionList.querySelector(".dismiss-session")?.dispatchEvent(new Event("click"));
      expect(calls).toEqual(["list", "list"]);
      harness.elements.undoButton.dispatchEvent(new Event("click"));
      expect(calls).toEqual(["list", "list", "list"]);
      const restored = harness.elements.sessionList.querySelectorAll(".working-row-frame");
      expect(restored.map(row => row.style.getPropertyValue("view-transition-name"))).toEqual(names);
      // Group change: the first session asks for input and becomes the hero.
      harness.emit("session_upsert", { type: "session_upsert", revision: 4, session: session(first.instanceId, { ...first, busy: false, inputRequired: true }) });
      expect(calls).toEqual(["list", "list", "list", "list"]);
      expect(harness.elements.sessionList.querySelector(".queue-hero")?.style.getPropertyValue("view-transition-class")).toBe("omp-row");
      // Hidden page: the same kind of change renders without motion.
      harness.setVisibility("hidden");
      harness.emit("session_upsert", { type: "session_upsert", revision: 5, session: { ...second, busy: false } });
      expect(calls).toHaveLength(4);
      expect(harness.elements.sessionList.querySelector(".working-row-frame")?.querySelector(".session-tile")?.dataset.state).toBe("idle");
    } finally {
      delete fakeDocument.startViewTransition;
      delete (globalThis as Record<string, unknown>).ViewTransition;
    }
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
      "This device is online, but your tailnet isn't answering. Check that Tailscale is connected.",
    );
    expect(tailnet.elements.statusBanner.querySelector(".status-freshness")?.textContent).toContain(
      "list as of",
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
    expect(harness.elements.statusBanner.children).toHaveLength(1);
    expect(harness.elements.statusBanner.querySelector(".status-guidance")?.textContent).toContain(
      "The browser may be stuck after sleep or a network change",
    );
    const troubleshooting = harness.elements.statusBanner
      .querySelectorAll(".status-action")
      .find(element => element.tagName === "button" && element.textContent === "Troubleshooting");
    troubleshooting?.dispatchEvent(new Event("click"));
    expect(harness.elements.trayHost.open).toBeTrue();

    harness.setList(2, [base]);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.hidden);
    expect(harness.elements.statusBanner.querySelector(".status-guidance")).toBeNull();
    harness.window.runTimersWithDelay(350);
    expect(harness.elements.trayHost.open).toBeFalse();
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
    expect(harness.elements.trayHost.open).toBeTrue();
    harness.elements.alertDetailButton.dispatchEvent(new Event("click"));
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

  test("counterexample: a failed first snapshot keeps its fault banner while its retry is pending", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [], initialListStatus: 503, suffix: "first-failure-pending",
    });
    expect(harness.elements.statusBanner.dataset.kind).toBe("desktop");
    const copy = harness.elements.statusBanner.textContent;
    harness.setList(2, []);
    harness.hangNextListRequest();
    const retryDelay = Math.min(...harness.pendingDelays().filter(delay => delay <= 4_000));
    harness.window.runTimersWithDelay(retryDelay);
    await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 2);
    expect(harness.elements.statusBanner.dataset.kind).toBe("desktop");
    expect(harness.elements.statusBanner.textContent).toBe(copy);
    expect(harness.elements.statusBanner.children).toHaveLength(1);
    harness.setVisibility("hidden");
    harness.freeze();
  });

  for (const freeze of [false, true]) {
    test(`council476: first-snapshot fault survives hide/show${freeze ? " and freeze" : ""}`, async () => {
      const harness = await bootApp({
        permission: "denied", initialSessions: [], initialListStatus: 503, suffix: `first-fault-visibility-${freeze}`,
      });
      harness.hangNextListRequest();
      harness.setVisibility("hidden");
      if (freeze) harness.freeze();
      harness.setVisibility("visible");
      await settleUntil(() => harness.fetchPaths.filter(path => path === "/api/v1/sessions").length === 2);
      expect(harness.elements.statusBanner.dataset.kind).toBe("desktop");
      expect(harness.elements.statusBanner.children).toHaveLength(1);
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  for (const via of ["launch", "probe"] as const) {
    test(`council476: local ${via} denial withdraws metadata and rejects pre-denial events`, async () => {
      const oldSession = session(`local-${via}-denied`);
      const harness = await bootApp({
        permission: "denied", initialSessions: [oldSession], suffix: `local-${via}-withdrawal`,
        ...(via === "launch" ? { launchResponse: async () => new Response(null, { status: 403 }) } : {}),
      });
      const oldStream = FakeEventSource.instances.at(-1)!;
      harness.elements.sessionList.querySelector(".working-row")!.dispatchEvent(new Event("click"));
      if (via === "probe") {
        await settleUntil(() => harness.embedCalls.length === 1, 100);
        harness.setList(2, [], 403);
        await harness.embedCalls[0]!.probeGateway!(new AbortController().signal);
      } else await settleUntil(() => harness.elements.statusBanner.dataset.kind === "unauthorized", 100);
      oldStream.emit("session_upsert", { type: "session_upsert", revision: 99, session: oldSession });
      oldStream.emit("keepalive", {});
      oldStream.onerror?.();
      expect(harness.elements.statusBanner.dataset.kind).toBe("unauthorized");
      expect(oldStream.closed).toBeTrue();
      expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(0);
      harness.setOnline(false);
      harness.window.dispatchEvent(new Event("offline"));
      expect(harness.elements.statusBanner.textContent).toContain("The previous session list was withdrawn.");
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  test("council476: a retained empty single-host observation keeps its clock in All hosts", async () => {
    const harness = await bootApp({ permission: "denied", initialSessions: [], suffix: "all-retained-empty" });
    harness.disconnectEvents();
    expect(harness.elements.emptyState.textContent).toContain("No sessions as of");
    harness.window.dispatchEvent(new Event("pagehide"));
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

    openHeroOptions(harness)?.dispatchEvent(new Event("click"));
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

    const staleFirstHold = openHeroOptions(harness);
    openHeroOptions(harness)?.dispatchEvent(new Event("click"));
    openHeroOptions(harness)?.dispatchEvent(new Event("click"));
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
    expect(!harness.elements.trayHost.open).toBeFalse();
    expect(harness.elements.undoCopy.querySelector(".undo-label")?.textContent).toBe("Hidden on this device");
    expect(harness.elements.undoCopy.querySelector(".undo-session-title")?.textContent).toBe("Dismiss One");
    expect(harness.elements.trayHost.querySelector(".tray-header")).toBeNull();
    expect(harness.elements.trayHost.querySelector(".tray-grip")?.hidden).toBeTrue();
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

    harness.elements.undoButton.dispatchEvent(new Event("click"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(2);
    expect(harness.localStorage.getItem("omp.sessions.dismissed.v2")).toBe("[]");

    harness.elements.sessionList.querySelectorAll(".dismiss-session")[0]?.dispatchEvent(new Event("click"));
    harness.runUndoTimer();
    expect(!harness.elements.trayHost.open).toBeTrue();
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
    expect(!reloaded.elements.trayHost.open).toBeTrue();
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
    openHeroOptions(harness)?.dispatchEvent(new Event("click"));
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

  for (const advance of ["next", "hold"] as const) {
    for (const failure of [403, 404, 409, 503, "withdrawn"] as const) {
      test(`successor4: remote ${advance} owns local target ${failure}`, async () => {
        const home = session(`local-target-${advance}-${failure}`, { inputRequired: true });
        const remote = session(`remote-predecessor-${advance}-${failure}`, { inputRequired: true });
        const payload = { revision: 1, sessions: [remote] };
        const listGate = Promise.withResolvers<void>();
        const launchGate = Promise.withResolvers<void>();
        let holdList = false;
        let reads = 0;
        const harness = await bootApp({
          permission: "denied", initialSessions: [home], clientConfig: config, remotePayload: payload,
          suffix: `local-target-${advance}-${failure}`,
          listResponse: async () => {
            reads += 1;
            if (holdList) await listGate.promise;
            return Response.json({ revision: 1, sessions: [home] });
          },
          launchResponse: async (path, init) => {
            if (!path.startsWith("https://remote.example")) {
              if (failure !== "withdrawn") return new Response(null, { status: failure });
              await launchGate.promise;
            }
            const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
            return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
          },
        });
        try {
          await settleUntil(() => harness.elements.directoryCount.textContent === "2 waiting", 100);
          const hero = harness.elements.sessionList.querySelector(".queue-hero")!;
          const open = hero.dataset.sourceKey === "remote\0https://remote.example" ? hero.querySelector(".action-request")
            : harness.elements.sessionList.querySelectorAll(".queue-row").find(row => row.dataset.sourceKey === "remote\0https://remote.example");
          open!.dispatchEvent(new Event("click"));
          await settleUntil(() => harness.embedCalls.length === 1, 100);
          const health = { state: "healthy" as const, rttMs: 1, lastSuccessAt: Date.now(), failureSince: null, retryAt: null };
          const healthy = { phase: "live" as const, endedReason: null, requestPending: advance === "hold",
            responsePending: false, loading: null, gatewayHealth: health, relayHealth: health };
          harness.embedCalls[0]!.onStateChange!(healthy);
          if (advance === "next") {
            payload.revision += 1;
            payload.sessions = [session(remote.instanceId)];
            harness.window.dispatchEvent(new Event("online"));
            await settleUntil(() => harness.body.querySelector(".triage-action")?.textContent === "Next ask →", 100);
          }
          const priorReads = reads;
          holdList = true;
          harness.body.querySelector(".triage-action")!.dispatchEvent(new Event("click"));
          await settleUntil(() => harness.launchRequests.length === 2, 100);
          if (failure === "withdrawn") {
            harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: { ...home, canControl: false } });
            launchGate.resolve();
          }
          for (let i = 0; i < 100; i++) await Promise.resolve();
          harness.embedCalls[0]!.onStateChange!(healthy);
          expect(harness.body.querySelector(".triage-bar")?.hidden).toBeFalse();
          expect(harness.body.querySelector(".triage-bar")?.dataset.kind).toBe("launch-failed");
          expect(harness.body.querySelector(".triage-copy")?.textContent).toContain("Home");
          expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Sessions");
          expect(harness.disposals.count).toBe(0);
          if (failure === 404 || failure === 409) {
            expect(reads).toBe(priorReads + 1);
            listGate.resolve();
            for (let i = 0; i < 100; i++) await Promise.resolve();
            expect(harness.body.querySelector(".triage-bar")?.dataset.kind === "launch-failed" && !harness.body.querySelector(".triage-bar")?.hidden).toBeFalse();
            if (advance === "hold") expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Hold → next");
          }
          if (failure === 503 || failure === "withdrawn") {
            harness.body.querySelector(".triage-action")!.dispatchEvent(new Event("click"));
            expect(harness.elements.statusBanner.textContent).toContain(failure === "withdrawn" ? "Control is no longer available" : "The session could not be opened");
          }
          expect(harness.launchRequests).toHaveLength(2);
        } finally { listGate.resolve(); launchGate.resolve(); harness.window.dispatchEvent(new Event("pagehide")); }
      });
    }
  }

  test("successor4: local in-shell Control withdrawal remains target-owned", async () => {
    const home = session("local-control-upgrade");
    const gate = Promise.withResolvers<void>();
    const harness = await bootApp({
      permission: "denied", initialSessions: [home], suffix: "local-control-upgrade",
      launchResponse: async (_path, init) => {
        const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
        if (body.mode === "control") await gate.promise;
        return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
      },
    });
    try {
      harness.elements.sessionList.querySelector(".working-row")!.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.embedCalls.length === 1, 100);
      harness.body.querySelector(".shell-control")!.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.launchRequests.length === 2, 100);
      harness.setList(2, [{ ...home, canControl: false }]);
      harness.window.dispatchEvent(new Event("online"));
      for (let i = 0; i < 100; i++) await Promise.resolve();
      gate.resolve();
      for (let i = 0; i < 100; i++) await Promise.resolve();
      const health = { state: "healthy" as const, rttMs: 1, lastSuccessAt: Date.now(), failureSince: null, retryAt: null };
      harness.embedCalls[0]!.onStateChange!({ phase: "live", endedReason: null, requestPending: false, responsePending: false,
        loading: null, gatewayHealth: health, relayHealth: health });
      expect(harness.embedCalls).toHaveLength(1);
      expect(harness.body.querySelector(".triage-bar")?.hidden).toBeFalse();
      expect(harness.body.querySelector(".triage-copy")?.textContent).toContain("Control is no longer available");
      expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Sessions");
    } finally { gate.resolve(); harness.window.dispatchEvent(new Event("pagehide")); }
  });

  for (const failure of [404, 409]) {
    for (const dismiss of [false, true]) {
      test(`successor4: expired Hold target ${failure} releases feedback${dismiss ? " during refresh dismissal" : " on observation"}`, async () => {
        const home = session(`expiry-home-${failure}-${dismiss}`, { inputRequired: true });
        const remote = session(`expiry-remote-${failure}-${dismiss}`, { inputRequired: true });
        const gate = Promise.withResolvers<void>();
        let hold = false;
        let reads = 0;
        const harness = await bootApp({
          permission: "denied", initialSessions: [home], clientConfig: config, suffix: `expiry-dismiss-${failure}-${dismiss}`,
          remoteResponse: async () => {
            reads += 1;
            if (hold) await gate.promise;
            return Response.json({ revision: 1, sessions: [remote] });
          },
          launchResponse: async (path, init) => {
            if (path.startsWith("https://remote.example")) return new Response(null, { status: failure });
            const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
            return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
          },
        });
        try {
          await settleUntil(() => harness.elements.directoryCount.textContent === "2 waiting", 100);
          const hero = harness.elements.sessionList.querySelector(".queue-hero")!;
          const open = hero.dataset.sourceKey === "local\0https://sessions.example" ? hero.querySelector(".action-request")
            : harness.elements.sessionList.querySelectorAll(".queue-row").find(row => row.dataset.sourceKey === "local\0https://sessions.example");
          open!.dispatchEvent(new Event("click"));
          await settleUntil(() => harness.embedCalls.length === 1, 100);
          const health = { state: "healthy" as const, rttMs: 1, lastSuccessAt: Date.now(), failureSince: null, retryAt: null };
          harness.embedCalls[0]!.onStateChange!({ phase: "live", endedReason: null, requestPending: true, responsePending: false,
            loading: null, gatewayHealth: health, relayHealth: health });
          hold = true;
          const priorReads = reads;
          harness.body.querySelector(".triage-action")!.dispatchEvent(new Event("click"));
          await settleUntil(() => reads === priorReads + 1, 100);
          expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Sessions");
          if (dismiss) {
            harness.body.querySelector(".gateway-shell")!.dispatchEvent(new Event("pointerdown"));
            expect(harness.body.querySelector(".triage-bar")?.hidden).toBeFalse();
            expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Hold → next");
          }
          gate.resolve();
          for (let i = 0; i < 100; i++) await Promise.resolve();
          expect(harness.elements.fleetStatus.hidden).toBeTrue();
          expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Hold → next");
          expect(harness.launchRequests).toHaveLength(2);
        } finally { gate.resolve(); harness.window.dispatchEvent(new Event("pagehide")); }
      });
    }
  }

  for (const remote of [false, true]) {
    for (const canControl of [false, true]) {
      test(`successor4: ${remote ? "remote" : "local"} View mounts current Control=${canControl}`, async () => {
        const original = session(`current-view-${remote}-${canControl}`, { canControl: !canControl });
        const payload = { revision: 1, sessions: remote ? [original] : [] };
        const gate = Promise.withResolvers<void>();
        const harness = await bootApp({
          permission: "denied", initialSessions: remote ? [] : [original], clientConfig: config, remotePayload: payload,
          suffix: `current-view-${remote}-${canControl}`, launchGate: gate.promise,
        });
        try {
          await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").length === 1, 100);
          harness.elements.sessionList.querySelector(".working-row")!.dispatchEvent(new Event("click"));
          await settleUntil(() => harness.launchRequests.length === 1, 100);
          const current = { ...original, canControl, title: "Current authoritative title" };
          if (remote) { payload.revision += 1; payload.sessions = [current]; }
          else harness.setList(2, [current]);
          harness.window.dispatchEvent(new Event("online"));
          for (let i = 0; i < 100; i++) await Promise.resolve();
          gate.resolve();
          await settleUntil(() => harness.embedCalls.length === 1, 100);
          expect(harness.body.querySelector(".shell-control")?.hidden).toBe(!canControl);
          expect(harness.body.querySelector(".shell-title")?.textContent).toBe(current.title);
        } finally { gate.resolve(); harness.window.dispatchEvent(new Event("pagehide")); }
      });
    }
  }

  test("successor4: distinct empty observations in one minute do not claim a shared instant", async () => {
    const previousNow = Date.now;
    let now = Date.parse("2026-10-25T01:30:05Z");
    Date.now = () => now;
    const gate = Promise.withResolvers<void>();
    let harness: BrowserHarness | undefined;
    try {
      harness = await bootApp({
        permission: "denied", initialSessions: [], clientConfig: config, suffix: "distinct-empty-instants",
        remoteResponse: async () => { await gate.promise; return Response.json({ revision: 1, sessions: [] }); },
      });
      harness.disconnectEvents();
      now += 35_000;
      gate.resolve();
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(harness.elements.emptyState.textContent).toContain("No sessions in the last received lists");
      expect(harness.elements.emptyState.textContent).not.toContain("No sessions as of");
    } finally { gate.resolve(); harness?.window.dispatchEvent(new Event("pagehide")); Date.now = previousNow; }
  });

  for (const advance of ["next", "hold"] as const) {
    for (const status of [403, 503]) {
      test(`council477: ${advance} target ${status} owns triage through predecessor updates`, async () => {
        const home = session(`owner-home-${advance}-${status}`, { inputRequired: true });
        const remote = session(`owner-away-${advance}-${status}`, { inputRequired: true });
        const harness = await bootApp({
          permission: "denied", initialSessions: [home], remoteSessions: [remote],
          clientConfig: config, suffix: `owner-${advance}-${status}`,
          launchResponse: async (path, init) => {
            if (path.startsWith("https://remote.example")) return new Response(null, { status });
            const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
            return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
          },
        });
        await settleUntil(() => harness.elements.directoryCount.textContent === "2 waiting", 100);
        const hero = harness.elements.sessionList.querySelector(".queue-hero")!;
        const open = hero.dataset.sourceKey === "local\0https://sessions.example" ? hero.querySelector(".action-request")
          : harness.elements.sessionList.querySelectorAll(".queue-row").find(row => row.dataset.sourceKey === "local\0https://sessions.example");
        open!.dispatchEvent(new Event("click"));
        await settleUntil(() => harness.embedCalls.length === 1, 100);
        const health = { state: "healthy" as const, rttMs: 1, lastSuccessAt: Date.now(), failureSince: null, retryAt: null };
        const healthy = { phase: "live" as const, endedReason: null, requestPending: advance === "hold",
          responsePending: false, loading: null, gatewayHealth: health, relayHealth: health };
        harness.embedCalls[0]!.onStateChange!(healthy);
        const current = advance === "next" ? session(home.instanceId) : home;
        harness.setList(2, [current]);
        harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: current });
        expect(harness.body.querySelector(".triage-action")?.textContent).toBe(advance === "next" ? "Next ask →" : "Hold → next");
        harness.body.querySelector(".triage-action")!.dispatchEvent(new Event("click"));
        await settleUntil(() => harness.body.querySelector(".triage-copy")?.textContent?.includes("Remote") === true, 100);
        const notice = harness.body.querySelector(".triage-copy")!.textContent;
        harness.embedCalls[0]!.onStateChange!(healthy);
        harness.emit("session_upsert", { type: "session_upsert", revision: 3, session: current });
        expect(harness.body.querySelector(".triage-bar")?.hidden).toBeFalse();
        expect(harness.body.querySelector(".triage-bar")?.dataset.kind).toBe("launch-failed");
        expect(harness.body.querySelector(".triage-bar")?.dataset.failureKind).toBe(status === 403 ? "unauthorized" : "offline");
        expect(harness.body.querySelector(".triage-copy")?.textContent).toBe(notice);
        expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Sessions");
        if (status === 403) {
          harness.window.dispatchEvent(new Event("online"));
          for (let i = 0; i < 100; i++) await Promise.resolve();
        } else {
          // An explicit tap outside the notice dismisses it, without disposing the predecessor.
          harness.body.querySelector(".gateway-shell")!.dispatchEvent(new Event("pointerdown"));
          harness.embedCalls[0]!.onStateChange!(healthy);
        }
        const triage = harness.body.querySelector(".triage-bar")!;
        expect(triage.hidden || triage.dataset.kind !== "launch-failed").toBeTrue();
        if (advance === "hold") expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Hold → next");
        expect(harness.disposals.count).toBe(0);
        harness.window.dispatchEvent(new Event("pagehide"));
      });
    }
  }

  for (const remote of [false, true]) {
    for (const mode of ["view", "control"] as const) {
      for (const resumed of [false, true]) {
        test(`council477: ${remote ? "remote" : "local"} ${mode} withdrawal rejects a ${resumed ? "resumed" : "pending"} launch`, async () => {
          const gate = Promise.withResolvers<void>();
          const original = session(`mode-${remote}-${mode}-${resumed}`, { inputRequired: mode === "control" });
          const payload = { revision: 1, sessions: [original] };
          let launches = 0;
          const harness = await bootApp({
            permission: "denied", initialSessions: remote ? [] : [original], clientConfig: config,
            remotePayload: remote ? payload : { revision: 1, sessions: [] }, suffix: `mode-withdrawal-${remote}-${mode}-${resumed}`,
            launchResponse: async (_path, init) => {
              if (++launches === (resumed ? 2 : 1)) await gate.promise;
              const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
              return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
            },
          });
          const selector = mode === "control" ? ".action-request" : ".working-row";
          await settleUntil(() => harness.elements.sessionList.querySelector(selector) !== null, 100);
          harness.elements.sessionList.querySelector(selector)!.dispatchEvent(new Event("click"));
          if (resumed) {
            await settleUntil(() => harness.embedCalls.length === 1, 100);
            harness.window.dispatchEvent(new Event("pagehide"));
            const show = new Event("pageshow");
            Object.defineProperty(show, "persisted", { value: true });
            harness.window.dispatchEvent(show);
          }
          await settleUntil(() => launches === (resumed ? 2 : 1), 100);
          const withdrawn = { ...original, [mode === "control" ? "canControl" : "canView"]: false };
          if (remote) { payload.revision += 1; payload.sessions = [withdrawn]; }
          else harness.setList(2, [withdrawn]);
          harness.window.dispatchEvent(new Event("online"));
          for (let i = 0; i < 100; i++) await Promise.resolve();
          gate.resolve();
          for (let i = 0; i < 100; i++) await Promise.resolve();
          expect(harness.embedCalls).toHaveLength(resumed ? 1 : 0);
          expect(harness.body.querySelector(".gateway-shell")).toBeNull();
          expect((remote ? harness.elements.fleetStatus : harness.elements.statusBanner).textContent)
            .toContain(`${mode === "control" ? "Control" : "View"} is no longer available for this session.`);
          harness.window.dispatchEvent(new Event("pagehide"));
        });
      }
    }
  }

  test("council477: a failed foreground launch permanently supersedes delayed bfcache resume", async () => {
    const old = session("resume-old");
    const newer = session("resume-newer");
    const gate = Promise.withResolvers<void>();
    let holdRemote = false;
    const harness = await bootApp({
      permission: "denied", initialSessions: [old, newer], clientConfig: config, suffix: "resume-failed-newer-intent",
      remoteResponse: async () => {
        if (holdRemote) await gate.promise;
        return Response.json({ revision: 1, sessions: [] });
      },
      launchResponse: async (path, init) => {
        if (path.includes(newer.instanceId)) return new Response(null, { status: 503 });
        const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
        return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
      },
    });
    harness.elements.sessionList.querySelectorAll(".working-row").find(row => row.dataset.instanceId === old.instanceId)!.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.embedCalls.length === 1, 100);
    harness.window.dispatchEvent(new Event("pagehide"));
    holdRemote = true;
    const show = new Event("pageshow");
    Object.defineProperty(show, "persisted", { value: true });
    harness.window.dispatchEvent(show);
    await settleUntil(() => harness.elements.sessionList.querySelectorAll(".working-row").some(row => row.dataset.instanceId === newer.instanceId && !row.disabled), 100);
    harness.elements.sessionList.querySelectorAll(".working-row").find(row => row.dataset.instanceId === newer.instanceId)!.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.elements.statusBanner.textContent?.includes("The session could not be opened") === true, 100);
    gate.resolve();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(harness.launchRequests).toHaveLength(2);
    expect(harness.embedCalls).toHaveLength(1);
    expect(harness.body.querySelector(".gateway-shell")).toBeNull();
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  test("successor3: a pending request preview resumes after persisted pagehide", async () => {
    const gate = Promise.withResolvers<void>();
    const harness = await bootApp({
      permission: "denied", initialSessions: [session("pending-resume", { inputRequired: true })],
      launchGate: gate.promise, suffix: "pending-preview-resume",
    });
    harness.elements.sessionList.querySelector(".action-request")!.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.launchRequests.length === 1, 100);
    harness.window.dispatchEvent(new Event("pagehide"));
    expect(harness.launchRequests[0]!.init.signal!.aborted).toBeTrue();
    const show = new Event("pageshow");
    Object.defineProperty(show, "persisted", { value: true });
    harness.window.dispatchEvent(show);
    gate.resolve();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(harness.launchRequests).toHaveLength(2);
    expect(harness.embedCalls).toHaveLength(1);
    expect(harness.elements.trayHost.dataset.panel).toBe("request");
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  test("successor3: remote resume awaits its own freshness after prior local withdrawal", async () => {
    const remote = session("remote-resume-withdrawn");
    const gate = Promise.withResolvers<void>();
    let hold = false;
    const harness = await bootApp({
      permission: "denied", initialSessions: [], clientConfig: config, suffix: "remote-resume-prior-denial",
      remoteResponse: async () => {
        if (hold) await gate.promise;
        return Response.json({ revision: 1, sessions: [remote] });
      },
    });
    await settleUntil(() => harness.elements.sessionList.querySelector(".working-row") !== null, 100);
    harness.elements.sessionList.querySelector(".working-row")!.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.embedCalls.length === 1, 100);
    harness.setList(2, [], 403);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "unauthorized", 100);
    hold = true;
    harness.window.dispatchEvent(new Event("pagehide"));
    const show = new Event("pageshow");
    Object.defineProperty(show, "persisted", { value: true });
    harness.window.dispatchEvent(show);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(harness.embedCalls).toHaveLength(1);
    gate.resolve();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(harness.embedCalls).toHaveLength(2);
    expect(harness.body.querySelector(".shell-host")?.textContent).toBe("Remote");
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  for (const localStatus of [403, 503]) {
    for (const outcome of ["answered", "ended"] as const) {
      test(`successor3: remote ${outcome} triage ignores unrelated local ${localStatus}`, async () => {
        const remote = session(`remote-${outcome}-${localStatus}`, { inputRequired: true });
        const payload = { revision: 1, sessions: [remote] };
        const harness = await bootApp({
          permission: "denied", initialSessions: [], initialListStatus: localStatus,
          clientConfig: config, remotePayload: payload, suffix: `remote-triage-${localStatus}-${outcome}`,
        });
        await settleUntil(() => harness.elements.sessionList.querySelector(".action-request") !== null, 100);
        harness.elements.sessionList.querySelector(".action-request")!.dispatchEvent(new Event("click"));
        await settleUntil(() => harness.embedCalls.length === 1, 100);
        const health = { state: "healthy" as const, rttMs: 1, lastSuccessAt: Date.now(), failureSince: null, retryAt: null };
        harness.embedCalls[0]!.onStateChange!({
          phase: "live", endedReason: null, requestPending: true, responsePending: false, loading: null,
          gatewayHealth: health, relayHealth: health,
        });
        expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Hold → next");
        payload.revision += 1;
        payload.sessions = outcome === "ended" ? [] : [session(remote.instanceId)];
        harness.window.dispatchEvent(new Event("online"));
        await settleUntil(() => harness.body.querySelector(".triage-copy")?.textContent?.includes(outcome === "ended" ? "Session ended" : "Answered") === true, 100);
        expect(harness.embedCalls).toHaveLength(1);
        harness.window.dispatchEvent(new Event("pagehide"));
      });
    }
  }

  for (const failure of [404, 409, 503, "network"] as const) {
    test(`successor3: remote Next ask ${failure} retains target ownership and list-only recovery`, async () => {
      const home = session(`next-home-${failure}`, { inputRequired: true });
      const remote = session(`next-remote-${failure}`, { inputRequired: true });
      const expiryRefresh = Promise.withResolvers<void>();
      let remoteReads = 0;
      const harness = await bootApp({
        permission: "denied", initialSessions: [home], remoteSessions: [remote],
        clientConfig: config, suffix: `next-remote-failure-${failure}`,
        remoteResponse: async () => {
          if (++remoteReads > 1 && (failure === 404 || failure === 409)) await expiryRefresh.promise;
          return Response.json({ revision: 1, sessions: [remote] });
        },
        launchResponse: async (path, init) => {
          if (path.startsWith("https://remote.example")) {
            if (failure === "network") throw new TypeError("connection lost");
            return new Response(null, { status: failure });
          }
          const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
          return Response.json({ mode: body.mode, generation: body.generation, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
        },
      });
      await settleUntil(() => harness.elements.directoryCount.textContent === "2 waiting", 100);
      const hero = harness.elements.sessionList.querySelector(".queue-hero")!;
      const open = hero.dataset.sourceKey === "local\0https://sessions.example" ? hero.querySelector(".action-request")
        : harness.elements.sessionList.querySelectorAll(".queue-row").find(row => row.dataset.sourceKey === "local\0https://sessions.example");
      open!.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.embedCalls.length === 1, 100);
      const answered = session(home.instanceId);
      harness.setList(2, [answered]);
      harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: answered });
      expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Next ask →");
      const reads = harness.fetchPaths.filter(path => path === "https://remote.example/api/v1/sessions").length;
      harness.body.querySelector(".triage-action")!.dispatchEvent(new Event("click"));
      for (let i = 0; i < 100; i++) await Promise.resolve();
      const health = { state: "healthy" as const, rttMs: 1, lastSuccessAt: Date.now(), failureSince: null, retryAt: null };
      harness.embedCalls[0]!.onStateChange!({
        phase: "live", endedReason: null, requestPending: false, responsePending: false, loading: null,
        gatewayHealth: health, relayHealth: health,
      });
      expect(harness.body.querySelector(".triage-copy")?.textContent).toContain("Remote:");
      expect(harness.body.querySelector(".triage-action")?.textContent).toBe("Sessions");
      if (failure === 404 || failure === 409) {
        expect(harness.fetchPaths.filter(path => path === "https://remote.example/api/v1/sessions").length).toBeGreaterThan(reads);
      }
      harness.body.querySelector(".triage-action")!.dispatchEvent(new Event("click"));
      expect(harness.elements.fleetStatus.textContent).toContain("Remote:");
      const launches = harness.launchRequests.length;
      if (failure === 404 || failure === 409) {
        expiryRefresh.resolve();
        for (let i = 0; i < 100; i++) await Promise.resolve();
        expect(harness.elements.fleetStatus.hidden).toBeTrue();
      } else {
        const refresh = harness.elements.fleetStatus.querySelector(".status-action")!;
        expect(refresh.textContent).toBe("Refresh host");
        const refreshReads = harness.fetchPaths.length;
        refresh.dispatchEvent(new Event("click"));
        for (let i = 0; i < 100; i++) await Promise.resolve();
        expect(harness.fetchPaths.slice(refreshReads)).toEqual(["https://remote.example/api/v1/sessions"]);
      }
      expect(harness.launchRequests).toHaveLength(launches);
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  for (const failure of [409, 503, "discard"] as const) {
    test(`successor3: local preview ${failure} consumes its snapshot before withdrawal or scope change`, async () => {
      const gate = Promise.withResolvers<void>();
      const local = session(`preview-${failure}`, { inputRequired: true });
      const harness = await bootApp({
        permission: "denied", initialSessions: [local], clientConfig: config,
        remoteSessions: [session("preview-away")], suffix: `preview-settlement-${failure}`,
        launchResponse: async (path, init) => {
          if (path.startsWith("https://remote.example")) {
            return Response.json({ ...JSON.parse(String(init.body)), capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
          }
          await gate.promise;
          return failure === "discard" ? Response.json({ ...JSON.parse(String(init.body)), capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") })
            : new Response(null, { status: failure });
        },
      });
      harness.elements.sessionList.querySelector(".action-request")!.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.launchRequests.length === 1, 100);
      if (failure === 409) harness.setList(2, [], 403);
      if (failure === "discard") {
        harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: session(local.instanceId) });
      }
      gate.resolve();
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(harness.elements.trayHost.open).toBeFalse();
      if (failure === 409) expect(harness.elements.statusBanner.dataset.kind).toBe("unauthorized");
      harness.elements.hostPicker.value = "remote\0https://remote.example";
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      harness.elements.sessionList.querySelector(".working-row")!.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.embedCalls.length === 1, 100);
      harness.window.dispatchEvent(new Event("popstate"));
      expect(harness.elements.hostPicker.value).toBe("remote\0https://remote.example");
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  test("successor3: a fresh empty remote renders after local authorization withdrawal", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [], initialListStatus: 403,
      clientConfig: config, remoteSessions: [], suffix: "remote-empty-local-denied",
    });
    await settleUntil(() => harness.pendingDelays().includes(10_000), 100);
    harness.elements.hostPicker.value = "remote\0https://remote.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    expect(harness.elements.emptyState.hidden).toBeFalse();
    expect(harness.elements.emptyState.textContent).toContain("No sessions on this host");
    expect(harness.elements.emptyState.querySelector(".status-action")?.textContent).toBe("All hosts");
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  test("successor3: quiet revalidation retains an empty observation clock", async () => {
    const previousNow = Date.now;
    Date.now = () => new Date("2026-10-25T01:30:00Z").getTime();
    try {
      const harness = await bootApp({ permission: "denied", initialSessions: [], suffix: "empty-revalidation-clock" });
      const retained = `No sessions as of ${sourceAvailability("fresh", Date.now()).time}`;
      harness.hangNextListRequest();
      harness.setVisibility("hidden");
      harness.freeze();
      harness.setVisibility("visible");
      expect(harness.elements.emptyState.textContent).toContain(retained);
      expect(harness.elements.emptyState.textContent).toContain("Checking for updates");
      harness.window.dispatchEvent(new Event("pagehide"));
    } finally { Date.now = previousNow; }
  });

  test("council476: a remote request mount preserves the local first-snapshot fault and retry", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [], initialListStatus: 503, clientConfig: config,
      remoteSessions: [session("remote-while-local-down", { inputRequired: true })], suffix: "remote-mount-local-retry",
    });
    await settleUntil(() => harness.elements.sessionList.querySelector(".action-request") !== null, 100);
    harness.elements.sessionList.querySelector(".action-request")!.dispatchEvent(new Event("click"));
    await settleUntil(() => harness.embedCalls.length === 1, 100);
    expect(harness.elements.statusBanner.dataset.kind).toBe("desktop");
    const retry = harness.pendingDelays().find(delay => delay <= 4_000);
    expect(retry).toBeDefined();
    harness.setList(2, []);
    harness.window.runTimersWithDelay(retry!);
    await settleUntil(() => FakeEventSource.instances.length === 1, 100);
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    expect(harness.embedCalls).toHaveLength(1);
    expect(harness.elements.trayHost.dataset.panel).toBe("request");
    harness.window.dispatchEvent(new Event("pagehide"));
  });

  for (const failure of [404, 409, 503, "network"] as const) {
    test(`council476: remote launch ${failure} never replaces the local fault`, async () => {
      const harness = await bootApp({
        permission: "denied", initialSessions: [], initialListStatus: 503, clientConfig: config,
        remoteSessions: [session("remote-action-failure")], suffix: `remote-action-${failure}`,
        launchResponse: async () => {
          if (failure === "network") throw new TypeError("synthetic remote failure");
          return new Response(null, { status: failure });
        },
      });
      await settleUntil(() => harness.elements.sessionList.querySelector(".working-row") !== null, 100);
      harness.elements.sessionList.querySelector(".working-row")!.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.launchRequests.length === 1, 100);
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(harness.elements.statusBanner.dataset.kind).toBe("desktop");
      if (failure === 404 || failure === 409) expect(harness.elements.fleetStatus.hidden).toBeTrue();
      else expect(harness.elements.fleetStatus.textContent).toContain("Remote:");
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  for (const multiple of [false, true]) {
    test(`council476: All hosts names withdrawn observations (${multiple ? "fleet" : "single"})`, async () => {
      const harness = await bootApp({
        permission: "denied", initialSessions: [session("all-withdrawn")],
        ...(multiple ? { clientConfig: config } : {}), suffix: `all-withdrawn-${multiple}`,
      });
      harness.setList(2, [], 403);
      harness.window.dispatchEvent(new Event("online"));
      await settleUntil(() => harness.elements.statusBanner.dataset.kind === "unauthorized", 100);
      harness.setOnline(false);
      harness.window.dispatchEvent(new Event("offline"));
      expect(harness.elements.emptyState.textContent).toContain("Session list withdrawn");
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  test.each([0, 1])("council476: All hosts names an expired list instead of an unobserved empty directory (clock step %i ms)", async clockStep => {
    const previousNow = Date.now;
    const initialNow = Date.parse("2026-10-25T01:30:00Z");
    let reads = 0;
    Date.now = () => initialNow + clockOffset + reads++ * clockStep;
    let harness: BrowserHarness | undefined;
    try {
      harness = await bootApp({
        permission: "denied", initialSessions: [], clientConfig: config,
        remoteSessions: [session("all-expired")], suffix: `all-expired-${clockStep}`,
      });
      const page = harness;
      await settleUntil(() => page.elements.directoryCount.textContent === "Live · 1", 100);
      page.setRemoteStatus(503);
      page.window.dispatchEvent(new Event("online"));
      // Stale observation and timer arming can cross a millisecond: run the remaining grace.
      const graceDelay = 35_000 - clockStep;
      await settleUntil(() => page.pendingDelays().includes(graceDelay), 100);
      page.advanceClock(35_001);
      page.window.runTimersWithDelay(graceDelay);
      expect(page.elements.emptyState.textContent).toContain("Session lists expired");
    } finally {
      harness?.window.dispatchEvent(new Event("pagehide"));
      Date.now = previousNow;
    }
  });

  for (const exit of ["denied", "scope-cancel"] as const) {
    test(`council476: ${exit} request tray restores the directory snapshot before another scope opens`, async () => {
      const gate = Promise.withResolvers<void>();
      const harness = await bootApp({
        permission: "denied", initialSessions: [session("snapshot-home")], clientConfig: config,
        remoteSessions: [session("snapshot-remote", { inputRequired: true })], suffix: `snapshot-restore-${exit}`,
        launchResponse: async (path, init) => {
          if (path.startsWith("https://remote.example")) {
            if (exit === "scope-cancel") await gate.promise;
            return new Response(null, { status: 403 });
          }
          const body = JSON.parse(String(init.body)) as { mode: string; generation: number };
          return Response.json({ ...body, capability: ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__") });
        },
      });
      await settleUntil(() => harness.elements.directoryCount.textContent === "1 waiting", 100);
      harness.elements.hostPicker.value = "remote\0https://remote.example";
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      harness.elements.sessionList.querySelector(".action-request")!.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.launchRequests.length === 1, 100);
      if (exit === "denied") await settleUntil(() => harness.elements.fleetStatus.textContent?.includes("Access withdrawn") === true, 100);
      harness.elements.hostPicker.value = "local\0https://sessions.example";
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      gate.resolve();
      harness.elements.sessionList.querySelector(".working-row")!.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.embedCalls.length === 1, 100);
      harness.body.querySelector(".shell-back")!.dispatchEvent(new Event("click"));
      // The fake history has no browser traversal; deliver the resulting restoration event.
      harness.window.dispatchEvent(new Event("popstate"));
      await settleUntil(() => harness.body.querySelector(".gateway-shell") === null, 100);
      expect(harness.elements.hostPicker.value).toBe("local\0https://sessions.example");
      harness.window.dispatchEvent(new Event("pagehide"));
    });
  }

  for (const localFailure of [false, true]) {
    test(`counterexample: remote launch denial owns only its row (${localFailure ? "local fault retained" : "healthy local"})`, async () => {
      const harness = await bootApp({
        permission: "denied", initialSessions: [session("denied-launch-home")],
        remoteSessions: [session("denied-launch-away")], clientConfig: config,
        suffix: `remote-denial-owner-${localFailure}`,
        launchResponse: async () => new Response(null, { status: 403 }),
      });
      await settleUntil(() => harness.elements.directoryCount.textContent === "Live · 2", 100);
      if (localFailure) harness.disconnectEvents();
      harness.elements.hostPicker.value = "remote\0https://remote.example";
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.elements.fleetStatus.children[0]?.dataset.state === "forbidden", 100);
      expect(harness.elements.statusBanner.dataset.kind).toBe(localFailure ? "gateway" : "ready");
      expect(harness.elements.statusBanner.hidden).toBe(!localFailure);
      expect(harness.elements.fleetStatus.children).toHaveLength(1);
      expect(harness.elements.fleetStatus.querySelector("button")).toBeNull();
      harness.elements.hostPicker.value = "all";
      harness.elements.hostPicker.dispatchEvent(new Event("change"));
      expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(1);
      harness.setVisibility("hidden");
    });
  }

  test("counterexample: authorization withdrawal cannot certify an empty local observation after offline", async () => {
    const home = session("withdrawn-observation");
    const harness = await bootApp({
      permission: "denied", initialSessions: [home], clientConfig: config, remoteSessions: [], suffix: "withdrawn-then-offline",
    });
    harness.elements.hostPicker.value = "local\0https://sessions.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    harness.setList(2, [], 403);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.statusBanner.dataset.kind === "unauthorized", 100);
    harness.setOnline(false);
    harness.window.dispatchEvent(new Event("offline"));
    expect(harness.elements.emptyState.textContent).toContain("Session list withdrawn");
    expect(harness.elements.emptyState.textContent).not.toContain("No sessions as of");
    expect(harness.elements.statusBanner.textContent).toContain("The previous session list was withdrawn.");
    expect(harness.elements.statusBanner.textContent).not.toContain("List as of");
    harness.setOnline(true);
    harness.setList(3, []);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.emptyState.textContent?.includes("No sessions on this host") === true, 100);
    expect(harness.elements.emptyState.textContent).not.toContain("withdrawn");
    harness.setVisibility("hidden");
  });

  test("404 is silent local-only; invalid configuration has one banner owner and no fleet row", async () => {
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
      expect(harness.elements.statusBanner.dataset.kind).toBe("configuration");
      expect(harness.elements.statusBanner.children).toHaveLength(1);
      expect(harness.elements.statusBanner.textContent).toContain("Fleet configuration unavailable");
      expect(harness.elements.fleetStatus.children).toHaveLength(0);
      harness.failNextListRequest();
      harness.elements.statusBanner.querySelector("button")?.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.elements.statusBanner.dataset.kind === "tailnet", 100);
      expect(harness.elements.statusBanner.children).toHaveLength(1);
      expect(harness.elements.fleetStatus.children).toHaveLength(0);
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
    openHeroOptions(failed)?.dispatchEvent(new Event("click"));
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
      const owner = source === "local" ? harness.elements.statusBanner : harness.elements.fleetStatus;
      await settleUntil(() => owner.textContent?.includes("The gateway returned an invalid launch response.") === true, 100);
      if (source === "remote") expect(harness.elements.statusBanner.hidden).toBeTrue();
      expect(harness.embedCalls).toHaveLength(0);
      expect(harness.elements.sessionList.querySelector(".working-row")?.disabled).toBeFalse();
      expect(harness.pendingDelaysSince(mark)).not.toContain(10_000);
      oversized = false;
      mark = harness.timerMark();
      harness.elements.sessionList.querySelector(".working-row")?.dispatchEvent(new Event("click"));
      await settleUntil(() => harness.embedCalls.length === 1, 100);
      if (source === "remote") expect(harness.elements.fleetStatus.hidden).toBeTrue();
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
      await settleUntil(() => harness.elements.fleetStatus.textContent?.includes("Gateway unavailable.") === true, 100);
      expect(harness.launchRequests[0]?.init.signal?.aborted).toBeTrue();
      expect(harness.elements.statusBanner.hidden).toBeTrue();
      expect(harness.elements.fleetStatus.textContent).toContain("Remote: Gateway unavailable. Check your tailnet connection and try again.");
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
      phase: "live", endedReason: null, requestPending: true, responsePending: false, loading: null,
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
    openHeroOptions(harness)?.dispatchEvent(new Event("click"));
    await Promise.resolve();
    expect(notification.closed).toBeFalse();
    harness.elements.hostPicker.value = "local\0https://sessions.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    expect(harness.elements.sessionList.querySelector(".queue-hero")).not.toBeNull();
    openHeroOptions(harness)?.dispatchEvent(new Event("click"));
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
    harness.elements.undoButton.dispatchEvent(new Event("click"));
    expect(harness.elements.sessionList.querySelectorAll(".working-row")).toHaveLength(2);
    harness.setVisibility("hidden");
  });

  test("one interruption has one banner owner while quiet refresh has no failure row or Retry", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [session("freshness-home-0001")],
      remoteSessions: [session("freshness-away-0001")], clientConfig: config, suffix: "freshness-ownership",
    });
    await settleUntil(() => harness.elements.directoryCount.textContent === "Live · 2", 100);
    harness.setVisibility("hidden");
    expect(harness.elements.fleetStatus.children).toHaveLength(0);
    harness.setVisibility("visible");
    expect(harness.elements.fleetStatus.children).toHaveLength(0);
    harness.disconnectEvents();
    expect(harness.elements.statusBanner.children).toHaveLength(1);
    expect(harness.elements.fleetStatus.children).toHaveLength(0);
    expect(harness.elements.directoryCount.textContent).toBe("Listed · 2");
    expect(harness.elements.directoryCount.className).toContain("count-pill-listed");
    expect(harness.elements.sessionList.querySelector(".working-row-frame")?.dataset.fresh).toBe("false");
    expect(harness.elements.sessionList.querySelector(".session-tile")?.dataset.state).toBe("unknown");
    const coverage = harness.elements.sessionList.querySelector(".all-clear-copy")?.textContent ?? "";
    expect(coverage).not.toContain("Home");
    expect(coverage).not.toContain("Remote");
    harness.setVisibility("hidden");
  });

  test("failed sources share byte-identical list-as-of timestamps with the banner and cached rows", async () => {
    const originalNow = Date.now;
    Date.now = () => Date.parse("2026-10-25T01:30:00Z");
    try {
      const harness = await bootApp({
        permission: "denied", initialSessions: [session("clock-home-0001")],
        remoteSessions: [session("clock-away-0001")], clientConfig: config, suffix: "freshness-clocks",
      });
      await settleUntil(() => harness.elements.directoryCount.textContent === "Live · 2", 100);
      harness.setRemoteStatus(503);
      harness.window.dispatchEvent(new Event("online"));
      await settleUntil(() => harness.elements.fleetStatus.children[0]?.dataset.state === "stale", 100);
      await settleUntil(() => FakeEventSource.instances.length === 2, 100);
      harness.disconnectEvents();
      const clock = /List as of ([^.]+)\./u.exec(harness.elements.statusBanner.textContent ?? "")?.[1];
      expect(clock).toBeDefined();
      expect(harness.elements.statusBanner.children).toHaveLength(1);
      expect(harness.elements.fleetStatus.children).toHaveLength(1);
      expect(harness.elements.fleetStatus.textContent).toContain(`List as of ${clock}.`);
      expect(harness.elements.sessionList.querySelectorAll(".session-freshness").every(node => node.textContent === `List as of ${clock}.`)).toBeTrue();
      harness.setVisibility("hidden");
    } finally { Date.now = originalNow; }
  });

  test("empty and filtered incomplete coverage stay truthful; forbidden sources offer no Retry", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [], clientConfig: config,
      remotePayload: { malformed: true }, suffix: "empty-incomplete",
    });
    await settleUntil(() => harness.elements.fleetStatus.children[0]?.dataset.state === "unavailable", 100);
    expect(harness.elements.emptyState.hidden).toBeFalse();
    expect(harness.elements.emptyState.textContent).toContain("No sessions to show yet");
    expect(harness.elements.sessionList.getAttribute("aria-label")).toBe("Listed OMP sessions");
    harness.elements.hostPicker.value = "remote\0https://remote.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    expect(harness.elements.emptyState.hidden).toBeFalse();
    expect(harness.elements.emptyState.textContent).toContain("This host has not been checked");
    expect(harness.elements.emptyState.querySelector("button")?.textContent).toBe("All hosts");
    harness.setRemoteStatus(403);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.fleetStatus.children[0]?.dataset.state === "forbidden", 100);
    expect(harness.elements.fleetStatus.querySelector("button")).toBeNull();
    harness.setVisibility("hidden");
  });

  test("offline recovery without an online event resumes remote polling and keeps the retained clock", async () => {
    const home = session("offline-fleet-home");
    const harness = await bootApp({
      permission: "denied", initialSessions: [home], remoteSessions: [session("offline-fleet-away")],
      clientConfig: config, suffix: "offline-fleet-recovery",
    });
    await settleUntil(() => harness.elements.directoryCount.textContent === "Live · 2", 100);
    harness.setRemoteStatus(503);
    harness.setList(2, [home], 503);
    harness.setOnline(false);
    harness.window.dispatchEvent(new Event("offline"));
    await settleUntil(() => harness.pendingDelays().includes(35_000), 100);
    const facts = harness.elements.sessionList.querySelectorAll(".session-freshness");
    expect(facts).toHaveLength(2);
    expect(facts.every(fact => fact.textContent?.startsWith("List as of "))).toBeTrue();
    expect(harness.elements.statusBanner.children).toHaveLength(1);
    expect(harness.elements.fleetStatus.children).toHaveLength(0);
    harness.setOnline(true); // Deliberately do not dispatch `online`.
    harness.setRemoteStatus(200);
    harness.setList(3, [home]);
    harness.runTimers();
    await settleUntil(() => harness.elements.directoryCount.textContent === "Live · 2", 100);
    const requests = harness.fetchPaths.filter(path => path === "https://remote.example/api/v1/sessions").length;
    harness.window.runTimersWithDelay(10_000);
    await settleUntil(() => harness.fetchPaths.filter(path => path === "https://remote.example/api/v1/sessions").length > requests, 100);
    expect(harness.elements.statusBanner.hidden).toBeTrue();
    harness.setVisibility("hidden");
  });

  test("a retained empty observation says when it was empty, not never checked", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [], remoteSessions: [], clientConfig: config, suffix: "retained-empty",
    });
    harness.setRemoteStatus(503);
    harness.window.dispatchEvent(new Event("online"));
    await settleUntil(() => harness.elements.fleetStatus.children[0]?.dataset.state === "stale", 100);
    harness.elements.hostPicker.value = "remote\0https://remote.example";
    harness.elements.hostPicker.dispatchEvent(new Event("change"));
    const time = /List as of ([^.]+)\./u.exec(harness.elements.fleetStatus.textContent ?? "")?.[1];
    expect(time).toBeDefined();
    expect(harness.elements.emptyState.textContent).toContain(`No sessions as of ${time}`);
    expect(harness.elements.emptyState.textContent).not.toContain("has not been checked");
    expect(harness.elements.sessionList.getAttribute("aria-label")).toBe("Listed OMP sessions");
    harness.setVisibility("hidden");
  });

  test("held and answered feedback treats quiet revalidation as checking, not a failed host", async () => {
    for (const action of ["held-directory", "hold", "answered"] as const) {
      const waiting = session(`checking-${action}`, { inputRequired: true });
      const harness = await bootApp({
        permission: "denied", initialSessions: [waiting], remoteSessions: [], clientConfig: config,
        suffix: `checking-feedback-${action}`,
      });
      if (action === "held-directory") {
        openHeroOptions(harness)?.dispatchEvent(new Event("click"));
        harness.setVisibility("hidden");
        expect(harness.elements.sessionList.querySelector(".all-held-summary")?.textContent).toContain("checking other hosts");
        expect(harness.elements.sessionList.textContent).not.toContain("unavailable");
      } else {
        harness.elements.sessionList.querySelector(".action-request")?.dispatchEvent(new Event("click"));
        await settleUntil(() => harness.embedCalls.length === 1, 100);
        const health = { state: "healthy" as const, rttMs: 1, lastSuccessAt: Date.now(), failureSince: null, retryAt: null };
        harness.embedCalls[0]?.onStateChange?.({
          phase: "live", endedReason: null, requestPending: true, responsePending: false, loading: null,
          gatewayHealth: health, relayHealth: health,
        });
        harness.setVisibility("hidden");
        if (action === "hold") harness.body.querySelector(".triage-action")?.dispatchEvent(new Event("click"));
        else harness.emit("session_upsert", { type: "session_upsert", revision: 2, session: session(waiting.instanceId) });
        await settleUntil(() => harness.body.querySelector(".triage-copy")?.textContent?.includes("checking other hosts") === true, 100);
        expect(harness.body.querySelector(".triage-copy")?.textContent).not.toContain("unavailable");
      }
      harness.window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("malformed remote data cannot assert fleet all-clear or erase home rows", async () => {
    const harness = await bootApp({
      permission: "denied", initialSessions: [session("fleet-home-0001")],
      clientConfig: config, remotePayload: { malformed: true }, suffix: "fleet-incomplete",
    });
    await settleUntil(() => harness.elements.fleetStatus.children[0]?.dataset.state === "unavailable", 100);
    expect(harness.elements.sessionList.querySelector(".all-clear-title")?.textContent).toBe("Host coverage incomplete");
    expect(harness.elements.sessionList.querySelector(".all-clear-copy")?.textContent).toBe("1 of 2 hosts up to date. Other sessions may be missing.");
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
        phase: "live", endedReason: null, requestPending: true, responsePending: false, loading: null,
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
