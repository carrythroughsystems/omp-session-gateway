import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Playwright otherwise captures an automatic failure DOM snapshot even when tracing is off.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: fileURLToPath(new URL("./visual", import.meta.url)),
  testMatch: "*.visual.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  preserveOutput: "never",
  timeout: 30_000,
  globalTimeout: 12 * 60_000,
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
