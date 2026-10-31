import { expect, test } from "@playwright/test";
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
