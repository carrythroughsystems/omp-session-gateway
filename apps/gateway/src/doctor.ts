import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tailnetAddressIsLocallyBound, tailscaleTunDevicePresent } from "./tailnet.ts";
import { fileURLToPath } from "node:url";
import { parseSessionListResponse, type SessionListResponse } from "@omp-session-gateway/protocol";
import {
  type GatewayConfig,
  loadGatewayConfig,
  loadReadinessToken,
  loopbackHttpOrigin,
} from "./config.ts";
import { OmpHostReader } from "./omp-registry.ts";
import { probeTernAvailability } from "./tern-creation.ts";
import type { DoctorReport } from "./diagnostics.ts";
import { type UserServiceStatus, userServiceStatus } from "./service.ts";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_READINESS_BODY_BYTES = 512;
const NETWORK_TIMEOUT_MS = 3_000;
const DEFAULT_RELAY_HEALTH_URL = "https://my.omp.sh";
/**
 * Lowest mainline OMP release that ships the collaboration host registry this gateway reads
 * (upstream PR #11908, first tagged in `v18.1.20`). Earlier releases have `collab.autoStart` only
 * behind the retired fork, so a host on one of them can never appear in the directory.
 */
const MINIMUM_OMP_VERSION = "18.1.20";

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function objectEntries(value: unknown): [string, unknown][] {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : [];
}

async function commandJson(command: readonly string[]): Promise<unknown> {
  try {
    const subprocess = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timeout = setTimeout(() => subprocess.kill(9), 5_000);
    try {
      const reader = subprocess.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > MAX_COMMAND_OUTPUT_BYTES) {
          subprocess.kill(9);
          await reader.cancel().catch(() => undefined);
          await subprocess.exited;
          return undefined;
        }
        chunks.push(result.value);
      }
      if ((await subprocess.exited) !== 0) return undefined;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return undefined;
  }
}

async function boundedResponseJson(response: Response, limit: number): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > limit)) return undefined;
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  }
}

