import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { fleetSourceBinding, type FleetSourceStatus, type SessionMetadata } from "@omp-session-gateway/protocol";
import { startDashboardFixture, installSilentWebSocket, type DashboardFixture } from "./fixture-server";
import { installSyntheticProductFixture, GATEWAY_WAITING, GATEWAY_WORKING } from "./synthetic-product-fixture";

// chrome-headless-shell exposes WorkerNavigator badging but has no BadgeService binder (bad IPC
// reason 123). Full Chromium's modern headless mode exercises the real worker API instead.
test.use({ channel: async ({ browserName }, use) => { await use(browserName === "chromium" ? "chromium" : undefined); } });

const GRANT = "71000000-0000-4000-8000-000000000001";
const VERIFIER = "FLEET_SYNTHETIC_VERIFIER_".padEnd(43, "v");
const ENDPOINT = "https://push.example.test/send/FLEET_SYNTHETIC_ENDPOINT";
const expiry = (): string => new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
const row = (state: FleetSourceStatus["state"], selected = true): FleetSourceStatus => ({
  sourceId: "remote", state, selected, ...(state === "not_enrolled" ? {} : { grantId: GRANT }),
  ...(state === "current" || state === "stale" ? { expiresAt: expiry() } : {}),
});
const shared: SessionMetadata = { ...GATEWAY_WAITING, instanceId: "fleet-notification-collision", title: "Remote request" };

async function pushProfile(page: Page, oldWorker = false): Promise<void> {
  await page.addInitScript(({ endpoint, oldWorker }) => {
    const json = { endpoint, expirationTime: null, keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) } };
    let subscribed = true;
    const subscription = {
      endpoint, expirationTime: null, options: { userVisibleOnly: true, applicationServerKey: null },
      getKey: () => null,
      toJSON: () => json,
      async unsubscribe(): Promise<boolean> { subscribed = false; return true; },
    };
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: class {
      static permission = "granted";
      static async requestPermission(): Promise<string> { throw new Error("unexpected permission prompt"); }
    } });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", { configurable: true, get: () => ({
      async getSubscription(): Promise<unknown> { return subscribed ? subscription : null; },
      async subscribe(): Promise<unknown> { subscribed = true; return subscription; },
    }) });
    Object.defineProperty(ServiceWorkerRegistration.prototype, "showNotification", { configurable: true, async value(): Promise<void> {} });
    if (oldWorker) {
      const postMessage = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function(message: unknown, transfer: Transferable[] | StructuredSerializeOptions = []): void {
        const request = message as { type?: string; version?: number };
        if (request.type === "omp-notification-support-request" && request.version === 3) {
          const port = (Array.isArray(transfer) ? transfer : transfer.transfer)?.[0] as MessagePort | undefined;
          port?.postMessage({ type: "omp-notification-support-response", version: 2 });
        } else postMessage.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
      };
    }
  }, { endpoint: ENDPOINT, oldWorker });
}

async function fleetApi(page: Page, home: DashboardFixture, away: DashboardFixture, initial: FleetSourceStatus = row("current")) {
  const api = {
    current: initial,
    unsupported: false,
    activationFailure: undefined as { status: number; code: string } | undefined,
    calls: [] as { path: string; method: string; body: Record<string, unknown>; credentials: boolean }[],
  };
  await page.route("**/api/v1/push/fleet/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown>;
    api.calls.push({ path, method: request.method(), body, credentials: request.headers().authorization !== undefined });
    if (api.unsupported) { await route.fulfill({ status: 404, body: "" }); return; }
    if (path.endsWith("/status")) await route.fulfill({ json: { version: 1, sources: [api.current] } });
    else if (path.endsWith("/fleet/grants")) await route.fulfill({ status: 201, json: { version: 1, grantId: GRANT, verifier: VERIFIER } });
    else if (path.endsWith("/activate")) {
      if (api.activationFailure !== undefined) await route.fulfill({ status: api.activationFailure.status, json: { code: api.activationFailure.code } });
      else { api.current = row("current", api.current.selected); await route.fulfill({ status: 204 }); }
    } else if (path.endsWith("/recipient")) {
      const selected = (body.sources as string[] | undefined)?.includes("remote") ?? false;
      const released = api.current.selected && !selected ? [{ sourceId: "remote", grantId: GRANT }] : [];
      api.current = { ...api.current, selected };
      await route.fulfill({ json: { version: 1, sources: selected ? ["remote"] : [], released } });
    } else await route.fulfill({ status: 204 });
  });
  await page.route(`${away.origin}/api/v1/notification-grants**`, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": home.origin, "Vary": "Origin", "Cache-Control": "no-store" };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } });
      return;
    }
    api.calls.push({ path: away.origin + path, method: request.method(), body: request.postDataJSON() as Record<string, unknown>,
      credentials: request.headers().cookie !== undefined || request.headers().authorization !== undefined });
    await route.fulfill(path.endsWith("/revoke") ? { status: 204, headers }
      : { status: path.endsWith("/renew") ? 200 : 201, headers, json: { version: 1, grantId: GRANT, expiresAt: expiry() } });
  });
  return api;
}

