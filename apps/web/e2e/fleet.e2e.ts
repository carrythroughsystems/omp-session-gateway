import { expect, test } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { startDashboardFixture, installSilentWebSocket } from "./fixture-server";

const shared: SessionMetadata = {
  instanceId: "colliding-session-001", generation: 1, title: "Shared session",
  cwdLabel: "project", startedAt: "2026-07-21T10:00:00.000Z", lastSeenAt: "2026-07-21T10:00:01.000Z",
  canView: true, canControl: true, inputRequired: false,
};

test("two origins isolate identity, launch directly with preflight, and isolate forbidden and timeout failures", async ({ page, context }) => {
  const home = await startDashboardFixture([{ ...shared, title: "Home session" }]);
  const away = await startDashboardFixture([{ ...shared, title: "Remote session" }]);
  home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], [away.origin]);
  away.configureFleet("Away", [{ id: "home", label: "Home", origin: home.origin }], [home.origin]);
  await context.addCookies([{ name: "fixture-cookie", value: "not-a-credential", url: away.origin }]);
  await installSilentWebSocket(page);
  try {
    await page.goto(home.origin);
    await expect(page.locator(".working-row")).toHaveCount(2);
    await expect(page.getByLabel("Host", { exact: true })).toHaveValue("all");
    await page.getByLabel("Host", { exact: true }).selectOption({ label: "Away" });
    await expect(page.locator(".working-row")).toHaveCount(1);
    await expect(page.locator(".working-row")).toContainText("Remote session");
    await page.getByRole("button", { name: "View Remote session", exact: true }).click();
    await expect(page.locator(".shell-host")).toHaveText("Away");
    await expect.poll(() => away.launchRequests.map(request => request.mode)).toEqual(["view"]);
    await page.locator(".shell-control").click();
    await expect.poll(() => away.launchRequests.map(request => request.mode)).toEqual(["view", "control"]);
    expect(home.launchRequests).toHaveLength(0);
    const launchPreflight = away.requestLog.find(request => request.method === "OPTIONS" && request.path.endsWith("/launch"));
    expect(launchPreflight).toMatchObject({ origin: home.origin, fetchMode: "cors", credentialsPresent: false });
    expect(away.requestLog.every(request => request.credentialsPresent === false)).toBe(true);
    expect(away.requestLog.every(request => request.path === "/api/v1/sessions" || request.path.endsWith("/launch"))).toBe(true);

    away.setListFailure("forbidden");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    await expect(page.locator("#fleet-status")).toContainText("Access withdrawn");
    await page.getByLabel("Host", { exact: true }).selectOption({ label: "Home" });
    await expect(page.getByRole("button", { name: "View Home session", exact: true })).toBeEnabled();
    await page.getByLabel("Host", { exact: true }).selectOption("all");
    await expect(page.locator(".all-clear-title")).toHaveText("Host coverage incomplete");
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    away.setListFailure(undefined);
    // Access denial is not connectivity: only a later foreground/identity recheck restores it.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".working-row")).toHaveCount(2);
    away.setListFailure("timeout");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#fleet-status")).toContainText("Host unavailable.", { timeout: 8_000 });
    await expect(page.getByRole("button", { name: "View Remote session", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "View Home session", exact: true })).toBeEnabled();
    away.setListFailure("malformed");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("button", { name: "View Home session", exact: true })).toBeEnabled();
    // Metadata-only evidence: no bodies, URLs containing authority, cookies or capability values.
    console.log("fleet CORS request evidence", JSON.stringify(away.requestLog));
    expect(away.requestLog.some(request => /events|client-config|push|health/u.test(request.path))).toBe(false);
  } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

test("selection changes discard a late remote launch instead of mounting it", async ({ page }) => {
  const home = await startDashboardFixture([{ ...shared, title: "Home session" }]);
  const away = await startDashboardFixture([{ ...shared, title: "Remote session" }]);
  home.configureFleet("Home", [{ id: "away", label: "Away", origin: away.origin }], []);
  away.configureFleet("Away", [], [home.origin]);
  await installSilentWebSocket(page);
  const intercepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`${away.origin}/api/v1/sessions/*/launch`, async route => {
    const response = await route.fetch();
    intercepted.resolve();
    await release.promise;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.goto(home.origin);
    await expect(page.locator(".working-row")).toHaveCount(2);
    await page.getByRole("button", { name: "View Remote session", exact: true }).click();
    await intercepted.promise;
    await page.getByLabel("Host", { exact: true }).selectOption({ label: "Home" });
    release.resolve();
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "View Home session", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "View Home session", exact: true }).click();
    await expect(page.locator(".shell-host")).toHaveText("Home");
    expect(home.launchRequests).toHaveLength(1);
  } finally { release.resolve(); await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

test("one interrupted gateway owns the story while quiet host revalidation stays neutral", async ({ page }) => {
  const home = await startDashboardFixture([{ ...shared, title: "Home session" }]);
  const away = await startDashboardFixture([{ ...shared, title: "Remote session" }]);
  home.configureFleet("MacBook", [{ id: "away", label: "Studio", origin: away.origin }], [away.origin]);
  away.configureFleet("Studio", [], [home.origin]);
  try {
    await page.clock.install({ time: new Date("2026-10-25T01:30:00Z") });
    await page.goto(home.origin);
    await expect(page.locator("#directory-count")).toHaveText("Live · 2");
    await page.clock.pauseAt(new Date("2026-10-25T01:30:01Z"));
    await page.route(`${away.origin}/api/v1/sessions`, () => {});
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("#fleet-status")).toBeHidden();
    home.disconnectEvents();
    await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "gateway", { timeout: 900 });
    await expect(page.locator("#status-banner > *")).toHaveCount(1);
    await expect(page.locator(".fleet-status-row")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await expect(page.locator("#directory-count")).toHaveText("Listed · 2");
    await expect(page.locator("#directory-count")).toHaveClass("count-pill count-pill-listed");
    await expect(page.locator(".all-clear-copy")).toHaveText("0 of 2 hosts up to date. Other sessions may be missing.");
    await expect(page.locator(".working-row-frame[data-fresh='false']")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
});

test("empty incomplete and filtered coverage have content and long failed hosts fit", async ({ page }) => {
  const home = await startDashboardFixture([]);
  const away = await startDashboardFixture([]);
  const label = "Host-" + "long-label-".repeat(5) + "east";
  home.configureFleet("Home", [{ id: "away", label, origin: away.origin }], [away.origin]);
  away.configureFleet(label, [], [home.origin]);
  away.setListFailure("malformed");
  try {
    expect(label.length).toBe(64);
    await page.goto(home.origin);
    await expect(page.locator("#empty-state")).toContainText("No sessions to show yet");
    await expect(page.locator(".fleet-status-row")).toHaveCount(1);
    await page.getByLabel("Host", { exact: true }).selectOption({ label });
    await expect(page.locator("#empty-state")).toContainText("This host has not been checked");
    await expect(page.locator("#empty-state")).toContainText("0 of 1 host up to date.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "All hosts", exact: true }).click();
    await expect(page.getByLabel("Host", { exact: true })).toHaveValue("all");
  } finally { await page.close(); await Promise.all([home.stop(), away.stop()]); }
});
