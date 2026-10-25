import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, startDashboardFixture } from "./fixture-server.ts";

interface NotificationTestState {
  permission: NotificationPermission;
  permissionRequests: number;
  subscribeCalls: number;
  subscriptionActive: boolean;
  unsubscribeCalls: number;
}

function session(instanceId: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
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
      requestId: `request-${instanceId}`,
      since: merged.lastSeenAt,
    },
  };
}

test("activity-stop routes launch View even with a current ask or without Control, without persistent capability sinks", { tag: "@core" }, async ({ page }) => {
  await installSilentWebSocket(page);
  const roomKey = new Uint8Array(32).fill(109);
  const capabilityCanary = Buffer.from(roomKey).toString("base64url");
  for (const canControl of [true, false]) {
    const current = session("stop-route-instance-0001", { generation: 4, canControl, inputRequired: true, busy: false });
    const fixture = await startDashboardFixture([current], { roomKey });
    try {
      await page.addInitScript(() => {
        const nativeFetch = window.fetch;
        const locations: string[] = [];
        Object.defineProperty(globalThis, "__notificationFetchLocations", { value: locations, configurable: true });
        window.fetch = new Proxy(nativeFetch, {
          apply(target, thisArgument, args): Promise<Response> {
            locations.push(location.pathname + location.search);
            return Reflect.apply(target, thisArgument, args);
          },
        });
      });
      await page.goto(fixture.origin + "/collab/stop-route-instance-0001?activity=stopped&generation=4");
      await expect(page.getByRole("application", { name: "OMP collaboration session" })).toBeVisible();
      await expect(page).toHaveURL(fixture.origin + "/client/");
      await expect(page.getByRole("textbox", { name: "Read-only session — watching only", exact: true })).toBeDisabled();
      expect(fixture.launchRequests).toEqual([{ instanceId: current.instanceId, generation: 4, mode: "view" }]);
      const residue = await page.evaluate(async canary => {
        const cacheUrls: string[] = [];
        const cacheContents: string[] = [];
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const request of await cache.keys()) {
            cacheUrls.push(request.url);
            cacheContents.push(await (await cache.match(request))!.text());
          }
        }
        const databaseNames = typeof indexedDB.databases === "function"
          ? (await indexedDB.databases()).map(database => database.name ?? "") : [];
        const sinks = [
          document.documentElement.outerHTML, location.href, JSON.stringify(history.state), document.cookie,
          JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }),
          JSON.stringify(databaseNames), ...cacheUrls, ...cacheContents,
        ];
        const locations = (globalThis as typeof globalThis & { __notificationFetchLocations: string[] }).__notificationFetchLocations;
        return {
          leaked: sinks.some(sink => sink.includes(canary)),
          cacheUrls,
          routesScrubbed: locations.every(path => !path.includes("/collab/") && !path.includes("generation=")),
          routePersisted: [location.href, JSON.stringify(history.state), JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })]
            .some(sink => sink.includes("stop-route-instance-0001") || sink.includes("request-stop-route-instance-0001")),
        };
      }, capabilityCanary);
      expect(residue.leaked).toBe(false);
      expect(residue.routesScrubbed).toBe(true);
      expect(residue.routePersisted).toBe(false);
      expect(residue.cacheUrls.every(url => !url.includes("/api/") && !url.includes("/client/") && !url.includes("/collab/"))).toBe(true);
      await page.goto("about:blank");
    } finally {
      await fixture.stop();
    }
  }
});

test("attention routes still acquire Control only for the exact current request", { tag: "@core" }, async ({ page }) => {
  await installSilentWebSocket(page);
  const current = session("attention-route-current-01", { inputRequired: true });
  const requestId = current.ask!.requestId;
  const fixture = await startDashboardFixture([current]);
  try {
    const route = fixture.origin + "/collab/attention-route-current-01?request=" + requestId;
    await page.goto(route);
    await expect(page.getByRole("application", { name: "OMP collaboration session" })).toBeVisible();
    expect(fixture.launchRequests).toEqual([{ instanceId: current.instanceId, generation: 1, mode: "control", requestId }]);
    await page.goto("about:blank");
    fixture.setSnapshot([{ ...current, ask: { ...current.ask!, requestId: "attention-route-new-request" } }]);
    await page.goto(route);
    await expect(page.locator('#status-banner[data-kind="expired"]')).toBeVisible();
    await expect(page).toHaveURL(fixture.origin + "/");
    expect(fixture.launchRequests).toHaveLength(1);
  } finally {
    await fixture.stop();
  }
});

