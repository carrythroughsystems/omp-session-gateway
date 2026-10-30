import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { HANG_DEADLINE_MS } from "../../scripts/test-support.ts";

// The browser-neutral compatibility lane: the `@core` tests of the e2e suite on every major
// engine, at a desktop size and an iPhone-class size. The deep lane (playwright.config.ts) keeps
// the Pixel/Chromium device, touch, and timing contract; nothing here replaces it, and no engine
// here stands in for a physical device.
const desktop = { viewport: { width: 1280, height: 800 } };

export default defineConfig({
  testDir: fileURLToPath(new URL("./e2e", import.meta.url)),
  testMatch: "*.e2e.ts",
  grep: /@core\b/u,
  fullyParallel: false,
  timeout: 2 * HANG_DEADLINE_MS,
  // One worker: breadth across engines matters here, not throughput, and core tests keep the deep
  // lane's timing bounds.
  workers: 1,
  retries: process.env.CI === "true" || process.env.CI === "1" ? 1 : 0,
  reporter: [["line"], [fileURLToPath(new URL("../../scripts/browser-flake-reporter.ts", import.meta.url)), { lane: "browser-core" }]],
  use: { serviceWorkers: "allow", trace: "off", video: "off", screenshot: "off" },
  projects: [
    { name: "desktop-chromium", use: { browserName: "chromium", ...desktop } },
    { name: "desktop-firefox", use: { browserName: "firefox", ...desktop } },
    {
      // Playwright's WebKit has no push service. With a service worker active, the dashboard's
      // `pushManager.getSubscription()` blocks its main thread for good (bisected 2026-09-24:
      // blocking workers or hiding PushManager each avoids it; a minimal worker does not trigger
      // it). Desktop WebKit therefore runs without workers, so the app takes its no-push path,
      // and WebKit worker coverage comes from the iPhone-class project below.
      name: "desktop-webkit",
      use: { browserName: "webkit", ...desktop, serviceWorkers: "block" },
      grepInvert: /@serviceworker\b/u,
    },
    { name: "iphone-webkit", use: { ...devices["iPhone 13"], serviceWorkers: "allow" } },
  ],
});
