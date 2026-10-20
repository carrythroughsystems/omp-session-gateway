/**
 * TestingBot, the real-device cloud behind the stable campaign's `deviceCloud` lane (ADR-032).
 *
 * Credentials come from the read-only 1Password service account, so a campaign never waits on a
 * Touch ID prompt. The tunnel is the pinned release jar, with TestingBot's own local proxy replaced
 * by an allowlisting one that never decrypts. WebDriver session creation and deletion are never
 * retried: a write that reached the vendor must not run twice. Failure text carries status codes
 * and W3C error codes, never response bodies, which can echo account identifiers and session URLs.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../packages/collab-client/upstream/src/tool-render/util.ts";
import { readProvider } from "./provider-read.ts";
import { parseRetainedVendorJson, RetainedVendorJsonError } from "./device-cloud-record-json.ts";
import { TESTINGBOT_SESSION_ID, WebDriverError, type WebDriverSession } from "./device-cloud-webdriver.ts";
import {
  boundedVendorText, readCloudCredentials, runOp, listProcesses, listeningAddresses, requireLoopbackListeners,
  type CloudDevice, type TestRecord, type OpRunner, type ProcessEntry,
} from "./device-cloud-common.ts";

/** The GitHub release asset, verified by the digest GitHub publishes for it. */
export const TESTINGBOT_TUNNEL = {
  version: "4.9",
  url: "https://github.com/testingbot/Testingbot-Tunnel/releases/download/v4.9/TestingBotTunnel-4.9.jar",
  bytes: 7_802_299,
  sha256: "ff4e23e21b38b236228d2f5eeaf3b241fad5d3b8faa3e8d1136772769cfe0f14",
} as const;

const API = "https://api.testingbot.com/v1";
const MAX_RECORD_BYTES = 2_000_000;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const TUNNEL_IDENTIFIER = /^omp-dc-[0-9a-f]{8}$/u;

export interface TestingBotCredentials {
  readonly key: string;
  readonly secret: string;
}

function retainedLogUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("TestingBot returned an invalid retained log reference");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("TestingBot returned an invalid retained log reference"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" ||
    !["s3.amazonaws.com", "s3-eu-west-1.amazonaws.com"].includes(url.hostname) || url.port !== "" ||
    !url.pathname.startsWith("/eulogtestingbot/")) throw new Error("TestingBot returned an unreviewed retained log origin or bucket");
  return url.href;
}

/**
 * Reads the TestingBot key and secret through the read-only 1Password service account.
 *
 * The token reaches only each `op` child, through its environment and never argv, in an
 * environment that carries no `OP_ACCOUNT`. A service account has exactly one account, so no call
 * passes `--account`; `op whoami` pins it to the personal account before anything is read.
 */
export async function readTestingBotCredentials(tokenFile: string, op: OpRunner = runOp): Promise<TestingBotCredentials> {
  const [key, secret] = await readCloudCredentials(tokenFile, "testingbot", op);
  return { key, secret };
}

function basicAuthorization(credentials: TestingBotCredentials): string {
  return `Basic ${btoa(`${credentials.key}:${credentials.secret}`)}`;
}

/** The REST API: read-only, bounded, and retried only on a transient 5xx. */
export class TestingBotApi {
  readonly #authorization: string;

  constructor(credentials: TestingBotCredentials) {
    this.#authorization = basicAuthorization(credentials);
  }

  async #get(path: string, operation: string): Promise<Response | undefined> {
    const response = await readProvider(() =>
      fetch(`${API}${path}`, { headers: { authorization: this.#authorization }, signal: AbortSignal.timeout(30_000) }),
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`TestingBot ${operation} read failed with HTTP ${response.status}`);
    }
    return response;
  }

  /** The real-device catalog, or only the devices free right now. */
  async devices(scope: "all" | "available"): Promise<readonly CloudDevice[]> {
    const response = await this.#get(scope === "all" ? "/devices" : "/devices/available", "device catalog");
    if (response === undefined) throw new Error("TestingBot device catalog is unavailable");
    const listing = parseRetainedVendorJson(await boundedVendorText(response, "TestingBot"));
    if (!Array.isArray(listing)) throw new Error("TestingBot returned an invalid device catalog");
    return listing.map(entry => {
      if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length < 1 || entry.name.length > 100 ||
        !["iOS", "Android"].includes(String(entry.platform_name)) || typeof entry.version !== "string" ||
        !/^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/u.test(entry.version)) throw new Error("TestingBot returned an invalid device catalog");
      return { name: entry.name, platform: entry.platform_name as string, version: entry.version };
    });
  }

