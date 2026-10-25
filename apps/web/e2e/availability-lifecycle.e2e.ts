import { expect, test, type Page } from "@playwright/test";
import { startDashboardFixture, installSilentWebSocket } from "./fixture-server";
import { GATEWAY_WORKING, GATEWAY_WAITING } from "./synthetic-product-fixture";

const time = new Date("2026-10-25T01:30:00Z");
async function visibility(page: Page, state: "hidden" | "visible", freeze = false): Promise<void> {
  await page.evaluate(({ state, freeze }) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
    if (freeze) document.dispatchEvent(new Event("freeze"));
  }, { state, freeze });
}

for (const freeze of [false, true]) {
  test(`council476: a foreground first-snapshot retry preserves its fault${freeze ? " after freeze" : ""}`, async ({ page }) => {
    const fixture = await startDashboardFixture([]);
    const release = Promise.withResolvers<void>();
    let requests = 0;
    await page.route(`${fixture.origin}/api/v1/sessions`, async route => {
      if (++requests === 1) { await route.fulfill({ status: 503, body: "" }); return; }
      await release.promise;
      await route.continue().catch(() => undefined);
    });
    try {
      await page.clock.install({ time });
      await page.goto(fixture.origin);
      await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop");
      await page.clock.pauseAt(new Date(time.getTime() + 1_000));
      await visibility(page, "hidden", freeze);
      await visibility(page, "visible");
      await expect.poll(() => requests).toBe(2);
      await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop");
      await expect(page.locator("#status-banner > *")).toHaveCount(1);
      release.resolve();
      await expect(page.locator("#status-banner")).toBeHidden();
    } finally { release.resolve(); await page.close(); await fixture.stop(); }
  });
}

for (const via of ["launch", "creation", "probe"] as const) {
  test(`council476: local ${via} 403 rejects pre-denial SSE metadata and clocks`, async ({ page, context }) => {
    const fixture = await startDashboardFixture([GATEWAY_WORKING]);
    await installSilentWebSocket(page);
    await page.addInitScript(() => {
      const Native = EventSource;
      class ObservedSource extends Native {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          (globalThis as typeof globalThis & { __oldDirectoryStream?: EventSource }).__oldDirectoryStream = this;
        }
      }
      globalThis.EventSource = ObservedSource;
    });
    if (via === "creation") {
      fixture.configureCreation({});
      await page.route(`${fixture.origin}/api/v1/session-creations/*`, route => route.fulfill({ status: 403, body: "" }));
    } else if (via === "launch") {
      await page.route(`${fixture.origin}/api/v1/sessions/*/launch`, route => route.fulfill({ status: 403, body: "" }));
    } else {
      await context.route(/\/assets\/collab-client\.[a-f0-9]+\.js(?:\?.*)?$/u, async route => {
        const original = new URL(route.request().url());
        if (original.searchParams.has("availability-original")) { await route.continue(); return; }
        original.search = "?availability-original=1";
        await route.fulfill({ contentType: "text/javascript", body: `
          import { startCollabWithCapability as start } from ${JSON.stringify(original.href)};
          export function startCollabWithCapability(container, capability, onDispose, options) {
            globalThis.__localAvailabilityProbe = options.probeGateway;
            return start(container, capability, onDispose, options);
          }
        ` });
      });
    }
    try {
      await page.clock.install({ time });
      await page.goto(fixture.origin);
      await expect(page.locator(".working-row")).toHaveCount(1);
      await expect.poll(() => fixture.requests.filter(request => request === "GET /api/v1/events").length).toBe(1);
      await page.clock.pauseAt(new Date(time.getTime() + 1_000));
      if (via === "creation") {
        await page.locator("#new-session").click();
        for (const name of ["Synthetic project", "Main", "OMP", "Create and open Control"]) await page.getByRole("button", { name, exact: true }).click();
      } else {
        await page.locator(".working-row").click();
        if (via === "probe") {
          await expect(page.locator(".gateway-shell")).toBeVisible();
          fixture.setListFailure("forbidden");
          await page.evaluate(async () => {
            await (globalThis as typeof globalThis & { __localAvailabilityProbe(signal: AbortSignal): Promise<unknown> }).__localAvailabilityProbe(new AbortController().signal);
          });
        }
      }
      await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "unauthorized");
      await page.evaluate(session => {
        const source = (globalThis as typeof globalThis & { __oldDirectoryStream: EventSource }).__oldDirectoryStream;
        source.dispatchEvent(new MessageEvent("session_upsert", { data: JSON.stringify({ type: "session_upsert", revision: 99, session }) }));
        source.dispatchEvent(new MessageEvent("keepalive", { data: "{}" }));
        source.dispatchEvent(new Event("error"));
      }, GATEWAY_WORKING);
      await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "unauthorized");
      await expect(page.locator(".working-row")).toHaveCount(0);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { __oldDirectoryStream: EventSource }).__oldDirectoryStream.readyState)).toBe(2);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
        window.dispatchEvent(new Event("offline"));
      });
      await expect(page.locator("#empty-state")).toContainText("Session list withdrawn");
      await expect(page.locator("#status-banner")).toContainText("The previous session list was withdrawn.");
    } finally { await page.close(); await fixture.stop(); }
  });
}