async function tap(page: Page, data: unknown): Promise<void> {
  expect(await page.evaluate(async data => {
    const registration = await navigator.serviceWorker.ready;
    const channel = new MessageChannel();
    const { promise, resolve } = Promise.withResolvers<unknown>();
    channel.port1.onmessage = event => resolve(event.data);
    // Same metadata-only handoff as the real notificationclick listener (unit-tested with v2/v3).
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
      data: { type: "omp-notification-route", version: 3, data }, ports: [channel.port2],
    }));
    void registration;
    const reply = await promise;
    channel.port1.close();
    return reply;
  }, data)).toEqual({ type: "omp-notification-route-accepted", version: 3 });
}

async function storageContents(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const databases: unknown[] = [];
    const cached: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        cached.push(request.url, await (await cache.match(request))!.text());
      }
    }
    for (const descriptor of await indexedDB.databases()) {
      if (descriptor.name === undefined) continue;
      const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
      const open = indexedDB.open(descriptor.name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error("database read failed"));
      const database = await promise;
      for (const name of database.objectStoreNames) {
        const { promise, resolve, reject } = Promise.withResolvers<unknown>();
        const request = database.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error("store read failed"));
        databases.push(await promise);
      }
      database.close();
    }
    return JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, databases, cached });
  });
}

function configure(home: DashboardFixture, away: DashboardFixture): void {
  home.configureFleet("Home", [{ id: "remote", label: "Studio", origin: away.origin }], []);
  away.configureFleet("Studio", [], [home.origin]);
}

