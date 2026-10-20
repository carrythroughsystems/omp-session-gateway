import { randomBytes } from "node:crypto";
import { test, type Browser, type Page } from "@playwright/test";
import type { SessionMetadata } from "../../../packages/protocol/src/index.ts";
import { startDashboardFixture, type DashboardFixture } from "../e2e/fixture-server.ts";
import {
  GATEWAY_WAITING, INITIAL_SESSIONS, RELEASE_WAITING, installSyntheticProductFixture,
} from "../e2e/synthetic-product-fixture.ts";
import { VISUAL_STATES, VISUAL_UPLOAD_REASONS } from "./safe-reporter.ts";
import { snapshotOptions, submitSnapshot, validateSnapshot } from "./snapshot-safety.ts";

const TRANSCRIPT = [
  "## Synthetic layout review",
  "This authored fixture explains a bounded compatibility change. It is not a real conversation, prompt, tool result, or session transcript.",
  "A wide session column should keep this prose readable and preserve enough room for meaningful code lines.",
  "```typescript",
  'const review = { source: "synthetic fixture", viewport: "responsive", approved: false };',
  'const summary = [review.source, review.viewport].join(" — ");',
  "```",
].join("\n\n");

function metadataOnly(session: SessionMetadata): SessionMetadata {
  if (session.ask === undefined) return session;
  const { preview: _preview, ...ask } = session.ask;
  return { ...session, ask };
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const selectors = ["body > main", ".gateway-shell main", ".sh-transcript", ".shell-back", ".sh-composer-ask-embedded", ".triage-bar", "#notification-settings"];
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      boxes: selectors.map(selector => {
        const element = document.querySelector(selector);
        if (element === null || getComputedStyle(element).display === "none") return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    };
  });
}

