import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TestingBotApi,
  readTestingBotCredentials,
  startTunnel,
  stopTunnel,
} from "./testingbot.ts";
import { runOp, startAllowlistProxy, type OpRunner, type ProcessEntry } from "./device-cloud-common.ts";
import { WebDriverSession, pageEvaluationScript } from "./device-cloud-webdriver.ts";

// Built at runtime so no token-shaped literal sits in the repository.
const TOKEN = `ops_${"SYNTHETICserviceAccount".repeat(3)}`;
const KEY = "synthetic-testingbot-key-7c1f";
const SECRET = "synthetic-testingbot-secret-2e9a";

interface OpCall {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

function opFixture(whoami: Record<string, unknown>): { readonly calls: OpCall[]; readonly op: OpRunner } {
  const calls: OpCall[] = [];
  const op: OpRunner = async (argv, environment) => {
    calls.push({ argv, environment });
    if (argv[1] === "whoami") return { exitCode: 0, stdout: JSON.stringify(whoami) };
    if (argv.at(-1) === "op://Centaur/TestingBot/key") return { exitCode: 0, stdout: `${KEY}\n` };
    if (argv.at(-1) === "op://Centaur/TestingBot/secret") return { exitCode: 0, stdout: `${SECRET}\n` };
    return { exitCode: 1, stdout: "" };
  };
  return { calls, op };
}

const SERVICE_ACCOUNT = { url: "https://my.1password.com/", user_type: "SERVICE_ACCOUNT" };

test("failed identified-session checkpoint ends the session before any browser command", async () => {
  const calls: string[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, options?: RequestInit) => {
    calls.push(`${options?.method} ${new URL(String(url)).pathname}`);
    return Response.json({ value: options?.method === "DELETE" ? null : { sessionId: "session-checkpoint-0001", capabilities: {} } });
  }, { preconnect: () => {} }));
  try {
    await expect(WebDriverSession.create("testingbot", KEY, SECRET, {}, async () => { throw new Error("checkpoint failed"); })).rejects.toThrow("checkpoint failed");
    expect(calls).toEqual(["POST /wd/hub/session", "DELETE /wd/hub/session/session-checkpoint-0001"]);
  } finally { mock.mockRestore(); }
});

test("oversized retained records fail without truncation or reflected content", async () => {
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response("SYNTHETIC-RECORD-CONTENT".repeat(100_000)), { preconnect: () => {} }));
  try {
    await expect(new TestingBotApi({ key: KEY, secret: SECRET }).testRecord("session-record-0001")).rejects.toThrow("oversized response");
  } finally { mock.mockRestore(); }
});

