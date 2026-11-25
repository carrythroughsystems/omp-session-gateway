import { expect, test, type Request } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { startDashboardFixture } from "./fixture-server.ts";
import { HANG_DEADLINE_MS } from "../../gateway/test/test-support.ts";

function session(): SessionMetadata {
  return {
    instanceId: "network-recovery-0001",
    generation: 1,
    title: "Wi-Fi roaming session",
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-25T05:00:00.000Z",
    lastSeenAt: "2026-07-25T05:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: false,
  };
}

test("cold boot overlaps client config and sessions and replaces an interrupted request", { tag: "@core" }, async ({ context }) => {
  for (const reconnect of [false, true]) {
    await test.step(reconnect ? "online during boot" : "normal boot", async () => {
      const active = session();
      const fixture = await startDashboardFixture([active]);
      const page = await context.newPage();
      const configUrl = `${fixture.origin}/api/v1/client-config`;
      const sessionsUrl = `${fixture.origin}/api/v1/sessions`;
      const releaseConfig = Promise.withResolvers<void>();
      const requests: Request[] = [];
      const failed = new Map<Request, string>();
      const pageErrors: string[] = [];
      const rejections: string[] = [];
      let intercepted = 0;
      try {
        await page.addInitScript(() => {
          window.addEventListener("unhandledrejection", () => console.error("Unhandled rejection during directory boot"));
        });
        page.on("pageerror", error => pageErrors.push(error.message));
        page.on("console", message => {
          if (message.type() === "error" && /unhandled|uncaught \(in promise\)/iu.test(message.text())) {
            rejections.push(message.text());
          }
        });
        page.on("request", request => {
          if (request.url() === sessionsUrl) requests.push(request);
        });
        page.on("requestfailed", request => {
          if (request.url() === sessionsUrl) failed.set(request, request.failure()?.errorText ?? "unknown failure");
        });
        await page.route(configUrl, async route => {
          await new Promise(resolve => setTimeout(resolve, 500));
          if (reconnect) await releaseConfig.promise;
          if (!page.isClosed()) await route.continue();
        });
        if (reconnect) {
          await page.route(sessionsUrl, async route => {
            // Leave the first request pending; only the page's abort can end it.
            if (++intercepted !== 1) await route.continue();
          });
        }

        await page.goto(fixture.origin, { waitUntil: "commit" });
        const row = page.locator(".working-row");
        if (reconnect) {
          await expect.poll(() => intercepted).toBe(1);
          await page.evaluate(() => window.dispatchEvent(new Event("online")));
          // The held request can only end by the page's abort; WebKit words that as a cancellation.
          await expect.poll(() => failed.get(requests[0]!)).toMatch(/aborted|cancell?ed/iu);
          // The held request never reaches the fixture, so the one it logs is the replacement. The route
          // cannot count it: WebKit skips page routes once the service worker controls the page.
          await expect.poll(() => fixture.requests.filter(request => request === "GET /api/v1/sessions").length).toBe(1);
          await expect(row).toHaveCount(0);
          releaseConfig.resolve();
        }

        await expect(row).toHaveCount(1);
        await expect(row).toContainText(active.title!);
        await expect.poll(() => fixture.requests.filter(request => request === "GET /api/v1/events").length).toBe(1);
        expect(requests).toHaveLength(reconnect ? 2 : 1);
        const { configEnd, sessionsStart } = await page.evaluate(([config, sessions]) => {
          const configTiming = performance.getEntriesByName(config, "resource")[0] as PerformanceResourceTiming | undefined;
          return {
            configEnd: configTiming?.responseEnd,
            sessionsStart: performance.getEntriesByName(sessions, "resource")[0]?.startTime,
          };
        }, [configUrl, sessionsUrl] as const);
        expect(configEnd).toBeDefined();
        expect(sessionsStart).toBeDefined();
        expect(sessionsStart!, `first sessions request precedes config completion (${requests.length} sessions request(s))`)
          .toBeLessThan(configEnd!);
        expect(failed.size).toBe(reconnect ? 1 : 0);
        expect(pageErrors).toEqual([]);
        expect(rejections).toEqual([]);
      } finally {
        releaseConfig.resolve();
        await page.close();
        await fixture.stop();
      }
    });
  }
});

test("dashboard reconnects after its live transport is interrupted", { tag: "@core" }, async ({ page }) => {
  const active = session();
  const fixture = await startDashboardFixture([active]);

  try {
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(1);

    await expect.poll(
      () => fixture.requests.filter(request => request === "GET /api/v1/events").length,
    ).toBeGreaterThanOrEqual(1);

    expect(fixture.disconnectEvents()).toBeGreaterThan(0);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "gateway", { timeout: 900 });
    await expect(page.locator("#status-banner .status-title")).toHaveText("Gateway unavailable");
    await expect(page.locator(".working-row")).toHaveCount(1);

    fixture.setSnapshot([active], 2);
    await expect(page.locator(".working-row")).toHaveCount(1, { timeout: 6_000 });
    await expect(page.locator("#status-banner")).toBeHidden();
    await expect.poll(
      () => fixture.requests.filter(request => request === "GET /api/v1/sessions").length,
    ).toBeGreaterThanOrEqual(2);
    await expect.poll(
      () => fixture.requests.filter(request => request === "GET /api/v1/events").length,
    ).toBeGreaterThanOrEqual(2);
  } finally {
    await fixture.stop();
  }
});

