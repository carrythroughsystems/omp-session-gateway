import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserStackApi, BROWSERSTACK_LOCAL, browserStackCapabilities, browserStackEntitlement, browserStackLocalArguments,
  browserStackModel, canonicalBrowserStackLocalIdentity, ownedLocalProcesses, prepareBrowserStackLocal, readBrowserStackCredentials, stopBrowserStackLocal,
} from "./browserstack.ts";
import { attestAllocation } from "./device-cloud-qualification.ts";
import { requireLoopbackListeners } from "./device-cloud-common.ts";
import type { CloudArtifact, CloudRecordRemoval, TestRecord } from "./device-cloud-common.ts";
import pins from "./browserstack-pins.json";

const credentials = { username: "synthetic-browserstack-user", accessKey: "synthetic-browserstack-key" };
const id = "a".repeat(40), build = "b".repeat(40);
const apiOrigin = "https://api.browserstack.com/automate";
const artifact = `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/console.txt?synthetic=true`;
const nestedArtifact = `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/nested.txt?synthetic=true`;
const video = `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/video.mp4`;
const record = {
  hashed_id: id, build_hashed_id: build, status: "done", device: "iPad 10th", os: "ios", os_version: "27.0",
  browser: "ipad", video_url: video, browser_console_logs_url: artifact,
};
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

function provider(options: {
  raw?: string; log?: string; logType?: string; missingLogs?: boolean; videoStatus?: number; media?: boolean; large?: boolean;
  deletionFails?: boolean; deletionUnverified?: boolean; lingering?: boolean; changed?: boolean;
  initiallyAbsent?: boolean; disappearsAfter?: number;
  postDeleteLog?: string; postDeleteSessionRaw?: string;
} = {}) {
  let deleted = false;
  let acknowledged = false, lateLogRead = false, lateSessionRead = false;
  let signedAbsent = false, postDeleteReads = 0;
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
    if (url === `${apiOrigin}/sessions/${id}.json`) {
      if (deleted && options.postDeleteSessionRaw !== undefined && !lateSessionRead) {
        lateSessionRead = true;
        return new Response(options.postDeleteSessionRaw, { headers: { "content-type": "application/json" } });
      }
      return deleted ? new Response("absent", { status: 404 }) : new Response(options.raw ?? JSON.stringify({ automation_session: record }), { headers: { "content-type": "application/json" } });
    }
    if (url.startsWith(`${apiOrigin}/sessions/${id}/`)) {
      if (deleted && url.endsWith("/logs") && options.postDeleteLog !== undefined && !lateLogRead) {
        lateLogRead = true;
        return new Response(options.postDeleteLog, { headers: { "content-type": "application/json" } });
      }
      if (deleted) return new Response("absent", { status: 404 });
      if (url.endsWith("/logs") && !options.missingLogs) return new Response(options.large ? "x".repeat(2_000_001) : options.log ?? "synthetic command record", { headers: { "content-type": options.logType ?? "text/plain" } });
      if (url.endsWith("/consolelogs")) return new Response("No messages were logged", { headers: { "content-type": "text/plain" } });
      return new Response("absent", { status: 404 });
    }
    if (url === artifact) {
      if ((!deleted && options.initiallyAbsent) || signedAbsent || (deleted && (!options.lingering ||
        (options.disappearsAfter !== undefined && ++postDeleteReads > options.disappearsAfter)))) return new Response("absent", { status: 404 });
      return new Response(deleted && options.changed ? "changed after audit" : "No messages were logged", { headers: { "content-type": "text/plain" } });
    }
    if (pins.artifactOrigins.some(origin => url === `${origin}/${id}/nested.txt?synthetic=true`)) return deleted ? new Response("absent", { status: 404 }) : new Response("Nested synthetic log", { headers: { "content-type": "text/plain" } });
    if (url === video) {
      if (options.media) return new Response("synthetic-media", { headers: { "content-type": "video/mp4" } });
      return new Response("<Error><Code>AccessDenied</Code><Message>s3:ListBucket</Message></Error>", { status: options.videoStatus ?? 403, headers: { "content-type": "application/xml" } });
    }
    throw new Error("unreviewed test URL");
  }, { preconnect: () => {} }));
  restore = () => mock.mockRestore();
  let now = 0;
  let artifacts: CloudArtifact[] = [];
  const inspected: TestRecord[] = [];
  const removal: CloudRecordRemoval = {
    get artifacts() { return artifacts; },
    get deleted() { return acknowledged; },
    markDeleted: async () => { acknowledged = true; },
    remember: async values => { artifacts = structuredClone([...values]); },
    inspect: async value => { inspected.push(value); },
  };
  const api = new BrowserStackApi(credentials);
  return { calls, api, removal, inspected, releaseArtifacts: () => { signedAbsent = true; },
    audit: () => api.testRecord(id, removal.remember),
    clock: { now: () => now, pause: async (milliseconds: number) => { now += milliseconds; } } };
}

