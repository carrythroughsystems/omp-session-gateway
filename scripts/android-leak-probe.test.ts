import { describe, expect, test } from "bun:test";
import { PAGE_PRELUDE } from "./android-leak-probe.ts";
import { leakSweepExpression } from "./browser-journey.ts";

const NEEDLE = "SYNTHETIC-NOTIFICATION-LEAK-CONTROL";
const GLOBALS = ["localStorage", "sessionStorage", "document", "caches", "indexedDB", "location", "history", "performance", "navigator", "fetch"];

type ScanSinks = (
  hit: (value: unknown) => boolean,
  note: (sink: string, detail?: string) => void,
) => Promise<void>;

/** The only content of an otherwise empty page. */
interface Page {
  readonly registration?: object;
  readonly cacheNames?: readonly string[];
  readonly databaseNames?: readonly string[];
  readonly fetch?: (url: string) => Promise<Response>;
}

function inPage<T>(body: string, page: Page): T {
  const openDatabase = () => {
    const request: { result: object; onsuccess?: () => void } = { result: { objectStoreNames: [], close: () => {} } };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };
  const run = new Function(...GLOBALS, body) as (...globals: unknown[]) => T;
  return run(
    { length: 0 },
    { length: 0 },
    { cookie: "", referrer: "", documentElement: { outerHTML: "<html></html>" } },
    { keys: async () => page.cacheNames ?? [], open: async () => ({ keys: async () => [] }) },
    { databases: async () => (page.databaseNames ?? []).map(name => ({ name })), open: openDatabase },
    { href: "https://gateway.example/", hash: "", search: "" },
    { state: null },
    { getEntriesByType: () => [] },
    { serviceWorker: { getRegistration: async () => page.registration ?? {} } },
    page.fetch ?? (async () => {
      throw new Error("this page has no network");
    }),
  );
}

async function scan(page: Page): Promise<readonly string[]> {
  const scanSinks = inPage<ScanSinks>(`${PAGE_PRELUDE}\nreturn scanSinks;`, page);
  const findings: string[] = [];
  await scanSinks(
    value => typeof value === "string" && value.includes(NEEDLE),
    sink => findings.push(sink),
  );
  return findings;
}

describe("capability sink scanning", () => {
  test("completes a clean sink scan when an iOS Safari tab registration has no getNotifications", async () => {
    await expect(scan({ registration: {} })).resolves.toEqual([]);
  });

  test("detects a notification body containing the needle", async () => {
    const findings = await scan({
      registration: { getNotifications: async () => [{ title: "Session attention", body: `Prompt: ${NEEDLE}`, data: null }] },
    });
    expect(findings).toEqual(["notificationBody"]);
  });

  test("detects the needle in a cache name and in a database name", async () => {
    expect(await scan({ cacheNames: ["app-shell", `shell-${NEEDLE}`], databaseNames: [`collab-${NEEDLE}`] })).toEqual([
      "cacheName",
      "indexedDbName",
    ]);
  });
});

describe("the sweep a vendor-logged driver runs", () => {
  const LABEL = "omp-sweep-fixture";
  const KEY = "SYNTHETIC-SWEEP-KEY-3b8e1d6f0a2c";
  const LINK = `omp-synthetic://relay/SYNTHETIC-SWEEP-ROOM-7a4c/${KEY}`;

  test("reports sinks and counts, never the page text that held the link", async () => {
    const out = await inPage<Promise<Record<string, unknown>>>(`return ${leakSweepExpression(LABEL, { detail: false })};`, {
      cacheNames: ["app-shell", `shell-${KEY}`],
      databaseNames: [`collab-${KEY}`],
      fetch: async url =>
        url === "/api/v1/sessions"
          ? Response.json({ sessions: [{ cwdLabel: LABEL, instanceId: "instance-sweep", generation: 3, canView: true, canControl: true }] })
          : Response.json({ capability: LINK }, { headers: { "cache-control": "no-store" } }),
    });
    expect(out).toMatchObject({
      launchStatus: 200,
      launchNoStore: true,
      cacheCount: 2,
      indexedDbCount: 1,
      findings: ["cacheBody", "indexedDB"],
      findingCount: 2,
    });
    expect(Object.keys(out)).not.toContain("cacheNames");
    expect(JSON.stringify(out)).not.toContain("SYNTHETIC-SWEEP");
  });

  test.each([
    ["missing target", { sessions: [{ cwdLabel: KEY }] }, undefined, { error: "target-not-published" }],
    ["untrusted launch keys", { sessions: [{ cwdLabel: LABEL, instanceId: "instance-safe", generation: 1 }] }, { [KEY]: LINK }, { error: "invalid-launch-payload", launchNoStore: true, launchStatus: 200 }],
  ])("minimizes vendor results for %s", async (_name, listing, launch, expected) => {
    const out = await inPage<Promise<Record<string, unknown>>>(`return ${leakSweepExpression(LABEL, { detail: false })};`, {
      fetch: async url => url === "/api/v1/sessions" ? Response.json(listing) :
        Response.json(launch, { headers: { "cache-control": `no-store, ${KEY}` } }),
    });
    expect(out).toEqual(expected);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});