describe("TestingBot retained audit surfaces", () => {
  const sessionId = "session-surfaces-0001";
  const logUrl = "https://s3-eu-west-1.amazonaws.com/eulogtestingbot/synthetic-session.log";
  const record = { state: "COMPLETE", assets_available: true, steps: "session creation", logs: {}, video: false, thumbs: [] };
  const assets = { session_id: sessionId, logs: {}, video: null, screenshots: [], har: null, performance: null };
  const needle = "SYNTHETIC-RAW-SURFACE-7e2c";

  test.each(["record", "assets", "log"] as const)("rejects duplicate object keys in the %s retained surface", async surface => {
    const duplicate = `"earlier":"${needle}","earlier":"clean"`;
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, options?: RequestInit) => {
      const target = String(url);
      if (target === logUrl) {
        expect(options?.headers).toBeUndefined();
        expect(options?.redirect).toBe("error");
        return new Response(`{${duplicate}}`);
      }
      if (target.endsWith("/assets")) {
        if (surface === "assets") {
          return new Response(JSON.stringify(assets).replace('"logs":{}', `"logs":{"appium":"${logUrl}","appium":"${logUrl}?clean"}`));
        }
        const value = { ...assets, logs: surface === "log" ? { appium: logUrl } : {} };
        return Response.json(value);
      }
      if (target === `${logUrl}?clean`) return Response.json({ step: "clean" });
      return surface === "record"
        ? new Response(JSON.stringify(record).replace('"logs":{}', `"logs":{"appium":"${logUrl}"},"logs":{}`))
        : Response.json(record);
    }, { preconnect: () => {} }));
    try {
      await expect(new TestingBotApi({ key: KEY, secret: SECRET }).testRecord(sessionId)).rejects.toThrow("duplicate");
    } finally { mock.mockRestore(); }
  });

  test("canonicalizes escaped JSON log values as well as auditing their raw bytes", async () => {
    const encoded = [...needle].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL) =>
      String(url) === logUrl ? new Response(`{"step":"${encoded}"}`) :
        Response.json(String(url).endsWith("/assets") ? { ...assets, logs: { appium: logUrl } } : record),
    { preconnect: () => {} }));
    try {
      expect((await new TestingBotApi({ key: KEY, secret: SECRET }).testRecord(sessionId))?.text).toContain(needle);
    } finally { mock.mockRestore(); }
  });

  test("keeps ordinary plaintext logs raw-only without parsing references from them", async () => {
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL) =>
      String(url) === logUrl ? new Response(`INFO: ${needle}`, { headers: { "content-type": "text/plain" } }) :
        Response.json(String(url).endsWith("/assets") ? { ...assets, logs: { appium: logUrl } } : record),
    { preconnect: () => {} }));
    try {
      expect((await new TestingBotApi({ key: KEY, secret: SECRET }).testRecord(sessionId))?.text).toContain(needle);
    } finally { mock.mockRestore(); }
  });

  test("rejects invalid JSON when the retained log declares a JSON content type", async () => {
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL) =>
      String(url) === logUrl ? new Response("not JSON", { headers: { "content-type": "application/json" } }) :
        Response.json(String(url).endsWith("/assets") ? { ...assets, logs: { appium: logUrl } } : record),
    { preconnect: () => {} }));
    try {
      await expect(new TestingBotApi({ key: KEY, secret: SECRET }).testRecord(sessionId)).rejects.toThrow("invalid retained vendor JSON");
    } finally { mock.mockRestore(); }
  });

  test.each(["missing inventory", "missing log", "unreviewed log origin", "unknown inventory"] as const)("refuses %s instead of claiming a complete audit", async failure => {
    const calls: string[] = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/assets")) {
        if (failure === "missing inventory") return new Response(null, { status: 404 });
        if (failure === "unknown inventory") return Response.json({ ...assets, logs: null });
        return Response.json({ ...assets, logs: { appium: failure === "unreviewed log origin" ? "https://unreviewed.invalid/log" : logUrl } });
      }
      if (target === logUrl) return new Response(null, { status: 404 });
      return Response.json(record);
    }, { preconnect: () => {} }));
    try {
      await expect(new TestingBotApi({ key: KEY, secret: SECRET }).testRecord(sessionId)).rejects.toThrow();
      expect(calls.some(url => url.startsWith("https://unreviewed.invalid"))).toBe(false);
    } finally { mock.mockRestore(); }
  });

  test("bounds aggregate retained bytes rather than permitting the limit again per log", async () => {
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL) =>
      String(url) === logUrl ? new Response("x".repeat(1_100_000)) :
        Response.json(String(url).endsWith("/assets") ? { ...assets, logs: { appium: logUrl } } : { ...record, steps: "x".repeat(1_100_000) }),
    { preconnect: () => {} }));
    try {
      await expect(new TestingBotApi({ key: KEY, secret: SECRET }).testRecord(sessionId)).rejects.toThrow("oversized response");
    } finally { mock.mockRestore(); }
  });

  test("refuses excessive declared surfaces before reading any log", async () => {
    let reads = 0;
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL) => {
      reads += 1;
      return Response.json(String(url).endsWith("/assets") ?
        { ...assets, logs: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`log${index}`, `${logUrl}?part=${index}`])) } : record);
    }, { preconnect: () => {} }));
    try {
      await expect(new TestingBotApi({ key: KEY, secret: SECRET }).testRecord(sessionId)).rejects.toThrow("surface bound");
      expect(reads).toBe(2);
    } finally { mock.mockRestore(); }
  });
});

