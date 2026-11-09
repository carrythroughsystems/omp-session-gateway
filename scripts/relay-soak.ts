import { appendFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseLaunchResponse, parseSessionListResponse } from "../packages/protocol/src/index.ts";

const DEFAULT_DURATION_SECONDS = 8 * 60 * 60;
const MAX_DURATION_SECONDS = 24 * 60 * 60;
const READY_TIMEOUT_MILLISECONDS = 30_000;
const HEALTH_CHECK_INTERVAL_MILLISECONDS = 10_000;
const GATEWAY_SAMPLE_INTERVAL_MILLISECONDS = 60_000;

export interface RelaySoakConfig {
  readonly gatewayOrigin: string;
  readonly publicOrigin: string;
  readonly tailscaleLogin: string;
  readonly durationSeconds: number;
  readonly instanceId?: string;
  /** The gateway process to sample; without it the soak takes no gateway measurement. */
  readonly gatewayPid?: number;
  /** Absolute path of a new CSV that receives every gateway sample as it is taken. */
  readonly samplesPath?: string;
}

/** One reading of the gateway process, `elapsedSeconds` after the soak window opened. */
export interface GatewayProcessSample {
  readonly elapsedSeconds: number;
  readonly rssKiB: number;
  readonly cpuSeconds: number;
}

export interface GatewayProcessSummary {
  readonly samples: number;
  readonly startRssKiB: number;
  readonly endRssKiB: number;
  readonly minRssKiB: number;
  readonly maxRssKiB: number;
  /** Least-squares resident-memory trend across every sample. */
  readonly rssSlopeKiBPerHour: number;
  /** CPU time the gateway spent inside the soak window. */
  readonly cpuSeconds: number;
}

interface RelaySoakSnapshot {
  readonly phase: string;
  readonly endedReason?: string | null;
}

interface RelaySoakClient {
  connect(): void;
  close(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RelaySoakSnapshot;
}

interface RelaySoakClientModule {
  readonly GuestClient: new (capability: string, displayName: string) => RelaySoakClient;
}

async function createRelaySoakClient(capability: string): Promise<RelaySoakClient> {
  // Static import makes every root project re-typecheck the pinned upstream subtree outside its relaxed tsconfig.
  const moduleUrl = new URL("../packages/collab-client/upstream/src/lib/client.ts", import.meta.url).href;
  const clientModule = (await import(moduleUrl)) as RelaySoakClientModule;
  if (typeof clientModule.GuestClient !== "function") throw new Error("pinned collaboration client is unavailable");
  return new clientModule.GuestClient(capability, "gateway-relay-soak");
}

function requireOrigin(value: string, label: string): URL {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return url;
}

function requireLoopbackGatewayOrigin(value: string): string {
  const url = requireOrigin(value, "OMP_GATEWAY_SOAK_GATEWAY_ORIGIN");
  if (url.protocol !== "http:") throw new Error("OMP_GATEWAY_SOAK_GATEWAY_ORIGIN must use loopback HTTP");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new Error("OMP_GATEWAY_SOAK_GATEWAY_ORIGIN must be a numeric loopback origin");
  }
  return url.origin;
}

function requirePublicOrigin(value: string | undefined): string {
  if (value === undefined) throw new Error("OMP_GATEWAY_SOAK_PUBLIC_ORIGIN is required");
  const url = requireOrigin(value, "OMP_GATEWAY_SOAK_PUBLIC_ORIGIN");
  if (url.protocol !== "https:") throw new Error("OMP_GATEWAY_SOAK_PUBLIC_ORIGIN must use HTTPS");
  return url.origin;
}

function requireTailscaleLogin(value: string | undefined): string {
  const login = value?.trim().toLowerCase();
  if (login === undefined || login.length === 0 || login.length > 320) {
    throw new Error("OMP_GATEWAY_SOAK_TAILSCALE_LOGIN must be a non-empty login");
  }
  return login;
}

function requireDurationSeconds(value: string | undefined): number {
  const raw = value ?? String(DEFAULT_DURATION_SECONDS);
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error("OMP_GATEWAY_SOAK_SECONDS must be a positive integer");
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_DURATION_SECONDS) {
    throw new Error(`OMP_GATEWAY_SOAK_SECONDS must not exceed ${MAX_DURATION_SECONDS}`);
  }
  return seconds;
}

function requireGatewayPid(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("OMP_GATEWAY_SOAK_GATEWAY_PID must be a positive integer");
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("OMP_GATEWAY_SOAK_GATEWAY_PID must name the gateway process");
  return pid;
}

function requireSamplesPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw new Error("OMP_GATEWAY_SOAK_SAMPLES must be an absolute path");
  return value;
}

/**
 * Parses one `ps -o rss=,time=` line: resident KiB, then cumulative CPU time as
 * `[[dd-]hh:]mm:ss[.ff]` (macOS prints `mm:ss` or `m:ss.ff`, procps `[dd-]hh:mm:ss`).
 */
export function parseGatewayProcessSample(output: string): { readonly rssKiB: number; readonly cpuSeconds: number } {
  const match = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/u.exec(output);
  if (match === null) throw new Error("the gateway process sample is unreadable");
  const [, rss, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return {
    rssKiB: Number(rss),
    cpuSeconds: Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds),
  };
}

export function summarizeGatewaySamples(samples: readonly GatewayProcessSample[]): GatewayProcessSummary {
  const first = samples[0];
  const last = samples.at(-1);
  if (first === undefined || last === undefined) throw new Error("no gateway sample was taken");
  const meanSeconds = samples.reduce((sum, sample) => sum + sample.elapsedSeconds, 0) / samples.length;
  const meanRss = samples.reduce((sum, sample) => sum + sample.rssKiB, 0) / samples.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of samples) {
    covariance += (sample.elapsedSeconds - meanSeconds) * (sample.rssKiB - meanRss);
    variance += (sample.elapsedSeconds - meanSeconds) ** 2;
  }
  const rss = samples.map(sample => sample.rssKiB);
  return {
    samples: samples.length,
    startRssKiB: first.rssKiB,
    endRssKiB: last.rssKiB,
    minRssKiB: Math.min(...rss),
    maxRssKiB: Math.max(...rss),
    rssSlopeKiBPerHour: variance === 0 ? 0 : Math.round((covariance / variance) * 3_600),
    cpuSeconds: Math.round((last.cpuSeconds - first.cpuSeconds) * 100) / 100,
  };
}