  /** The retained record of one WebDriver session, which TestingBot keys by session id. */
  async testRecord(sessionId: string): Promise<TestRecord | undefined> {
    if (!TESTINGBOT_SESSION_ID.test(sessionId)) throw new Error("invalid TestingBot session id");
    const response = await this.#get(`/tests/${sessionId}`, "test record");
    if (response === undefined) return undefined;
    const text = await boundedVendorText(response, "TestingBot");
    const record = parseRetainedVendorJson(text);
    if (!isRecord(record)) throw new Error("TestingBot returned an invalid test record");
    if (record.state !== "COMPLETE" || record.assets_available !== true) {
      return { complete: false, text: `${text}\n${JSON.stringify(record)}`, video: record.video !== false, screenshots: 0 };
    }
    const assetsResponse = await this.#get(`/tests/${sessionId}/assets`, "test assets");
    if (assetsResponse === undefined) throw new Error("TestingBot retained asset inventory is missing");
    let remainingBytes = MAX_RECORD_BYTES - Buffer.byteLength(text, "utf8");
    const assetsText = await boundedVendorText(assetsResponse, "TestingBot", remainingBytes);
    remainingBytes -= Buffer.byteLength(assetsText, "utf8");
    const assets = parseRetainedVendorJson(assetsText);
    if (!isRecord(assets) || assets.session_id !== sessionId || !isRecord(record.logs) || !isRecord(assets.logs) ||
      !Array.isArray(record.thumbs) || !Array.isArray(assets.screenshots) ||
      (assets.har !== null && assets.har !== false && typeof assets.har !== "string") ||
      (assets.performance !== null && assets.performance !== false && typeof assets.performance !== "string")) {
      throw new Error("TestingBot returned an invalid retained asset inventory");
    }
    const surfaces = [text, JSON.stringify(record), assetsText, JSON.stringify(assets)];
    const references = new Set([...Object.values(record.logs), ...Object.values(assets.logs)]);
    for (const extra of [assets.har, assets.performance]) if (typeof extra === "string") references.add(extra);
    if (references.size > 16) throw new Error("TestingBot retained log inventory exceeds its surface bound");
    for (const reference of references) {
      const url = retainedLogUrl(reference);
      // Signed asset references are already authorized. Never forward the account's credentials.
      const logResponse = await readProvider(() => fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) }));
      if (!logResponse.ok) {
        await logResponse.body?.cancel();
        throw new Error(`TestingBot retained log read failed with HTTP ${logResponse.status}`);
      }
      const logText = await boundedVendorText(logResponse, "TestingBot", remainingBytes);
      remainingBytes -= Buffer.byteLength(logText, "utf8");
      surfaces.push(logText);
      try { surfaces.push(JSON.stringify(parseRetainedVendorJson(logText))); }
      catch (error) {
        const type = logResponse.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (!(error instanceof RetainedVendorJsonError) || error.code !== "invalid-json" ||
          type === "application/json" || type?.endsWith("+json")) throw error;
        // Plain-text logs remain raw-only and are never a source of further references.
      }
    }
    return {
      complete: true,
      text: surfaces.join("\n"),
      video: record.video !== false || (assets.video !== null && assets.video !== false),
      screenshots: record.thumbs.length + assets.screenshots.length,
    };
  }
}

/** TestingBot-only native controls for the iPhone Home Screen and background Push proof. */
export class TestingBotNativeSession {
  constructor(private readonly session: WebDriverSession) {
    if (session.vendor !== "testingbot") throw new Error("native iPhone journey requires TestingBot");
  }

  navigate(url: string): Promise<unknown> { return this.session.navigate(url); }
  evaluate<T>(expression: string): Promise<T> { return this.session.evaluate<T>(expression); }

  async contexts(): Promise<readonly string[]> {
    const listed = await this.session.command("context listing", "GET", "/contexts");
    return (Array.isArray(listed) ? listed : []).flatMap(context => {
      if (typeof context === "string") return [context];
      return isRecord(context) && typeof context.id === "string" ? [context.id] : [];
    });
  }

  async context(name: string): Promise<void> {
    await this.session.command("context switch", "POST", "/context", { name });
  }

  async find(predicate: string): Promise<string | undefined> {
    try {
      const element = await this.session.command("element lookup", "POST", "/element", { using: "-ios predicate string", value: predicate });
      return isRecord(element) && typeof element[ELEMENT] === "string" ? element[ELEMENT] : undefined;
    } catch (error) {
      if (error instanceof WebDriverError && error.code === "no such element") return undefined;
      throw error;
    }
  }

  async findAll(predicate: string): Promise<readonly string[]> {
    const elements = await this.session.command("element lookup", "POST", "/elements", { using: "-ios predicate string", value: predicate });
    return (Array.isArray(elements) ? elements : []).flatMap(element =>
      isRecord(element) && typeof element[ELEMENT] === "string" ? [element[ELEMENT]] : []);
  }

  async click(element: string): Promise<void> {
    await this.session.command("tap", "POST", `/element/${encodeURIComponent(element)}/click`, {});
  }

  async pressHome(): Promise<void> {
    await this.session.command("home button", "POST", "/execute/sync", { script: "mobile: pressButton", args: [{ name: "home" }] });
  }

  async openNotificationCenter(): Promise<void> {
    await this.session.command("notification center", "POST", "/actions", { actions: [{
      type: "pointer", id: "finger", parameters: { pointerType: "touch" }, actions: [
        { type: "pointerMove", duration: 0, x: 100, y: 3 }, { type: "pointerDown", button: 0 },
        { type: "pause", duration: 150 }, { type: "pointerMove", duration: 500, x: 100, y: 650 },
        { type: "pointerUp", button: 0 },
      ],
    }] });
  }
}

