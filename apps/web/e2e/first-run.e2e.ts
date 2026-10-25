import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installSilentWebSocket, startDashboardFixture, type DashboardFixture } from "./fixture-server";
import { GATEWAY_WAITING, GATEWAY_WORKING, INITIAL_SESSIONS, installSyntheticProductFixture } from "./synthetic-product-fixture";

const KEY = "omp.sessions.first-run.v1";
interface NotificationFixtureState { __ompNotificationMedia: { permissionRequests: number } }
test.use({ deviceScaleFactor: 2 });
test.beforeEach(async ({}, info) => { test.skip(!info.project.name.startsWith("pixel"), "Pixel lane owns first-run coverage"); });

async function record(page: Page): Promise<unknown> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), KEY);
}

async function permissionRequests(page: Page): Promise<number> {
  return page.evaluate(() => {
    // Installed by the synthetic notification helper before the application boots.
    const fixtureState = globalThis as unknown as NotificationFixtureState;
    return fixtureState.__ompNotificationMedia.permissionRequests;
  });
}

async function assertPrivate(page: Page, fixture: DashboardFixture): Promise<void> {
  fixture.assertNoCapabilityMaterial(JSON.stringify(await page.evaluate(async () => ({
    html: document.documentElement.outerHTML, url: location.href, history: history.state, cookie: document.cookie,
    local: { ...localStorage }, session: { ...sessionStorage },
    databases: await indexedDB.databases(),
    caches: await Promise.all((await caches.keys()).map(async name => {
      const cache = await caches.open(name);
      return Promise.all((await cache.keys()).map(async request => ({ url: request.url, body: await (await cache.match(request))?.text() })));
    })),
  }))));
}

