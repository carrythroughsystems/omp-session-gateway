import { expect, test } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { startDashboardFixture } from "./fixture-server.ts";

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

test("failure states keep stale sessions, exact copy, timestamps, and mobile fit", async ({ context, page }) => {
  test.setTimeout(60_000);
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
      "This device is online, but your tailnet isn't answering — Tailscale is off or logged out here.",
    );
    await expect(page.locator("#status-banner .status-freshness")).toContainText("Last seen");
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
      "Tailnet looks fine, but the desktop isn't answering — asleep, or the gateway stopped. Last seen",
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

    const help = page.getByRole("dialog", { name: "Still unreachable?" });
    await expect(help).toBeVisible();
    await expect(help.getByText("Force stop", { exact: true })).toBeVisible();
    await expect(help.getByText("These steps are guidance, not a diagnosis", { exact: false })).toBeVisible();
  } finally {
    await fixture.stop();
  }
});