describe("TestingBot credentials through the 1Password service account", () => {
  let root: string;
  let tokenFile: string;
  let ambientAccount: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "testingbot-op-"));
    tokenFile = join(root, "op-service-account.token");
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    ambientAccount = process.env.OP_ACCOUNT;
    process.env.OP_ACCOUNT = "personal.1password.example";
  });

  afterEach(async () => {
    if (ambientAccount === undefined) delete process.env.OP_ACCOUNT;
    else process.env.OP_ACCOUNT = ambientAccount;
    await rm(root, { recursive: true, force: true });
  });

  test("reads both fields with the token in the child environment only, no account selection", async () => {
    const { calls, op } = opFixture(SERVICE_ACCOUNT);
    expect(await readTestingBotCredentials(tokenFile, op)).toEqual({ key: KEY, secret: SECRET });
    expect(calls.map(call => call.argv.join(" "))).toEqual([
      "op whoami --format json",
      "op read op://Centaur/TestingBot/key",
      "op read op://Centaur/TestingBot/secret",
    ]);
    for (const call of calls) {
      expect(call.environment.OP_SERVICE_ACCOUNT_TOKEN).toBe(TOKEN);
      expect(Object.keys(call.environment).sort()).toEqual(["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"]);
      expect(call.argv.join(" ")).not.toContain(TOKEN);
    }
  });

  test.each([
    ["a group-readable file", async (path: string) => chmod(path, 0o640)],
    ["a symlink", async (path: string) => {
      const target = `${path}.target`;
      await writeFile(target, `${TOKEN}\n`, { mode: 0o600 });
      await rm(path);
      await symlink(target, path);
    }],
    ["a malformed token", async (path: string) => writeFile(path, "not-a-service-account-token\n", { mode: 0o600 })],
  ])("refuses %s before running op", async (_name, corrupt) => {
    await corrupt(tokenFile);
    const { calls, op } = opFixture(SERVICE_ACCOUNT);
    await expect(readTestingBotCredentials(tokenFile, op)).rejects.toThrow("service-account token");
    expect(calls).toEqual([]);
  });

  test.each([
    ["a user account", { url: "https://my.1password.com", user_type: "HUMAN" }],
    ["another 1Password account", { url: "https://other.1password.com", user_type: "SERVICE_ACCOUNT" }],
  ])("refuses %s before reading any item", async (_name, whoami) => {
    const { calls, op } = opFixture(whoami);
    await expect(readTestingBotCredentials(tokenFile, op)).rejects.toThrow("not a service account of my.1password.com");
    expect(calls.map(call => call.argv[1])).toEqual(["whoami"]);
  });

  describe("an op that fails is reported as op failing, not as a wrong account", () => {
    let originalPath: string | undefined;
    async function fakeOp(body: string): Promise<void> {
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "op"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      process.env.PATH = `${bin}:${originalPath}`;
    }
    beforeEach(() => { originalPath = process.env.PATH; });
    afterEach(() => { process.env.PATH = originalPath; });

    test("an op that exits non-zero names its status and first stderr line", async () => {
      await fakeOp('echo "[ERROR] synthetic: invalid service account token" >&2\nexit 1');
      const failure = await readTestingBotCredentials(tokenFile).catch((error: unknown) => String(error));
      expect(failure).toContain("op whoami exited 1: [ERROR] synthetic: invalid service account token");
      expect(failure).not.toContain("not a service account");
      expect(failure).not.toContain("host-fault");
    });

    test("a timed-out identity probe reports a host fault and the installed-path recovery", async () => {
      await fakeOp("trap '' TERM\nexec sleep 10");
      const failure = await readTestingBotCredentials(tokenFile, (argv, environment) => runOp(argv, environment, 200)).catch((error: unknown) => String(error));
      expect(failure).toContain("op whoami did not exit within 0.2 s");
      expect(failure).not.toContain("not a service account");
      expect(failure).toContain("host-fault");
      expect(failure).toContain("hardlink");
      expect(failure).toContain("brew reinstall --cask 1password-cli");
      expect(failure).not.toContain(TOKEN);
    });

    test("an externally signalled identity probe is not misreported as an exec timeout", async () => {
      await fakeOp("kill -TERM $$");
      const failure = await readTestingBotCredentials(tokenFile).catch((error: unknown) => String(error));
      expect(failure).toContain("terminated by SIGTERM");
      expect(failure).not.toContain("did not exit within");
      expect(failure).not.toContain("hardlink");
    });
  });
});