async function settledTray(page: Page, panel: string): Promise<number> {
  const tray = page.locator("#tray");
  await expect(tray).toHaveAttribute("data-panel", `first-run-${panel}`);
  await expect(tray.locator(`[data-panel="first-run-${panel}"] h2`)).toBeFocused();
  await expect(tray.locator(`[data-panel="first-run-${panel}"] h2`)).toHaveCSS("outline-style", "none");
  await expect.poll(async () => tray.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
  return tray.evaluate(element => element.getBoundingClientRect().height);
}

for (const viewport of [{ width: 412, height: 915 }, { width: 1280, height: 800 }]) {
  test(`first-run flow, real alerts, resume and arrivals at ${viewport.width}x${viewport.height}`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    const key = randomBytes(32);
    const fixture = await startDashboardFixture([GATEWAY_WAITING, ...INITIAL_SESSIONS], { roomKey: key, firstRun: true });
    const screenshots = process.env.OMP_FIRST_RUN_SCREENSHOTS;
    const capture = async (name: string): Promise<void> => {
      await assertPrivate(page, fixture);
      if (screenshots === undefined) return;
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, `${viewport.width}x${viewport.height}-${name}.png`) });
    };
    try {
      // Same notification/subscription state-machine fixture as the existing tray and notification lanes.
      await installSyntheticProductFixture(context, key, { answerRequests: true, randomSeed: 42 });
      await page.goto(fixture.origin);
      await expect(page.locator("#directory-title")).toHaveText("Needs you");
      const connected = await settledTray(page, "connected");
      await expect(page.locator(".first-run-copy")).toContainText("5 live sessions are listed across the checked hosts.");
      await expect(page.locator(".first-run-note")).toHaveText("Capabilities are requested only when you tap an action.");
      await expect(page.locator(".first-run-connected svg")).toHaveAttribute("width", "32");
      expect(await record(page)).toBeNull();
      expect(fixture.launchRequests).toHaveLength(0);
      await capture("connected");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      const alerts = await settledTray(page, "alerts");
      await expect(page.locator("#alerts-panel .sheet-build")).toBeHidden();
      await capture("alerts");
      expect(await record(page)).toEqual({ version: 1, step: "alerts", updatedAt: "2026-08-21T12:10:00.000Z" });
      await page.evaluate(async () => navigator.serviceWorker.ready);
      await page.reload();
      await settledTray(page, "alerts");
      await capture("resumed-alerts");
      await expect(page.locator("#notify")).toHaveCount(1);
      await expect(page.locator("#notify")).toHaveAttribute("data-state", "idle");
      expect(await permissionRequests(page)).toBe(0);
      await page.locator("#notify").click();
      await expect(page.locator("#notify")).toHaveAttribute("data-state", "enabled");
      expect(await permissionRequests(page)).toBe(1);
      await page.locator("#alert-detail").click();
      await expect(page.locator("#tray")).toHaveAttribute("data-panel", "detail");
      await page.keyboard.press("Escape");
      await settledTray(page, "alerts");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      const modes = await settledTray(page, "modes");
      await capture("modes");
      await expect(page.locator(".first-run-mode h3")).toHaveText(["View", "Control"]);
      const heights = { connected, alerts, modes };
      for (const [a, b] of [[connected, alerts], [alerts, modes], [connected, modes]]) expect(Math.abs(a! - b!)).toBeGreaterThanOrEqual(24);
      const targets = await page.locator('.tray-panel:not([inert]) button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
      expect(targets.every(height => height >= 48)).toBe(true);
      await page.getByRole("button", { name: "Back to Background alerts", exact: true }).click();
      await settledTray(page, "alerts");
      expect(await record(page)).toMatchObject({ step: "alerts" });
      await page.getByRole("button", { name: "Not now", exact: true }).click();
      await settledTray(page, "modes");
      await page.locator("#tray").evaluate(element => (element as HTMLDialogElement).requestClose());
      await settledTray(page, "alerts");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await settledTray(page, "modes");
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.locator("#tray")).toBeHidden();
      expect(await record(page)).toMatchObject({ step: "done" });
      await page.locator("#settings").click();
      await expect(page.locator("#tray")).toHaveAttribute("data-panel", "alerts");
      await expect(page.locator("#alerts-panel .sheet-build")).toBeVisible();
      await expect(page.locator("#alerts-panel .sheet-build")).toContainText("Community project · not affiliated with OMP · build");
      await expect(page.locator("#notify")).toHaveCount(1);
      await expect(page.locator("#notify")).toHaveAttribute("data-state", "enabled");
      await page.locator("#notify").click();
      await expect(page.locator("#notify")).toHaveAttribute("data-state", "idle");
      await page.keyboard.press("Escape");
      await page.reload();
      await expect(page.locator(".queue-hero")).toBeVisible();
      await expect(page.locator("#tray")).toBeHidden();

      // A single state change consumes one arrival; slow the real CSS timelines for a mid-frame capture.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Animation.enable");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
      fixture.upsert(GATEWAY_WORKING);
      await expect(page.locator(".all-clear-summary")).toHaveAttribute("data-arrived", "true");
      await page.waitForFunction(() => document.getAnimations().some(animation => animation instanceof CSSAnimation && animation.animationName === "all-clear-ring" && Number(animation.currentTime) >= 100 && Number(animation.currentTime) < 400));
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
      await capture("all-clear-mid-arrival");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
      await expect.poll(async () => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
      fixture.upsert({ ...GATEWAY_WORKING, lastSeenAt: "2026-08-21T12:10:01.000Z" });
      await expect(page.locator(".all-clear-summary")).not.toHaveAttribute("data-arrived", "true");
      await page.reload();
      await expect(page.locator(".all-clear-summary")).toBeVisible();
      await expect(page.locator(".all-clear-summary")).not.toHaveAttribute("data-arrived", "true");

      fixture.upsert(GATEWAY_WAITING);
      await page.locator(".action-request").click();
      await expect(page.locator(".sh-ask-send")).toBeEnabled();
      await page.locator(".tray-expand").click();
      await expect(page).toHaveURL(`${fixture.origin}/client/`);
      await expect(page.locator("#tray")).toBeHidden();
      await page.locator(".sh-ask-send").click();
      await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(0);
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
      fixture.upsert(GATEWAY_WORKING);
      await expect(page.locator('.triage-bar[data-kind="clear"]')).toContainText("Answered — all clear");
      await page.waitForFunction(() => document.getAnimations().some(animation => animation instanceof CSSAnimation && animation.animationName === "all-clear-check" && Number(animation.currentTime) >= 100 && Number(animation.currentTime) < 300));
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
      await capture("triage-check-mid-arrival");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
      await page.locator(".shell-back").click();
      // The cached directory still showed the queue: clearance while away gets its one arrival.
      await expect(page.locator(".all-clear-summary")).toHaveAttribute("data-arrived", "true");
      await assertPrivate(page, fixture);
      if (screenshots !== undefined) await writeFile(join(screenshots, `${viewport.width}x${viewport.height}-heights.json`), JSON.stringify(heights, null, 2));
    } finally { await fixture.stop(); }
  });
}

