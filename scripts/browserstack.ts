/** BrowserStack Automate Mobile: fixed catalog aliases, private Local, complete record audit/removal. */
import { createHash } from "node:crypto";
import { createReadStream, openSync, writeSync, type ReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isRecord } from "../packages/collab-client/upstream/src/tool-render/util.ts";
import {
  boundedVendorBytes, boundedVendorText, readCloudCredentials, runOp, listeningAddresses, requireLoopbackListeners,
  type CloudDevice, type TestRecord, type OpRunner, type CloudArtifact, type CloudRecordRemoval,
} from "./device-cloud-common.ts";
import { readProvider } from "./provider-read.ts";
import { BROWSERSTACK_SESSION_ID } from "./device-cloud-webdriver.ts";
import { parseRetainedVendorJson, RetainedVendorJsonError } from "./device-cloud-record-json.ts";
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
const ARTIFACT_ORIGINS = new Set(pins.artifactOrigins);
const DASHBOARD_ORIGINS = new Set(pins.dashboardOrigins);
const DOCUMENTATION_ORIGINS = new Set(pins.documentationOrigins);
const REFERENCE_HOSTNAMES = [...new Set([...ARTIFACT_ORIGINS, ...DASHBOARD_ORIGINS].map(origin => new URL(origin).hostname))];
const DOCUMENTATION_HOSTNAMES = [...DOCUMENTATION_ORIGINS].map(origin => new URL(origin).hostname);
const INSIGHT_COMPONENTS = new Set(["browserstack_time", "user_time", "capabilities_impact"]);
const PRESENTATION_FIELDS = new Set(["browser_url", "public_url", "logs", "video_url"]);
const FINAL_RECORD_STATES = new Set(["done", "failed", "timeout", "passed"]);
const ARTIFACT_SIGNATURE_KEYS = new Set([
  "X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders", "X-Amz-Signature",
]);

export class BrowserStackAuditFailure extends Error {}

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
const BASE64_IMAGE = /(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)[A-Za-z0-9+/=]{64,}/u;
const TEXT_MEDIA_FIELD = /(?:^|[^\w"'])(?:"(?:[^"]*(?:screenshot|video|visual)[^"]*|screen)"|'(?:[^']*(?:screenshot|video|visual)[^']*|screen)'|[\w.-]*(?:screenshot|video|visual)[\w.-]*|screen)\s*[:=]\s*(?:["']?(?:https?:|data:|iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)|\{(?!\s*\})|\[(?!\s*\]))/iu;
const BMP_HEADERS = new Set([12, 40, 52, 56, 64, 108, 124]);

function bytesAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function binaryMedia(bytes: Uint8Array): boolean {
  if (bytesAt(bytes, 0, "\x89PNG\r\n\x1a\n") || bytesAt(bytes, 0, "\xff\xd8\xff") ||
    bytesAt(bytes, 0, "GIF87a") || bytesAt(bytes, 0, "GIF89a") ||
    (bytesAt(bytes, 0, "RIFF") && bytesAt(bytes, 8, "WEBP")) || bytesAt(bytes, 4, "ftyp") ||
    bytesAt(bytes, 0, "\x1a\x45\xdf\xa3")) return true;
  if (!bytesAt(bytes, 0, "BM") || bytes.length < 26) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = view.getUint32(14, true), dataOffset = view.getUint32(10, true);
  if (!BMP_HEADERS.has(header) || view.getUint32(6, true) !== 0 ||
    dataOffset < 14 + header || view.getUint32(2, true) < dataOffset) return false;
  return header === 12
    ? view.getUint16(18, true) > 0 && view.getUint16(20, true) > 0 && view.getUint16(22, true) === 1
    : bytes.length >= 28 && view.getInt32(18, true) > 0 && view.getInt32(22, true) !== 0 && view.getUint16(26, true) === 1;
}

/** Closed disabled markers; opaque screenshot payloads count too, not only familiar URLs. */
function retainedMedia(value: unknown, key = ""): boolean {
  if (/screenshot|video|visual|^screen$/iu.test(key) &&
    value !== undefined && value !== null && value !== false && value !== "" && !(Array.isArray(value) && value.length === 0)) return true;
  if (typeof value === "string") {
    if (key === "optimize_url") {
      let url: URL | undefined;
      try { url = new URL(value); } catch { url = undefined; }
      if (url !== undefined && DOCUMENTATION_ORIGINS.has(url.origin) && documentationPresentation(value, url)) return false;
    }
    return MEDIA_URL.test(value);
  }
  if (Array.isArray(value)) return value.some(item => retainedMedia(item));
  return isRecord(value) && Object.entries(value).some(([name, item]) => retainedMedia(name) || retainedMedia(item, name));
}

function retainedContent(raw: string, contentType: string | null): { text: string; media: boolean; json?: unknown } {
  // Plain text remains raw-only for reference discovery. JSON bodies reject duplicates.
  if (!/(?:\/|\+)json(?:;|$)/iu.test(contentType ?? "")) return { text: raw, media: MEDIA_URL.test(raw) || BASE64_IMAGE.test(raw) || TEXT_MEDIA_FIELD.test(raw) };
  const json = parseRetainedVendorJson(raw);
  const canonical = JSON.stringify(json);
  return { text: canonical === raw ? raw : `${raw}\n${canonical}`, media: BASE64_IMAGE.test(raw) || retainedMedia(json), json };
}

async function readRetainedBody(response: Response): Promise<{ readonly text: string; readonly media: boolean }> {
  try {
    const bytes = await boundedVendorBytes(response, "BrowserStack");
    const media = binaryMedia(bytes);
    return { text: new TextDecoder("utf-8", { fatal: !media }).decode(bytes), media };
  }
  catch { throw new BrowserStackAuditFailure("BrowserStack retained body could not be read within its audit bound"); }
}

/** A validated storage object's rotating authorization query is not its identity. */
export function browserStackArtifactIdentity(artifact: CloudArtifact): string {
  const url = new URL(artifact.url);
  return `${url.origin}${url.pathname}`;
}

function reviewedArtifactQuery(url: URL): boolean {
  if (!url.href.includes("?")) return true;
  const keys = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if ((!ARTIFACT_SIGNATURE_KEYS.has(key) && key !== "response-content-type") || keys.has(key)) return false;
    keys.add(key);
  }
  return keys.size === ARTIFACT_SIGNATURE_KEYS.size + Number(keys.has("response-content-type"));
}

export function validateBrowserStackArtifacts(sessionId: string, artifacts: readonly CloudArtifact[]): void {
  if (!BROWSERSTACK_SESSION_ID.test(sessionId) || artifacts.length > 64) throw new BrowserStackAuditFailure("invalid BrowserStack artifact inventory");
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || Object.keys(artifact).sort().join(",") !== "buildId,kind,url" ||
      typeof artifact.url !== "string" || artifact.url.length > 8192 || typeof artifact.buildId !== "string" ||
      !BROWSERSTACK_SESSION_ID.test(artifact.buildId) || (artifact.kind !== "text" && artifact.kind !== "media")) throw new BrowserStackAuditFailure("invalid BrowserStack artifact inventory");
    const parsed = referenceUrl(artifact.url);
    if (parsed === undefined) throw new BrowserStackAuditFailure("invalid BrowserStack artifact reference");
    if (!ARTIFACT_ORIGINS.has(parsed.origin) || !reviewedArtifactQuery(parsed) || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" ||
      (!parsed.pathname.includes(sessionId) && !parsed.pathname.includes(artifact.buildId))) throw new BrowserStackAuditFailure("unreviewed BrowserStack artifact reference");
    const identity = `${parsed.origin}${parsed.pathname}`;
    if (seen.has(identity)) throw new BrowserStackAuditFailure("invalid BrowserStack artifact inventory");
    seen.add(identity);
  }
}

