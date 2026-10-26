import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { relaySocketCount, startDashboardFixture, type DashboardFixture } from "./fixture-server";
import { GATEWAY_WAITING, GATEWAY_WORKING, INITIAL_SESSIONS, RELEASE_WAITING, installSyntheticProductFixture } from "./synthetic-product-fixture";

async function assertPrivate(page: Page, fixture: DashboardFixture): Promise<void> {
  const residue = await page.evaluate(async () => ({
    html: document.documentElement.outerHTML,
    history: history.state,
    local: { ...localStorage }, session: { ...sessionStorage },
    caches: await Promise.all((await caches.keys()).map(async name => {
      const cache = await caches.open(name);
      return Promise.all((await cache.keys()).map(async request => ({ url: request.url, body: await (await cache.match(request))?.text() })));
    })),
  }));
  fixture.assertNoCapabilityMaterial(JSON.stringify(residue));
}

for (const viewport of [{ width: 412, height: 915 }, { width: 1280, height: 800 }]) {
  test(`one tray anatomy and request promotion at ${viewport.width}x${viewport.height}`, async ({ page, context }, info) => {
    test.skip(!info.project.name.startsWith("pixel"), "Pixel lane owns tray qualification");
    await page.setViewportSize(viewport);
    const key = randomBytes(32);
    const fixture = await startDashboardFixture([GATEWAY_WAITING, ...INITIAL_SESSIONS.slice(1)], { roomKey: key });
    const heights: Record<string, number> = {};
    const directory = process.env.OMP_TRAY_SCREENSHOTS;
    const capture = async (name: string): Promise<void> => {
      await assertPrivate(page, fixture);
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.waitForFunction(() => (document.querySelector("#tray")?.getAnimations().length ?? 0) === 0);
      const height = await page.evaluate(() => document.querySelector("#tray[open]")?.getBoundingClientRect().height);
      if (height !== undefined) heights[name] = height;
      if (directory !== undefined) {
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: join(directory, `${viewport.width}x${viewport.height}-${name}.png`), animations: "disabled" });
      }
    };
    try {
      await installSyntheticProductFixture(context, key, { answerRequests: true, randomSeed: 42 });
      await page.goto(fixture.origin);
      await page.evaluate(async () => navigator.serviceWorker.ready);
      await page.reload();
      await page.locator("#settings").click();
      const tray = page.locator("#tray");
      await expect(tray).toHaveAttribute("data-panel", "alerts");
      await expect(tray.locator("h2")).toBeFocused();
      expect(await tray.evaluate(element => element.matches(":modal"))).toBe(true);
      const historyLength = await page.evaluate(() => history.length);
      await page.locator("#notify").click();
      await expect(page.locator("#notify")).toHaveAttribute("data-state", "enabled");
      await capture("background-alerts");
      await page.locator("#alert-detail").click();
      await expect(tray).toHaveAttribute("data-panel", "detail");
      await expect(tray.locator('[data-panel="detail"] h2')).toBeFocused();
      expect(await tray.locator('[data-panel="alerts"]').evaluate(element => (element as HTMLElement).inert && element.getAttribute("aria-hidden") === "true")).toBe(true);
      await expect.poll(async () => tray.evaluate(element => element.getAnimations().length)).toBe(0);
      await capture("alert-detail");
      expect(await tray.locator('[data-panel="detail"] .tray-body').evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(heights["alert-detail"]! - heights["background-alerts"]!)).toBeGreaterThanOrEqual(24);
      const targets = await tray.locator('.tray-panel:not([inert]) button, .detail-option').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
      expect(targets.every(height => height >= 48)).toBe(true);
      expect(await tray.locator('[data-panel="detail"]').evaluate(element => parseFloat(getComputedStyle(element).paddingBottom))).toBeGreaterThanOrEqual(16);
      await page.keyboard.press("Escape");
      await expect(tray).toHaveAttribute("data-panel", "alerts");
      await expect(tray.locator('[data-panel="alerts"] h2')).toBeFocused();
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      await page.locator("#alert-detail").click();
      await page.getByRole("button", { name: "Back to Background alerts", exact: true }).click();
      await expect(tray.locator('[data-panel="alerts"] h2')).toBeFocused();
      await page.locator("#alert-detail").click();
      await page.locator('input[value="private"]').check();
      await expect(page.locator("#alert-detail")).toContainText("Private");
      await page.keyboard.press("Escape");
      await expect(tray).toBeHidden();
      await expect(page.locator("#settings")).toBeFocused();
      await page.locator("#settings").click();
      await page.mouse.click(2, 2);
      await expect(tray).toBeHidden();
      await page.locator("#settings").click();
      await expect.poll(async () => tray.evaluate(element => element.getAnimations().length)).toBe(0);
      const grip = await tray.locator(".tray-grip").boundingBox();
      if (grip === null) throw new Error("missing tray grip");
      await page.mouse.move(grip.x + grip.width / 2, grip.y + 12);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + 125, { steps: 6 });
      await page.mouse.up();
      await expect(tray).toBeHidden();

      await page.getByRole("button", { name: "Options", exact: true }).click();
      await capture("this-request");
      await page.getByRole("button", { name: "Hold for desk", exact: true }).click();
      await expect(page.locator(".held-row")).toHaveCount(1);
      await page.locator(".held-requeue").click();
      await page.getByRole("button", { name: "Options", exact: true }).click();
      await page.getByRole("button", { name: "View transcript", exact: true }).click();
      await expect(page).toHaveURL(`${fixture.origin}/client/`);
      await page.locator(".shell-back").click();
      await expect(page.locator(".queue-hero")).toBeVisible();
      await expect(page.locator(".hero-options")).toHaveCSS("min-height", "48px");
      await expect(page.locator(".hero-options")).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
      expect(await page.locator(".hero-options").evaluate(element => element.getBoundingClientRect().width))
        .toBeLessThan(await page.locator(".action-request").evaluate(element => element.getBoundingClientRect().width));

      await page.locator(".dismiss-session").first().click();
      await expect(tray).toHaveAttribute("role", "status");
      expect(await tray.evaluate(element => element.matches(":modal"))).toBe(false);
      await capture("undo");
      expect(heights.undo).toBeGreaterThanOrEqual(88);
      expect(heights.undo).toBeLessThanOrEqual(96);
      await expect(tray.locator("h2, .tray-header")).toHaveCount(0);
      await expect(tray.locator(".tray-grip")).toBeHidden();
      await expect(tray.locator(".session-tile")).toHaveCount(1);
      await expect(tray.locator(".undo-label")).toHaveText("Hidden on this device");
      await expect(tray).not.toContainText("5s");
      await expect(page.locator("#undo-dismissal")).toHaveCSS("min-height", "48px");
      await page.locator("#undo-dismissal").click();
      await expect(tray).toBeHidden();

      const { promise: gate, resolve: releaseLaunch } = Promise.withResolvers<void>();
      await page.route("**/launch", async route => { await gate; await route.continue(); });
      await page.locator(".action-request").click();
      await expect(tray).toBeVisible();
      await expect(tray.locator(".request-status")).toHaveText("Connecting…");
      await expect(tray.locator(".tray-header h2")).toHaveText("Gateway auth hardening");
      await expect(tray.locator(".tray-header .session-tile")).toHaveCount(1);
      await expect(tray.locator(".request-preview h3, .request-preview .session-tile")).toHaveCount(0);
      await capture("request-connecting");
      releaseLaunch();
      await expect(tray.locator("#root .sh-app")).toHaveCount(1);
      await expect(page.locator("body")).toHaveCSS("background-color", "rgb(6, 8, 9)");
      await expect(page.locator("body")).toHaveCSS("font-size", "16px");
      await expect(page.locator(".sh-ask-send")).toBeEnabled();
      await expect.poll(async () => tray.evaluate(element => element.getAnimations().length)).toBe(0);
      await capture("request-mounted");
      const header = tray.locator('.tray-panel:not([inert]) .tray-header');
      await expect(header.locator("h2")).toHaveText("Gateway auth hardening");
      await expect(header.locator("h2")).toHaveCSS("text-overflow", "ellipsis");
      await expect(tray).toHaveAttribute("aria-labelledby", (await header.locator("h2").getAttribute("id"))!);
      await expect(header.getByRole("button", { name: "Close Gateway auth hardening", exact: true })).toBeVisible();
      await expect(header.getByRole("button", { name: "Expand to full screen", exact: true }).locator("svg")).toHaveCount(1);
      await expect(tray.locator(".shell-bar")).toHaveCSS("display", "none");
      await expect(tray.locator(".sh-panel")).toHaveCSS("border-radius", "0px");
      await expect(tray.locator(".sh-panel")).toHaveCSS("border-left-width", "0px");
      await expect(tray.locator(".sh-main")).toHaveCSS("padding", "0px");
      const frame = await tray.locator(".sh-panel").boundingBox();
      const shell = await tray.locator(".gateway-shell").boundingBox();
      expect(Math.abs(frame!.width - shell!.width)).toBeLessThanOrEqual(1);
      expect((await tray.locator(".triage-bar").boundingBox())!.height).toBeLessThan(100);
      const headerCenters = await header.locator(":scope > *").evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect();
        return box.y + box.height / 2;
      }));
      expect(headerCenters).toHaveLength(5);
      expect(Math.max(...headerCenters) - Math.min(...headerCenters)).toBeLessThanOrEqual(1);
      const connection = await header.locator(".conn-chip").elementHandle();
      await page.locator(".sh-ask-send").click();
      await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(0);
      fixture.upsert(GATEWAY_WORKING);
      await page.locator(".sh-composer-input").fill("Draft retained through expansion");
      const root = await page.locator("#root").elementHandle();
      const sockets = await relaySocketCount(page);
      const launches = fixture.launchRequests.length;
      const cdp = await context.newCDPSession(page);
      await cdp.send("Animation.enable");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
      await page.locator(".tray-expand").click();
      if (directory !== undefined) {
        await assertPrivate(page, fixture);
        await page.screenshot({ path: join(directory, `${viewport.width}x${viewport.height}-request-mid-growth.png`) });
      }
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
      await expect(page).toHaveURL(`${fixture.origin}/client/`);
      expect(await root!.evaluate(element => element === document.querySelector("body > .gateway-shell > #root"))).toBe(true);
      expect(await connection!.evaluate(element => element === document.querySelector(".shell-bar .conn-chip"))).toBe(true);
      await expect(page.locator(".shell-bar")).toBeVisible();
      await expect(page.locator(".sh-panel")).not.toHaveCSS("border-radius", "0px");
      expect(await relaySocketCount(page)).toBe(sockets);
      expect(fixture.launchRequests).toHaveLength(launches);
      await expect(page.locator(".sh-composer-input")).toHaveValue("Draft retained through expansion");
      await capture("request-promoted");
      // Promotion leaves the same history shape as a full launch: system back returns to the directory.
      await page.goBack();
      await expect(page).toHaveURL(`${fixture.origin}/`);
      await expect(page.locator("#session-list")).toBeVisible();
      await expect(page.locator("#root")).toHaveCount(0);
      await expect(page.locator("body > .gateway-shell")).toHaveCount(0);

      await page.clock.install();
      await expect(page.locator("#status-banner")).toBeHidden();
      await page.route("**/api/v1/sessions", route => route.abort("connectionrefused"));
      await page.route("**/api/v1/events", route => route.abort("connectionrefused"));
      fixture.disconnectEvents();
      await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "tailnet");
      await page.clock.fastForward(46_000);
      await page.getByRole("button", { name: "Troubleshooting", exact: true }).click();
      await capture("troubleshooting");
      if (directory !== undefined) await writeFile(join(directory, `${viewport.width}x${viewport.height}-heights.json`), JSON.stringify(heights, null, 2));
    } finally { await fixture.stop(); }
  });
}

