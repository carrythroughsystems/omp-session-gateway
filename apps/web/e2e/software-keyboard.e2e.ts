import { expect, test, type Page } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, startDashboardFixture } from "./fixture-server.ts";

// A phone software keyboard shrinks the visual viewport without changing the layout viewport, so
// `dvh` units keep reporting the unobstructed height. This inset is a plausible portrait keyboard.
const KEYBOARD_INSET = 320;

interface SoftwareKeyboard {
  __setSoftwareKeyboardInset?: (inset: number) => void;
}

function session(): SessionMetadata {
  return {
    instanceId: "software-keyboard-0001",
    generation: 1,
    title: "Compose a reply while the keyboard is open",
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-09-20T08:00:00.000Z",
    lastSeenAt: "2026-09-20T08:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: true,
    ask: {
      requestId: "software-keyboard-request-0001",
      since: "2026-09-20T08:00:01.000Z",
    },
  };
}

// Headless Chromium never raises a software keyboard, so the platform signal a phone browser does
// emit — a shorter `visualViewport` and its `resize` event — is driven directly.
async function installSoftwareKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let inset = 0;
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      width: { get: (): number => window.innerWidth },
      height: { get: (): number => window.innerHeight - inset },
      offsetTop: { get: (): number => 0 },
      offsetLeft: { get: (): number => 0 },
      pageTop: { get: (): number => 0 },
      pageLeft: { get: (): number => 0 },
      scale: { get: (): number => 1 },
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
    (globalThis as typeof globalThis & SoftwareKeyboard).__setSoftwareKeyboardInset = (
      next: number,
    ): void => {
      inset = next;
      viewport.dispatchEvent(new Event("resize"));
    };
  });
}

function setKeyboardInset(page: Page, inset: number): Promise<void> {
  return page.evaluate(next => {
    const show = (globalThis as typeof globalThis & SoftwareKeyboard).__setSoftwareKeyboardInset;
    if (show === undefined) throw new Error("missing software keyboard harness");
    show(next);
  }, inset);
}

function visualViewportHeight(page: Page): Promise<number> {
  return page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
}

test("an open software keyboard cannot cover the composer", { tag: "@core" }, async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);

  try {
    await installSilentWebSocket(page);
    await installSoftwareKeyboard(page);
    await page.goto(fixture.origin);

    await page.getByRole("button", { name: "Open request" }).click();
    await page.locator(".tray-expand").click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    const composer = page.locator(".sh-composer-input");
    await expect(composer).toBeVisible();

    const unobstructed = await visualViewportHeight(page);
    const restingShell = await page.locator(".gateway-shell").boundingBox();
    expect(restingShell?.height).toBeCloseTo(unobstructed, 0);

    await setKeyboardInset(page, KEYBOARD_INSET);
    const obstructed = await visualViewportHeight(page);
    expect(obstructed).toBe(unobstructed - KEYBOARD_INSET);

    const raisedShell = await page.locator(".gateway-shell").boundingBox();
    expect(raisedShell?.height).toBeCloseTo(obstructed, 0);

    const raisedComposer = await composer.boundingBox();
    if (raisedComposer === null) throw new Error("the composer input is not laid out");
    expect(raisedComposer.height).toBeGreaterThan(0);
    expect(raisedComposer.y + raisedComposer.height).toBeLessThanOrEqual(obstructed);

    // Dismissing the keyboard has to give the transcript its height back.
    await setKeyboardInset(page, 0);
    const settledShell = await page.locator(".gateway-shell").boundingBox();
    expect(settledShell?.height).toBeCloseTo(unobstructed, 0);
  } finally {
    await fixture.stop();
  }
});

// iOS Safari zooms into a text field smaller than 16px when it takes focus, and stays zoomed. Every
// touch screen needs that size, not just a portrait phone: an iPad or a phone turned to landscape
// is wider than the client's phone breakpoint.
test("the composer is large enough to focus without zooming in either orientation", async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);

    await page.getByRole("button", { name: "Open request" }).click();
    await page.locator(".tray-expand").click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    const composer = page.locator(".sh-composer-input");
    await expect(composer).toBeVisible();

    const portrait = page.viewportSize();
    if (portrait === null) throw new Error("the project sets no viewport");
    for (const viewport of [portrait, { width: portrait.height, height: portrait.width }]) {
      await page.setViewportSize(viewport);
      await expect(composer, `${viewport.width}px wide`).toHaveCSS("font-size", "16px");
    }
  } finally {
    await fixture.stop();
  }
});
