import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  startDashboardFixture, creationFixtureOptions, type DashboardFixture, type CreationFixtureConfig,
} from "./fixture-server";
import { GATEWAY_WORKING, installSyntheticProductFixture } from "./synthetic-product-fixture";

const PREFS = "omp.sessions.creation-prefs.v1";
const TASK = ["SYNTHETIC", "FIRST_TASK", "DO_NOT_PERSIST"].join("_");
const readySession = { ...GATEWAY_WORKING, instanceId: "creation-synthetic-0001", generation: 3, title: "Synthetic created session" };
test.beforeEach(async ({}, info) => { test.skip(!info.project.name.startsWith("pixel"), "Pixel lane owns creation coverage"); });

async function capture(page: Page, fixture: DashboardFixture, name: string): Promise<void> {
  fixture.assertNoCapabilityMaterial(await page.content());
  fixture.assertNoCapabilityMaterial(page.url());
  const directory = process.env.OMP_CREATION_SCREENSHOTS;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: join(directory, `${size.width}x${size.height}-${name}.png`), animations: "disabled" });
}

async function panel(page: Page, step: string): Promise<number> {
  const tray = page.locator("#tray");
  await expect(tray).toHaveAttribute("data-panel", `creation-${step}`);
  const current = tray.locator(`.tray-panel[data-panel="creation-${step}"]:not([inert])`);
  await expect(current.locator("h2")).toBeFocused();
  await expect.poll(() => tray.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
  const bounds = await tray.boundingBox();
  expect(bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // A status response can replace the progress panel between the animation and geometry reads.
  await expect.poll(async () => {
    const controls = await current.locator("button").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    return controls.length > 0 && controls.every(height => height >= 48);
  }).toBe(true);
  return bounds!.height;
}

async function review(page: Page): Promise<void> {
  await page.locator("#new-session").click();
  await panel(page, "project");
  await page.getByRole("button", { name: "Synthetic project", exact: true }).click();
  await panel(page, "working-copy");
  await page.getByRole("button", { name: "Main", exact: true }).click();
  await panel(page, "profile");
  await page.getByRole("button", { name: "OMP", exact: true }).click();
  await panel(page, "review");
}

async function privateSinks(page: Page, fixture: DashboardFixture, bodies: readonly string[] = []): Promise<void> {
  const values = await page.evaluate(async () => ({
    url: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie,
    databases: await indexedDB.databases(),
    caches: await Promise.all((await caches.keys()).map(async name => {
      const cache = await caches.open(name);
      return Promise.all((await cache.keys()).map(async request => ({ url: request.url, body: await (await cache.match(request))?.text() })));
    })),
  }));
  const serialized = JSON.stringify({ values, bodies, creation: fixture.creationRequests, launches: fixture.launchRequests });
  fixture.assertNoCapabilityMaterial(serialized);
  expect(serialized.includes(TASK)).toBe(false);
  const prefs = await page.evaluate(key => localStorage.getItem(key), PREFS);
  if (prefs !== null) {
    const choices = JSON.parse(prefs).choices as Record<string, unknown>[];
    for (const choice of choices) expect(Object.keys(choice).sort()).toEqual(["profileId", "projectId", "sourceId", "sourceOrigin", "updatedAt", "workingCopyId"]);
  }
}

for (const viewport of [{ width: 412, height: 915 }, { width: 1280, height: 800 }]) {
  test(`creation wizard to full-screen Control and one-shot task at ${viewport.width}x${viewport.height}`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const key = randomBytes(32);
    const fixture = await startDashboardFixture([], { roomKey: key });
    const remote = await startDashboardFixture([]);
    const opening = Promise.withResolvers<void>();
    await page.route(`**/api/v1/sessions/${readySession.instanceId}/launch`, async route => {
      await opening.promise;
      await route.continue();
    });
    const bodies: string[] = [];
    page.on("request", request => { if (request.url().includes("/api/") && request.postData() !== null) bodies.push(request.postData()!); });
    fixture.configureFleet("Creation host", [{ id: "remote", label: "Other host", origin: remote.origin }], []);
    remote.configureFleet("Other host", [], [fixture.origin]);
    fixture.configureCreation({ readySession });
    try {
      await installSyntheticProductFixture(context, key, { activeAsk: false, randomSeed: 42 });
      await page.goto(fixture.origin);
      await expect(page.locator("#empty-new-session")).toBeVisible();
      await page.locator("#empty-new-session").click();
      const host = await panel(page, "host");
      await capture(page, fixture, "host");
      await page.getByRole("button", { name: "Creation host", exact: true }).click();
      const project = await panel(page, "project");
      await capture(page, fixture, "project");
      await page.getByRole("button", { name: "Synthetic project", exact: true }).click();
      const copy = await panel(page, "working-copy");
      await capture(page, fixture, "working-copy");
      await page.getByRole("button", { name: "Review", exact: true }).click();
      const profile = await panel(page, "profile");
      await capture(page, fixture, "profile");
      await page.getByRole("button", { name: "Careful OMP", exact: true }).click();
      const confirmation = await panel(page, "review");
      await page.getByRole("textbox", { name: "First task (optional)" }).fill(TASK);
      await capture(page, fixture, "review");
      for (const [a, b] of [[host, project], [project, copy], [copy, profile], [profile, confirmation]]) expect(Math.abs(a! - b!)).toBeGreaterThanOrEqual(24);
      // Logical Back replaces one native panel, including consecutive noncancelable native requests.
      await page.locator("#tray").evaluate(element => (element as HTMLDialogElement).requestClose());
      await panel(page, "profile");
      await page.locator("#tray").evaluate(element => (element as HTMLDialogElement).requestClose());
      await panel(page, "working-copy");
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await page.getByRole("button", { name: "Careful OMP", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "First task (optional)" })).toHaveValue(TASK);
      await page.getByRole("button", { name: "Create and open Control", exact: true }).click();
      await panel(page, "progress");
      const steps = page.locator(".creation-step");
      const activeStep = page.locator('.creation-step[aria-current="step"]');
      await expect(steps).toHaveText(["Starting in Tern", "Waiting for OMP", "Opening Control"]);
      await expect(activeStep).toHaveText("Starting in Tern");
      expect(await steps.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.state))).toEqual(["active", "future", "future"]);
      const dot = page.locator('.creation-step[data-state="active"] .creation-step-dot');
      expect(await dot.evaluate(element => getComputedStyle(element, "::before").animationName)).toBe("none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      expect(await dot.evaluate(element => getComputedStyle(element, "::before").animationName)).toBe("status-pulse");
      expect(await dot.evaluate(element => getComputedStyle(element, "::before").animationDuration)).toBe("1.6s");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await capture(page, fixture, "accepted");
      await expect.poll(() => fixture.requests.filter(request => request.startsWith("GET /api/v1/session-creations/")).length).toBeGreaterThanOrEqual(2);
      await expect(activeStep).toHaveText("Starting in Tern");
      await capture(page, fixture, "launching");
      await expect(activeStep).toHaveText("Waiting for OMP");
      expect(await steps.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.state))).toEqual(["done", "active", "future"]);
      await expect(page.locator(".creation-step-check path")).toHaveAttribute("d", "M4 10l4 4 8-8");
      await capture(page, fixture, "awaiting-omp");
      await expect(activeStep).toHaveText("Opening Control");
      expect(await steps.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.state))).toEqual(["done", "done", "active"]);
      await expect(page.locator(".creation-step-check")).toHaveCount(2);
      await expect(page.locator("#tray")).toBeVisible();
      expect(fixture.launchRequests).toHaveLength(0);
      await capture(page, fixture, "opening-control");
      opening.resolve();
      await expect(page).toHaveURL(`${fixture.origin}/client/`);
      await expect(page.locator('.conn-chip[data-state="connected"]')).toBeVisible();
      await expect(page.locator(".sh-composer-input")).toHaveValue(TASK);
      await expect(page.locator(".sh-composer-input")).toBeEditable();
      await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(0);
      expect(fixture.launchRequests).toEqual([{ instanceId: readySession.instanceId, generation: 3, mode: "control" }]);
      expect(fixture.creationRequests).toHaveLength(1);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { __ompSyntheticGuestCounts?: { prompts: number } }).__ompSyntheticGuestCounts?.prompts)).toBe(0);
      await capture(page, fixture, "ready-control");
      await privateSinks(page, fixture, bodies);
      await page.locator(".sh-composer-input").fill("Changed locally, never reseeded");
      await page.locator(".shell-back").click();
      await page.reload();
      await page.locator("#new-session").click();
      await panel(page, "host");
      await expect(page.getByRole("button", { name: "Creation host", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Creation host", exact: true }).click();
      await expect(page.getByRole("button", { name: "Synthetic project", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Synthetic project", exact: true }).click();
      await expect(page.getByRole("button", { name: "Review", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await expect(page.getByRole("button", { name: "Careful OMP", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Careful OMP", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "First task (optional)" })).toHaveValue("");
      expect(fixture.creationRequests).toHaveLength(1);
    } finally { opening.resolve(); await fixture.stop(); await remote.stop(); }
  });
}

const terminalStates: NonNullable<CreationFixtureConfig["states"]> = [
  { state: "failed", error: "preflight_failed" }, { state: "failed", error: "spawn_failed" }, { state: "failed", error: "interrupted" },
  { state: "started_unavailable", error: "adoption_timeout" }, { state: "started_unavailable", error: "correlation_ambiguous" },
  { state: "started_unavailable", error: "control_unavailable" }, { state: "started_unavailable", error: "interrupted" },
  { state: "outcome_unknown", error: "launch_outcome_unknown" }, { state: "outcome_unknown", error: "interrupted" },
];
for (const terminal of terminalStates) {
  test(`creation terminal ${terminal.state}/${terminal.error}`, async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    const fixture = await startDashboardFixture([]);
    fixture.configureCreation({ states: [terminal] });
    try {
      await page.goto(fixture.origin);
      await review(page);
      await page.getByRole("button", { name: "Create and open Control", exact: true }).click();
      await panel(page, "terminal");
      await expect(page.locator(".creation-terminal")).toContainText(terminal.state === "failed" ? "did not start a command"
        : terminal.state === "started_unavailable" ? "Tern started the command, but OMP could not be opened here"
          : "It may have started. Check Tern and the directory before creating another");
      expect(fixture.creationRequests).toHaveLength(1);
      expect(fixture.launchRequests).toHaveLength(0);
      await capture(page, fixture, `${terminal.state}-${terminal.error}`);
      await privateSinks(page, fixture);
    } finally { await fixture.stop(); }
  });
}

for (const missing of [404, "not_configured", "tern_unavailable", "configuration_unavailable", "ledger_unavailable"] as const) {
  test(`creation unavailable ${missing} has explicit options retry`, async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    const fixture = await startDashboardFixture([]);
    fixture.configureCreation({ options: missing === 404 ? 404 : {
      version: 1, revision: creationFixtureOptions.revision, available: false, reason: missing, projects: [], profiles: [],
    } });
    try {
      await page.goto(fixture.origin);
      await page.locator("#new-session").click();
      await panel(page, "terminal");
      await expect(page.getByRole("button", { name: "Create and open Control", exact: true })).toBeDisabled();
      expect(fixture.creationRequests).toHaveLength(0);
      await capture(page, fixture, `unavailable-${missing}`);
      fixture.configureCreation({ readySession });
      await page.getByRole("button", { name: "Retry options", exact: true }).click();
      await panel(page, "project");
      expect(fixture.creationRequests).toHaveLength(0);
    } finally { await fixture.stop(); }
  });
}

test("lost acknowledgement and background resume use only explicit Check, with identical POST replay", async ({ page, context }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const key = randomBytes(32);
  const fixture = await startDashboardFixture([], { roomKey: key });
  fixture.configureCreation({ lostAcknowledgement: true, readySession, states: [{ state: "ready" }] });
  try {
    await installSyntheticProductFixture(context, key, { activeAsk: false });
    await page.goto(fixture.origin);
    await review(page);
    await page.getByRole("textbox", { name: "First task (optional)" }).fill(TASK);
    await page.getByRole("button", { name: "Create and open Control", exact: true }).click();
    await panel(page, "terminal");
    await capture(page, fixture, "lost-acknowledgement");
    expect(fixture.creationRequests).toHaveLength(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("#tray")).toBeHidden();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fixture.creationRequests).toHaveLength(1);
    expect(fixture.launchRequests).toHaveLength(0);
    await page.locator("#new-session").click();
    await panel(page, "terminal");
    await capture(page, fixture, "stopped-watching");
    await page.getByRole("button", { name: "Check creation", exact: true }).click();
    await expect(page.locator(".sh-composer-input")).toHaveValue(TASK);
    expect(fixture.creationRequests).toHaveLength(2);
    expect(fixture.creationRequests[1]).toEqual(fixture.creationRequests[0]);
    await privateSinks(page, fixture);
  } finally { await fixture.stop(); }
});

test("revision mismatch refreshes valid choices and requires another explicit Create", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const fixture = await startDashboardFixture([]);
  fixture.configureCreation({ revisionMismatchOnce: true, states: [{ state: "failed", error: "preflight_failed" }] });
  try {
    await page.goto(fixture.origin);
    await review(page);
    await page.getByRole("button", { name: "Create and open Control", exact: true }).click();
    await panel(page, "project");
    await expect(page.getByRole("button", { name: "Synthetic project", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(fixture.creationRequests).toHaveLength(1);
    await capture(page, fixture, "revision-mismatch");
    await page.getByRole("button", { name: "Synthetic project", exact: true }).click();
    await page.getByRole("button", { name: "Main", exact: true }).click();
    await page.getByRole("button", { name: "OMP", exact: true }).click();
    await page.getByRole("button", { name: "Create and open Control", exact: true }).click();
    await panel(page, "terminal");
    expect(fixture.creationRequests).toHaveLength(2);
    expect(fixture.creationRequests[0]!.clientOperationId).not.toBe(fixture.creationRequests[1]!.clientOperationId);
  } finally { await fixture.stop(); }
});

test("slow options and status responses cannot reopen a closed wizard or launch in the background", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await startDashboardFixture([]);
  fixture.configureCreation({ readySession, delayMs: { options: 300, status: 500 }, states: [{ state: "ready" }] });
  try {
    await page.goto(fixture.origin);
    await page.locator("#new-session").click();
    await expect(page.locator("#tray")).toHaveAttribute("data-panel", "creation-progress");
    await page.getByRole("button", { name: "Close New session", exact: true }).click();
    await expect(page.locator("#tray")).toBeHidden();
    await expect.poll(() => fixture.requests.filter(request => request.endsWith("/session-creation-options")).length).toBe(1);
    await review(page);
    const draft = page.getByRole("textbox", { name: "First task (optional)" });
    await draft.fill("a".repeat(8_001));
    await expect(page.getByRole("button", { name: "Create and open Control", exact: true })).toBeDisabled();
    await expect(draft).toHaveAttribute("aria-invalid", "true");
    await capture(page, fixture, "draft-too-long");
    await draft.fill(TASK);
    await page.getByRole("button", { name: "Create and open Control", exact: true }).click();
    await expect.poll(() => fixture.requests.filter(request => request.startsWith("GET /api/v1/session-creations/")).length).toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("#tray")).toBeHidden();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The fixture publishes only when the delayed status response completes.
    await expect(page.locator(".working-row")).toBeVisible();
    expect(fixture.launchRequests).toHaveLength(0);
    await page.locator("#new-session").click();
    await panel(page, "terminal");
    expect(fixture.creationRequests).toHaveLength(1);
    await page.getByRole("button", { name: "Close Stopped watching", exact: true }).click();
    await privateSinks(page, fixture);
  } finally { await fixture.stop(); }
});

test("remote source creation uses CORS and omitted credentials through ordinary Control launch", async ({ page, context }) => {
  const key = randomBytes(32);
  const home = await startDashboardFixture([]);
  const remote = await startDashboardFixture([], { roomKey: key });
  home.configureFleet("Home", [{ id: "remote", label: "Remote", origin: remote.origin }], []);
  remote.configureFleet("Remote", [], [home.origin]);
  remote.configureCreation({ readySession, states: [{ state: "ready" }] });
  try {
    await installSyntheticProductFixture(context, key, { activeAsk: false });
    await context.addCookies([{ name: "synthetic_not_forwarded", value: "private-cookie", url: remote.origin }]);
    await page.goto(home.origin);
    await page.locator("#host-picker").selectOption(`remote\0${remote.origin}`);
    await page.locator("#new-session").click();
    await expect(page.getByRole("button", { name: "Remote", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Remote", exact: true }).click();
    await page.getByRole("button", { name: "Synthetic project", exact: true }).click();
    await page.getByRole("button", { name: "Main", exact: true }).click();
    await page.getByRole("button", { name: "OMP", exact: true }).click();
    await page.getByRole("button", { name: "Create and open Control", exact: true }).click();
    await expect(page.locator('.conn-chip[data-state="connected"]')).toBeVisible();
    expect(home.creationRequests).toHaveLength(0);
    expect(remote.creationRequests).toHaveLength(1);
    const creation = remote.requestLog.filter(request => request.path.includes("/session-creation"));
    expect(creation.some(request => request.method === "OPTIONS")).toBe(true);
    for (const request of creation) {
      expect(request.origin).toBe(home.origin);
      expect(request.fetchMode).toBe("cors");
      expect(request.credentialsPresent).toBe(false);
    }
    expect(remote.launchRequests[0]?.mode).toBe("control");
    await privateSinks(page, remote);
  } finally { await home.stop(); await remote.stop(); }
});