test("transient expiry pauses for pointer and focus, and cannot close a replacement tray", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([...INITIAL_SESSIONS], { roomKey: key });
  try {
    await installSyntheticProductFixture(context, key);
    await page.goto(fixture.origin);
    await page.clock.install();
    await page.locator(".dismiss-session").first().click();
    await page.locator("#tray").hover();
    await page.clock.fastForward(6_000);
    await expect(page.locator("#tray")).toBeVisible();
    await page.locator("#undo-dismissal").focus();
    await page.mouse.move(1, 1);
    await page.clock.fastForward(6_000);
    await expect(page.locator("#tray")).toBeVisible();
    await page.locator("#settings").focus();
    await page.clock.fastForward(5_500);
    await expect(page.locator("#tray")).toBeHidden();
    await expect(page.locator(".dismissed-control")).toBeVisible();
    await page.locator(".dismiss-session").first().click();
    await page.locator("#settings").click();
    await page.clock.fastForward(6_000);
    await expect(page.locator("#tray")).toHaveAttribute("data-panel", "alerts");
  } finally { await fixture.stop(); }
});

test("request close cancels late launch; failed preview returns to the directory; bfcache preserves tray presentation", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
  try {
    await installSyntheticProductFixture(context, key);
    await page.goto(fixture.origin);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    await page.route("**/launch", async route => { await held; await route.continue().catch(() => undefined); });
    await page.locator(".action-request").click();
    await page.locator("#tray").evaluate(element => (element as HTMLDialogElement).requestClose());
    await expect(page.locator("#tray")).toBeHidden();
    release();
    await page.unroute("**/launch");
    await expect(page.locator("#root")).toHaveCount(0);
    await page.route("**/launch", route => route.fulfill({ status: 503, body: "{}" }));
    await page.locator(".action-request").click();
    await expect(page.locator("#tray")).toBeHidden();
    await expect(page.locator("#status-banner")).toHaveText("The session could not be opened. Try again.");
    await page.unroute("**/launch");
    await page.locator(".action-request").click();
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await expect(page.locator("#root .sh-app")).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await assertPrivate(page, fixture);
    await page.getByRole("button", { name: "Close Gateway auth hardening", exact: true }).click();
    await expect(page.locator("#root")).toHaveCount(0);
  } finally { await fixture.stop(); }
});