function occurrences(text: string, fragment: string): number {
  let count = 0;
  for (let index = text.indexOf(fragment); index !== -1; index = text.indexOf(fragment, index + fragment.length)) count += 1;
  return count;
}

function referenceLike(value: string): boolean {
  const lower = value.toLowerCase();
  return value.includes("://") || REFERENCE_HOSTNAMES.some(hostname => lower.includes(hostname)) ||
    DOCUMENTATION_HOSTNAMES.some(hostname => lower.includes(hostname));
}

/** Decode bytes, not URLs; malformed escapes stay literal and excessive nesting fails closed. */
function percentDecoded(value: string): string {
  for (let pass = 0; pass < 4; pass += 1) {
    const decoded = value.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded === value) return value;
    value = decoded;
  }
  if (/%[0-9a-f]{2}/iu.test(value)) throw new BrowserStackAuditFailure("unaccounted BrowserStack artifact reference");
  return value;
}

/** Non-JSON error text cannot declare references, so every pinned-host census must be zero. */
function rawErrorCensus(raw: string): void {
  const text = raw.toLowerCase(), decoded = percentDecoded(text).toLowerCase();
  if (REFERENCE_HOSTNAMES.some(hostname => text.includes(hostname) || decoded.includes(hostname))) throw new BrowserStackAuditFailure("unaccounted BrowserStack artifact reference");
}

