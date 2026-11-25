import { expect, test, type Page } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import { installSilentWebSocket, startDashboardFixture } from "./fixture-server.ts";

const working: SessionMetadata = {
  instanceId: "stable-session-0000", generation: 1, title: "Stable row",
  startedAt: "2026-10-20T08:00:00.000Z", lastSeenAt: "2026-10-20T08:01:00.000Z",
  canControl: true, canView: true, inputRequired: false,
};
const waiting: SessionMetadata = {
  ...working, inputRequired: true, ask: { requestId: "stable-request-0001", since: working.lastSeenAt },
};

// Wait for delivery on the app's own native stream, including its initial snapshot. A row
// count/text assertion alone could pass before any routine upsert had reached the browser.
async function openDirectory(page: Page, origin: string): Promise<void> {
  await page.clock.setFixedTime(new Date("2026-10-20T09:00:00.000Z"));
  await installSilentWebSocket(page);
  await page.addInitScript(() => {
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        for (const type of ["snapshot", "session_upsert"]) this.addEventListener(type, (event: MessageEvent<string>) => {
          Reflect.set(window, "__directoryTestRevision", JSON.parse(event.data).revision);
        });
      }
    };
  });
  await page.goto(origin);
  await waitForRevision(page, 1);
}

async function waitForRevision(page: Page, revision: number): Promise<void> {
  await page.waitForFunction(expected => Reflect.get(window, "__directoryTestRevision") === expected, revision);
}

test("ten heartbeat upserts remove no directory nodes, including after a list transition", async ({ page }) => {
  const sessions = Array.from({ length: 30 }, (_, i) => ({ ...working, instanceId: `stable-session-${1000 + i}` }));
  const fixture = await startDashboardFixture(sessions);
  try {
    await openDirectory(page, fixture.origin);
    await expect(page.locator(".working-row")).toHaveCount(30);
    const removed = await page.locator("#session-list").evaluateHandle(list => {
      const counts = { removed: 0 };
      new MutationObserver(records => {
        for (const record of records) counts.removed += record.removedNodes.length;
      }).observe(list, { childList: true });
      return counts;
    });
    for (let i = 0; i < 10; i++) {
      fixture.upsert({ ...sessions[0]!, lastSeenAt: `2026-10-20T08:02:0${i}.000Z` });
    }
    await waitForRevision(page, 11);
    expect(await removed.evaluate(c => c.removed)).toBe(0);

    // An ask arriving moves a working row into the queue, then the transition unnames it.
    const ask = { ...waiting, instanceId: sessions[0]!.instanceId };
    fixture.upsert(ask);
    const primary = page.locator(".action-request");
    await expect(primary).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.matches(":active-view-transition"))).toBe(false);
    expect(await removed.evaluate(c => c.removed)).toBeGreaterThan(0);
    const afterTransition = await primary.elementHandle();
    fixture.upsert({ ...ask, lastSeenAt: "2026-10-20T08:03:00.000Z" });
    await waitForRevision(page, 13);
    expect(await afterTransition!.evaluate(button => button.isConnected)).toBe(true);
  } finally { await fixture.stop(); }
});

test("a press that spans an unchanged heartbeat launches exactly once", async ({ page }) => {
  const fixture = await startDashboardFixture([working]);
  try {
    await openDirectory(page, fixture.origin);
    const button = page.locator(".working-row");
    await button.hover();
    await page.mouse.down();
    fixture.upsert({ ...working, lastSeenAt: "2026-10-20T08:02:00.000Z" });
    await waitForRevision(page, 2);
    await page.mouse.up();
    await expect.poll(() => fixture.launchRequests.length).toBe(1);
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    expect(fixture.requests.filter(path => path.endsWith("/launch"))).toHaveLength(1);
  } finally { await fixture.stop(); }
});

test("a refresh resets an imperatively changed launch label without releasing the pending action", async ({ page }) => {
  const fixture = await startDashboardFixture([waiting]);
  const gate = Promise.withResolvers<void>();
  try {
    await openDirectory(page, fixture.origin);
    await page.route("**/launch", async route => { await gate.promise; await route.fulfill({ status: 503, body: "{}" }); });
    const primary = page.locator(".action-request");
    await primary.click();
    await expect(primary).toHaveText("Opening control…");
    fixture.upsert({ ...waiting, lastSeenAt: "2026-10-20T08:02:00.000Z" });
    await waitForRevision(page, 2);
    await expect(primary).toHaveText("Open request");
    await expect(primary).toBeDisabled();
    gate.resolve();
    await expect(primary).toBeEnabled();
  } finally { gate.resolve(); await fixture.stop(); }
});