test("reduced motion swaps and promotes instantly", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
  try {
    await installSyntheticProductFixture(context, key);
    await page.goto(fixture.origin);
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.locator("#settings").click();
    await page.locator("#notify").click();
    await expect(page.locator("#alert-detail")).toBeVisible();
    await page.locator("#alert-detail").click();
    expect(await page.locator("#tray").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    await expect(page.locator(".tray-panel-out")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator(".action-request").click();
    await page.locator('#tray .tray-panel:not([inert]) .tray-header h2').click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator("#tray")).toHaveCount(0);
  } finally { await fixture.stop(); }
});

test("growth cancellation and pagehide never promote a disposed shell", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
  try {
    await installSyntheticProductFixture(context, key);
    await page.goto(fixture.origin);
    await page.locator(".action-request").click();
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    await page.locator(".tray-expand").evaluate(element => {
      (element as HTMLButtonElement).click();
      (document.querySelector("#tray") as HTMLDialogElement).requestClose();
    });
    await expect(page.locator("#root")).toHaveCount(0);
    await expect(page.locator("#session-list")).toBeVisible();
    await page.locator(".action-request").click();
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    await page.locator(".tray-expand").evaluate(element => {
      (element as HTMLButtonElement).click();
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    });
    await expect(page.locator("#root .sh-app")).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(page.locator('#tray[data-layout="expanded"] #root .sh-app')).toHaveCount(1);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await assertPrivate(page, fixture);
  } finally { await fixture.stop(); }
});