describe("TestingBot tunnel ownership", () => {
  const ours = "java -jar /cache/TestingBotTunnel-4.9.jar --nobump --nocache --tunnel-identifier omp-dc-1a2b3c4d --readyfile /w/ready";

  test("stops only this attempt's tunnel, escalating when it ignores SIGTERM", async () => {
    let processes: ProcessEntry[] = [
      { pid: 101, command: ours },
      { pid: 102, command: ours.replace("omp-dc-1a2b3c4d", "omp-dc-9f8e7d6c") },
      { pid: 103, command: "grep -- --tunnel-identifier omp-dc-1a2b3c4d notes" },
    ];
    const signals: string[] = [];
    const running = await stopTunnel("omp-dc-1a2b3c4d", async () => processes, (pid, name) => {
      signals.push(`${pid} ${name}`);
      if (name === "SIGKILL") processes = processes.filter(entry => entry.pid !== pid);
    }, 5);
    expect(running).toBe(1);
    expect(signals).toEqual(["101 SIGTERM", "101 SIGKILL"]);
    expect(processes.map(entry => entry.pid)).toEqual([102, 103]);
  });

  test("fails when the tunnel outlives SIGKILL", async () => {
    await expect(stopTunnel("omp-dc-1a2b3c4d", async () => [{ pid: 101, command: ours }], () => {}, 5)).rejects.toThrow("outlived SIGKILL");
  });

  describe("with a stand-in tunnel process", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "testingbot-tunnel-"));
      // Listens where told and touches its ready file; the open listener keeps it alive until stopped.
      await writeFile(join(root, "stand-in.ts"), [
        "const args = process.argv.slice(3);",
        'const ready = args[args.indexOf("--readyfile") + 1];',
        "Bun.listen({ hostname: process.argv[2], port: 0, socket: { data() {} } });",
        'await Bun.write(ready, "ready");',
      ].join("\n"));
      for (const [name, host] of [["java-exposed", "0.0.0.0"], ["java-loopback", "127.0.0.1"]] as const) {
        await writeFile(join(root, name), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "stand-in.ts")}" ${host} "$@"\n`, { mode: 0o700 });
      }
    });

    afterEach(async () => {
      await stopTunnel("omp-dc-0000feed").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    const options = (java: string) => ({
      java: join(root, java), jar: join(root, "TestingBotTunnel-standin.jar"), directory: join(root, "work"),
      identifier: "omp-dc-0000feed", localProxyPort: 9,
    });
    const credentials = { key: KEY, secret: SECRET };

    test("refuses a tunnel that listens beyond loopback and leaves it stopped", async () => {
      await expect(startTunnel(options("java-exposed"), credentials, 20_000)).rejects.toThrow("listens beyond loopback");
      expect(await stopTunnel("omp-dc-0000feed")).toBe(0);
    });

    test("accepts a tunnel that listens on loopback only", async () => {
      await startTunnel(options("java-loopback"), credentials, 20_000);
      expect(await stopTunnel("omp-dc-0000feed")).toBe(1);
    });
  });
});

