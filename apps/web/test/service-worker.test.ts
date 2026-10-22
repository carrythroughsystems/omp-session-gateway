import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

const GLOBAL_NAMES = [
  "addEventListener",
  "caches",
  "clients",
  "fetch",
  "location",
  "navigator",
  "registration",
  "__SHELL_ASSETS__",
  "__CACHE_NAME__",
  "skipWaiting",
] as const;
const nativeGlobals = Object.fromEntries(
  GLOBAL_NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
) as Record<(typeof GLOBAL_NAMES)[number], PropertyDescriptor | undefined>;

const listeners = new Map<string, Array<(event: unknown) => void>>();
const cacheAdds: string[][] = [];
const cacheDeletes: string[] = [];
const cachePuts: string[] = [];
const fetched: string[] = [];
const cache = {
  async addAll(paths: readonly string[]): Promise<void> {
    cacheAdds.push([...paths]);
  },
  async match(): Promise<Response | undefined> {
    return undefined;
  },
  async put(request: { url: string }): Promise<void> {
    cachePuts.push(request.url);
  },
};
const caches = {
  async open(): Promise<typeof cache> {
    return cache;
  },
  async keys(): Promise<string[]> {
    return ["omp-sessions-shell-old", "omp-sessions-shell-current", "unrelated"];
  },
  async delete(name: string): Promise<boolean> {
    cacheDeletes.push(name);
    return true;
  },
};
interface FakeWindowClient {
  readonly url: string;
  focus(): Promise<unknown>;
  navigate?(path: string): Promise<FakeWindowClient | null>;
  postMessage?(message: unknown, transfer: readonly MessagePort[]): void;
}

const clientState = {
  windows: [] as FakeWindowClient[],
  matchOptions: [] as unknown[],
  opened: [] as string[],
  navigated: [] as string[],
  claims: 0,
};
const clients = {
  async claim(): Promise<void> {
    clientState.claims += 1;
  },
  async matchAll(options: unknown): Promise<typeof clientState.windows> {
    clientState.matchOptions.push(options);
    return clientState.windows;
  },
  async openWindow(path: string): Promise<null> {
    clientState.opened.push(path);
    return null;
  },
};
const shownNotifications: Array<{
  readonly title: string;
  readonly body: string;
  readonly options: NotificationOptions;
  readonly data: unknown;
  closed: boolean;
  close(): void;
}> = [];
let notificationRead: (() => void) | undefined;
const registration = {
  async showNotification(title: string, options: NotificationOptions): Promise<void> {
    for (const notification of shownNotifications) {
      if (notification.options.tag === options.tag) notification.close();
    }
    shownNotifications.push({
      title,
      body: options.body ?? "",
      options,
      data: options.data,
      closed: false,
      close(): void {
        // Chrome's persistent notification identity is shared by replacements with this tag.
        for (const notification of shownNotifications) {
          if (notification.options.tag === this.options.tag) notification.closed = true;
        }
      },
    });
  },
  async getNotifications(options: { readonly tag: string }): Promise<typeof shownNotifications> {
    const observed = notificationRead;
    notificationRead = undefined;
    if (observed !== undefined) queueMicrotask(observed);
    return shownNotifications.filter(notification => notification.options.tag === options.tag && !notification.closed);
  },
};
const badgeState = {
  set: [] as number[],
  clears: 0,
};


