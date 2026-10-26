import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Chrome's reduced UA freezes the platform at "Android 10; K" by design; do not
// "fix" it to report the device's Android 17 version.
const androidUserAgent =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";

// The browser lane was benchmarked at 1, 2 and 4 workers through a `workflow_dispatch` input.
// Two workers is the fastest stable width, so an unset variable or an empty workflow `env:` value
// selects 2. Three is accepted for a bounded qualification campaign and is not yet qualified.
// Anything else is a wiring mistake and fails loudly here, because silently falling back would
// attribute a run to a width it never used.
function playwrightWorkers(): number {
  const requested = process.env.PLAYWRIGHT_WORKERS;
  switch (requested) {
    case undefined:
    case "":
    case "2":
      return 2;
    case "1":
      return 1;
    case "3":
      return 3;
    case "4":
      return 4;
    default:
      throw new Error(
        `PLAYWRIGHT_WORKERS must be "1", "2", "3" or "4" when set, not ${JSON.stringify(requested)}`,
      );
  }
}

export default defineConfig({
  testDir: fileURLToPath(new URL("./e2e", import.meta.url)),
  testMatch: "*.e2e.ts",
  fullyParallel: false,
  workers: playwrightWorkers(),
  retries: process.env.CI === "true" || process.env.CI === "1" ? 1 : 0,
  reporter: [["line"], [fileURLToPath(new URL("../../scripts/browser-flake-reporter.ts", import.meta.url)), { lane: "browser-notifications" }]],
  use: {
    trace: "off",
    video: "off",
    screenshot: "off",
    browserName: "chromium",
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "allow",
    userAgent: androidUserAgent,
  },
  projects: [
    // Measured on a Pixel 10 Pro on 2026-08-20: 411x816 layout viewport, 412x919 screen, DPR 2.625.
    // `screen` is recorded here rather than set, because this Playwright version does not accept it
    // as a project `use` option; only the viewport and scale factor affect rendering anyway.
    {
      name: "pixel-10-pro-411x816",
      use: {
        viewport: { width: 411, height: 816 },
        deviceScaleFactor: 2.625,
      },
    },
    // Deliberately synthetic narrow viewport for responsive layout coverage,
    // not an emulation of a measured physical device.
    {
      name: "synthetic-narrow-390x844",
      use: { viewport: { width: 390, height: 844 } },
    },
  ],
});