test("changed, gone, and unavailable stop routes remain in the directory without acquiring capabilities", { tag: "@core" }, async ({ page }) => {
  const current = session("stop-expired-instance-01", { generation: 2 });
  const fixture = await startDashboardFixture([current]);
  try {
    for (const sessions of [[current], [], [{ ...current, generation: 1, canView: false, canControl: false }]]) {
      fixture.setSnapshot(sessions);
      await page.goto(fixture.origin + "/collab/stop-expired-instance-01?activity=stopped&generation=1");
      await expect(page.locator('#status-banner[data-kind="expired"]')).toBeVisible();
      await expect(page).toHaveURL(fixture.origin + "/");
      await expect(page.getByRole("application", { name: "OMP collaboration session" })).toHaveCount(0);
      expect(fixture.launchRequests).toEqual([]);
      expect(fixture.requests.some(request => request.includes("/launch"))).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  } finally {
    await fixture.stop();
  }
});

/**
 * Delivers a tapped notification to the open page from the worker, with the exact message the
 * worker's `notificationclick` handler sends. Headless Chromium grants workers no notification
 * permission, so the tap handler itself is covered by the worker unit tests and the Pixel check.
 */
async function tapNotification(context: BrowserContext, data: unknown): Promise<void> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const reply = await worker.evaluate(async notificationData => {
    const scope = globalThis as unknown as {
      readonly clients: {
        matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<
          { postMessage(message: unknown, transfer: Transferable[]): void }[]
        >;
      };
    };
    const [client] = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (client === undefined) throw new Error("no open page to route the tap to");
    const channel = new MessageChannel();
    const { promise, resolve } = Promise.withResolvers<unknown>();
    channel.port1.onmessage = event => resolve(event.data);
    client.postMessage({ type: "omp-notification-route", version: 2, data: notificationData }, [channel.port2]);
    return promise;
  }, data);
  expect(reply).toEqual({ type: "omp-notification-route-accepted", version: 2 });
}

test("a tapped notification switches a live collaboration in place and never reloads it", { tag: "@core" }, async ({ browserName, context, page }) => {
  test.skip(browserName !== "chromium", "Playwright exposes service-worker handles only in Chromium");
  await installSilentWebSocket(page);
  const viewing = session("tap-viewing-instance-01");
  const asking = session("tap-asking-instance-001", { inputRequired: true });
  const requestId = asking.ask!.requestId;
  const fixture = await startDashboardFixture([viewing, asking]);
  const sessionListReads = (): number => fixture.requests.filter(request => request === "GET /api/v1/sessions").length;
  try {
    await page.goto(fixture.origin);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.locator('.working-row[data-instance-id="tap-viewing-instance-01"]').click();
    await expect(page.locator(".shell-title")).toHaveText("tap-viewing-instance-01");
    // Survives only while this document does; a reload or navigation would drop it.
    await page.evaluate(() => Object.defineProperty(globalThis, "__ompTappedDocument", { value: true }));
    const sameDocument = () => page.evaluate(() => "__ompTappedDocument" in globalThis);

    // Another session's ask: Control of that session replaces the live View in this document.
    await tapNotification(context, { version: 2, type: "attention", instanceId: asking.instanceId, requestId });
    await expect(page.locator(".shell-title")).toHaveText("tap-asking-instance-001");
    await expect(page.getByRole("application", { name: "OMP collaboration session" })).toBeVisible();
    await expect(page).toHaveURL(fixture.origin + "/client/");
    expect(await sameDocument()).toBe(true);
    expect(fixture.launchRequests).toEqual([
      { instanceId: viewing.instanceId, generation: 1, mode: "view" },
      { instanceId: asking.instanceId, generation: 1, mode: "control", requestId },
    ]);

    // Taps for the collaboration already open keep it: its own ask, and an activity stop, which
    // must not downgrade Control to View.
    for (const data of [
      { version: 2, type: "attention", instanceId: asking.instanceId, requestId },
      { version: 2, type: "activity_stop", instanceId: asking.instanceId, generation: 1 },
    ]) {
      const reads = sessionListReads();
      await tapNotification(context, data);
      await expect.poll(sessionListReads).toBe(reads + 1);
      await expect(page.locator(".triage-bar")).toBeHidden();
      expect(fixture.launchRequests).toHaveLength(2);
    }

    // A stale tap leaves the live collaboration open and says so where the user is looking.
    await tapNotification(context, { version: 2, type: "attention", instanceId: viewing.instanceId, requestId: "tap-stale-request-000001" });
    await expect(page.locator(".triage-bar")).toContainText("That alert changed or expired.");
    await expect(page.locator(".shell-title")).toHaveText("tap-asking-instance-001");
    expect(fixture.launchRequests).toHaveLength(2);
    expect(await sameDocument()).toBe(true);
  } finally {
    await fixture.stop();
  }
});