function normalizedServeAuthority(value: string): string | undefined {
  try {
    const url = new URL(`https://${value}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    return `${hostname}:${url.port === "" ? "443" : url.port}`;
  } catch {
    return undefined;
  }
}

function publicOriginAuthority(config: GatewayConfig): string {
  const origin = new URL(config.http.publicOrigin);
  return `${origin.hostname.toLowerCase().replace(/\.$/u, "")}:${origin.port === "" ? "443" : origin.port}`;
}

export function serveConfigurationMatches(value: unknown, config: GatewayConfig): boolean {
  const web = property(value, "Web");
  if (typeof web !== "object" || web === null || Array.isArray(web)) return false;
  const expectedAuthority = publicOriginAuthority(config);
  const expectedProxy = loopbackHttpOrigin(config.http.hostname, config.http.port);
  for (const [hostAndPort, server] of Object.entries(web)) {
    if (normalizedServeAuthority(hostAndPort) !== expectedAuthority) continue;
    const handlers = property(server, "Handlers");
    if (typeof handlers !== "object" || handlers === null || Array.isArray(handlers)) continue;
    for (const handler of Object.values(handlers)) {
      if (property(handler, "Proxy") === expectedProxy) return true;
    }
  }
  return false;
}

/**
 * The TCP destination a Serve proxy or TCP-forward target connects to, expanded as tailscaled expands it:
 * a bare port means `127.0.0.1`, and a target without a scheme means `http://`. `null` for a Unix
 * socket, which cannot reach the gateway's TCP listener; `undefined` when unparsable.
 */
function serveTarget(target: string): { hostname: string; port: number } | null | undefined {
  if (target.startsWith("unix:")) return null;
  if (/^\d+$/u.test(target)) { const port = Number(target); return port > 0 && port <= 65535 ? { hostname: "127.0.0.1", port } : undefined; }
  const insecure = "https+insecure://";
  const url = target.startsWith(insecure)
    ? `https://${target.slice(insecure.length)}`
    : target.startsWith("http://") || target.startsWith("https://")
      ? target
      : `http://${target}`;
  try {
    const parsed = new URL(url);
    return { hostname: parsed.hostname, port: parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80 };
  } catch {
    return undefined;
  }
}

/** Match the listener host as well as its port; unparsable relevant targets fail closed. */
function targetReachesGateway(target: unknown, config: GatewayConfig): boolean {
  if (typeof target !== "string") return true;
  const destination = serveTarget(target);
  if (destination === undefined) return true;
  if (destination === null || destination.port !== config.http.port) return false;
  const normalize = (host: string) => host.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  const host = normalize(destination.hostname), bind = normalize(config.http.hostname);
  const loopback = (host: string) => host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  return host === bind || (loopback(host) && loopback(bind)) || bind === "0.0.0.0" || bind === "::";
}

function authorityReachesGateway(scope: unknown, authority: string, config: GatewayConfig): boolean {
  const tcpPort = authority.slice(authority.lastIndexOf(":") + 1);
  const isObject = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
  const tcp = property(scope, "TCP"), web = property(scope, "Web");
  if ((tcp !== undefined && !isObject(tcp)) || (web !== undefined && !isObject(web))) return true;
  const listener = property(tcp, tcpPort);
  if (listener !== undefined && !isObject(listener)) return true;
  const forward = property(listener, "TCPForward");
  if (forward !== undefined && targetReachesGateway(forward, config)) return true;
  return objectEntries(web).some(([hostPort, server]) => {
    if (normalizedServeAuthority(hostPort) !== authority) return false;
    const handlers = property(server, "Handlers");
    if (!isObject(handlers)) return true;
    return objectEntries(handlers).some(([, handler]) => {
      if (!isObject(handler)) return true;
      const proxy = property(handler, "Proxy");
      return proxy !== undefined ? targetReachesGateway(proxy, config)
        : typeof property(handler, "Path") !== "string" && typeof property(handler, "Text") !== "string";
    });
  });
}

/**
 * Funnel publishes a Serve authority to the Internet, so none may reach the gateway: Funnel may be
 * enabled neither for the gateway's own Serve authority nor for an authority whose handler proxies
 * or forwards to the gateway's listener host and port. tailscaled merges foreground `tailscale funnel`
 * sessions with the persistent configuration, so every scope is checked against every other. A
 * Funnel that publishes another local service passes; an entry that cannot be parsed fails.
 */
export function funnelConfigurationDisabled(value: unknown, config: GatewayConfig): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const foreground = property(value, "Foreground");
  if (foreground !== undefined && foreground !== null && (typeof foreground !== "object" || Array.isArray(foreground))) return false;
  if (objectEntries(foreground).some(([, scope]) => typeof scope !== "object" || scope === null || Array.isArray(scope))) return false;
  const gatewayAuthority = publicOriginAuthority(config);
  const scopes = [value, ...objectEntries(property(value, "Foreground")).map(([, session]) => session)];
  for (const scope of scopes) {
    const allowFunnel = property(scope, "AllowFunnel");
    if (allowFunnel === undefined || allowFunnel === null) continue;
    if (typeof allowFunnel !== "object" || Array.isArray(allowFunnel)) return false;
    for (const [hostPort, enabled] of Object.entries(allowFunnel)) {
      if (enabled === false) continue;
      if (enabled !== true) return false;
      const authority = normalizedServeAuthority(hostPort);
      if (authority === undefined || authority === gatewayAuthority) return false;
      if (scopes.some(source => authorityReachesGateway(source, authority, config))) return false;
    }
  }
  return true;
}

export function tailscaleSelfIp(value: unknown): string | undefined {
  const addresses = property(property(value, "Self"), "TailscaleIPs");
  if (!Array.isArray(addresses)) return undefined;
  return (
    addresses.find(address => typeof address === "string" && isIP(address) === 4) ??
    addresses.find(address => typeof address === "string" && isIP(address) === 6)
  );
}

export async function gatewayReady(
  config: GatewayConfig,
  readinessToken: string,
  expectedInstance?: string,
): Promise<boolean> {
  try {
    const challenge = randomBytes(32).toString("base64url");
    const response = await fetch(`${loopbackHttpOrigin(config.http.hostname, config.http.port)}/api/v1/health`, {
      headers: { "X-OMP-Readiness-Challenge": challenge },
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = await boundedResponseJson(response, MAX_READINESS_BODY_BYTES);
    if (property(body, "status") !== "ready") return false;
    const instanceValue = property(body, "instance");
    if (instanceValue !== undefined && (typeof instanceValue !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(instanceValue))) {
      return false;
    }
    const instance = typeof instanceValue === "string" ? instanceValue : "";
    if (expectedInstance !== undefined && instance !== expectedInstance) return false;
    const proof = property(body, "proof");
    if (typeof proof !== "string") return false;
    const supplied = Buffer.from(proof);
    const current = Buffer.from(
      createHmac("sha256", readinessToken).update(challenge).update("\0").update(instance).digest("base64url"),
    );
    if (current.length === supplied.length && timingSafeEqual(current, supplied)) return true;
    if (instance !== "" || expectedInstance !== undefined) return false;
    const legacy = Buffer.from(createHmac("sha256", readinessToken).update(challenge).digest("base64url"));
    return legacy.length === supplied.length && timingSafeEqual(legacy, supplied);
  } catch {
    return false;
  }
}

export async function loopbackHttpResponds(config: GatewayConfig): Promise<boolean> {
  try {
    const challenge = randomBytes(32).toString("base64url");
    const response = await fetch(`${loopbackHttpOrigin(config.http.hostname, config.http.port)}/api/v1/health`, {
      headers: { "X-OMP-Readiness-Challenge": challenge },
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function publicResponse(
  config: GatewayConfig,
  path: string,
  tailscaleIp?: string,
): Promise<Response | undefined> {
  const intended = new URL(path, config.http.publicOrigin);
  try {
    return await fetch(intended, {
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    if (tailscaleIp === undefined) return undefined;
  }

  const direct = new URL(intended);
  direct.hostname = isIP(tailscaleIp) === 6 ? `[${tailscaleIp}]` : tailscaleIp;
  try {
    return await fetch(direct, {
      headers: { Host: intended.host },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      cache: "no-store",
      tls: { serverName: intended.hostname },
    });
  } catch {
    return undefined;
  }
}

async function publicSessions(config: GatewayConfig, tailscaleIp?: string): Promise<SessionListResponse | undefined> {
  const response = await publicResponse(config, "/api/v1/sessions", tailscaleIp);
  if (response === undefined) return undefined;
  try {
    const cacheDirectives = response.headers
      .get("Cache-Control")
      ?.split(",")
      .map(value => value.trim().toLowerCase());
    if (!response.ok || cacheDirectives?.includes("no-store") !== true) return undefined;
    return parseSessionListResponse(await response.json());
  } catch {
    return undefined;
  }
}

async function publicAsset(config: GatewayConfig, path: string, tailscaleIp?: string): Promise<Response | undefined> {
  return await publicResponse(config, path, tailscaleIp);
}

async function localAssetsPresent(): Promise<boolean> {
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  try {
    await Promise.all([
      access(`${webRoot}index.html`),
      access(`${webRoot}manifest.webmanifest`),
      access(`${webRoot}service-worker.js`),
    ]);
    const index = await readFile(`${webRoot}index.html`, "utf8");
    return index.includes("manifest.webmanifest");
  } catch {
    return false;
  }
}

/** Compares dotted release numbers; anything unparseable counts as older. */
function versionAtLeast(observed: string, minimum: string): boolean {
  const parse = (value: string): number[] => {
    const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
    return match === null ? [] : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(observed);
  const right = parse(minimum);
  if (left.length !== 3 || right.length !== 3) return false;
  for (let index = 0; index < 3; index += 1) {
    const observedPart = left[index] ?? 0;
    const minimumPart = right[index] ?? 0;
    if (observedPart !== minimumPart) return observedPart > minimumPart;
  }
  return true;
}

/** Reads the version banner of the OMP on PATH. Absent means no usable `omp` was reachable. */
async function installedOmpVersion(): Promise<string | undefined> {
  try {
    const probe = Bun.spawn(["omp", "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [output] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
    return probe.exitCode === 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Confirms the OMP on PATH is mainline and recent enough to publish into the discovery directory.
 * This replaces the retired patched-tree assertion: there is no fork to verify any more, and the
 * only compatibility fact that still decides whether a session can ever appear is the release.
 */
async function ompVersionSupported(probe: () => Promise<string | undefined>): Promise<boolean> {
  const version = await probe();
  if (version === undefined) return false;
  return versionAtLeast(version.trim().replace(/^omp\//u, ""), MINIMUM_OMP_VERSION);
}

async function relayReachable(): Promise<boolean> {
  try {
    const response = await fetch(DEFAULT_RELAY_HEALTH_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      redirect: "manual",
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runDoctorChecks(
  options: {
    /**
     * Whether Tailscale's tunnel device is present. Injectable for the same reason
     * `createHttpHandler` takes it: the real probe reads this host's interface table, so a test that
     * used it would assert whatever the machine running it happens to be, and the unsafe topology —
     * the one case worth pinning — could not be expressed on a developer workstation at all.
     */
    readonly tunDevicePresent?: () => boolean;
    /**
     * Reads the installed OMP version banner. Injectable for the same reason as the tunnel probe:
     * the real one measures whatever `omp` this machine happens to have on PATH, so the supported
     * and unsupported releases — the two cases worth pinning — are otherwise untestable.
     */
    readonly ompVersion?: () => Promise<string | undefined>;
    /**
     * Reads the service manager's view of the gateway. Injectable for the same reason as the probes
     * above: the real one queries whatever service manager this machine runs.
     */
    readonly serviceStatus?: (config: GatewayConfig) => Promise<UserServiceStatus>;
    readonly ternAvailable?: (config: GatewayConfig) => Promise<boolean>;
  } = {},
): Promise<DoctorReport> {
  const checks: Record<string, boolean> = {
    config: false,
    permissions: false,
    daemon: false,
    listenerLoopbackOnly: false,
    loopbackTrustSound: false,
    serviceInstalled: false,
    serviceActive: false,
    tailscaleConnected: false,
    serveMapping: false,
    funnelDisabled: false,
    identityAllowed: false,
    assets: false,
    pwa: false,
    securityHeaders: false,
    relay: false,
    discoveryReadable: false,
    sessionHealth: false,
    compatibility: false,
  };

  let config: GatewayConfig;
  try {
    config = await loadGatewayConfig();
    checks.config = true;
  } catch {
    return { service: "omp-session-gateway", checks };
  }

  if (config.tern !== undefined) {
    try { checks.ternAvailable = await (options.ternAvailable ?? probeTernAvailability)(config); }
    catch { checks.ternAvailable = false; }
  }
  checks.assets = await localAssetsPresent();
  checks.compatibility = await ompVersionSupported(options.ompVersion ?? installedOmpVersion);
  let readinessToken: string | undefined;
  try {
    readinessToken = await loadReadinessToken(config);
    checks.permissions = true;
  } catch {
    checks.permissions = false;
  }
  checks.daemon = readinessToken !== undefined && (await gatewayReady(config, readinessToken));
  checks.listenerLoopbackOnly = checks.daemon && ["127.0.0.1", "::1"].includes(config.http.hostname);
  // The gateway owns no endpoint now; what must stay sound is its read access to OMP's own
  // discovery directory. A symlinked or foreign-owned directory is a real permissions finding.
  checks.discoveryReadable = await new OmpHostReader({
    directory: config.omp.discoveryDir,
    timeoutMs: config.omp.queryTimeoutMs,
  }).directoryUsable();
  if (!checks.discoveryReadable) checks.permissions = false;

  // A service manager that cannot be read fails both service checks without costing the rest of the report.
  try {
    const service = await (options.serviceStatus ?? userServiceStatus)(config);
    checks.serviceInstalled = service.installed;
    checks.serviceActive = service.active;
  } catch {
    checks.serviceInstalled = false;
    checks.serviceActive = false;
  }
  checks.relay = await relayReachable();
  const funnel = await commandJson(["tailscale", "funnel", "status", "--json"]);
  checks.funnelDisabled = funnel !== undefined && funnelConfigurationDisabled(funnel, config);

  if (config.auth.mode === "dev-localhost") {
    checks.tailscaleConnected = true;
    checks.serveMapping = true;
    checks.identityAllowed = true;
    // No identity header is believed in this mode, so there is no loopback trust to be unsound.
    checks.loopbackTrustSound = true;
    const [sessions, root, manifest, worker] = await Promise.all([
      publicSessions(config),
      publicAsset(config, "/"),
      publicAsset(config, "/manifest.webmanifest"),
      publicAsset(config, "/service-worker.js"),
    ]);
    checks.sessionHealth =
      sessions !== undefined && sessions.sessions.every(session => Number.isFinite(Date.parse(session.lastSeenAt)));
    checks.pwa = root?.ok === true && manifest?.ok === true && worker?.ok === true;
    checks.securityHeaders = root?.headers.get("Content-Security-Policy")?.includes("default-src 'self'") === true;
    return { service: "omp-session-gateway", checks };
  }

  const [status, serve] = await Promise.all([
    commandJson(["tailscale", "status", "--json"]),
    commandJson(["tailscale", "serve", "status", "--json"]),
  ]);
  const tailscaleIp = tailscaleSelfIp(status);
  const [sessions, root, manifest, worker] = await Promise.all([
    publicSessions(config, tailscaleIp),
    publicAsset(config, "/", tailscaleIp),
    publicAsset(config, "/manifest.webmanifest", tailscaleIp),
    publicAsset(config, "/service-worker.js", tailscaleIp),
  ]);
  checks.tailscaleConnected = property(status, "BackendState") === "Running";
  // The bind address is necessary but not sufficient. Userspace-mode tailscaled forwards inbound
  // tailnet connections to localhost, so the listener is remotely reachable and the caller arrives as
  // a loopback peer whose identity header would be believed. Report that as its own finding, and
  // withhold the loopback claim, whenever no TUN device owns our tailnet address. See #98.
  //
  // Reported from the interface table rather than from the configuration: a config that declares
  // `auth.trustIdentityWithoutTailnetDevice` asserts trust, it does not establish it, so a host that
  // sets the flag while running userspace mode must still fail here.
  const tunDevicePresent = options.tunDevicePresent ?? (() => tailscaleTunDevicePresent());
  checks.loopbackTrustSound = tunDevicePresent();
  if (checks.tailscaleConnected && !checks.loopbackTrustSound) {
    // A loopback bind address cannot be claimed while a netstack forwarder can reach it.
    checks.listenerLoopbackOnly = false;
  }
  if (checks.tailscaleConnected && !tailnetAddressIsLocallyBound(tailscaleIp)) {
    checks.listenerLoopbackOnly = false;
  }
  checks.serveMapping = serveConfigurationMatches(serve, config);
  checks.identityAllowed = sessions !== undefined;
  checks.sessionHealth =
    sessions !== undefined && sessions.sessions.every(session => Number.isFinite(Date.parse(session.lastSeenAt)));
  checks.pwa = root?.ok === true && manifest?.ok === true && worker?.ok === true;
  checks.securityHeaders = root?.headers.get("Content-Security-Policy")?.includes("default-src 'self'") === true;
  return { service: "omp-session-gateway", checks };
}
