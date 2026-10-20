/** Shared real-device credential, bounded-read, process, and non-decrypting proxy boundaries. */
import { createServer, connect, type Socket } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../packages/collab-client/upstream/src/tool-render/util.ts";
import { parseRetainedVendorJson } from "./device-cloud-record-json.ts";

export type DeviceCloudVendor = "testingbot" | "browserstack";
export interface CloudDevice { readonly name: string; readonly platform: string; readonly version: string }
export interface TestRecord {
  readonly complete: boolean;
  /** Bounded raw retained surfaces and their canonical JSON, searched only in memory. */
  readonly text: string;
  readonly video: boolean;
  readonly screenshots: number;
}

export async function boundedVendorText(response: Response, vendor: string, maximum = 2_000_000): Promise<string> {
  if (response.body === null) throw new Error(`${vendor} returned an empty response`);
  if (maximum < 1) { await response.body.cancel(); throw new Error(`${vendor} returned an oversized response`); }
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximum) {
    await response.body.cancel();
    throw new Error(`${vendor} returned an oversized response`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error(`${vendor} returned an oversized response`);
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

export function vendorJson(text: string, vendor: string): unknown {
  try { return parseRetainedVendorJson(text); }
  catch { throw new Error(`${vendor} returned invalid JSON`); }
}

export interface OpResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly failure?: string;
  readonly failureClass?: "host-fault";
}
export type OpRunner = (argv: readonly string[], environment: Readonly<Record<string, string>>) => Promise<OpResult>;

export async function runOp(argv: readonly string[], environment: Readonly<Record<string, string>>, timeoutMs = 30_000): Promise<OpResult> {
  const child = Bun.spawn([...argv], { env: { ...environment }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (timedOut) return { exitCode: exitCode || 1, stdout, failureClass: "host-fault", failure: `did not exit within ${timeoutMs / 1000} s` };
    if (exitCode === 0) return { exitCode, stdout };
    if (child.signalCode !== null) return { exitCode, stdout, failure: `terminated by ${child.signalCode}` };
    const detail = stderr.trim().split("\n")[0]!.slice(0, 200);
    return { exitCode, stdout, failure: `exited ${exitCode}${detail === "" ? "" : `: ${detail}`}` };
  } finally { clearTimeout(deadline); }
}

export function serviceAccountTokenFile(environment: Readonly<Record<string, string | undefined>>): string {
  return environment.OMP_STABLE_OP_TOKEN_FILE ?? join(homedir(), ".local", "state", "alpha-founder", "retained-host", "op-service-account.token");
}

const REFERENCES = {
  testingbot: ["op://Centaur/TestingBot/key", "op://Centaur/TestingBot/secret"],
  browserstack: ["op://Centaur/BrowserStack/username", "op://Centaur/BrowserStack/access-key"],
} as const;

/** Closed references, private token, pinned service-account identity, minimal child environment. */
export async function readCloudCredentials(tokenFile: string, vendor: DeviceCloudVendor, op: OpRunner = runOp): Promise<readonly [string, string]> {
  const metadata = await lstat(tokenFile).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600 || metadata.size < 1 || metadata.size > 8_192) {
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
  try { identity = parseRetainedVendorJson(whoami.stdout); } catch { identity = undefined; }
  const url = isRecord(identity) && typeof identity.url === "string"
    ? identity.url.trim().toLowerCase().replace(/^https:\/\//u, "").replace(/\/$/u, "") : "";
  if (url !== "my.1password.com" || !isRecord(identity) || identity.user_type !== "SERVICE_ACCOUNT") {
    throw new Error("the 1Password token is not a service account of my.1password.com");
  }
  const label = vendor === "testingbot" ? "TestingBot" : "BrowserStack";
  const read = async (reference: string): Promise<string> => {
    const result = await op(["op", "read", reference], environment);
    if (result.exitCode !== 0) throw new Error(`the ${label} credential could not be read from 1Password: op read ${result.failure ?? `exited ${result.exitCode}`}`);
    const value = result.stdout.trim();
    if (!/^[\x21-\x7e]{8,256}$/u.test(value)) throw new Error(`the ${label} credential could not be read from 1Password`);
    return value;
  };
  return [await read(REFERENCES[vendor][0]), await read(REFERENCES[vendor][1])];
}

export interface AllowlistProxy {
  readonly port: number;
  refusals(): number;
  close(): Promise<void>;
}

/** Exactly the candidate/CSP host:port set; no plain HTTP and no TLS termination. */
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
        if (head.length > 8_192) { client.off("data", onData); refuse(); }
        return;
      }
      client.off("data", onData);
      const target = /^CONNECT ([A-Za-z0-9.-]{1,253}):([0-9]{1,5}) HTTP\/1\.[01]\r\n/u.exec(head.toString("latin1", 0, end + 2));
      const host = target?.[1]?.toLowerCase();
      const port = Number(target?.[2]);
      if (host === undefined || !Object.hasOwn(permitted, `${host}:${port}`)) { refuse(); return; }
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
      for (const socket of open) socket.destroy();
      await closed.promise;
    },
  };
}

export interface ProcessEntry { readonly pid: number; readonly command: string }
export function requireLoopbackListeners(addresses: readonly string[], vendor: DeviceCloudVendor): void {
  const exposed = addresses.filter(address => !/^(?:127\.0\.0\.1|\[::1\]):[0-9]+$/u.test(address));
  if (exposed.length > 0) throw new Error(`${vendor} tunnel listens beyond loopback on ${exposed.length} sockets`);
}

export async function listProcesses(): Promise<readonly ProcessEntry[]> {
  const child = Bun.spawn(["ps", "-axww", "-o", "pid=,command="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error("could not list cloud tunnel processes");
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
  });
}

export async function listeningAddresses(pid: number): Promise<readonly string[]> {
  const child = Bun.spawn(["lsof", "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-F", "n"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [listing, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0 && exitCode !== 1) throw new Error("could not list cloud tunnel sockets");
  return listing.split("\n").flatMap(line => line.startsWith("n") ? [line.slice(1)] : []);
}