function dashboardPresentation(value: string, url: URL, field: string, sessionId: string, buildId: string): boolean {
  const parts = /^https?:\/\/([^/?#]+)(\/[^?#]*)(?:\?([^#]*))?$/iu.exec(value);
  if (parts === null || parts[1]!.toLowerCase() !== url.hostname || value.includes("%") ||
    url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== "") return false;
  const sessionPath = `/builds/${buildId}/sessions/${sessionId}`;
  if (field === "browser_url" || field === "logs") return parts[2] === `${sessionPath}${field === "logs" ? "/logs" : ""}` && parts[3] === undefined;
  if (field === "public_url") return parts[2] === sessionPath && /^auth_token=[A-Za-z0-9_-]{16,128}$/u.test(parts[3] ?? "");
  if (field !== "video_url" || parts[2] !== `/sessions/${sessionId}/video` || !/^[^&]+(?:&[^&]+){2}$/u.test(parts[3] ?? "")) return false;
  const query = url.searchParams;
  return query.size === 3 &&
    /^[A-Za-z0-9_-]{16,512}$/u.test(query.get("token") ?? "") && /^[A-Za-z0-9_-]{1,32}$/u.test(query.get("source") ?? "") &&
    /^[0-9]{1,10}(?:\.[0-9]{1,12})?$/u.test(query.get("diff") ?? "");
}

function documentationPresentation(value: string, url: URL): boolean {
  const parts = /^https?:\/\/([^/?#]+)(\/[^?#]*)(?:#([^?#]*))?$/iu.exec(value);
  return parts !== null && parts[1]!.toLowerCase() === url.hostname && url.username === "" && url.password === "" && url.port === "" &&
    /^\/docs\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(parts[2]!) &&
    (parts[3] === undefined || /^[A-Za-z0-9_-]+$/u.test(parts[3]));
}

/** No token extraction, delimiter repair or inferred references. */
function referenceUrl(value: string): URL | undefined {
  if (!referenceLike(value)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserStackAuditFailure("unaccounted BrowserStack artifact reference"); }
  if (!/^https?:\/\/[^/?#]/iu.test(value) || /[,\s"'<>\\]/u.test(value) ||
    occurrences(value, "://") !== 1 || occurrences(percentDecoded(value), "://") !== 1 ||
    occurrences(value.toLowerCase(), url.hostname) !== 1) throw new BrowserStackAuditFailure("unaccounted BrowserStack artifact reference");
  return url;
}

/** Every pinned-host occurrence in raw, canonical and decoded text belongs to an accepted value. */
export function browserStackReferences(sessionId: string, buildId: string | undefined, value: unknown, sessionMetadata = false, raw = JSON.stringify(value) ?? ""): {
  artifacts: CloudArtifact[]; dashboardReferences: number;
} {
  const enforceVideoPresentation = sessionMetadata && (!isRecord(value) || value.status !== "running");
  if (enforceVideoPresentation && isRecord(value) && FINAL_RECORD_STATES.has(String(value.status)) && !Object.hasOwn(value, "video_url")) throw new BrowserStackAuditFailure("BrowserStack returned an unreviewed video presentation");
  const artifacts: CloudArtifact[] = [];
  const dashboards = new Set<string>();
  const accepted = new Map(REFERENCE_HOSTNAMES.map(hostname => [hostname, 0]));
  const path: string[] = [];
  const walk = (value: unknown, key = "", depth = 0): void => {
    const videoPresentation = enforceVideoPresentation && depth === 1 && key === "video_url";
    if (videoPresentation && typeof value !== "string") throw new BrowserStackAuditFailure("BrowserStack returned an unreviewed video presentation");
    if (typeof value === "string") {
      const url = referenceUrl(value);
      if (url === undefined) {
        if (videoPresentation) throw new BrowserStackAuditFailure("BrowserStack returned an unreviewed video presentation");
        return;
      }
      if (DOCUMENTATION_ORIGINS.has(url.origin)) {
        if (!sessionMetadata || path.length !== 5 || path[0] !== "insights" || path[1] !== "summary" || path[2] !== "time_breakdown" ||
          !INSIGHT_COMPONENTS.has(path[3]!) || path[4] !== "optimize_url" || !documentationPresentation(value, url)) throw new BrowserStackAuditFailure("unreviewed BrowserStack documentation reference");
        return;
      }
      const presentation = DASHBOARD_ORIGINS.has(url.origin) && sessionMetadata && depth === 1 && PRESENTATION_FIELDS.has(key);
      if (presentation && buildId === undefined) throw new BrowserStackAuditFailure("unbound retained reference");
      const dashboard = presentation && buildId !== undefined && dashboardPresentation(value, url, key, sessionId, buildId);
      if (videoPresentation && !dashboard) throw new BrowserStackAuditFailure("BrowserStack returned an unreviewed video presentation");
      if (!dashboard && !ARTIFACT_ORIGINS.has(url.origin)) throw new BrowserStackAuditFailure("unreviewed BrowserStack artifact reference");
      if (buildId === undefined) throw new BrowserStackAuditFailure("unbound retained reference");
      accepted.set(url.hostname, (accepted.get(url.hostname) ?? 0) + 1);
      if (dashboard) { dashboards.add(value); return; }
      const artifact: CloudArtifact = { url: value, buildId, kind: /screenshot|video|visual|^screen$/iu.test(key) || MEDIA_URL.test(value) ? "media" : "text" };
      validateBrowserStackArtifacts(sessionId, [artifact]);
      const identity = browserStackArtifactIdentity(artifact);
      const index = artifacts.findIndex(item => browserStackArtifactIdentity(item) === identity);
      if (index === -1) artifacts.push(artifact);
      else if (artifacts[index]!.kind !== artifact.kind) throw new BrowserStackAuditFailure("BrowserStack artifact classification changed");
      else artifacts[index] = artifact;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        path.push("[]");
        walk(item, key, depth + 1);
        path.pop();
      }
    } else if (isRecord(value)) {
      for (const [name, item] of Object.entries(value)) {
        if (/data:/iu.test(name) || retainedMedia(name)) throw new BrowserStackAuditFailure("BrowserStack retained media key");
        if (referenceLike(name)) throw new BrowserStackAuditFailure("unaccounted BrowserStack artifact reference");
        path.push(name);
        walk(item, name, depth + 1);
        path.pop();
      }
    }
  };
  walk(value);
  const canonical = (JSON.stringify(value) ?? "").toLowerCase(), original = raw.toLowerCase(), decoded = percentDecoded(canonical).toLowerCase();
  for (const [hostname, count] of accepted) {
    if (occurrences(original, hostname) !== count || occurrences(canonical, hostname) !== count ||
      occurrences(decoded, hostname) !== count) throw new BrowserStackAuditFailure("unaccounted BrowserStack artifact reference");
  }
  validateBrowserStackArtifacts(sessionId, artifacts);
  return { artifacts, dashboardReferences: dashboards.size };
}

export function mergeBrowserStackArtifacts(sessionId: string, artifacts: CloudArtifact[], added: readonly CloudArtifact[]): void {
  validateBrowserStackArtifacts(sessionId, artifacts);
  if (added.length > 64) throw new BrowserStackAuditFailure("invalid BrowserStack artifact inventory");
  const identities = new Map<string, number>();
  for (let index = 0; index < artifacts.length; index += 1) identities.set(browserStackArtifactIdentity(artifacts[index]!), index);
  for (const artifact of added) {
    validateBrowserStackArtifacts(sessionId, [artifact]);
    const identity = browserStackArtifactIdentity(artifact);
    const index = identities.get(identity);
    if (index === undefined) {
      if (artifacts.length >= 64) throw new BrowserStackAuditFailure("invalid BrowserStack artifact inventory");
      identities.set(identity, artifacts.length);
      artifacts.push(artifact);
    } else {
      const previous = artifacts[index]!;
      if (previous.kind !== artifact.kind || previous.buildId !== artifact.buildId) throw new BrowserStackAuditFailure("BrowserStack artifact identity changed");
      artifacts[index] = artifact;
    }
  }
}

function sessionRecord(payload: unknown, sessionId: string): Record<string, unknown> {
  if (!isRecord(payload) || Object.keys(payload).join(",") !== "automation_session" || !isRecord(payload.automation_session) || payload.automation_session.hashed_id !== sessionId) throw new BrowserStackAuditFailure("BrowserStack returned an invalid allocation record");
  return payload.automation_session;
}

function sessionPayload(raw: string, sessionId: string): Record<string, unknown> {
  return sessionRecord(parseRetainedVendorJson(raw), sessionId);
}

/** Recovery only: strict-parsed whole values, individually validated under the existing bound. */
function recoverableArtifacts(sessionId: string, buildId: string | undefined, value: unknown, known: readonly CloudArtifact[]): CloudArtifact[] {
  const artifacts = [...known];
  if (buildId === undefined) return artifacts;
  const identity = buildId;
  const walk = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (!referenceLike(value)) return;
      const artifact: CloudArtifact = { url: value, buildId: identity, kind: /screenshot|video|visual|^screen$/iu.test(key) || MEDIA_URL.test(value) ? "media" : "text" };
      try { validateBrowserStackArtifacts(sessionId, [artifact]); }
      catch (error) { if (error instanceof BrowserStackAuditFailure) return; throw error; }
      const objectIdentity = browserStackArtifactIdentity(artifact);
      const index = artifacts.findIndex(known => browserStackArtifactIdentity(known) === objectIdentity);
      if (index === -1) {
        if (artifacts.length < 64) artifacts.push(artifact);
      } else if (artifacts[index]!.kind === artifact.kind && artifacts[index]!.buildId === artifact.buildId) artifacts[index] = artifact;
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
    } else if (isRecord(value)) {
      for (const [name, item] of Object.entries(value)) walk(item, name);
    }
  };
  walk(value);
  return artifacts;
}

function sessionVideoPresentation(record: Record<string, unknown>, sessionId: string, buildId: string | undefined): boolean {
  if (record.status === "running" || buildId === undefined) return false;
  const value = record.video_url;
  if (typeof value !== "string") return false;
  try {
    const video = referenceUrl(value);
    return video !== undefined && DASHBOARD_ORIGINS.has(video.origin) && dashboardPresentation(value, video, "video_url", sessionId, buildId);
  } catch (error) {
    if (error instanceof BrowserStackAuditFailure) return false;
    throw error;
  }
}

function sessionContent(record: Record<string, unknown>, raw: string, presentation: boolean, media = false): TestRecord {
  return { complete: record.status !== "running", text: `${raw}\n${JSON.stringify(record)}`, video: false,
    screenshots: media || BASE64_IMAGE.test(raw) || Object.entries(record).some(([key, value]) => (key !== "video_url" || !presentation) && retainedMedia(value, key)) ? 1 : 0 };
}

export class BrowserStackApi {
  readonly #authorization: string;
  readonly #removalStarted = new Set<string>();
  constructor(credentials: BrowserStackCredentials) {
    this.#authorization = `Basic ${btoa(`${credentials.username}:${credentials.accessKey}`)}`;
  }

  async #get(path: string, beforeRetry?: (response: Response) => Promise<void>): Promise<Response> {
    return readProvider(() => fetch(`${API}${path}`, {
      headers: { authorization: this.#authorization }, redirect: "error", signal: AbortSignal.timeout(30_000),
    }), beforeRetry === undefined ? undefined : { beforeRetry });
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

  async #session(sessionId: string, inspect?: CloudRecordRemoval["inspect"], rejected?: (response: Response) => Promise<void>): Promise<{ readonly record: Record<string, unknown>; readonly raw: string; readonly content: TestRecord } | undefined> {
    if (!BROWSERSTACK_SESSION_ID.test(sessionId)) throw new Error("invalid BrowserStack session id");
    const response = await this.#get(`/sessions/${sessionId}.json`, rejected);
    if (response.status === 404) {
      if (rejected !== undefined) await rejected(response);
      else await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      if (rejected !== undefined) await rejected(response);
      else await response.body?.cancel();
      throw new Error(`BrowserStack allocation read failed with HTTP ${response.status}`);
    }
    if (rejected !== undefined && /^(?:image|video)\//iu.test(response.headers.get("content-type") ?? "")) {
      await rejected(response);
      throw new BrowserStackAuditFailure("BrowserStack returned an invalid allocation record");
    }
    const { text: raw, media } = await readRetainedBody(response);
    await inspect?.({ complete: false, text: raw, video: false, screenshots: media ? 1 : 0 });
    const record = sessionPayload(raw, sessionId);
    const buildId = typeof record.build_hashed_id === "string" && BROWSERSTACK_SESSION_ID.test(record.build_hashed_id) ? record.build_hashed_id : undefined;
    const content = sessionContent(record, raw, sessionVideoPresentation(record, sessionId, buildId), media);
    await inspect?.(content);
    return { record, raw, content };
  }

  async allocation(sessionId: string): Promise<Record<string, unknown>> {
    const result = await this.#session(sessionId);
    if (result === undefined) throw new Error("BrowserStack allocation record is absent");
    return result.record;
  }

  async #artifact(url: string, sessionId: string, buildId: string, beforeRetry?: (response: Response) => Promise<void>): Promise<Response> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("invalid BrowserStack artifact reference"); }
    if (!ARTIFACT_ORIGINS.has(parsed.origin) || !reviewedArtifactQuery(parsed) || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" ||
      (!parsed.pathname.includes(sessionId) && !parsed.pathname.includes(buildId))) throw new Error("unreviewed BrowserStack artifact reference");
    // Signed references carry their own authorization. Never forward account authorization here.
    return readProvider(() => fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(30_000) }), beforeRetry === undefined ? undefined : { beforeRetry });
  }

  async testRecord(sessionId: string, remember?: (artifacts: readonly CloudArtifact[]) => Promise<void>, inspect?: CloudRecordRemoval["inspect"]): Promise<TestRecord | undefined> {
    const texts: string[] = [];
    const artifacts: CloudArtifact[] = [];
    let buildId: string | undefined;
    let dashboardReferences = 0, screenshots = 0, bytes = 0, video = false;
    const inventory = async (json: unknown, raw: string, sessionMetadata = false): Promise<void> => {
      const found = browserStackReferences(sessionId, buildId, json, sessionMetadata, raw);
      dashboardReferences += found.dashboardReferences;
      mergeBrowserStackArtifacts(sessionId, artifacts, found.artifacts);
      await remember?.([...artifacts]);
    };
    const append = async (response: Response, artifactError = false): Promise<string | undefined> => {
      const contentType = response.headers.get("content-type") ?? "";
      if (/^(?:image|video)\//iu.test(contentType)) {
        video = true;
        await response.body?.cancel();
        await inspect?.({ complete: false, text: "", video: true, screenshots: 0 });
        return undefined;
      }
      const { text: raw, media } = await readRetainedBody(response);
      await inspect?.({ complete: false, text: raw, video: false, screenshots: media ? 1 : 0 });
      if (media) screenshots = 1;
      if (artifactError && !/(?:\/|\+)json(?:;|$)/iu.test(contentType)) rawErrorCensus(raw);
      const content = retainedContent(raw, contentType);
      if (content.text !== raw || content.media) await inspect?.({ complete: false, text: content.text !== raw ? content.text : "", video: false, screenshots: content.media ? 1 : 0 });
      if (content.json !== undefined) await inventory(content.json, raw);
      bytes += Buffer.byteLength(content.text);
      if (bytes > 2_000_000) throw new Error("BrowserStack returned oversized aggregate records");
      texts.push(content.text);
      if (content.media) screenshots = 1;
      return raw;
    };
    const inspectResponse = async (response: Response): Promise<void> => { await append(response); };
    const session = await this.#session(sessionId, inspect, inspectResponse);
    if (session === undefined) return undefined;
    const { record, raw, content: metadata } = session;
    if (record.status !== "running" && typeof record.build_hashed_id === "string" && BROWSERSTACK_SESSION_ID.test(record.build_hashed_id)) buildId = record.build_hashed_id;
    await inventory(record, raw, true);
    if (record.status === "running") return metadata;
    if (Object.keys(record).some(field => !(RECORD_FIELDS as readonly string[]).includes(field))) throw new Error("BrowserStack returned an unreviewed retained-record field");
    if (!FINAL_RECORD_STATES.has(String(record.status)) || typeof record.build_hashed_id !== "string" || !BROWSERSTACK_SESSION_ID.test(record.build_hashed_id)) throw new Error("BrowserStack record has unknown finalization state");
    texts.push(metadata.text);
    screenshots ||= metadata.screenshots;
    bytes += Buffer.byteLength(metadata.text);
    if (bytes > 2_000_000) throw new Error("BrowserStack returned oversized aggregate records");
    for (const surface of LOG_SURFACES) {
      const response = await this.#get(`/sessions/${sessionId}/${surface}`, inspectResponse);
      const contentType = response.headers.get("content-type") ?? "";
      await append(response);
      if (response.status === 404 && surface !== "logs") continue;
      if (response.status !== 200) throw new Error("BrowserStack required retained log is unavailable");
      if (/^(?:image|video)\//iu.test(contentType)) continue;
      if (!contentType.startsWith("text/plain") && !/(?:\/|\+)json(?:;|$)/iu.test(contentType)) throw new Error("BrowserStack returned an unexpected log format");
    }
    for (const artifact of artifacts) {
      const response = await this.#artifact(artifact.url, sessionId, artifact.buildId, async response => { await append(response, response.status >= 400); });
      if (artifact.kind === "media" && response.status === 200) {
        video = true;
        await inspect?.({ complete: false, text: "", video: true, screenshots: 0 });
        await append(response);
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      const text = await append(response, response.status >= 400);
      if (response.status === 404) continue;
      if (artifact.kind === "media") {
        if (response.status !== 403 || text === undefined || !text.includes("<Code>AccessDenied</Code>") || !text.includes("s3:ListBucket")) throw new Error("BrowserStack video retention state is unknown");
        continue;
      }
      if (response.status === 200 && /^(?:image|video)\//iu.test(contentType)) continue;
      if (response.status !== 200 || (!contentType.startsWith("text/plain") && !/(?:\/|\+)json(?:;|$)/iu.test(contentType))) throw new Error("BrowserStack retained artifact state is unknown");
    }
    const text = texts.join("\n");
    return { complete: true, text, video, screenshots, dashboardReferences };
  }

  /** DELETE is never retried; only subsequent absence reads are bounded/retried. */
  async deleteRecord(sessionId: string, removal: CloudRecordRemoval, clock: { now(): number; pause(milliseconds: number): Promise<void> } = { now: Date.now, pause: Bun.sleep }): Promise<void> {
    validateBrowserStackArtifacts(sessionId, removal.artifacts);
    const artifacts = [...removal.artifacts];
    const audited = new Set(artifacts.map(browserStackArtifactIdentity));
    let buildId = artifacts[0]?.buildId;
    let deleteAcknowledged = false;
    let validationFailures = 0;
    const unvalidated = async (next = artifacts): Promise<void> => {
      validationFailures += 1;
      artifacts.splice(0, artifacts.length, ...next);
      await removal.remember([...artifacts], "post-audit unvalidated record");
    };
    const inspect = async (response: Response, mode: "body" | "session" | "delete" | "artifact" = "body"): Promise<string | undefined> => {
      const contentType = response.headers.get("content-type") ?? "";
      if (/^(?:image|video)\//iu.test(contentType)) {
        await response.body?.cancel();
        await removal.inspect({ complete: false, text: "", video: true, screenshots: 0 });
        if (mode === "session" || mode === "delete") await unvalidated();
        return;
      }
      let body: Awaited<ReturnType<typeof readRetainedBody>>;
      try { body = await readRetainedBody(response); }
      catch (error) {
        if (!(error instanceof BrowserStackAuditFailure)) throw error;
        await unvalidated();
        return;
      }
      const { text: raw, media } = body;
      // Scan even malformed/duplicate JSON before parsing; a later 404 cannot erase a hit.
      await removal.inspect({ complete: false, text: raw, video: false, screenshots: media ? 1 : 0 });
      const metadata = mode === "session" && response.status === 200;
      const deletion = mode === "delete";
      const jsonType = /(?:\/|\+)json(?:;|$)/iu.test(contentType);
      const unexpectedFormat = mode === "artifact" && response.status === 200 && !contentType.startsWith("text/plain") && !jsonType;
      let content: ReturnType<typeof retainedContent>;
      try { content = retainedContent(raw, metadata || deletion || unexpectedFormat ? "application/json" : contentType); }
      catch (error) {
        if (!(error instanceof RetainedVendorJsonError)) throw error;
        await unvalidated();
        return raw;
      }
      if (content.text !== raw || (!metadata && content.media)) await removal.inspect({ complete: false, text: content.text !== raw ? content.text : "", video: false, screenshots: !metadata && content.media ? 1 : 0 });
      let next = [...artifacts], retained: TestRecord | undefined;
      let invalid = false;
      try {
        if (mode === "artifact" && response.status >= 400 && !jsonType) rawErrorCensus(raw);
        if (metadata) {
          const record = sessionRecord(content.json, sessionId);
          const recordBuild = typeof record.build_hashed_id === "string" && BROWSERSTACK_SESSION_ID.test(record.build_hashed_id) ? record.build_hashed_id : undefined;
          const presentation = sessionVideoPresentation(record, sessionId, recordBuild);
          retained = sessionContent(record, raw, presentation, media);
          if (recordBuild === undefined) throw new BrowserStackAuditFailure("BrowserStack record has invalid build identity");
          buildId = recordBuild;
          if (Object.keys(record).some(field => !(RECORD_FIELDS as readonly string[]).includes(field))) throw new BrowserStackAuditFailure("BrowserStack returned an unreviewed retained-record field");
          if (record.status !== "running" && !presentation) throw new BrowserStackAuditFailure("BrowserStack returned an unreviewed video presentation");
          mergeBrowserStackArtifacts(sessionId, next, browserStackReferences(sessionId, buildId, record, true, raw).artifacts);
        } else if (content.json !== undefined) {
          mergeBrowserStackArtifacts(sessionId, next, browserStackReferences(sessionId, buildId, content.json, false, raw).artifacts);
        }
        if (unexpectedFormat) throw new BrowserStackAuditFailure("BrowserStack retained signed artifact format is unknown");
        if (deletion && (!isRecord(content.json) || content.json.status !== "ok")) throw new BrowserStackAuditFailure("BrowserStack record deletion was not acknowledged");
      } catch (error) {
        if (!(error instanceof BrowserStackAuditFailure)) throw error;
        invalid = true;
        next = recoverableArtifacts(sessionId, buildId, content.json, artifacts);
      }
      if (retained !== undefined) await removal.inspect(retained);
      if (invalid) await unvalidated(next);
      else {
        artifacts.splice(0, artifacts.length, ...next);
        await removal.remember([...artifacts], next.some(artifact => !audited.has(browserStackArtifactIdentity(artifact))) ? "post-audit retained reference" : undefined);
      }
      if (deletion && !invalid) deleteAcknowledged = true;
      return raw;
    };
    const existing = await this.#get(`/sessions/${sessionId}.json`, async response => { await inspect(response, "session"); });
    await inspect(existing, "session");
    if (existing.status !== 200 && existing.status !== 404) await unvalidated();
    let deletionError: Error | undefined;
    if (existing.status !== 404 && !removal.deleted && !this.#removalStarted.has(sessionId)) {
      this.#removalStarted.add(sessionId);
      const response = await fetch(`${API}/sessions/${sessionId}.json`, { method: "DELETE", headers: { authorization: this.#authorization }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      await inspect(response, "delete");
      if (response.status !== 200) {
        deletionError = new Error(`BrowserStack record deletion failed with HTTP ${response.status}`);
        await unvalidated();
      } else if (deleteAcknowledged) await removal.markDeleted();
    }
    if (existing.status === 404) await removal.markDeleted();
    const deadline = clock.now() + 180_000;
    for (;;) {
      let absent = true;
      for (const suffix of [".json", ...LOG_SURFACES.map(surface => `/${surface}`)]) {
        const mode = suffix === ".json" ? "session" : "body";
        const check = await this.#get(`/sessions/${sessionId}${suffix}`, async response => { await inspect(response, mode); });
        await inspect(check, mode);
        if (check.status !== 404) absent = false;
      }
      if (absent) break;
      if (clock.now() >= deadline) throw deletionError ?? new Error("BrowserStack record deletion could not be verified");
      await clock.pause(2_000);
    }
    await removal.markDeleted();
    // Prove record/log absence even without an inventory, but never claim artifact restoration.
    if (artifacts.length === 0) throw new Error("BrowserStack retained artifact inventory is unavailable");
    for (let index = 0; index < artifacts.length; index += 1) {
      for (;;) {
        const artifact = artifacts[index]!;
        const check = await this.#artifact(artifact.url, sessionId, artifact.buildId, async response => { await inspect(response, "artifact"); });
        if (artifact.kind === "media" && check.status === 200) {
          await removal.inspect({ complete: true, text: "", video: true, screenshots: 0 });
          await inspect(check, "artifact");
        } else {
          const before = validationFailures;
          const text = await inspect(check, "artifact");
          if (check.status === 404) break;
          if (artifact.kind === "media" && check.status === 403) {
            if (text?.includes("<Code>AccessDenied</Code>") && text.includes("s3:ListBucket")) break;
            await unvalidated();
          } else if (check.status !== 200 && validationFailures === before) {
            throw new Error("BrowserStack retained signed artifact state is unknown");
          }
        }
        if (clock.now() >= deadline) throw new Error("BrowserStack retained signed artifact absence could not be verified");
        await clock.pause(2_000);
      }
    }
    if (deletionError !== undefined) throw deletionError;
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

interface LocalProcessIdentity { readonly pid: number; readonly started: string }
export interface BrowserStackLocalProcess extends LocalProcessIdentity {
  readonly parentPid: number;
  readonly cwd?: string;
  readonly executableFiles: readonly string[];
}

/** No argv/title inspection: retitling cannot hide a process or expose the vendor's child key. */
async function localProcesses(): Promise<BrowserStackLocalProcess[]> {
  const ps = Bun.spawn(["ps", "-axo", "pid=,ppid=,lstart="], { env: { ...process.env, LC_ALL: "C" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [listing, status] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  if (status !== 0) throw new Error("could not enumerate BrowserStack Local process lineage");
  const processes = new Map<number, { pid: number; parentPid: number; started: string; cwd?: string; executableFiles: string[] }>();
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match) processes.set(Number(match[1]), { pid: Number(match[1]), parentPid: Number(match[2]), started: match[3]!, executableFiles: [] });
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("BrowserStack Local process ownership requires POSIX");
  const lsof = Bun.spawn(["lsof", "-nP", "-a", "-u", String(uid), "-d", "cwd,txt", "-F", "pfn"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [files, fileStatus] = await Promise.all([new Response(lsof.stdout).text(), lsof.exited]);
  if (fileStatus !== 0 && fileStatus !== 1) throw new Error("could not verify BrowserStack Local process ownership");
  let current: ReturnType<typeof processes.get>;
  let descriptor = "";
  for (const line of files.split("\n")) {
    if (line.startsWith("p")) { current = processes.get(Number(line.slice(1))); descriptor = ""; }
    else if (line.startsWith("f")) descriptor = line.slice(1);
    else if (line.startsWith("n") && current !== undefined) {
      const file = line.slice(1).replace(/ \(deleted\)$/u, "");
      if (descriptor === "cwd") current.cwd = file;
      else if (descriptor === "txt") current.executableFiles.push(file);
    }
  }
  return [...processes.values()];
}

async function localProcessIdentities(options: BrowserStackLocalIdentity): Promise<LocalProcessIdentity[]> {
  const file = join(options.directory, "processes.json");
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (stat === undefined) return [];
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 32_768) throw new Error("invalid BrowserStack Local process checkpoint");
  const value = parseRetainedVendorJson(await readFile(file, "utf8"));
  if (!Array.isArray(value) || value.length > 128 || value.some(item => !isRecord(item) || Object.keys(item).sort().join(",") !== "pid,started" ||
    !Number.isSafeInteger(item.pid) || (item.pid as number) < 1 || typeof item.started !== "string" || !/^[ -~]{1,64}$/u.test(item.started))) throw new Error("invalid BrowserStack Local process checkpoint");
  return value as LocalProcessIdentity[];
}

async function saveLocalProcesses(options: BrowserStackLocalIdentity, identities: readonly LocalProcessIdentity[]): Promise<void> {
  const file = join(options.directory, "processes.json");
  await writeFile(`${file}.new`, JSON.stringify(identities), { mode: 0o600 });
  await chmod(`${file}.new`, 0o600);
  await rename(`${file}.new`, file);
}

async function canonicalLocalPath(path: string): Promise<{ path: string; exists: boolean }> {
  try { return { path: await realpath(path), exists: true }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw new Error("could not resolve BrowserStack Local process ownership");
    const parent = await canonicalLocalPath(dirname(path));
    return { path: join(parent.path, basename(path)), exists: false };
  }
}

/** Birth identities prevent PID reuse; exact executable/cwd also catches orphaned vendor children. */
export async function ownedLocalProcesses(options: BrowserStackLocalIdentity, snapshot: () => Promise<readonly BrowserStackLocalProcess[]> = localProcesses): Promise<number[]> {
  const [binary, directory, roots, processes] = await Promise.all([
    canonicalLocalPath(options.binary), canonicalLocalPath(options.directory), localProcessIdentities(options), snapshot(),
  ]);
  const owned = new Set<number>();
  for (const entry of processes) {
    if (roots.some(root => root.pid === entry.pid && root.started === entry.started) ||
      (entry.executableFiles.includes(binary.path) && entry.cwd === directory.path)) owned.add(entry.pid);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of processes) if (!owned.has(entry.pid) && owned.has(entry.parentPid)) { owned.add(entry.pid); changed = true; }
  }
  if (!directory.exists && processes.some(entry => entry.executableFiles.includes(binary.path)) && owned.size === 0) throw new Error("BrowserStack Local absence cannot be proved without its working directory");
  if (processes.some(entry => entry.cwd === directory.path && !owned.has(entry.pid))) throw new Error("BrowserStack Local working directory has an unverified process");
  const identities = processes.filter(entry => owned.has(entry.pid)).map(({ pid, started }) => ({ pid, started })).sort((a, b) => a.pid - b.pid);
  if (identities.length > 128) throw new Error("BrowserStack Local process lineage exceeded its bound");
  if (directory.exists && JSON.stringify(identities) !== JSON.stringify(roots)) await saveLocalProcesses(options, identities);
  return identities.map(entry => entry.pid);
}

export async function canonicalBrowserStackLocalIdentity(options: BrowserStackLocalIdentity): Promise<BrowserStackLocalIdentity> {
  try {
    const [binary, directory] = await Promise.all([realpath(options.binary), realpath(options.directory)]);
    return { ...options, binary, directory };
  } catch { throw new Error("could not resolve BrowserStack Local process ownership"); }
}

/** No tunnel ownership is checkpointed until download and private-directory preparation succeed. */
export async function prepareBrowserStackLocal(options: BrowserStackLocalIdentity, checkpoint: () => Promise<void>, ensure = ensureBrowserStackLocal): Promise<BrowserStackLocalIdentity> {
  const binary = await ensure();
  if (binary !== options.binary) throw new Error("BrowserStack Local binary differs from its recovery identity");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await canonicalBrowserStackLocalIdentity(options);
  await checkpoint();
  return options;
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
  let stopped = false;
  try {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const deadline = runtime.now() + 10_000;
      const signalled = new Set<number>();
      let quietSince: number | undefined;
      while (runtime.now() < deadline) {
        const pids = await runtime.processes(options);
        if (pids.length === 0) {
          quietSince ??= runtime.now();
          if (runtime.now() - quietSince >= 1_000) { stopped = true; return; }
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
    if (stopped) {
      await rm(join(options.directory, "processes.json"), { force: true });
      await rm(join(options.directory, "processes.json.new"), { force: true });
    }
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
    const parent = (await localProcesses()).find(entry => entry.pid === child.pid);
    if (parent === undefined) throw new Error("BrowserStack Local launched parent identity is unavailable");
    await saveLocalProcesses(options, [{ pid: parent.pid, started: parent.started }]);
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