test("withdrawn request access returns to the directory and a recovered client remains keyboard-usable", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
  try {
    await installSyntheticProductFixture(context, key, { answerRequests: true });
    await page.goto(fixture.origin);
    await page.route("**/launch", route => route.fulfill({ status: 403, body: "{}" }));
    await page.locator(".action-request").click();
    await expect(page.locator("#status-banner")).toHaveText("This tailnet identity is not authorized.");
    await expect(page.locator("#tray")).toBeHidden();
    await expect(page.locator(".action-request")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
    await expect(page.locator("#root")).toHaveCount(0);
    await page.unroute("**/launch");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#status-banner")).toBeHidden();
    await page.locator(".action-request").click();
    await page.locator(".sh-ask-send").click();
    await expect(page.locator(".sh-composer-input")).toBeVisible();
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, "height", { configurable: true, value: 460 });
      viewport.dispatchEvent(new Event("resize"));
    });
    await expect.poll(() => page.locator("#tray").evaluate(element => element.getAnimations().length)).toBe(0);
    const fit = await page.evaluate(() => {
      const tray = document.querySelector("#tray")!.getBoundingClientRect();
      const input = document.querySelector(".sh-composer-input")!.getBoundingClientRect();
      return { bottom: tray.bottom, inputBottom: input.bottom, top: input.top, trayTop: tray.top };
    });
    expect(fit.bottom).toBeLessThanOrEqual(460);
    expect(fit.inputBottom).toBeLessThanOrEqual(fit.bottom);
    expect(fit.top).toBeGreaterThanOrEqual(fit.trayTop);
    await page.locator(".sh-composer-input").fill("Keyboard-safe draft");
    await assertPrivate(page, fixture);
  } finally { await fixture.stop(); }
});

