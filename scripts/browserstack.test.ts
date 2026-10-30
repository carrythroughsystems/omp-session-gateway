import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserStackApi, BrowserStackAuditFailure, BROWSERSTACK_LOCAL, browserStackCapabilities, browserStackEntitlement, browserStackLocalArguments, browserStackReferences,
  browserStackModel, canonicalBrowserStackLocalIdentity, mergeBrowserStackArtifacts, ownedLocalProcesses, prepareBrowserStackLocal, readBrowserStackCredentials, stopBrowserStackLocal,
} from "./browserstack.ts";
import { attestAllocation, cleanupDeviceCloud, parseDeviceCloudProgress, runDeviceCloud, type DeviceCloudLaneInput, type DeviceCloudRuntime } from "./device-cloud-qualification.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import { boundedVendorBytes, boundedVendorText, requireLoopbackListeners } from "./device-cloud-common.ts";
import type { CloudArtifact, CloudRecordRemoval, TestRecord } from "./device-cloud-common.ts";
import pins from "./browserstack-pins.json";

const credentials = { username: "synthetic-browserstack-user", accessKey: "synthetic-browserstack-key" };
const id = "a".repeat(40), build = "b".repeat(40);
const apiOrigin = "https://api.browserstack.com/automate";
function signedQuery(label: string): string {
  return new URLSearchParams({
    "X-Amz-Algorithm": "SYNTHETIC_ALGORITHM", "X-Amz-Credential": "SYNTHETIC_CREDENTIAL",
    "X-Amz-Date": `${label}_DATE`, "X-Amz-Expires": "604800", "X-Amz-SignedHeaders": "host",
    "X-Amz-Signature": `${label}_SIGNATURE`,
  }).toString();
}
const artifactQuery = signedQuery("SYNTHETIC_DEFAULT");
const artifact = `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/console.txt?${artifactQuery}`;
const oldSignature = `${artifact.split("?")[0]}?${signedQuery("SYNTHETIC_OLD")}`;
const newSignature = `${artifact.split("?")[0]}?${signedQuery("SYNTHETIC_NEW")}`;
const nestedArtifact = `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/nested.txt?${artifactQuery}`;
const video = `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/video.mp4`;
const replayCapability = "SYNTHETIC_REPLAY_ROOM.SYNTHETIC_R1_R2_WINDOW_CANARY_NOT_A_REAL_KEY";
const replayWindow = replayCapability.slice(28, 44);
const presentation = {
  browser_url: `https://automate.browserstack.com/builds/${build}/sessions/${id}`,
  public_url: `https://automate.browserstack.com/builds/${build}/sessions/${id}?auth_token=${"SYNTHETIC_PUBLIC_ONLY_".padEnd(64, "X")}`,
  logs: `https://automate.browserstack.com/builds/${build}/sessions/${id}/logs`,
  video_url: `https://automate.browserstack.com/sessions/${id}/video?token=${"SYNTHETIC_VIDEO_ONLY_".padEnd(194, "X")}&source=TEST_SYN&diff=1.234567890`,
};
const record = {
  hashed_id: id, build_hashed_id: build, status: "done", device: "iPad 10th", os: "ios", os_version: "27.0",
  browser: "ipad", video_url: presentation.video_url, browser_console_logs_url: artifact,
};
const documentation = "https://www.browserstack.com/docs/automate/selenium/synthetic-optimization#synthetic-fragment";
const observedArtifacts = {
  browser_console_logs_url: artifact,
  har_logs_url: `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/har.txt?${artifactQuery}`,
  selenium_logs_url: `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/selenium.txt?${artifactQuery}`,
  browser_profiling_url: `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/profiling.txt?${artifactQuery}`,
  session_terminal_logs_url: `https://bs-selenium-logs-use.s3.us-east-1.amazonaws.com/${id}/session-terminal.txt?${artifactQuery}&response-content-type=text%2Fplain`,
  build_terminal_logs_url: `https://bs-selenium-logs-use.s3.us-east-1.amazonaws.com/${build}/build-terminal.txt?${artifactQuery}&response-content-type=text%2Fplain`,
};
const observedRecord = {
  ...record, device: "Samsung Galaxy S26", os: "android", os_version: "16.0", browser: "chrome_android",
  ...presentation, ...observedArtifacts,
  insights: { summary: { time_breakdown: {
    browserstack_time: { seconds: 1, reason: "synthetic", optimize_url: documentation },
    user_time: { seconds: 2, reason: "synthetic", optimize_url: documentation },
    capabilities_impact: { seconds: 3, reason: "synthetic", optimize_url: documentation },
  } } },
};
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

interface RetainedReply { text: string | Uint8Array<ArrayBuffer>; status: number; type: string }
function retainedReply(reply: RetainedReply): Response {
  return new Response(reply.text, { status: reply.status, headers: { "content-type": reply.type } });
}

function provider(options: {
  raw?: string; log?: string; logType?: string; missingLogs?: boolean; videoStatus?: number; media?: boolean; large?: boolean;
  deletionFails?: boolean; deletionUnverified?: boolean; lingering?: boolean; changed?: boolean;
  initiallyAbsent?: boolean; disappearsAfter?: number;
  postDeleteLog?: string; postDeleteSessionRaw?: string; preDeleteSessionRaw?: string; recordAlreadyDeleted?: boolean;
  sessionReply?: RetainedReply; logReply?: RetainedReply; artifactReply?: RetainedReply;
  deleteReply?: RetainedReply; postDeleteArtifactReply?: RetainedReply; nestedLog?: string;
  retry?: { surface: "session" | "log" | "artifact"; reply: RetainedReply };
  additionalArtifacts?: readonly string[]; xmlLogs?: boolean;
} = {}) {
  let deleted = options.recordAlreadyDeleted ?? false;
  let acknowledged = false, lateLogRead = false, lateSessionRead = false;
  let signedAbsent = false, postDeleteReads = 0;
  let retried = false, sessionReads = 0;
  const calls: { method: string; url: string; authorization: boolean }[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).has("authorization");
    calls.push({ method, url, authorization });
    const retryUrl = options.retry?.surface === "session" ? `${apiOrigin}/sessions/${id}.json`
      : options.retry?.surface === "log" ? `${apiOrigin}/sessions/${id}/logs` : artifact;
    if (method === "GET" && !retried && options.retry !== undefined && url === retryUrl) {
      retried = true;
      return retainedReply(options.retry.reply);
    }
    if (method === "DELETE") {
      if (options.deletionFails) throw new Error("synthetic ambiguous transport failure");
      if (options.deleteReply !== undefined) {
        if (options.deleteReply.status === 200) deleted = !options.deletionUnverified;
        return retainedReply(options.deleteReply);
      }
      deleted = !options.deletionUnverified;
      return Response.json({ status: "ok" });
    }
    if (url === `${apiOrigin}/sessions/${id}.json`) {
      if (!deleted && ++sessionReads > 1 && options.preDeleteSessionRaw !== undefined) return new Response(options.preDeleteSessionRaw, { headers: { "content-type": "application/json" } });
      if (!deleted && options.sessionReply !== undefined) return retainedReply(options.sessionReply);
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
      if (deleted) return options.xmlLogs ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404, headers: { "content-type": "application/xml" } }) : new Response("absent", { status: 404 });
      if (url.endsWith("/logs") && options.logReply !== undefined) return retainedReply(options.logReply);
      if (url.endsWith("/logs") && !options.missingLogs) return new Response(options.large ? "x".repeat(2_000_001) : options.log ?? "synthetic command record", { headers: { "content-type": options.logType ?? "text/plain" } });
      if (url.endsWith("/consolelogs")) return new Response("No messages were logged", { headers: { "content-type": "text/plain" } });
      return options.xmlLogs ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404, headers: { "content-type": "application/xml" } }) : new Response("absent", { status: 404 });
    }
    if (url === artifact || (options.additionalArtifacts?.includes(url) && url.split("?")[0] === artifact.split("?")[0])) {
      if (deleted && options.postDeleteArtifactReply !== undefined) return retainedReply(options.postDeleteArtifactReply);
      if (!deleted && options.artifactReply !== undefined) return retainedReply(options.artifactReply);
      if ((!deleted && options.initiallyAbsent) || signedAbsent || (deleted && (!options.lingering ||
        (options.disappearsAfter !== undefined && ++postDeleteReads > options.disappearsAfter)))) return new Response("absent", { status: 404 });
      return new Response(deleted && options.changed ? "changed after audit" : "No messages were logged", { headers: { "content-type": "text/plain" } });
    }
    if (pins.artifactOrigins.some(origin => url === `${origin}/${id}/nested.txt?${artifactQuery}`)) return deleted ? new Response("absent", { status: 404 }) : new Response(options.nestedLog ?? "Nested synthetic log", { headers: { "content-type": "text/plain" } });
    if (options.additionalArtifacts?.includes(url)) return deleted ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404, headers: { "content-type": "application/xml" } }) : new Response("synthetic observed log", { headers: { "content-type": "text/plain" } });
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
  const incidents: string[] = [];
  const removal: CloudRecordRemoval = {
    get artifacts() { return artifacts; },
    get deleted() { return acknowledged; },
    markDeleted: async () => { acknowledged = true; },
    remember: async (values, incident) => { artifacts = structuredClone([...values]); if (incident !== undefined) incidents.push(incident); },
    inspect: async value => { inspected.push(value); },
  };
  const api = new BrowserStackApi(credentials);
  return { calls, api, removal, inspected, incidents, releaseArtifacts: () => { signedAbsent = true; },
    audit: () => api.testRecord(id, removal.remember),
    clock: { now: () => now, pause: async (milliseconds: number) => { now += milliseconds; } } };
}