async function fileSha256(path: string): Promise<string | undefined> {
  const bytes = await readFile(path).catch(() => undefined);
  return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}

/** The pinned tunnel jar, downloaded once into the user cache and verified before every use. */
export async function ensureTunnelJar(directory = join(homedir(), ".cache", "omp-session-gateway", "testingbot")): Promise<string> {
  const path = join(directory, `TestingBotTunnel-${TESTINGBOT_TUNNEL.version}.jar`);
  if (await fileSha256(path) === TESTINGBOT_TUNNEL.sha256) return path;
  const response = await readProvider(() => fetch(TESTINGBOT_TUNNEL.url, { signal: AbortSignal.timeout(120_000) }));
  if (!response.ok) throw new Error(`the TestingBot tunnel download failed with HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== TESTINGBOT_TUNNEL.bytes || createHash("sha256").update(bytes).digest("hex") !== TESTINGBOT_TUNNEL.sha256) {
    throw new Error("the TestingBot tunnel download does not match its pinned SHA-256");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}

export interface TunnelOptions {
  readonly java: string;
  readonly jar: string;
  /** Private working directory: the tunnel writes its pid and ready files here. */
  readonly directory: string;
  readonly identifier: string;
  /** The allowlisting proxy's port; TestingBot's own local proxy never starts. */
  readonly localProxyPort: number;
}

/**
 * Starts the tunnel and waits for its ready file. `--noproxy` hands every device request to the
 * allowlisting proxy on `localProxyPort`, so TLS stays end to end and SSE and WebSockets pass
 * through; `--nocache` bypasses the vendor's caching proxy. The credentials reach Java only
 * through its environment.
 *
 * Stock 4.9 also opens a Selenium relay (4445) and a metrics server (8003) on every interface,
 * with no option to bind them elsewhere, and the relay lends this account to any unauthenticated
 * caller that can reach it. Port -1 makes each listener fail to open, which the tunnel logs and
 * survives; the lane drives the hub directly and needs neither. Once ready, the tunnel must listen
 * on loopback only, or it is refused.
 */
export async function startTunnel(
  options: TunnelOptions,
  credentials: TestingBotCredentials,
  timeoutMs = 120_000,
  listeners: (pid: number) => Promise<readonly string[]> = listeningAddresses,
): Promise<void> {
  if (!TUNNEL_IDENTIFIER.test(options.identifier)) throw new Error("invalid TestingBot tunnel identifier");
  const ready = join(options.directory, "ready");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const child = Bun.spawn(
    [
      options.java, "-jar", options.jar, "--nobump", "--nocache", "--noproxy", "--localproxy", String(options.localProxyPort),
      "--se-port=-1", "--metrics-port=-1", "--tunnel-identifier", options.identifier, "--readyfile", ready,
    ],
    {
      cwd: options.directory,
      env: { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin", TESTINGBOT_KEY: credentials.key, TESTINGBOT_SECRET: credentials.secret },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  child.unref();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("the TestingBot tunnel exited before it was ready");
      if (await Bun.file(ready).exists()) {
        requireLoopbackListeners(await listeners(child.pid), "testingbot");
        return;
      }
      await Bun.sleep(500);
    }
    throw new Error("the TestingBot tunnel did not become ready");
  } catch (error) {
    // A tunnel that failed to start never outlives the call, least of all one listening beyond loopback.
    await stopTunnel(options.identifier).catch((stopError: unknown) => {
      throw new AggregateError([error, stopError], "the TestingBot tunnel failed to start and to stop");
    });
    throw error;
  }
}











/**
 * Stops every tunnel process carrying this attempt's identifier, found by command line so a crash
 * before the pid was recorded still leaves it stoppable. Returns how many were running.
 */
export async function stopTunnel(
  identifier: string,
  list: () => Promise<readonly ProcessEntry[]> = listProcesses,
  signal: (pid: number, name: "SIGTERM" | "SIGKILL") => void = (pid, name) => process.kill(pid, name),
  graceMs = 10_000,
): Promise<number> {
  if (!TUNNEL_IDENTIFIER.test(identifier)) throw new Error("invalid TestingBot tunnel identifier");
  const owned = async () => (await list())
    .filter(entry => entry.command.includes("TestingBotTunnel") && entry.command.includes(` --tunnel-identifier ${identifier} `))
    .map(entry => entry.pid);
  let pids = await owned();
  const running = pids.length;
  for (const name of ["SIGTERM", "SIGKILL"] as const) {
    if (pids.length === 0) return running;
    for (const pid of pids) {
      try {
        signal(pid, name);
      } catch {
        // It exited between the listing and the signal.
      }
    }
    const deadline = Date.now() + graceMs;
    while ((pids = await owned()).length > 0 && Date.now() < deadline) await Bun.sleep(250);
  }
  if (pids.length > 0) throw new Error("the TestingBot tunnel outlived SIGKILL");
  return running;
}