test("fleet Hosts enroll, partial failure, reload renewal, and released revocation stay per-host and storage-free", { tag: ["@core", "@serviceworker"] }, async ({ page }) => {
  const home = await startDashboardFixture([]);
  const away = await startDashboardFixture([]);
  configure(home, away);
  await pushProfile(page);
  const api = await fleetApi(page, home, away, row("not_enrolled", false));
  try {
    await page.goto(home.origin);
    await page.locator("#settings").click();
    const toggle = page.getByRole("switch", { name: "Studio alerts", exact: true });
    await expect(toggle).not.toBeChecked();
    api.activationFailure = { status: 503, code: "source_unreachable" };
    await toggle.click();
    await expect(page.locator(".notification-host-error")).toHaveText("source_unreachable");
    await expect(page.locator(".notification-host-status")).toHaveText("Off");
    api.activationFailure = undefined;
    await toggle.check();
    await expect(page.locator(".notification-host-status")).toHaveText("Covered");
    await expect(page.locator(".notification-hosts-summary")).toHaveText("All selected hosts covered");
    await expect(page.locator("#notify")).toHaveText("Disable background alerts");
    expect(api.calls.find(call => call.path === `${away.origin}/api/v1/notification-grants`)?.body)
      .toEqual({ version: 1, grantId: GRANT, verifier: VERIFIER });
    expect(api.calls.filter(call => call.path.startsWith(away.origin)).every(call => !call.credentials)).toBe(true);
    expect(api.calls.filter(call => call.path.endsWith("/status")).every(call => call.body.endpoint === ENDPOINT)).toBe(true);
    api.current = { ...row("stale"), expiresAt: new Date(Date.now() + 9 * 24 * 60 * 60 * 1_000).toISOString() };
    await page.reload();
    await page.locator("#settings").click();
    await expect(page.locator(".notification-host-status")).toHaveText("Unreachable · showing last known");
    await expect(page.locator(".notification-hosts-summary")).toHaveText("0 of 1 selected hosts covered");
    await expect.poll(() => api.calls.some(call => call.path.endsWith("/renew"))).toBe(true);
    await expect(page.locator("#empty-state")).toContainText("Host coverage incomplete");
    await toggle.uncheck();
    await expect.poll(() => api.calls.some(call => call.path === `${away.origin}/api/v1/notification-grants/${GRANT}/revoke`)).toBe(true);
    expect(api.calls.some(call => call.method === "DELETE" && call.path.endsWith("/recipient"))).toBe(true);
    const storage = await storageContents(page);
    for (const value of [ENDPOINT, VERIFIER, GRANT, "FLEET_SYNTHETIC_SECRET"]) expect(storage).not.toContain(value);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await toggle.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

test("stale, revoked, unknown and rebound-origin fleet taps never reach any launch broker", { tag: ["@core", "@serviceworker"] }, async ({ page }) => {
  const home = await startDashboardFixture([{ ...shared, title: "Home collision" }]);
  const away = await startDashboardFixture([shared]);
  configure(home, away);
  await pushProfile(page);
  const api = await fleetApi(page, home, away);
  const binding = await fleetSourceBinding("remote", away.origin);
  try {
    for (const [state, source] of [["stale", binding], ["unauthorized", binding], ["current", "X".repeat(22)],
      ["current", await fleetSourceBinding("remote", "http://127.0.0.1:1")]] as const) {
      await test.step(`${state}: ${source === binding ? "configured" : "unmatched"} binding`, async () => {
        api.current = row(state);
        await page.goto(`${home.origin}/collab/${shared.instanceId}?request=${shared.ask!.requestId}&source=${source}`);
        await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "expired");
        await expect(page.locator("#status-banner")).toBeVisible();
        await expect(page).toHaveURL(home.origin + "/");
        expect(home.launchRequests).toHaveLength(0);
        expect(away.launchRequests).toHaveLength(0);
        expect(home.requests.concat(away.requests).some(request => request.endsWith("/launch"))).toBe(false);
      });
    }
  } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

test("a remote stop revalidates only its exact source and opens View", { tag: ["@core", "@serviceworker"] }, async ({ page }) => {
  const home = await startDashboardFixture([{ ...shared, title: "Home collision" }]);
  const away = await startDashboardFixture([shared]);
  configure(home, away);
  await pushProfile(page);
  await installSilentWebSocket(page);
  await fleetApi(page, home, away);
  const binding = await fleetSourceBinding("remote", away.origin);
  try {
    await page.goto(`${home.origin}/collab/${shared.instanceId}?activity=stopped&generation=${shared.generation}&source=${binding}`);
    await expect(page.locator(".shell-host")).toHaveText("Studio");
    await expect(page.getByRole("textbox", { name: "Read-only session — watching only", exact: true })).toBeDisabled();
    expect(away.launchRequests).toEqual([{ instanceId: shared.instanceId, generation: shared.generation, mode: "view" }]);
    expect(home.launchRequests).toHaveLength(0);
    const storage = await storageContents(page);
    home.assertNoCapabilityMaterial(storage);
    away.assertNoCapabilityMaterial(storage);
    expect(storage).not.toContain(ENDPOINT);
  } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

test("a warm page refuses an old binding after the configured source origin is rebound", { tag: ["@core", "@serviceworker"] }, async ({ page }) => {
  const home = await startDashboardFixture([{ ...shared, title: "Home collision" }]);
  const away = await startDashboardFixture([shared]);
  const replacement = await startDashboardFixture([shared]);
  configure(home, away);
  await pushProfile(page);
  await installSilentWebSocket(page);
  await fleetApi(page, home, away);
  const binding = await fleetSourceBinding("remote", away.origin);
  try {
    await page.goto(home.origin);
    await expect(page.locator(".queue-hero")).toBeVisible();
    await page.locator("#settings").click();
    await expect(page.locator(".notification-host-status")).toHaveText("Covered");
    await page.locator("#tray .tray-leading").click();
    home.configureFleet("Home", [{ id: "remote", label: "Replacement", origin: replacement.origin }], []);
    await tap(page, { version: 3, type: "attention", source: binding, instanceId: shared.instanceId, requestId: shared.ask!.requestId });
    await expect.poll(async () => (await page.locator(".gateway-shell").count()) > 0 ||
      await page.locator("#status-banner").getAttribute("data-kind") === "expired").toBe(true);
    expect(away.launchRequests).toHaveLength(0);
    expect(home.launchRequests).toHaveLength(0);
    expect(replacement.launchRequests).toHaveLength(0);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "expired");
  } finally { await page.close(); await Promise.all([home.stop(), away.stop(), replacement.stop()]); }
});

for (const oldWorker of [false, true]) {
  test(`fleet compatibility: ${oldWorker ? "old client / new gateway" : "new client / old gateway"} keeps local Push v2`, { tag: ["@core", "@serviceworker"] }, async ({ page }) => {
    const home = await startDashboardFixture([]);
    const away = await startDashboardFixture([]);
    configure(home, away);
    await pushProfile(page, oldWorker);
    const api = await fleetApi(page, home, away);
    api.unsupported = !oldWorker;
    try {
      await page.goto(home.origin);
      await page.locator("#settings").click();
      await expect(page.locator("#notify")).toHaveText("Disable background alerts");
      await expect(page.locator(".notification-hosts")).toBeHidden();
      expect(api.calls.some(call => call.path.endsWith("/recipient"))).toBe(false);
      if (oldWorker) expect(api.calls).toHaveLength(0);
      else await expect.poll(() => api.calls.filter(call => call.path.endsWith("/status")).length).toBeGreaterThan(0);
    } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
  });
}

for (const surface of ["view", "ask", "composer", "photo", "speech", "first-task"] as const) {
  test(`fleet taps preserve the active ${surface} surface without reloading or relaunching`, async ({ page, context }, info) => {
    test.skip(!info.project.name.startsWith("pixel"), "The deep browser lane exercises pinned-client drafts");
    const key = randomBytes(32);
    const current = surface === "ask" ? GATEWAY_WAITING : GATEWAY_WORKING;
    const home = await startDashboardFixture([current], { roomKey: key });
    const away = await startDashboardFixture(surface === "first-task" ? [] : [current], { roomKey: key });
    configure(home, away);
    if (surface === "first-task") away.configureCreation({ readySession: current, states: [{ state: "ready" }] });
    await installSyntheticProductFixture(context, key, { activeAsk: surface === "ask", randomSeed: 42 });
    await page.route(`${home.origin}/api/v1/client-config`, async route => {
      const response = await route.fetch();
      const config = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, json: { ...config, speech: { browserRecognition: true } } });
    });
    await page.addInitScript(() => {
      class Recognition {
        lang = ""; continuous = false; interimResults = false; maxAlternatives = 1;
        onstart: (() => void) | null = null;
        onresult: ((event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() { Reflect.set(window, "__fleetSpeech", this); }
        start(): void { queueMicrotask(() => this.onstart?.()); }
        stop(): void { this.onend?.(); }
        abort(): void {}
      }
      Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: Recognition });
    });
    const api = await fleetApi(page, home, away);
    const binding = await fleetSourceBinding("remote", away.origin);
    const task = "FLEET_SYNTHETIC_FIRST_TASK_DRAFT";
    try {
      await page.goto(home.origin);
      await page.locator("#settings").click();
      await page.locator("#notify").click();
      await expect(page.locator(".notification-host-status")).toHaveText("Covered");
      await page.locator("#tray .tray-leading").click();
      if (surface === "first-task") {
        await page.locator("#new-session").click();
        await page.getByRole("button", { name: "Studio", exact: true }).click();
        await page.getByRole("button", { name: "Synthetic project", exact: true }).click();
        await page.getByRole("button", { name: "Main", exact: true }).click();
        await page.getByRole("button", { name: "OMP", exact: true }).click();
        await page.getByRole("textbox", { name: "First task (optional)" }).fill(task);
        await tap(page, { version: 3, type: "activity_stop", source: "X".repeat(22), instanceId: current.instanceId, generation: 1 });
        await expect(page.getByRole("textbox", { name: "First task (optional)" })).toHaveValue(task);
        await page.getByRole("button", { name: "Create and open Control", exact: true }).click();
      } else {
        await page.getByLabel("Host", { exact: true }).selectOption({ label: "Studio" });
        if (surface === "ask") await page.getByRole("button", { name: "Open request", exact: true }).click();
        else {
          await page.getByRole("button", { name: `View ${current.title}`, exact: true }).click();
          if (surface !== "view") await page.locator(".shell-control").click();
        }
      }
      await expect(page.locator(".shell-host")).toHaveText("Studio");
      const composer = page.locator(".sh-composer-input");
      if (surface === "ask") {
        await expect(page.locator(".sh-ask-option")).toHaveCount(2);
        await page.locator(".sh-ask-option").nth(1).click();
      } else if (surface === "view") await expect(composer).toBeDisabled();
      else if (surface === "first-task") await expect(composer).toHaveValue(task);
      else await composer.fill("FLEET_SYNTHETIC_UNSENT_DRAFT");
      if (surface === "photo") {
        const image = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 16; canvas.height = 16;
          canvas.getContext("2d")!.fillRect(0, 0, 16, 16);
          return canvas.toDataURL("image/png").split(",")[1]!;
        });
        await page.locator(".sh-photo-input-library").setInputFiles({
          name: "FLEET_SYNTHETIC_PHOTO.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
        });
        await expect(page.locator(".sh-photo img")).toBeVisible();
      }
      if (surface === "speech") {
        await page.getByRole("button", { name: "Start browser speech input", exact: true }).click();
        await page.getByRole("button", { name: "Start recording", exact: true }).click();
        await page.evaluate(() => {
          // In-process fixture instance, not server or persisted data.
          const recognition = Reflect.get(window, "__fleetSpeech") as {
            onresult(event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }): void;
            onend(): void;
          };
          recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "FLEET_SYNTHETIC_SPEECH_REVIEW" } }] });
          recognition.onend();
        });
        await expect(page.getByRole("textbox", { name: "Review speech text" })).toHaveValue("FLEET_SYNTHETIC_SPEECH_REVIEW");
      }
      await page.locator(".gateway-shell").evaluate(element => element.setAttribute("data-fleet-preserved", "true"));
      await page.evaluate(() => Reflect.set(window, "__fleetSameDocument", true));
      const launches = away.launchRequests.length;
      const reads = api.calls.filter(call => call.path.endsWith("/status")).length;
      await tap(page, { version: 3, type: "activity_stop", source: binding, instanceId: current.instanceId, generation: current.generation });
      await expect.poll(() => api.calls.filter(call => call.path.endsWith("/status")).length).toBeGreaterThan(reads);
      // A stale alert for a colliding instance cannot tear down the live client either.
      await tap(page, { version: 3, type: "attention", source: "X".repeat(22), instanceId: current.instanceId, requestId: "fleet_expired_request_0001" });
      await expect(page.locator(".gateway-shell[data-fleet-preserved='true']")).toBeVisible();
      expect(await page.evaluate(() => Reflect.get(window, "__fleetSameDocument"))).toBe(true);
      expect(away.launchRequests).toHaveLength(launches);
      expect(home.launchRequests).toHaveLength(0);
      if (surface === "ask") await expect(page.locator(".sh-ask-option").nth(1)).toHaveAttribute("aria-pressed", "true");
      else if (surface === "view") await expect(composer).toBeDisabled();
      else await expect(composer).toHaveValue(surface === "first-task" ? task : "FLEET_SYNTHETIC_UNSENT_DRAFT");
      if (surface === "photo") await expect(page.locator(".sh-photo img")).toBeVisible();
      if (surface === "speech") await expect(page.getByRole("textbox", { name: "Review speech text" })).toHaveValue("FLEET_SYNTHETIC_SPEECH_REVIEW");
      expect(await page.evaluate(() => Reflect.get(window, "__ompSyntheticGuestCounts"))).toEqual({ prompts: 0, responses: 0 });
      const storage = await storageContents(page);
      home.assertNoCapabilityMaterial(storage);
      away.assertNoCapabilityMaterial(storage);
      for (const value of [ENDPOINT, VERIFIER, GRANT, task, "FLEET_SYNTHETIC_UNSENT_DRAFT", "FLEET_SYNTHETIC_SPEECH_REVIEW"]) expect(storage).not.toContain(value);
    } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
  });
}