/** Real qualification scanner/checkpoints, with only the vendor/device/host effects replaced. */
function auditedAttempt(fixture: ReturnType<typeof provider>, options: { progress?: unknown; crashOnIncident?: boolean; crashOnArtifactUrl?: string; interruptRemoval?: boolean } = {}) {
  let published = options.progress !== undefined, crashed = false;
  const checkpoints: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const session = (kind: "fixture" | "live"): SessionMetadata => ({
    instanceId: `synthetic-replay-${kind}`, generation: 1, cwdLabel: kind === "live" ? "omp-stable-live" : "omp-cloud-fixture",
    model: "fixture/model", startedAt: "2026-10-20T00:00:00.000Z", lastSeenAt: "2026-10-20T00:00:00.000Z",
    canView: true, canControl: true, inputRequired: false,
  });
  const capture = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); throw error; }
  };
  const scan = (inspect?: CloudRecordRemoval["inspect"]): CloudRecordRemoval["inspect"] => async record => {
    await fixture.removal.inspect(record);
    await inspect?.(record);
  };
  const runtime: DeviceCloudRuntime = {
    ...fixture.clock,
    admit: async () => {},
    fixture: async operation => { published = operation === "start"; },
    fixtureSession: async () => published ? session("fixture") : undefined,
    liveSession: async () => session("live"),
    tunnel: async () => {},
    verify: async (target, attempt) => {
      const vendor = target === "ipad" ? "browserstack" : "testingbot";
      if (vendor === "browserstack") await attempt.startingTunnel(vendor);
      await attempt.allocating(vendor);
      await attempt.created({ vendor, target, sessionId: vendor === "browserstack" ? id : `synthetic-replay-${target}` });
      return { vendor: vendor === "browserstack" ? "BrowserStack" : "TestingBot", tunnelVersion: vendor === "browserstack" ? "8.9" : "4.9" };
    },
    endSession: async () => {},
    record: async (reference, remember, inspect) => {
      if (crashed) throw new Error("synthetic process lost after checkpoint");
      return reference.vendor === "browserstack" ? capture(() => fixture.api.testRecord(id, remember, scan(inspect)))
        : { complete: true, text: "synthetic clean record", video: false, screenshots: 0 };
    },
    removeRecord: async (reference, removal) => {
      if (crashed) throw new Error("synthetic process lost after checkpoint");
      if (options.interruptRemoval) throw new Error("synthetic interruption before record removal");
      if (reference.vendor === "browserstack") await capture(() => fixture.api.deleteRecord(id, {
        ...removal, inspect: scan(removal.inspect), remember: async (artifacts, incident) => {
          await fixture.removal.remember(artifacts, incident);
          await removal.remember(artifacts, incident);
        },
      }, fixture.clock));
    },
    launch: async () => replayCapability,
    removeWorkspace: async () => {},
  };
  const input: DeviceCloudLaneInput = {
    identity: {
      tag: "v0.7.0-prealpha.1",
      candidate: { tag: "v0.7.0-prealpha.1", sourceCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archivePath: "/synthetic/archive.tar" },
      omp: { bunVersion: "1.4.0", sourceCommit: "c".repeat(40), sourceTree: "d".repeat(40), version: "18.1.20", nativeTarballSha256: "e".repeat(64), nativeBinarySha256: "f".repeat(64) },
      origin: "https://synthetic-replay.example",
    },
    sessionLabel: "omp-stable-live", progress: options.progress, runtime,
    pixel: async (_owner, action) => action(),
    checkpoint: async (progress: Record<string, unknown>) => {
      if (crashed) throw new Error("synthetic process lost after checkpoint");
      checkpoints.push(structuredClone(progress));
      if (options.crashOnIncident && parseDeviceCloudProgress(progress).resources?.some(resource => resource.incident)) {
        crashed = true;
        throw new Error("synthetic crash after incident checkpoint");
      }
      if (options.crashOnArtifactUrl !== undefined && parseDeviceCloudProgress(progress).resources?.some(resource =>
        resource.artifacts?.some(artifact => artifact.url === options.crashOnArtifactUrl))) {
        crashed = true;
        throw new Error("synthetic crash after refreshed-signature checkpoint");
      }
    },
  };
  const attempt = options.progress === undefined ? runDeviceCloud(input) : cleanupDeviceCloud(input);
  return { attempt, checkpoints, errors };
}

function errorMessages(error: unknown): string {
  return error instanceof AggregateError ? [error.message, ...error.errors.map(errorMessages)].join("\n")
    : error instanceof Error ? error.message : String(error);
}