async function validateNegativeGuards(browser: Browser, fixture: DashboardFixture, keyBytes: Uint8Array, setPhase: (phase: string) => void): Promise<void> {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await context.route("**/*", async route => {
      if (new URL(route.request().url()).origin === fixture.origin) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    const canary = Buffer.from(keyBytes).toString("base64url").slice(3, 19);
    for (const location of ["hidden-attribute", "form-value", "inline-style", "text", "textual-resource"]) {
      setPhase(`negative-${location}`);
      await page.evaluate(({ location, value }) => {
        if (location === "text") {
          const paragraph = document.createElement("p");
          paragraph.id = "visual-negative";
          paragraph.hidden = true;
          paragraph.textContent = value;
          document.body.append(paragraph);
          return;
        }
        const input = document.createElement("input");
        input.id = "visual-negative";
        input.hidden = true;
        if (location === "hidden-attribute") input.setAttribute("data-canary", value);
        else if (location === "form-value") input.value = value;
        else if (location === "inline-style") input.style.setProperty("--canary", `"${value}"`);
        else {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(`body { --canary: "${value}"; }`);
          document.adoptedStyleSheets = [sheet];
        }
        document.body.append(input);
      }, { location, value: canary });
      let rejected = false;
      try { await validateSnapshot(page, fixture, snapshotOptions(390, 844)); }
      catch (error) {
        if (String(error).includes(canary)) throw new Error("visual guard: unsafe diagnostic");
        rejected = true;
      }
      if (!rejected) throw new Error("visual guard: planted material accepted");
      await page.evaluate(() => { document.querySelector("#visual-negative")?.remove(); document.adoptedStyleSheets = []; });
    }
    for (const markup of ['<iframe src="about:blank"></iframe>', '<div onclick="return false"></div>', '<img src="https://external.example.test/image.png">', '<img src="/api/v1/sessions">', '<img src="/assets/%2e%2e/private.png">', "<canvas></canvas>"]) {
      setPhase("negative-surface");
      await page.evaluate(value => {
        const node = document.createElement("div");
        node.id = "visual-negative";
        node.innerHTML = value;
        document.body.append(node);
      }, markup);
      let rejected = false;
      try { await validateSnapshot(page, fixture, snapshotOptions(390, 844)); }
      catch { rejected = true; }
      if (!rejected) throw new Error("visual guard: unreviewed surface accepted");
      await page.evaluate(() => document.querySelector("#visual-negative")?.remove());
    }
  } finally { await context.close(); }
}

for (const state of VISUAL_STATES) {
  test(state, async ({ browser, context, page }, info) => {
    let phase = "fixture";
    const roomKey = randomBytes(32);
    const waiting = metadataOnly(GATEWAY_WAITING);
    const sessions = state === "directory-empty" ? [] : state === "directory-needs-you" || state === "collab-control-ask"
      ? [waiting, metadataOnly(RELEASE_WAITING), ...INITIAL_SESSIONS.slice(1)]
      : [...INITIAL_SESSIONS];
    const fixture = await startDashboardFixture(sessions, { roomKey });
    let unexpectedRequests = 0;
    try {
      await installSyntheticProductFixture(context, roomKey, { readOnly: state === "collab-view", transcript: TRANSCRIPT, randomSeed: 42 });
      await context.route("**/*", async route => {
        if (new URL(route.request().url()).origin === fixture.origin) await route.continue();
        else { unexpectedRequests++; await route.abort("blockedbyclient"); }
      });
      phase = "directory";
      await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
      await page.locator(state === "directory-empty" ? ".empty-state" : state === "directory-needs-you" || state === "collab-control-ask" ? ".queue-hero" : ".all-clear-summary").waitFor();
      if (state === "directory-all-clear" || state === "settings-enabled-session") {
        phase = "alerts";
        await page.evaluate(async () => navigator.serviceWorker.ready);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator("#settings").click();
        await page.locator('#notify[data-state="idle"]').waitFor();
        await page.locator("#notify").click();
        await page.locator('#notify[data-state="enabled"]').waitFor();
        if (state === "directory-all-clear") {
          await page.locator("#notification-settings-close").click();
          await page.locator(".alerts-hint").waitFor({ state: "hidden" });
        } else if (!await page.locator('input[name="notification-detail"][value="session"]').isChecked()) {
          throw new Error("visual state: session detail not selected");
        }
      }
      phase = "state";
      if (state === "directory-empty") {
        if (!(await page.locator("body").innerText()).includes("collab.autoStart")) throw new Error("visual state: empty guidance missing");
      } else if (state === "directory-needs-you") {
        if (await page.locator(".working-row").count() !== 3 || await page.locator(".queue-row").count() !== 1 ||
          await page.locator(".queue-hero h2").textContent() !== GATEWAY_WAITING.title) throw new Error("visual state: attention ordering mismatch");
        if (!(await page.locator(".queue-hero .ask-preview").textContent())?.startsWith("Waiting for your input")) throw new Error("visual state: directory preview present");
      } else if (state === "collab-view" || state === "collab-control-ask") {
        await page.locator(state === "collab-view" ? ".working-row" : ".action-request").first().click();
        await page.locator('.conn-chip[data-state="connected"][data-compact="true"]').waitFor();
        await page.locator(".sh-transcript").getByText("Synthetic layout review", { exact: true }).waitFor();
        await page.locator(".sh-transcript pre code").waitFor();
        if (state === "collab-view") {
          await page.getByRole("button", { name: "Control", exact: true }).waitFor();
          if (await page.locator(".sh-composer-input").isEditable()) throw new Error("visual state: writable view composer");
        } else {
          await page.locator(".sh-composer-ask-embedded").waitFor();
          await page.locator(".sh-ask-option-checked .sh-ask-option-recommended").waitFor();
          await page.locator(".sh-ask-send:enabled").waitFor();
          await page.locator('.triage-bar[data-kind="hold"]').waitFor();
        }
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        // The build identity is intentionally not a visual baseline input.
        const build = document.querySelector(".sheet-build code");
        if (build !== null) build.textContent = "synthetic-build";
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
        window.scrollTo(0, 0);
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      phase = "geometry";
      const source = await geometry(page);
      if (source.overflow) { phase = "source-overflow"; throw new Error("visual geometry: overflow"); }
      if (unexpectedRequests !== 0) { phase = "source-network"; throw new Error("visual geometry: external request"); }
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error("visual geometry: missing viewport");
      if (viewport.width === 1280) {
        const [directory, column, transcript, back] = source.boxes;
        if (state.startsWith("collab-")) {
          // Ask intentionally uses the client's bounded embedded body; 900px is the normal View contract.
          if (!column || !transcript || (state === "collab-view" && Math.abs(transcript.width - 900) > 1)) { phase = "source-transcript"; throw new Error("visual geometry: session column mismatch"); }
          if (!back || Math.abs(back.x - column.x) > 1) { phase = "source-header"; throw new Error("visual geometry: session header mismatch"); }
        } else if (!directory || Math.abs(directory.width - 560) > 1) throw new Error("visual geometry: directory column mismatch");
      }
      phase = "guard";
      const options = snapshotOptions(viewport.width, viewport.height);
      if (state === "directory-empty") await validateNegativeGuards(browser, fixture, roomKey, value => { phase = value; });
      phase = "guard";
      const serialized = await validateSnapshot(page, fixture, options);
      // Check the actual serialized HTML with JS off, without another server or inert-copy exporter.
      const parityContext = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC", javaScriptEnabled: false, serviceWorkers: "block" });
      try {
        await parityContext.route("**/*", async route => {
          const url = route.request().url();
          const resource = serialized.resources.find(value => value.url === url);
          if (resource !== undefined) await route.fulfill({ contentType: resource.mimetype, body: Buffer.from(resource.content, resource.mimetype.includes("text") ? "utf8" : "base64") });
          else if (new URL(url).origin === fixture.origin) await route.continue();
          else { unexpectedRequests++; await route.abort("blockedbyclient"); }
        });
        const parityPage = await parityContext.newPage();
        await parityPage.goto(fixture.origin, { waitUntil: "domcontentloaded" });
        await parityPage.setContent(serialized.html, { waitUntil: "load" });
        // @percy/dom stamps native modal state for Percy's renderer to restore, even with app JS off.
        await parityPage.evaluate(() => {
          for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[data-percy-dialog-modal]")) {
            dialog.removeAttribute("open");
            dialog.showModal();
          }
          // Restore the serializer's recorded scroll offsets after native modal autofocus.
          window.scrollTo(0, 0);
          for (const element of document.querySelectorAll<HTMLElement>("[data-percy-scrolltop], [data-percy-scrollleft]")) {
            element.scrollTop = Number(element.getAttribute("data-percy-scrolltop") ?? 0);
            element.scrollLeft = Number(element.getAttribute("data-percy-scrollleft") ?? 0);
          }
        });
        await parityPage.evaluate(async () => document.fonts.ready);
        const copy = await geometry(parityPage);
        if (copy.overflow) { phase = "parity-overflow"; throw new Error("visual geometry: serialized overflow"); }
        const labels = ["directory", "column", "transcript", "header", "ask", "triage", "settings"];
        const equal = source.boxes.every((box, index) => {
          const other = copy.boxes[index];
          const matches = box === null || other == null ? box === other
            : ["x", "y", "width", "height"].every(key => Math.abs(box[key as keyof typeof box] - other[key as keyof typeof other]) <= 1);
          if (!matches) {
            const metric = box === null || other == null ? "" : ["x", "y", "width", "height"].find(key => Math.abs(box[key as keyof typeof box] - other[key as keyof typeof other]) > 1);
            phase = `parity-${labels[index]}${index === 0 && metric ? `-${metric}` : ""}`;
          }
          return matches;
        });
        if (!equal || unexpectedRequests !== 0) throw new Error("visual geometry: serialized parity mismatch");
      } finally { await parityContext.close(); }
      if (process.env.OMP_VISUAL_MODE === "upload") {
        phase = "submit";
        await submitSnapshot(page, `${state} / ${info.project.name}`, fixture, options);
        info.annotations.push({ type: "visual-submitted", description: "accepted" });
      } else if (process.env.OMP_VISUAL_MODE !== "local") throw new Error("visual mode: closed mode required");
    } catch (error) {
      // Playwright must never get a browser error, locator excerpt, unsafe message or cause.
      info.annotations.push({ type: "visual-phase", description: phase });
      const reason = error instanceof Error ? /^visual upload: submission failed \(([a-z-]+)\)$/u.exec(error.message)?.[1] : undefined;
      if (reason && Object.hasOwn(VISUAL_UPLOAD_REASONS, reason)) info.annotations.push({ type: "visual-upload-reason", description: reason });
      throw new Error("visual validation failed");
    } finally {
      await context.close();
      await fixture.stop();
    }
  });
}
