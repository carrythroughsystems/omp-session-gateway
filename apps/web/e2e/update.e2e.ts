import { expect, type Page, type Route, test } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, startDashboardFixture, type DashboardFixture } from "./fixture-server.ts";

function session(instanceId = "pwa-upgrade-0001", title = "Automatic PWA upgrade"): SessionMetadata {
  return {
    instanceId,
    generation: 1,
    title,
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-25T05:00:00.000Z",
    lastSeenAt: "2026-07-25T05:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
  };
}


async function installLoadCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const prior = Number.parseInt(sessionStorage.getItem("omp-e2e-loads") ?? "0", 10);
    sessionStorage.setItem("omp-e2e-loads", String(prior + 1));
  });
}

async function waitForControlledWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller !== null) return;
    await new Promise<void>(resolve => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  });
}

async function triggerWorkerUpgrade(page: Page, fixture: DashboardFixture): Promise<void> {
  await page.evaluate(async () => {
    await caches.open("omp-sessions-shell-e2e-previous");
  });
  fixture.upgradeServiceWorker();
  try {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
  } catch (error) {
    if (!String(error).includes("Execution context was destroyed")) throw error;
  }
}

/**
 * Upgrades the worker and returns once the new worker has finished its `activate` event and the
 * page's bounded fallback timer has had its chance to fire. Chromium can hold `activate` for about a
 * second after the controller changes, so a shorter wait would observe neither.
 */
async function upgradeThroughActivation(page: Page, fixture: DashboardFixture): Promise<void> {
  await page.evaluate(() => {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      sessionStorage.setItem("omp-e2e-controller-changed-at", String(Date.now()));
    }, { once: true });
  });
  await triggerWorkerUpgrade(page, fixture);
  await expect.poll(
    () => page.evaluate(async () => {
      const changedAt = Number(sessionStorage.getItem("omp-e2e-controller-changed-at") ?? Number.NaN);
      const registration = await navigator.serviceWorker.getRegistration();
      return Date.now() - changedAt > 1_250 &&
        registration?.active?.state === "activated" &&
        registration.installing === null &&
        registration.waiting === null;
    }).catch(() => false),
  ).toBe(true);
}

/** Holds matching requests until released, then settles each with `finish`. */
async function holdRoute(
  page: Page,
  url: string,
  finish: (route: Route) => Promise<void>,
): Promise<{ readonly arrived: Promise<void>; readonly finished: Promise<void>; release(): void }> {
  let release = (): void => undefined;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  let arrive = (): void => undefined;
  const arrived = new Promise<void>(resolve => {
    arrive = resolve;
  });
  let finishOne = (): void => undefined;
  const finished = new Promise<void>(resolve => {
    finishOne = resolve;
  });
  await page.route(url, async route => {
    arrive();
    await released;
    await finish(route).catch(() => undefined);
    finishOne();
  });
  return { arrived, finished, release: () => release() };
}


async function loadCount(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => Number.parseInt(sessionStorage.getItem("omp-e2e-loads") ?? "0", 10));
  } catch {
    return 0;
  }
}

test("an updated PWA activates and reloads an idle directory automatically", { tag: ["@core", "@serviceworker"] }, async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);
  await installLoadCounter(page);

  try {
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(1);
    await waitForControlledWorker(page);
    expect(await loadCount(page)).toBe(1);

    await triggerWorkerUpgrade(page, fixture);

    await expect.poll(() => loadCount(page)).toBe(2);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".working-row")).toHaveCount(1);
  } finally {
    await fixture.stop();
  }
});

test("an updated PWA preserves active collaboration until the user leaves", async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);
  await installLoadCounter(page);
  await installSilentWebSocket(page);

  try {
    await page.goto(fixture.origin);
    await waitForControlledWorker(page);
    await page.getByRole("button", { name: "View Automatic PWA upgrade" }).click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    expect(await loadCount(page)).toBe(1);

    await upgradeThroughActivation(page, fixture);

    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator(".conn-chip")).toBeVisible();
    expect(await loadCount(page)).toBe(1);

    const failedLaunchRoute = "**/api/v1/sessions/pwa-upgrade-0001/launch";
    await page.route(failedLaunchRoute, route =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    await page.locator(".shell-control").click();
    await expect(page.locator(".triage-copy")).toHaveText(
      "This host: The session could not be opened. Try again.",
    );
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => ({
      href: location.href,
      loads: Number.parseInt(sessionStorage.getItem("omp-e2e-loads") ?? "0", 10),
    }))).toEqual({ href: `${fixture.origin}/client/`, loads: 1 });
    await page.unroute(failedLaunchRoute);

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect.poll(() => loadCount(page)).toBe(2);
    await expect(page.locator(".working-row")).toHaveCount(1);
  } finally {
    await fixture.stop();
  }
});

