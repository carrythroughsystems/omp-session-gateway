import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { startDashboardFixture, installSilentWebSocket } from "./fixture-server";
import { GATEWAY_WORKING, GATEWAY_WAITING, RELEASE_WAITING, installSyntheticProductFixture } from "./synthetic-product-fixture";

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

test("successor3: persisted pageshow resumes an unmounted request preview with a new launch", async ({ page, context }) => {
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
  const release = Promise.withResolvers<void>();
  let launches = 0;
  await installSyntheticProductFixture(context, key);
  await page.route(`${fixture.origin}/api/v1/sessions/*/launch`, async route => {
    if (++launches === 1) await release.promise;
    await route.continue().catch(() => undefined);
  });
  try {
    await page.goto(fixture.origin);
    await page.locator(".action-request").click();
    await expect.poll(() => launches).toBe(1);
    await expect(page.locator(".request-status")).toHaveText("Connecting…");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(() => launches).toBe(2);
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    release.resolve();
    await expect(page.locator("#tray")).toHaveAttribute("data-panel", "request");
    fixture.assertNoCapabilityMaterial(await page.content());
  } finally { release.resolve(); await page.close(); await fixture.stop(); }
});

test("successor3: remote bfcache resume waits for remote freshness despite prior local 403", async ({ page, context }) => {
  const key = randomBytes(32);
  const home = await startDashboardFixture([], { roomKey: key });
  const away = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
  home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
  away.configureFleet("Away", [], [home.origin]);
  const release = Promise.withResolvers<void>();
  const intercepted = Promise.withResolvers<void>();
  await installSyntheticProductFixture(context, key);
  try {
    await page.goto(home.origin);
    await page.locator(".action-request").click();
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    home.setListFailure("forbidden");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "unauthorized");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await page.route(`${away.origin}/api/v1/sessions`, async route => {
      intercepted.resolve();
      await release.promise;
      await route.continue().catch(() => undefined);
    });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await intercepted.promise;
    expect(away.launchRequests).toHaveLength(1);
    release.resolve();
    await expect.poll(() => away.launchRequests.length).toBe(2);
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    await expect(page.locator(".shell-host")).toHaveText("Away");
    home.assertNoCapabilityMaterial(await page.content());
    away.assertNoCapabilityMaterial(await page.content());
  } finally { release.resolve(); await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

for (const localFailure of ["forbidden", "malformed"] as const) {
  for (const outcome of ["answered", "ended"] as const) {
    test(`successor3: remote ${outcome} triage stays authoritative while local is ${localFailure}`, async ({ page, context }) => {
      const key = randomBytes(32);
      const home = await startDashboardFixture([], { roomKey: key });
      const away = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
      home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
      away.configureFleet("Away", [], [home.origin]);
      home.setListFailure(localFailure);
      await installSyntheticProductFixture(context, key);
      try {
        await page.goto(home.origin);
        await page.locator(".action-request").click();
        await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
        await expect(page.locator(".triage-action")).toHaveText("Hold → next");
        away.setSnapshot(outcome === "ended" ? [] : [GATEWAY_WORKING]);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await expect(page.locator(".triage-copy")).toContainText(outcome === "ended" ? "Session ended" : "Answered");
        await expect(page.locator(".shell-host")).toHaveText("Away");
      } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
    });
  }
}

for (const failure of [404, 409, 503, "network"] as const) {
  test(`successor3: remote Next ask ${failure} names its target and recovers through list refresh`, async ({ page, context }) => {
    const key = randomBytes(32);
    const home = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
    const away = await startDashboardFixture([RELEASE_WAITING], { roomKey: key });
    home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
    away.configureFleet("Away", [], [home.origin]);
    const release = Promise.withResolvers<void>();
    let launches = 0;
    let reads = 0;
    await installSyntheticProductFixture(context, key);
    await page.route(`${away.origin}/api/v1/sessions/*/launch`, async route => {
      launches += 1;
      if (failure === "network") await route.abort("connectionrefused");
      else await route.fulfill({ status: failure, headers: { "Access-Control-Allow-Origin": home.origin }, body: "" });
    });
    try {
      await page.goto(home.origin);
      await expect(page.locator("#directory-count")).toHaveText("2 waiting");
      await page.locator(".queue-hero").filter({ has: page.getByRole("heading", { name: GATEWAY_WAITING.title!, exact: true }) })
        .locator(".action-request").or(page.getByRole("button", { name: `Open request in ${GATEWAY_WAITING.title}`, exact: true })).click();
      await expect(page.locator(".triage-action")).toHaveText("Hold → next");
      home.upsert(GATEWAY_WORKING);
      await expect(page.locator(".triage-action")).toHaveText("Next ask →");
      await page.route(`${away.origin}/api/v1/sessions`, async route => {
        reads += 1;
        await release.promise;
        await route.continue().catch(() => undefined);
      });
      await page.locator(".triage-action").click();
      await expect(page.locator(".triage-copy")).toContainText("Away:");
      await expect(page.locator(".triage-action")).toHaveText("Sessions");
      if (failure === 404 || failure === 409) await expect.poll(() => reads).toBe(1);
      await page.locator(".triage-action").click();
      await expect(page.locator("#fleet-status")).toContainText("Away:");
      release.resolve();
      if (failure === 404 || failure === 409) await expect(page.locator("#fleet-status")).toContainText("The list has been refreshed.");
      const priorReads = reads;
      await page.getByRole("button", { name: "Refresh host", exact: true }).click();
      await expect.poll(() => reads).toBe(priorReads + 1);
      expect(launches).toBe(1);
      await expect(page.locator("#fleet-status")).toBeHidden();
      await expect(page.locator("#status-banner")).toBeHidden();
    } finally { release.resolve(); await page.close(); await Promise.all([home.stop(), away.stop()]); }
  });
}

for (const failure of [409, 503, "discard"] as const) {
  test(`successor3: local preview ${failure} returns to the directory without orphaning its snapshot`, async ({ page }) => {
    const home = await startDashboardFixture([GATEWAY_WAITING]);
    const away = await startDashboardFixture([GATEWAY_WORKING]);
    home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
    away.configureFleet("Away", [], [home.origin]);
    const release = Promise.withResolvers<void>();
    const intercepted = Promise.withResolvers<void>();
    await installSilentWebSocket(page);
    await page.route(`${home.origin}/api/v1/sessions/*/launch`, async route => {
      const response = failure === "discard" ? await route.fetch() : undefined;
      intercepted.resolve();
      await release.promise;
      if (response !== undefined) await route.fulfill({ response }).catch(() => undefined);
      else await route.fulfill({ status: failure as number, body: "" }).catch(() => undefined);
    });
    try {
      await page.goto(home.origin);
      await page.locator(".action-request").click();
      await intercepted.promise;
      if (failure === 409) home.setListFailure("forbidden");
      if (failure === "discard") {
        home.upsert(GATEWAY_WORKING);
        await expect(page.locator(".action-request")).toHaveCount(0);
      }
      release.resolve();
      await expect(page.locator("#tray")).toBeHidden();
      if (failure === 409) await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "unauthorized");
      await page.getByLabel("Host", { exact: true }).selectOption({ label: "Away" });
      await expect(page.locator(".working-row")).toHaveCount(1);
      await page.locator(".working-row").click();
      await expect(page.locator(".gateway-shell")).toBeVisible();
      await page.locator(".shell-back").click();
      await expect(page.getByLabel("Host", { exact: true })).toHaveValue(`away\0${away.origin}`);
    } finally { release.resolve(); await page.close(); await Promise.all([home.stop(), away.stop()]); }
  });
}

test("successor3: a fresh empty selected remote is visible while local access is withdrawn", async ({ page }) => {
  const home = await startDashboardFixture([]);
  const away = await startDashboardFixture([]);
  home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
  away.configureFleet("Away", [], [home.origin]);
  home.setListFailure("forbidden");
  try {
    await page.goto(home.origin);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "unauthorized");
    await page.getByLabel("Host", { exact: true }).selectOption({ label: "Away" });
    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(page.locator("#empty-state")).toContainText("No sessions on this host");
    await expect(page.getByRole("button", { name: "All hosts", exact: true })).toBeVisible();
  } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

test("successor3: a quiet pending recheck retains the successful empty observation clock", async ({ page }) => {
  const fixture = await startDashboardFixture([]);
  const release = Promise.withResolvers<void>();
  try {
    await page.clock.install({ time });
    await page.goto(fixture.origin);
    await expect.poll(() => fixture.requests.filter(request => request === "GET /api/v1/events").length).toBe(1);
    await page.clock.pauseAt(new Date(time.getTime() + 1_000));
    await page.route(`${fixture.origin}/api/v1/sessions`, async route => {
      await release.promise;
      await route.continue().catch(() => undefined);
    });
    await visibility(page, "hidden", true);
    await visibility(page, "visible");
    await expect(page.locator("#empty-state .empty-state-detail h2")).toContainText("No sessions as of");
    await expect(page.locator("#empty-state")).toContainText("Checking for updates");
    await expect(page.locator("#status-banner")).toBeHidden();
    await expect(page.locator("#fleet-status .status-action")).toHaveCount(0);
  } finally { release.resolve(); await page.close(); await fixture.stop(); }
});
