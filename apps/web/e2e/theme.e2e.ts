import { expect, test } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, startDashboardFixture } from "./fixture-server.ts";

function session(): SessionMetadata {
  return {
    instanceId: "theme-follows-system-0001",
    generation: 1,
    title: "Follow the system color scheme",
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-11-09T08:00:00.000Z",
    lastSeenAt: "2026-11-09T08:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: true,
    ask: {
      requestId: "theme-follows-system-request-0001",
      since: "2026-11-09T08:00:01.000Z",
    },
  };
}

// The theme is the system's: one stylesheet, two schemes, no stored preference. The embedded client
// reads the gateway palette through tokens, so an open request has to turn with the page, and a
// scheme change while the page is open must not wait for a reload.
test("the directory and an open request follow the system color scheme", { tag: "@core" }, async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);

  try {
    await installSilentWebSocket(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(fixture.origin);
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(244, 244, 242)");
    await expect(page.locator("#directory-title")).toHaveCSS("color", "rgb(11, 11, 12)");

    await page.getByRole("button", { name: "Open request" }).click();
    const client = page.locator("#tray #root .sh-app");
    await expect(client).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(client).toHaveCSS("color", "rgb(11, 11, 12)");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(page.locator("#directory-title")).toHaveCSS("color", "rgb(245, 245, 243)");
    await expect(client).toHaveCSS("background-color", "rgb(17, 17, 19)");
    await expect(client).toHaveCSS("color", "rgb(245, 245, 243)");
  } finally {
    await fixture.stop();
  }
});