for (const close of ["skip", "escape", "native"] as const) {
  test(`fresh introduction ${close} writes done and never reopens`, async ({ page }) => {
    const fixture = await startDashboardFixture([], { firstRun: true });
    try {
      await installSilentWebSocket(page);
      await page.goto(fixture.origin);
      await settledTray(page, "connected");
      await expect(page.locator(".first-run-copy")).toContainText("No live sessions are listed yet.");
      if (close === "skip") await page.getByRole("button", { name: "Skip introduction" }).click();
      else if (close === "escape") await page.keyboard.press("Escape");
      else await page.locator("#tray").evaluate(element => (element as HTMLDialogElement).requestClose());
      await expect(page.locator("#tray")).toBeHidden();
      expect(await record(page)).toMatchObject({ version: 1, step: "done" });
      await page.reload();
      await expect(page.locator("#empty-state")).toBeVisible();
      await expect(page.locator("#tray")).toBeHidden();
      await assertPrivate(page, fixture);
    } finally { await fixture.stop(); }
  });
}

test("corrupt records suppress; modes resume and reduced motion swap instantly", async ({ page }) => {
  const fixture = await startDashboardFixture(INITIAL_SESSIONS, { firstRun: true });
  try {
    await page.goto(fixture.origin);
    await settledTray(page, "connected");
    await page.evaluate(key => localStorage.setItem(key, "{corrupt"), KEY);
    await page.reload();
    await expect(page.locator(".working-row")).toHaveCount(4);
    await expect(page.locator("#tray")).toBeHidden();
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, step: "modes", updatedAt: "2026-10-24T00:00:00.000Z" })), KEY);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await settledTray(page, "modes");
    expect(await page.locator("#tray").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    await page.locator("#tray").evaluate(element => {
      element.addEventListener("cancel", event => {
        const previous = element.getAttribute("data-cancelability");
        element.setAttribute("data-cancelability", `${previous === null ? "" : `${previous},`}${event.cancelable}`);
      });
    });
    await page.keyboard.press("Escape");
    await settledTray(page, "alerts");
    expect(await page.locator("#tray").evaluate(element => element.matches(":modal"))).toBe(true);
    await page.keyboard.press("Escape");
    await settledTray(page, "connected");
    await expect(page.locator("#tray")).toHaveAttribute("data-cancelability", "true,false");
    expect(await page.locator("#tray").evaluate(element => element.matches(":modal"))).toBe(true);
    expect(await record(page)).toBeNull();
    await page.keyboard.press("Escape");
    await expect(page.locator("#tray")).toBeHidden();
    await assertPrivate(page, fixture);
  } finally { await fixture.stop(); }
});

test("a fresh client-route reload never starts the introduction", async ({ page }) => {
  const fixture = await startDashboardFixture(INITIAL_SESSIONS, { firstRun: true });
  try {
    await page.goto(`${fixture.origin}/client/`);
    await expect(page.locator(".working-row")).toHaveCount(4);
    await expect(page.locator("#tray")).toBeHidden();
    expect(await record(page)).toBeNull();
    await assertPrivate(page, fixture);
  } finally { await fixture.stop(); }
});

test("introduction waits for an authoritative visible directory and never replaces another tray", async ({ page }) => {
  const fixture = await startDashboardFixture(INITIAL_SESSIONS, { firstRun: true });
  const { promise, resolve } = Promise.withResolvers<void>();
  try {
    await page.route("**/api/v1/sessions", async route => { await promise; await route.continue(); });
    await page.goto(fixture.origin);
    await expect(page.locator("#status-banner")).toContainText("Loading");
    await expect(page.locator("#tray")).toBeHidden();
    await page.locator("#settings").click();
    resolve();
    await expect(page.locator(".working-row")).toHaveCount(4);
    await expect(page.locator("#tray")).toHaveAttribute("data-panel", "alerts");
    await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
    await page.keyboard.press("Escape");
    await expect(page.locator("#tray")).toBeHidden();
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    await settledTray(page, "connected");
    await assertPrivate(page, fixture);
  } finally { resolve(); await fixture.stop(); }
});