async function readGatewayProcess(pid: number): Promise<{ readonly rssKiB: number; readonly cpuSeconds: number }> {
  const ps = Bun.spawn(["ps", "-o", "rss=,time=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [output, exitCode] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  if (exitCode !== 0 || output.trim() === "") throw new Error("the gateway process is not running");
  return parseGatewayProcessSample(output);
}

export function parseRelaySoakConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RelaySoakConfig {
  const instanceId = environment.OMP_GATEWAY_SOAK_INSTANCE_ID?.trim();
  if (instanceId !== undefined && (instanceId.length === 0 || instanceId.length > 128)) {
    throw new Error("OMP_GATEWAY_SOAK_INSTANCE_ID must contain 1 to 128 characters");
  }
  const gatewayPid = requireGatewayPid(environment.OMP_GATEWAY_SOAK_GATEWAY_PID);
  const samplesPath = requireSamplesPath(environment.OMP_GATEWAY_SOAK_SAMPLES);
  if (samplesPath !== undefined && gatewayPid === undefined) {
    throw new Error("OMP_GATEWAY_SOAK_SAMPLES requires OMP_GATEWAY_SOAK_GATEWAY_PID");
  }
  return {
    gatewayOrigin: requireLoopbackGatewayOrigin(
      environment.OMP_GATEWAY_SOAK_GATEWAY_ORIGIN ?? "http://127.0.0.1:4317",
    ),
    publicOrigin: requirePublicOrigin(environment.OMP_GATEWAY_SOAK_PUBLIC_ORIGIN),
    tailscaleLogin: requireTailscaleLogin(environment.OMP_GATEWAY_SOAK_TAILSCALE_LOGIN),
    durationSeconds: requireDurationSeconds(environment.OMP_GATEWAY_SOAK_SECONDS),
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(gatewayPid === undefined ? {} : { gatewayPid }),
    ...(samplesPath === undefined ? {} : { samplesPath }),
  };
}

function assertNoStore(response: Response): void {
  const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
  if (!cacheControl.split(",").some(directive => directive.trim() === "no-store")) {
    throw new Error(`gateway response ${response.status} did not include Cache-Control: no-store`);
  }
}

export async function runRelaySoak(config: RelaySoakConfig): Promise<void> {
  // Sample only the process the operator names: a loopback origin may be a tunnel (the stable lane's
  // SSH forward) whose listener is not the gateway. Prove it can be sampled, and claim the samples
  // file, before a capability exists.
  const gatewayPid = config.gatewayPid;
  if (gatewayPid !== undefined) await readGatewayProcess(gatewayPid);
  if (config.samplesPath !== undefined) {
    await writeFile(config.samplesPath, "elapsed_s,rss_kib,cpu_s\n", { flag: "wx", mode: 0o600 });
  }

  const publicHost = new URL(config.publicOrigin).host;
  const listResponse = await fetch(`${config.gatewayOrigin}/api/v1/sessions`, {
    headers: { "Tailscale-User-Login": config.tailscaleLogin, Host: publicHost },
    cache: "no-store",
  });
  assertNoStore(listResponse);
  if (!listResponse.ok) throw new Error(`session list failed with status ${listResponse.status}`);
  const list = parseSessionListResponse(await listResponse.json());
  const session = list.sessions.find(candidate => {
    if (!candidate.canView) return false;
    return config.instanceId === undefined || candidate.instanceId === config.instanceId;
  });
  if (session === undefined) throw new Error("no matching view-capable live session");

  const launchResponse = await fetch(
    `${config.gatewayOrigin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tailscale-User-Login": config.tailscaleLogin,
        Host: publicHost,
        Origin: config.publicOrigin,
      },
      body: JSON.stringify({ mode: "view", generation: session.generation }),
    },
  );
  assertNoStore(launchResponse);
  if (!launchResponse.ok) throw new Error(`launch failed with status ${launchResponse.status}`);
  let capability = parseLaunchResponse(await launchResponse.json()).capability;
  const client = await createRelaySoakClient(capability);
  capability = "";

  let liveObserved = false;
  let endedReason: string | null = null;
  let transitions = 0;
  let previousPhase = client.getSnapshot().phase;
  const unsubscribe = client.subscribe(() => {
    const snapshot = client.getSnapshot();
    if (snapshot.phase !== previousPhase) {
      transitions += 1;
      previousPhase = snapshot.phase;
    }
    if (snapshot.phase === "live") liveObserved = true;
    if (snapshot.phase === "ended") endedReason = snapshot.endedReason ?? "ended";
  });

  try {
    client.connect();
    const readyDeadline = performance.now() + READY_TIMEOUT_MILLISECONDS;
    while (!liveObserved && endedReason === null && performance.now() < readyDeadline) await Bun.sleep(100);
    if (!liveObserved) throw new Error(endedReason ?? "relay did not become live");

    const startedAt = new Date().toISOString();
    const startedMonotonic = performance.now();
    const durationMilliseconds = config.durationSeconds * 1_000;
    const samples: GatewayProcessSample[] = [];
    const recordSample = async (): Promise<void> => {
      if (gatewayPid === undefined) return;
      const reading = await readGatewayProcess(gatewayPid);
      const sample = { elapsedSeconds: Math.round((performance.now() - startedMonotonic) / 1_000), ...reading };
      samples.push(sample);
      if (config.samplesPath !== undefined) {
        await appendFile(config.samplesPath, `${sample.elapsedSeconds},${sample.rssKiB},${sample.cpuSeconds}\n`);
      }
    };
    await recordSample();
    let nextSampleAt = startedMonotonic + GATEWAY_SAMPLE_INTERVAL_MILLISECONDS;
    while (performance.now() - startedMonotonic < durationMilliseconds) {
      const remaining = durationMilliseconds - (performance.now() - startedMonotonic);
      await Bun.sleep(Math.min(HEALTH_CHECK_INTERVAL_MILLISECONDS, Math.max(1, remaining)));
      if (endedReason !== null) throw new Error(`relay ended during soak: ${endedReason}`);
      if (performance.now() >= nextSampleAt) {
        await recordSample();
        nextSampleAt += GATEWAY_SAMPLE_INTERVAL_MILLISECONDS;
      }
    }
    await recordSample();

    const finalPhase = client.getSnapshot().phase;
    if (finalPhase !== "live") throw new Error(`relay was not live at completion: ${finalPhase}`);
    console.log(
      JSON.stringify({
        startedAt,
        completedAt: new Date().toISOString(),
        durationSeconds: Math.floor((performance.now() - startedMonotonic) / 1_000),
        transitions,
        finalPhase,
        ...(gatewayPid === undefined ? {} : { gateway: summarizeGatewaySamples(samples) }),
      }),
    );
  } finally {
    unsubscribe();
    client.close();
  }
}

if (import.meta.main) {
  try {
    await runRelaySoak(parseRelaySoakConfig());
  } catch (error) {
    console.error(`relay soak failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
