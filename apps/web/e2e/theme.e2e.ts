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

// Text has to stay readable on every surface it can sit on, including the pressed and hovered one.
test("every text ink keeps a 4.5:1 contrast on every surface in both schemes", async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      const low = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const luminance = (token: string): number => {
          const hex = style.getPropertyValue(token).trim().slice(1);
          const full = hex.length === 3 ? [...hex].map(digit => digit + digit).join("") : hex;
          const [red, green, blue] = [0, 2, 4].map(index => {
            const channel = Number.parseInt(full.slice(index, index + 2), 16) / 255;
            return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
        };
        const failures: string[] = [];
        for (const ink of ["--ink", "--ink-2", "--ink-3", "--state-attention-text", "--state-danger-text"]) {
          for (const surface of ["--ground", "--surface-1", "--surface-2", "--surface-3"]) {
            const [text, behind] = [luminance(ink), luminance(surface)];
            const ratio = (Math.max(text, behind) + 0.05) / (Math.min(text, behind) + 0.05);
            if (!(ratio >= 4.5)) failures.push(`${ink} on ${surface}: ${ratio.toFixed(2)}`);
          }
        }
        return failures;
      });
      expect(low, colorScheme).toEqual([]);
    }
  } finally {
    await fixture.stop();
  }
});
