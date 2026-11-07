import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { parseNotificationData } from "@omp-session-gateway/protocol";
import vectors from "../../../packages/protocol/test/vectors/fleet-ordering.json" with { type: "json" };

const GLOBAL_NAMES = [
  "addEventListener",
  "caches",
  "clients",
  "fetch",
  "location",
  "navigator",
  "registration",
  "__SHELL_ASSETS__",
  "__LAZY_ASSETS__",
  "__CACHE_NAME__",
  "skipWaiting",
  "indexedDB",
] as const;
const nativeGlobals = Object.fromEntries(
  GLOBAL_NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
) as Record<(typeof GLOBAL_NAMES)[number], PropertyDescriptor | undefined>;

const listeners = new Map<string, Array<(event: unknown) => void>>();
const cacheAdds: string[][] = [];
const cacheDeletes: string[] = [];
const cachePuts: string[] = [];
const fetched: string[] = [];
const cachedResponses = new Map<string, Response>();
const cache = {
  async addAll(paths: readonly string[]): Promise<void> {
    cacheAdds.push([...paths]);
  },
  async match(request: { url: string }): Promise<Response | undefined> {
    return cachedResponses.get(request.url)?.clone();
  },
  async put(request: { url: string }, response: Response): Promise<void> {
    cachePuts.push(request.url);
    cachedResponses.set(request.url, response.clone());
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
  readonly tag: string;
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
      tag: options.tag ?? "",
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
  async getNotifications(options: { readonly tag?: string } = {}): Promise<typeof shownNotifications> {
    const observed = notificationRead;
    notificationRead = undefined;
    if (observed !== undefined) queueMicrotask(observed);
    return shownNotifications.filter(notification => (options.tag === undefined || notification.options.tag === options.tag) && !notification.closed);
  },
};
const badgeState = {
  set: [] as (number | undefined)[],
  clears: 0,
  current: undefined as [number, boolean] | undefined,
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
      async setAppBadge(value?: number): Promise<void> {
        badgeState.set.push(value);
        badgeState.current = [value ?? 0, value !== undefined];
      },
      async clearAppBadge(): Promise<void> {
        badgeState.clears += 1;
        badgeState.current = [0, true];
      },
    },
  },
  location: { configurable: true, value: { origin: "https://sessions.example" } },
  __SHELL_ASSETS__: { configurable: true, value: ["/assets/app.0123456789ab.js"] },
  __LAZY_ASSETS__: { configurable: true, value: ["/assets/nerd-symbols-md-01.0123456789ab.woff2"] },
  __CACHE_NAME__: { configurable: true, value: "omp-sessions-shell-current" },
});

type VectorStep = Record<string, unknown>;
const vectorBindings = vectors.defaults as Record<string, string>;
const vectorBinding = (token: unknown): string | undefined =>
  token === undefined ? undefined : vectorBindings[token as string] ?? token as string;

async function workerMessage(data: unknown): Promise<unknown> {
  let completion: Promise<unknown> | undefined;
  let response: unknown;
  listener("message")({
    data,
    ports: [{ postMessage(value: unknown): void { response = value; } }],
    waitUntil(promise: Promise<unknown>): void { completion = promise; },
  });
  await completion;
  return response;
}

async function settledPush(message: unknown): Promise<void> {
  const delivery = push(message);
  for (let turn = 0; turn < 60; turn++) await Promise.resolve();
  jest.runAllTimers();
  await delivery;
}