for (const order of ["the failure settles first", "a collaboration mounts first"] as const) {
  test(`an updated PWA never interrupts concurrent launches when ${order}`, async ({ page }) => {
    const failing = session("pwa-upgrade-0002", "Failing launch");
    const fixture = await startDashboardFixture([session(), failing]);
    await installLoadCounter(page);
    await installSilentWebSocket(page);
    const failingLaunch = await holdRoute(page, `**/api/v1/sessions/${failing.instanceId}/launch`, route =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    const viewLaunch = await holdRoute(page, "**/api/v1/sessions/pwa-upgrade-0001/launch", route => route.continue());

    try {
      await page.goto(fixture.origin);
      await expect(page.locator(".working-row")).toHaveCount(2);
      await waitForControlledWorker(page);
      await page.getByRole("button", { name: "View Failing launch" }).click();
      await page.getByRole("button", { name: "View Automatic PWA upgrade" }).click();
      await Promise.all([failingLaunch.arrived, viewLaunch.arrived]);

      await upgradeThroughActivation(page, fixture);
      expect(await loadCount(page)).toBe(1);

      if (order === "the failure settles first") {
        // The superseded failure is discarded; the latest intent still owns the deferred update.
        failingLaunch.release();
        await failingLaunch.finished;
        await expect(page.locator("#status-banner")).not.toContainText("The session could not be opened.");
        await expect(page.locator(".gateway-shell")).toHaveCount(0);
        expect(fixture.launchRequests).toHaveLength(0);
        await page.waitForTimeout(250);
        expect(await loadCount(page)).toBe(1);
        viewLaunch.release();
        await expect(page.locator(".conn-chip")).toBeVisible();
      } else {
        // A late failure must leave the collaboration another launch mounted meanwhile untouched.
        viewLaunch.release();
        await expect(page.locator(".conn-chip")).toBeVisible();
        failingLaunch.release();
        await failingLaunch.finished;
        await page.waitForTimeout(250);
        await expect(page.locator(".conn-chip")).toBeVisible();
        await expect(page.locator("link[data-omp-collab-styles]")).toHaveCount(1);
      }
      await expect(page).toHaveURL(`${fixture.origin}/client/`);
      await expect(page.locator(".shell-title")).toHaveText("Automatic PWA upgrade");
      expect(await loadCount(page)).toBe(1);
      expect(fixture.launchRequests.map(request => request.instanceId)).toEqual(["pwa-upgrade-0001"]);

      await page.goBack();
      await expect(page).toHaveURL(`${fixture.origin}/`);
      await expect.poll(() => loadCount(page)).toBe(2);
      await expect(page.locator(".working-row")).toHaveCount(2);
    } finally {
      failingLaunch.release();
      viewLaunch.release();
      await fixture.stop();
    }
  });
}

test("an updated PWA keeps a routed notification until its snapshot resolves", async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);
  await installLoadCounter(page);
  await installSilentWebSocket(page);

  try {
    await page.goto(fixture.origin);
    await waitForControlledWorker(page);
    const snapshot = await holdRoute(page, "**/api/v1/sessions", route => route.continue());
    await page.goto(`${fixture.origin}/collab/pwa-upgrade-0001?activity=stopped&generation=1`);
    await snapshot.arrived;
    expect(await loadCount(page)).toBe(2);

    await upgradeThroughActivation(page, fixture);
    expect(await loadCount(page)).toBe(2);

    snapshot.release();
    await expect(page.locator(".conn-chip")).toBeVisible();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    expect(fixture.launchRequests).toEqual([{ instanceId: "pwa-upgrade-0001", generation: 1, mode: "view" }]);
    expect(await loadCount(page)).toBe(2);
  } finally {
    await fixture.stop();
  }
});

test("an updated PWA applies its deferred update once a routed notification expires", async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);
  await installLoadCounter(page);

  try {
    await page.goto(fixture.origin);
    await waitForControlledWorker(page);
    const snapshot = await holdRoute(page, "**/api/v1/sessions", route => route.continue());
    // Generation 2 no longer matches the live generation-1 session, so the route resolves as expired.
    await page.goto(`${fixture.origin}/collab/pwa-upgrade-0001?activity=stopped&generation=2`);
    await snapshot.arrived;

    await upgradeThroughActivation(page, fixture);
    expect(await loadCount(page)).toBe(2);

    snapshot.release();
    await expect.poll(() => loadCount(page)).toBe(3);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".working-row")).toHaveCount(1);
    expect(fixture.launchRequests).toEqual([]);
  } finally {
    await fixture.stop();
  }
});