describe("BrowserStack fixed policy inputs", () => {
  test("pins disjoint storage and dashboard origins", () => {
    expect(pins.artifactOrigins).toEqual([
      "https://api.browserstack.com", "https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com", "https://bs-selenium-logs-use.s3.us-east-1.amazonaws.com",
    ]);
    expect(pins.dashboardOrigins).toEqual(["https://automate.browserstack.com"]);
    expect(new Set([...pins.artifactOrigins, ...pins.dashboardOrigins]).size).toBe(4);
  });
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
  test("passes the documented space-separated two-host list exactly to pinned Local", () => {
    expect(browserStackLocalArguments({
      binary: "/owned/BrowserStackLocal", directory: "/owned/attempt", identifier: "omp-dc-bs-1234abcd",
      hosts: ["example.com", "example.org"], localProxyPort: 4567,
    })).toEqual([
      "/owned/BrowserStackLocal", "--config-file", join("/owned/attempt", "local.yml"),
      "--disable-dashboard", "--only-automate", "--log-file", join("/owned/attempt", "startup.pipe"),
      "--disable-proxy-discovery", "--force-local", "--force-proxy", "--local-proxy-host", "127.0.0.1",
      "--local-proxy-port", "4567", "--local-identifier", "omp-dc-bs-1234abcd",
      "--include-hosts", "example.com", "example.org",
    ]);
  });

  test.skipIf(process.platform === "win32")("reads only the exact BrowserStack fields through the pinned service account", async () => {
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

test.skipIf(process.platform === "win32")("Local ownership canonicalizes symlinked ancestors and fails closed on missing paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-bs-canonical-"));
  try {
    const actual = join(directory, "actual"), alias = join(directory, "alias");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, alias);
    await writeFile(join(actual, "BrowserStackLocal"), "synthetic", { mode: 0o700 });
    const identity = { directory: alias, binary: join(alias, "BrowserStackLocal"), identifier: "omp-dc-bs-1234abcd" };
    expect(await canonicalBrowserStackLocalIdentity(identity)).toEqual({
      ...identity, directory: await realpath(actual), binary: await realpath(join(actual, "BrowserStackLocal")),
    });
    await rm(join(actual, "BrowserStackLocal"));
    await expect(canonicalBrowserStackLocalIdentity(identity)).rejects.toThrow("resolve");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("Local ownership includes retitled descendants and orphans without argv, but excludes PID reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-bs-lineage-"));
  try {
    const binary = join(directory, "BrowserStackLocal");
    await writeFile(binary, "synthetic", { mode: 0o700 });
    const identity = { directory, binary, identifier: "omp-dc-bs-1234abcd" };
    const canonical = await canonicalBrowserStackLocalIdentity(identity);
    await writeFile(join(directory, "processes.json"), JSON.stringify([{ pid: 101, started: "launch" }, { pid: 105, started: "old" }]), { mode: 0o600 });
    const snapshot = async () => [
      { pid: 101, parentPid: 1, started: "launch", cwd: canonical.directory, executableFiles: [canonical.binary] },
      { pid: 102, parentPid: 101, started: "child", cwd: "/elsewhere", executableFiles: ["/other/helper"] },
      { pid: 103, parentPid: 1, started: "orphan", cwd: canonical.directory, executableFiles: [canonical.binary] },
      { pid: 104, parentPid: 1, started: "other", cwd: "/other/attempt", executableFiles: [canonical.binary] },
      { pid: 105, parentPid: 1, started: "reused", cwd: "/other", executableFiles: ["/other/helper"] },
    ];
    expect(await ownedLocalProcesses(identity, snapshot)).toEqual([101, 102, 103]);
    const saved = JSON.parse(await readFile(join(directory, "processes.json"), "utf8"));
    expect(saved.map((value: { pid: number }) => value.pid)).toEqual([101, 102, 103]);
    expect((await lstat(join(directory, "processes.json"))).mode & 0o777).toBe(0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Local stop proves not-started with absent binary/directory and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-bs-not-started-"));
  try {
    const identity = { directory: join(root, "never-created"), binary: join(root, "missing-cache", "BrowserStackLocal"), identifier: "omp-dc-bs-1234abcd" };
    let now = 0;
    const runtime = { processes: (options: typeof identity) => ownedLocalProcesses(options, async () => []),
      kill: () => { throw new Error("must not signal an unowned process"); }, now: () => now,
      pause: async (milliseconds: number) => { now += milliseconds; } };
    await stopBrowserStackLocal(identity, runtime);
    await stopBrowserStackLocal(identity, runtime);
    expect(await Bun.file(identity.directory).exists()).toBe(false);
    await expect(ownedLocalProcesses(identity, async () => [{
      pid: 100, parentPid: 1, started: "other", cwd: "/other/attempt",
      executableFiles: [join(await realpath(root), "missing-cache", "BrowserStackLocal")],
    }])).rejects.toThrow("absence cannot be proved");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Local preparation checkpoints only after binary and directory exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-bs-prepare-"));
  try {
    const identity = { directory: join(root, "attempt"), binary: join(root, "BrowserStackLocal"), identifier: "omp-dc-bs-1234abcd" };
    let checkpoints = 0;
    await expect(prepareBrowserStackLocal(identity, async () => { checkpoints++; }, async () => { throw new Error("download failed"); })).rejects.toThrow("download failed");
    expect(checkpoints).toBe(0);
    expect(await Bun.file(identity.directory).exists()).toBe(false);
    await writeFile(identity.binary, "synthetic", { mode: 0o700 });
    await prepareBrowserStackLocal(identity, async () => {
      expect((await lstat(identity.directory)).isDirectory()).toBe(true);
      expect(await Bun.file(identity.binary).exists()).toBe(true);
      checkpoints++;
    }, async () => identity.binary);
    expect(checkpoints).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "darwin")("real process ownership finds and stops a retitled child without reading argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-bs-process-proof-"));
  const child = Bun.spawn([process.execPath, "-e", "process.title='synthetic-retitled-worker';console.log('ready');setInterval(()=>{},1000);"], {
    cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    const identity = { directory, binary: process.execPath, identifier: "omp-dc-bs-1234abcd" };
    expect(await ownedLocalProcesses(identity)).toContain(child.pid);
    await stopBrowserStackLocal(identity);
    await child.exited;
    expect(await Bun.file(join(directory, "processes.json")).exists()).toBe(false);
    await stopBrowserStackLocal(identity);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

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

test.skipIf(process.platform === "win32")("Local cleanup's private config fixture has POSIX mode 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-bs-private-config-"));
  try {
    const config = join(directory, "local.yml");
    await writeFile(config, "synthetic: only", { mode: 0o600 });
    expect((await lstat(config)).mode & 0o777).toBe(0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Local crash cleanup catches respawned children, escalates and removes private config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-bs-stop-"));
  const config = join(directory, "local.yml"), fifo = join(directory, "startup.pipe");
  await writeFile(config, "synthetic: only", { mode: 0o600 });
  await writeFile(fifo, "", { mode: 0o600 });
  try {
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
    expect([...source.matchAll(/\bparseRetainedVendorJson\s*\(/gu)]).toHaveLength(6);
    expect(source).not.toMatch(/\.command\.includes\("BrowserStackLocal"\)/u);
  });
  const placements: [string, (value: string) => unknown][] = [];
  for (const field of ["logs", "insights", "reason"]) for (let depth = 0; depth < 6; depth++) {
    placements.push([`${field}/${depth}`, value => {
      let nested: unknown = value;
      for (let level = 0; level < depth; level++) nested = level % 2 === 0 ? [null, { child: nested }] : { arbitrary: nested };
      return { ...record, [field]: nested };
    }]);
  }
  test.each(placements)("class invariant: storage URL at %s is fetched, privately inventoried and absence-checked", async (_name, place) => {
    for (const origin of pins.artifactOrigins) {
      const nested = `${origin}/${id}/nested.txt?synthetic=true`;
      const fixture = provider({ raw: JSON.stringify({ automation_session: place(nested) }) });
      await fixture.audit();
      expect(fixture.removal.artifacts.some(item => item.url === nested)).toBe(true);
      expect(fixture.calls.filter(call => call.url === nested)).toHaveLength(1);
      await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
      expect(fixture.calls.filter(call => call.url === nested)).toHaveLength(2);
      expect(fixture.calls.filter(call => call.url === nested).every(call => !call.authorization)).toBe(true);
      restore?.();
    }
  });
  test.each(placements)("class invariant: unreviewed origin anywhere at %s fails closed", async (_name, place) => {
    const fixture = provider({ raw: JSON.stringify({ automation_session: place(`https://unreviewed.example/${id}/opaque`) }) });
    await expect(fixture.audit()).rejects.toThrow("unreviewed");
    expect(fixture.calls).toHaveLength(1);
  });
  test("only top-level dashboard presentation fields are counted and never fetched", async () => {
    const browserUrl = `https://automate.browserstack.com/dashboard/v2/sessions/${id}`;
    const publicUrl = `https://automate.browserstack.com/dashboard/v2/public-build/${build}/sessions/${id}`;
    const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, browser_url: browserUrl, public_url: publicUrl } }) });
    expect((await fixture.audit())?.dashboardReferences).toBe(2);
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.calls.some(call => call.url === browserUrl || call.url === publicUrl)).toBe(false);
    expect(fixture.removal.artifacts.some(item => item.url.startsWith(pins.dashboardOrigins[0]!))).toBe(false);
    restore?.();
    const misplaced = provider({ raw: JSON.stringify({ automation_session: { ...record, insights: { browser_url: browserUrl } } }) });
    await expect(misplaced.audit()).rejects.toThrow("unreviewed");
  });
  test.each(["session", "log"] as const)("post-DELETE %s bodies are scanned raw plus canonical before absence", async surface => {
    const marker = "SYNTHETIC-LATE-RETAINED-CONTENT";
    const json = JSON.stringify(surface === "session" ? { automation_session: { ...record, reason: marker } } : { late: marker }).replace("SYNTHETIC", "\\u0053YNTHETIC");
    const fixture = provider(surface === "session" ? { postDeleteSessionRaw: json } : { postDeleteLog: json });
    await fixture.audit();
    let incident = false;
    await fixture.api.deleteRecord(id, { ...fixture.removal, inspect: async record => {
      await fixture.removal.inspect(record);
      if (record.text.includes(marker.slice(4, 20))) incident = true;
    } }, fixture.clock);
    expect(incident).toBe(true);
    expect(fixture.inspected.some(record => record.text.includes("\\u0053YNTHETIC") && record.text.includes(marker))).toBe(true);
  });
  test("duplicate post-DELETE JSON is raw-scanned before rejecting its discarded content", async () => {
    const marker = "SYNTHETIC-LATE-DUPLICATE-CONTENT";
    const fixture = provider({ postDeleteLog: `{"step":"${marker}","step":"clean"}` });
    await fixture.audit();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow();
    expect(fixture.inspected.some(record => record.text.includes(marker))).toBe(true);
    expect(fixture.removal.deleted).toBe(true);
  });
  test("audits raw and canonical metadata, text and referenced logs without forwarding auth", async () => {
    const raw = JSON.stringify({ automation_session: { ...record, reason: "SYNTHETIC-CLOUD-LINK" } }).replace("SYNTHETIC", "\\u0053YNTHETIC");
    const fixture = provider({ raw });
    const inspected = await fixture.audit();
    expect(inspected?.complete).toBe(true);
    expect(inspected?.text).toContain("SYNTHETIC-CLOUD-LINK");
    expect(inspected?.text).toContain("synthetic command record");
    expect(inspected?.video).toBe(false);
    expect(fixture.calls.filter(call => !call.url.startsWith(apiOrigin)).every(call => !call.authorization)).toBe(true);
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });
  test("rejects duplicate decoded keys in metadata and JSON logs before trusting references", async () => {
    const raw = `{"automation_session":${JSON.stringify(record).replace('"video_url":', '"video_url":"https://unreviewed.example/hidden.mp4","video_url":')}}`;
    const fixture = provider({ raw });
    await expect(fixture.api.testRecord(id)).rejects.toThrow();
    expect(fixture.calls).toHaveLength(1);
    restore?.();
    const logs = provider({ log: '{"nested":{"link":"SYNTHETIC-HIDDEN","l\\u0069nk":"clean"}}', logType: "application/json" });
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
  test("unchanged clean lingering text still prevents restoration", async () => {
    const fixture = provider({ lingering: true });
    await fixture.audit();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow("absence");
  });
  test.each([false, true])("audits late materialization even when initially absent (changed=%s)", async changed => {
    const fixture = provider({ initiallyAbsent: true, lingering: true, changed, disappearsAfter: 2 });
    await fixture.audit();
    expect(fixture.removal.artifacts.map(item => item.url)).toContain(artifact);
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.inspected.filter(record => record.text === (changed ? "changed after audit" : "No messages were logged"))).toHaveLength(2);
  });
  test("a fresh process retains private references after DELETE and must recheck their absence", async () => {
    const fixture = provider({ initiallyAbsent: true, lingering: true, changed: true });
    await fixture.audit();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow("absence");
    const persisted = JSON.parse(JSON.stringify(fixture.removal.artifacts)) as CloudArtifact[];
    const fresh = new BrowserStackApi(credentials);
    await expect(fresh.deleteRecord(id, { ...fixture.removal, artifacts: persisted }, fixture.clock)).rejects.toThrow("absence");
    fixture.releaseArtifacts();
    await fresh.deleteRecord(id, { ...fixture.removal, artifacts: persisted }, fixture.clock);
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });
  test("unverified API deletion fails even when signed artifacts disappear", async () => {
    const fixture = provider({ deletionUnverified: true });
    await fixture.audit();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow("could not be verified");
  });
  test("changed lingering text is inspected and cannot satisfy removal", async () => {
    const changed = true;
    const fixture = provider({ lingering: true, changed });
    await fixture.audit();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow();
    expect(fixture.inspected.some(record => record.text === "changed after audit")).toBe(true);
  });
  test("unverified removal fails and a transport-ambiguous DELETE is not replayed", async () => {
    const fixture = provider({ deletionFails: true });
    await fixture.audit();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow("could not be verified");
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });
  test("fresh deletion reconstructs an inventory from the complete strictly parsed record", async () => {
    const fixture = provider();
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.removal.artifacts).toHaveLength(2);
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });
  test.each([
    { value: { error: "unknown error", screenshot: "opaque-base64-screenshot" } },
    { visual_log: { opaque: "retained" } },
    { screenshots: 1 },
  ])("failed-command media is not limited to familiar screenshot URLs: %j", async log => {
    const fixture = provider({ log: JSON.stringify(log), logType: "application/json" });
    expect((await fixture.audit())?.screenshots).toBe(1);
  });
  test.each(["data:image/png;base64,synthetic", "https://media.example/opaque.webm"])("an unreviewed media URL fails closed: %s", async url => {
    const fixture = provider({ log: JSON.stringify({ value: { screen: url } }), logType: "application/json" });
    await expect(fixture.audit()).rejects.toThrow("unreviewed");
  });
  test.each([{ marker: null }, { marker: false }, { marker: "" }, { marker: [] }])("documented empty media markers are not retained content: %j", async ({ marker }) => {
    const fixture = provider({ log: JSON.stringify({ screenshot: marker, video: marker, visual: marker }), logType: "application/json" });
    expect((await fixture.audit())?.screenshots).toBe(0);
  });
  test("plaintext never supplies artifact references; declared JSON inventories do", async () => {
    const plaintext = provider({ log: JSON.stringify({ log_url: nestedArtifact }) });
    await plaintext.audit();
    expect(plaintext.calls.filter(call => call.url === nestedArtifact)).toHaveLength(0);
    expect(plaintext.removal.artifacts.map(item => item.url)).not.toContain(nestedArtifact);
    restore?.();
    const json = provider({ log: JSON.stringify({ log_url: nestedArtifact }), logType: "application/json" });
    await json.audit();
    expect(json.removal.artifacts.filter(item => item.url === nestedArtifact)).toHaveLength(1);
    expect(json.calls.filter(call => call.url === nestedArtifact)).toHaveLength(1);
  });
});
