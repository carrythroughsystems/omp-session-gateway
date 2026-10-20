/** BrowserStack Automate Mobile: fixed catalog aliases, private Local, complete record audit/removal. */
import { createHash } from "node:crypto";
import { createReadStream, openSync, writeSync, type ReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../packages/collab-client/upstream/src/tool-render/util.ts";
import {
  boundedVendorText, readCloudCredentials, runOp, listProcesses, listeningAddresses, requireLoopbackListeners,
  type CloudDevice, type TestRecord, type OpRunner, type CloudArtifact, type CloudRecordRemoval,
} from "./device-cloud-common.ts";
import { readProvider } from "./provider-read.ts";
import { BROWSERSTACK_SESSION_ID } from "./device-cloud-webdriver.ts";
import { parseRetainedVendorJson } from "./device-cloud-record-json.ts";
import pins from "./browserstack-pins.json";

export const BROWSERSTACK_LOCAL = pins.local;
export const BROWSERSTACK_LOCAL_BINARY = join(homedir(), ".cache", "omp-session-gateway", "browserstack", `BrowserStackLocal-${BROWSERSTACK_LOCAL.version}`);
export const BROWSERSTACK_MODELS = pins.models;
const API = "https://api.browserstack.com/automate";
const VERSION = /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/u;
const IDENTIFIER = /^omp-dc-bs-[0-9a-f]{8}$/u;
const LOG_SURFACES = ["logs", "networklogs", "consolelogs", "seleniumlogs", "appiumlogs", "telemetrylogs"] as const;
const ARTIFACT_FIELDS = ["browser_console_logs_url", "har_logs_url", "selenium_logs_url", "appium_logs_url", "selenium_telemetry_logs_url", "browser_profiling_url", "session_terminal_logs_url", "build_terminal_logs_url"] as const;
const RECORD_FIELDS = [
  "name", "duration", "os", "os_version", "browser_version", "browser", "device", "status", "hashed_id", "reason",
  "build_name", "project_name", "build_hashed_id", "test_priority", "logs", "browserstack_status", "created_at",
  "browser_url", "public_url", "video_url", "insights", ...ARTIFACT_FIELDS,
] as const;
/** Official API examples plus the exact authenticated account surfaces observed 2026-10-20. */
const ARTIFACT_ORIGINS: Record<string, true> = {
  "https://automate.browserstack.com": true,
  "https://api.browserstack.com": true,
  "https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com": true,
  "https://bs-selenium-logs-use.s3.us-east-1.amazonaws.com": true,
};

export interface BrowserStackCredentials { readonly username: string; readonly accessKey: string }
export async function readBrowserStackCredentials(tokenFile: string, op: OpRunner = runOp): Promise<BrowserStackCredentials> {
  const [username, accessKey] = await readCloudCredentials(tokenFile, "browserstack", op);
  return { username, accessKey };
}

export function browserStackEntitlement(now: number): void {
  if (!Number.isFinite(now) || now >= Date.parse(pins.entitlement.cutoff)) throw new Error("BrowserStack Mobile entitlement requires reviewed renewal after 2027-10-20 00:00 UTC");
}

export function browserStackModel(target: "ipad" | "android", device: CloudDevice): (typeof BROWSERSTACK_MODELS)[typeof target][number] | undefined {
  return BROWSERSTACK_MODELS[target].find(model => model.name === device.name &&
    model.platform === device.platform && VERSION.test(device.version) && Number(device.version.split(".")[0]) >= model.minimumOsMajor);
}

export function browserStackCapabilities(target: "ipad" | "android", device: CloudDevice, identifier: string): Record<string, unknown> {
  if (!browserStackModel(target, device) || !IDENTIFIER.test(identifier)) throw new Error("invalid BrowserStack target, model, OS or local identifier");
  return {
    browserName: target === "ipad" ? "safari" : "chrome",
    "bstack:options": {
      deviceName: device.name, osVersion: device.version, realMobile: true, local: true, localIdentifier: identifier,
      video: false, debug: false, consoleLogs: "disable", networkLogs: false, seleniumLogs: false, appiumLogs: false,
      maskCommands: "screenshot,setValues,getValues,setCookies,getCookies",
      sessionName: `omp-device-cloud-${target}`, buildName: identifier, idleTimeout: 120,
    },
  };
}

const MEDIA_URL = /(?:data:(?:image|video)\/|https?:[^\s"'<>]*(?:\/(?:screenshots?|video)(?:[/?]|$)|\.(?:png|jpe?g|webp|gif|avif|svg|bmp|ico|mp4|webm|mov|m4v)(?:[?#]|$)))/iu;
const ARTIFACT_KEY = /(?:log|profiling|terminal|artifact).*url|screenshot|video|visual|^screen$/iu;

/** Closed disabled markers; opaque screenshot payloads count too, not only familiar URLs. */
function retainedMedia(value: unknown, key = ""): boolean {
  if (/screenshot|video|visual|^screen$/iu.test(key) &&
    value !== undefined && value !== null && value !== false && value !== "" && !(Array.isArray(value) && value.length === 0)) return true;
  if (typeof value === "string") return MEDIA_URL.test(value);
  if (Array.isArray(value)) return value.some(item => retainedMedia(item));
  return isRecord(value) && Object.entries(value).some(([name, item]) => retainedMedia(item, name));
}

function retainedContent(raw: string, contentType: string | null): { text: string; media: boolean; json?: unknown } {
  // Plain text remains raw-only for reference discovery. JSON bodies reject duplicates.
  if (!/(?:\/|\+)json(?:;|$)/iu.test(contentType ?? "")) return { text: raw, media: MEDIA_URL.test(raw) ||
    /"(?:[^"]*(?:screenshot|video|visual)[^"]*|screen)"\s*:\s*(?!null\b|false\b|""|\[\s*\])\S/iu.test(raw) };
  const json = parseRetainedVendorJson(raw);
  const canonical = JSON.stringify(json);
  return { text: canonical === raw ? raw : `${raw}\n${canonical}`, media: retainedMedia(json), json };
}

export function validateBrowserStackArtifacts(sessionId: string, artifacts: readonly CloudArtifact[]): void {
  if (!BROWSERSTACK_SESSION_ID.test(sessionId) || artifacts.length > 64) throw new Error("invalid BrowserStack artifact inventory");
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || Object.keys(artifact).sort().join(",") !== "buildId,kind,url" ||
      typeof artifact.url !== "string" || artifact.url.length > 8192 || typeof artifact.buildId !== "string" ||
      !BROWSERSTACK_SESSION_ID.test(artifact.buildId) || (artifact.kind !== "text" && artifact.kind !== "media") || seen.has(artifact.url)) throw new Error("invalid BrowserStack artifact inventory");
    let parsed: URL;
    try { parsed = new URL(artifact.url); } catch { throw new Error("invalid BrowserStack artifact reference"); }
    if (!Object.hasOwn(ARTIFACT_ORIGINS, parsed.origin) || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" ||
      (!parsed.pathname.includes(sessionId) && !parsed.pathname.includes(artifact.buildId))) throw new Error("unreviewed BrowserStack artifact reference");
    seen.add(artifact.url);
  }
}

export class BrowserStackApi {
  readonly #authorization: string;
  readonly #removalStarted = new Set<string>();
  constructor(credentials: BrowserStackCredentials) {
    this.#authorization = `Basic ${btoa(`${credentials.username}:${credentials.accessKey}`)}`;
  }

  async #get(path: string): Promise<Response> {
    return readProvider(() => fetch(`${API}${path}`, {
      headers: { authorization: this.#authorization }, redirect: "error", signal: AbortSignal.timeout(30_000),
    }));
  }

  async plan(now = Date.now()): Promise<void> {
    browserStackEntitlement(now);
    const response = await this.#get("/plan.json");
    if (!response.ok) { await response.body?.cancel(); throw new Error(`BrowserStack plan read failed with HTTP ${response.status}`); }
    const plan = parseRetainedVendorJson(await boundedVendorText(response, "BrowserStack"));
    if (!isRecord(plan) || plan.automate_plan !== pins.entitlement.plan || plan.parallel_sessions_max_allowed !== pins.entitlement.parallelSessions ||
      plan.team_parallel_sessions_max_allowed !== pins.entitlement.parallelSessions) throw new Error("BrowserStack Automate Mobile entitlement no longer matches reviewed metadata");
  }

  /** Catalog eligibility, not free-device availability. Missing aliases are never generalized. */
  async devices(target: "ipad" | "android"): Promise<readonly CloudDevice[]> {
    const response = await this.#get("/browsers.json");
    if (!response.ok) { await response.body?.cancel(); throw new Error(`BrowserStack catalog read failed with HTTP ${response.status}`); }
    const listing = parseRetainedVendorJson(await boundedVendorText(response, "BrowserStack"));
    if (!Array.isArray(listing)) throw new Error("BrowserStack returned an invalid catalog");
    const devices: CloudDevice[] = [];
    for (const entry of listing) {
      if (!isRecord(entry)) throw new Error("BrowserStack returned an invalid catalog entry");
      if (entry.real_mobile !== true) continue;
      if (typeof entry.device !== "string" || typeof entry.os !== "string" || typeof entry.os_version !== "string" || !VERSION.test(entry.os_version)) throw new Error("BrowserStack returned an invalid real-device catalog entry");
      const device = { name: entry.device, platform: entry.os, version: entry.os_version };
      const model = browserStackModel(target, device);
      if (model !== undefined && entry.browser === model.browser) devices.push(device);
    }
    return devices;
  }

  async #session(sessionId: string): Promise<{ readonly record: Record<string, unknown>; readonly raw: string } | undefined> {
    if (!BROWSERSTACK_SESSION_ID.test(sessionId)) throw new Error("invalid BrowserStack session id");
    const response = await this.#get(`/sessions/${sessionId}.json`);
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`BrowserStack allocation read failed with HTTP ${response.status}`); }
    const raw = await boundedVendorText(response, "BrowserStack");
    const payload = parseRetainedVendorJson(raw);
    if (!isRecord(payload) || Object.keys(payload).join(",") !== "automation_session" || !isRecord(payload.automation_session) || payload.automation_session.hashed_id !== sessionId) throw new Error("BrowserStack returned an invalid allocation record");
    return { record: payload.automation_session, raw };
  }

  async allocation(sessionId: string): Promise<Record<string, unknown>> {
    const result = await this.#session(sessionId);
    if (result === undefined) throw new Error("BrowserStack allocation record is absent");
    return result.record;
  }

  async #artifact(url: string, sessionId: string, buildId: string): Promise<Response> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("invalid BrowserStack artifact reference"); }
    if (!Object.hasOwn(ARTIFACT_ORIGINS, parsed.origin) || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" ||
      (!parsed.pathname.includes(sessionId) && !parsed.pathname.includes(buildId))) throw new Error("unreviewed BrowserStack artifact reference");
    // Signed references carry their own authorization. Never forward account authorization here.
    return readProvider(() => fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(30_000) }));
  }

  async testRecord(sessionId: string, remember?: (artifacts: readonly CloudArtifact[]) => Promise<void>): Promise<TestRecord | undefined> {
    const session = await this.#session(sessionId);
    if (session === undefined) return undefined;
    const { record, raw } = session;
    if (record.status === "running") return { complete: false, text: "", video: false, screenshots: 0 };
    if (Object.keys(record).some(field => !(RECORD_FIELDS as readonly string[]).includes(field))) throw new Error("BrowserStack returned an unreviewed retained-record field");
    if (!["done", "failed", "timeout", "passed"].includes(String(record.status)) || typeof record.build_hashed_id !== "string" || !BROWSERSTACK_SESSION_ID.test(record.build_hashed_id)) throw new Error("BrowserStack record has unknown finalization state");
    const texts = [raw, JSON.stringify(record)];
    const artifacts: CloudArtifact[] = [];
    const inventory = async (json: unknown, key = ""): Promise<void> => {
      if (typeof json === "string") {
        let url: URL;
        try { url = new URL(json); } catch { return; }
        if (url.protocol !== "https:" && url.protocol !== "http:") return;
        if (ARTIFACT_KEY.test(key)) validateBrowserStackArtifacts(sessionId, [{ url: json, buildId: record.build_hashed_id as string, kind: "text" }]);
        if (Object.hasOwn(ARTIFACT_ORIGINS, url.origin) && (url.pathname.includes(sessionId) || url.pathname.includes(record.build_hashed_id as string))) {
          const kind = /screenshot|video|visual|^screen$/iu.test(key) || MEDIA_URL.test(json) ? "media" : "text";
          if (!artifacts.some(artifact => artifact.url === json)) {
            artifacts.push({ url: json, buildId: record.build_hashed_id as string, kind });
            validateBrowserStackArtifacts(sessionId, artifacts);
            await remember?.([...artifacts]);
          }
        }
      } else if (Array.isArray(json)) {
        for (const item of json) await inventory(item, key);
      } else if (isRecord(json)) {
        for (const [name, item] of Object.entries(json)) await inventory(item, name);
      }
    };
    for (const field of [...ARTIFACT_FIELDS, "video_url"]) {
      const url = record[field];
      if (url === undefined || url === null || url === "") continue;
      if (typeof url !== "string") throw new Error("BrowserStack returned an invalid artifact reference");
      validateBrowserStackArtifacts(sessionId, [{ url, buildId: record.build_hashed_id, kind: field === "video_url" ? "media" : "text" }]);
      await inventory(url, field);
    }
    if (typeof record.video_url !== "string" || record.video_url === "") throw new Error("BrowserStack returned no video retention indicator");
    let screenshots = Object.entries(record).some(([key, value]) => key !== "video_url" && retainedMedia(value, key)) ? 1 : 0;
    let bytes = Buffer.byteLength(raw) + Buffer.byteLength(texts[1]!);
    if (bytes > 2_000_000) throw new Error("BrowserStack returned oversized aggregate records");
    const append = async (raw: string, contentType: string | null = null) => {
      const content = retainedContent(raw, contentType);
      bytes += Buffer.byteLength(content.text);
      if (bytes > 2_000_000) throw new Error("BrowserStack returned oversized aggregate records");
      texts.push(content.text);
      if (content.media) screenshots = 1;
      if (content.json !== undefined) await inventory(content.json);
    };
    let video = false;
    for (const surface of LOG_SURFACES) {
      const response = await this.#get(`/sessions/${sessionId}/${surface}`);
      if (response.status === 404 && surface !== "logs") { await append(await boundedVendorText(response, "BrowserStack"), response.headers.get("content-type")); continue; }
      if (response.status !== 200) { await response.body?.cancel(); throw new Error("BrowserStack required retained log is unavailable"); }
      const contentType = response.headers.get("content-type") ?? "";
      if (response.status === 200 && /^(?:image|video)\//iu.test(contentType)) { video = true; await response.body?.cancel(); continue; }
      if (!contentType.startsWith("text/plain") && !/(?:\/|\+)json(?:;|$)/iu.test(contentType)) { await response.body?.cancel(); throw new Error("BrowserStack returned an unexpected log format"); }
      await append(await boundedVendorText(response, "BrowserStack"), contentType);
    }
    for (const artifact of artifacts) {
      const response = await this.#artifact(artifact.url, sessionId, artifact.buildId);
      if (response.status === 404) { await append(await boundedVendorText(response, "BrowserStack"), response.headers.get("content-type")); continue; }
      if (artifact.kind === "media") {
        if (response.status === 200) { video = true; await response.body?.cancel(); continue; }
        const denial = await boundedVendorText(response, "BrowserStack");
        if (response.status !== 403 || !denial.includes("<Code>AccessDenied</Code>") || !denial.includes("s3:ListBucket")) throw new Error("BrowserStack video retention state is unknown");
        await append(denial);
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (response.status === 200 && /^(?:image|video)\//iu.test(contentType)) { video = true; await response.body?.cancel(); continue; }
      if (response.status !== 200 || (!contentType.startsWith("text/plain") && !/(?:\/|\+)json(?:;|$)/iu.test(contentType))) { await response.body?.cancel(); throw new Error("BrowserStack retained artifact state is unknown"); }
      const text = await boundedVendorText(response, "BrowserStack");
      await append(text, contentType);
    }
    const text = texts.join("\n");
    return { complete: true, text, video, screenshots };
  }

  /** DELETE is never retried; only subsequent absence reads are bounded/retried. */
  async deleteRecord(sessionId: string, removal: CloudRecordRemoval, clock: { now(): number; pause(milliseconds: number): Promise<void> } = { now: Date.now, pause: Bun.sleep }): Promise<void> {
    validateBrowserStackArtifacts(sessionId, removal.artifacts);
    const artifacts = [...removal.artifacts];
    const existing = await this.#get(`/sessions/${sessionId}.json`);
    await existing.body?.cancel();
    if (existing.status !== 200 && existing.status !== 404) throw new Error("BrowserStack record cleanup state is unknown");
    if (existing.status === 200 && !this.#removalStarted.has(sessionId)) {
      this.#removalStarted.add(sessionId);
      const response = await fetch(`${API}/sessions/${sessionId}.json`, { method: "DELETE", headers: { authorization: this.#authorization }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (response.status !== 200) { await response.body?.cancel(); throw new Error(`BrowserStack record deletion failed with HTTP ${response.status}`); }
      const result = parseRetainedVendorJson(await boundedVendorText(response, "BrowserStack"));
      if (!isRecord(result) || result.status !== "ok") throw new Error("BrowserStack record deletion was not acknowledged");
    }
    // Confidentiality still requires DELETE when a crash lost the inventory. Never claim
    // restoration afterward: without the references their signed objects cannot be verified.
    if (artifacts.length === 0) throw new Error("BrowserStack retained artifact inventory is unavailable");
    const deadline = clock.now() + 180_000;
    for (;;) {
      let absent = true;
      for (const suffix of [".json", ...LOG_SURFACES.map(surface => `/${surface}`)]) {
        const check = await this.#get(`/sessions/${sessionId}${suffix}`);
        await check.body?.cancel();
        if (check.status !== 404) absent = false;
      }
      if (absent) break;
      if (clock.now() >= deadline) throw new Error("BrowserStack record deletion could not be verified");
      await clock.pause(2_000);
    }
    for (const artifact of artifacts) {
      for (;;) {
        const check = await this.#artifact(artifact.url, sessionId, artifact.buildId);
        if (check.status === 404) { await check.body?.cancel(); break; }
        if (artifact.kind === "media" && check.status === 403) {
          const denial = await boundedVendorText(check, "BrowserStack");
          if (denial.includes("<Code>AccessDenied</Code>") && denial.includes("s3:ListBucket")) break;
          throw new Error("BrowserStack retained media absence is unknown");
        }
        const contentType = check.headers.get("content-type") ?? "";
        if (check.status !== 200) { await check.body?.cancel(); throw new Error("BrowserStack retained signed artifact state is unknown"); }
        if (artifact.kind === "media" || /^(?:image|video)\//iu.test(contentType)) {
          await check.body?.cancel();
          await removal.inspect({ complete: true, text: "", video: true, screenshots: 0 });
        } else {
          if (!contentType.startsWith("text/plain") && !/(?:\/|\+)json(?:;|$)/iu.test(contentType)) { await check.body?.cancel(); throw new Error("BrowserStack retained signed artifact format is unknown"); }
          const content = retainedContent(await boundedVendorText(check, "BrowserStack"), contentType);
          await removal.inspect({ complete: true, text: content.text, video: false, screenshots: content.media ? 1 : 0 });
          const discover = (value: unknown, key = ""): void => {
            if (typeof value === "string") {
              let url: URL;
              try { url = new URL(value); } catch { return; }
              if (url.protocol !== "https:" && url.protocol !== "http:") return;
              if (ARTIFACT_KEY.test(key)) validateBrowserStackArtifacts(sessionId, [{ url: value, buildId: artifact.buildId, kind: "text" }]);
              if (Object.hasOwn(ARTIFACT_ORIGINS, url.origin) && (url.pathname.includes(sessionId) || url.pathname.includes(artifact.buildId)) && !artifacts.some(item => item.url === value)) {
                artifacts.push({ url: value, buildId: artifact.buildId, kind: /screenshot|video|visual|^screen$/iu.test(key) || MEDIA_URL.test(value) ? "media" : "text" });
              }
            } else if (Array.isArray(value)) { for (const item of value) discover(item, key); }
            else if (isRecord(value)) { for (const [name, item] of Object.entries(value)) discover(item, name); }
          };
          if (content.json !== undefined) {
            discover(content.json);
            validateBrowserStackArtifacts(sessionId, artifacts);
            await removal.remember([...artifacts]);
          }
        }
        if (clock.now() >= deadline) throw new Error("BrowserStack retained signed artifact absence could not be verified");
        await clock.pause(2_000);
      }
    }
  }
}

export function requireBrowserStackRosetta(): void {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("BrowserStack Local requires the single-user macOS orchestrator");
  if (Bun.spawnSync(["/usr/bin/arch", "-x86_64", "/usr/bin/true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode !== 0) throw new Error("BrowserStack Local needs Rosetta 2 on Apple Silicon");
}

export interface BrowserStackLocalIdentity {
  readonly binary: string;
  readonly directory: string;
  readonly identifier: string;
}
export interface BrowserStackLocalOptions extends BrowserStackLocalIdentity {
  readonly localProxyPort: number;
  readonly hosts: readonly string[];
}

export function browserStackLocalArguments(options: BrowserStackLocalOptions): string[] {
  if (!IDENTIFIER.test(options.identifier) || !Number.isInteger(options.localProxyPort) || options.localProxyPort < 1 || options.localProxyPort > 65535 ||
    options.hosts.length === 0 || options.hosts.some(host => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host))) throw new Error("invalid BrowserStack Local containment configuration");
  return [options.binary, "--config-file", join(options.directory, "local.yml"), "--disable-dashboard", "--only-automate",
    "--log-file", join(options.directory, "startup.pipe"), "--disable-proxy-discovery", "--force-local", "--force-proxy",
    "--local-proxy-host", "127.0.0.1", "--local-proxy-port", String(options.localProxyPort), "--local-identifier", options.identifier,
    "--include-hosts", ...options.hosts];
}

async function ownedLocalProcesses(options: BrowserStackLocalIdentity): Promise<number[]> {
  // Local rewrites process titles and can respawn a child during shutdown. The attempt's
  // unique private cwd plus exact executable identify even a child whose argv was rewritten.
  const identity = await canonicalBrowserStackLocalIdentity(options);
  const candidates = (await listProcesses()).filter(entry => entry.command.includes("BrowserStackLocal"));
  const owned: number[] = [];
  for (const candidate of candidates) {
    const child = Bun.spawn(["lsof", "-a", "-p", String(candidate.pid), "-d", "cwd,txt", "-F", "n"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [text, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (status !== 0 && status !== 1) throw new Error("could not verify BrowserStack Local process ownership");
    const files = text.split("\n");
    if (files.includes(`n${identity.binary}`) && files.includes(`n${identity.directory}`)) owned.push(candidate.pid);
  }
  return owned;
}

export async function canonicalBrowserStackLocalIdentity(options: BrowserStackLocalIdentity): Promise<BrowserStackLocalIdentity> {
  try {
    const [binary, directory] = await Promise.all([realpath(options.binary), realpath(options.directory)]);
    return { ...options, binary, directory };
  } catch { throw new Error("could not resolve BrowserStack Local process ownership"); }
}

interface LocalStopRuntime {
  processes(options: BrowserStackLocalIdentity): Promise<readonly number[]>;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  now(): number;
  pause(milliseconds: number): Promise<void>;
}

/** Also used by crash cleanup. Never kill another Local/Percy process by executable name alone. */
export async function stopBrowserStackLocal(options: BrowserStackLocalIdentity, runtime: LocalStopRuntime = {
  processes: ownedLocalProcesses,
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => { process.kill(pid, signal); },
  now: Date.now,
  pause: Bun.sleep,
}): Promise<void> {
  if (!IDENTIFIER.test(options.identifier)) throw new Error("invalid BrowserStack Local identifier");
  try {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const deadline = runtime.now() + 10_000;
      const signalled = new Set<number>();
      let quietSince: number | undefined;
      while (runtime.now() < deadline) {
        const pids = await runtime.processes(options);
        if (pids.length === 0) {
          quietSince ??= runtime.now();
          if (runtime.now() - quietSince >= 1_000) return;
        } else {
          quietSince = undefined;
          for (const pid of pids) {
            if (signalled.has(pid)) continue;
            signalled.add(pid);
            try { runtime.kill(pid, signal); } catch { /* already exited */ }
          }
        }
        await runtime.pause(200);
      }
    }
    throw new Error("BrowserStack Local outlived SIGKILL");
  } finally {
    await rm(join(options.directory, "local.yml"), { force: true });
    await rm(join(options.directory, "startup.pipe"), { force: true });
  }
}

/** Private config; vendor-child argv exposure is the explicit single-user-workstation exception. */
export async function startBrowserStackLocal(options: BrowserStackLocalOptions, credentials: BrowserStackCredentials, timeoutMs = 120_000): Promise<void> {
  const argv = browserStackLocalArguments(options);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const directory = await lstat(options.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) throw new Error("BrowserStack Local requires an owned 0700 directory");
  const config = join(options.directory, "local.yml");
  const fifo = join(options.directory, "startup.pipe");
  await writeFile(config, `key: ${JSON.stringify(credentials.accessKey)}\n`, { mode: 0o600, flag: "wx" });
  let stream: ReadStream | undefined;
  let pipeDescriptor: number | undefined;
  const closePipe = () => {
    if (pipeDescriptor !== undefined) { try { writeSync(pipeDescriptor, "\n"); } catch { /* already closed */ } }
    stream?.destroy();
    pipeDescriptor = undefined;
  };
  try {
    const maker = Bun.spawn(["mkfifo", "-m", "600", fifo], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    if (await maker.exited !== 0) throw new Error("could not create BrowserStack Local readiness pipe");
    let ready = false;
    let streamFailed = false;
    let pending = "";
    // RDWR makes opening nonblocking even when the vendor fails before opening its writer.
    pipeDescriptor = openSync(fifo, "r+");
    stream = createReadStream(fifo, { fd: pipeDescriptor, autoClose: true });
    stream.on("error", () => { streamFailed = true; });
    stream.on("data", (chunk: Buffer) => {
      // No Local log file exists. Retain only enough volatile bytes to recognize the fixed marker.
      if (!ready) { pending = (pending + chunk.toString("utf8")).slice(-512); ready = pending.includes("You can now access your local server(s) in our remote browser"); }
      if (ready) pending = "";
    });
    const child = Bun.spawn(argv, { cwd: options.directory,
      env: { HOME: options.directory, TMP: options.directory, TMPDIR: options.directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    void child.exited.then(closePipe);
    const deadline = Date.now() + timeoutMs;
    while (!ready) {
      if (streamFailed || child.exitCode !== null || Date.now() >= deadline) throw new Error("BrowserStack Local did not become ready");
      await Bun.sleep(200);
    }
    const pids = await ownedLocalProcesses(options);
    if (pids.length === 0) throw new Error("BrowserStack Local process ownership is unverified");
    for (const pid of pids) {
      requireLoopbackListeners(await listeningAddresses(pid), "browserstack");
    }
  } catch (error) {
    try {
      await stopBrowserStackLocal(options).catch(() => { throw new AggregateError([error, new Error("BrowserStack Local cleanup failed")], "BrowserStack Local start and cleanup failed"); });
    } finally { closePipe(); }
    throw error;
  }
}

export async function ensureBrowserStackLocal(directory = join(homedir(), ".cache", "omp-session-gateway", "browserstack")): Promise<string> {
  requireBrowserStackRosetta();
  const binary = join(directory, `BrowserStackLocal-${BROWSERSTACK_LOCAL.version}`);
  const existing = await readFile(binary).catch(() => undefined);
  if (existing?.byteLength === BROWSERSTACK_LOCAL.bytes && createHash("sha256").update(existing).digest("hex") === BROWSERSTACK_LOCAL.sha256) return binary;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const response = await readProvider(() => fetch(BROWSERSTACK_LOCAL.url, { redirect: "error", signal: AbortSignal.timeout(120_000) }));
  if (!response.ok) { await response.body?.cancel(); throw new Error(`BrowserStack Local download failed with HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("BrowserStack Local download has no body");
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      count += part.value.byteLength;
      if (count > BROWSERSTACK_LOCAL.archiveBytes) { await reader.cancel(); throw new Error("BrowserStack Local download exceeds pinned bytes"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const archive = Buffer.concat(chunks);
  if (count !== BROWSERSTACK_LOCAL.archiveBytes || createHash("sha256").update(archive).digest("hex") !== BROWSERSTACK_LOCAL.archiveSha256) throw new Error("BrowserStack Local archive differs from its pinned digest");
  const zip = join(directory, "local.zip");
  const temporary = `${binary}.new`;
  try {
    await writeFile(zip, archive, { mode: 0o600 });
    const unzip = Bun.spawn(["unzip", "-p", zip, "BrowserStackLocal"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [bytes, status] = await Promise.all([new Response(unzip.stdout).arrayBuffer(), unzip.exited]);
    if (status !== 0 || bytes.byteLength !== BROWSERSTACK_LOCAL.bytes || createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== BROWSERSTACK_LOCAL.sha256) throw new Error("BrowserStack Local binary differs from its pinned digest");
    await writeFile(temporary, new Uint8Array(bytes), { mode: 0o700 });
    await chmod(temporary, 0o700);
    await rename(temporary, binary);
  } finally { await rm(zip, { force: true }); await rm(temporary, { force: true }); }
  return binary;
}
