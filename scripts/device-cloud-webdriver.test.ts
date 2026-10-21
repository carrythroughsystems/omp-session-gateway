import { afterEach, expect, spyOn, test } from "bun:test";
import { WebDriverSession, endWebDriverSession } from "./device-cloud-webdriver.ts";

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); });
const username = "synthetic-user", password = "synthetic-password", id = "a".repeat(40);

test.each(["testingbot", "browserstack"] as const)("%s creation writes once and never falls back after a primary failure", async vendor => {
  const calls: string[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return Response.json({ value: { error: "session not created", message: "SYNTHETIC-VENDOR-SECRET-DO-NOT-REFLECT" } }, { status: 503 });
  }, { preconnect: () => {} }));
  restore = () => mock.mockRestore();
  let checkpointed = false;
  const error = await WebDriverSession.create(vendor, username, password, {}, async () => { checkpointed = true; }).catch((error: unknown) => error);
  expect(calls).toEqual([`https://hub.${vendor}.com/wd/hub/session`]);
  expect(checkpointed).toBe(false);
  expect(String(error)).not.toContain("SYNTHETIC-VENDOR-SECRET");
});

test("BrowserStack HTTP-200 schema refusal is not a successful allocation", async () => {
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ status: 13, sessionId: "", value: { message: "synthetic refusal" } }), { preconnect: () => {} }));
  restore = () => mock.mockRestore();
  await expect(WebDriverSession.create("browserstack", username, password, {}, async () => { throw new Error("must not checkpoint"); })).rejects.toThrow("HTTP 200");
  expect(mock).toHaveBeenCalledTimes(1);
});

test("BrowserStack checkpoints before further commands and keeps authorization private", async () => {
  const effects: string[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(url)).username).toBe("");
    effects.push(init?.method + " " + new URL(String(url)).pathname);
    return Response.json(effects.length === 1 ? { value: { sessionId: id, capabilities: { platformName: "iOS" } } } : { value: null });
  }, { preconnect: () => {} }));
  restore = () => mock.mockRestore();
  const created = await WebDriverSession.create("browserstack", username, password, {}, async sessionId => { expect(sessionId).toBe(id); effects.push("checkpoint"); });
  expect(effects).toEqual(["POST /wd/hub/session", "checkpoint", `POST /wd/hub/session/${id}/timeouts`]);
  expect(JSON.stringify(created.session)).not.toContain(password);
  expect(JSON.stringify(created.session)).not.toContain(btoa(`${username}:${password}`));
  await endWebDriverSession("browserstack", username, password, id);
  expect(effects.at(-1)).toBe(`DELETE /wd/hub/session/${id}`);
});

test("failed BrowserStack ownership checkpoint ends the known session before any navigation", async () => {
  const methods: string[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return Response.json({ value: methods.length === 1 ? { sessionId: id, capabilities: {} } : null });
  }, { preconnect: () => {} }));
  restore = () => mock.mockRestore();
  await expect(WebDriverSession.create("browserstack", username, password, {}, async () => { throw new Error("checkpoint failed"); })).rejects.toThrow("checkpoint failed");
  expect(methods).toEqual(["POST", "DELETE"]);
});

// TestingBot's real iPhone hub (observed 2026-10-20, iPhone 16 and 17 Pro Max on iOS 26) answers
// with a W3C `value` and also echoes the session id at the top level.
const TESTINGBOT_ID = "tb-synthetic-session-0001";
const IPHONE = { platformName: "iOS", browserName: "safari", platform: "MAC", deviceName: "iPhone 16", platformVersion: "26.5" };
test.each([
  ["hybrid W3C with a top-level id", { sessionId: TESTINGBOT_ID, status: 0, value: { sessionId: TESTINGBOT_ID, capabilities: IPHONE } }],
  ["plain W3C", { value: { sessionId: TESTINGBOT_ID, capabilities: IPHONE } }],
  ["JSON Wire Protocol", { sessionId: TESTINGBOT_ID, status: 0, value: IPHONE }],
])("TestingBot %s session start yields the allocated capabilities", async (_shape, body) => {
  let calls = 0;
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json(calls++ === 0 ? body : { value: null }), { preconnect: () => {} }));
  restore = () => mock.mockRestore();
  const checkpoints: string[] = [];
  const created = await WebDriverSession.create("testingbot", username, password, {}, async sessionId => { checkpoints.push(sessionId); });
  expect(checkpoints).toEqual([TESTINGBOT_ID]);
  expect(created.session.id).toBe(TESTINGBOT_ID);
  expect(created.capabilities).toMatchObject({ platformName: "iOS", browserName: "safari", deviceName: "iPhone 16" });
});

test.each([IPHONE, undefined, null, [], "SYNTHETIC_INVALID_CAPABILITIES", false, 42])("a session start naming two different ids is unidentified regardless of capabilities: %j", async capabilities => {
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () =>
    Response.json({ sessionId: TESTINGBOT_ID, status: 0, value: { sessionId: "tb-synthetic-session-0002", capabilities } }), { preconnect: () => {} }));
  restore = () => mock.mockRestore();
  await expect(WebDriverSession.create("testingbot", username, password, {}, async () => { throw new Error("must not checkpoint"); }))
    .rejects.toThrow("two session ids");
  expect(mock).toHaveBeenCalledTimes(1);
});
test.each([200, 503])("conflicting session ids stay unidentified even in a classified HTTP-%s error", async status => {
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () =>
    Response.json({ sessionId: TESTINGBOT_ID, status: 13, value: { sessionId: "tb-synthetic-session-0002", error: "session not created" } }, { status }), { preconnect: () => {} }));
  restore = () => mock.mockRestore();
  await expect(WebDriverSession.create("testingbot", username, password, {}, async () => { throw new Error("must not checkpoint"); }))
    .rejects.toThrow("two session ids");
  expect(mock).toHaveBeenCalledTimes(1);
});