test("request lifecycle: a delayed successor inherits the promoted shell", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WAITING, RELEASE_WAITING], { roomKey: key });
  const intercepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await installSyntheticProductFixture(context, key);
    await page.goto(fixture.origin);
    await page.locator(".action-request").click();
    await expect(page.locator(".triage-action")).toHaveText("Hold → next");
    const previousSocket = await page.evaluateHandle(() =>
      (globalThis as typeof globalThis & { __ompSyntheticSocket: { readyState: number } }).__ompSyntheticSocket);
    await page.route(`**/sessions/${RELEASE_WAITING.instanceId}/launch`, async route => {
      const response = await route.fetch();
      intercepted.resolve();
      await release.promise;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await page.locator(".triage-action").click();
    await intercepted.promise;
    await page.getByRole("button", { name: "Expand to full screen", exact: true }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    release.resolve();
    await expect.poll(() => relaySocketCount(page)).toBe(2);
    await expect(page.locator("body > .gateway-shell > #root .sh-app")).toHaveCount(1);
    await expect(page.locator(".shell-title")).toHaveText("Release qualification");
    await expect(page.locator("#tray[open]")).toHaveCount(0);
    expect(await previousSocket.evaluate(socket => socket.readyState)).toBe(3);
    expect(await page.evaluate(() =>
      (globalThis as typeof globalThis & { __ompSyntheticSocket: { readyState: number } }).__ompSyntheticSocket.readyState)).toBe(1);
    await assertPrivate(page, fixture);
    await page.goBack();
    await expect(page.locator("#session-list")).toBeVisible();
    await expect(page.locator("#root")).toHaveCount(0);
  } finally { release.resolve(); await page.close(); await fixture.stop(); }
});

test("request lifecycle: replacing a growing request permits another promotion", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WAITING, RELEASE_WAITING], { roomKey: key });
  const intercepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await installSyntheticProductFixture(context, key);
    await page.goto(fixture.origin);
    await page.locator(".action-request").click();
    await expect(page.locator(".triage-action")).toHaveText("Hold → next");
    await expect.poll(() => page.locator("#tray").evaluate(element => element.getAnimations().length)).toBe(0);
    const historyLength = await page.evaluate(() => history.length);
    await page.clock.install();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
    await page.route(`**/sessions/${RELEASE_WAITING.instanceId}/launch`, async route => {
      const response = await route.fetch();
      intercepted.resolve();
      await release.promise;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await page.locator(".triage-action").click();
    await intercepted.promise;
    await page.locator(".tray-expand").evaluate(element => (element as HTMLButtonElement).click());
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "full");
    release.resolve();
    await expect(page.locator('#tray .tray-panel:not([inert]) h2')).toHaveText("Release qualification");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    await page.clock.runFor(500);
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    const replacementRoot = await page.locator("#root").elementHandle();
    await page.getByRole("button", { name: "Expand to full screen", exact: true }).click();
    await page.clock.runFor(500);
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    expect(await replacementRoot!.evaluate(element => element === document.querySelector("body > .gateway-shell > #root"))).toBe(true);
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
    expect(await page.evaluate(() => history.state)).toEqual({ ompCollab: true });
    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator("#session-list")).toBeVisible();
    await assertPrivate(page, fixture);
  } finally { release.resolve(); await page.close(); await fixture.stop(); }
});

test("request lifecycle: snapshot withdrawal cancels a compact request", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
  const intercepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  try {
    await installSyntheticProductFixture(context, key);
    await page.goto(fixture.origin);
    await page.route("**/launch", async route => {
      const response = await route.fetch();
      intercepted.resolve();
      await release.promise;
      await route.fulfill({ response }).catch(() => undefined);
      delivered.resolve();
    });
    await page.locator(".action-request").click();
    await intercepted.promise;
    await expect(page.locator(".request-status")).toHaveText("Connecting…");
    fixture.setListFailure("forbidden");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "unauthorized");
    await expect(page.locator("#tray")).toBeHidden();
    await expect(page.locator("#status-banner")).toHaveText("This tailnet identity is not authorized.");
    await page.locator("#settings").click();
    await expect(page.locator("#tray")).toHaveAttribute("data-panel", "alerts");
    release.resolve();
    await delivered.promise;
    await expect(page.locator("#root")).toHaveCount(0);
    expect(await relaySocketCount(page)).toBe(0);
    await expect(page.locator("#tray")).toHaveAttribute("data-panel", "alerts");
    await assertPrivate(page, fixture);
  } finally { release.resolve(); await page.close(); await fixture.stop(); }
});