describe("page evaluation", () => {
  const LINK = "omp-synthetic://relay/SYNTHETIC-EVAL-ROOM-5d2c/SYNTHETIC-EVAL-KEY-8e1b4f7a";

  async function evaluate(expression: string): Promise<unknown> {
    const done = Promise.withResolvers<unknown>();
    new Function(pageEvaluationScript(expression))(done.resolve);
    return done.promise;
  }

  test("returns the expression's value", async () => {
    expect(await evaluate("({ passed: true, count: 2 })")).toEqual({ ok: true, value: { passed: true, count: 2 } });
  });

  test.each([
    ["an Error whose message quotes a link", `(() => { throw new TypeError("could not open ${LINK}"); })()`, "TypeError"],
    ["a rejected string", `Promise.reject("${LINK}")`, "unnamed rejection"],
    ["an Error with a crafted name", `(() => { const error = new Error("x"); error.name = "${LINK}"; throw error; })()`, "unnamed rejection"],
    ["an all-letter crafted error name", `(() => { const error = new Error("x"); error.name = "SyntheticSecretWindow"; throw error; })()`, "unnamed rejection"],
  ])("reports only the kind of %s", async (_name, expression, reported) => {
    const result = await evaluate(expression);
    expect(result).toEqual({ ok: false, error: reported });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-EVAL");
  });
});

describe("the tunnel's allowlisting proxy", () => {
  let upstream: Server;
  let upstreamPort: number;
  let accepted: number;

  beforeEach(async () => {
    accepted = 0;
    upstream = createServer(socket => {
      accepted += 1;
      socket.pipe(socket);
    });
    const listening = Promise.withResolvers<void>();
    upstream.listen(0, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("the upstream fixture did not bind a port");
    upstreamPort = address.port;
  });

  afterEach(() => {
    upstream.close();
  });

  /** Sends one proxy request, then `payload` once the tunnel opens; resolves with everything read. */
  async function exchange(port: number, request: string, payload?: string): Promise<string> {
    const socket = connect(port, "127.0.0.1");
    const done = Promise.withResolvers<string>();
    let received = "";
    socket.on("data", chunk => {
      received += chunk.toString("latin1");
      if (payload !== undefined && received.endsWith("\r\n\r\n") && received.startsWith("HTTP/1.1 200")) socket.write(payload);
      if (payload !== undefined && received.endsWith(payload)) socket.end();
    });
    socket.on("close", () => done.resolve(received));
    socket.on("error", done.reject);
    socket.write(request);
    return done.promise;
  }

  test("relays bytes only through a CONNECT to an allowed host and port", async () => {
    const proxy = await startAllowlistProxy([`127.0.0.1:${upstreamPort}`]);
    try {
      const tunneled = await exchange(proxy.port, `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`, "through-the-tunnel");
      expect(tunneled).toBe("HTTP/1.1 200 Connection Established\r\n\r\nthrough-the-tunnel");
      expect(accepted).toBe(1);
      expect(proxy.refusals()).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  test.each([
    ["another port on an allowed host", (port: number) => `CONNECT 127.0.0.1:${port + 1} HTTP/1.1\r\n\r\n`],
    ["another name for an allowed address", (port: number) => `CONNECT localhost:${port} HTTP/1.1\r\n\r\n`],
    ["plain HTTP to an allowed host", (port: number) => `GET http://127.0.0.1:${port}/api/v1/sessions HTTP/1.1\r\nTailscale-User-Login: forged@example\r\n\r\n`],
  ])("refuses %s without opening a connection", async (_name, request) => {
    const proxy = await startAllowlistProxy([`127.0.0.1:${upstreamPort}`]);
    try {
      expect(await exchange(proxy.port, request(upstreamPort))).toStartWith("HTTP/1.1 403 Forbidden");
      expect(accepted).toBe(0);
      expect(proxy.refusals()).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  test("closing tears down a relayed connection that is still open", async () => {
    const proxy = await startAllowlistProxy([`127.0.0.1:${upstreamPort}`]);
    const socket = connect(proxy.port, "127.0.0.1");
    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    socket.once("data", () => opened.resolve());
    socket.on("close", () => closed.resolve());
    socket.on("error", () => undefined);
    socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\n\r\n`);
    await opened.promise;
    await proxy.close();
    await closed.promise;
    expect(socket.destroyed).toBe(true);
  });
});
