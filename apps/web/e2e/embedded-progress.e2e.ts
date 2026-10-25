import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { CollabEmbedState } from "../../../packages/collab-client/upstream/src/embed-contract";
import { startDashboardFixture, type DashboardFixture } from "./fixture-server";
import { GATEWAY_WORKING, installSyntheticProductFixture } from "./synthetic-product-fixture";

const FIRST_TASK = "SYNTHETIC_FIRST_TASK_MEMORY_ONLY_5eb931";
interface ProgressHarness {
  takes: number;
  publications: number;
  mutations: number;
  copies: string[];
  state: CollabEmbedState | null;
  publish(patch: Partial<CollabEmbedState>): void;
  observer?: MutationObserver;
  held?: boolean;
}
interface ProgressGlobals {
  __ompProgress: ProgressHarness;
  __ompTakeProgressDraft(): string | undefined;
  __ompSyntheticSocket: {
    snapshotEntries: unknown[];
    sendSnapshotChunk(count: number, final?: boolean): Promise<void>;
    sendHostFrame(frame: unknown): Promise<void>;
    disconnect(): void;
  };
  __ompPreviousProgressSocket?: ProgressGlobals["__ompSyntheticSocket"];
  __ompSyntheticGuestCounts: { prompts: number; responses: number };
}

async function installProgressHarness(context: BrowserContext): Promise<void> {
  await context.addInitScript(firstTask => {
    const globals = globalThis as typeof globalThis & ProgressGlobals;
    let draft: string | undefined = firstTask;
    globals.__ompProgress = { takes: 0, publications: 0, mutations: 0, copies: [], state: null, publish: () => { throw new Error("client has not mounted"); } };
    globals.__ompTakeProgressDraft = () => {
      globals.__ompProgress.takes += 1;
      const next = draft;
      draft = undefined;
      return next;
    };
  }, FIRST_TASK);
  // Exercise the public embed callbacks with the real built client, independently of creation UI.
  // Only a function reference crosses this wrapper; no task or capability is placed in an asset.
  await context.route(/\/assets\/collab-client\.[a-f0-9]+\.js(?:\?.*)?$/u, async route => {
    const original = new URL(route.request().url());
    if (original.searchParams.has("progress-original")) { await route.continue(); return; }
    original.search = "?progress-original=1";
    await route.fulfill({ contentType: "text/javascript", body: `
      import { startCollabWithCapability as start } from ${JSON.stringify(original.href)};
      export function startCollabWithCapability(container, capability, onDispose, options = {}) {
        const harness = globalThis.__ompProgress;
        const forward = state => { harness.state = state; harness.publications += 1; options.onStateChange?.(state); };
        // While held, the real client's own publications are recorded but not forwarded, so a
        // synthetic case cannot be overwritten by a late client state change.
        const publish = state => { if (harness.held) { harness.state = state; return; } forward(state); };
        harness.publish = patch => forward({ ...harness.state, ...patch });
        return start(container, capability, onDispose, { ...options, onStateChange: publish,
          takeInitialPromptDraft: globalThis.__ompTakeProgressDraft });
      }
    ` });
  });
}

async function chunk(page: Page, count: number, final = false): Promise<void> {
  await page.evaluate(async ({ count, final }) => {
    await (globalThis as typeof globalThis & ProgressGlobals).__ompSyntheticSocket.sendSnapshotChunk(count, final);
  }, { count, final });
}

async function observeChip(page: Page): Promise<void> {
  await page.locator(".conn-chip").evaluate(chip => {
    const h = (globalThis as typeof globalThis & ProgressGlobals).__ompProgress;
    h.observer?.disconnect();
    h.copies = [chip.textContent ?? ""];
    h.mutations = 0;
    h.observer = new MutationObserver(records => {
      h.mutations += records.length;
      h.copies.push(chip.textContent ?? "");
    });
    h.observer.observe(chip, { subtree: true, childList: true, characterData: true });
  });
}

async function assertPrivate(page: Page, fixture: DashboardFixture): Promise<void> {
  fixture.assertNoCapabilityMaterial(await page.content());
  fixture.assertNoCapabilityMaterial(JSON.stringify(fixture.requests));
  const persisted = await page.evaluate(async () => {
    const cacheRecords: unknown[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        cacheRecords.push([request.url, response === undefined ? "" : await response.text()]);
      }
    }
    return JSON.stringify({ url: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie, cacheRecords });
  });
  fixture.assertNoCapabilityMaterial(persisted);
  expect(persisted.includes(FIRST_TASK)).toBe(false);
}

