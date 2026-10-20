import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserStackApi, BROWSERSTACK_LOCAL, browserStackCapabilities, browserStackEntitlement, browserStackLocalArguments,
  browserStackModel, readBrowserStackCredentials, stopBrowserStackLocal,
} from "./browserstack.ts";
import { attestAllocation } from "./device-cloud-qualification.ts";
import { requireLoopbackListeners } from "./device-cloud-common.ts";

const credentials = { username: "synthetic-browserstack-user", accessKey: "synthetic-browserstack-key" };
const id = "a".repeat(40), build = "b".repeat(40);
const apiOrigin = "https://api.browserstack.com/automate";
const artifact = `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/console.txt?synthetic=true`;
const video = `https://automate.browserstack.com/sessions/${id}/video`;
const record = {
  hashed_id: id, build_hashed_id: build, status: "done", device: "iPad 10th", os: "ios", os_version: "27.0",
  browser: "ipad", video_url: video, browser_console_logs_url: artifact,
};
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

function provider(options: {
  raw?: string; log?: string; logType?: string; missingLogs?: boolean; videoStatus?: number; media?: boolean; large?: boolean;
  deletionFails?: boolean; deletionUnverified?: boolean; lingering?: boolean; changed?: boolean;
} = {}) {
  let deleted = false;
  const calls: { method: string; url: string; authorization: boolean }[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).has("authorization");
    calls.push({ method, url, authorization });
    if (method === "DELETE") {
      if (options.deletionFails) throw new Error("synthetic ambiguous transport failure");
      deleted = !options.deletionUnverified;
      return Response.json({ status: "ok" });
    }
    if (url === `${apiOrigin}/sessions/${id}.json`) return deleted ? new Response("absent", { status: 404 }) : new Response(options.raw ?? JSON.stringify({ automation_session: record }), { headers: { "content-type": "application/json" } });
    if (url.startsWith(`${apiOrigin}/sessions/${id}/`)) {
      if (deleted) return new Response("absent", { status: 404 });
      if (url.endsWith("/logs") && !options.missingLogs) return new Response(options.large ? "x".repeat(2_000_001) : options.log ?? "synthetic command record", { headers: { "content-type": options.logType ?? "text/plain" } });
      if (url.endsWith("/consolelogs")) return new Response("No messages were logged", { headers: { "content-type": "text/plain" } });
      return new Response("absent", { status: 404 });
    }
    if (url === artifact) {
      if (deleted && !options.lingering) return new Response("absent", { status: 404 });
      return new Response(deleted && options.changed ? "changed after audit" : "No messages were logged", { headers: { "content-type": "text/plain" } });
    }
    if (url === video) {
      if (options.media) return new Response("synthetic-media", { headers: { "content-type": "video/mp4" } });
      return new Response("<Error><Code>AccessDenied</Code><Message>s3:ListBucket</Message></Error>", { status: options.videoStatus ?? 403, headers: { "content-type": "application/xml" } });
    }
    throw new Error("unreviewed test URL");
  }, { preconnect: () => {} }));
  restore = () => mock.mockRestore();
  let now = 0;
  return { calls, api: new BrowserStackApi(credentials), clock: { now: () => now, pause: async (milliseconds: number) => { now += milliseconds; } } };
}