describe("fleet vectors through the actual worker listeners and durable store", () => {
  for (const scenario of vectors.scenarios) {
    test(scenario.name, async () => {
      shownNotifications.length = 0;
      badgeState.current = undefined;
      let alerts = 0;
      let captured = 0;
      if ("fleet" in scenario && scenario.fleet) {
        expect(await workerMessage({ type: "omp-notification-mode", version: 3, fleet: true }))
          .toEqual({ type: "omp-notification-mode-set", version: 3 });
      }
      for (const step of scenario.steps as VectorStep[]) {
        const before = shownNotifications.length;
        const live = new Set(shownNotifications.filter(notification => !notification.closed).map(notification => notification.tag));
        if ("advance" in step) jest.advanceTimersByTime(step.advance as number);
        else if ("restart" in step) {
          const persisted = structuredClone(database.values.get("worker"));
          await restartWorker();
          expect(database.values.get("worker")).toEqual(persisted);
        } else if ("capture" in step) {
          const response = await workerMessage({ type: "omp-notification-support-request", version: 3 }) as { received: number };
          captured = response.received;
        } else if ("push" in step) {
          const message = step.push as VectorStep;
          const [epoch, n] = message.seq as [number, number];
          const [count, complete] = message.badge as [number, boolean];
          const source = vectorBinding(message.source);
          await settledPush({
            version: 3, type: message.type, instanceId: message.instanceId, generation: 1,
            ...(source === undefined ? {} : { source }), seq: { epoch, n }, badge: { count, complete },
            ...(message.type === "clear" ? {} : { title: message.type === "attention" ? "OMP session needs attention" : "OMP session activity stopped" }),
            ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
          });
        } else if ("legacy" in step) {
          const message = step.legacy as VectorStep;
          await settledPush({ version: 2, ...message, ...(message.type === "clear" ? {} : {
            generation: 1, title: message.type === "attention" ? "OMP session needs attention" : "OMP session activity stopped",
          }) });
        } else {
          const snapshot = step.reconcile as VectorStep;
          const [count, complete] = snapshot.badge as [number, boolean];
          const delivery = workerMessage({
            type: "omp-notification-reconcile", version: 3, asOf: { received: captured },
            fresh: (snapshot.fresh as string[]).map(token => token === "local" ? token : vectorBinding(token)),
            pending: snapshot.pending, retained: snapshot.retained ?? [], badge: { count, complete },
          });
          for (let turn = 0; turn < 60; turn++) await Promise.resolve();
          jest.runAllTimers();
          await delivery;
        }
        for (const notification of shownNotifications.slice(before)) {
          if (!live.has(notification.tag) || (notification.options as NotificationOptions & { renotify: boolean }).renotify) alerts++;
        }
      }
      const displayed = shownNotifications.filter(notification => !notification.closed).map(notification => {
        const intent = parseNotificationData(notification.data)!;
        return `${notification.tag}|${intent.kind}|${intent.kind === "attention" ? intent.requestId : intent.generation}`;
      }).sort();
      expect(displayed).toEqual([...scenario.expect.displayed].sort());
      // A positive platform badge exposes only the count; completeness matters at zero (flag/clear).
      const appliedBadge = badgeState.current as [number, boolean] | undefined;
      expect(appliedBadge?.[0]).toBe(scenario.expect.badge[0] as number);
      if (scenario.expect.badge[0] === 0) expect(appliedBadge?.[1]).toBe(scenario.expect.badge[1] as boolean);
      expect(alerts).toBe(scenario.expect.alerts);
      const stored = JSON.stringify([...database.values]);
      for (const field of ["title", "body", "endpoint", "capability", "verifier", "secret"]) expect(stored).not.toContain(`\"${field}\"`);
    });
  }

  test("upgrading persisted ordering state preserves clears without a fresh-snapshot request map", async () => {
    const ask = { source: vectorBindings.studio, instanceId: "aaaa1111bbbb2222", generation: 1, requestId: "req_upgrade_0000a" };
    await settledPush({ ...ask, version: 3, type: "clear", seq: { epoch: 1, n: 1 }, badge: { count: 0, complete: true } });
    const { observed: _observed, ...oldState } = database.values.get("worker") as Record<string, unknown>;
    database.values.set("worker", oldState);
    await restartWorker();
    expect(await workerMessage({ type: "omp-notification-support-request", version: 3 }))
      .toEqual({ type: "omp-notification-support-response", version: 3, received: 1 });
    await workerMessage({
      type: "omp-notification-reconcile", version: 3, asOf: { received: 1 },
      fresh: ["local"], pending: [], retained: [ask], badge: { count: 1, complete: false },
    });
    expect(badgeState.current).toEqual([0, false]);
    expect(database.values.get("worker")).toMatchObject({ ...oldState, observed: {} });
  });

  test("v3 support captures the serialized receipt count and rejects malformed handshakes", async () => {
    await settledPush({
      version: 2, type: "clear", instanceId: "receipt-count-session", requestId: "receipt_request_0001", pendingAskCount: 0,
    });
    expect(await workerMessage({ type: "omp-notification-support-request", version: 3 }))
      .toEqual({ type: "omp-notification-support-response", version: 3, received: 1 });
    expect(await workerMessage({ type: "omp-notification-support-request", version: 3, extra: true })).toBeUndefined();
  });

  test("a blocked IndexedDB falls back to the same in-memory reducer without losing in-worker tombstones", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open(): never { throw new Error("synthetic storage denied"); } } });
    await restartWorker();
    shownNotifications.length = 0;
    const message = { version: 2, instanceId: "fallback-session-001", requestId: "fallback_request_0001", pendingAskCount: 0 };
    await settledPush({ ...message, type: "clear" });
    await settledPush({ ...message, type: "attention", generation: 1, title: "OMP session needs attention" });
    expect(shownNotifications).toHaveLength(0);
  });

  for (const failure of ["open", "commit"] as const) {
    test(`focused remediation: an IndexedDB ${failure} failure refuses durable fleet mode and retains local Push v2 badges`, async () => {
      if (failure === "open") {
        Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
          open(): never { throw new Error("synthetic storage denied"); },
        } });
        await restartWorker();
      } else database.failCommit = true;
      expect(await workerMessage({ type: "omp-notification-mode", version: 3, fleet: true }))
        .toEqual({ type: "omp-notification-mode-failed", version: 3 });
      expect(database.values.get("worker")).toBeUndefined();
      await settledPush({ version: 2, type: "clear", instanceId: "mode-failure-local", requestId: "mode_failure_request_0001", pendingAskCount: 4 });
      expect(badgeState.current).toEqual([4, true]);
    });
  }

  test("focused remediation: fleet-mode acknowledgment waits for the IndexedDB transaction commit", async () => {
    const gate = Promise.withResolvers<void>();
    database.commitGate = gate.promise;
    let response: unknown;
    const setting = workerMessage({ type: "omp-notification-mode", version: 3, fleet: true }).then(value => { response = value; });
    for (let turn = 0; turn < 60; turn++) await Promise.resolve();
    expect(response).toBeUndefined();
    expect(database.values.get("worker")).toBeUndefined();
    gate.resolve();
    await setting;
    expect(response).toEqual({ type: "omp-notification-mode-set", version: 3 });
    expect(database.values.get("worker")).toMatchObject({ fleet: true });
  });

  test("focused remediation: an acknowledged legacy reset restores local Push v2 badge counts", async () => {
    expect(await workerMessage({ type: "omp-notification-mode", version: 3, fleet: true }))
      .toEqual({ type: "omp-notification-mode-set", version: 3 });
    await settledPush({ version: 2, type: "clear", instanceId: "reset-local-badge", requestId: "reset_local_request_0001", pendingAskCount: 2 });
    badgeState.set.length = 0;
    expect(await workerMessage({ type: "omp-notification-mode", version: 3, fleet: false }))
      .toEqual({ type: "omp-notification-mode-set", version: 3 });
    await settledPush({ version: 2, type: "clear", instanceId: "reset-local-badge", requestId: "reset_local_request_0001", pendingAskCount: 3 });
    expect(badgeState.set).toEqual([3]);
    await restartWorker();
    await settledPush({ version: 2, type: "clear", instanceId: "reset-local-badge", requestId: "reset_local_request_0001", pendingAskCount: 5 });
    expect(badgeState.set).toEqual([3, 5]);
  });

  test("zero incomplete coverage shows the platform flag; only zero complete clears it", async () => {
    badgeState.set.length = 0;
    badgeState.clears = 0;
    const message = { version: 3, type: "clear", instanceId: "fleet-badge-session", generation: 1, requestId: "fleet_badge_request_0001" };
    await settledPush({ ...message, seq: { epoch: 1, n: 1 }, badge: { count: 0, complete: false } });
    expect(badgeState.set).toEqual([undefined]);
    expect(badgeState.clears).toBe(0);
    await settledPush({ ...message, seq: { epoch: 1, n: 2 }, badge: { count: 0, complete: true } });
    expect(badgeState.clears).toBe(1);
    await settledPush({ ...message, seq: { epoch: 1, n: 1 }, badge: { count: 8, complete: true } });
    expect(badgeState.set).toEqual([undefined]);
  });
});