async function setup(context: BrowserContext, page: Page): Promise<DashboardFixture> {
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([GATEWAY_WORKING], { roomKey: key });
  await page.setViewportSize({ width: 412, height: 915 });
  await installSyntheticProductFixture(context, key, {
    transcript: "Synthetic snapshot join", historyEntryCount: 99, activeAsk: false,
    manualSnapshot: true, randomSeed: 42,
  });
  await context.route("**/*", async route => {
    if (new URL(route.request().url()).origin === fixture.origin) await route.fallback();
    else await route.abort("blockedbyclient");
  });
  await installProgressHarness(context);
  await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
  await page.locator(".working-row").first().click();
  await expect(page.locator(".conn-chip")).toHaveText("Joining session… 0%");
  await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "connecting");
  return fixture;
}

test("chunked join and reconnect announce progress once, and Control accepts but never sends the first draft", async ({ context, page }, info) => {
  let errors = 0;
  let taskRequests = 0;
  page.on("pageerror", () => { errors += 1; });
  page.on("console", message => { if (message.type() === "error") errors += 1; });
  page.on("request", request => { if (`${request.url()} ${request.postData() ?? ""}`.includes(FIRST_TASK)) taskRequests += 1; });
  const fixture = await setup(context, page);
  try {
    await observeChip(page);
    await chunk(page, 43);
    await expect(page.locator(".conn-chip")).toHaveText("Joining session… 43%");
    const screenshots = process.env.OMP_PROGRESS_SCREENSHOTS;
    if (screenshots !== undefined) {
      await assertPrivate(page, fixture);
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, `${info.project.name}-after-412x915-mid-join.png`), animations: "disabled" });
    }
    const beforeDuplicate = await page.evaluate(() => {
      const h = (globalThis as typeof globalThis & ProgressGlobals).__ompProgress;
      return { publications: h.publications, mutations: h.mutations };
    });
    await chunk(page, 0);
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.publications)).toBeGreaterThan(beforeDuplicate.publications);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.mutations)).toBe(beforeDuplicate.mutations);
    await chunk(page, 31);
    await expect(page.locator(".conn-chip")).toHaveText("Joining session… 74%");
    await chunk(page, 26, true);
    await expect(page.locator(".conn-chip")).toHaveText("Connected");
    expect(await page.evaluate(() => (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.copies)).toEqual([
      "Joining session… 0%", "Joining session… 43%", "Joining session… 74%", "Connected",
    ]);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.takes)).toBe(0);
    await expect(page.locator(".sh-composer-input")).not.toBeEditable();

    await page.locator(".shell-control").click();
    await expect(page.locator(".conn-chip")).toHaveText("Joining session… 0%");
    await observeChip(page);
    await chunk(page, 43);
    await expect(page.locator(".conn-chip")).toHaveText("Joining session… 43%");
    await chunk(page, 57, true);
    await expect(page.locator(".conn-chip")).toHaveText("Connected");
    await expect(page.locator(".sh-composer-input")).toHaveValue(FIRST_TASK);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.takes)).toBe(1);
    await page.locator(".sh-composer-input").fill("");
    await page.evaluate(async () => {
      await (globalThis as typeof globalThis & ProgressGlobals).__ompSyntheticSocket.sendHostFrame({
        t: "ui-request", request: { kind: "editor", reqId: 9, title: "Synthetic Ask", prefill: "Ask keeps its own text" },
      });
    });
    await expect(page.locator(".sh-composer-input")).toHaveValue("Ask keeps its own text");
    await page.evaluate(async () => {
      await (globalThis as typeof globalThis & ProgressGlobals).__ompSyntheticSocket.sendHostFrame({ t: "ui-request-end", reqId: 9 });
    });
    await expect(page.locator(".sh-composer-input")).toHaveValue("");
    await page.evaluate(() => {
      const g = globalThis as typeof globalThis & ProgressGlobals;
      g.__ompPreviousProgressSocket = g.__ompSyntheticSocket;
      g.__ompSyntheticSocket.disconnect();
    });
    await expect(page.locator(".conn-chip")).toHaveText("Reconnecting…");
    await expect.poll(() => page.evaluate(() => {
      const g = globalThis as typeof globalThis & ProgressGlobals;
      return g.__ompSyntheticSocket !== g.__ompPreviousProgressSocket && g.__ompSyntheticSocket.snapshotEntries.length === 100;
    })).toBe(true);
    await expect(page.locator(".conn-chip")).toHaveText("Reconnecting… 0%");
    await expect(page.locator(".sh-transcript")).toContainText("Synthetic snapshot join");
    await chunk(page, 43);
    await expect(page.locator(".conn-chip")).toHaveText("Reconnecting… 43%");
    await chunk(page, 57, true);
    await expect(page.locator(".conn-chip")).toHaveText("Connected");
    await expect(page.locator(".sh-composer-input")).toHaveValue("");
    expect(await page.evaluate(() => (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.copies)).toEqual([
      "Joining session… 0%", "Joining session… 43%", "Connected", "Reconnecting…", "Reconnecting… 0%", "Reconnecting… 43%", "Connected",
    ]);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.takes)).toBe(1);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & ProgressGlobals).__ompSyntheticGuestCounts)).toEqual({ prompts: 0, responses: 0 });
    expect(fixture.launchRequests.map(request => request.mode)).toEqual(["view", "control"]);
    await assertPrivate(page, fixture);
    expect(errors).toBe(0);
    expect(taskRequests).toBe(0);
  } finally { await fixture.stop(); }
});