describe("BrowserStack fixed policy inputs", () => {
  test("bounded byte reads preserve binary data without relaxing the existing UTF-8 text decoder", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await boundedVendorBytes(new Response(bytes), "BrowserStack", bytes.length)).toEqual(bytes);
    await expect(boundedVendorText(new Response(bytes), "BrowserStack", bytes.length)).rejects.toThrow();
  });
  test("bounded bytes retain the declared and streaming size limits", async () => {
    await expect(boundedVendorBytes(new Response("synthetic", { headers: { "content-length": "9" } }), "BrowserStack", 8)).rejects.toThrow("oversized");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); },
      cancel() { cancelled = true; },
    });
    await expect(boundedVendorBytes(new Response(stream), "BrowserStack", 3)).rejects.toThrow("oversized");
    expect(cancelled).toBe(true);
  });
  test("the existing text reader still decodes a bounded UTF-8 character split across chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([0xe2])); controller.enqueue(new Uint8Array([0x82, 0xac])); controller.close(); },
    });
    expect(await boundedVendorText(new Response(stream), "BrowserStack", 3)).toBe("€");
  });
  test("pins disjoint storage, dashboard and documentation origins", () => {
    expect(pins.artifactOrigins).toEqual([
      "https://api.browserstack.com", "https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com", "https://bs-selenium-logs-use.s3.us-east-1.amazonaws.com",
    ]);
    expect(pins.dashboardOrigins).toEqual(["https://automate.browserstack.com"]);
    expect(pins.documentationOrigins).toEqual(["https://www.browserstack.com"]);
    expect(new Set([...pins.artifactOrigins, ...pins.dashboardOrigins, ...pins.documentationOrigins]).size).toBe(5);
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
  test.each(["SM-S942B", "SM-S942U1"])("records exact browser-reported versions and canonical allocated model %s", model => {
    expect(attestAllocation("browserstack", "ipad", { name: "iPad 10th", version: "27" }, ipad)).toEqual({ device: "iPad (10th generation)", os: "27.0", browser: "safari", browserVersion: "27.0" });
    expect(attestAllocation("browserstack", "android", { name: "Samsung Galaxy S26", version: "16.0" }, { ...samsung, browser: { ...samsung.browser, model } })).toEqual({ device: "Galaxy S26", model, os: "16.0.0", browser: "chrome", browserVersion: "152.0.7977.54" });
    expect(() => attestAllocation("browserstack", "android", { name: "Samsung Galaxy S25", version: "16.0" }, {
      ...samsung, browser: { ...samsung.browser, model }, vendorRecord: { ...samsung.vendorRecord, device: "Samsung Galaxy S25" },
    })).toThrow("canonical model");
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
    expect([...source.matchAll(/\bparseRetainedVendorJson\s*\(/gu)]).toHaveLength(5);
    expect(source).not.toMatch(/\.command\.includes\("BrowserStackLocal"\)/u);
  });
  const placements: [string, (value: unknown) => unknown][] = [];
  for (const field of ["logs", "insights", "reason"]) for (let depth = 0; depth < 6; depth++) {
    placements.push([`${field}/${depth}`, value => {
      let nested: unknown = value;
      for (let level = 0; level < depth; level++) nested = level % 2 === 0 ? [null, { child: nested }] : { arbitrary: nested };
      return { ...record, [field]: nested };
    }]);
  }
  test.each(placements)("class invariant: storage URL at %s is fetched, privately inventoried and absence-checked", async (_name, place) => {
    for (const origin of pins.artifactOrigins) {
      const nested = `${origin}/${id}/nested.txt?${artifactQuery}`;
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
  test("a whole-value signed log's interior capability window is an audit hit and a persisted incident", async () => {
    const fixture = provider({
      raw: JSON.stringify({ automation_session: { ...record, insights: [{ nested: { reason: nestedArtifact } }] } }),
      nestedLog: `synthetic retained fragment ${replayWindow}`,
    });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("cloud test records contain a live View or Control link");
    expect(errorMessages(error)).toContain("BrowserStack record removed under a retained-record incident");
    expect(errorMessages(error)).not.toContain("BrowserStack record removal could not be verified");
    expect(fixture.calls.filter(call => call.url === nestedArtifact)).toHaveLength(2);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.results.audit).toMatchObject({ recordsExposingLinks: 1 });
    expect(progress.resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordRemoved: true });
    expect(JSON.stringify(lane.checkpoints)).not.toContain(replayWindow);
  });
  const unavailableRequiredLog = { retry: { surface: "log", reply: {
    text: "SYNTHETIC_UNAVAILABLE_REQUIRED_LOG", status: 401, type: "text/plain",
  } } } as const;
  test("an untyped required-log audit failure persists an incident before clean deletion and absence", async () => {
    const fixture = provider(unavailableRequiredLog);
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("could not be audited");
    expect(lane.errors).toContain("BrowserStack required retained log is unavailable");
    expect(lane.checkpoints.map(parseDeviceCloudProgress).some(progress => progress.resources?.some(resource =>
      resource.vendor === "browserstack" && resource.incident === true && !resource.recordDeleted))).toBe(true);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.cleanupRequired).toBe(true);
    expect(progress.resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ audited: false, incident: true, recordDeleted: true, recordRemoved: true });
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.calls.filter(call => call.url === `${apiOrigin}/sessions/${id}/logs`)).toHaveLength(2);
    expect(fixture.calls.filter(call => call.url === artifact)).toHaveLength(1);
  });
  test("an untyped required-log failure survives a crash before release and fresh clean cleanup", async () => {
    const fixture = provider(unavailableRequiredLog);
    const crashed = auditedAttempt(fixture, { crashOnIncident: true });
    await expect(crashed.attempt).rejects.toThrow();
    const progress = structuredClone(crashed.checkpoints.at(-1));
    expect(parseDeviceCloudProgress(progress).resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ audited: false, incident: true, recordRemoved: false });
    expect(fixture.calls.some(call => call.method === "DELETE")).toBe(false);
    restore?.();
    const fresh = provider();
    const recovery = auditedAttempt(fresh, { progress });
    await expect(recovery.attempt).rejects.toThrow("incident");
    const deletion = fresh.calls.findIndex(call => call.method === "DELETE");
    expect(deletion).toBeGreaterThanOrEqual(0);
    expect(fresh.calls.findIndex(call => call.url.endsWith("/logs"))).toBeGreaterThan(deletion);
    expect(fresh.calls.filter(call => call.url === artifact)).toHaveLength(1);
    const after = parseDeviceCloudProgress(recovery.checkpoints.at(-1));
    expect(after.cleanupRequired).toBe(true);
    expect(after.resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ audited: false, incident: true, recordDeleted: true, recordRemoved: true });
  });
  const lateMetadata = JSON.stringify({ automation_session: { ...record, insights: { reference: nestedArtifact } } });
  const signedMetadata = (url: string) => JSON.stringify({ automation_session: { ...record, browser_console_logs_url: url } });
  test("re-signing an audited object checkpoints and polls the newest URL without an incident", async () => {
    const fixture = provider({
      raw: signedMetadata(oldSignature), preDeleteSessionRaw: signedMetadata(newSignature),
      additionalArtifacts: [oldSignature, newSignature], lingering: true, disappearsAfter: 2,
    });
    await fixture.audit();
    expect(fixture.removal.artifacts.filter(artifact => artifact.kind === "text")).toEqual([{ url: oldSignature, buildId: build, kind: "text" }]);
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.removal.artifacts.filter(artifact => artifact.kind === "text")).toEqual([{ url: newSignature, buildId: build, kind: "text" }]);
    expect(fixture.incidents).toEqual([]);
    expect(fixture.calls.filter(call => call.url === oldSignature)).toHaveLength(1);
    expect(fixture.calls.filter(call => call.url === newSignature)).toHaveLength(3);
    expect(fixture.clock.now()).toBe(4_000);
    expect((await fetch(oldSignature)).status).toBe(404);
    expect((await fetch(newSignature)).status).toBe(404);
  });
  async function signatureCheckpoint() {
    const fixture = provider({
      raw: signedMetadata(oldSignature), preDeleteSessionRaw: signedMetadata(newSignature),
      additionalArtifacts: [oldSignature, newSignature],
    });
    const crashed = auditedAttempt(fixture, { crashOnArtifactUrl: newSignature });
    await expect(crashed.attempt).rejects.toThrow();
    const progress = structuredClone(crashed.checkpoints.at(-1));
    const resource = parseDeviceCloudProgress(progress).resources?.find(resource => resource.vendor === "browserstack");
    expect(resource).toMatchObject({ audited: true, recordRemoved: false });
    expect(resource?.incident).not.toBe(true);
    expect(resource?.artifacts?.filter(artifact => artifact.kind === "text")).toEqual([{ url: newSignature, buildId: build, kind: "text" }]);
    expect(fixture.calls.some(call => call.method === "DELETE")).toBe(false);
    restore?.();
    return progress;
  }
  test("fresh cleanup uses the last checkpointed signature after a crash before DELETE", async () => {
    const progress = await signatureCheckpoint();
    const fresh = provider({ raw: signedMetadata(newSignature), additionalArtifacts: [oldSignature, newSignature], lingering: true, disappearsAfter: 2 });
    const recovery = auditedAttempt(fresh, { progress });
    await expect(recovery.attempt).resolves.toMatchObject({ restored: true });
    expect(fresh.calls.some(call => call.url === oldSignature)).toBe(false);
    expect(fresh.calls.filter(call => call.url === newSignature)).toHaveLength(4);
    expect(fresh.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    const resource = parseDeviceCloudProgress(recovery.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack");
    expect(resource).toMatchObject({ recordDeleted: true, recordRemoved: true, artifacts: [] });
    expect(resource?.incident).not.toBe(true);
  });
  test("loading older URL-based inventories keeps the last signature and every historical incident", async () => {
    const progress = parseDeviceCloudProgress(await signatureCheckpoint());
    const resource = progress.resources!.find(resource => resource.vendor === "browserstack")!;
    resource.artifacts = [{ url: oldSignature, buildId: build, kind: "text" }, ...resource.artifacts!];
    resource.incident = true;
    const legacy = structuredClone(progress);
    const normalized = parseDeviceCloudProgress(structuredClone(legacy)).resources!.find(resource => resource.vendor === "browserstack")!;
    expect(normalized.incident).toBe(true);
    expect(normalized.artifacts?.filter(artifact => artifact.kind === "text")).toEqual([{ url: newSignature, buildId: build, kind: "text" }]);
    for (const field of ["kind", "buildId"] as const) {
      const conflict = structuredClone(legacy);
      const owned = conflict.resources!.find(resource => resource.vendor === "browserstack")!;
      owned.artifacts = owned.artifacts!.map(artifact => artifact.url !== newSignature ? artifact
        : field === "kind" ? { ...artifact, kind: "media" } : { ...artifact, buildId: "c".repeat(40) });
      expect(() => parseDeviceCloudProgress(conflict)).toThrow("BrowserStack artifact identity changed");
    }
    const fresh = provider({ raw: signedMetadata(newSignature), additionalArtifacts: [oldSignature, newSignature] });
    const recovery = auditedAttempt(fresh, { progress: legacy });
    await expect(recovery.attempt).rejects.toThrow("incident");
    expect(fresh.calls.some(call => call.url === oldSignature)).toBe(false);
    expect(parseDeviceCloudProgress(recovery.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true, artifacts: [] });
  });
  test("discovery dedupes signatures without weakening classification or build identity", () => {
    expect(browserStackReferences(id, build, { reason: [oldSignature, newSignature] }).artifacts)
      .toEqual([{ url: newSignature, buildId: build, kind: "text" }]);
    expect(() => browserStackReferences(id, build, { reason: oldSignature, insights: { screenshot: newSignature } })).toThrow("classification changed");
    for (const changed of [{ url: newSignature, buildId: build, kind: "media" }, { url: newSignature, buildId: "c".repeat(40), kind: "text" }] as const) {
      const inventory: CloudArtifact[] = [{ url: oldSignature, buildId: build, kind: "text" }];
      expect(() => mergeBrowserStackArtifacts(id, inventory, [changed])).toThrow("BrowserStack artifact identity changed");
    }
  });
  const signatureKeys = ["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders", "X-Amz-Signature"];
  test("query-free references and complete signatures with an optional content type retain object identity", () => {
    const base = artifact.split("?")[0]!;
    const typed = `${newSignature}&response-content-type=text%2Fplain`;
    expect(browserStackReferences(id, build, { reason: [base, artifact, typed] }).artifacts)
      .toEqual([{ url: typed, buildId: build, kind: "text" }]);
  });
  test.each(["versionId", "response-content-disposition", "X-Amz-Security-Token", "synthetic", "version%49d"])("an unreviewed artifact query key fails closed: %s", key => {
    const unreviewed = `${artifact}&${key}=SYNTHETIC_UNREVIEWED_VALUE`;
    expect(() => browserStackReferences(id, build, { reason: unreviewed })).toThrow("unreviewed BrowserStack artifact reference");
    const inventory: CloudArtifact[] = [{ url: artifact, buildId: build, kind: "text" }];
    expect(() => mergeBrowserStackArtifacts(id, inventory, [{ url: unreviewed, buildId: build, kind: "text" }])).toThrow(BrowserStackAuditFailure);
    expect(inventory[0]?.url).toBe(artifact);
  });
  test.each([...signatureKeys, "response-content-type"])("duplicate signed-artifact query keys fail closed: %s", key => {
    const prefix = key === "response-content-type" ? `${artifact}&response-content-type=text%2Fplain` : artifact;
    expect(() => browserStackReferences(id, build, { reason: `${prefix}&${key}=SYNTHETIC_DUPLICATE` })).toThrow(BrowserStackAuditFailure);
  });
  test.each(signatureKeys)("a partial artifact signature without %s fails closed", key => {
    const partial = new URL(artifact);
    partial.searchParams.delete(key);
    expect(() => browserStackReferences(id, build, { reason: partial.href })).toThrow(BrowserStackAuditFailure);
  });
  test.each(["", "response-content-type=text%2Fplain"])("an empty or content-type-only artifact query fails closed: %s", query => {
    expect(() => browserStackReferences(id, build, { reason: `${artifact.split("?")[0]}?${query}` })).toThrow(BrowserStackAuditFailure);
  });
  const lateBody = JSON.stringify({ reference: nestedArtifact });
  function lateReference(surface: string): NonNullable<Parameters<typeof provider>[0]> {
    if (surface === "pre-delete") return { preDeleteSessionRaw: lateMetadata };
    if (surface === "delete") return { deleteReply: { text: JSON.stringify({ status: "ok", reference: nestedArtifact }), status: 200, type: "application/json" } };
    if (surface === "absence-session") return { postDeleteSessionRaw: lateMetadata };
    if (surface === "absence-log") return { postDeleteLog: lateBody };
    return { postDeleteArtifactReply: { text: lateBody, status: 404, type: "application/json" } };
  }
  test.each(["pre-delete", "delete", "absence-session", "absence-log", "absence-artifact"])("a new %s reference is an incident, never a late audit", async surface => {
    const fixture = provider({ ...lateReference(surface), nestedLog: replayWindow });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("incident");
    expect(fixture.incidents).toContain("post-audit retained reference");
    const discovered = lane.checkpoints.map(parseDeviceCloudProgress).filter(progress =>
      progress.resources?.some(resource => resource.artifacts?.some(artifact => artifact.url === nestedArtifact)));
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered.every(progress => progress.resources?.find(resource => resource.vendor === "browserstack")?.incident === true)).toBe(true);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ audited: true, incident: true, recordDeleted: true, recordRemoved: true });
    expect(progress.cleanupRequired).toBe(true);
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.calls.filter(call => call.url === nestedArtifact)).toHaveLength(1);
    expect(fixture.calls.findIndex(call => call.url === nestedArtifact)).toBeGreaterThan(fixture.calls.findIndex(call => call.method === "DELETE"));
    expect(fixture.inspected.some(record => record.text.includes(replayWindow))).toBe(false);
  });
  test.each(["pre-delete", "delete"])("a crash after the atomic %s-reference checkpoint survives fresh cleanup", async surface => {
    const fixture = provider(lateReference(surface));
    const crashed = auditedAttempt(fixture, { crashOnIncident: true });
    await expect(crashed.attempt).rejects.toThrow();
    const progress = structuredClone(crashed.checkpoints.at(-1));
    const resource = parseDeviceCloudProgress(progress).resources?.find(resource => resource.vendor === "browserstack");
    expect(resource).toMatchObject({ audited: true, incident: true, recordRemoved: false });
    expect(resource?.artifacts).toContainEqual({ url: nestedArtifact, buildId: build, kind: "text" });
    const before = fixture.calls.filter(call => call.method === "DELETE").length;
    expect(before).toBe(surface === "delete" ? 1 : 0);
    expect(fixture.calls.some(call => call.url === nestedArtifact)).toBe(false);
    restore?.();
    const fresh = provider(surface === "delete" ? { recordAlreadyDeleted: true } : { raw: lateMetadata });
    const recovery = auditedAttempt(fresh, { progress });
    await expect(recovery.attempt).rejects.toThrow("incident");
    expect(before + fresh.calls.filter(call => call.method === "DELETE").length).toBe(1);
    expect(fresh.calls.filter(call => call.url === nestedArtifact)).toHaveLength(1);
    const deletion = fresh.calls.findIndex(call => call.method === "DELETE");
    if (deletion !== -1) expect(fresh.calls.slice(0, deletion).some(call => call.url.endsWith("/logs"))).toBe(false);
    const after = parseDeviceCloudProgress(recovery.checkpoints.at(-1));
    expect(after.resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
    expect(after.cleanupRequired).toBe(true);
  });
  test("fresh cleanup detects a reference first appearing in its record re-read before it can be fetched", async () => {
    const fixture = provider();
    const interrupted = auditedAttempt(fixture, { interruptRemoval: true });
    await expect(interrupted.attempt).rejects.toThrow();
    const progress = structuredClone(interrupted.checkpoints.at(-1));
    expect(parseDeviceCloudProgress(progress).resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ audited: true, recordRemoved: false });
    restore?.();
    const fresh = provider({ raw: lateMetadata, nestedLog: replayWindow });
    const recovery = auditedAttempt(fresh, { progress });
    await expect(recovery.attempt).rejects.toThrow("incident");
    expect(recovery.errors).toContain("post-audit retained reference");
    expect(fresh.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(fresh.calls.filter(call => call.url === nestedArtifact)).toHaveLength(1);
    expect(fresh.calls.findIndex(call => call.url === nestedArtifact)).toBeGreaterThan(fresh.calls.findIndex(call => call.method === "DELETE"));
    expect(parseDeviceCloudProgress(recovery.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordRemoved: true });
  });
  const unlistedMetadata = JSON.stringify({ automation_session: { ...record, unlisted_log_url: nestedArtifact } });
  test.each(["schema", "census"])("post-audit %s validation failure checkpoints safe references and still deletes", async failure => {
    const raw = failure === "schema" ? unlistedMetadata : JSON.stringify({
      automation_session: { ...record, insights: { unaccounted: new URL(artifact).hostname, safe: nestedArtifact } },
    });
    const fixture = provider({ preDeleteSessionRaw: raw });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).rejects.toThrow();
    expect(fixture.incidents).toContain("post-audit unvalidated record");
    const saved = lane.checkpoints.map(parseDeviceCloudProgress).find(progress =>
      progress.resources?.some(resource => resource.incident && resource.artifacts?.some(artifact => artifact.url === nestedArtifact)));
    expect(saved).toBeDefined();
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.calls.filter(call => call.url === nestedArtifact)).toHaveLength(1);
    expect(fixture.calls.findIndex(call => call.url === nestedArtifact)).toBeGreaterThan(fixture.calls.findIndex(call => call.method === "DELETE"));
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
    expect(progress.cleanupRequired).toBe(true);
  });
  test("a crash after an unvalidated-record checkpoint preserves references for fresh cleanup", async () => {
    const fixture = provider({ preDeleteSessionRaw: unlistedMetadata });
    const crashed = auditedAttempt(fixture, { crashOnIncident: true });
    await expect(crashed.attempt).rejects.toThrow();
    const progress = structuredClone(crashed.checkpoints.at(-1));
    const resource = parseDeviceCloudProgress(progress).resources?.find(resource => resource.vendor === "browserstack");
    expect(resource).toMatchObject({ incident: true, recordRemoved: false });
    expect(resource?.artifacts).toContainEqual({ url: nestedArtifact, buildId: build, kind: "text" });
    expect(fixture.calls.some(call => call.method === "DELETE")).toBe(false);
    restore?.();
    const fresh = provider({ raw: unlistedMetadata });
    const recovery = auditedAttempt(fresh, { progress });
    await expect(recovery.attempt).rejects.toThrow("incident");
    expect(fresh.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(fresh.calls.filter(call => call.url === nestedArtifact)).toHaveLength(1);
    expect(parseDeviceCloudProgress(recovery.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
  });
  test("a malformed DELETE acknowledgement cannot prevent normal absence verification", async () => {
    const fixture = provider({ deleteReply: { text: "SYNTHETIC MALFORMED JSON {", status: 200, type: "application/json" } });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).rejects.toThrow();
    expect(fixture.incidents).toContain("post-audit unvalidated record");
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.calls.filter(call => call.url === artifact)).toHaveLength(2);
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
  });
  test("a malformed absence body persists an incident while polling still converges", async () => {
    const fixture = provider({ postDeleteLog: "SYNTHETIC MALFORMED JSON {" });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).rejects.toThrow();
    expect(fixture.incidents).toContain("post-audit unvalidated record");
    expect(fixture.calls.filter(call => call.url === `${apiOrigin}/sessions/${id}/logs`)).toHaveLength(3);
    expect(fixture.clock.now()).toBe(2_000);
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordRemoved: true });
  });
  test("a malformed lingering artifact still exhausts the existing absence bound", async () => {
    const fixture = provider({ postDeleteArtifactReply: { text: "SYNTHETIC MALFORMED JSON {", status: 200, type: "application/json" } });
    await fixture.audit();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow("retained signed artifact absence could not be verified");
    expect(fixture.incidents).toContain("post-audit unvalidated record");
    expect(fixture.removal.deleted).toBe(true);
    expect(fixture.clock.now()).toBe(180_000);
  });
  test("an empty inventory blocks restoration only after record and all log absence is verified", async () => {
    const fixture = provider({ raw: JSON.stringify({ automation_session: { hashed_id: id, build_hashed_id: build, status: "running" } }) });
    expect((await fixture.audit())?.complete).toBe(false);
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow("BrowserStack retained artifact inventory is unavailable");
    const deletion = fixture.calls.findIndex(call => call.method === "DELETE");
    expect(deletion).toBeGreaterThanOrEqual(0);
    expect(fixture.calls.slice(deletion + 1).map(call => call.url)).toEqual([
      `${apiOrigin}/sessions/${id}.json`,
      ...["logs", "networklogs", "consolelogs", "seleniumlogs", "appiumlogs", "telemetrylogs"].map(surface => `${apiOrigin}/sessions/${id}/${surface}`),
    ]);
    expect(fixture.removal.deleted).toBe(true);
    expect(fixture.removal.artifacts).toEqual([]);
    expect(fixture.incidents).toEqual([]);
  });
  const noSuchKey = "<Error><Code>NoSuchKey</Code><Message>SYNTHETIC MISSING OBJECT</Message></Error>";
  test.each(["application/xml", "text/plain", "application/json"])("a clean %s artifact 404 converges without an incident", async type => {
    const reply = { status: 404, type, text: type === "application/json" ? JSON.stringify({ code: "NoSuchKey" }) : noSuchKey };
    const fixture = provider({ artifactReply: reply, postDeleteArtifactReply: reply });
    const lane = auditedAttempt(fixture);
    expect(await lane.attempt).toMatchObject({ passed: true });
    expect(fixture.incidents).toEqual([]);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.cleanupRequired).toBe(false);
    expect(progress.resources?.find(resource => resource.vendor === "browserstack")?.incident).not.toBe(true);
    expect(fixture.inspected.some(record => record.text.includes(reply.text))).toBe(true);
  });
  test.each(["audit", "absence"])("an XML 404 capability window persists an incident during %s", async stage => {
    const clean = { text: noSuchKey, status: 404, type: "application/xml" };
    const exposed = { ...clean, text: `<Error><Code>NoSuchKey</Code><Message>${replayWindow}</Message></Error>` };
    const fixture = provider({ artifactReply: stage === "audit" ? exposed : clean, postDeleteArtifactReply: stage === "absence" ? exposed : clean });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("incident");
    expect(fixture.inspected.some(record => record.text.includes(replayWindow))).toBe(true);
    expect(fixture.incidents).not.toContain("post-audit unvalidated record");
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordRemoved: true });
    expect(JSON.stringify(lane.checkpoints)).not.toContain(replayWindow);
  });
  test.each([new URL(artifact).hostname, new URL(artifact).hostname.replaceAll(".", "%2e")])("non-JSON artifact errors still enforce the raw hostname census: %s", async host => {
    const fixture = provider({ postDeleteArtifactReply: { text: `<Error><Code>NoSuchKey</Code><Message>${host}</Message></Error>`, status: 404, type: "application/xml" } });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).rejects.toThrow();
    expect(fixture.incidents).toContain("post-audit unvalidated record");
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordRemoved: true });
  });
  test("a JSON 404 still inventories declared whole-value references", async () => {
    const reply = { text: JSON.stringify({ code: "NoSuchKey", log_url: nestedArtifact }), status: 404, type: "application/json" };
    const fixture = provider({ artifactReply: reply, postDeleteArtifactReply: reply });
    const lane = auditedAttempt(fixture);
    expect(await lane.attempt).toMatchObject({ passed: true });
    expect(fixture.calls.filter(call => call.url === nestedArtifact)).toHaveLength(2);
    expect(fixture.incidents).toEqual([]);
  });
  test("whole-value references accept case-insensitive schemes and preserve duplicate/classification checks", () => {
    const upper = nestedArtifact.replace("https:", "HtTpS:");
    expect(browserStackReferences(id, build, { reason: [{ arbitrary: upper }] }).artifacts).toEqual([{ url: upper, buildId: build, kind: "text" }]);
    expect(browserStackReferences(id, build, { reason: [artifact, nestedArtifact, artifact] }).artifacts.map(item => item.url)).toEqual([artifact, nestedArtifact]);
    expect(() => browserStackReferences(id, build, { reason: artifact, insights: { screenshot: artifact } })).toThrow("classification changed");
    expect(() => browserStackReferences(id, build, { reason: `http://${new URL(artifact).hostname}/${id}/log` })).toThrow(BrowserStackAuditFailure);
  });
  test.each(placements)("census invariant: every unaccounted key/value reference at %s fails closed", async (_name, place) => {
    for (const origin of [...pins.artifactOrigins, ...pins.dashboardOrigins]) {
      const host = new URL(origin).hostname, url = `${origin}/${id}/nested.txt`;
      const variants: unknown[] = [
        { [host]: "synthetic key" }, { [url]: "synthetic URL key" },
        `(${url})`, `${url},${url}`, `${url}${url}`, `${url};${url}`,
        host, `${url}?nested=${encodeURIComponent(url)}`, `${url}?host=${host}`, `See ${url} for details`,
        `${url}?nested=${encodeURIComponent(`${[...pins.artifactOrigins, ...pins.dashboardOrigins].find(other => other !== origin)!}/${id}/other.txt`)}`,
      ];
      for (const value of variants) {
        const fixture = provider({ raw: JSON.stringify({ automation_session: place(value) }) });
        await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
        expect(fixture.calls).toHaveLength(1);
        restore?.();
      }
      const raw = JSON.stringify({ automation_session: place(url) }).replaceAll(host, host.replaceAll(".", "\\u002e"));
      const fixture = provider({ raw });
      await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
      expect(fixture.calls).toHaveLength(1);
      restore?.();
    }
  });
  test("raw and canonical host censuses independently equal accepted reference occurrences", async () => {
    const value = { reason: [artifact, artifact] };
    expect(browserStackReferences(id, build, value).artifacts).toHaveLength(1);
    for (const raw of [JSON.stringify({ reason: artifact }), JSON.stringify({ reason: [artifact, artifact, artifact] })]) {
      expect(() => browserStackReferences(id, build, value, false, raw)).toThrow("unaccounted BrowserStack artifact reference");
    }
    expect(() => browserStackReferences(id, build, { reason: `${artifact}&nested=${encodeURIComponent(`https://api.browserstack.com/${id}/other.txt`)}` })).toThrow("unaccounted BrowserStack artifact reference");
    const fixture = provider({ raw: JSON.stringify({ automation_session: record }).replaceAll("/", "\\/") });
    expect((await fixture.audit())?.complete).toBe(true);
  });
  test.each(["session", "log", "artifact", "delete", "post-session", "post-log", "post-artifact", "retry"])("every retained %s JSON body enforces the census", async surface => {
    const json = { [new URL(artifact).hostname]: "synthetic unaccounted key" };
    const raw = JSON.stringify(json), metadata = JSON.stringify({ automation_session: { ...record, insights: json } });
    const reply = { text: raw, status: 200, type: "application/json" };
    const options: NonNullable<Parameters<typeof provider>[0]> = {};
    if (surface === "session") options.raw = metadata;
    if (surface === "log") options.logReply = reply;
    if (surface === "artifact") options.artifactReply = reply;
    if (surface === "delete") options.deleteReply = { ...reply, text: JSON.stringify({ status: "ok", ...json }) };
    if (surface === "post-session") options.postDeleteSessionRaw = metadata;
    if (surface === "post-log") options.postDeleteLog = raw;
    if (surface === "post-artifact") options.postDeleteArtifactReply = { ...reply, status: 404 };
    if (surface === "retry") options.retry = { surface: "session", reply: { ...reply, status: 502 } };
    const fixture = provider(options);
    if (surface === "delete" || surface.startsWith("post-")) {
      await fixture.audit();
      await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
      expect(fixture.incidents).toContain("post-audit unvalidated record");
      expect(fixture.removal.deleted).toBe(true);
    } else await expect(fixture.audit()).rejects.toThrow("unaccounted BrowserStack artifact reference");
  });
  test.each(placements)("class invariant: unreviewed origin anywhere at %s fails closed", async (_name, place) => {
    const fixture = provider({ raw: JSON.stringify({ automation_session: place(`https://unreviewed.example/${id}/opaque`) }) });
    await expect(fixture.audit()).rejects.toThrow("unreviewed");
    expect(fixture.calls).toHaveLength(1);
  });
  test.each(placements)("class invariant: embedded unknown/dashboard origins at %s fail closed", async (_name, place) => {
    for (const origin of ["https://unreviewed.example", ...pins.dashboardOrigins]) {
      const fixture = provider({ raw: JSON.stringify({ automation_session: place(`See ${origin}/${id}/opaque for details`) }) });
      await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
      expect(fixture.calls).toHaveLength(1);
      restore?.();
    }
  });
  test.each(placements)("class invariant: scheme-less pinned storage host at %s fails closed", async (_name, place) => {
    for (const origin of pins.artifactOrigins) {
      for (const value of [
        `See ${new URL(origin).hostname.toUpperCase()}/${id}/log`,
        `See ${artifact} and //${new URL(origin).hostname}/${id}/log`,
        `See ${new URL(origin).hostname}/${id}/log and ${artifact}`,
      ]) {
        const fixture = provider({ raw: JSON.stringify({ automation_session: place(value) }) });
        await expect(fixture.audit()).rejects.toThrow("unaccounted BrowserStack artifact reference");
        expect(fixture.calls).toHaveLength(1);
        restore?.();
      }
    }
  });
  test("only top-level dashboard presentation fields are counted and never fetched", async () => {
    const browserUrl = presentation.browser_url;
    const publicUrl = presentation.public_url;
    const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, browser_url: browserUrl, public_url: publicUrl } }) });
    expect((await fixture.audit())?.dashboardReferences).toBe(3);
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.calls.some(call => call.url === browserUrl || call.url === publicUrl)).toBe(false);
    expect(fixture.removal.artifacts.some(item => item.url.startsWith(pins.dashboardOrigins[0]!))).toBe(false);
    restore?.();
    const misplaced = provider({ raw: JSON.stringify({ automation_session: { ...record, insights: { browser_url: browserUrl } } }) });
    await expect(misplaced.audit()).rejects.toThrow("unreviewed");
  });
  test.each([
    ["video data URI", "data:video/mp4;base64,SYNTHETIC_VIDEO_INDICATOR"],
    ["image data URI", "data:image/png;base64,SYNTHETIC_IMAGE_INDICATOR"],
    ["plain string", "SYNTHETIC_NON_URL_INDICATOR"],
    ["storage URL", video],
    ["another dashboard URL", presentation.browser_url],
    ["wrong session", presentation.video_url.replace(id, "c".repeat(40))],
    ["empty string", ""],
    ["missing", undefined],
    ["null", null],
    ["boolean", false],
    ["object", {}],
    ["array", []],
  ] as const)("finalized video_url rejects a %s instead of treating it as an exempt indicator", async (_name, value) => {
    const metadata = { ...record, video_url: value };
    expect(() => browserStackReferences(id, build, metadata, true)).toThrow(BrowserStackAuditFailure);
    const fixture = provider({ raw: JSON.stringify({ automation_session: metadata }) });
    await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
    expect(fixture.calls).toHaveLength(1);
  });
  test("the pinned finalized video presentation is mandatory, counted and never fetched or inventoried", async () => {
    const fixture = provider();
    expect(await fixture.audit()).toMatchObject({ complete: true, video: false, screenshots: 0, dashboardReferences: 1 });
    expect(fixture.removal.artifacts).toEqual([{ url: artifact, buildId: build, kind: "text" }]);
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.incidents).toEqual([]);
    expect(fixture.calls.some(call => call.url === presentation.video_url || call.url === video)).toBe(false);
  });
  test.each(["data:video/mp4;base64,SYNTHETIC_LATE_VIDEO", undefined])("an invalid post-audit video indicator persists an incident while deletion still completes: %s", async value => {
    const fixture = provider({ preDeleteSessionRaw: JSON.stringify({ automation_session: { ...record, video_url: value } }) });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("incident");
    expect(fixture.incidents).toContain("post-audit unvalidated record");
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ audited: true, incident: true, recordDeleted: true, recordRemoved: true });
  });
  test("running metadata does not exempt an unvalidated video value from media detection", async () => {
    const fixture = provider({ preDeleteSessionRaw: JSON.stringify({ automation_session: {
      ...record, status: "running", video_url: "data:video/mp4;base64,SYNTHETIC_RUNNING_VIDEO",
    } }) });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("incident");
    expect(fixture.inspected.some(record => record.screenshots > 0)).toBe(true);
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
  });
  test.each([
    { video_url: "data:video/mp4;base64,SYNTHETIC_RUNNING_VIDEO" },
    { video_url: "data:image/png;base64,SYNTHETIC_RUNNING_IMAGE" },
    { video_url: { payload: "SYNTHETIC_RUNNING_MEDIA" } },
    { video_url: ["SYNTHETIC_RUNNING_MEDIA"] },
    { insights: { screenshot: "data:image/png;base64,SYNTHETIC_RUNNING_IMAGE" } },
    { insights: { visual: { payload: "SYNTHETIC_RUNNING_MEDIA" } } },
  ])("running session media remains an incident after a clean finalized record: %j", async media => {
    const running = { hashed_id: id, status: "running", ...media };
    const fixture = provider({ retry: { surface: "session", reply: {
      text: JSON.stringify({ automation_session: running }), status: 200, type: "application/json",
    } } });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("incident");
    expect(fixture.inspected.some(record => !record.complete && record.screenshots > 0)).toBe(true);
    const hit = lane.checkpoints.findIndex(progress => parseDeviceCloudProgress(progress).resources?.some(resource => resource.incident));
    const finalized = lane.checkpoints.findIndex(progress => parseDeviceCloudProgress(progress).results.audit !== undefined);
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(finalized).toBeGreaterThan(hit);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.cleanupRequired).toBe(true);
    expect(progress.resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
    expect(fixture.calls.filter(call => call.url === artifact)).toHaveLength(2);
    expect(fixture.clock.now()).toBe(2_000);
  });
  test("a running record without a video indicator stays clean when it finalizes", async () => {
    const fixture = provider({ retry: { surface: "session", reply: {
      text: JSON.stringify({ automation_session: { hashed_id: id, status: "running" } }), status: 200, type: "application/json",
    } } });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).resolves.toMatchObject({ passed: true, audit: { recordsWithMedia: 0 } });
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.some(resource => resource.incident)).toBe(false);
  });
  test("the observed finalized Galaxy record audits clean without fetching presentation or docs hosts", async () => {
    const fixture = provider({
      raw: JSON.stringify({ automation_session: observedRecord }),
      additionalArtifacts: Object.values(observedArtifacts), xmlLogs: true,
      log: "synthetic device http://192.0.2.10:4444 navigated https://example.com",
    });
    const audited = await fixture.audit();
    expect(audited).toMatchObject({ complete: true, video: false, screenshots: 0, dashboardReferences: 4 });
    expect(fixture.removal.artifacts.map(artifact => artifact.url).sort()).toEqual(Object.values(observedArtifacts).sort());
    expect(audited?.text).toContain(documentation);
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.incidents).toEqual([]);
    expect(fixture.calls.some(call => [...pins.dashboardOrigins, ...pins.documentationOrigins].some(origin => call.url.startsWith(origin)))).toBe(false);
    expect(fixture.calls.filter(call => Object.values(observedArtifacts).includes(call.url))).toHaveLength(12);
  });
  test.each(Object.keys(presentation) as (keyof typeof presentation)[])("observed %s presentation binds ids and rejects extra parameters/fragments", async field => {
    const value = presentation[field];
    const wrong = "c".repeat(40);
    const invalid = [
      value.replace(id, wrong),
      field === "video_url" ? value.replace("/sessions/", `/builds/${wrong}/sessions/`) : value.replace(build, wrong),
      `${value}${value.includes("?") ? "&" : "?"}extra=SYNTHETIC`,
      `${value}#synthetic-fragment`,
    ];
    for (const url of invalid) {
      const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, [field]: url } }) });
      await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
      expect(fixture.calls).toHaveLength(1);
      restore?.();
    }
  });
  test.each(["public_url", "video_url"] as const)("observed %s token validation rejects dots and missing/duplicate parameters", async field => {
    const value = presentation[field];
    const invalid = [
      value.replace(/(auth_token|token)=[^&]*/u, "$1=SYNTHETIC_DOTTED_TOKEN.value"),
      value.replace(/(auth_token|token)=[^&]*/u, "$1=short"),
      `${value}&${field === "public_url" ? "auth_token" : "token"}=SYNTHETIC_DUPLICATE`,
      value.replace(/(auth_token|token)=[^&]*/u, "$1="),
    ];
    for (const url of invalid) {
      const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, [field]: url } }) });
      await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
      restore?.();
    }
  });
  test.each(["not_decimal", "1e9", "-1", "1.2.3", "9.", "12345678901", "1.1234567890123"])("video diff rejects non-observed decimal forms: %s", diff => {
    expect(() => browserStackReferences(id, build, { video_url: presentation.video_url.replace("1.234567890", diff) }, true)).toThrow(BrowserStackAuditFailure);
  });
  test("dashboard fields do not retain the old generic paths or misplaced logs paths", () => {
    for (const [field, url] of [
      ["browser_url", `https://automate.browserstack.com/dashboard/v2/sessions/${id}`],
      ["logs", presentation.browser_url],
      ["logs", `${presentation.logs}/extra`],
      ["reason", presentation.logs],
    ] as const) expect(() => browserStackReferences(id, build, { [field]: url }, true)).toThrow(BrowserStackAuditFailure);
  });
  test.each(["public_url", "video_url"] as const)("empty query separators are not the pinned %s shape", field => {
    for (const url of [presentation[field].replace("?", "?&"), `${presentation[field]}&`, `${presentation[field]}&&`])
      expect(() => browserStackReferences(id, build, { [field]: url }, true)).toThrow(BrowserStackAuditFailure);
  });
  test("the exact video query keys do not pin parameter order", () => {
    const url = `${presentation.video_url.split("?")[0]}?diff=1.234567890&source=TEST_SYN&token=${"SYNTHETIC_VIDEO_ONLY_".padEnd(194, "X")}`;
    expect(browserStackReferences(id, build, { video_url: url }, true)).toEqual({ artifacts: [], dashboardReferences: 1 });
  });
  test.each(["browserstack_time", "user_time", "capabilities_impact"])("only the observed %s optimize_url path accepts documentation references", component => {
    const metadata = { insights: { summary: { time_breakdown: { [component]: { optimize_url: documentation } } } } };
    expect(browserStackReferences(id, build, metadata, true)).toEqual({ artifacts: [], dashboardReferences: 0 });
    expect(() => browserStackReferences(id, build, metadata)).toThrow(BrowserStackAuditFailure);
    for (const value of [
      { reason: documentation },
      { insights: { optimize_url: documentation } },
      { insights: { summary: { time_breakdown: { [component]: { hint: documentation } } } } },
      { insights: { summary: { time_breakdown: { unobserved_component: { optimize_url: documentation } } } } },
      { insights: [{ summary: { time_breakdown: { [component]: { optimize_url: documentation } } } }] },
    ]) expect(() => browserStackReferences(id, build, value, true)).toThrow(BrowserStackAuditFailure);
  });
  test.each([
    `${documentation.split("#")[0]}?query=synthetic`,
    "https://www.browserstack.com/automate/synthetic",
    "https://www.browserstack.com/docs/synthetic/page.html",
    "https://www.browserstack.com/docs/synthetic#dotted.fragment",
    "https://www.browserstack.com/docs/synthetic#",
    "https://synthetic@www.browserstack.com/docs/synthetic",
    "https://www.browserstack.com:443/docs/synthetic",
  ])("documentation URL shape fails closed: %s", url => {
    expect(() => browserStackReferences(id, build, {
      insights: { summary: { time_breakdown: { browserstack_time: { optimize_url: url } } } },
    }, true)).toThrow(BrowserStackAuditFailure);
  });
  test("an accepted optimization document is not classified as retained video by its slug", async () => {
    const fixture = provider({
      raw: JSON.stringify({ automation_session: { ...observedRecord, insights: { summary: { time_breakdown: {
        browserstack_time: { optimize_url: "https://www.browserstack.com/docs/automate/selenium/video" },
      } } } } }),
      additionalArtifacts: Object.values(observedArtifacts), xmlLogs: true,
    });
    expect(await fixture.audit()).toMatchObject({ complete: true, video: false, screenshots: 0, dashboardReferences: 4 });
  });
  test.each(["%2E", "%2e", "%252E", "%2525252E", "%252525252E"])("percent-escaped nested hosts fail closed at every query surface (dots=%s)", async escape => {
    const host = new URL(nestedArtifact).hostname.replaceAll(".", escape);
    const nested = `https%3A%2F%2F${host}%2F${id}%2Fnested.txt`;
    for (const field of ["browser_url", "public_url", "reason"]) {
      const value = field === "reason" ? `${artifact}&nested=${nested}` : `https://automate.browserstack.com/builds/${build}/sessions/${id}?auth_token=${nested}`;
      const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, [field]: value } }) });
      await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
      expect(fixture.calls).toHaveLength(1);
      restore?.();
    }
  });
  test.each(["%2E", "%2e", "%252E"])("the decoded census detects hidden hostname-only keys, values and artifact queries (dots=%s)", async escape => {
    const host = new URL(nestedArtifact).hostname.replaceAll(".", escape);
    for (const json of [{ [host]: "synthetic" }, { hint: host }, { reason: artifact.replace("SYNTHETIC_DEFAULT_SIGNATURE", host) }]) {
      const fixture = provider({ log: JSON.stringify(json), logType: "application/json" });
      await expect(fixture.audit()).rejects.toThrow("unaccounted BrowserStack artifact reference");
      restore?.();
    }
  });
  test.each(["%3A%2F%2F", "%3a%2f%2f", "%253A%252F%252F"])("an accepted artifact may contain exactly one decoded scheme separator (separator=%s)", separator => {
    const value = `${artifact}&nested=https${separator}unreviewed.example%2Fsynthetic`;
    expect(() => browserStackReferences(id, build, { reason: value })).toThrow("unaccounted BrowserStack artifact reference");
  });
  test("percent decoding leaves malformed escapes literal and accepts a clean four-pass fixpoint", () => {
    for (const suffix of ["%zz%2G%tail%", "%41%42%43", "%25252541"]) {
      expect(browserStackReferences(id, build, { reason: artifact.replace("SYNTHETIC_DEFAULT_SIGNATURE", suffix) }).artifacts).toHaveLength(1);
    }
    expect(() => browserStackReferences(id, build, { reason: artifact.replace("SYNTHETIC_DEFAULT_SIGNATURE", "%2525252541") })).toThrow("unaccounted BrowserStack artifact reference");
  });
  test.each([
    "?auth_token=synthetic.dotted", "?dotted.key=synthetic", "?auth_token=synthetic%2Esuffix",
    "?auth_token=synthetic+suffix", "#synthetic-fragment", "/extra.segment", "//empty",
    "/../synthetic-normalized", "?auth_token=%zz",
  ])("dashboard presentation exact shapes reject %s", async suffix => {
    const url = `https://automate.browserstack.com/builds/${build}/sessions/${id}${suffix}`;
    const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, browser_url: url } }) });
    await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
    expect(fixture.calls).toHaveLength(1);
  });
  test.each(["synthetic@", ":443", ":444"])("dashboard presentation authority rejects userinfo/ports: %s", async extra => {
    const authority = extra.endsWith("@") ? `${extra}automate.browserstack.com` : `automate.browserstack.com${extra}`;
    const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, public_url: presentation.public_url.replace("automate.browserstack.com", authority) } }) });
    await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
    expect(fixture.calls).toHaveLength(1);
  });
  test.each(["browser_url", "public_url"])("a dashboard URL embedded in top-level %s is not exempt", async field => {
    const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, [field]: `See https://automate.browserstack.com/dashboard/v2/sessions/${id} for details` } }) });
    await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
    expect(fixture.calls).toHaveLength(1);
  });
  const rejectedSurfaces = [
    ["DELETE", "deleteReply", 401, "text/plain", "BrowserStack record deletion failed with HTTP 401"],
    ["post-audit signed artifact", "postDeleteArtifactReply", 401, "application/json", "BrowserStack retained signed artifact state is unknown"],
    ["pre-audit session", "sessionReply", 401, "application/json", "BrowserStack allocation read failed with HTTP 401"],
    ["pre-audit log", "logReply", 401, "application/json", "BrowserStack required retained log is unavailable"],
    ["pre-audit log format", "logReply", 200, "application/octet-stream", "BrowserStack returned an unexpected log format"],
    ["pre-audit signed artifact", "artifactReply", 401, "application/json", "BrowserStack retained artifact state is unknown"],
    ["pre-audit signed artifact format", "artifactReply", 200, "application/octet-stream", "BrowserStack retained artifact state is unknown"],
  ] as const;
  test.each(rejectedSurfaces)("%s body is scanned and persists an incident before its original rejection", async (_surface, option, status, type, message) => {
    const text = type === "application/json"
      ? JSON.stringify({ reason: replayWindow }).replace(replayWindow[0]!, `\\u${replayWindow.charCodeAt(0).toString(16).padStart(4, "0")}`)
      : `synthetic rejected fragment ${replayWindow}`;
    const fixture = provider({ [option]: { text, status, type } });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).rejects.toThrow();
    expect(lane.errors).toContain(message);
    expect(fixture.inspected.some(record => record.text.includes(replayWindow))).toBe(true);
    expect(fixture.inspected.some(record => record.text.includes(text))).toBe(true);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.resources?.find(resource => resource.vendor === "browserstack")?.incident).toBe(true);
    expect(progress.cleanupRequired).toBe(true);
    expect(JSON.stringify(lane.checkpoints)).not.toContain(replayWindow);
  });
  test.each(["deleteReply", "postDeleteArtifactReply"] as const)("rejected JSON from %s is canonical-scanned and discovers whole-value references", async option => {
    const raw = JSON.stringify({ reason: replayWindow, insights: { log: nestedArtifact } })
      .replace(replayWindow[0]!, `\\u${replayWindow.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const fixture = provider({ [option]: { text: raw, status: 401, type: "application/json" } });
    await fixture.audit();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow(option === "deleteReply" ? "deletion failed with HTTP 401" : "signed artifact state is unknown");
    expect(fixture.inspected.some(record => record.text.includes(raw) && record.text.includes(replayWindow))).toBe(true);
    expect(fixture.removal.artifacts.map(item => item.url)).toContain(nestedArtifact);
  });
  test.each(["session", "log", "artifact"] as const)("a 5xx %s body persists an incident before GET retry succeeds", async surface => {
    const raw = JSON.stringify({ reason: replayWindow }).replace(replayWindow[0]!, `\\u${replayWindow.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const fixture = provider({ retry: { surface, reply: { text: raw, status: 502, type: "application/json" } } });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("incident");
    const url = surface === "session" ? `${apiOrigin}/sessions/${id}.json` : surface === "log" ? `${apiOrigin}/sessions/${id}/logs` : artifact;
    expect(fixture.calls.filter(call => call.url === url).length).toBeGreaterThanOrEqual(2);
    expect(fixture.inspected.some(record => record.text.includes(raw) && record.text.includes(replayWindow))).toBe(true);
    const hit = lane.checkpoints.findIndex(checkpoint => parseDeviceCloudProgress(checkpoint).resources?.some(resource => resource.incident));
    const audited = lane.checkpoints.findIndex(checkpoint => parseDeviceCloudProgress(checkpoint).results.audit !== undefined);
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(hit).toBeLessThan(audited);
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack")?.incident).toBe(true);
    expect(JSON.stringify(lane.checkpoints)).not.toContain(replayWindow);
  }, 15_000);
  test("a 502 unbound reference persists an incident before clean metadata permits deletion", async () => {
    const fixture = provider({
      retry: { surface: "session", reply: {
        text: JSON.stringify({ insights: [{ reason: nestedArtifact }] }),
        status: 502, type: "application/json",
      } },
    });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("incident");
    expect(lane.errors).toContain("unbound retained reference");
    const incident = lane.checkpoints.find(checkpoint => parseDeviceCloudProgress(checkpoint).resources?.some(resource => resource.incident));
    expect(parseDeviceCloudProgress(incident).resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, audited: false, recordRemoved: false });
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.calls.filter(call => call.url === artifact)).toHaveLength(1);
    expect(fixture.calls.some(call => call.url === nestedArtifact)).toBe(false);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordRemoved: true });
    expect(progress.cleanupRequired).toBe(true);
    expect(JSON.stringify(lane.checkpoints)).not.toContain(nestedArtifact);
  });
  test("a crash before build discovery leaves a durable incident that fresh cleanup cannot erase", async () => {
    const fixture = provider({
      retry: { surface: "session", reply: { text: JSON.stringify({ insights: { reason: nestedArtifact } }), status: 502, type: "application/json" } },
    });
    const crashed = auditedAttempt(fixture, { crashOnIncident: true });
    await expect(crashed.attempt).rejects.toThrow();
    expect(crashed.errors).toContain("unbound retained reference");
    expect(fixture.calls).toHaveLength(1);
    const progress = structuredClone(crashed.checkpoints.at(-1));
    expect(parseDeviceCloudProgress(progress).resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, audited: false, recordRemoved: false });
    expect(JSON.stringify(progress)).not.toContain(nestedArtifact);
    restore?.();
    const fresh = provider();
    const recovery = auditedAttempt(fresh, { progress });
    await expect(recovery.attempt).rejects.toThrow("incident");
    expect(fresh.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    const after = parseDeviceCloudProgress(recovery.checkpoints.at(-1));
    expect(after.resources?.find(resource => resource.vendor === "browserstack")).toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
    expect(after.cleanupRequired).toBe(true);
    expect(fresh.calls.filter(call => call.url === artifact)).toHaveLength(1);
  });
  test.each(["running", "done"])("a %s session with references but no build identity fails closed", async status => {
    const { build_hashed_id: _build, ...withoutBuild } = record;
    const fixture = provider({ raw: JSON.stringify({ automation_session: { ...withoutBuild, status, insights: { reason: nestedArtifact } } }) });
    await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
    expect(fixture.calls).toHaveLength(1);
  });
  test.each(["audit", "cleanup"])("an absent %s session body with unbound references fails closed", async operation => {
    const fixture = provider({ sessionReply: { text: JSON.stringify({ insights: { reason: nestedArtifact } }), status: 404, type: "application/json" } });
    const result = operation === "audit" ? fixture.audit() : fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    if (operation === "audit") await expect(result).rejects.toThrow("unbound retained reference");
    else {
      await expect(result).rejects.toThrow("record deletion could not be verified");
      expect(fixture.incidents).toContain("post-audit unvalidated record");
      expect(fixture.clock.now()).toBe(180_000);
    }
    if (operation === "audit") expect(fixture.calls).toHaveLength(1);
    else expect(fixture.calls.length).toBeGreaterThan(1);
  });
  test("fresh cleanup records an unvalidated pre-build body and still deletes after the retry", async () => {
    const fixture = provider({ retry: { surface: "session", reply: { text: JSON.stringify({ insights: { reason: nestedArtifact } }), status: 502, type: "application/json" } } });
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.incidents).toContain("post-audit unvalidated record");
    expect(fixture.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.calls.some(call => call.url === nestedArtifact)).toBe(false);
  }, 15_000);
  test("pre-finalization references are unbound even when running metadata reports a build", async () => {
    const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, status: "running", insights: { reason: nestedArtifact } } }) });
    await expect(fixture.audit()).rejects.toThrow("unbound retained reference");
    expect(fixture.removal.artifacts).toEqual([]);
  });
  test("pre-finalization without references or a build identity remains incomplete", async () => {
    const fixture = provider({ raw: JSON.stringify({ automation_session: { hashed_id: id, status: "running" } }) });
    expect((await fixture.audit())?.complete).toBe(false);
    expect(fixture.removal.artifacts).toEqual([]);
  });
  test("rejected media bodies stay unread and report media without scanning their bytes", async () => {
    const fixture = provider({ postDeleteArtifactReply: { text: replayWindow, status: 401, type: "video/mp4" } });
    await fixture.audit();
    await expect(fixture.api.deleteRecord(id, fixture.removal, fixture.clock)).rejects.toThrow("signed artifact state is unknown");
    expect(fixture.inspected.some(record => record.video)).toBe(true);
    expect(fixture.inspected.some(record => record.text.includes(replayWindow))).toBe(false);
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
  test("duplicate post-DELETE JSON is raw-scanned and flagged without blocking absence", async () => {
    const marker = "SYNTHETIC-LATE-DUPLICATE-CONTENT";
    const fixture = provider({ postDeleteLog: `{"step":"${marker}","step":"clean"}` });
    await fixture.audit();
    await fixture.api.deleteRecord(id, fixture.removal, fixture.clock);
    expect(fixture.incidents).toContain("post-audit unvalidated record");
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
  test.each([ ["missing required logs", { missingLogs: true }], ["oversized body", { large: true }] ] as const)("refuses %s", async (_name, options) => {
    const fixture = provider(options);
    await expect(fixture.api.testRecord(id)).rejects.toThrow();
  });
  test("an unknown signed-media state remains a failure outside the dashboard video indicator", async () => {
    const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, insights: { recording: video } } }), videoStatus: 401 });
    await expect(fixture.audit()).rejects.toThrow("video retention state is unknown");
  });
  test("reports kept media and refuses new/unreviewed retained surfaces", async () => {
    const fixture = provider({ raw: JSON.stringify({ automation_session: { ...record, insights: { recording: video } } }), media: true });
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
    expect(fixture.removal.artifacts).toEqual([{ url: artifact, buildId: build, kind: "text" }]);
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
  async function expectTextMedia(log: string, media: boolean): Promise<void> {
    const fixture = provider({ log });
    const lane = auditedAttempt(fixture);
    if (media) {
      const error = await lane.attempt.catch((error: unknown) => error);
      expect(errorMessages(error)).toContain("kept video or screenshots for 1 of 3 sessions");
      expect(errorMessages(error)).toContain("BrowserStack record removed under a retained-record incident");
      expect(errorMessages(error)).not.toContain("BrowserStack record removal could not be verified");
    } else await expect(lane.attempt).resolves.toMatchObject({ audit: { recordsWithMedia: 0 } });
    const resource = parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack");
    expect(resource?.incident === true).toBe(media);
    expect(resource?.recordRemoved).toBe(true);
  }
  function binaryBody(header: readonly number[], suffix = "SYNTHETIC_BINARY_BODY"): Uint8Array<ArrayBuffer> {
    return new Uint8Array([...header, ...new TextEncoder().encode(suffix)]);
  }
  function bitmapBody(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(58), view = new DataView(bytes.buffer);
    bytes.set([0x42, 0x4d]);
    view.setUint32(2, bytes.length, true);
    view.setUint32(10, 54, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, 1, true);
    view.setInt32(22, 1, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 24, true);
    return bytes;
  }
  const binaryBodies: readonly (readonly [string, Uint8Array<ArrayBuffer>])[] = [
    ["PNG", binaryBody([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["JPEG", binaryBody([0xff, 0xd8, 0xff])],
    ["GIF87a", binaryBody([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])],
    ["GIF89a", binaryBody([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
    ["WebP", binaryBody([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])],
    ["MP4", binaryBody([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])],
    ["WebM", binaryBody([0x1a, 0x45, 0xdf, 0xa3])],
    ["BMP", bitmapBody()],
  ];
  test.each(binaryBodies)("a signed .txt artifact containing raw %s bytes is a media incident despite text/plain", async (_kind, bytes) => {
    const fixture = provider({ artifactReply: { text: bytes, status: 200, type: "text/plain" } });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("kept video or screenshots");
    expect(fixture.inspected.some(record => record.screenshots > 0)).toBe(true);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.results.audit).toMatchObject({ recordsWithMedia: 1 });
    expect(progress.resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
  });
  test.each(["text/plain", "application/json", "application/octet-stream"])("raw PNG bytes in a retained log are media before rejecting their %s format", async type => {
    const fixture = provider({ logReply: { text: binaryBodies[0]![1], status: 200, type } });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).rejects.toThrow();
    expect(fixture.inspected.some(record => record.screenshots > 0)).toBe(true);
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
  });
  test("binary classification still scans decoded retained text for capability windows", async () => {
    const bytes = binaryBody([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `synthetic retained fragment ${replayWindow}`);
    const fixture = provider({ artifactReply: { text: bytes, status: 200, type: "text/plain" } });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).rejects.toThrow();
    expect(fixture.inspected.some(record => record.text.includes(replayWindow) && record.screenshots > 0)).toBe(true);
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).results.audit)
      .toMatchObject({ recordsWithMedia: 1, recordsExposingLinks: 1 });
    expect(JSON.stringify(lane.checkpoints)).not.toContain(replayWindow);
  });
  test("a mislabeled binary 404 during absence verification cannot erase a media incident", async () => {
    const fixture = provider({ postDeleteArtifactReply: { text: binaryBodies[0]![1], status: 404, type: "text/plain" } });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("incident");
    expect(fixture.inspected.some(record => record.screenshots > 0)).toBe(true);
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ incident: true, recordDeleted: true, recordRemoved: true });
  });
  test.each(["synthetic clean text log", "BM synthetic log without a plausible image header", "GIF87 synthetic text", "RIFF synthetic WAVE text", "ftyp synthetic text at the wrong offset"])("clean non-media bytes stay clean: %s", async text => {
    const fixture = provider({ artifactReply: { text, status: 200, type: "text/plain" } });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).resolves.toMatchObject({ passed: true, audit: { recordsWithMedia: 0 } });
  });
  test.each([
    ["UTF-16LE text without a charset", new Uint8Array(Buffer.from(`synthetic retained fragment ${replayWindow}`, "utf16le")), "text/plain"],
    ["an ASCII body declared UTF-16LE", "synthetic retained fragment", "text/plain; charset=utf-16le"],
    ["an ASCII body declared Latin-1", "synthetic retained fragment", "text/plain; charset=ISO-8859-1"],
    ["a later non-UTF-8 charset after a UTF-8 one", "synthetic retained fragment", "text/plain; charset=utf-8; charset=utf-7"],
    ["a repeated UTF-8 charset", "synthetic retained fragment", "text/plain; charset=utf-8; charset=utf-8"],
  ] as const)("%s is an unreviewed encoding: an incident that still deletes the record", async (_case, text, type) => {
    const fixture = provider({ artifactReply: { text, status: 200, type } });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("could not be audited");
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ incident: true, recordDeleted: true });
    expect(JSON.stringify(lane.checkpoints)).not.toContain(replayWindow);
  });
  test.each(["text/plain; charset=utf-8", "text/plain; charset=UTF-8", 'text/plain; charset="utf-8"', "text/plain; charset = utf-8", "text/plain; charset=us-ascii"])("a clean body declared %s stays clean", async type => {
    const fixture = provider({ artifactReply: { text: "synthetic clean text log", status: 200, type } });
    const lane = auditedAttempt(fixture);
    await expect(lane.attempt).resolves.toMatchObject({ passed: true, audit: { recordsWithMedia: 0 } });
  });
  test.each([
    [{ takesScreenshot: true }, false],
    [{ video: "false" }, false],
    [{ disableAutomaticScreenshots: true }, false],
    [{ screenshot: 1 }, false],
    [{ screenshot: null }, false],
    [{ screenshot: "" }, false],
    [{ screenshot: [] }, false],
    [{ screenshot: {} }, false],
    [{ screenshot: { value: "iVBORw0KGgoSYNTHETIC_NESTED_IMAGE" } }, true],
    [{ screenshot: [{ value: "SYNTHETIC_NESTED_IMAGE" }] }, true],
    [{ screenshot: "data:image/png;base64,SYNTHETIC_TEXT_IMAGE" }, true],
    [{ video: "https://media.invalid/SYNTHETIC_TEXT_VIDEO.mp4" }, true],
    [{ screenshot: "iVBORw0KGgoSYNTHETIC_TEXT_PNG" }, true],
    [{ screenshot: "/9j/SYNTHETIC_TEXT_JPEG" }, true],
    [{ screenshot: "R0lGODSYNTHETIC_TEXT_GIF" }, true],
    [{ screenshot: "UklGRSYNTHETIC_TEXT_WEBP" }, true],
    [{ screen: "https://media.invalid/SYNTHETIC_OPAQUE_IMAGE" }, true],
    [{ unrelated: "https://media.invalid/SYNTHETIC_TEXT_VIDEO.mp4?synthetic=true" }, true],
  ] as const)("text-log media includes media-valued strings and nonempty containers, not capability flags: %j", async (log, media) => {
    await expectTextMedia(JSON.stringify(log), media);
  });
  test.each([
    ["screenshot: {payload: opaque}", true],
    ["'screenshot': {payload: opaque}", true],
    ['"video" = [{payload: opaque}]', true],
    ["visual=[opaque]", true],
    ["video=data:video/mp4;base64,SYNTHETIC_VIDEO", true],
    ["'screen'='https://media.invalid/SYNTHETIC_OPAQUE_MEDIA'", true],
    ["screenshot=https://media.invalid/SYNTHETIC_OPAQUE_MEDIA", true],
    ["visual=iVBORw0KGgoSYNTHETIC_IMAGE", true],
    ["screen='data:application/octet-stream;base64,SYNTHETIC_SCREEN'", true],
    ['screenshot: "[REDACTED]"', false],
    ["screenshot='[REDACTED]'", false],
    ['screenshot: "{payload: opaque}"', false],
    ["takesScreenshot: true", false],
    ["disableAutomaticScreenshots=true", false],
    ['"video":"false"', false],
    ["screen=null", false],
    ["visual=1", false],
    ["screenshot={}", false],
    ["screenshot=[]", false],
    ["screenResolution={value: SYNTHETIC}", false],
  ] as const)("text media keys accept all reviewed quoting/separator forms without placeholder false positives: %s", async (log, media) => {
    await expectTextMedia(log, media);
  });
  test.each(["iVBORw0KGgo", "/9j/", "R0lGOD", "UklGR"])("bare %s image runs in raw prose are media", async signature => {
    const fixture = provider({ log: `synthetic image dump: ${signature}${"SYNTHETIC".repeat(8).slice(0, 64)} end` });
    const lane = auditedAttempt(fixture);
    const error = await lane.attempt.catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("kept video or screenshots");
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.vendor === "browserstack"))
      .toMatchObject({ incident: true, recordRemoved: true });
  });
  test.each(["iVBORw0KGgo", "/9j/", "R0lGOD", "UklGR"])("a short bare %s prefix alone is not an image run", async signature => {
    const fixture = provider({ log: `synthetic short prefix: ${signature}${"SYNTHETIC".repeat(8).slice(0, 63)} end` });
    expect((await fixture.audit())?.screenshots).toBe(0);
  });
  test.each(["log JSON", "session JSON"])("raw image runs are also detected outside media keys in %s", async surface => {
    const payload = `iVBORw0KGgo${"SYNTHETIC".repeat(8)}`;
    const fixture = provider(surface === "log JSON"
      ? { log: JSON.stringify({ result: payload }), logType: "application/json" }
      : { raw: JSON.stringify({ automation_session: { ...record, insights: { result: payload } } }) });
    expect((await fixture.audit())?.screenshots).toBe(1);
  });
  test("an unreviewed HTTP media URL fails closed", async () => {
    const fixture = provider({ log: JSON.stringify({ value: { screen: "https://media.example/opaque.webm" } }), logType: "application/json" });
    await expect(fixture.audit()).rejects.toThrow("unreviewed");
  });
  test("opaque data-image content remains a retained-media audit hit, not a fetched reference", async () => {
    const fixture = provider({ log: JSON.stringify({ value: { screen: "data:image/png;base64,synthetic" } }), logType: "application/json" });
    expect((await fixture.audit())?.screenshots).toBe(1);
  });
  const mediaKeys: [string, boolean][] = [
    ["data:image/png;base64,SYNTHETIC-MEDIA-KEY", true],
    ["DaTa:application/octet-stream,SYNTHETIC-DATA-KEY", false],
    [`https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/image.png`, true],
    [`https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${id}/video.mp4`, true],
  ];
  test.each(mediaKeys)("keys are media-classified and data/media keys fail closed: %s", async (key, media) => {
    const fixture = provider({ log: JSON.stringify({ nested: [{ [key]: null }] }), logType: "application/json" });
    await expect(fixture.api.testRecord(id, fixture.removal.remember, fixture.removal.inspect)).rejects.toThrow("BrowserStack retained media key");
    expect(fixture.inspected.some(record => record.screenshots > 0)).toBe(media);
  });
  test.each(placements)("media-key rejection holds at every retained metadata path: %s", async (_name, place) => {
    for (const [key] of mediaKeys) {
      const fixture = provider({ raw: JSON.stringify({ automation_session: place({ arbitrary: [{ [key]: null }] }) }) });
      await expect(fixture.audit()).rejects.toThrow(BrowserStackAuditFailure);
      expect(fixture.calls).toHaveLength(1);
      restore?.();
    }
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
