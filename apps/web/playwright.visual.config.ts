import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { HANG_DEADLINE_MS } from "../../scripts/test-support.ts";

// Playwright otherwise captures an automatic failure DOM snapshot even when tracing is off.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: fileURLToPath(new URL("./visual", import.meta.url)),
  testMatch: "*.visual.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  preserveOutput: "never",
  timeout: 2 * HANG_DEADLINE_MS,
  globalTimeout: 6 * HANG_DEADLINE_MS,
  outputDir: "../../test-results/visual",
  reporter: [[fileURLToPath(new URL("./visual/safe-reporter.ts", import.meta.url))]],
  use: {
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    deviceScaleFactor: 1,
    serviceWorkers: "allow",
    // The e2e fixture mirrors the production CSP (`style-src 'self'`) so the fleet specs prove the
    // document's connect-src; this lane injects inline motion-disabling and guard styles, and it
    // reviews geometry, not policy, so it bypasses CSP as it did before the fixture carried one.
    bypassCSP: true,
    screenshot: "off",
    video: "off",
    trace: "off",
  },
  projects: [
    { name: "visual-phone-390x844", use: { viewport: { width: 390, height: 844 } } },
    { name: "visual-tablet-810x1080", use: { viewport: { width: 810, height: 1080 } } },
    { name: "visual-desktop-1280x800", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
