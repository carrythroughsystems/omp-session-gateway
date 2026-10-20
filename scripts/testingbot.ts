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
import { createServer, connect, type Socket } from "node:net";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../packages/collab-client/upstream/src/tool-render/util.ts";
import type { JourneyPage } from "./browser-journey.ts";
import { readProvider } from "./provider-read.ts";

/** The GitHub release asset, verified by the digest GitHub publishes for it. */
export const TESTINGBOT_TUNNEL = {
  version: "4.9",
  url: "https://github.com/testingbot/Testingbot-Tunnel/releases/download/v4.9/TestingBotTunnel-4.9.jar",
  bytes: 7_802_299,
  sha256: "ff4e23e21b38b236228d2f5eeaf3b241fad5d3b8faa3e8d1136772769cfe0f14",
} as const;

const HUB = "https://hub.testingbot.com/wd/hub";
const API = "https://api.testingbot.com/v1";
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
export const TESTINGBOT_SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const TUNNEL_IDENTIFIER = /^omp-dc-[0-9a-f]{8}$/u;
const KEY_REFERENCE = "op://Centaur/TestingBot/key";
const SECRET_REFERENCE = "op://Centaur/TestingBot/secret";
/** A real device can queue behind another customer's session before TestingBot allocates it. */
const SESSION_CREATE_TIMEOUT_MS = 10 * 60 * 1_000;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_RECORD_BYTES = 2_000_000;

export interface TestingBotCredentials {
  readonly key: string;
  readonly secret: string;
}

export interface CloudDevice {
  readonly name: string;
  readonly platform: string;
  readonly version: string;
}

export interface TestRecord {
  readonly complete: boolean;
  /** Bounded raw retained surfaces and their canonical JSON, searched only in memory. */
  readonly text: string;
  readonly video: boolean;
  readonly screenshots: number;
}