async function notificationState(page: Page): Promise<NotificationTestState> {
  return page.evaluate(() => {
    const testGlobal = globalThis as unknown as { __ompNotificationTest: NotificationTestState };
    return structuredClone(testGlobal.__ompNotificationTest);
  });
}

test("attention cards and explicit background alert settings stay metadata-only", async ({ page }) => {
  const controlAttention = session("attention-control-0001", { inputRequired: true });
  const viewAttention = session("attention-viewonly-002", {
    canControl: false,
    inputRequired: true,
    startedAt: "2026-07-21T09:00:00.000Z",
  });
  const ordinary = session("ordinary-newest-0003", { startedAt: "2026-07-21T12:00:00.000Z", busy: true });
  const fixture = await startDashboardFixture([ordinary, viewAttention, controlAttention]);
  const forbiddenCanaries = [
    "PROMPT_CONTENT_CANARY",
    "OPTION_CONTENT_CANARY",
    "PREFILL_CONTENT_CANARY",
    "ANSWER_CONTENT_CANARY",
    "PRIVATE_REQUEST_ID_CANARY",
    "CAPABILITY_CONTENT_CANARY",
  ];

  try {
    await page.addInitScript(() => {
      const state: NotificationTestState = {
        permission: "default",
        permissionRequests: 0,
        subscribeCalls: 0,
        subscriptionActive: false,
        unsubscribeCalls: 0,
      };
      const subscriptionJson = {
        endpoint: "https://push.example.test/send/e2e-browser",
        expirationTime: null,
        keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
      };
      let subscription: PushSubscription | null = null;
      const createSubscription = (): PushSubscription => ({
        endpoint: subscriptionJson.endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey(): ArrayBuffer | null {
          return null;
        },
        async unsubscribe(): Promise<boolean> {
          state.unsubscribeCalls += 1;
          state.subscriptionActive = false;
          subscription = null;
          return true;
        },
        toJSON(): PushSubscriptionJSON {
          return structuredClone(subscriptionJson);
        },
      });
      const pushManager = {
        async getSubscription(): Promise<PushSubscription | null> {
          return subscription;
        },
        async subscribe(): Promise<PushSubscription> {
          state.subscribeCalls += 1;
          state.subscriptionActive = true;
          subscription = createSubscription();
          return subscription;
        },
      };
      Object.defineProperty(globalThis, "__ompNotificationTest", { configurable: true, value: state });
      Object.defineProperty(globalThis, "Notification", {
        configurable: true,
        value: class {
          static get permission(): NotificationPermission {
            return state.permission;
          }

          static async requestPermission(): Promise<NotificationPermission> {
            state.permissionRequests += 1;
            state.permission = "granted";
            return state.permission;
          }
        },
      });
      Object.defineProperty(globalThis, "PushManager", {
        configurable: true,
        value: class {},
      });
      Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
        configurable: true,
        get(): typeof pushManager {
          return pushManager;
        },
      });
      Object.defineProperty(ServiceWorkerRegistration.prototype, "showNotification", {
        configurable: true,
        async value(): Promise<void> {},
      });
    });

    await page.goto(fixture.origin);
    await expect(page.locator("#directory-title")).toHaveText("Needs you");
    await expect(page.locator("#directory-count")).toHaveText("2 waiting");
    await expect(page.locator(".queue-hero h2")).toHaveText("attention-control-0001");
    await expect(page.locator(".queue-hero .ask-preview")).toHaveText("Waiting for your input");
    await expect(page.locator(".queue-hero").getByRole("button")).toHaveText([
      "Open request",
      "Options",
    ]);
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("button", { name: "Hold for desk" }).click();
    await expect(page.locator("#directory-count")).toHaveText("2 waiting · 1 held");
    await expect(page.locator(".queue-hero h2")).toHaveText("attention-viewonly-002");
    await expect(page.locator(".held-row .row-title")).toHaveText("attention-control-0001");
    const heldStorage = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("omp.sessions.held-asks.v2") ?? "null") as unknown,
    );
    expect(heldStorage).toEqual([
      {
        instanceId: "attention-control-0001",
        requestId: "request-attention-control-0001",
        heldAt: expect.any(String),
        sourceId: "local",
        sourceOrigin: fixture.origin,
      },
    ]);
    await page.locator(".held-requeue").click();
    await expect(page.locator("#directory-count")).toHaveText("2 waiting");
    await expect(page.locator(".queue-hero h2")).toHaveText("attention-control-0001");
    await expect(page.locator(".queue-row .row-title")).toHaveText(["attention-viewonly-002"]);
    await expect(page.locator(".working-row .row-title")).toHaveText(["ordinary-newest-0003"]);
    expect(await notificationState(page)).toMatchObject({ permissionRequests: 0, subscriptionActive: false });
    for (const busy of [true, false, undefined]) {
      const { busy: _activity, ...metadata } = ordinary;
      const updated = busy === undefined ? metadata : { ...metadata, busy };
      fixture.upsert(updated);
      await expect(page.locator(".session-activity")).toHaveText(
        busy === true ? "Working" : busy === false ? "Idle" : "Activity unknown",
      );
      await expect(page.locator(".working-row .session-tile")).toHaveAttribute(
        "data-state", busy === true ? "working" : busy === false ? "idle" : "unknown",
      );
      expect(await page.locator(".session-activity").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    const directoryTargets = await page
      .locator("#settings, .action-request, .queue-row, .working-row, .dismiss-session")
      .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    expect(directoryTargets.every(height => height >= 44)).toBe(true);
    const heroAltTargets = await page
      .locator(".hero-options")
      .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    expect(heroAltTargets.every(height => height >= 44)).toBe(true);

    for (let count = 1; count <= 6; count += 1) {
      const waiting = Array.from({ length: count }, (_, index) =>
        session(`responsive-attention-${String(index + 1).padStart(4, "0")}`, {
          inputRequired: true,
          lastSeenAt: `2026-07-21T10:00:${String(index + 2).padStart(2, "0")}.000Z`,
        }),
      );
      fixture.setSnapshot([...waiting, ordinary]);
      await expect(page.locator("#directory-count")).toHaveText(`${count} waiting`);
      await expect(page.locator(".queue-hero")).toHaveCount(1);
      await expect(page.locator(".queue-row")).toHaveCount(count - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const targets = await page
        .locator(".action-request, .hero-options, .queue-row, .working-row, .dismiss-session")
        .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
      expect(targets.every(height => height >= 44)).toBe(true);
    }

    fixture.setSnapshot([ordinary]);
    await expect(page.locator("#directory-title")).toHaveText("Sessions");
    await expect(page.locator("#directory-count")).toHaveText("Live · 1");
    await expect(page.locator(".all-clear-title")).toHaveText("All clear");
    // Alerts were never enabled, so the resting copy must not promise a ping; the hint chip
    // routes to Settings instead, and the old bottom notifications block is gone.
    await expect(page.locator(".all-clear-copy")).toHaveText("Nothing needs you.");
    await expect(page.locator(".alerts-hint")).toHaveText("Enable alerts to get pinged");
    await expect(page.locator(".working-row")).toHaveCount(1);
    await expect(page.locator(".lede, .site-footer, .home-alerts")).toHaveCount(0);
    await expect(page.locator("#settings")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const allClearDot = await page.locator(".all-clear-dot").evaluate(element => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        shadow: style.boxShadow,
        width: element.getBoundingClientRect().width,
      };
    });
    expect(allClearDot.height).toBeGreaterThan(0);
    expect(allClearDot.width).toBe(allClearDot.height);
    expect(allClearDot.shadow).not.toBe("none");

    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.locator("#settings").click();
    await expect(page.locator("#notify")).toHaveText("Enable background alerts");
    await expect(page.locator("#notify-note")).toBeVisible();
    await expect(page.locator("#notification-detail-options")).toBeHidden();
    await page.locator("#tray .tray-leading").click();
    await expect(page.locator("#tray")).toBeHidden();
    expect(await notificationState(page)).toMatchObject({ permissionRequests: 0, subscriptionActive: false });
    await page.clock.install();
    const requestsBeforeDismiss = fixture.requests.length;
    await page.getByRole("button", { name: "Hide ordinary-newest-0003 on this device" }).click();
    await expect(page.locator(".working-row")).toHaveCount(0);
    await expect(page.locator("#directory-count")).toHaveText("Live · 1");
    await expect(page.locator(".all-clear-copy")).toHaveText("Nothing needs you.");
    await expect(page.locator("#tray[data-panel='undo']")).toBeVisible();
    await expect(page.locator("#undo-copy")).toContainText("on this device");
    const dismissedStorage = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("omp.sessions.dismissed.v2") ?? "null") as unknown,
    );
    expect(dismissedStorage).toEqual([
      {
        instanceId: "ordinary-newest-0003",
        generation: 1,
        dismissedAt: expect.any(String),
        sourceId: "local",
        sourceOrigin: fixture.origin,
      },
    ]);
    await page.locator("#undo-dismissal").click();
    await expect(page.locator(".working-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Hide ordinary-newest-0003 on this device" }).click();
    await page.clock.fastForward(5_100);
    await expect(page.locator("#tray[data-panel='undo']")).toBeHidden();
    await expect(page.locator(".dismissed-control")).toContainText("1 hidden on this device");
    const restoreSurface = await page.locator(".dismissed-control").evaluate(element => {
      const action = element.querySelector("button");
      return {
        actionHeight: action?.getBoundingClientRect().height ?? 0,
        overflowFree: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(restoreSurface).toEqual({ actionHeight: 44, overflowFree: true });
    expect(fixture.requests).toHaveLength(requestsBeforeDismiss);
    await page.locator(".dismissed-control").getByRole("button", { name: "Show all" }).click();
    await expect(page.locator(".working-row")).toHaveCount(1);
    expect(await page.evaluate(() => localStorage.getItem("omp.sessions.dismissed.v2"))).toBe("[]");

    expect(await notificationState(page)).toMatchObject({ permissionRequests: 0, subscriptionActive: false });
    await page.locator("#settings").click();
    await expect(page.locator("#tray")).toBeVisible();
    await page.locator("#notify").click();
    await expect(page.locator("#notify")).toHaveText("Disable background alerts");
    await page.locator("#alert-detail").click();
    await expect(page.locator("#notification-detail-options")).toBeVisible();
    await expect(page.locator('input[name="notification-detail"][value="session"]')).toBeChecked();
    await expect(page.locator(".detail-warning")).toContainText("notification history");
    const detailTargets = await page.locator(".detail-option").evaluateAll(elements =>
      elements.map(element => element.getBoundingClientRect().height),
    );
    expect(detailTargets.every(height => height >= 48)).toBe(true);
    await page.locator('input[name="notification-detail"][value="preview"]').check();
    await expect(page.locator('input[name="notification-detail"][value="preview"]')).toBeChecked();
    expect(await notificationState(page)).toMatchObject({
      permission: "granted",
      permissionRequests: 1,
      subscribeCalls: 1,
      subscriptionActive: true,
      unsubscribeCalls: 0,
    });
    expect(fixture.requests).toContain("POST /api/v1/push/subscription");


    await page.locator("#notify").click();
    await expect(page.locator("#notify")).toHaveText("Enable background alerts");
    await expect(page.locator("#notification-detail-options")).toBeHidden();
    expect(await notificationState(page)).toMatchObject({
      subscribeCalls: 1,
      subscriptionActive: false,
      unsubscribeCalls: 1,
    });
    expect(fixture.requests).toContain("DELETE /api/v1/push/subscription");

    const browserResidue = await page.evaluate(async canaries => {
      const cacheEntries: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          cacheEntries.push(request.url, await (await cache.match(request))!.text());
        }
      }
      const databaseNames = typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map(database => database.name ?? "")
        : [];
      const text = [
        document.documentElement.textContent ?? "",
        location.href,
        JSON.stringify(history.state),
        document.cookie,
        JSON.stringify({ ...localStorage }),
        JSON.stringify({ ...sessionStorage }),
        JSON.stringify(databaseNames),
        JSON.stringify(cacheEntries),
        (() => {
          const testGlobal = globalThis as unknown as { __ompNotificationTest: NotificationTestState };
          return JSON.stringify(testGlobal.__ompNotificationTest);
        })(),
      ].join("\n");
      return {
        found: canaries.filter(canary => text.includes(canary)),
        cacheUrls: cacheEntries.filter(entry => entry.startsWith("http")),
      };
    }, forbiddenCanaries);
    expect(browserResidue.found).toEqual([]);
    expect(browserResidue.cacheUrls.every(url => !url.includes("/api/") && !url.includes("/client/"))).toBe(true);
    expect(fixture.requests.some(request => request.includes("/launch") || request.includes("/client/"))).toBe(false);
  } finally {
    await fixture.stop();
  }
});