Object.defineProperties(globalThis, {
  addEventListener: {
    configurable: true,
    value(type: string, listener: (event: unknown) => void): void {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
  },
  caches: { configurable: true, value: caches },
  clients: { configurable: true, value: clients },
  registration: { configurable: true, value: registration },
  fetch: {
    configurable: true,
    async value(request: { url: string }): Promise<Response> {
      fetched.push(request.url);
      return new Response("asset", { status: 200 });
    },
  },
  skipWaiting: {
    configurable: true,
    async value(): Promise<void> {
      clientState.claims += 0;
      clientState.matchOptions.push("skipWaiting");
    },
  },
  navigator: {
    configurable: true,
    value: {
      async setAppBadge(value: number): Promise<void> {
        badgeState.set.push(value);
      },
      async clearAppBadge(): Promise<void> {
        badgeState.clears += 1;
      },
    },
  },
  location: { configurable: true, value: { origin: "https://sessions.example" } },
  __SHELL_ASSETS__: { configurable: true, value: ["/assets/app.0123456789ab.js"] },
  __CACHE_NAME__: { configurable: true, value: "omp-sessions-shell-current" },
});

// The worker installs global listeners at import time, so this cache-busted import is the test boundary.
const serviceWorkerTestModule = "../src/service-worker.ts?service-worker-contract";
await import(serviceWorkerTestModule);

function listener(type: string): (event: unknown) => void {
  const registered = listeners.get(type);
  if (registered?.length !== 1) throw new Error(`expected one ${type} listener`);
  return registered[0]!;
}

let pendingPush: Promise<unknown> = Promise.resolve();
function push(message: unknown): Promise<unknown> {
  let completion: Promise<unknown> | undefined;
  listener("push")({
    data: { json: () => message },
    waitUntil(promise: Promise<unknown>): void { completion = promise; },
  });
  pendingPush = Promise.resolve(completion);
  return pendingPush;
}

function nextNotificationRead(): Promise<void> {
  return new Promise(resolve => { notificationRead = resolve; });
}

beforeEach(() => { jest.useFakeTimers({ now: 0 }); });
afterEach(async () => {
  try {
    jest.runAllTimers();
    await pendingPush.catch(() => {});
  } finally {
    notificationRead = undefined;
    jest.useRealTimers();
  }
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    const descriptor = nativeGlobals[name];
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("notification service worker", () => {
  test("responds only to the exact versioned support handshake", () => {
    const responses: unknown[] = [];
    const message = listener("message");
    message({
      data: { type: "omp-notification-support-request", version: 2 },
      ports: [{ postMessage(value: unknown): void { responses.push(value); } }],
    });
    message({
      data: { type: "omp-notification-support-request", version: 2, content: "PROMPT_CANARY" },
      ports: [{ postMessage(value: unknown): void { responses.push(value); } }],
    });
    message({
      data: { type: "omp-notification-support-request", version: 1 },
      ports: [{ postMessage(value: unknown): void { responses.push(value); } }],
    });

    expect(responses).toEqual([{ type: "omp-notification-support-response", version: 2 }]);
    expect(JSON.stringify(responses)).not.toContain("PROMPT_CANARY");
  });

  test("shows selected detail, badges pending count, and clears only the exact request", async () => {
    shownNotifications.length = 0;
    badgeState.set.length = 0;
    badgeState.clears = 0;
    const receivePush = listener("push");
    const attention = {
      version: 2,
      type: "attention",
      instanceId: "push-instance-000001",
      generation: 3,
      requestId: "push-request-identity-0001",
      pendingAskCount: 2,
      title: "OMP session needs attention",
      body: "Session name · project",
    };
    let attentionCompletion: Promise<unknown> | undefined;
    receivePush({
      data: { json(): unknown { return attention; } },
      waitUntil(promise: Promise<unknown>): void { attentionCompletion = promise; },
    });
    await attentionCompletion;
    expect(shownNotifications).toHaveLength(1);
    expect(shownNotifications[0]).toMatchObject({
      title: "OMP session needs attention",
      closed: false,
      options: {
        tag: "omp-attention-push-instance-000001",
        body: "Session name · project",
        renotify: false,
        data: {
          version: 2,
          type: "attention",
          instanceId: "push-instance-000001",
          requestId: "push-request-identity-0001",
        },
      },
    });
    expect(badgeState.set).toEqual([2]);

    let malformedWait = false;
    receivePush({
      data: { json(): unknown { return { ...attention, prompt: "PROMPT_CONTENT_CANARY" }; } },
      waitUntil(): void { malformedWait = true; },
    });
    expect(malformedWait).toBeFalse();

    let staleClearCompletion: Promise<unknown> | undefined;
    receivePush({
      data: {
        json(): unknown {
          return {
            version: 2,
            type: "clear",
            instanceId: attention.instanceId,
            requestId: "different-request-000001",
            pendingAskCount: 1,
          };
        },
      },
      waitUntil(promise: Promise<unknown>): void { staleClearCompletion = promise; },
    });
    await staleClearCompletion;
    expect(shownNotifications[0]?.closed).toBeFalse();

    jest.advanceTimersByTime(2_000);
    let clearCompletion: Promise<unknown> | undefined;
    receivePush({
      data: {
        json(): unknown {
          return {
            version: 2,
            type: "clear",
            instanceId: attention.instanceId,
            requestId: attention.requestId,
            pendingAskCount: 0,
          };
        },
      },
      waitUntil(promise: Promise<unknown>): void { clearCompletion = promise; },
    });
    await clearCompletion;
    expect(shownNotifications[0]?.closed).toBeTrue();
    expect(badgeState.set).toEqual([2, 1]);
    expect(badgeState.clears).toBe(1);
  });

  const attention = {
    version: 2, type: "attention", instanceId: "push-timing-000001", generation: 3,
    requestId: "push-request-timing-0001", pendingAskCount: 1,
    title: "OMP session needs attention", body: "Session name · project",
  };
  const clearFor = (message: typeof attention) => ({
    version: 2, type: "clear", instanceId: message.instanceId,
    requestId: message.requestId, pendingAskCount: 0,
  });

  test("settles a clear 50 ms after display and closes only its exact request", async () => {
    shownNotifications.length = 0;
    await push(attention);
    const current = shownNotifications.at(-1)!;
    await push({ ...attention, instanceId: "push-other-timing-0001" });
    const other = shownNotifications.at(-1)!;
    jest.advanceTimersByTime(50);
    await push({ ...clearFor(attention), requestId: "push-different-request-0001" });
    expect(current.closed).toBeFalse();
    const read = nextNotificationRead();
    const clearing = push(clearFor(attention));
    await read;
    expect(current.closed).toBeFalse();
    jest.advanceTimersByTime(1_949);
    expect(current.closed).toBeFalse();
    jest.advanceTimersByTime(1);
    await clearing;
    expect(current.closed).toBeTrue();
    expect(other.closed).toBeFalse();
  });

  test("clears an old display immediately", async () => {
    shownNotifications.length = 0;
    const message = { ...attention, instanceId: "push-old-timing-000001" };
    await push(message);
    const current = shownNotifications.at(-1)!;
    jest.advanceTimersByTime(2_050);
    const read = nextNotificationRead();
    const clearing = push(clearFor(message));
    await read;
    expect(current.closed).toBeTrue();
    await clearing;
  });

  test("a replacement push queued during settle remains displayed after the old clear", async () => {
    shownNotifications.length = 0;
    const message = { ...attention, instanceId: "push-queued-timing-0001" };
    await push(message);
    jest.advanceTimersByTime(50);
    const read = nextNotificationRead();
    const clearing = push(clearFor(message));
    await read;
    const replacement = { ...message, requestId: "push-replacement-request-0001" };
    const replacing = push(replacement);
    jest.advanceTimersByTime(1_950);
    await Promise.all([clearing, replacing]);
    expect(shownNotifications.filter(notification => !notification.closed).map(notification => notification.data))
      .toEqual([{ version: 2, type: "attention", instanceId: message.instanceId, requestId: replacement.requestId }]);
  });

  test("re-queries after settle instead of closing a replacement made by another context", async () => {
    shownNotifications.length = 0;
    const message = { ...attention, instanceId: "push-context-timing-0001" };
    await push(message);
    jest.advanceTimersByTime(50);
    const read = nextNotificationRead();
    const clearing = push(clearFor(message));
    await read;
    const replacementData = {
      version: 2, type: "attention", instanceId: message.instanceId,
      requestId: "push-context-replacement-0001",
    };
    // The browser's persistent tag can change independently while this worker is suspended.
    await registration.showNotification(message.title, {
      tag: `omp-attention-${message.instanceId}`, body: message.body, data: replacementData,
    });
    const replacement = shownNotifications.at(-1)!;
    jest.advanceTimersByTime(1_950);
    await clearing;
    expect(replacement.closed).toBeFalse();
    expect(replacement.data).toEqual(replacementData);
  });

  test("identical attention replay updates the badge without re-showing or extending settle", async () => {
    shownNotifications.length = 0;
    badgeState.set.length = 0;
    const message = { ...attention, instanceId: "push-replay-timing-0001" };
    await push(message);
    const current = shownNotifications.at(-1)!;
    jest.advanceTimersByTime(1_000);
    await push({ ...message, pendingAskCount: 3 });
    expect(shownNotifications).toEqual([current]);
    expect(current.closed).toBeFalse();
    expect(badgeState.set).toEqual([1, 3]);
    jest.advanceTimersByTime(1_000);
    const read = nextNotificationRead();
    const clearing = push(clearFor(message));
    await read;
    expect(current.closed).toBeTrue();
    await clearing;
  });

  test("changed attention title or body replaces the displayed content", async () => {
    shownNotifications.length = 0;
    const message = { ...attention, instanceId: "push-content-timing-0001" };
    await registration.showNotification("Older attention title", {
      tag: `omp-attention-${message.instanceId}`, body: message.body,
      data: { version: 2, type: "attention", instanceId: message.instanceId, requestId: message.requestId },
    });
    const first = shownNotifications.at(-1)!;
    await push(message);
    const second = shownNotifications.at(-1)!;
    expect(first.closed).toBeTrue();
    expect(second.title).toBe(message.title);
    await push({ ...message, body: "Updated session detail" });
    expect(second.closed).toBeTrue();
    expect(shownNotifications.filter(notification => !notification.closed).map(({ title, body }) => ({ title, body })))
      .toEqual([{ title: message.title, body: "Updated session detail" }]);
  });

  test("an identical replay re-shows a dismissed notification", async () => {
    shownNotifications.length = 0;
    const message = { ...attention, instanceId: "push-dismissed-timing-0001" };
    await push(message);
    const dismissed = shownNotifications.at(-1)!;
    dismissed.close();
    await push(message);
    expect(shownNotifications.at(-1)).not.toBe(dismissed);
    expect(shownNotifications.filter(notification => !notification.closed).map(notification => notification.data))
      .toEqual([{ version: 2, type: "attention", instanceId: message.instanceId, requestId: message.requestId }]);
  });

  test("a worker with no local display timestamp clears a persisted notification immediately", async () => {
    shownNotifications.length = 0;
    const message = { ...attention, instanceId: "push-prior-worker-000001" };
    await registration.showNotification(message.title, {
      tag: `omp-attention-${message.instanceId}`, body: message.body,
      data: { version: 2, type: "attention", instanceId: message.instanceId, requestId: message.requestId },
    });
    const persisted = shownNotifications.at(-1)!;
    const read = nextNotificationRead();
    const clearing = push(clearFor(message));
    await read;
    expect(persisted.closed).toBeTrue();
    await clearing;
  });

  function tap(data?: unknown): Promise<void> {
    let completion: Promise<void> | undefined;
    let closed = 0;
    listener("notificationclick")({
      notification: { close(): void { closed += 1; }, ...(data === undefined ? {} : { data }) },
      waitUntil(promise: Promise<void>): void { completion = promise; },
    });
    expect(closed).toBe(1);
    return completion ?? Promise.reject(new Error("notificationclick did not extend its lifetime"));
  }

  async function flushMicrotasks(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  }

  const attentionData = {
    version: 2,
    type: "attention",
    instanceId: "push-instance-000001",
    requestId: "push-request-identity-0001",
  };
  const attentionRoute = "/collab/push-instance-000001?request=push-request-identity-0001";

  test("hands a tap to the open page, which Chromium reports by creation URL, and never navigates it", async () => {
    // A live `/client/` collaboration still reports the `/` it was created at (Chrome 154 WebAPK),
    // so the worker cannot tell it from an idle directory and must never navigate either.
    const posted: unknown[] = [];
    let focuses = 0;
    clientState.windows = [
      {
        url: "https://other.example/",
        async focus(): Promise<unknown> { throw new Error("cross-origin client must not be focused"); },
        postMessage(): void { throw new Error("cross-origin client must not be messaged"); },
      },
      {
        url: "https://sessions.example/",
        async focus(): Promise<unknown> { focuses += 1; return this; },
        async navigate(path: string): Promise<FakeWindowClient> { clientState.navigated.push(path); return this; },
        postMessage(message: unknown, transfer: readonly MessagePort[]): void {
          posted.push(message);
          transfer[0]?.postMessage({ type: "omp-notification-route-accepted", version: 2 });
        },
      },
      {
        url: "https://sessions.example/",
        async focus(): Promise<unknown> { throw new Error("only the most recently focused page is asked"); },
      },
    ];
    clientState.matchOptions.length = 0;
    clientState.opened.length = 0;
    clientState.navigated.length = 0;

    await tap(attentionData);

    expect(clientState.matchOptions).toEqual([{ type: "window", includeUncontrolled: true }]);
    expect(focuses).toBe(1);
    expect(posted).toEqual([{ type: "omp-notification-route", version: 2, data: attentionData }]);
    expect(clientState.navigated).toEqual([]);
    expect(clientState.opened).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test("opens the route when the open page does not accept it, and still never navigates", async () => {
    // A page still running a release without in-place routing never answers.
    for (const reply of [undefined, { type: "omp-notification-route-accepted", version: 1 }]) {
      clientState.windows = [{
        url: "https://sessions.example/",
        async focus(): Promise<unknown> { return this; },
        async navigate(path: string): Promise<FakeWindowClient> { clientState.navigated.push(path); return this; },
        postMessage(_message: unknown, transfer: readonly MessagePort[]): void {
          if (reply !== undefined) transfer[0]?.postMessage(reply);
        },
      }];
      clientState.opened.length = 0;
      clientState.navigated.length = 0;

      const completion = tap(attentionData);
      await flushMicrotasks();
      if (reply === undefined) {
        jest.advanceTimersByTime(2_999);
        await flushMicrotasks();
        expect(clientState.opened).toEqual([]);
        jest.advanceTimersByTime(1);
      }
      await completion;

      expect(clientState.opened).toEqual([attentionRoute]);
      expect(clientState.navigated).toEqual([]);
    }
  });

  test("opens the route when no page is open", async () => {
    clientState.windows = [];
    clientState.opened.length = 0;
    await tap(attentionData);
    expect(clientState.opened).toEqual([attentionRoute]);
  });

  test("a notification API failure does not block later push delivery", async () => {
    shownNotifications.length = 0;
    const stop = {
      version: 2, type: "activity_stop", instanceId: "push-activity-000002",
      generation: 3, pendingAskCount: 0, title: "OMP session activity stopped",
    };
    const showNotification = registration.showNotification;
    registration.showNotification = async () => { throw new Error("Notifications unavailable"); };
    try {
      await expect(push(stop)).rejects.toThrow();
    } finally {
      registration.showNotification = showNotification;
    }
    await push({ ...stop, generation: 4 });
    expect(shownNotifications.filter(notification => !notification.closed).map(notification => notification.data))
      .toEqual([{ version: 2, type: "activity_stop", instanceId: stop.instanceId, generation: 4 }]);
  });

  test("activity stops preserve displayed attention and exact-request clears cannot close a stop", async () => {
    shownNotifications.length = 0;
    badgeState.set.length = 0;
    badgeState.clears = 0;
    const stop = {
      version: 2,
      type: "activity_stop",
      instanceId: "push-activity-000001",
      generation: 3,
      pendingAskCount: 0,
      title: "OMP session activity stopped",
      body: "Session name · project",
    };
    await push(stop);
    expect(shownNotifications.filter(notification => !notification.closed)).toHaveLength(1);
    const displayedStop = shownNotifications[0]!;
    expect(displayedStop.options.data).toEqual({
      version: 2, type: "activity_stop", instanceId: stop.instanceId, generation: 3,
    });
    expect(badgeState.clears).toBe(1);
    const clear = {
      version: 2, type: "clear", instanceId: stop.instanceId,
      requestId: "push-request-activity-0001", pendingAskCount: 0,
    };
    await push(clear);
    expect(displayedStop.closed).toBeFalse();
    await push({ ...stop, requestId: clear.requestId });
    expect(shownNotifications).toHaveLength(1);
    const { type: _type, ...attentionFields } = stop;
    const attention = {
      ...attentionFields, type: "attention", title: "OMP session needs attention",
      requestId: clear.requestId, pendingAskCount: 1,
    };
    await push(attention);
    expect(displayedStop.closed).toBeTrue();
    expect(shownNotifications.at(-1)!.options).toMatchObject({ renotify: true });
    const displayedAttention = shownNotifications.at(-1)!;
    await push({ ...stop, pendingAskCount: 1 });
    expect(shownNotifications.filter(notification => !notification.closed)).toEqual([displayedAttention]);
    expect(badgeState.set.at(-1)).toBe(1);
    jest.advanceTimersByTime(2_000);
    await push(clear);
    expect(displayedAttention.closed).toBeTrue();
    await push(stop);
    expect(shownNotifications.filter(notification => !notification.closed).map(notification => notification.data))
      .toEqual([{ version: 2, type: "activity_stop", instanceId: stop.instanceId, generation: 3 }]);
    await registration.showNotification("Outdated attention", {
      tag: "omp-attention-push-activity-000001",
      data: { version: 1, type: "attention", instanceId: stop.instanceId, requestId: clear.requestId },
    });
    await push(stop);
    expect(shownNotifications.filter(notification => !notification.closed).map(notification => notification.data))
      .toEqual([{ version: 2, type: "activity_stop", instanceId: stop.instanceId, generation: 3 }]);
    // Push handlers overlap while getNotifications is pending. The later ask must win.
    shownNotifications.length = 0;
    await Promise.all([
      push(stop),
      push({ ...attentionFields, type: "attention", title: "OMP session needs attention", requestId: clear.requestId, pendingAskCount: 1 }),
    ]);
    expect(shownNotifications.filter(notification => !notification.closed).map(notification => notification.data))
      .toEqual([{ version: 2, type: "attention", instanceId: stop.instanceId, requestId: clear.requestId }]);
    expect(fetched).toEqual([]);
    expect(cachePuts).toEqual([]);
  });

  test("stop taps open only an exact generation-bound route, and malformed data opens the directory", async () => {
    clientState.windows = [];
    clientState.opened.length = 0;
    const valid = { version: 2, type: "activity_stop", instanceId: "push-activity-000001", generation: 3 };
    for (const data of [valid, { ...valid, requestId: "extra-request-00001" }, { ...valid, generation: 0 }]) {
      await tap(data);
    }
    expect(clientState.opened).toEqual([
      "/collab/push-activity-000001?activity=stopped&generation=3", "/", "/",
    ]);
    expect(fetched).toEqual([]);
  });

  test("a tap without valid data only brings the open page forward, or opens the directory", async () => {
    let focuses = 0;
    clientState.windows = [{
      url: "https://sessions.example/",
      async focus(): Promise<unknown> { focuses += 1; return this; },
      postMessage(): void { throw new Error("malformed data must not reach a page"); },
    }];
    clientState.opened.length = 0;
    await tap();
    expect(focuses).toBe(1);
    expect(clientState.opened).toEqual([]);

    clientState.windows = [{
      url: "https://sessions.example/",
      async focus(): Promise<unknown> { throw new Error("focus rejected"); },
    }];
    await tap({ version: 2, type: "attention", instanceId: "push-instance-000001" });
    expect(clientState.opened).toEqual(["/"]);
    expect(fetched).toEqual([]);
  });

  test("caches only the shell, activates without navigating any client, and keeps fetch exclusions", async () => {
    // Chromium reports each window's creation URL, not the route it later reached through the
    // history API. An idle directory, a pending launch, and a live `/client/` collaboration therefore
    // all look like `/` to the worker, and none of them may be navigated.
    clientState.windows = ["idle directory", "pending launch", "live collaboration"].map(() => ({
      url: "https://sessions.example/",
      async focus(): Promise<unknown> { return this; },
      async navigate(path: string): Promise<FakeWindowClient> {
        clientState.navigated.push(path);
        return this;
      },
    }));
    clientState.navigated.length = 0;
    clientState.claims = 0;
    clientState.matchOptions.length = 0;

    let installCompletion: Promise<void> | undefined;
    listener("install")({ waitUntil(promise: Promise<void>): void { installCompletion = promise; } });
    await installCompletion;
    expect(cacheAdds).toEqual([["/assets/app.0123456789ab.js"]]);
    expect(clientState.matchOptions).toContain("skipWaiting");

    let activateCompletion: Promise<unknown> | undefined;
    listener("activate")({ waitUntil(promise: Promise<unknown>): void { activateCompletion = promise; } });
    await activateCompletion;
    expect(cacheDeletes).toEqual(["omp-sessions-shell-old"]);
    expect(clientState.claims).toBe(1);
    expect(clientState.navigated).toEqual([]);

    const fetchListener = listener("fetch");
    const bypasses = [
      { method: "POST", mode: "same-origin", url: "https://sessions.example/assets/app.0123456789ab.js" },
      { method: "GET", mode: "navigate", url: "https://sessions.example/" },
      { method: "GET", mode: "same-origin", url: "https://sessions.example/api/v1/sessions" },
      { method: "GET", mode: "same-origin", url: "https://sessions.example/api/v1/client-config" },
      { method: "GET", mode: "cors", url: "https://remote.example/api/v1/sessions" },
      { method: "POST", mode: "cors", url: "https://remote.example/api/v1/sessions/collision-0001/launch" },
      { method: "GET", mode: "cors", url: "https://remote.example/assets/app.0123456789ab.js" },
      { method: "GET", mode: "same-origin", url: "https://sessions.example/client/" },
      { method: "GET", mode: "same-origin", url: "https://sessions.example/assets/app.0123456789ab.js?x=1" },
    ];
    for (const request of bypasses) {
      let responded = false;
      fetchListener({ request, respondWith(): void { responded = true; } });
      expect(responded).toBeFalse();
    }

    const shellRequest = {
      method: "GET",
      mode: "same-origin",
      url: "https://sessions.example/assets/app.0123456789ab.js",
    };
    let shellResponse: Promise<Response> | undefined;
    fetchListener({ request: shellRequest, respondWith(promise: Promise<Response>): void { shellResponse = promise; } });
    expect(await shellResponse).toBeInstanceOf(Response);
    expect(fetched).toEqual([shellRequest.url]);
    expect(cachePuts).toEqual([shellRequest.url]);
  });
});
