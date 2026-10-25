import { expect, test } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, startDashboardFixture } from "./fixture-server.ts";

function session(): SessionMetadata {
  return {
    instanceId: "desktop-layout-0001",
    generation: 1,
    title: "Read a session in a desktop window",
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-10-20T08:00:00.000Z",
    lastSeenAt: "2026-10-20T08:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: true,
    ask: {
      requestId: "desktop-layout-request-0001",
      since: "2026-10-20T08:00:01.000Z",
    },
  };
}

// The directory's `main` rule also matches the embedded client's `<main>`. A desktop window keeps the
// directory in its 35rem triage column but gives an open session the client's full 900px transcript,
// with the session header aligned to the same column.
test("a desktop window widens an open session but not the directory", { tag: "@core" }, async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);

  try {
    await installSilentWebSocket(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(fixture.origin);
    await expect(page.locator("body > main")).toHaveCSS("width", "560px");

    await page.getByRole("button", { name: "Open request" }).click();
    await page.locator(".tray-expand").click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator(".sh-composer-input")).toBeVisible();
    await expect(page.locator(".sh-transcript")).toHaveCSS("width", "900px");

    const column = await page.locator(".gateway-shell main").boundingBox();
    const back = await page.locator(".shell-back").boundingBox();
    if (column === null || back === null) throw new Error("the session column or its header is not laid out");
    expect(back.x).toBeCloseTo(column.x, 0);
  } finally {
    await fixture.stop();
  }
});