async function boundedVendorText(response: Response, maximumBytes = MAX_RECORD_BYTES): Promise<string> {
  if (response.body === null) throw new Error("TestingBot returned an empty response");
  if (maximumBytes < 1) {
    await response.body.cancel();
    throw new Error("TestingBot returned an oversized response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error("TestingBot returned an oversized response");
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(buffer);
}

function vendorJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error("TestingBot returned invalid JSON"); }
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

export interface OpResult {
  readonly exitCode: number;
  readonly stdout: string;
  /** Why op did not succeed: a timeout, or its exit status and first stderr line. */
  readonly failure?: string;
  readonly failureClass?: "host-fault";
}
export type OpRunner = (argv: readonly string[], environment: Readonly<Record<string, string>>) => Promise<OpResult>;

/** The real `op` child; `timeoutMs` is a test seam. */
export async function runOp(argv: readonly string[], environment: Readonly<Record<string, string>>, timeoutMs = 30_000): Promise<OpResult> {
  const child = Bun.spawn([...argv], { env: { ...environment }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (timedOut) return { exitCode: exitCode || 1, stdout, failureClass: "host-fault", failure: `did not exit within ${timeoutMs / 1000} s` };
    if (exitCode === 0) return { exitCode, stdout };
    // A signal from elsewhere is not evidence that our exec deadline expired.
    if (child.signalCode !== null) return { exitCode, stdout, failure: `terminated by ${child.signalCode}` };
    const detail = stderr.trim().split("\n")[0]!.slice(0, 200);
    return { exitCode, stdout, failure: `exited ${exitCode}${detail === "" ? "" : `: ${detail}`}` };
  } finally { clearTimeout(deadline); }
}

/** The service-account token file: `OMP_STABLE_OP_TOKEN_FILE`, else the operator's default token file. */
export function serviceAccountTokenFile(environment: Readonly<Record<string, string | undefined>>): string {
  return environment.OMP_STABLE_OP_TOKEN_FILE ?? join(homedir(), ".local", "state", "alpha-founder", "retained-host", "op-service-account.token");
}

/**
 * Reads the TestingBot key and secret through the read-only 1Password service account.
 *
 * The token reaches only each `op` child, through its environment and never argv, in an
 * environment that carries no `OP_ACCOUNT`. A service account has exactly one account, so no call
 * passes `--account`; `op whoami` pins it to the personal account before anything is read.
 */
export async function readTestingBotCredentials(tokenFile: string, op: OpRunner = runOp): Promise<TestingBotCredentials> {
  const metadata = await lstat(tokenFile).catch(() => undefined);
  if (
    metadata === undefined || !metadata.isFile() || metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600 || metadata.size < 1 || metadata.size > 8_192
  ) {
    throw new Error("the 1Password service-account token must be a 0600 regular file owned by the current user");
  }
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!/^ops_[A-Za-z0-9+/=._-]{40,8000}$/u.test(token)) throw new Error("the 1Password service-account token is malformed");
  const environment = { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin", OP_SERVICE_ACCOUNT_TOKEN: token };

  const whoami = await op(["op", "whoami", "--format", "json"], environment);
  if (whoami.exitCode !== 0) {
    const recovery = whoami.failureClass === "host-fault"
      ? "; host-fault: 1Password identity probe timed out; if the installed op path hangs on macOS, re-exec the same inode through a hardlink or run brew reinstall --cask 1password-cli, then rerun the candidate preflight"
      : "";
    throw new Error(`op whoami ${whoami.failure ?? `exited ${whoami.exitCode}`}; the 1Password service account could not be checked${recovery}`);
  }
  let identity: unknown;
  try {
    identity = JSON.parse(whoami.stdout);
  } catch {
    identity = undefined;
  }
  const url = isRecord(identity) && typeof identity.url === "string"
    ? identity.url.trim().toLowerCase().replace(/^https:\/\//u, "").replace(/\/$/u, "")
    : "";
  if (url !== "my.1password.com" || !isRecord(identity) || identity.user_type !== "SERVICE_ACCOUNT") {
    throw new Error("the 1Password token is not a service account of my.1password.com");
  }
  const read = async (reference: string): Promise<string> => {
    const result = await op(["op", "read", reference], environment);
    if (result.exitCode !== 0) throw new Error(`the TestingBot credential could not be read from 1Password: op read ${result.failure ?? `exited ${result.exitCode}`}`);
    const value = result.stdout.trim();
    if (!/^[\x21-\x7e]{8,256}$/u.test(value)) throw new Error("the TestingBot credential could not be read from 1Password");
    return value;
  };
  return { key: await read(KEY_REFERENCE), secret: await read(SECRET_REFERENCE) };
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
    const listing = vendorJson(await boundedVendorText(response));
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
    const text = await boundedVendorText(response);
    const record = vendorJson(text);
    if (!isRecord(record)) throw new Error("TestingBot returned an invalid test record");
    if (record.state !== "COMPLETE" || record.assets_available !== true) {
      return { complete: false, text: `${text}\n${JSON.stringify(record)}`, video: record.video !== false, screenshots: 0 };
    }
    const assetsResponse = await this.#get(`/tests/${sessionId}/assets`, "test assets");
    if (assetsResponse === undefined) throw new Error("TestingBot retained asset inventory is missing");
    let remainingBytes = MAX_RECORD_BYTES - Buffer.byteLength(text, "utf8");
    const assetsText = await boundedVendorText(assetsResponse, remainingBytes);
    remainingBytes -= Buffer.byteLength(assetsText, "utf8");
    const assets = vendorJson(assetsText);
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
      const logText = await boundedVendorText(logResponse, remainingBytes);
      remainingBytes -= Buffer.byteLength(logText, "utf8");
      surfaces.push(logText);
      try { surfaces.push(JSON.stringify(JSON.parse(logText))); } catch { /* Plain-text logs have no JSON representation. */ }
    }
    return {
      complete: true,
      text: surfaces.join("\n"),
      video: record.video !== false || (assets.video !== null && assets.video !== false),
      screenshots: record.thumbs.length + assets.screenshots.length,
    };
  }
}

export class WebDriverError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

async function webDriverCommand(
  authorization: string,
  operation: string,
  method: string,
  path: string,
  body: unknown,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  const send = () => fetch(`${HUB}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const response = method === "GET" ? await readProvider(send) : await send();
  const payload: unknown = await response.json().catch(() => undefined);
  const value = isRecord(payload) ? payload.value : undefined;
  if (!response.ok) {
    const code = isRecord(value) && typeof value.error === "string" && /^[a-z ]{1,40}$/u.test(value.error) ? value.error : "unknown error";
    throw new WebDriverError(`TestingBot ${operation} failed with HTTP ${response.status} (${code})`, response.status, code);
  }
  return value;
}

/** Ends a session; one TestingBot already ended counts as ended. */
export async function endWebDriverSession(credentials: TestingBotCredentials, sessionId: string): Promise<void> {
  if (!TESTINGBOT_SESSION_ID.test(sessionId)) throw new Error("invalid TestingBot session id");
  try {
    await webDriverCommand(basicAuthorization(credentials), "session end", "DELETE", `/session/${sessionId}`, undefined);
  } catch (error) {
    if (error instanceof WebDriverError && (error.status === 404 || error.code === "invalid session id")) return;
    throw error;
  }
}

/**
 * The `execute/async` script around a page expression. A rejection returns only its error's name:
 * TestingBot logs every command's result, and a message can quote page state, a link included.
 */
export function pageEvaluationScript(expression: string): string {
  return `const done = arguments[arguments.length - 1];
    Promise.resolve().then(() => (${expression})).then(
      value => done({ ok: true, value }),
      error => done({ ok: false, error: error instanceof Error && ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "DOMException"].includes(error.name) ? error.name : "unnamed rejection" }));`;
}

/** One W3C session on a real device. Page evaluations return only their structured result. */
export class WebDriverSession implements JourneyPage {
  readonly #authorization: string;

  private constructor(readonly id: string, authorization: string) {
    this.#authorization = authorization;
  }

  /** `created` persists the session id before any other command, so cleanup can always end it. */
  static async create(
    credentials: TestingBotCredentials,
    capabilities: Record<string, unknown>,
    created: (sessionId: string) => Promise<void>,
  ): Promise<{ readonly session: WebDriverSession; readonly capabilities: Record<string, unknown> }> {
    const authorization = basicAuthorization(credentials);
    const value = await webDriverCommand(authorization, "session start", "POST", "/session", { capabilities: { alwaysMatch: capabilities } }, SESSION_CREATE_TIMEOUT_MS);
    if (!isRecord(value) || typeof value.sessionId !== "string" || !TESTINGBOT_SESSION_ID.test(value.sessionId)) {
      throw new Error("TestingBot started no identifiable session");
    }
    const session = new WebDriverSession(value.sessionId, authorization);
    try {
      await created(session.id);
      await session.#command("timeouts", "POST", "/timeouts", { script: 90_000, pageLoad: 90_000 });
    } catch (error) {
      try { await endWebDriverSession(credentials, session.id); }
      catch { throw new AggregateError([error, new Error("TestingBot identified session could not be ended after setup failure")], "TestingBot session setup and release failed"); }
      throw error;
    }
    return { session, capabilities: isRecord(value.capabilities) ? value.capabilities : {} };
  }

  #command(operation: string, method: string, path: string, body?: unknown): Promise<unknown> {
    return webDriverCommand(this.#authorization, operation, method, `/session/${this.id}${path}`, body);
  }

  async navigate(url: string): Promise<unknown> {
    return this.#command("navigation", "POST", "/url", { url });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.#command("page evaluation", "POST", "/execute/async", { script: pageEvaluationScript(expression), args: [] });
    if (!isRecord(result) || result.ok !== true) {
      const name = isRecord(result) && typeof result.error === "string" && /^[A-Za-z -]{1,40}$/u.test(result.error) ? result.error : "no result";
      throw new Error(`page evaluation failed: ${name}`);
    }
    return result.value as T;
  }

  async contexts(): Promise<readonly string[]> {
    const listed = await this.#command("context listing", "GET", "/contexts");
    return (Array.isArray(listed) ? listed : []).flatMap(context => {
      if (typeof context === "string") return [context];
      return isRecord(context) && typeof context.id === "string" ? [context.id] : [];
    });
  }

  async context(name: string): Promise<void> {
    await this.#command("context switch", "POST", "/context", { name });
  }

  /** The first element matching an iOS predicate, or undefined when none does. */
  async find(predicate: string): Promise<string | undefined> {
    try {
      const element = await this.#command("element lookup", "POST", "/element", { using: "-ios predicate string", value: predicate });
      return isRecord(element) && typeof element[ELEMENT] === "string" ? element[ELEMENT] : undefined;
    } catch (error) {
      if (error instanceof WebDriverError && error.code === "no such element") return undefined;
      throw error;
    }
  }

  async findAll(predicate: string): Promise<readonly string[]> {
    const elements = await this.#command("element lookup", "POST", "/elements", { using: "-ios predicate string", value: predicate });
    return (Array.isArray(elements) ? elements : []).flatMap(element =>
      isRecord(element) && typeof element[ELEMENT] === "string" ? [element[ELEMENT]] : [],
    );
  }

  async click(element: string): Promise<void> {
    await this.#command("tap", "POST", `/element/${encodeURIComponent(element)}/click`, {});
  }

  async pressHome(): Promise<void> {
    await this.#command("home button", "POST", "/execute/sync", { script: "mobile: pressButton", args: [{ name: "home" }] });
  }

  /** Pulls Notification Center down from the top edge. */
  async openNotificationCenter(): Promise<void> {
    await this.#command("notification center", "POST", "/actions", {
      actions: [{
        type: "pointer",
        id: "finger",
        parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x: 100, y: 3 },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 150 },
          { type: "pointerMove", duration: 500, x: 100, y: 650 },
          { type: "pointerUp", button: 0 },
        ],
      }],
    });
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
        const exposed = (await listeners(child.pid)).filter(address => !/^(?:127\.0\.0\.1|\[::1\]):[0-9]+$/u.test(address));
        if (exposed.length > 0) throw new Error(`the TestingBot tunnel listens beyond loopback on ${exposed.length} sockets`);
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

/** Every TCP address a process listens on, as lsof names them (`*:8003`, `127.0.0.1:50376`). */
async function listeningAddresses(pid: number): Promise<readonly string[]> {
  const child = Bun.spawn(["lsof", "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-F", "n"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [listing, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  // lsof exits 1 when the process has no matching socket.
  if (exitCode !== 0 && exitCode !== 1) throw new Error("could not list the TestingBot tunnel's sockets");
  return listing.split("\n").flatMap(line => (line.startsWith("n") ? [line.slice(1)] : []));
}

export interface AllowlistProxy {
  readonly port: number;
  /** Requests refused so far: anything but a CONNECT to an allowed `host:port`. */
  refusals(): number;
  close(): Promise<void>;
}

const MAX_PROXY_HEAD = 8_192;

/**
 * The tunnel's local proxy. TestingBot's tunnel fetches whatever its devices request from this
 * machine's network position, and its own proxy would reach loopback (where a gateway trusts
 * identity headers), the LAN, and every tailnet service this machine's login may open. This one
 * opens only CONNECT tunnels to the exact `host:port` entries allowed and refuses everything else,
 * including plain HTTP; it never decrypts what it relays.
 */
export async function startAllowlistProxy(allowed: readonly string[]): Promise<AllowlistProxy> {
  const permitted: Record<string, true> = Object.fromEntries(allowed.map(entry => [entry.toLowerCase(), true]));
  let refused = 0;
  const open = new Set<Socket>();
  const server = createServer(client => {
    open.add(client);
    client.on("close", () => open.delete(client));
    let head = Buffer.alloc(0);
    const refuse = () => {
      refused += 1;
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_PROXY_HEAD) {
          client.off("data", onData);
          refuse();
        }
        return;
      }
      client.off("data", onData);
      const target = /^CONNECT ([A-Za-z0-9.-]{1,253}):([0-9]{1,5}) HTTP\/1\.[01]\r\n/u.exec(head.toString("latin1", 0, end + 2));
      const host = target?.[1]?.toLowerCase();
      const port = Number(target?.[2]);
      if (host === undefined || !Object.hasOwn(permitted, `${host}:${port}`)) {
        refuse();
        return;
      }
      client.pause();
      const upstream = connect(port, host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const early = head.subarray(end + 4);
        if (early.length > 0) upstream.write(early);
        upstream.pipe(client);
        client.pipe(upstream);
        client.resume();
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the tunnel proxy did not bind a port");
  return {
    port: address.port,
    refusals: () => refused,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      // A relay WebSocket can stay open after its session ends; close() would otherwise wait on it.
      for (const socket of open) socket.destroy();
      await closed.promise;
    },
  };
}

export interface ProcessEntry {
  readonly pid: number;
  readonly command: string;
}

async function listProcesses(): Promise<readonly ProcessEntry[]> {
  const child = Bun.spawn(["ps", "-axww", "-o", "pid=,command="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error("could not list processes");
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
  });
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
