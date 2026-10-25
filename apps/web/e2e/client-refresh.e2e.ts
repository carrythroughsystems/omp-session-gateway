import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startDashboardFixture } from "./fixture-server";
import { GATEWAY_WAITING, GATEWAY_WORKING, INITIAL_SESSIONS, installSyntheticProductFixture } from "./synthetic-product-fixture";

const TRANSCRIPT = "## Synthetic client refresh\n\n**Markdown** and native MathML:\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\n```text\n\u{f0493} synthetic-folder  \ue0b0  eza symbols\n```";
const STREAM = "Streaming **assistant text** with [a safe link](https://example.com).";

for (const viewport of [{ width: 412, height: 915 }, { width: 1280, height: 800 }]) {
  for (const mode of ["view", "control"] as const) {
    test(`client refresh ${mode} at ${viewport.width}x${viewport.height}`, async ({ page, context }, info) => {
      await page.setViewportSize(viewport);
      const key = randomBytes(32);
      const fixture = await startDashboardFixture(mode === "view" ? [...INITIAL_SESSIONS] : [GATEWAY_WAITING], { roomKey: key });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.name));
      page.on("console", message => { if (message.type() === "error") errors.push("console error"); });
      let externalRequests = 0;
      try {
        await installSyntheticProductFixture(context, key, {
          readOnly: mode === "view", transcript: TRANSCRIPT, historyEntryCount: 200,
          streamedTranscript: STREAM, answerRequests: true, randomSeed: 42,
        });
        await context.route("**/*", async route => {
          if (new URL(route.request().url()).origin === fixture.origin) await route.continue();
          else { externalRequests++; await route.abort("blockedbyclient"); }
        });
        await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
        await page.locator(mode === "view" ? ".working-row" : ".action-request").first().click();
        await expect(page.locator('.conn-chip[data-state="connected"]')).toBeVisible();
        await expect(page.locator(".sh-transcript h2")).toHaveText("Synthetic client refresh");
        await expect(page.locator('.sh-transcript math[display="block"]')).toHaveCount(1);
        await expect(page.locator(".sh-transcript")).toContainText("Streaming assistant text with a safe link.");
        await expect(page.locator(".sh-transcript pre code")).toContainText("\u{f0493} synthetic-folder  \ue0b0  eza symbols");
        await expect(page.locator(".sh-composer")).toHaveCount(1);
        const rowsBefore = await page.locator(".tr-row").count();
        await page.getByRole("button", { name: /^Show earlier/ }).click();
        await expect(page.getByRole("button", { name: /^Show earlier/ })).toHaveCount(0);
        expect(await page.locator(".tr-row").count()).toBeGreaterThan(rowsBefore);
        await expect(page.locator(".sh-transcript")).toContainText("Synthetic earlier entry 0");
        await page.locator(".tr-root").evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.evaluate(async () => { await document.fonts.ready; });
        expect(await page.locator(".sh-transcript pre code").evaluate(element => getComputedStyle(element).fontFamily)).toContain("Symbols Nerd Font Mono");
        const directory = process.env.OMP_CLIENT_REFRESH_SCREENSHOTS;
        const screenshot = async (suffix: string) => {
          fixture.assertNoCapabilityMaterial(await page.content());
          fixture.assertNoCapabilityMaterial(page.url());
          if (directory !== undefined) {
            await mkdir(directory, { recursive: true });
            await page.screenshot({ path: join(directory, `${info.project.name}-${viewport.width}x${viewport.height}-${mode}-${suffix}.png`), animations: "disabled" });
          }
        };
        if (mode === "view") {
          await expect(page.locator(".sh-composer-input")).not.toBeEditable();
          await screenshot("transcript");
        } else {
          await expect(page.locator(".sh-composer-ask-embedded")).toBeVisible();
          await expect(page.locator(".sh-ask-option-checked .sh-ask-option-recommended")).toBeVisible();
          await screenshot("ask");
          await page.locator(".sh-ask-send").click();
          await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(0);
          await expect(page.locator(".sh-transcript")).toContainText("Synthetic Ask answered: Implement ADR-0036 locally");
          fixture.upsert(GATEWAY_WORKING);
          await expect(page.locator('.triage-bar[data-kind="hold"]')).toHaveCount(0);
          await page.locator(".tr-root").evaluate(element => { element.scrollTop = element.scrollHeight; });
          await screenshot("answered");
        }
        expect(errors).toEqual([]);
        expect(externalRequests).toBe(0);
        fixture.assertNoCapabilityMaterial(JSON.stringify(fixture.requests));
      } finally { await fixture.stop(); }
    });
  }
}
