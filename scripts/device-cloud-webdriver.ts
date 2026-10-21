/** Fixed-vendor W3C transport. Reads alone retry; creation/commands/end are never replayed. */
import { isRecord } from "../packages/collab-client/upstream/src/tool-render/util.ts";
import type { JourneyPage } from "./browser-journey.ts";
import { boundedVendorText, vendorJson, type DeviceCloudVendor } from "./device-cloud-common.ts";
import { readProvider } from "./provider-read.ts";

export const TESTINGBOT_SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/u;
export const BROWSERSTACK_SESSION_ID = /^[a-f0-9]{40}$/u;
const CONNECTIONS = {
  testingbot: { endpoint: "https://hub.testingbot.com/wd/hub", name: "TestingBot", sessionId: TESTINGBOT_SESSION_ID },
  browserstack: { endpoint: "https://hub.browserstack.com/wd/hub", name: "BrowserStack", sessionId: BROWSERSTACK_SESSION_ID },
} as const;

export class WebDriverError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

async function webDriverCommand(vendor: DeviceCloudVendor, authorization: string, operation: string, method: string, path: string, body: unknown, timeoutMs = 120_000): Promise<unknown> {
  const connection = CONNECTIONS[vendor];
  const send = () => fetch(`${connection.endpoint}${path}`, {
    method, headers: { "content-type": "application/json", authorization }, redirect: "error",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
  });
  const response = method === "GET" ? await readProvider(send) : await send();
  const payload = vendorJson(await boundedVendorText(response, connection.name), connection.name);
  const value = isRecord(payload) ? payload.value : undefined;
  if (operation === "session start" && isRecord(payload) && isRecord(value) &&
    typeof payload.sessionId === "string" && typeof value.sessionId === "string" && payload.sessionId !== value.sessionId) throw new Error(`${connection.name} session start reported two session ids`);
  // BrowserStack reports schema refusal with HTTP 200, status 13, and an empty sessionId.
  if (!response.ok || (isRecord(payload) && typeof payload.status === "number" && payload.status !== 0) || (isRecord(value) && typeof value.error === "string")) {
    const code = isRecord(value) && typeof value.error === "string" && /^[a-z ]{1,40}$/u.test(value.error) ? value.error : "unknown error";
    throw new WebDriverError(`${connection.name} ${operation} failed with HTTP ${response.status} (${code})`, response.status, code);
  }
  if (operation === "session start" && isRecord(payload) && isRecord(value)) {
    const wireId = typeof payload.sessionId === "string" && payload.sessionId !== "" ? payload.sessionId : undefined;
    // W3C nests the id and capabilities in `value`; TestingBot also echoes the id at the top level.
    if (typeof value.sessionId === "string" && isRecord(value.capabilities)) {
      return value;
    }
    // JSON Wire Protocol: the id is top-level and `value` holds the capabilities themselves.
    if (wireId !== undefined) return { sessionId: wireId, capabilities: value };
  }
  return value;
}

export async function endWebDriverSession(vendor: DeviceCloudVendor, username: string, password: string, sessionId: string): Promise<void> {
  if (!CONNECTIONS[vendor].sessionId.test(sessionId)) throw new Error("invalid cloud WebDriver session id");
  try {
    await webDriverCommand(vendor, `Basic ${btoa(`${username}:${password}`)}`, "session end", "DELETE", `/session/${sessionId}`, undefined);
  } catch (error) {
    if (error instanceof WebDriverError && (error.status === 404 || error.code === "invalid session id")) return;
    throw error;
  }
}

/** Logged evaluation failures contain only a closed error name, never a page-state message. */
export function pageEvaluationScript(expression: string): string {
  return `const done = arguments[arguments.length - 1];
    Promise.resolve().then(() => (${expression})).then(
      value => done({ ok: true, value }),
      error => done({ ok: false, error: error instanceof Error && ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "DOMException"].includes(error.name) ? error.name : "unnamed rejection" }));`;
}

export class WebDriverSession implements JourneyPage {
  readonly #authorization: string;
  private constructor(readonly vendor: DeviceCloudVendor, readonly id: string, authorization: string) {
    this.#authorization = authorization;
  }

  /** Checkpoint before the first further command; a failed checkpoint immediately ends the known session. */
  static async create(vendor: DeviceCloudVendor, username: string, password: string, capabilities: Record<string, unknown>, created: (sessionId: string) => Promise<void>): Promise<{ readonly session: WebDriverSession; readonly capabilities: Record<string, unknown> }> {
    const authorization = `Basic ${btoa(`${username}:${password}`)}`;
    const value = await webDriverCommand(vendor, authorization, "session start", "POST", "/session", { capabilities: { alwaysMatch: capabilities } }, 600_000);
    if (!isRecord(value) || typeof value.sessionId !== "string" || !CONNECTIONS[vendor].sessionId.test(value.sessionId)) throw new Error("cloud provider started no identifiable session");
    const session = new WebDriverSession(vendor, value.sessionId, authorization);
    try {
      await created(session.id);
      await session.command("timeouts", "POST", "/timeouts", { script: 90_000, pageLoad: 90_000 });
    } catch (error) {
      try { await endWebDriverSession(vendor, username, password, session.id); }
      catch { throw new AggregateError([error, new Error("identified cloud session could not be ended after setup failure")], "cloud session setup and release failed"); }
      throw error;
    }
    return { session, capabilities: isRecord(value.capabilities) ? value.capabilities : {} };
  }

  /** Also supplies TestingBot's native-iPhone adapter; it cannot change the fixed vendor endpoint. */
  command(operation: string, method: string, path: string, body?: unknown): Promise<unknown> {
    return webDriverCommand(this.vendor, this.#authorization, operation, method, `/session/${this.id}${path}`, body);
  }

  async navigate(url: string): Promise<unknown> { return this.command("navigation", "POST", "/url", { url }); }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.command("page evaluation", "POST", "/execute/async", { script: pageEvaluationScript(expression), args: [] });
    if (!isRecord(result) || result.ok !== true) {
      const name = isRecord(result) && typeof result.error === "string" && ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "DOMException", "unnamed rejection"].includes(result.error) ? result.error : "no result";
      throw new Error(`page evaluation failed: ${name}`);
    }
    return result.value as T;
  }
}