test("request lifecycle: delayed bfcache resume yields to a foreground launch", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  const key = randomBytes(32);
  const working = { ...GATEWAY_WORKING, instanceId: "foreground-choice-0001", title: "Foreground choice" };
  const home = await startDashboardFixture([GATEWAY_WAITING, working], { roomKey: key });
  const away = await startDashboardFixture([INITIAL_SESSIONS[1]!], { roomKey: key });
  home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], []);
  away.configureFleet("Away", [], [home.origin]);
  const intercepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const hiddenRemoteCount = () => page.evaluate(() => {
    const records: unknown = JSON.parse(localStorage.getItem("omp.sessions.dismissed.v2") ?? "[]");
    return Array.isArray(records) ? records.length : 0;
  });
  try {
    await installSyntheticProductFixture(context, key);
    await page.goto(home.origin);
    await expect(page.locator(".working-row")).toHaveCount(2);
    // A real remote Hide is reconciled only when that source's authoritative snapshot applies.
    await page.getByRole("button", { name: `Hide ${INITIAL_SESSIONS[1]!.title} on this device`, exact: true }).click();
    await expect.poll(hiddenRemoteCount).toBe(1);
    await page.locator(".action-request").click();
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await expect(page.locator("#root .sh-app")).toHaveCount(0);
    await page.route(`${away.origin}/api/v1/sessions`, async route => {
      const response = await route.fetch();
      intercepted.resolve();
      await release.promise;
      await route.fulfill({ response }).catch(() => undefined);
    });
    // The resumed local snapshot must be applied, not merely received. Keep the remote held
    // while observing this row transition, so the foreground intent still races its continuation.
    home.upsert({ ...working, title: "Foreground choice refreshed" });
    away.upsert({ ...INITIAL_SESSIONS[1]!, generation: INITIAL_SESSIONS[1]!.generation + 1 });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await intercepted.promise;
    await expect(page.getByRole("button", { name: "View Foreground choice refreshed", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View Foreground choice refreshed", exact: true }).click();
    await expect(page.locator("body > .gateway-shell .shell-title")).toHaveText("Foreground choice refreshed");
    const foregroundRoot = await page.locator("#root").elementHandle();
    expect(await hiddenRemoteCount()).toBe(1);
    release.resolve();
    // The mounted shell intentionally does not render directory rows. Observe the app's
    // generation reconciliation instead, not response completion or a fixed frame count.
    await expect.poll(hiddenRemoteCount).toBe(0);
    expect(home.launchRequests.map(request => request.instanceId)).toEqual([GATEWAY_WAITING.instanceId, working.instanceId]);
    await expect(page.locator("body > .gateway-shell .shell-title")).toHaveText("Foreground choice refreshed");
    expect(await foregroundRoot!.evaluate(element => element === document.querySelector("#root"))).toBe(true);
    expect(await relaySocketCount(page)).toBe(2);
    await assertPrivate(page, home);
    await assertPrivate(page, away);
  } finally { release.resolve(); await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

test("request lifecycle: keyboard close restores request focus across row refresh", async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith("pixel"));
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WAITING], { roomKey: key });
  try {
    await installSyntheticProductFixture(context, key);
    await page.goto(fixture.origin);
    await page.locator(".action-request").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    fixture.upsert({ ...GATEWAY_WAITING, model: "fixture/focus-restored" });
    await page.keyboard.press("Escape");
    await expect(page.locator("#tray")).toBeHidden();
    await expect(page.locator(".queue-hero")).toContainText("focus-restored");
    await expect(page.locator(".action-request")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#tray #root .sh-app")).toHaveCount(1);
    fixture.remove(GATEWAY_WAITING.instanceId, GATEWAY_WAITING.generation);
    await page.keyboard.press("Escape");
    await expect(page.locator("#root")).toHaveCount(0);
    await expect(page.locator(".action-request")).toHaveCount(0);
    await expect(page.locator("#directory-title")).toBeFocused();
    await expect(page.locator("#directory-title")).toHaveCSS("outline-style", "none");
    await assertPrivate(page, fixture);
  } finally { await page.close(); await fixture.stop(); }
});
