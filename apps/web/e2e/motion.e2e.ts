import { expect, test, type Page } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, relaySocketCount, startDashboardFixture } from "./fixture-server.ts";

function working(instanceId: string, startedAt: string, busy = true): SessionMetadata {
  return {
    instanceId,
    generation: 1,
    title: `\u{F04E6} ${instanceId}`,
    cwdLabel: "project",
    model: "provider/model",
    startedAt,
    lastSeenAt: "2026-10-20T08:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
    busy,
  };
}

const FIRST = working("motion-session-0001", "2026-10-20T08:00:00.000Z");
const SECOND = working("motion-session-0002", "2026-10-20T07:00:00.000Z");

/** Records every typed view transition the app starts, without changing what the browser does. */
async function spyOnTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const native = document.startViewTransition.bind(document);
    const record: string[][] = [];
    Object.defineProperty(globalThis, "__ompTransitions", { configurable: true, value: record });
    document.startViewTransition = ((options: unknown) => {
      const types: string[] = [];
      if (typeof options === "object" && options !== null && "types" in options && Array.isArray(options.types)) {
        types.push(...options.types.map(String));
      }
      record.push(types);
      return native(options as never);
    }) as typeof document.startViewTransition;
  });
}

async function transitions(page: Page): Promise<string[][]> {
  return page.evaluate(() => {
    // Installed by `spyOnTransitions`; absent only before the init script ran.
    const record = Reflect.get(globalThis, "__ompTransitions") as string[][] | undefined;
    return record ?? [];
  });
}

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.matches(":active-view-transition"))).toBe(false);
}

// Motion exists only on user-initiated transitions and genuine state changes (ADR-040): the
// directory ↔ session navigation travels with the tapped tile, rows move when a session changes
// group or leaves, and a refresh that only moves `lastSeenAt` never starts a transition.
test("navigation, hide, and group changes animate while routine refreshes do not", { tag: "@core" }, async ({ page }) => {
  const fixture = await startDashboardFixture([FIRST, SECOND]);
  try {
    await installSilentWebSocket(page);
    await spyOnTransitions(page);
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(2);
    expect(await transitions(page)).toEqual([]);

    fixture.upsert({ ...FIRST, lastSeenAt: "2026-10-20T08:05:00.000Z" });
    await expect(page.locator(".working-row")).toHaveCount(2);
    expect(await transitions(page)).toEqual([]);

    fixture.upsert({ ...FIRST, busy: false });
    await expect(page.locator('.working-row .session-tile[data-state="idle"]')).toHaveCount(1);
    await settled(page);
    expect(await transitions(page)).toEqual([["list"]]);
    expect(await page.locator("[style*='view-transition']").count()).toBe(0);

    await page.locator(".working-row").first().click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator(".shell-heading .session-tile .glyph")).toHaveText("\u{F04E6}");
    await settled(page);
    expect(await transitions(page)).toEqual([["list"], ["forward"]]);
    expect(await page.locator("[style*='view-transition']").count()).toBe(0);

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".working-row")).toHaveCount(2);
    await settled(page);
    expect(await transitions(page)).toEqual([["list"], ["forward"], ["back"]]);
    expect(await page.locator("[style*='view-transition']").count()).toBe(0);

    await page.getByRole("button", { name: /^Hide .* on this device$/ }).first().click();
    await expect(page.locator(".working-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".working-row")).toHaveCount(2);
    await settled(page);
    expect(await transitions(page)).toEqual([["list"], ["forward"], ["back"], ["list"], ["list"]]);
    expect(await page.locator("[style*='view-transition']").count()).toBe(0);
  } finally {
    await fixture.stop();
  }
});

test("a delayed forward transition cannot remount a disposed shell", { tag: "@core" }, async ({ page }) => {
  const fixture = await startDashboardFixture([FIRST]);
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await installSilentWebSocket(page);
    await page.addInitScript(() => {
      // Defer only forward commits; directory updates and Back keep their ordinary ordering.
      Object.defineProperty(globalThis, "ViewTransition", {
        configurable: true,
        value: class { get types(): Set<string> { return new Set(); } },
      });
      document.startViewTransition = ((options: { update: () => void; types: string[] }) => {
        const done = Promise.withResolvers<void>();
        const commit = (): void => {
          options.update();
          done.resolve();
        };
        if (options.types.includes("forward")) {
          Reflect.set(globalThis, "__ompDeferredForward", commit);
        } else commit();
        return {
          ready: done.promise, finished: done.promise, updateCallbackDone: done.promise,
          types: new Set(options.types), skipTransition(): void {},
        };
      }) as typeof document.startViewTransition;
    });
    await page.goto(fixture.origin);
    await page.locator(".working-row").click();
    await expect.poll(() => relaySocketCount(page)).toBe(1);
    await expect.poll(() => page.evaluate(() => typeof Reflect.get(globalThis, "__ompDeferredForward"))).toBe("function");
    await expect(page.locator(".gateway-shell")).toHaveCount(0);

    fixture.setListFailure("forbidden");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "unauthorized");
    await expect(page.locator("#directory-title")).toBeVisible();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await page.evaluate(() => {
      const commit = Reflect.get(globalThis, "__ompDeferredForward") as () => void;
      Reflect.deleteProperty(globalThis, "__ompDeferredForward");
      commit();
    });
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    await expect(page.locator("#directory-title")).toBeVisible();
    await expect(page.locator("#empty-state")).toBeVisible();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    expect(await page.evaluate(() => history.state.ompDirectory.version)).toBe(2);
    expect(fixture.launchRequests).toHaveLength(1);

    // The restored directory still opens normally, with the full-launch Back history shape.
    fixture.setListFailure(undefined);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.locator(".working-row").click();
    await expect.poll(() => relaySocketCount(page)).toBe(2);
    await page.evaluate(() => (Reflect.get(globalThis, "__ompDeferredForward") as () => void)());
    await expect(page.locator(".gateway-shell")).toBeVisible();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    expect(await page.evaluate(() => history.state)).toEqual({ ompCollab: true });
    await page.goBack();
    await expect(page.locator("#directory-title")).toBeVisible();
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    expect(await page.evaluate(() => history.state.ompDirectory.version)).toBe(2);
  } finally {
    await fixture.stop();
  }
});

test("reduced motion renders every change without a view transition", { tag: "@core" }, async ({ browser }) => {
  const fixture = await startDashboardFixture([FIRST, SECOND]);
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  try {
    await installSilentWebSocket(page);
    await spyOnTransitions(page);
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(2);
    fixture.upsert({ ...FIRST, busy: false });
    await expect(page.locator('.working-row .session-tile[data-state="idle"]')).toHaveCount(1);
    await page.locator(".working-row").first().click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await page.goBack();
    await expect(page.locator(".working-row")).toHaveCount(2);
    await page.getByRole("button", { name: /^Hide .* on this device$/ }).first().click();
    await expect(page.locator(".working-row")).toHaveCount(1);
    expect(await transitions(page)).toEqual([]);
  } finally {
    await page.close();
    await context.close();
    await fixture.stop();
  }
});
