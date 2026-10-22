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
    away.setListFailure(undefined);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator(".working-row")).toHaveCount(2);
    away.setListFailure("timeout");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#fleet-status")).toContainText("Cannot reach this host from this app.", { timeout: 8_000 });
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
