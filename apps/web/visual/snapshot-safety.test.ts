import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import type percySnapshot from "@percy/playwright";
import { startDashboardFixture, type DashboardFixture } from "../e2e/fixture-server.ts";
import { INITIAL_SESSIONS } from "../e2e/synthetic-product-fixture.ts";
import { assertSerializedSnapshotSafe, snapshotOptions, submitSnapshot } from "./snapshot-safety.ts";

let fixture: DashboardFixture;
let canary = "";
let room = "";
let key = "";

beforeAll(async () => {
  fixture = await startDashboardFixture(INITIAL_SESSIONS);
  const response = await fetch(`${fixture.origin}/api/v1/sessions/${INITIAL_SESSIONS[0].instanceId}/launch`, { method: "POST", body: JSON.stringify({ generation: 1, mode: "control" }) });
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || !("capability" in body) || typeof body.capability !== "string") throw new Error("test fixture launch failed");
  canary = body.capability;
  const pieces = canary.split(".");
  room = pieces[0] ?? "";
  // Control encodes the same 32-byte key followed by authority bytes.
  key = Buffer.from(pieces[1] ?? "", "base64url").subarray(0, 32).toString("base64url");
});

afterAll(async () => {
  canary = ""; room = ""; key = "";
  await fixture?.stop();
});

function rejectedWithoutEcho(action: () => void, planted: string): void {
  let rejected = false;
  let echoed = false;
  try { action(); }
  catch (error) {
    rejected = true;
    const diagnostic = error instanceof Error ? `${error.message}\n${error.stack ?? ""}\n${String(error.cause ?? "")}` : String(error);
    echoed = diagnostic.includes(planted);
  }
  expect(rejected).toBe(true);
  expect(echoed).toBe(false);
}

test("fixture keeps authority closure-owned and rejects full material, every segment and mixed escapes", () => {
  expect(Object.entries(fixture).some(([name, value]) => typeof value !== "function" && /capability|key|room/iu.test(name))).toBe(false);
  for (const value of [canary, room, key]) {
    for (let index = 0; index + 16 <= value.length; index++) {
      const segment = value.slice(index, index + 16);
      for (const encoded of [segment, encodeURIComponent(segment), JSON.stringify(segment),
        [...segment].map(character => `%${character.charCodeAt(0).toString(16)}`).join(""),
        [...segment].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
        [...segment].map(character => `&#${character.charCodeAt(0)};`).join(""),
        [...segment].map((character, offset) => offset % 2 === 0 ? `&#x${character.charCodeAt(0).toString(16)};` : character).join("")]) {
        rejectedWithoutEcho(() => fixture.assertNoCapabilityMaterial(encoded), segment);
      }
    }
  }
  fixture.assertNoCapabilityMaterial("authored synthetic fixture prose");
});

test("hidden attributes, materialized form values, inline styles and text all fail without echo", () => {
  const segment = canary.slice(4, 20);
  for (const html of [
    `<input hidden data-synthetic-canary="${segment}">`,
    `<input hidden value="${segment}">`,
    `<p style='--synthetic-canary: "${segment}"'></p>`,
    `<p hidden>${segment}</p>`,
  ]) rejectedWithoutEcho(() => assertSerializedSnapshotSafe({ html, resources: [] }, fixture), segment);
});

test("every serialized resource and decoded bytes are checked, including identifiers and serializer diagnostics", () => {
  for (const snapshot of [
    { html: "<p>synthetic</p>", resources: [{ url: "http://render.percy.local/__serialized__/style.css", mimetype: "text/css", content: `/* ${canary} */` }] },
    { html: "<p>synthetic</p>", resources: [{ url: "http://render.percy.local/__serialized__/image.svg", mimetype: "image/svg+xml", content: Buffer.from(`<svg data-value="${key}"></svg>`).toString("base64") }] },
    { html: "<p>synthetic</p>", resources: [], warnings: [canary] },
    { html: `<p>${["fixture-private", "sensitive-net", "ts", "net"].join(".")}</p>`, resources: [] },
  ]) rejectedWithoutEcho(() => assertSerializedSnapshotSafe(snapshot, fixture), canary);
  assertSerializedSnapshotSafe({ html: "<p>authored synthetic text</p>", resources: [], warnings: [] }, fixture);
});

test("unreviewed serialized resource origins and endpoints fail before submission", () => {
  for (const url of ["https://external.example.test/image.png", "http://127.0.0.1/api/v1/sessions"]) {
    rejectedWithoutEcho(() => assertSerializedSnapshotSafe({ html: "<p>synthetic</p>", resources: [{ url, mimetype: "text/css", content: "p {}" }] }, fixture), canary);
  }
});

test("built production assets contain no Percy package or credential hooks", async () => {
  const assets = new URL("../dist/assets/", import.meta.url);
  for (const name of await readdir(assets)) {
    if (!/\.(?:js|css)$/u.test(name)) continue;
    const text = await readFile(new URL(name, assets), "utf8");
    expect(/@percy\/|PERCY_TOKEN|PERCY_SERVER_ADDRESS/u.test(text)).toBe(false);
  }
});

test("last-mile SDK guard rejects swallowed errors, warnings, no-ops and mutated snapshots", async () => {
    // Injected SDK callbacks never access a browser; browser-dependent negatives run in test:visual.
    const page = {} as Page;
    let uploads = 0;
    const sdk = {
      request: { post: async (_path: string, _data: Record<string, unknown>) => { uploads++; return { body: { success: true } }; } },
      logger: { log: (_namespace: string, _level: string, _message: unknown): unknown => undefined },
    };
    const valid = { html: "<p>synthetic</p>", resources: [], warnings: [] };
    const callbacks: Array<typeof percySnapshot> = [
      async () => undefined,
      async () => { sdk.logger.log("playwright", "warn", canary); return undefined; },
      async () => { try { await sdk.request.post("/percy/snapshot", { domSnapshot: { ...valid, html: canary } }); } catch {} return undefined; },
    ];
    for (const callback of callbacks) {
      await expect(submitSnapshot(page, "directory-empty / visual-phone-390x844", fixture, snapshotOptions(390, 844), callback, sdk)).rejects.toThrow("visual upload: submission failed");
    }
    expect(uploads).toBe(0);
    await submitSnapshot(page, "directory-empty / visual-phone-390x844", fixture, snapshotOptions(390, 844), async () => {
      await sdk.request.post("/percy/snapshot", { domSnapshot: valid });
      return undefined;
    }, sdk);
    expect(uploads).toBe(1);
});