test("counterexample: first snapshot failure stays named throughout a pending scheduled retry", async ({ page }) => {
  const fixture = await startDashboardFixture([]);
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  await page.route(`${fixture.origin}/api/v1/sessions`, async route => {
    if (++requests === 1) { await route.fulfill({ status: 503, body: "" }); return; }
    pending.resolve();
    await release.promise;
    await route.continue().catch(() => undefined);
  });
  try {
    await page.clock.install({ time: new Date("2026-10-25T01:30:00Z") });
    await page.clock.pauseAt(new Date("2026-10-25T01:30:01Z"));
    await page.goto(fixture.origin);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop");
    await page.clock.runFor(4_000);
    await pending.promise;
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop");
    await expect(page.locator(".status-title")).toHaveText("Desktop unreachable");
    await expect(page.locator("#status-banner > *")).toHaveCount(1);
    release.resolve();
    await expect(page.locator("#status-banner")).toBeHidden();
  } finally { release.resolve(); await page.close(); await fixture.stop(); }
});

test("failure states keep stale sessions, exact copy, timestamps, and mobile fit", async ({ context, page }) => {
  test.setTimeout(2 * HANG_DEADLINE_MS);
  const active = session();
  const fixture = await startDashboardFixture([active]);
  const eventRequestCount = (): number =>
    fixture.requests.filter(request => request === "GET /api/v1/events").length;
  const assertFits = async (): Promise<void> => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator(".working-row")).toHaveCount(1);
  };

  try {
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(1);
    await expect.poll(eventRequestCount).toBeGreaterThanOrEqual(1);

    await context.setOffline(true);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "offline");
    await expect(page.locator("#status-banner .status-title")).toHaveText("You're offline");
    await expect(page.locator("#status-banner .status-detail")).toContainText(
      "This device has no connection. Showing the list as of",
    );
    await assertFits();

    const eventRequestsBeforeOnline = eventRequestCount();
    await context.setOffline(false);
    await expect(page.locator("#status-banner")).toBeHidden({ timeout: 6_000 });
    await expect.poll(eventRequestCount).toBeGreaterThan(eventRequestsBeforeOnline);

    await page.route("**/api/v1/sessions", route => route.abort("connectionrefused"));
    expect(fixture.disconnectEvents()).toBeGreaterThan(0);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "tailnet", {
      timeout: 6_000,
    });
    await expect(page.locator("#status-banner .status-title")).toHaveText("Tailnet unreachable");
    await expect(page.locator("#status-banner .status-detail")).toHaveText(
      "This device is online, but your tailnet isn't answering. Check that Tailscale is connected.",
    );
    await expect(page.locator("#status-banner .status-freshness")).toContainText("list as of");
    await assertFits();

    const eventRequestsBeforeTailnetRecovery = eventRequestCount();
    await page.unroute("**/api/v1/sessions");
    await expect(page.locator("#status-banner")).toBeHidden({ timeout: 6_000 });
    await expect.poll(eventRequestCount).toBeGreaterThan(eventRequestsBeforeTailnetRecovery);

    await page.route("**/api/v1/sessions", route =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    expect(fixture.disconnectEvents()).toBeGreaterThan(0);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "desktop", {
      timeout: 6_000,
    });
    await expect(page.locator("#status-banner .status-title")).toHaveText("Desktop unreachable");
    await expect(page.locator("#status-banner .status-detail")).toContainText(
      "The desktop isn't answering. Check that it is awake and the gateway is running. Showing the list as of",
    );
    await expect.poll(
      () => page.locator("#status-banner .status-action").evaluate(element => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await assertFits();

    const eventRequestsBeforeDesktopRecovery = eventRequestCount();
    await page.unroute("**/api/v1/sessions");
    await expect(page.locator("#status-banner")).toBeHidden({ timeout: 6_000 });
    await expect.poll(eventRequestCount).toBeGreaterThan(eventRequestsBeforeDesktopRecovery);

    // Keep replacement EventSource connections down as well as the stream that is open now. Without
    // this, the gateway banner can recover between the data-kind and copy assertions.
    await page.route("**/api/v1/events", route => route.abort("connectionrefused"));
    expect(fixture.disconnectEvents()).toBeGreaterThan(0);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "gateway", {
      timeout: 900,
    });
    await expect(page.locator("#status-banner .status-title")).toHaveText("Gateway unavailable");
    await expect(page.locator("#status-banner .status-detail")).toContainText(
      "Live updates paused; showing the list as of",
    );
    await assertFits();
  } finally {
    await context.setOffline(false);
    await fixture.stop();
  }
});

test("a prolonged visible outage opens recovery help from the loaded shell", async ({ page }) => {
  const active = session();
  const fixture = await startDashboardFixture([active]);

  try {
    await page.clock.install();
    await page.goto(fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(1);
    await expect.poll(
      () => fixture.requests.filter(request => request === "GET /api/v1/events").length,
    ).toBeGreaterThanOrEqual(1);
    await page.route("**/api/v1/sessions", route => route.abort("connectionrefused"));
    expect(fixture.disconnectEvents()).toBeGreaterThan(0);
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "tailnet", { timeout: 6_000 });
    await expect(page.locator("#status-banner .status-guidance")).toHaveCount(0);

    await page.clock.fastForward(45_100);
    await expect(page.locator("#status-banner .status-guidance")).toContainText(
      "The browser may be stuck after sleep or a network change",
    );
    await page.route("**/*", route => route.abort("connectionrefused"));
    await page.getByRole("button", { name: "Troubleshooting" }).click();

    const help = page.getByRole("dialog", { name: "Troubleshooting" });
    await expect(help).toBeVisible();
    await expect(help.getByText("Force stop", { exact: true })).toBeVisible();
    await expect(help.getByText("These steps are guidance, not a diagnosis", { exact: false })).toBeVisible();
  } finally {
    await fixture.stop();
  }
});