describe("BrowserStack fixed policy inputs", () => {
  test("requires the observed Mobile plan and exactly five group/team parallels", async () => {
    let body = { automate_plan: "Automate Mobile", parallel_sessions_max_allowed: 5, team_parallel_sessions_max_allowed: 5 };
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json(body), { preconnect: () => {} }));
    restore = () => mock.mockRestore();
    const api = new BrowserStackApi(credentials);
    await api.plan(Date.parse("2026-10-20T00:00:00Z"));
    body = { ...body, automate_plan: "Automate Desktop" };
    await expect(api.plan(Date.parse("2026-10-20T00:00:00Z"))).rejects.toThrow("entitlement");
    body = { ...body, automate_plan: "Automate Mobile", parallel_sessions_max_allowed: 1 };
    await expect(api.plan(Date.parse("2026-10-20T00:00:00Z"))).rejects.toThrow("entitlement");
  });
  test("uses the same fail-closed loopback listener contract as TestingBot", () => {
    for (const vendor of ["testingbot", "browserstack"] as const) {
      expect(() => requireLoopbackListeners(["127.0.0.1:4567", "[::1]:4568"], vendor)).not.toThrow();
      for (const address of ["*:4567", "0.0.0.0:4567", "[::]:4567", "192.168.1.2:4567", "100.64.0.1:4567"]) {
        expect(() => requireLoopbackListeners([address], vendor)).toThrow("beyond loopback");
      }
    }
  });
  test("pins the observed artifact, entitlement cutoff and Samsung-only aliases", () => {
    expect(BROWSERSTACK_LOCAL.version).toBe("8.9");
    expect(BROWSERSTACK_LOCAL.archiveBytes).toBe(10_298_446);
    expect(BROWSERSTACK_LOCAL.sha256).toHaveLength(64);
    expect(() => browserStackEntitlement(Date.parse("2027-10-19T23:59:59Z"))).not.toThrow();
    expect(() => browserStackEntitlement(Date.parse("2027-10-20T00:00:00Z"))).toThrow("renewal");
    expect(browserStackModel("ipad", { name: "iPad 10th", platform: "ios", version: "27" })?.canonical).toBe("iPad (10th generation)");
    for (const device of [
      { name: "iPad 9th", platform: "ios", version: "18" },
      { name: "iPad 10th", platform: "ios", version: "25.9" },
      { name: "iPad 10th", platform: "ios", version: "latest" },
    ]) expect(browserStackModel("ipad", device)).toBeUndefined();
    for (const name of ["Google Pixel 10 Pro", "Samsung Galaxy A55", "Galaxy S26"]) expect(browserStackModel("android", { name, platform: "android", version: "16" })).toBeUndefined();
  });

  test("keeps credentials out of lane-created argv and confines browser traffic", () => {
    const argv = browserStackLocalArguments({ binary: "/owned/BrowserStackLocal", directory: "/owned/attempt", identifier: "omp-dc-bs-1234abcd", hosts: ["candidate.example"], localProxyPort: 4567 });
    expect(argv).toContain("--config-file");
    expect(argv).not.toContain("--key");
    expect(argv.join(" ")).not.toContain(credentials.accessKey);
    for (const flag of ["--force-local", "--force-proxy", "--disable-dashboard", "--only-automate", "--disable-proxy-discovery", "--include-hosts"]) expect(argv).toContain(flag);
    expect(argv[argv.indexOf("--local-proxy-host") + 1]).toBe("127.0.0.1");
    expect(argv).not.toContain("--only");
    expect(() => browserStackLocalArguments({ binary: "/owned/BrowserStackLocal", directory: "/owned", identifier: "other", hosts: ["*"], localProxyPort: 4567 })).toThrow();
    const capabilities = browserStackCapabilities("ipad", { name: "iPad 10th", platform: "ios", version: "27" }, "omp-dc-bs-1234abcd");
    expect(capabilities["bstack:options"]).toMatchObject({ realMobile: true, video: false, debug: false, consoleLogs: "disable", networkLogs: false, seleniumLogs: false, appiumLogs: false });
    expect(JSON.stringify(capabilities)).not.toContain(credentials.accessKey);
  });

  test("reads only the exact BrowserStack fields through the pinned service account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-bs-credentials-"));
    try {
      const file = join(directory, "token");
      await writeFile(file, "ops_" + "synthetic".repeat(8), { mode: 0o600 });
      const calls: string[][] = [];
      const actual = await readBrowserStackCredentials(file, async (argv, environment) => {
        calls.push([...argv]);
        expect(environment.OP_ACCOUNT).toBeUndefined();
        expect(argv.join(" ")).not.toContain(environment.OP_SERVICE_ACCOUNT_TOKEN!);
        if (argv[1] === "whoami") return { exitCode: 0, stdout: JSON.stringify({ url: "my.1password.com", user_type: "SERVICE_ACCOUNT" }) };
        return { exitCode: 0, stdout: argv.at(-1)?.endsWith("/username") ? credentials.username : credentials.accessKey };
      });
      expect(actual).toEqual(credentials);
      expect(calls.slice(1).map(argv => argv.at(-1))).toEqual(["op://Centaur/BrowserStack/username", "op://Centaur/BrowserStack/access-key"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("BrowserStack allocation attestation", () => {
  const ipad = { capabilities: { platformName: "iOS", browserName: "safari", deviceName: "iPad 10th" }, browser: { family: "ipad", browser: "safari", browserVersion: "27.0", os: "27.0", model: "" }, vendorRecord: { device: "iPad 10th", os: "ios", osVersion: "27.0", browser: "ipad" } } as const;
  const samsung = { capabilities: { platformName: "Android", browserName: "chrome", deviceName: "synthetic-serial" }, browser: { family: "android", browser: "chrome", browserVersion: "152.0.7977.54", os: "16.0.0", model: "SM-S942B" }, vendorRecord: { device: "Samsung Galaxy S26", os: "android", osVersion: "16.0", browser: "chrome_android" } } as const;
  test("records exact browser-reported versions and canonical allocated models", () => {
    expect(attestAllocation("browserstack", "ipad", { name: "iPad 10th", version: "27" }, ipad)).toEqual({ device: "iPad (10th generation)", os: "27.0", browser: "safari", browserVersion: "27.0" });
    expect(attestAllocation("browserstack", "android", { name: "Samsung Galaxy S26", version: "16.0" }, samsung)).toEqual({ device: "Galaxy S26", model: "SM-S942B", os: "16.0.0", browser: "chrome", browserVersion: "152.0.7977.54" });
  });
  test("refuses iPhone, wrong OEM/model/OS/browser and uncorroborated allocation", () => {
    expect(() => attestAllocation("browserstack", "iphone", { name: "iPhone 17", version: "26" }, ipad)).toThrow();
    for (const changed of [
      { ...samsung, browser: { ...samsung.browser, model: "Pixel 10" } },
      { ...samsung, browser: { ...samsung.browser, model: "SM-S921B" } },
      { ...samsung, browser: { ...samsung.browser, os: "15.0.0" } },
      { ...samsung, browser: { ...samsung.browser, browser: "unknown" as const } },
      { ...samsung, vendorRecord: { ...samsung.vendorRecord, device: "Samsung Galaxy S24" } },
    ]) expect(() => attestAllocation("browserstack", "android", { name: "Samsung Galaxy S26", version: "16.0" }, changed)).toThrow();
  });
});

test("Local crash cleanup catches respawned children, escalates and removes private config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-bs-stop-"));
  const config = join(directory, "local.yml"), fifo = join(directory, "startup.pipe");
  await writeFile(config, "synthetic: only", { mode: 0o600 });
  await writeFile(fifo, "", { mode: 0o600 });
  try {
    expect((await lstat(config)).mode & 0o777).toBe(0o600);
    let time = 0, respawned = false;
    const alive = new Set([101]);
    const signals: string[] = [];
    await stopBrowserStackLocal({ directory, binary: join(directory, "BrowserStackLocal"), identifier: "omp-dc-bs-1234abcd" }, {
      now: () => time, pause: async milliseconds => { time += milliseconds; },
      processes: async () => {
        if (time >= 200 && !respawned) { alive.add(102); respawned = true; }
        return [...alive];
      },
      kill: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        if (pid === 101 || signal === "SIGKILL") alive.delete(pid);
      },
    });
    expect(signals).toEqual(["101:SIGTERM", "102:SIGTERM", "102:SIGKILL"]);
    expect(alive.size).toBe(0);
    expect(await Bun.file(config).exists()).toBe(false);
    expect(await Bun.file(fifo).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

describe("BrowserStack complete retention and deletion", () => {
  test("every BrowserStack JSON boundary uses the shared duplicate-rejecting parser", async () => {
    const source = await readFile(new URL("./browserstack.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bJSON\s*\.\s*parse\s*\(/u);
    expect(source).not.toMatch(/\bvendorJson\s*\(/u);
    expect(source).not.toMatch(/\.\s*json\s*\(/u);
    expect([...source.matchAll(/\bparseRetainedVendorJson\s*\(/gu)]).toHaveLength(5);
  });
  test("audits raw and canonical metadata, text and referenced logs without forwarding auth", async () => {
    const raw = JSON.stringify({ automation_session: { ...record, reason: "SYNTHETIC-CLOUD-LINK" } }).replace("SYNTHETIC", "\\u0053YNTHETIC");
    const fixture = provider({ raw });
    const inspected = await fixture.api.testRecord(id);
    expect(inspected?.complete).toBe(true);
    expect(inspected?.text).toContain("SYNTHETIC-CLOUD-LINK");
    expect(inspected?.text).toContain("synthetic command record");
    expect(inspected?.video).toBe(false);
    expect(fixture.calls.filter(call => !call.url.startsWith(apiOrigin)).every(call => !call.authorization)).toBe(true);
    expect(await fixture.api.deleteRecord(id, true, fixture.clock)).toBe(0);
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });
  test("rejects duplicate decoded keys in metadata and JSON logs before trusting references", async () => {
    const raw = `{"automation_session":${JSON.stringify(record).replace('"video_url":', '"video_url":"https://unreviewed.example/hidden.mp4","video_url":')}}`;
    const fixture = provider({ raw });
    await expect(fixture.api.testRecord(id)).rejects.toThrow();
    expect(fixture.calls).toHaveLength(1);
    restore?.();
    const logs = provider({ log: '{"nested":{"link":"SYNTHETIC-HIDDEN","l\\u0069nk":"clean"}}' });
    await expect(logs.api.testRecord(id)).rejects.toThrow();
  });
  test("strictly canonicalizes JSON logs but refuses malformed declared JSON", async () => {
    const fixture = provider({ log: '{"step":"\\u0053YNTHETIC-LOG-VALUE"}', logType: "application/json" });
    expect((await fixture.api.testRecord(id))?.text).toContain("SYNTHETIC-LOG-VALUE");
    restore?.();
    const malformed = provider({ log: "not JSON", logType: "application/json" });
    await expect(malformed.api.testRecord(id)).rejects.toThrow();
  });
  test.each([ ["missing required logs", { missingLogs: true }], ["oversized body", { large: true }], ["unknown video state", { videoStatus: 401 }] ] as const)("refuses %s", async (_name, options) => {
    const fixture = provider(options);
    await expect(fixture.api.testRecord(id)).rejects.toThrow();
  });
  test("reports kept media and refuses new/unreviewed retained surfaces", async () => {
    const fixture = provider({ media: true });
    expect((await fixture.api.testRecord(id))?.video).toBe(true);
    restore?.();
    const invalid = provider({ raw: JSON.stringify({ automation_session: { ...record, unreviewed_media_url: "https://unreviewed.example/video" } }) });
    await expect(invalid.api.testRecord(id)).rejects.toThrow("unreviewed");
  });
  test("allows only identical audited-clean lingering text, counting rather than publishing URLs", async () => {
    const fixture = provider({ lingering: true });
    await fixture.api.testRecord(id);
    expect(await fixture.api.deleteRecord(id, true, fixture.clock)).toBe(1);
  });
  test.each([ ["unclean", false, false], ["changed", true, true] ] as const)("refuses %s lingering text", async (_name, clean, changed) => {
    const fixture = provider({ lingering: true, changed });
    await fixture.api.testRecord(id);
    await expect(fixture.api.deleteRecord(id, clean, fixture.clock)).rejects.toThrow();
  });
  test("unverified removal fails and a transport-ambiguous DELETE is not replayed", async () => {
    const fixture = provider({ deletionFails: true });
    await fixture.api.testRecord(id);
    await expect(fixture.api.deleteRecord(id, true, fixture.clock)).rejects.toThrow();
    await expect(fixture.api.deleteRecord(id, true, fixture.clock)).rejects.toThrow("could not be verified");
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });
  test("crash cleanup re-inspects before deletion, never trusts a persisted clean flag for lingering URLs", async () => {
    const fixture = provider();
    expect(await fixture.api.deleteRecord(id, true, fixture.clock)).toBe(0);
    expect(fixture.calls.findIndex(call => call.url.endsWith("/logs"))).toBeLessThan(fixture.calls.findIndex(call => call.method === "DELETE"));
    expect(await new BrowserStackApi(credentials).deleteRecord(id, true, fixture.clock)).toBe(0);
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });
});