// Transactions commit structured clones, so a new worker instance cannot reuse the previous heap.
function workerDatabase(): { readonly factory: IDBFactory; readonly values: Map<string, unknown>; failCommit: boolean; commitGate: Promise<void> | undefined } {
  const values = new Map<string, unknown>();
  const controls = { failCommit: false, commitGate: undefined as Promise<void> | undefined };
  let created = false;
  const database = {
    close(): void {},
    createObjectStore(): void { created = true; },
    transaction(): unknown {
      const transaction = {
        oncomplete: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined,
        objectStore: () => ({
          get(key: string): unknown {
            const request = { result: structuredClone(values.get(key)) };
            queueMicrotask(() => transaction.oncomplete?.());
            return request;
          },
          put(value: unknown, key: string): void {
            void Promise.resolve(controls.commitGate).then(() => {
              if (controls.failCommit) { transaction.onabort?.(); return; }
              values.set(key, structuredClone(value));
              transaction.oncomplete?.();
            });
          },
        }),
      };
      return transaction;
    },
  };
  const factory = {
    open(): unknown {
      const request = { result: database, onupgradeneeded: undefined as (() => void) | undefined, onsuccess: undefined as (() => void) | undefined };
      queueMicrotask(() => {
        if (!created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, values, get failCommit() { return controls.failCommit; }, set failCommit(value) { controls.failCommit = value; },
    get commitGate() { return controls.commitGate; }, set commitGate(value) { controls.commitGate = value; } };
}

let workerInstance = 0;
let database = workerDatabase();
async function restartWorker(): Promise<void> {
  listeners.clear();
  await import(`../src/service-worker.ts?service-worker-contract-${++workerInstance}`);
}

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

beforeEach(async () => {
  jest.useFakeTimers({ now: 0 });
  database = workerDatabase();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: database.factory });
  await restartWorker();
});
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
    await clearing;
    expect(current.closed).toBeTrue();
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
    await clearing;
    expect(current.closed).toBeTrue();
  });

  test("a duplicate attention never re-shows content, even if its presentation changes", async () => {
    shownNotifications.length = 0;
    const message = { ...attention, instanceId: "push-content-timing-0001" };
    await registration.showNotification("Older attention title", {
      tag: `omp-attention-${message.instanceId}`, body: message.body,
      data: { version: 2, type: "attention", instanceId: message.instanceId, requestId: message.requestId },
    });
    const first = shownNotifications.at(-1)!;
    await push(message);
    const second = shownNotifications.at(-1)!;
    expect(first.closed).toBeFalse();
    expect(second).toBe(first);
    await push({ ...message, body: "Updated session detail" });
    expect(second.closed).toBeFalse();
    expect(shownNotifications.filter(notification => !notification.closed).map(({ title, body }) => ({ title, body })))
      .toEqual([{ title: "Older attention title", body: message.body }]);
  });

  test("an identical replay does not re-alert a dismissed request", async () => {
    shownNotifications.length = 0;
    const message = { ...attention, instanceId: "push-dismissed-timing-0001" };
    await push(message);
    const dismissed = shownNotifications.at(-1)!;
    dismissed.close();
    await push(message);
    expect(shownNotifications.at(-1)).toBe(dismissed);
    expect(shownNotifications.filter(notification => !notification.closed).map(notification => notification.data))
      .toEqual([]);
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
    await clearing;
    expect(persisted.closed).toBeTrue();
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

  test("hands exact v3 remote metadata to an open page and keeps the binding in a cold stop route", async () => {
    const posted: unknown[] = [];
    const source = vectors.defaults.studio;
    const data = { ...attentionData, version: 3, source };
    clientState.opened.length = 0;
    clientState.windows = [{
      url: "https://sessions.example/",
      async focus(): Promise<unknown> { return this; },
      postMessage(message: unknown, transfer: readonly MessagePort[]): void {
        posted.push(message);
        transfer[0]?.postMessage({ type: "omp-notification-route-accepted", version: 3 });
      },
    }];
    await tap(data);
    expect(posted).toEqual([{ type: "omp-notification-route", version: 3, data }]);
    expect(clientState.opened).toEqual([]);
    clientState.windows = [];
    await tap({ version: 3, type: "activity_stop", source, instanceId: data.instanceId, generation: 3 });
    expect(clientState.opened).toEqual([`/collab/${data.instanceId}?activity=stopped&generation=3&source=${source}`]);
  });

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
      requestId: "push-request-activity-0002", pendingAskCount: 1,
    };
    await push(attention);
    expect(displayedStop.closed).toBeTrue();
    expect(shownNotifications.at(-1)!.options).toMatchObject({ renotify: true });
    const displayedAttention = shownNotifications.at(-1)!;
    await push({ ...stop, pendingAskCount: 1 });
    expect(shownNotifications.filter(notification => !notification.closed)).toEqual([displayedAttention]);
    expect(badgeState.set.at(-1)).toBe(1);
    jest.advanceTimersByTime(2_000);
    await push({ ...clear, requestId: attention.requestId });
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
      push({ ...attentionFields, type: "attention", title: "OMP session needs attention", requestId: "push-request-overlap-0003", pendingAskCount: 1 }),
    ]);
    expect(shownNotifications.filter(notification => !notification.closed).map(notification => notification.data))
      .toEqual([{ version: 2, type: "attention", instanceId: stop.instanceId, requestId: "push-request-overlap-0003" }]);
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

  test("precaches only the shell, activates without navigating any client, and keeps fetch exclusions", async () => {
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

  test("caches lazy fonts on first use without precaching or intercepting unlisted fonts", async () => {
    cacheAdds.length = 0;
    cachePuts.length = 0;
    fetched.length = 0;
    cachedResponses.clear();
    let installCompletion: Promise<void> | undefined;
    listener("install")({ waitUntil(promise: Promise<void>): void { installCompletion = promise; } });
    await installCompletion;
    expect(cacheAdds).toEqual([["/assets/app.0123456789ab.js"]]);
    expect(fetched).toEqual([]);
    expect(cachedResponses.size).toBe(0);

    const request = {
      method: "GET",
      mode: "same-origin",
      url: "https://sessions.example/assets/nerd-symbols-md-01.0123456789ab.woff2",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Promise<Response> | undefined;
      listener("fetch")({ request, respondWith(promise: Promise<Response>): void { response = promise; } });
      expect(await (await response)?.text()).toBe("asset");
      expect(fetched).toEqual([request.url]);
      expect(cachePuts).toEqual([request.url]);
    }

    let responded = false;
    listener("fetch")({
      request: { ...request, url: "https://sessions.example/assets/other.woff2" },
      respondWith(): void { responded = true; },
    });
    expect(responded).toBeFalse();
    expect(fetched).toEqual([request.url]);
    expect(cachePuts).toEqual([request.url]);
  });
});