test("council476: a healthy remote request does not recover or stop the local retry chain", async ({ page }) => {
  const home = await startDashboardFixture([]);
  const away = await startDashboardFixture([GATEWAY_WAITING]);
  home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
  away.configureFleet("Away", [], [home.origin]);
  home.setListFailure("malformed");
  await installSilentWebSocket(page);
  try {
    await page.clock.install({ time });
    await page.goto(home.origin);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop");
    await page.clock.pauseAt(new Date(time.getTime() + 1_000));
    await page.locator(".action-request").click();
    await expect(page.locator(".gateway-shell")).toBeVisible();
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop");
    const requests = home.requests.filter(request => request === "GET /api/v1/sessions").length;
    home.setListFailure(undefined);
    await page.clock.runFor(4_000);
    await expect.poll(() => home.requests.filter(request => request === "GET /api/v1/sessions").length).toBeGreaterThan(requests);
    await expect(page.locator("#status-banner")).toBeHidden();
    await expect(page.locator("#tray")).toHaveAttribute("data-panel", "request");
  } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

for (const failure of [404, 409, 503, "network"] as const) {
  test(`council476: remote launch ${failure} leaves the independent local banner intact`, async ({ page }) => {
    const home = await startDashboardFixture([]);
    const away = await startDashboardFixture([GATEWAY_WORKING]);
    home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
    away.configureFleet("Away", [], [home.origin]);
    home.setListFailure("malformed");
    await installSilentWebSocket(page);
    await page.route(`${away.origin}/api/v1/sessions/*/launch`, async route => failure === "network" ? await route.abort("connectionrefused")
      : await route.fulfill({ status: failure, headers: { "Access-Control-Allow-Origin": home.origin }, body: "" }));
    try {
      await page.clock.install({ time });
      await page.goto(home.origin);
      await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop");
      await page.clock.pauseAt(new Date(time.getTime() + 1_000));
      await page.locator(".working-row").click();
      await expect(page.locator("#fleet-status")).toContainText("Away:");
      await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop");
    } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
  });
}

for (const exit of ["denied", "scope-cancel"] as const) {
  test(`council476: remote request ${exit} restores the directory snapshot before a local visit`, async ({ page }) => {
    const home = await startDashboardFixture([GATEWAY_WORKING]);
    const away = await startDashboardFixture([GATEWAY_WAITING]);
    home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
    away.configureFleet("Away", [], [home.origin]);
    const release = Promise.withResolvers<void>();
    await installSilentWebSocket(page);
    await page.route(`${away.origin}/api/v1/sessions/*/launch`, async route => {
      if (exit === "scope-cancel") await release.promise;
      await route.fulfill({ status: 403, headers: { "Access-Control-Allow-Origin": home.origin }, body: "" }).catch(() => undefined);
    });
    try {
      await page.goto(home.origin);
      await page.getByLabel("Host", { exact: true }).selectOption({ label: "Away" });
      await page.locator(".action-request").click();
      if (exit === "denied") await expect(page.locator("#fleet-status")).toContainText("Access withdrawn");
      await page.getByLabel("Host", { exact: true }).evaluate(element => {
        const picker = element as HTMLSelectElement;
        picker.value = Array.from(picker.options).find(option => option.label === "Home")!.value;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      release.resolve();
      await expect(page.locator("#tray")).toBeHidden();
      await page.locator(".working-row").click();
      await expect(page.locator(".gateway-shell")).toBeVisible();
      await page.locator(".shell-back").click();
      await expect(page.getByLabel("Host", { exact: true })).toHaveValue(`local\0${home.origin}`);
    } finally { release.resolve(); await page.close(); await Promise.all([home.stop(), away.stop()]); }
  });
}

test("council476: a retained empty single host names its observed clock in All hosts", async ({ page }) => {
  const fixture = await startDashboardFixture([]);
  try {
    await page.clock.install({ time });
    await page.goto(fixture.origin);
    await expect.poll(() => fixture.requests.filter(request => request === "GET /api/v1/events").length).toBe(1);
    await page.clock.pauseAt(new Date(time.getTime() + 1_000));
    fixture.disconnectEvents();
    await expect(page.locator("#empty-state")).toContainText("No sessions as of");
  } finally { await page.close(); await fixture.stop(); }
});

test("council476: All hosts describes expired observations", async ({ page }) => {
  const home = await startDashboardFixture([]);
  const away = await startDashboardFixture([GATEWAY_WORKING]);
  home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
  away.configureFleet("Away", [], [home.origin]);
  try {
    await page.clock.install({ time });
    await page.goto(home.origin);
    await expect(page.locator(".working-row")).toHaveCount(1);
    await page.clock.pauseAt(new Date(time.getTime() + 1_000));
    away.setListFailure("malformed");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#fleet-status")).toContainText("Host unavailable.");
    await page.clock.runFor(35_001);
    await expect(page.locator("#empty-state")).toContainText("Session lists expired");
  } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
});