test("progress floors and clamps percentages, clears null, and yields to forbidden, ended and sustained outages", async ({ context, page }) => {
  const fixture = await setup(context, page);
  try {
    // Hold the real client's own publications so a late one cannot overwrite a synthetic case.
    await page.evaluate(() => { (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.held = true; });
    for (const [received, total, suffix] of [
      [3, 7, " 42%"], [-10, 100, " 0%"], [150, 100, " 100%"],
      [Number.MAX_VALUE, Number.MIN_VALUE, " 100%"], [1, 0, ""], [1, -1, ""],
      [1, Number.NaN, ""], [1, Number.POSITIVE_INFINITY, ""], [Number.NaN, 100, ""],
    ] as const) {
      await page.evaluate(({ received, total }) => {
        (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.publish({ loading: { received, total } });
      }, { received, total });
      await expect(page.locator(".conn-chip")).toHaveText(`Joining session…${suffix}`);
    }
    await page.evaluate(() => (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.publish({ loading: null }));
    await expect(page.locator(".conn-chip")).toHaveText("Connecting…");
    await page.evaluate(() => { (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.held = false; });
    await chunk(page, 100, true);
    await expect(page.locator(".conn-chip")).toHaveText("Connected");
    await page.evaluate(() => {
      const h = (globalThis as typeof globalThis & ProgressGlobals).__ompProgress;
      h.publish({ phase: "reconnecting", loading: { received: 43, total: 100 }, gatewayHealth: { ...h.state!.gatewayHealth, state: "degraded", failureSince: Date.now() } });
    });
    await expect(page.locator(".conn-chip")).toHaveText("Reconnecting…");
    await page.evaluate(() => {
      const now = Date.now();
      Date.now = () => now + 3_001;
      (globalThis as typeof globalThis & ProgressGlobals).__ompProgress.publish({ loading: { received: 50, total: 100 } });
    });
    await expect(page.locator(".conn-chip")).toHaveText("Gateway unavailable");
    await expect(page.locator(".triage-copy")).toHaveText("Reconnecting automatically…");
    await page.evaluate(() => {
      const h = (globalThis as typeof globalThis & ProgressGlobals).__ompProgress;
      h.publish({ phase: "ended", endedReason: "Session exited with code 0", gatewayHealth: { ...h.state!.gatewayHealth, state: "healthy", failureSince: null } });
    });
    await expect(page.locator(".conn-chip")).toHaveText("Ended");
    await page.evaluate(() => {
      const h = (globalThis as typeof globalThis & ProgressGlobals).__ompProgress;
      h.publish({ gatewayHealth: { ...h.state!.gatewayHealth, state: "forbidden" } });
    });
    await expect(page.locator(".conn-chip")).toHaveText("Access withdrawn");
    await expect(page.locator(".triage-action")).toHaveText("Back to Sessions");
    await assertPrivate(page, fixture);
  } finally { await fixture.stop(); }
});