// Chromium's DevTools delivery invokes the installed worker's real PushEvent handler, without an
// external push service or notification permission. The suppressed attention never needs to display.
test("clear-before-attention survives an actual IndexedDB-backed service-worker termination", async ({ browserName, context, page }) => {
  test.skip(browserName !== "chromium", "DevTools push delivery is Chromium-specific");
  const home = await startDashboardFixture([]);
  await pushProfile(page);
  const cdp = await context.newCDPSession(page);
  const registrations = new Map<string, { registrationId: string; scopeURL: string }>();
  const versions = new Map<string, { versionId: string; registrationId: string; status: string; runningStatus: string }>();
  cdp.on("ServiceWorker.workerRegistrationUpdated", event => { for (const registration of event.registrations) registrations.set(registration.registrationId, registration); });
  cdp.on("ServiceWorker.workerVersionUpdated", event => { for (const version of event.versions) versions.set(version.versionId, version); });
  const receipts = async (): Promise<number> => await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const channel = new MessageChannel();
    const { promise, resolve } = Promise.withResolvers<number>();
    channel.port1.onmessage = event => {
      const value: unknown = event.data;
      if (typeof value === "object" && value !== null && "received" in value && typeof value.received === "number") resolve(value.received);
    };
    registration.active!.postMessage({ type: "omp-notification-support-request", version: 3 }, [channel.port2]);
    const received = await promise;
    channel.port1.close();
    return received;
  });
  try {
    await cdp.send("ServiceWorker.enable");
    await page.goto(home.origin);
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await expect.poll(() => [...registrations.values()].find(registration => registration.scopeURL === home.origin + "/")?.registrationId).toBeDefined();
    const registrationId = [...registrations.values()].find(registration => registration.scopeURL === home.origin + "/")!.registrationId;
    const message = { version: 3, instanceId: "fleet-restart-session", generation: 1, requestId: "fleet_restart_request_0001", badge: { count: 0, complete: true } };
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: home.origin, registrationId,
      data: JSON.stringify({ ...message, type: "clear", seq: { epoch: 10, n: 2 } }) });
    await expect.poll(receipts).toBe(1);
    await expect.poll(() => [...versions.values()].find(version => version.registrationId === registrationId && version.status === "activated")?.versionId).toBeDefined();
    const versionId = [...versions.values()].find(version => version.registrationId === registrationId && version.status === "activated")!.versionId;
    // Drop the page's in-flight initialization and status timers before stopping the worker; an
    // owner page posting a late mode handshake would legitimately start it again.
    await page.goto("about:blank");
    await cdp.send("ServiceWorker.stopWorker", { versionId });
    await expect.poll(() => versions.get(versionId)?.runningStatus).toBe("stopped");
    await page.goto(home.origin);
    expect(await receipts()).toBe(1);
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: home.origin, registrationId,
      data: JSON.stringify({ ...message, type: "attention", seq: { epoch: 10, n: 1 }, title: "OMP session needs attention" }) });
    await expect.poll(receipts).toBe(2);
    const contents = await storageContents(page);
    expect(contents).toContain("fleet_restart_request_0001");
    expect(contents).toContain('"shown":{}');
    expect(contents).toContain('"received":2');
    expect(contents).not.toContain(ENDPOINT);
    expect(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length)).toBe(0);
  } finally { await cdp.detach().catch(() => undefined); await page.close(); await home.stop(); }
});
