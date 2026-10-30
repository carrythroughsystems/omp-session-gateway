import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ORDER_AUTHOR, ORDER_HEAD_PREFIX, REPOSITORY, StaleIntentError, applyDecisionPatch, campaignAttempt, campaignExecution, campaignRetryLaunchState, parseCampaignFailureObservation, parseCampaignRetryPlan, compareVersions, isOrder, nextStep, outsideOrderScope, parseCampaignInfrastructureHold, requestVersion, promotionHold, tick } from "./release-driver.ts";
import type { CampaignFailureObservation, CampaignInfrastructureHold, Decision, DriverConfig, DriverPort, DriverState, JobObservation, PullRequest, RepositorySnapshot, TrackingIssue } from "./release-driver.ts";
import { assertReleaseTagState } from "./release-tag-state.ts";
import { releaseAssetNames, verifyReleaseSignatures } from "./post-release-smoke.ts";
import { downloadReleaseAssets } from "./release-download.ts";
import { compareReleaseArchives } from "./release-runtime-compare.ts";
import { runReleaseGenerate } from "./release-generate.ts";
import { assertCampaignCleanupComplete, assertCampaignRetryEligible, assertDeviceCloudResumeEligible, externalCleanupCurrent, validateStableQualificationReceipt, type StableQualificationLaneModules, type StableQualificationReceipt } from "./stable-qualification.ts";
import { defaultLaneModules } from "./stable-lanes.ts";
import { clearReleaseHostLease } from "./release-host-lease.ts";
import { parseDeviceCloudMachineOutcome, readDeviceCloudOutcomeFile } from "./device-cloud-outcome.ts";
import { parseDeviceCloudProgress } from "./device-cloud-qualification.ts";
import { nextReleaseVersion, parseReleaseClass, REQUIRED_CHECKS, ROUTINE_BRANCH_PROTECTION, routineBranchProtectionMatches, ROUTINE_EVIDENCE_STEPS, RoutineHoldError, routineProtectedPath, routineSourceHold, generatedReleaseKind, generatedReleaseFilesMatch } from "./release-policy.ts";
import type { RoutineAuthority, RoutineEvidence } from "./release-policy.ts";
import { runAdb } from "./android-device.ts";
import { parseQualificationOutcome, qualificationExecutionsMatch, qualificationOutcomeExitCode, readQualificationOutcomeFile, type QualificationOutcome } from "./qualification-outcome.ts";
import { parseRetainedVendorJson } from "./device-cloud-record-json.ts";
import { privateQualificationFailureDiagnostic } from "./qualification-failure.ts";
import packageManifest from "../package.json";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_BUN_VERSION = packageManifest.packageManager.replace(/^bun@/u, "");
interface RuntimeConfig extends DriverConfig {
  ghConfig: string;
  signingKey: string;
  stateDir: string;
  dryRun: boolean;
}
export function driverConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  if (env.OMP_RELEASE_DRY_RUN !== undefined && !["0", "1", "false", "true"].includes(env.OMP_RELEASE_DRY_RUN)) throw new Error("OMP_RELEASE_DRY_RUN must be 0, 1, false or true");
  const config = {
    bot: env.OMP_RELEASE_BOT_LOGIN ?? "alphastorm-release",
    founder: env.OMP_RELEASE_FOUNDER_LOGIN ?? "alphastorm",
    ghConfig: env.OMP_RELEASE_GH_CONFIG_DIR ?? join(homedir(), ".config/gh-release-bot"),
    signingKey: env.OMP_RELEASE_SIGNING_KEY ?? join(homedir(), ".ssh/omp-gateway-release-signing"),
    stateDir: env.OMP_RELEASE_STATE_DIR ?? join(homedir(), ".local/state/omp-session-gateway/release-driver"),
    dryRun: env.OMP_RELEASE_DRY_RUN === "1" || env.OMP_RELEASE_DRY_RUN === "true",
  };
  for (const login of [config.bot, config.founder]) if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(login)) throw new Error("invalid release identity login");
  if (config.bot.toLowerCase() === config.founder.toLowerCase()) throw new Error("release bot and maintainer logins must be distinct");
  for (const path of [config.ghConfig, config.signingKey, config.stateDir]) if (!isAbsolute(path)) throw new Error("driver paths must be absolute");
  return config;
}
/** Never let ambient founder tokens or git identity override the dedicated machine account. */
export function botEnvironment(config: RuntimeConfig, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ambient, GH_CONFIG_DIR: config.ghConfig, GH_HOST: "github.com", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_COUNT", "OMP_STABLE_PREVIOUS_TAG", "OMP_STABLE_MAC_SUDO_PASSWORD_FILE", "OMP_STABLE_QUALIFICATION_DIR", "OMP_STABLE_OUTCOME_FILE", "OMP_RELEASE_SMOKE_LOG_DIR"]) delete env[key];
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_/u.test(key)) delete env[key];
  return env;
}
async function command(argv: string[], cwd: string, env: NodeJS.ProcessEnv, allowedFailure = false,
  captureOutput?: (out: Buffer, err: Buffer) => void): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(), child.exited]);
  const outBytes = Buffer.from(stdout), errBytes = Buffer.from(stderr);
  captureOutput?.(outBytes, errBytes);
  const out = outBytes.toString(), err = errBytes.toString();
  if (code !== 0 && !allowedFailure) throw new Error(`${argv[0]} ${argv[1] ?? ""} exited ${code}; inspect the private release-driver job logs`, { cause: { out: out.slice(-262144), err: err.slice(-262144) } });
  return { code, out: out.trim(), err };
}
function commandOutputTail(previous: Buffer, bytes: Buffer): Buffer {
  const tail = bytes.subarray(-262_144);
  return Buffer.concat([previous.subarray(Math.max(0, previous.length + tail.length - 262_144)), tail]);
}
/** A fixed-size byte ring; child chunks never keep an oversized backing buffer alive. */
export class CommandOutputTail {
  private buffer: Buffer = Buffer.alloc(0);
  private length = 0;
  private end = 0;
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.buffer.length === 0) this.buffer = Buffer.alloc(262_144);
    const chunk = bytes.subarray(-this.buffer.length);
    const first = Math.min(chunk.length, this.buffer.length - this.end);
    this.buffer.set(chunk.subarray(0, first), this.end);
    this.buffer.set(chunk.subarray(first), 0);
    this.end = (this.end + chunk.length) % this.buffer.length;
    this.length = Math.min(this.buffer.length, this.length + chunk.length);
  }
  bytes(): Buffer {
    const start = this.length === this.buffer.length ? this.end : 0;
    return Buffer.concat([this.buffer.subarray(start, this.length), this.buffer.subarray(0, start)]);
  }
}
async function commandTail(argv: string[], cwd: string, env: NodeJS.ProcessEnv, out: CommandOutputTail, err: CommandOutputTail): Promise<number> {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const drain = async (stream: ReadableStream<Uint8Array>, tail: CommandOutputTail) => {
    for await (const chunk of stream) tail.push(chunk);
  };
  const [code] = await Promise.all([child.exited, drain(child.stdout, out), drain(child.stderr, err)]);
  return code;
}
async function jsonFile<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  // Directory fsync is a POSIX durability step; NTFS has no equivalent and rename is already atomic there.
  if (process.platform !== "win32") {
    const parent = await open(dirname(path), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
}
async function immutableJobJson(path: string, value: unknown): Promise<boolean> {
  return immutableJobBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}
async function immutableJobBytes(path: string, bytes: Buffer): Promise<boolean> {
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  const parent = await open(dirname(path), "r");
  try { await parent.sync(); } finally { await parent.close(); }
  return true;
}
async function retainJobDiagnostics(directory: string, prefix: "qualification" | "smoke", out: Buffer, err: Buffer, failure?: Error): Promise<void> {
  for (const [name, bytes] of [[`${prefix}-out.log`, out], [`${prefix}-err.log`, err]] as const) {
    if (!await immutableJobBytes(join(directory, name), bytes)) throw new Error(`${prefix} output already exists`);
  }
  if (failure !== undefined && !await immutableJobJson(join(directory, `${prefix}-failure.json`), {
    errors: privateQualificationFailureDiagnostic(failure),
  })) throw new Error(`${prefix} failure evidence already exists`, { cause: failure });
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("release-driver state directory must be private and owned by this account");
}
export function credentialExpiry(headers: string, now = Date.now()): { status: "unknown" | "valid" | "expired"; expiresAt?: string } {
  const value = /^github-authentication-token-expiration:\s*(.+)$/imu.exec(headers)?.[1]?.trim();
  const at = value === undefined ? NaN : Date.parse(value);
  return !Number.isFinite(at) ? { status: "unknown" } : { status: at <= now ? "expired" : "valid", expiresAt: new Date(at).toISOString() };
}
interface ApiPr {
  number: number; user: { login: string; type: string }; head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string }; draft: boolean; state: "open" | "closed"; merged: boolean;
  merged_by: { login: string } | null; merge_commit_sha: string | null; mergeable_state: string; mergeable: boolean | null; html_url: string;
}
interface WorkflowRun { id: number; run_attempt: number; head_sha: string; head_branch: string; conclusion: string | null; status: string; html_url: string; created_at: string }
interface JobSpec { kind: "campaign" | "approve" | "smoke"; state: DriverState; root: string }
interface WorkCheckout { path: string; branch?: string; bytes: number }
interface WorkPruneResult {
  operation: "prune";
  apply: boolean;
  wouldRemove?: WorkCheckout[];
  removed?: WorkCheckout[];
  kept: { path: string; reason: string }[];
}

/** Failed qualification is retryable, never qualified, once every effect owner proves cleanup. */
export function assertFailedCampaignCleanup(
  state: DriverState, value: unknown, modules: StableQualificationLaneModules = defaultLaneModules,
): void {
  if (!state.candidateCommit || !state.candidateDigest || !state.previousStable || !state.macHost) throw new Error("failed campaign binding is incomplete");
  const receipt = validateStableQualificationReceipt(value, state.candidate, state.candidateCommit, state.previousStable);
  // Worker exit/absence and the OS lock prove settlement in failedCampaignCleanup/lease clear.
  // A failed consumer can leave publication marked running and omit campaign completedAt.
  if (receipt.status !== "failed" || receipt.macHost !== state.macHost ||
    receipt.candidate?.tag !== state.candidate || receipt.candidate.sourceCommit !== state.candidateCommit ||
    receipt.candidate.archiveSha256 !== state.candidateDigest) {
    throw new Error("failed campaign does not match its exact binding");
  }
  // Debian owns its workflow teardown; a failed/unknown workflow is not proof of cloud absence.
  for (const name of ["debian", "cleanup", "windowsCleanup", "androidPushCleanup", "deviceCloudCleanup"] as const) {
    if (receipt.lanes[name].status !== "passed" || receipt.lanes[name].attempts < 1) throw new Error("failed campaign cleanup did not pass: " + name);
  }
  for (const name of ["windows", "androidPush", "deviceCloud"] as const) {
    if (!externalCleanupCurrent(receipt, name)) throw new Error("failed campaign cleanup is stale or incomplete: " + name);
  }
  for (const name of ["windows", "androidPush", "deviceCloud"] as const) {
    if (modules[name].needsCleanup(receipt.lanes[name].evidence?.progress)) throw new Error("failed campaign cleanup is stale or incomplete: " + name);
  }
  const cloud = parseDeviceCloudProgress(receipt.lanes.deviceCloud.evidence?.progress);
  const resources = cloud.resources, audit = cloud.results.audit;
  if (resources === undefined || resources.some(resource =>
    resource.sessionId === undefined || !resource.ended || !resource.audited || resource.incident === true ||
    resource.unauditedDeletion === true || (resource.vendor === "browserstack" && !resource.recordRemoved)) ||
    (resources.length > 0 && audit?.records !== resources.length) ||
    (audit !== undefined && (audit.records !== resources.length || audit.recordsExposingLinks !== 0 ||
      audit.recordsWithMedia !== 0 || (audit.lingeringSignedArtifacts !== undefined && audit.lingeringSignedArtifacts !== 0)))) {
    throw new Error("failed campaign device-cloud retained-record audit is unresolved");
  }
}

class CampaignAvailabilityResult extends Error {
  constructor(readonly hold: CampaignInfrastructureHold) { super("candidate device-cloud infrastructure held"); }
}
class CampaignFailureResult extends Error {
  constructor(readonly outcome: QualificationOutcome, readonly exitCode: number) { super("candidate qualification failed"); }
}

/** These are the only worker arguments which grant new-format recovery authority. */
export function campaignWorkerArguments(state: DriverState, executionPath: string, preflight = false): string[] {
  if (state.qualificationExecution === undefined) return preflight ? ["--preflight"] : state.resumeDeviceCloud ? ["--resume-device-cloud"] : [];
  if (!qualificationExecutionsMatch(state.qualificationExecution, campaignExecution(state))) throw new Error("campaign execution binding changed");
  if (preflight && campaignAttempt(state) !== 0) throw new Error("retry must consume authorization before admission");
  return ["--execution-file", executionPath, ...(preflight ? ["--preflight"] : []),
    ...(state.retryPlan?.outcome.receipt === undefined ? (!preflight && state.retryPlan !== undefined ?
      ["--retry-outcome-file", join(dirname(executionPath), "retry-preflight-outcome.json"), "--retry-outcome-sha256", state.retryPlan.outcomeSha256] : []) :
      ["--retry-receipt-sha256", state.retryPlan.outcome.receipt.sha256])];
}

/** Exit 75 alone is never authoritative: validate its closed outcome and the bound receipt. */
export function campaignAvailabilityObservation(
  state: DriverState, output: unknown, receipt: StableQualificationReceipt | undefined,
  modules?: StableQualificationLaneModules,
): CampaignInfrastructureHold {
  const { availabilityHolds: holds } = parseDeviceCloudMachineOutcome(output);
  let scope: CampaignInfrastructureHold["scope"] = "preflight";
  if (receipt !== undefined && Object.values(receipt.lanes).some(lane => lane.attempts !== 0 || lane.status !== "pending" || lane.evidence !== undefined)) {
    const recorded = assertDeviceCloudResumeEligible(receipt, {
      tag: state.candidate, previousTag: state.previousStable!, orchestratorCommit: state.candidateCommit!, macHost: state.macHost ?? "",
    }, modules);
    if (receipt.candidate === undefined || receipt.candidate.sourceCommit !== state.candidateCommit || receipt.candidate.archiveSha256 !== state.candidateDigest) throw new Error("held receipt differs from the selected candidate");
    if (JSON.stringify(holds) !== JSON.stringify(recorded)) throw new Error("stable outcome differs from held availability evidence");
    scope = "receipt";
  } else {
    if (receipt !== undefined) {
      validateStableQualificationReceipt(receipt, state.candidate, state.candidateCommit!, state.previousStable!);
      if (receipt.candidate !== undefined || receipt.predecessor !== undefined || receipt.macHost !== undefined) throw new Error("preflight hold receipt records qualification identity effects");
    }
    if (holds.some(hold => hold.stage !== "preflight")) throw new Error("allocation hold has no resumable receipt");
  }
  return parseCampaignInfrastructureHold({
    scope, candidate: state.candidate, sourceCommit: state.candidateCommit, archiveSha256: state.candidateDigest,
    orchestratorCommit: state.candidateCommit, policy: state.authorityPolicy, campaignAttempt: campaignAttempt(state), macHost: state.macHost, availabilityHolds: holds,
  }, state);
}

export class StudioDriver implements DriverPort {
  private env: NodeJS.ProcessEnv;
  private email = "";
  constructor(readonly config: RuntimeConfig, readonly plan: boolean) {
    // A plan may use the founder's existing read-only CLI session before the bot exists.
    this.env = plan ? { ...process.env, GH_PROMPT_DISABLED: "1" } : botEnvironment(config);
  }
  async gh<T>(args: string[], optional = false): Promise<T | undefined> {
    const result = await command(["gh", ...args], ROOT, this.env, optional);
    if (result.code !== 0) {
      if (optional && /\bHTTP 404\b/u.test(result.err)) return undefined;
      throw new Error("GitHub read failed; refusing to infer missing provider state");
    }
    return result.out === "" ? undefined : JSON.parse(result.out) as T;
  }
  async api<T>(path: string, optional = false): Promise<T | undefined> {
    return this.gh<T>(["api", `repos/${REPOSITORY}/${path}`], optional);
  }
  async pages<T>(path: string): Promise<T[]> {
    const pages = await this.gh<T[][]>(["api", "--paginate", "--slurp", `repos/${REPOSITORY}/${path}`]);
    return pages!.flat();
  }
  async readiness(state?: DriverState): Promise<Record<string, unknown> & { ready: boolean }> {
    const env = botEnvironment(this.config);
    const checks: Record<string, boolean> = {};
    const privateInput = async (path: string): Promise<boolean> => {
      try { const stat = await lstat(path); return stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size > 0; }
      catch { return false; }
    };
    for (const [name, path] of Object.entries({ signingKey: this.config.signingKey,
      vultr: join(homedir(), ".vultr-apikey"), tailscaleApi: join(homedir(), ".ts-qual-apikey"),
      serviceAccount: join(homedir(), ".local/state/omp-session-gateway/op-service-account.token"),
      pixelKeychain: join(homedir(), "Library/Keychains/omp-qualification.keychain-db") })) checks[name] = await privateInput(path);
    checks.tailscaleJoin = await privateInput(join(homedir(), ".ts-qual-authkey")) || await privateInput(join(homedir(), ".ts-authkey-qual"));
    checks.platform = process.platform === "darwin" && process.arch === "arm64" && Bun.version === PINNED_BUN_VERSION;
    // Share the qualification prerequisite list recognized by check:repository (not an adb argv).
    const executables = ["adb", "security", "git", "gh", "cosign", "shasum", "ssh", "scp", "bash", "python3", "curl"];
    for (const executable of [...executables, "tmux", "op"]) checks[executable] = Bun.which(executable) !== null;
    checks.java = await Bun.file("/opt/homebrew/opt/openjdk@17/bin/java").exists();
    const target = env.OMP_STABLE_MAC_HOST;
    checks.macConfigured = !!target && !target.includes(".example.");
    if (checks.macConfigured) {
      const result = await command(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "ControlMaster=no", "-o", "ControlPath=none", target!, "true"], ROOT, env, true).catch(() => undefined);
      checks.macReachable = result?.code === 0;
    }
    const devices = await runAdb(undefined, ["devices"], { timeoutMs: 10_000 }).catch(() => undefined);
    checks.pixel = devices !== undefined && devices.split("\n").filter(line => /\tdevice$/u.test(line.trim())).length === 1;
    let expiry: ReturnType<typeof credentialExpiry> = { status: "unknown" };
    try {
      const identity = await command(["gh", "api", "--include", "user"], ROOT, env);
      const boundary = identity.out.search(/\r?\n\r?\n/u);
      const body = identity.out.slice(boundary).trim();
      checks.botIdentity = boundary >= 0 && JSON.parse(body).login === this.config.bot;
      expiry = credentialExpiry(identity.out.slice(0, boundary));
      const repository = JSON.parse((await command(["gh", "api", "repos/" + REPOSITORY], ROOT, env)).out);
      checks.repositoryWrite = repository.permissions?.push === true;
      const protection = await command(["gh", "api", "repos/" + REPOSITORY + "/branches/main"], ROOT, env);
      checks.branchProtection = routineBranchProtectionMatches(JSON.parse(protection.out));
    } catch { checks.botIdentity = false; checks.repositoryWrite = false; }
    checks.githubNotExpired = expiry.status !== "expired";
    const leasePath = join(homedir(), ".local/state/omp-session-gateway/release-host/lease.sqlite");
    let lease: "free" | "owned" | "exact-retry-owner" | "unreadable" = "free";
    if (await Bun.file(leasePath).exists()) {
      try { const db = new Database(leasePath, { readonly: true });
        try {
          const owner = db.query<{ owner: string }, []>("SELECT owner FROM campaign WHERE id = 1").get()?.owner;
          if (owner !== undefined) {
            lease = "owned";
            if (state?.phase === "retry-pending" && owner === `qualification:${state.candidate}:${this.receipt(state)}`) {
              parseCampaignRetryPlan(state.retryPlan, state);
              lease = "exact-retry-owner";
            }
          }
        } finally { db.close(); }
      } catch { lease = "unreadable"; }
    }
    checks.hostLeaseCompatible = lease === "free" || lease === "exact-retry-owner";
    return { at: new Date().toISOString(), ready: Object.values(checks).every(Boolean), checks, lease,
      disabled: await Bun.file(join(this.config.stateDir, "disabled")).exists(), dryRun: this.config.dryRun,
      owner: this.config.bot, repository: REPOSITORY, orderAuthor: ORDER_AUTHOR, orderPrefix: ORDER_HEAD_PREFIX,
      credentialExpiry: { github: expiry, serviceAccount: "unknown", tailscale: "unknown", vultr: "unknown" },
      unobserved: ["service-account and provider validity/expiry", "TestingBot pinned-device availability", "Pixel PIN and WebAPK", "qualification workflow secrets", "retained guest full preflight"],
      nextAction: "resolve false checks before consuming a request; full candidate preflight remains mandatory; never clear an owned lease" };
  }
  async authenticate(): Promise<void> {
    if (this.plan) throw new Error("plan mode cannot authenticate for writes");
    const identity = await this.gh<{ login: string; id: number }>(["api", "user"]);
    if (identity?.login !== this.config.bot) throw new Error("dedicated gh config is not authenticated as the configured release bot");
    this.email = `${identity.id}+${identity.login}@users.noreply.github.com`;
    this.env = { ...this.env, GIT_AUTHOR_NAME: this.config.bot, GIT_COMMITTER_NAME: this.config.bot,
      GIT_AUTHOR_EMAIL: this.email, GIT_COMMITTER_EMAIL: this.email };
    // HTTPS git's only credential source is gh under the same isolated configuration.
    this.env.GIT_CONFIG_COUNT = "3";
    this.env.GIT_CONFIG_KEY_0 = "credential.helper"; this.env.GIT_CONFIG_VALUE_0 = "";
    this.env.GIT_CONFIG_KEY_1 = "credential.https://github.com.helper"; this.env.GIT_CONFIG_VALUE_1 = "!gh auth git-credential";
    this.env.GIT_CONFIG_KEY_2 = "gpg.ssh.allowedSignersFile"; this.env.GIT_CONFIG_VALUE_2 = join(this.config.stateDir, "allowed-signers");
    const keyParts = (await command(["ssh-keygen", "-y", "-f", this.config.signingKey], ROOT, this.env)).out.split(/\s+/u);
    const publicKey = `${keyParts[0]} ${keyParts[1]}`; // Never persist a key comment containing a host/account identifier.
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(publicKey)) throw new Error("release signing key must be an unattended ed25519 SSH key");
    await writeFile(join(this.config.stateDir, "allowed-signers"), `${this.email} ${publicKey}\n`, { mode: 0o600 });
  }
  async load(): Promise<DriverState | undefined> {
    const state = await jsonFile<DriverState>(join(this.config.stateDir, "state.json"));
    if (state !== undefined && (state.schemaVersion !== 1 || !Number.isSafeInteger(state.sequence) || requestVersion(state.issue) === undefined)) throw new Error("unsupported/corrupt release-driver state");
    if (state !== undefined) {
      campaignAttempt(state); parseReleaseClass(state.issue.releaseClass);
      if (state.qualificationExecution !== undefined && !qualificationExecutionsMatch(state.qualificationExecution, campaignExecution(state))) throw new Error("invalid campaign execution binding");
      if (state.retryPlan !== undefined) parseCampaignRetryPlan(state.retryPlan, state);
      if (state.phase === "retry-pending" && (state.retryPlan === undefined || !Number.isSafeInteger(state.retryNotBefore))) throw new Error("invalid campaign retry state");
    }
    return state;
  }
  async save(state: DriverState): Promise<void> {
    if (this.plan) throw new Error("plan attempted state mutation");
    await atomicJson(join(this.config.stateDir, "state.json"), state);
  }
  async readPr(number: number): Promise<PullRequest> {
    const pr = (await this.api<ApiPr>(`pulls/${number}`))!;
    const [head, files, checks, merge] = await Promise.all([
      this.api<{ tree: { sha: string } }>(`git/commits/${pr.head.sha}`),
      this.pages<{ filename: string; previous_filename?: string; status?: string }>(`pulls/${number}/files?per_page=100`),
      this.gh<{ check_runs: { name: string; status: string; conclusion: string; app: { slug: string } }[] }[]>(["api", "--paginate", "--slurp", `repos/${REPOSITORY}/commits/${pr.head.sha}/check-runs?per_page=100&filter=latest`]),
      pr.merged && pr.merge_commit_sha !== null ? this.api<{ tree: { sha: string }; verification: { verified: boolean } }>(`git/commits/${pr.merge_commit_sha}`) : undefined,
    ]);
    const runs = checks!.flatMap(page => page.check_runs);
    return { number, author: pr.user.login, authorType: pr.user.type, headRepository: pr.head.repo?.full_name ?? "",
      base: pr.base.ref, baseCommit: pr.base.sha, headRef: pr.head.ref, head: pr.head.sha, tree: head!.tree.sha, draft: pr.draft,
      state: pr.state, merged: pr.merged, mergedBy: pr.merged_by?.login, mergeCommit: pr.merge_commit_sha ?? undefined,
      mergeTree: merge?.tree.sha, mergeVerified: merge?.verification.verified, behind: pr.mergeable_state === "behind" || pr.mergeable_state === "unknown",
      mergeable: pr.mergeable_state === "dirty" ? false : pr.mergeable_state === "unknown" ? null : pr.mergeable,
      checksPassed: REQUIRED_CHECKS.every(name => runs.some(run => run.name === name && run.status === "completed" && run.conclusion === "success" && run.app.slug === "github-actions")), files, url: pr.html_url };
  }
  async issues(previous?: TrackingIssue): Promise<TrackingIssue[]> {
    const raw = await this.pages<{ number: number; title: string; user: { login: string }; html_url: string; created_at: string; labels?: { name: string }[]; pull_request?: unknown }>("issues?state=open&creator=github-actions%5Bbot%5D&per_page=100");
    const issues: TrackingIssue[] = raw.filter(issue => issue.pull_request === undefined).map(issue => ({
      number: issue.number, title: issue.title, author: issue.user.login, request: issue.created_at, url: issue.html_url,
      releaseClass: parseReleaseClass(issue.labels?.some(label => label.name === "release-minor") ? "minor" : "patch"),
    })).filter(issue => requestVersion(issue) !== undefined);
    if (issues.length === 0) return issues;
    const requests = await this.api<{ workflow_runs: WorkflowRun[] }>("actions/workflows/release-request.yml/runs?status=success&per_page=100", true);
    const jobName = (issue: TrackingIssue) => `Request OMP ${requestVersion(issue)}${issue.releaseClass === "minor" ? " (minor)" : ""}`;
    type FilingJob = { name: string; conclusion: string; steps?: { name: string; status: string; conclusion: string }[] };
    // The successful filing step's output is resolved into an immutable Actions
    // step name. Current labels/timestamps cannot identify which issue a run filed.
    const filedIssue = (job: FilingJob): TrackingIssue | undefined => {
      if (job.conclusion !== "success") return undefined;
      const records = job.steps?.filter(step => step.name.startsWith("Record tracking issue #")) ?? [];
      if (records.length !== 1 || records[0]!.status !== "completed" || records[0]!.conclusion !== "success") return undefined;
      const number = /^Record tracking issue #([1-9][0-9]*)$/u.exec(records[0]!.name)?.[1];
      return issues.find(issue => String(issue.number) === number && jobName(issue) === job.name);
    };
    const unmatched = new Set(issues.map(issue => issue.number));
    for (const run of requests?.workflow_runs ?? []) {
      if (unmatched.size === 0) break;
      const jobs = await this.api<{ jobs: FilingJob[] }>(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      for (const job of jobs!.jobs) {
        const issue = filedIssue(job);
        if (issue === undefined || !unmatched.has(issue.number)) continue;
        issue.request = `${run.id}:${run.run_attempt}`;
        unmatched.delete(issue.number);
      }
    }
    // A long-lived open request can outlive the newest 100 runs. Revalidate its recorded
    // successful run directly rather than requiring another workflow dispatch.
    const retained = issues.find(issue => issue.number === previous?.number && jobName(issue) === jobName(previous!));
    if (retained && unmatched.has(retained.number) && /^[1-9][0-9]*:[1-9][0-9]*$/u.test(previous!.request)) {
      const [id, attempt] = previous!.request.split(":");
      const run = await this.api<{ path: string; conclusion: string; status: string }>(`actions/runs/${id}/attempts/${attempt}`, true);
      if (run?.path === ".github/workflows/release-request.yml" && run.status === "completed" && run.conclusion === "success") {
        const jobs = await this.api<{ jobs: FilingJob[] }>(`actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`);
        if (jobs?.jobs.some(job => filedIssue(job)?.number === retained.number)) {
          retained.request = previous!.request;
          unmatched.delete(retained.number);
        }
      }
    }
    // A mutable label alone cannot opt a legacy patch request into minor-release authority.
    return issues.filter(issue => issue.releaseClass !== "minor" || /^[1-9][0-9]*:[1-9][0-9]*$/u.test(issue.request));
  }
  async workflow(tag: string, source: string): Promise<"passed" | "failed" | "pending"> {
    const result = await this.api<{ workflow_runs: WorkflowRun[] }>(`actions/workflows/signed-release.yml/runs?event=push&head_sha=${source}&per_page=100`);
    const run = result!.workflow_runs.find(run => run.head_branch === tag && run.head_sha === source);
    return run?.status !== "completed" ? "pending" : run.conclusion === "success" ? "passed" : "failed";
  }
  async job(kind: JobSpec["kind"], state: DriverState): Promise<JobObservation> {
    const directory = this.jobDirectory(kind, state);
    let result: JobObservation | undefined;
    try {
      if (kind === "campaign" && state.qualificationExecution !== undefined) {
        this.assertJobBinding(await jsonFile<JobSpec>(join(directory, "spec.json")), kind, state);
      }
      result = await jsonFile<JobObservation>(join(directory, "result.json"));
      if (result !== undefined && (result === null || typeof result !== "object" || Array.isArray(result))) {
        throw new Error("invalid release job result");
      }
    }
    catch {
      if (kind === "campaign" && state.qualificationExecution !== undefined) return { status: "failed", detail: "campaign harness:invalid_evidence" };
      throw new Error("invalid release job result");
    }
    if (result !== undefined) {
      if (kind === "campaign" && state.qualificationExecution !== undefined) {
        if (!await Bun.file(join(directory, "exit")).exists()) return await this.campaignWorkerRunning(state) ?
          { status: "running" } : { status: "failed", detail: "campaign harness:invalid_evidence" };
        if (result.status === "failed") {
          try { return { status: "failed", campaignFailure: await this.completedCampaignFailure(state) }; }
          catch { return { status: "failed", detail: "campaign harness:invalid_evidence" }; }
        }
        if (result.status !== "passed" || await readFile(join(directory, "exit"), "utf8") !== "0\n") {
          return { status: "failed", detail: "campaign harness:invalid_evidence" };
        }
      }
      return result;
    }
    const running = await command(["tmux", "has-session", "-t", this.session(kind, state)], ROOT, this.env, true);
    return { status: running.code === 0 ? "running" : "absent", detail: `${kind} job has no exit receipt and no tmux session; no automatic retry` };
  }
  jobDirectory(kind: JobSpec["kind"], state: DriverState): string {
    const retry = kind === "campaign" && campaignAttempt(state) > 0 ? `-retry-${campaignAttempt(state)}` : "";
    return join(this.config.stateDir, "jobs", `${state.issue.number}-${state.candidate}-${kind}${retry}`);
  }
  session(kind: JobSpec["kind"], state: DriverState): string {
    const retry = kind === "campaign" && campaignAttempt(state) > 0 ? `-retry-${campaignAttempt(state)}` : "";
    return `omp-release-${state.issue.number}-${state.candidate.replaceAll(".", "-")}-${kind}${retry}`;
  }
  jobCheckoutName(kind: JobSpec["kind"], state: DriverState): string {
    const retry = kind === "campaign" && campaignAttempt(state) > 0 ? `-retry-${campaignAttempt(state)}` : "";
    return `${state.issue.number}-${state.candidate}-${kind}-job${retry}`;
  }
  async workPruneSessions(): Promise<string[]> {
    const result = await command(["tmux", "list-sessions", "-F", "#{session_name}"], ROOT, this.env, true);
    if (result.code !== 0 && !/^(?:no server running on |error connecting to .+ \(No such file or directory\)|failed to connect to server: No such file or directory)/u.test(result.err.trim())) {
      throw new Error("cannot inspect tmux sessions; work pruning refused");
    }
    return result.code === 0 ? result.out.split("\n").filter(name => name.startsWith("omp-release-")) : [];
  }
  /** The tick mutex is held for apply; previews never create a lock, log or state file. */
  async pruneWork(apply = false): Promise<WorkPruneResult> {
    if (apply && (this.plan || this.config.dryRun)) throw new Error("dry-run driver cannot apply work pruning");
    const state = await this.load();
    if (state === undefined) throw new Error("work pruning requires a saved release state");
    compareVersions(state.version, state.version);
    if (!state.candidate.startsWith(`v${state.version}-prealpha.`)) throw new Error("release state version/candidate differ; work pruning refused");
    const sessions = new Set(await this.workPruneSessions());
    if (sessions.size > 0 && !await Bun.file(join(this.config.stateDir, "disabled")).exists()) {
      throw new Error("enable the kill switch before pruning while a release job is running");
    }
    const work = join(await realpath(this.config.stateDir), "work");
    const info = await lstat(work).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const candidates: WorkCheckout[] = [], kept: WorkPruneResult["kept"] = [];
    if (info === undefined) return { operation: "prune", apply, ...(apply ? { removed: candidates } : { wouldRemove: candidates }), kept };
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("work pruning requires a real work directory");
    const references = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === "string") references.add(value);
      else if (value !== null && typeof value === "object") for (const child of Object.values(value)) collect(child);
    };
    collect(state.intent);
    const protectedPaths = new Set<string>();
    const jobs = await readdir(join(this.config.stateDir, "jobs"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const job of jobs) {
      if (!job.isDirectory()) continue;
      const directory = join(this.config.stateDir, "jobs", job.name);
      const result = await jsonFile<JobObservation>(join(directory, "result.json"));
      const exit = await jsonFile<number>(join(directory, "exit"));
      if (result && ["passed", "failed", "infrastructure-hold"].includes(result.status) && Number.isInteger(exit)) continue;
      const spec = await jsonFile<JobSpec>(join(directory, "spec.json"));
      if (spec === undefined) continue;
      if (!["campaign", "approve", "smoke"].includes(spec.kind) || typeof spec.root !== "string" || !isAbsolute(spec.root) ||
        !Number.isSafeInteger(spec.state?.issue?.number) || !/^v[0-9]+\.[0-9]+\.[0-9]+-prealpha\.[1-9][0-9]*$/u.test(spec.state.candidate)) {
        throw new Error("invalid non-terminal job specification; work pruning refused");
      }
      protectedPaths.add(resolve(spec.root));
      protectedPaths.add(join(work, this.jobCheckoutName(spec.kind, spec.state)));
    }
    // Logical byte estimates include symlinks themselves, never their external targets.
    const bytes = async (path: string): Promise<number> => {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
      let total = stat.size;
      for (const entry of await readdir(path)) total += await bytes(join(path, entry));
      return total;
    };
    const listed = await this.git(["worktree", "list", "--porcelain", "-z"]);
    for (const record of listed.split("\0\0")) {
      const fields = record.split("\0");
      const listedPath = fields.find(field => field.startsWith("worktree "))?.slice(9);
      if (listedPath === undefined) continue;
      const path = resolve(listedPath);
      if (dirname(path) !== work) continue;
      const name = basename(path);
      const family = /^([1-9][0-9]*)-(v([0-9]+\.[0-9]+\.[0-9]+)-prealpha\.[1-9][0-9]*)-(prepare|approve|record|campaign-job|approve-job|smoke-job)(-retry-[1-9][0-9]*)?$/u.exec(name);
      const rebuild = /^v([0-9]+\.[0-9]+\.[0-9]+)-rebuild$/u.exec(name);
      const version = family?.[3] ?? rebuild?.[1];
      const ref = fields.find(field => field.startsWith("branch "))?.slice(7);
      const branch = ref?.replace(/^refs\/heads\//u, "");
      const branchVersion = /^release-driver\/[1-9][0-9]*\/v([0-9]+\.[0-9]+\.[0-9]+)-prealpha\./u.exec(branch ?? "")?.[1];
      const session = family === null ? undefined :
        `omp-release-${family[1]}-${family[2]!.replaceAll(".", "-")}-${family[4]!.replace(/-job$/u, "")}${family[5] ?? ""}`;
      let reason: string | undefined;
      if (version === undefined || (branch !== undefined && branchVersion === undefined)) reason = "unrecognized driver checkout";
      else if (version === state.version || branchVersion === state.version) reason = "current release version";
      else if (rebuild !== null && compareVersions(version, state.version) >= 0) reason = "not an older rebuild";
      else if (session !== undefined && sessions.has(session)) reason = "live job session";
      else if (protectedPaths.has(resolve(path))) reason = "non-terminal job specification";
      else if ([...references].some(value => value === path || value.startsWith(path + sep) ||
        value === branch || value === ref || value === family?.[2] || value === version || value === `v${version}`)) reason = "current intent reference";
      if (reason !== undefined) { kept.push({ path, reason }); continue; }
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("unsafe work checkout; pruning refused");
      candidates.push({ path, ...(branch === undefined ? {} : { branch }), bytes: await bytes(path) });
    }
    if (apply) for (const checkout of candidates) {
      await this.git(["worktree", "remove", "--force", checkout.path]);
      await this.git(["worktree", "prune"]);
      if (checkout.branch !== undefined) await this.git(["branch", "-D", checkout.branch]);
    }
    return { operation: "prune", apply, ...(apply ? { removed: candidates } : { wouldRemove: candidates }), kept };
  }
  async campaignWorkerRunning(state: DriverState): Promise<boolean> {
    return (await command(["tmux", "has-session", "-t", this.session("campaign", state)], ROOT, this.env, true)).code === 0;
  }
  async anyCampaignWorkerRunning(state: DriverState): Promise<boolean> {
    const attempts = new Map<string, { issue: number; attempt: number }>();
    for (let attempt = 0; attempt <= campaignAttempt(state); attempt++) attempts.set(`${state.issue.number}:${attempt}`, { issue: state.issue.number, attempt });
    let entries: string[];
    try { entries = await readdir(join(this.config.stateDir, "jobs")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries = []; }
    // Every launcher creates its deterministic directory before tmux. Include even unexpected
    // future ordinals and another request's same-candidate job, not just this state's history.
    for (const entry of entries) {
      const match = /^([1-9][0-9]*)-(v[0-9]+\.[0-9]+\.[0-9]+-prealpha\.[1-9][0-9]*)-campaign(?:-retry-([1-9][0-9]*))?$/u.exec(entry);
      if (match?.[2] !== state.candidate) continue;
      const issue = Number(match[1]), attempt = Number(match[3] ?? 0);
      if (!Number.isSafeInteger(issue) || !Number.isSafeInteger(attempt) || attempt > 10_000) throw new Error("invalid candidate campaign job identity");
      attempts.set(`${issue}:${attempt}`, { issue, attempt });
    }
    for (const { issue, attempt } of attempts.values()) {
      if (await this.campaignWorkerRunning({ ...state, issue: { ...state.issue, number: issue }, campaignAttempt: attempt })) return true;
    }
    return false;
  }
  releaseHostLeasePath(): string {
    return join(homedir(), ".local/state/omp-session-gateway/release-host/lease.sqlite");
  }
  async releaseHostOwner(): Promise<string | undefined> {
    const path = this.releaseHostLeasePath();
    if (!await Bun.file(path).exists()) return undefined;
    const db = new Database(path, { readonly: true });
    try {
      return db.query<{ owner: string }, []>("SELECT owner FROM campaign WHERE id = 1").get()?.owner;
    } finally { db.close(); }
  }
  /** Probe the real OS lock without creating a row, clearing ownership or replacing its inode. */
  async assertReleaseHostRetryAvailable(state: DriverState, requireOwner: boolean): Promise<void> {
    const path = this.releaseHostLeasePath();
    const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (file === undefined) {
      if (requireOwner) throw new Error("campaign retry owner is missing");
      return;
    }
    const parent = await lstat(dirname(path));
    if (!file.isFile() || file.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink() ||
      [file, parent].some(info => info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new Error("unsafe release-host lease");
    const database = new Database(path);
    try {
      database.exec("PRAGMA busy_timeout = 1000");
      database.exec("BEGIN EXCLUSIVE");
      const owner = database.query<{ owner: string }, []>("SELECT owner FROM campaign WHERE id = 1").get()?.owner;
      if ((requireOwner && owner === undefined) || (owner !== undefined && owner !== `qualification:${state.candidate}:${this.receipt(state)}`)) {
        throw new Error("campaign retry owner changed");
      }
    } finally {
      try { database.exec("ROLLBACK"); } catch {}
      database.close();
    }
  }
  async campaignBinding(state: DriverState): Promise<DriverState> {
    const specification = await jsonFile<JobSpec>(join(this.jobDirectory("campaign", state), "spec.json"));
    this.assertJobBinding(specification, "campaign", state);
    return specification!.state;
  }
  /** Hash exact completed bytes, not parsed/reformatted JSON. Never touch the working receipt. */
  async completedCampaignFailure(state: DriverState): Promise<CampaignFailureObservation> {
    const directory = this.jobDirectory("campaign", state), expected = campaignExecution(state);
    const bound = await this.campaignBinding(state);
    if (!qualificationExecutionsMatch(bound.qualificationExecution, expected)) throw new Error("completed campaign binding changed");
    const files = new Map<string, Buffer>();
    for (const name of ["spec.json", "result.json", "exit", "failure-outcome.json"]) {
      const path = join(directory, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8_388_608) throw new Error("invalid completed campaign evidence");
      files.set(name, await readFile(path));
    }
    const result = parseRetainedVendorJson(files.get("result.json")!.toString()) as JobObservation;
    if (result === null || typeof result !== "object" || Object.keys(result).join(",") !== "status" ||
      result.status !== "failed") throw new Error("campaign worker has no classified failure result");
    const outcome = await readQualificationOutcomeFile(join(directory, "failure-outcome.json"), expected);
    if (files.get("exit")!.toString() !== `${qualificationOutcomeExitCode(outcome, expected)}\n` ||
      (outcome.scope === "preflight") !== (outcome.receipt === undefined)) throw new Error("campaign terminal evidence disagrees");
    let restartLanes: CampaignFailureObservation["restartLanes"] = [];
    if (outcome.receipt !== undefined) {
      const path = join(directory, "failed-qualification.json"), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8_388_608) throw new Error("invalid completed campaign receipt");
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== outcome.receipt.sha256) throw new Error("completed campaign receipt changed");
      const receipt = validateStableQualificationReceipt(JSON.parse(bytes.toString()), state.candidate, state.candidateCommit!, state.previousStable!);
      if (receipt.status !== "failed" || !qualificationExecutionsMatch(receipt.execution, expected) ||
        outcome.scope !== (receipt.rigReadiness?.status === "failed" ? "rigReadiness" : "campaign")) {
        throw new Error("campaign receipt scope or execution differs from its outcome");
      }
      if (qualificationOutcomeExitCode(outcome, expected) === 75) {
        if (expected.campaignAttempt === 2) this.campaignCleanupComplete(receipt, state);
        else restartLanes = this.campaignRetryLanes(receipt, state);
      }
      if (JSON.stringify(receipt.failureSummary) !== JSON.stringify(outcome.failureSummary)) throw new Error("campaign outcome differs from its receipt");
      files.set("failed-qualification.json", bytes);
    }
    const hash = createHash("sha256");
    for (const [name, bytes] of files) hash.update(`${name}:${bytes.length}:`).update(bytes);
    for (const name of ["out.log", "err.log", "qualification-out.log", "qualification-err.log"]) {
      const path = join(directory, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid completed campaign log");
      hash.update(`${name}:${info.size}:`);
      let size = 0;
      for await (const bytes of Bun.file(path).stream()) { size += bytes.length; hash.update(bytes); }
      if (size !== info.size) throw new Error("completed campaign log changed");
    }
    return parseCampaignFailureObservation({ outcome, outcomeSha256: createHash("sha256").update(files.get("failure-outcome.json")!).digest("hex"),
      jobSha256: hash.digest("hex"), restartLanes }, state);
  }
  campaignRetryLanes(receipt: StableQualificationReceipt, state: DriverState): CampaignFailureObservation["restartLanes"] {
    return assertCampaignRetryEligible(receipt, campaignExecution(state));
  }
  campaignCleanupComplete(receipt: StableQualificationReceipt, state: DriverState): void {
    assertCampaignCleanupComplete(receipt, campaignExecution(state));
  }
  /** Revalidation is used for both scheduling and unclaimed-launch replay; it never clears a lease. */
  async validateCampaignRetry(state: DriverState): Promise<void> {
    try {
      const plan = parseCampaignRetryPlan(state.retryPlan, state);
      if (!qualificationExecutionsMatch(state.qualificationExecution, campaignExecution(state)) ||
        state.approvePr !== undefined || state.stableCommit !== undefined) throw new StaleIntentError("campaign retry binding changed");
      const prior: DriverState = { ...state, campaignAttempt: plan.outcome.execution.campaignAttempt, qualificationExecution: plan.outcome.execution };
      // The failed job retains its preceding plan; the next state must not retarget that execution.
      const bound = await this.campaignBinding(prior);
      if (!qualificationExecutionsMatch(bound.qualificationExecution, plan.outcome.execution)) throw new StaleIntentError("prior campaign binding changed");
      if (await this.anyCampaignWorkerRunning(state)) throw new StaleIntentError("a candidate campaign worker is still active");
      if (await this.api(`git/ref/tags/v${state.version}`, true) !== undefined || await this.api(`releases/tags/v${state.version}`, true) !== undefined) {
        throw new StaleIntentError("stable publication already exists");
      }
      const approval = await this.pages<ApiPr>(`pulls?state=all&base=main&head=carrythroughsystems:${encodeURIComponent(`release-driver/${state.issue.number}/${state.candidate}-approve`)}&per_page=100`);
      if (approval.length !== 0) throw new StaleIntentError("candidate approval already exists");
      const prepare = state.preparePr === undefined ? undefined : await this.readPr(state.preparePr);
      if (!prepare?.merged || prepare.mergeCommit !== state.candidateCommit) throw new StaleIntentError("candidate source binding changed");
      this.requireSourceAuthority(await this.authority(state, (await this.api<{ sha: string }>("commits/main"))!.sha, prepare), state.authorityPolicy);
      // Verify immutable tag and published digest without downloading or modifying artifacts.
      const reference = (await this.api<{ ref: string; object: { sha: string; type: string } }>(`git/ref/tags/${state.candidate}`))!;
      assertReleaseTagState(reference, (await this.api(`git/tags/${reference.object.sha}`)) as Parameters<typeof assertReleaseTagState>[1], state.candidate, state.candidateCommit!);
      const release = await this.api<{ draft: boolean; prerelease: boolean; assets: { name: string; digest: string }[] }>(`releases/tags/${state.candidate}`);
      if (release?.draft !== false || release.prerelease !== true ||
        release.assets.find(asset => asset.name === releaseAssetNames(state.version).archive)?.digest !== `sha256:${state.candidateDigest}`) throw new StaleIntentError("candidate archive binding changed");
      const observed = await this.completedCampaignFailure(bound);
      const expected: CampaignFailureObservation = { outcome: plan.outcome, outcomeSha256: plan.outcomeSha256, jobSha256: plan.jobSha256, restartLanes: plan.restartLanes };
      if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new StaleIntentError("completed campaign evidence changed");
      if (plan.outcome.receipt === undefined) {
        if (await Bun.file(this.receipt(state)).exists()) throw new StaleIntentError("effects-free retry acquired a receipt");
      } else {
        const bytes = await readFile(this.receipt(state));
        if (createHash("sha256").update(bytes).digest("hex") !== plan.outcome.receipt.sha256) throw new StaleIntentError("working receipt binding changed");
        this.campaignRetryLanes(JSON.parse(bytes.toString()), bound);
      }
      const owner = await this.releaseHostOwner();
      if (owner !== undefined && owner !== `qualification:${state.candidate}:${this.receipt(state)}`) throw new StaleIntentError("release host lease belongs to another campaign");
      if (plan.outcome.receipt !== undefined && owner === undefined) throw new StaleIntentError("campaign retry owner is missing");
      await this.assertReleaseHostRetryAvailable(state, plan.outcome.receipt !== undefined);
    } catch (error) {
      if (error instanceof RoutineHoldError || error instanceof StaleIntentError) throw error;
      throw new StaleIntentError("campaign retry evidence is missing or changed");
    }
  }
  async failedCampaignCleanup(state: DriverState): Promise<string> {
    const bound = await this.campaignBinding(state);
    if (bound.candidateCommit !== state.candidateCommit || bound.candidateDigest !== state.candidateDigest ||
      bound.macHost !== state.macHost || bound.authorityPolicy !== state.authorityPolicy) throw new Error("failed worker binding changed");
    const directory = this.jobDirectory("campaign", state);
    if ((await this.job("campaign", state)).status !== "failed" || !await Bun.file(join(directory, "exit")).exists()) throw new Error("failed campaign worker has not exited");
    for (let attempt = 0; attempt <= campaignAttempt(state); attempt++) {
      if (await this.campaignWorkerRunning({ ...state, campaignAttempt: attempt })) throw new Error("a candidate campaign worker is still active");
    }
    const bytes = await readFile(this.receipt(state), "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bound.qualificationExecution === undefined) assertFailedCampaignCleanup(bound, JSON.parse(bytes));
    else {
      if (await this.anyCampaignWorkerRunning(state)) throw new Error("a candidate campaign worker is still active");
      const failure = await this.completedCampaignFailure(bound);
      if (failure.outcome.receipt?.sha256 !== digest || failure.outcome.receipt.cleanupDisposition !== "restored") throw new Error("failed campaign receipt changed or is not restored before retirement");
      this.campaignCleanupComplete(JSON.parse(bytes), bound);
    }
    return digest;
  }
  async recoverFailedCampaign(state: DriverState): Promise<void> {
    const owner = await this.releaseHostOwner();
    if (owner === undefined) return;
    const expected = `qualification:${state.candidate}:${this.receipt(state)}`;
    if (owner !== expected) throw new Error("release host lease belongs to another campaign");
    const path = join(this.jobDirectory("campaign", state), "lease-recovery.json");
    const result = await clearReleaseHostLease(expected, async () => {
      const receiptSha256 = await this.failedCampaignCleanup(state);
      await atomicJson(path, { owner: expected, candidate: state.candidate, at: new Date().toISOString(), receiptSha256, status: "clear-authorized" });
    });
    const proof = await jsonFile<Record<string, unknown>>(path);
    if (proof !== undefined) await atomicJson(path, { ...proof, status: result });
  }
  campaignHoldObservation(state: DriverState, output: unknown, receipt: StableQualificationReceipt | undefined): CampaignInfrastructureHold {
    return campaignAvailabilityObservation(state, output, receipt);
  }
  /** One operator authorization, no device allocation. The next tick launches a fresh immutable job. */
  async authorizeDeviceCloudRetry(candidate: string, attempt: number): Promise<DriverState> {
    const state = await this.load();
    if (state === undefined || state.phase !== "infrastructure-held" || state.candidate !== candidate || campaignAttempt(state) !== attempt ||
      state.intent !== undefined || state.announcement !== undefined || state.stableCommit !== undefined || state.approvePr !== undefined ||
      state.qualificationExecution !== undefined || state.retryPlan !== undefined) {
      throw new Error("retry-device-cloud requires the exact held candidate and current job attempt without pending work or publication");
    }
    const hold = parseCampaignInfrastructureHold(state.infrastructureHold, state);
    parseCampaignInfrastructureHold(hold, await this.campaignBinding(state));
    const job = await this.job("campaign", state);
    if (job.status !== "infrastructure-hold" || JSON.stringify(parseCampaignInfrastructureHold(job.availabilityHold, state)) !== JSON.stringify(hold)) {
      throw new Error("held campaign job is missing or changed");
    }
    for (let ordinal = 0; ordinal <= attempt; ordinal += 1) {
      if (await this.campaignWorkerRunning({ ...state, campaignAttempt: ordinal })) throw new Error("a candidate campaign worker is still active");
    }
    if (await this.api(`git/ref/tags/v${state.version}`, true) !== undefined || await this.api(`releases/tags/v${state.version}`, true) !== undefined) {
      throw new Error("stable publication already exists; device-cloud retry is refused");
    }
    const prepare = state.preparePr === undefined ? undefined : await this.readPr(state.preparePr);
    if (prepare === undefined || !prepare.merged || prepare.mergeCommit !== state.candidateCommit) throw new Error("candidate source binding changed");
    const authority = await this.authority(state, (await this.api<{ sha: string }>("commits/main"))!.sha, prepare);
    this.requireSourceAuthority(authority, state.authorityPolicy);
    const receipt = await jsonFile<StableQualificationReceipt>(this.receipt(state));
    const observed = this.campaignHoldObservation(state, { outcome: "infrastructure-hold", availabilityHolds: hold.availabilityHolds }, receipt);
    if (JSON.stringify(observed) !== JSON.stringify(hold)) throw new Error("held campaign scope or binding changed");
    if (hold.scope === "receipt") {
      if (receipt === undefined) throw new Error("held allocation receipt is missing");
      const archived = await jsonFile<StableQualificationReceipt>(join(this.jobDirectory("campaign", state), "held-qualification.json"));
      if (archived === undefined || JSON.stringify(archived) !== JSON.stringify(receipt)) throw new Error("held receipt differs from its immutable completed-job snapshot");
    }
    const owner = await this.releaseHostOwner();
    if (owner !== undefined && owner !== `qualification:${state.candidate}:${this.receipt(state)}`) throw new Error("release host lease belongs to another campaign");
    const next: DriverState = {
      ...state, phase: "candidate-verified", campaignAttempt: attempt + 1, resumeDeviceCloud: hold.scope === "receipt", sequence: state.sequence + 1,
    };
    delete next.infrastructureHold;
    const occupied = await lstat(this.jobDirectory("campaign", next)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (occupied !== undefined || await this.campaignWorkerRunning(next)) throw new Error("retry job identity is already occupied");
    await this.save(next);
    return next;
  }
  /** Normalize controls using installed policy; callers choose the authority comparison base. */
  async controls(source: string, local = false): Promise<Map<string, string>> {
    const entries = local
      ? (await this.git(["ls-tree", "-r", source])).split("\n").filter(Boolean).map(line => {
        const [meta, path] = line.split("\t"); return { path: path!, sha: meta!.split(" ")[2]!, type: meta!.split(" ")[1]!, mode: meta!.split(" ")[0]! };
      })
      : (await this.api<{ truncated: boolean; tree: { path: string; sha: string; type: string; mode: string }[] }>("git/trees/" + source + "?recursive=1"));
    if (!Array.isArray(entries) && entries?.truncated) throw new RoutineHoldError("missing-evidence");
    const tree = Array.isArray(entries) ? entries : entries!.tree;
    const controls = new Map<string, string>();
    for (const entry of tree) {
      if (entry.type === "tree") continue;
      // Generated approval records change every release. Their only admitted source
      // transition is the exact generated approve class below, plus the policy gate.
      if (entry.path === "STABLE_RELEASE.lock.json") continue;
      const manifest = entry.path === "package.json" || entry.path.endsWith("/package.json");
      if (!routineProtectedPath(entry.path) && !manifest && entry.path !== "bun.lock") continue;
      let hash = entry.sha;
      if (manifest || entry.path === "bun.lock" || entry.path === "scripts/build-release.ts") {
        const text = local ? await this.git(["show", source + ":" + entry.path])
          : Buffer.from((await this.api<{ content: string }>("contents/" + entry.path + "?ref=" + source))!.content, "base64").toString().trim();
        let normalized: string;
        if (entry.path === "scripts/build-release.ts") normalized = text.replace(/const PRODUCT_VERSION = "[0-9.]+"/u, 'const PRODUCT_VERSION = "<release>"');
        else if (entry.path === "bun.lock") {
          // Match only the generated workspace versions, not dependency versions in this JSONC lock.
          normalized = text.replace(/("(?:apps|packages)\/[^"\n]+": \{\n      "name": "[^"\n]+",\n      "version": ")[0-9.]+(",)/gu, '$1<release>$2');
        } else {
          const parsed = JSON.parse(text);
          delete parsed.version;
          normalized = JSON.stringify(parsed);
        }
        hash = createHash("sha256").update(normalized).digest("hex");
      }
      controls.set(entry.path, entry.mode + ":" + hash);
    }
    return controls;
  }
  async authority(state: DriverState, main: string, pr?: PullRequest): Promise<RoutineAuthority> {
    const installed = await this.git(["rev-parse", "HEAD"]);
    const source = pr?.merged ? pr.mergeCommit! : pr?.head ?? state.selectedMain;
    const [trusted, observed, protection] = await Promise.all([
      this.controls(installed, true), this.controls(source), this.api<unknown>("branches/main", true),
    ]);
    if (protection === undefined) throw new RoutineHoldError("missing-evidence");
    if (!routineBranchProtectionMatches(protection)) throw new RoutineHoldError("policy-changed");
    const protectedChanges = [...new Set([...trusted.keys(), ...observed.keys()])].filter(path => trusted.get(path) !== observed.get(path));
    if (await this.git(["status", "--porcelain", "--untracked-files=all"]) !== "") protectedChanges.push("installed-checkout-dirty");
    const policy = createHash("sha256").update(JSON.stringify({ controls: [...trusted].sort(), protection: ROUTINE_BRANCH_PROTECTION, bot: this.config.bot, reviewer: this.config.founder, checks: REQUIRED_CHECKS })).digest("hex");
    const comparison = await this.api<{ status: string; total_commits: number; commits: { sha: string }[] }>("compare/" + installed + "..." + state.selectedMain);
    let sourceReviewed = comparison?.status === "identical" || comparison?.status === "ahead";
    if (!comparison || comparison.total_commits !== comparison.commits.length) sourceReviewed = false;
    let unreviewedCommit: string | undefined;
    for (const commit of comparison?.commits ?? []) {
      const prs = await this.pages<{ number: number }>("commits/" + commit.sha + "/pulls?per_page=100");
      let reviewed = false;
      for (const item of prs) {
        const candidate = (await this.api<ApiPr & { title: string }>("pulls/" + item.number))!;
        if (!candidate.merged || candidate.base.ref !== "main" || candidate.merge_commit_sha !== commit.sha) continue;
        const detail = await this.readPr(item.number);
        const subject = (await this.api<{ message: string }>("git/commits/" + candidate.merge_commit_sha))!.message.split("\n", 1)[0]!;
        const baseline = isOrder(detail) && outsideOrderScope(detail).length === 0 && candidate.merged_by?.login === this.config.bot;
        // A bot merge needs a maintainer review of this exact head, never a mutable title.
        const changesReleaseLock = detail.files.some(file => [file.filename, file.previous_filename].includes("STABLE_RELEASE.lock.json"));
        let fix = false;
        if (!changesReleaseLock && /^(fix|perf|revert)(\([^)]+\))?: /u.test(subject)) {
          if (candidate.merged_by?.login === this.config.bot) {
            if (this.config.bot.toLowerCase() !== this.config.founder.toLowerCase() &&
              detail.files.every(file => [file.filename, file.previous_filename].every(path => path === undefined || !routineProtectedPath(path)))) {
              const reviews = await this.pages<{ id: number; user: { login: string }; state: string; commit_id: string }>(`pulls/${item.number}/reviews?per_page=100`);
              const review = reviews.filter(review => review.user.login === this.config.founder && review.state !== "COMMENTED" && review.state !== "PENDING").sort((a, b) => b.id - a.id)[0];
              // readPr resolves tree from this immutable head SHA, not the movable branch name.
              fix = review?.state === "APPROVED" && review.commit_id === detail.head &&
                detail.mergeTree !== undefined && detail.tree === detail.mergeTree;
            }
          } else fix = candidate.merged_by?.login === this.config.founder;
        }
        const kind = generatedReleaseKind(detail.headRef);
        const releaseRecord = detail.author === this.config.bot && generatedReleaseFilesMatch(kind, detail.files)
          && /^(chore|docs)\(release\): (prepare|approve|record) /u.test(subject) && candidate.merged_by?.login === this.config.bot;
        if (baseline || fix || releaseRecord) { reviewed = true; break; }
      }
      if (!reviewed) { sourceReviewed = false; unreviewedCommit = commit.sha; break; }
    }
    return { policy, protectedChanges, sourceReviewed, ...(unreviewedCommit === undefined ? {} : { unreviewedCommit }),
      sourceFresh: pr ? main === (pr.merged ? pr.mergeCommit : state.candidateCommit) : main === state.selectedMain,
      releaseClassAllowed: state.previousStable !== undefined
        && state.version === nextReleaseVersion(state.previousStable, parseReleaseClass(state.issue.releaseClass)) };
  }
  async evidence(state: DriverState): Promise<RoutineEvidence | undefined> {
    const result = await jsonFile<JobObservation & { evidence?: RoutineEvidence }>(join(this.jobDirectory("approve", state), "result.json"));
    const receipt = await jsonFile<StableQualificationReceipt>(this.receipt(state));
    if (result?.status !== "passed" || receipt?.status !== "passed" || receipt.schemaVersion !== 3
      || receipt.tag !== state.candidate || receipt.candidate?.sourceCommit !== state.candidateCommit
      || receipt.candidate?.archiveSha256 !== state.candidateDigest || Object.values(receipt.lanes).some(lane => lane.status !== "passed")) return undefined;
    return result.evidence;
  }
  async promotionSnapshot(state: DriverState): Promise<RepositorySnapshot> {
    const pr = await this.readPr(state.approvePr!);
    const main = (await this.api<{ sha: string }>("commits/main"))!.sha;
    const [authority, evidence] = await Promise.all([this.authority(state, main, pr), this.evidence(state)]);
    return { main, approve: pr, authority, ...(evidence === undefined ? {} : { evidence }), upstreamTag: "", latestStable: "", tags: [], issues: [] };
  }
  async prepareObservation(state: DriverState): Promise<PullRequest | undefined> {
    if (state.preparePr !== undefined) return this.readPr(state.preparePr);
    if (state.phase !== "held" || state.holdReason !== "stale-source" || state.candidateCommit !== undefined) return undefined;
    // The PR may predate its state checkpoint or only now be visible. Never create here.
    const branch = `release-driver/${state.issue.number}/${state.candidate}-prepare`;
    const existing = await this.pages<ApiPr>(`pulls?state=all&base=main&head=carrythroughsystems:${encodeURIComponent(branch)}&per_page=100`);
    if (existing.length > 1) throw new Error("multiple PRs use the deterministic release branch");
    return existing.length === 1 ? this.readPr(existing[0]!.number) : undefined;
  }
  async snapshot(state: DriverState | undefined): Promise<RepositorySnapshot> {
    const [main, upstream, latest, tags, issues] = await Promise.all([
      this.api<{ sha: string }>("commits/main"), this.api<{ content: string }>("contents/UPSTREAM.lock.json?ref=main"),
      this.api<{ tag_name: string }>("releases/latest"), this.pages<{ name: string }>("tags?per_page=100"), this.issues(state?.phase === "closed" ? undefined : state?.issue),
    ]);
    const lock: { tag: string } = JSON.parse(Buffer.from(upstream!.content, "base64").toString());
    compareVersions(lock.tag, lock.tag);
    const stableTags = tags.map(tag => tag.name).filter(tag => /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(tag)).sort(compareVersions);
    const repo: RepositorySnapshot = { main: main!.sha, upstreamTag: lock.tag, latestStable: stableTags.at(-1) ?? latest!.tag_name, tags: tags.map(tag => tag.name), issues };
    const retryInvalid = (error: unknown) => {
      if (error instanceof RoutineHoldError) {
        repo.authorityFailure = error.reason;
        repo.authorityFailureCommit = error.sourceCommit;
      } else repo.campaignRetryInvalid = true;
    };
    if (state === undefined || state.phase === "closed") return repo;
    if (compareVersions(repo.upstreamTag, requestVersion(state.issue)!) < 0) {
      const prs = await this.pages<ApiPr>("pulls?state=open&base=main&per_page=100");
      const matching = prs.filter(pr => pr.user.login === ORDER_AUTHOR && pr.user.type === "Bot" && pr.head.repo?.full_name === REPOSITORY && pr.head.ref.startsWith(ORDER_HEAD_PREFIX));
      // Multiple matching orders are ambiguous. Never select by attacker-controlled title/body.
      if (matching.length === 1) repo.order = await this.readPr(matching[0]!.number);
    }
    const prepare = await this.prepareObservation(state);
    if (prepare !== undefined) repo.prepare = prepare;
    if (state.approvePr !== undefined) repo.approve = await this.readPr(state.approvePr);
    if (state.recordPr !== undefined) repo.record = await this.readPr(state.recordPr);
    if (["approve-open", "approve-checking", "approval-required", "approved", "retry-pending"].includes(state.phase)) {
      try { repo.authority = await this.authority(state, repo.main, state.phase === "retry-pending" ? repo.prepare : repo.approve); }
      catch (error) { if (!(error instanceof RoutineHoldError)) throw error; retryInvalid(error); }
      const evidence = await this.evidence(state);
      if (evidence !== undefined) repo.evidence = evidence;
    }
    if (state.phase === "candidate-tagged") repo.candidateWorkflow = await this.workflow(state.candidate, state.candidateCommit!);
    if (state.phase === "stable-tagged") repo.stableWorkflow = await this.workflow(`v${state.version}`, state.stableCommit!);
    if (state.phase === "qualifying") {
      repo.campaign = await this.job("campaign", state);
      const observedState = { ...state };
      delete observedState.intent;
      const proposed = nextStep(observedState, repo, this.config);
      if (proposed.operation === "schedule-campaign-retry") {
        try { await this.validateCampaignRetry(applyDecisionPatch(state, proposed)); }
        catch (error) { retryInvalid(error); }
      }
    }
    if (state.phase === "retry-pending") {
      try {
        const pending = campaignRetryLaunchState(state), directory = this.jobDirectory("campaign", pending);
        if (await Bun.file(join(directory, "started")).exists() || await Bun.file(join(directory, "result.json")).exists() ||
          await this.campaignWorkerRunning(pending)) {
          this.assertJobBinding(await jsonFile<JobSpec>(join(directory, "spec.json")), "campaign", pending);
        } else {
          await this.validateCampaignRetry(state);
        }
      } catch (error) { retryInvalid(error); }
    }
    if (state.phase === "approve-checking") repo.approveChecks = await this.job("approve", state);
    if (state.phase === "smoking") repo.smoke = await this.job("smoke", state);
    if (state.phase === "diagnostic-required" || (state.phase === "held" && state.holdReason === "stale-source")) {
      try {
        const owner = await this.releaseHostOwner();
        if (owner !== undefined) {
          repo.hostRecoveryRequired = true;
          if (owner === `qualification:${state.candidate}:${this.receipt(state)}`) {
            await this.failedCampaignCleanup(state);
            repo.hostRecoveryRequired = false;
          }
        }
      } catch { repo.hostRecoveryRequired = true; }
    }
    return repo;
  }
  async announce(issue: number, body: string, marker: string): Promise<void> {
    const comments = await this.pages<{ body: string; user: { login: string } }>(`issues/${issue}/comments?per_page=100`);
    if (comments.some(comment => comment.user.login === this.config.bot && comment.body.includes(marker))) return;
    await this.gh(["api", "--method", "POST", `repos/${REPOSITORY}/issues/${issue}/comments`, "-f", `body=${body}`]);
  }
  async git(args: string[], cwd = ROOT): Promise<string> {
    return (await command(["git", ...args], cwd, this.env)).out;
  }
  async checkout(name: string, commit: string, branch?: string): Promise<string> {
    const directory = join(this.config.stateDir, "work", name);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await this.git(["fetch", "origin", "main", commit]);
    if (!await Bun.file(join(directory, ".git")).exists()) {
      const existingBranch = branch === undefined ? undefined : await command(["git", "rev-parse", "--verify", `refs/heads/${branch}`], ROOT, this.env, true);
      if (existingBranch?.code === 0) {
        if (existingBranch.out !== commit) throw new Error("orphaned driver branch differs from its pinned checkout source");
        await this.git(["worktree", "add", directory, branch!]);
      } else await this.git(["worktree", "add", ...(branch === undefined ? ["--detach"] : ["-b", branch]), directory, commit]);
    }
    return directory;
  }
  signingArgs(): string[] { return ["-c", "gpg.format=ssh", "-c", `user.signingkey=${this.config.signingKey}`]; }
  async push(ref: string, cwd = ROOT, expectedHead?: string): Promise<void> {
    if (!(ref.startsWith("refs/heads/release-driver/") || /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+(?:-prealpha\.[1-9][0-9]*)?$/u.test(ref))) throw new Error("driver refuses push outside owned release branches/tags");
    if (expectedHead !== undefined && !ref.startsWith("refs/heads/release-driver/")) throw new Error("driver refuses to replace release tags");
    await this.git(["push", ...(expectedHead === undefined ? [] : [`--force-with-lease=${ref}:${expectedHead}`]),
      `https://github.com/${REPOSITORY}.git`, `${expectedHead === undefined ? ref : "HEAD"}:${ref}`], cwd);
  }
  async assertGeneratedControls(pr: PullRequest): Promise<void> {
    const kind = generatedReleaseKind(pr.headRef);
    if (!generatedReleaseFilesMatch(kind, pr.files)) throw new RoutineHoldError("generated-content-mismatch");
    let base: string;
    if (kind === "record") {
      if (!pr.baseCommit) throw new RoutineHoldError("missing-evidence");
      const comparison = await this.api<{ merge_base_commit: { sha: string } }>(`compare/${pr.baseCommit}...${pr.head}`);
      if (!comparison?.merge_base_commit?.sha) throw new RoutineHoldError("missing-evidence");
      base = comparison.merge_base_commit.sha;
    } else base = await this.git(["rev-parse", "HEAD"]);
    const [trusted, candidate] = await Promise.all([this.controls(base, kind !== "record"), this.controls(pr.head)]);
    if ([...new Set([...trusted.keys(), ...candidate.keys()])].some(path => trusted.get(path) !== candidate.get(path))) throw new RoutineHoldError("generated-content-mismatch");
  }
  async assertCheckpointAuthor(head: string): Promise<void> {
    const commit = await this.api<{ author: { login: string } | null; commit: { verification: { verified: boolean } } }>("commits/" + head);
    if (commit?.author?.login !== this.config.bot || commit.commit.verification.verified !== true) throw new RoutineHoldError("pr-identity-changed");
  }
  async openPr(kind: "prepare" | "approve" | "record", state: DriverState, replace?: PullRequest): Promise<PullRequest> {
    if (replace !== undefined && kind !== "record") throw new Error("only record PRs may be regenerated");
    const branch = `release-driver/${state.issue.number}/${state.candidate}-${kind}`;
    const existing = await this.pages<ApiPr>(`pulls?state=all&base=main&head=carrythroughsystems:${encodeURIComponent(branch)}&per_page=100`);
    if (existing.length > 1) throw new Error("multiple PRs use the deterministic release branch");
    if (existing.length === 1) {
      const pr = await this.readPr(existing[0]!.number);
      if (pr.author !== this.config.bot || pr.headRepository !== REPOSITORY || pr.base !== "main" || pr.headRef !== branch) throw new RoutineHoldError("pr-identity-changed");
      await this.assertCheckpointAuthor(pr.head);
      await this.assertGeneratedControls(pr);
      if (replace === undefined || pr.merged) return pr;
      if (pr.number !== replace.number || pr.head !== replace.head || pr.tree !== replace.tree) throw new StaleIntentError("record PR changed before regeneration");
      if (pr.state !== "open" || pr.draft) throw new Error("record PR is not open for regeneration");
    }
    if (replace !== undefined && existing.length !== 1) throw new StaleIntentError("record PR disappeared before regeneration");
    const source = kind === "prepare" ? state.selectedMain : kind === "approve" ? state.candidateCommit!
      : (await this.api<{ sha: string }>("commits/main"))!.sha;
    const remote = await this.api<{ object: { sha: string } }>(`git/ref/heads/${branch}`, true);
    if (remote !== undefined) await this.assertCheckpointAuthor(remote.object.sha);
    if (replace !== undefined && remote?.object.sha !== replace.head) throw new StaleIntentError("record branch changed before regeneration");
    if (remote === undefined || replace !== undefined) {
      if (kind === "record" && (!state.smokedAt || !Number.isFinite(Date.parse(state.smokedAt))
        || new Date(state.smokedAt).toISOString() !== state.smokedAt)) throw new Error("record requires the persisted smoke completion time");
      // Adopt a pushed branch without a checkout; a source-keyed directory must never hold an older head.
      const directory = await this.checkout(`${state.issue.number}-${state.candidate}-${kind}${kind === "record" ? "-" + source : ""}`,
        source, kind === "record" ? undefined : branch);
      const args = [kind, kind === "prepare" ? state.version : `v${state.version}`,
        "--date", kind === "record" ? state.smokedAt!.slice(0, 10) : state.date];
      if (kind === "prepare") args.push("--candidate-tag", state.candidate, "--release-class", parseReleaseClass(state.issue.releaseClass));
      if (kind === "approve") args.push("--receipt", this.receipt(state), "--candidate-tag", state.candidate);
      if (kind === "record") args.push("--smoke", join(this.jobDirectory("smoke", state), "smoke.json"), "--status", join(this.jobDirectory("smoke", state), "status.json"), "--publication", join(this.config.stateDir, `${state.candidate}-publication.json`));
      // A committed local head is the crash checkpoint before a push; never regenerate its content.
      if (await this.git(["rev-parse", "HEAD"], directory) === source) {
        // Main is record data, not executable authority: never install or run its scripts as the bot.
        if (kind === "record") await runReleaseGenerate(args, directory);
        else {
          await command([process.execPath, "install", "--frozen-lockfile"], directory, this.env);
          await command([process.execPath, "scripts/release-generate.ts", ...args], directory, this.env);
        }
        await this.git(["add", "--all"], directory);
        const changed = await this.git(["diff", "--cached", "--name-only"], directory);
        if (changed === "") throw new Error("release generator produced no changes; refusing an empty release PR");
        await this.git([...this.signingArgs(), "commit", "-S", "-m", `${kind === "record" ? "docs" : "chore"}(release): ${kind} v${state.version}`], directory);
      }
      if (kind === "record") {
        if (await this.git(["rev-parse", "HEAD^"], directory) !== source) throw new Error("record checkpoint is not a single commit on its main source");
        await this.git(["verify-commit", "HEAD"], directory);
      }
      await this.push(`refs/heads/${branch}`, directory, kind === "record" ? remote?.object.sha ?? "" : undefined);
    }
    if (replace !== undefined) return this.readPr(replace.number);
    const created = await this.gh<ApiPr>(["api", "--method", "POST", `repos/${REPOSITORY}/pulls`, "-f", `title=${kind === "record" ? "docs" : "chore"}(release): ${kind} v${state.version}`, "-f", `head=${branch}`, "-f", "base=main", "-f", `body=Generated release ${kind} for #${state.issue.number}. ${kind === "approve" ? "Standing routine authority permits only the release bot to merge after exact-head/tree qualification, comparison, policy, smoke-plan and required checks." : "The release driver pins the head when merging."}`]);
    return this.readPr(created!.number);
  }
  receipt(state: DriverState): string { return join(homedir(), ".local/share/omp-session-gateway/qualification", state.candidate, "stable-qualification.json"); }
  async merge(pr: PullRequest, order: boolean): Promise<PullRequest> {
    const current = await this.readPr(pr.number);
    if (current.head !== pr.head || current.tree !== pr.tree) {
      if (current.merged) throw new Error("PR merged at a head other than the pinned one");
      throw new StaleIntentError("PR head changed before pinned merge");
    }
    if (order ? !isOrder(current) || outsideOrderScope(current).length > 0 : current.author !== this.config.bot || current.base !== "main" || current.headRepository !== REPOSITORY) throw new Error("PR identity/scope changed");
    if (!order) await this.assertGeneratedControls(current);
    if (current.merged) {
      if (current.mergedBy !== this.config.bot) throw new Error("driver-owned PR merged by another identity");
      return current;
    }
    if (current.state !== "open" || current.draft || current.behind || current.mergeable === false || current.mergeable === null || !current.checksPassed) throw new StaleIntentError("PR is not eligible for strict checked merge");
    await command(["gh", "pr", "merge", String(pr.number), "--repo", REPOSITORY, "--squash", "--match-head-commit", pr.head], ROOT, this.env);
    const merged = await this.readPr(pr.number);
    if (!merged.merged || merged.mergedBy !== this.config.bot) throw new Error("pinned merge is not observable as the release bot");
    return merged;
  }
  async tag(tag: string, source: string): Promise<void> {
    const remote = await this.api<{ ref: string; object: { sha: string; type: string } }>(`git/ref/tags/${tag}`, true);
    if (remote !== undefined) {
      const object = await this.api<{ tag: string; object: unknown; verification: unknown; tagger: { email: string } }>(`git/tags/${remote.object.sha}`);
      assertReleaseTagState(remote, object!, tag, source);
      if (object!.tagger.email !== this.email) throw new Error("existing release tag has another tagger");
      return;
    }
    await this.git(["fetch", "origin", "main", source]);
    const local = await command(["git", "rev-parse", "--verify", `refs/tags/${tag}^{commit}`], ROOT, this.env, true);
    if (local.code === 0) {
      if (local.out !== source) throw new Error("local release tag points at another source");
      await this.git(["tag", "-v", tag]);
    } else await this.git([...this.signingArgs(), "tag", "-s", "-m", `omp-session-gateway ${tag}`, tag, source]);
    await this.push(`refs/tags/${tag}`);
  }
  async verify(tag: string, source: string, stable: boolean, state: DriverState): Promise<string> {
    const version = state.version, names = releaseAssetNames(version);
    const directory = stable ? join(this.config.stateDir, `${tag}-assets`) : join(dirname(this.receipt(state)), "assets");
    const reference = (await this.api<{ ref: string; object: { sha: string; type: string } }>(`git/ref/tags/${tag}`))!;
    assertReleaseTagState(reference, (await this.api(`git/tags/${reference.object.sha}`)) as Parameters<typeof assertReleaseTagState>[1], tag, source);
    await downloadReleaseAssets(directory, () => command(["gh", "release", "download", tag, "--repo", REPOSITORY, "--dir", directory], ROOT, this.env));
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...names.all].sort())) throw new Error("published release has an unexpected asset set");
    await command(["gh", "release", "verify", tag, "--repo", REPOSITORY], ROOT, this.env);
    for (const asset of names.all) await command(["gh", "release", "verify-asset", tag, join(directory, asset), "--repo", REPOSITORY], ROOT, this.env);
    await command(["shasum", "-a", "256", "-c", "SHA256SUMS"], directory, this.env);
    for (const asset of names.attested) {
      await verifyReleaseSignatures(join(directory, asset), REPOSITORY, tag, argv => command(argv, ROOT, this.env));
    }
    const digest = createHash("sha256").update(await readFile(join(directory, names.archive))).digest("hex");
    const release = (await this.api<{ draft: boolean; prerelease: boolean; published_at: string; html_url: string; assets: { name: string; digest: string }[] }>(`releases/tags/${tag}`))!;
    if (release.draft || release.prerelease === stable || release.assets.find(asset => asset.name === names.archive)?.digest !== `sha256:${digest}`) throw new Error("published release flags or archive digest disagree");
    const latest = (await this.api<{ tag_name: string }>("releases/latest"))!;
    if ((latest.tag_name === tag) !== stable) throw new Error("release GitHub Latest state disagrees with its channel");
    if (stable) {
      const checkout = await this.checkout(`${tag}-rebuild`, source);
      if (await this.git(["rev-parse", "HEAD"], checkout) !== source) throw new Error("stable rebuild source changed");
      await command([process.execPath, "install", "--frozen-lockfile"], checkout, this.env);
      await command([process.execPath, "run", "release:build"], checkout, { ...this.env, OMP_RELEASE_CHANNEL: "stable" });
      const rebuilt = createHash("sha256").update(await readFile(join(checkout, "dist/release", names.archive))).digest("hex");
      if (rebuilt !== digest) throw new Error("stable rebuilt digest differs from published archive");
      const runs = (await this.api<{ workflow_runs: WorkflowRun[] }>(`actions/workflows/signed-release.yml/runs?event=push&head_sha=${source}&per_page=100`))!;
      const run = runs.workflow_runs.find(run => run.head_branch === tag && run.head_sha === source && run.conclusion === "success");
      if (run === undefined) throw new Error("stable publication workflow disappeared");
      await atomicJson(join(this.config.stateDir, `${state.candidate}-publication.json`), { tag, sourceCommit: source, archiveSha256: digest, runUrl: run.html_url, releaseUrl: release.html_url, publishedAt: release.published_at });
    }
    return digest;
  }
  async campaignLaunchState(state: DriverState): Promise<DriverState> {
    const prior = await jsonFile<JobSpec>(join(this.jobDirectory("campaign", state), "spec.json"));
    const macHost = state.macHost ?? prior?.state.macHost ?? this.env.OMP_STABLE_MAC_HOST;
    if (macHost === undefined || macHost.includes(".example.") || !/^[A-Za-z_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(macHost)) {
      throw new Error("configure OMP_STABLE_MAC_HOST with the retained qualification target before arming");
    }
    const bound = { ...state, macHost };
    if (prior?.state.qualificationExecution !== undefined) {
      if (!qualificationExecutionsMatch(prior.state.qualificationExecution, campaignExecution(bound))) throw new Error("immutable campaign execution changed");
      return { ...bound, qualificationExecution: prior.state.qualificationExecution };
    }
    if (bound.qualificationExecution !== undefined) {
      if (!qualificationExecutionsMatch(bound.qualificationExecution, campaignExecution(bound))) throw new Error("campaign execution changed");
      return bound;
    }
    // Never upgrade an existing legacy spec, including spec-only failed launches.
    if (prior !== undefined || campaignAttempt(bound) !== 0) return bound;
    return await this.candidateSupportsExecution(bound) ? { ...bound, qualificationExecution: campaignExecution(bound) } : bound;
  }
  async candidateSupportsExecution(state: DriverState): Promise<boolean> {
    const file = await this.api<{ content: string }>(`contents/scripts/stable-qualification.ts?ref=${state.candidateCommit}`);
    return file !== undefined && /^export const QUALIFICATION_EXECUTION_FORMAT = 1;/mu.test(Buffer.from(file.content, "base64").toString());
  }
  assertJobBinding(prior: JobSpec | undefined, kind: JobSpec["kind"], state: DriverState): void {
    const pending = state.retryPlan !== undefined && state.retryPlan.nextAttempt === campaignAttempt(state) + 1;
    if (prior?.kind !== kind || prior.root !== ROOT || this.jobDirectory(kind, prior.state) !== this.jobDirectory(kind, state) ||
      prior.state.candidateCommit !== state.candidateCommit || prior.state.candidateDigest !== state.candidateDigest ||
      prior.state.authorityPolicy !== state.authorityPolicy || prior.state.previousStable !== state.previousStable ||
      prior.state.stableCommit !== state.stableCommit || prior.state.stableDigest !== state.stableDigest ||
      (kind === "approve" && (prior.state.approvedHead !== state.approvedHead || prior.state.approvedTree !== state.approvedTree)) ||
      (kind === "campaign" && (prior.state.macHost !== state.macHost || prior.state.resumeDeviceCloud !== state.resumeDeviceCloud ||
        JSON.stringify(prior.state.qualificationExecution) !== JSON.stringify(state.qualificationExecution) ||
        (!pending && (JSON.stringify(prior.state.retryPlan) !== JSON.stringify(state.retryPlan) || prior.state.retryNotBefore !== state.retryNotBefore))))) {
      throw new StaleIntentError("immutable release job specification differs from its launch binding");
    }
  }
  async launch(kind: JobSpec["kind"], state: DriverState): Promise<void> {
    const directory = this.jobDirectory(kind, state);
    await privateDirectory(directory);
    const prior = await jsonFile<JobSpec>(join(directory, "spec.json"));
    if (prior !== undefined && kind !== "approve") this.assertJobBinding(prior, kind, state);
    if (await Bun.file(join(directory, "result.json")).exists() ||
      (await command(["tmux", "has-session", "-t", this.session(kind, state)], ROOT, this.env, true)).code === 0 ||
      (kind !== "approve" && await Bun.file(join(directory, "started")).exists())) {
      this.assertJobBinding(prior, kind, state);
      return; // A valid start claim is a no-relaunch fence, never evidence of action absence.
    }
    const specification = { kind, state, root: ROOT } satisfies JobSpec;
    if (kind === "approve") await atomicJson(join(directory, "spec.json"), specification);
    else if (!await immutableJobJson(join(directory, "spec.json"), specification)) {
      const prior = await jsonFile<JobSpec>(join(directory, "spec.json"));
      this.assertJobBinding(prior, kind, state);
      // A spec is preparation, not a worker start claim: an unclaimed, sessionless launch can replay.
    }
    const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
    const launcher = `${quote(process.execPath)} ${quote(join(ROOT, "scripts/release-driver.ts"))} worker ${quote(join(directory, "spec.json"))} >>${quote(join(directory, "out.log"))} 2>>${quote(join(directory, "err.log"))}`;
    const workerEnvironment = { PATH: this.env.PATH ?? "", OMP_RELEASE_BOT_LOGIN: this.config.bot, OMP_RELEASE_FOUNDER_LOGIN: this.config.founder, OMP_RELEASE_GH_CONFIG_DIR: this.config.ghConfig, OMP_RELEASE_SIGNING_KEY: this.config.signingKey, OMP_RELEASE_STATE_DIR: this.config.stateDir, OMP_STABLE_MAC_HOST: kind === "campaign" ? state.macHost ?? "" : this.env.OMP_STABLE_MAC_HOST ?? "", OMP_STABLE_MAC_MODEL: this.env.OMP_STABLE_MAC_MODEL ?? "VirtualMac2,1" };
    await command(["tmux", "new-session", "-d", "-s", this.session(kind, state), ...Object.entries(workerEnvironment).flatMap(([key, value]) => ["-e", `${key}=${value}`]), launcher], ROOT, this.env);
  }
  requireSourceAuthority(authority: RoutineAuthority, expected?: string): void {
    const reason = routineSourceHold(authority, expected);
    if (reason !== undefined) throw new RoutineHoldError(reason, authority.unreviewedCommit);
  }
  async perform(step: Decision, state: DriverState): Promise<Partial<DriverState>> {
    if (this.plan) throw new Error("plan attempted a release effect");
    switch (step.operation) {
      case "schedule-campaign-retry": {
        if (step.patch?.retryNotBefore !== state.retryNotBefore || !Number.isSafeInteger(state.retryNotBefore) ||
          state.retryNotBefore! < 0) throw new StaleIntentError("campaign retry deadline changed");
        await this.validateCampaignRetry(state);
        const directory = this.jobDirectory("campaign", campaignRetryLaunchState(state));
        if (await lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }) !== undefined) throw new StaleIntentError("retry job identity is already occupied");
        return {};
      }
      case "rerequest": {
        const current = { ...state };
        delete current.intent;
        const repo = await this.snapshot(current);
        const assertRetry = (observation: RepositorySnapshot) => {
          const retry = nextStep(current, observation, this.config);
          if (retry.operation !== "rerequest" || retry.patch?.selectedMain !== step.patch?.selectedMain ||
            retry.patch?.candidate !== step.patch?.candidate || retry.patch?.issue?.number !== step.patch?.issue?.number ||
            retry.patch?.issue?.request !== step.patch?.issue?.request) throw new StaleIntentError("retry subject changed");
          const orphan = observation.prepare?.merged ? undefined : observation.prepare;
          if (orphan?.number !== step.pr?.number) throw new StaleIntentError("new orphan prepare requires a pinned retirement plan");
        };
        const assertOrphan = (orphan: PullRequest | undefined) => {
          if (step.pr === undefined) return undefined;
          if (!orphan || orphan.merged || (state.preparePr !== undefined && orphan.number !== state.preparePr) || orphan.number !== step.pr.number || orphan.head !== step.pr.head ||
            orphan.author !== this.config.bot || orphan.base !== "main" || orphan.headRepository !== REPOSITORY ||
            orphan.headRef !== `release-driver/${state.issue.number}/${state.candidate}-prepare`) throw new StaleIntentError("orphan prepare identity changed");
          return orphan;
        };
        const prepareNumber = state.preparePr ?? step.pr?.number;
        const assertUnpublished = async () => {
          if (await this.api(`git/ref/tags/v${state.version}`, true) !== undefined ||
            await this.api(`releases/tags/v${state.version}`, true) !== undefined) throw new StaleIntentError("stable publication already exists; preserve the immutable release");
        };
        const revalidate = async () => {
          const [issues, prepare, tags] = await Promise.all([
            this.issues(current.issue), this.prepareObservation({ ...current, ...(prepareNumber === undefined ? {} : { preparePr: prepareNumber }) }),
            this.pages<{ name: string }>("tags?per_page=100"),
          ]);
          // Recompute nextCandidate through nextStep; a newly published prealpha reserves its ordinal.
          assertRetry({ ...repo, issues, tags: tags.map(tag => tag.name), ...(prepare === undefined ? {} : { prepare }) });
          const orphan = assertOrphan(prepare);
          await assertUnpublished();
          return orphan;
        };
        assertRetry(repo);
        assertOrphan(repo.prepare);
        const next = applyDecisionPatch(state, step);
        this.requireSourceAuthority(await this.authority(next, repo.main), state.authorityPolicy);
        await assertUnpublished();
        await this.recoverFailedCampaign(state);
        let orphan = await revalidate();
        if (orphan) {
          const marker = `<!-- release-driver-retire:${state.issue.number}:${state.candidate} -->`;
          await this.announce(orphan.number, `release-driver: retire unmerged prepare after a landed fix; request #${next.issue.number} continues with ${next.candidate}\n${marker}`, marker);
          orphan = await revalidate();
          if (orphan?.state === "open") await this.gh(["api", "--method", "PATCH", `repos/${REPOSITORY}/pulls/${orphan.number}`, "-f", "state=closed"]);
        }
        // Preserve the failed selection if the issue closed or prepare merged while
        // cleanup/comment/close settled. Those idempotent retirements stay reconciled.
        await revalidate();
        return {};
      }
      case "update-order":
      case "update-release-pr": {
        const pr = await this.readPr(step.pr!.number);
        if (step.operation === "update-order" ? !isOrder(pr) || outsideOrderScope(pr).length > 0 : pr.author !== this.config.bot || pr.base !== "main" || pr.headRepository !== REPOSITORY) throw new Error("PR scope/identity changed");
        if (step.operation === "update-release-pr" && state.phase === "record-open") {
          if (pr.head !== step.pr!.head || pr.merged || pr.mergeable === null || (!pr.behind && pr.mergeable !== false)) return {};
          await this.openPr("record", state, pr);
          return {};
        }
        if (pr.head !== step.pr!.head || !pr.behind) return {};
        if (!pr.checksPassed) throw new Error("order checks no longer pass");
        await this.gh(["api", "--method", "PUT", `repos/${REPOSITORY}/pulls/${pr.number}/update-branch`, "-f", `expected_head_sha=${pr.head}`]);
        return {};
      }
      case "ready-order": {
        const pr = await this.readPr(step.pr!.number);
        if (!isOrder(pr) || outsideOrderScope(pr).length > 0) throw new Error("order identity/scope changed before ready");
        if (pr.head !== step.pr!.head || !pr.checksPassed) throw new StaleIntentError("order moved before ready");
        if (pr.draft) await command(["gh", "pr", "ready", String(pr.number), "--repo", REPOSITORY], ROOT, this.env);
        return {};
      }
      case "merge-order": await this.merge(step.pr!, true); return {};
      case "open-prepare": {
        const main = (await this.api<{ sha: string }>("commits/main"))!.sha;
        const authority = await this.authority(state, main);
        this.requireSourceAuthority(authority, state.authorityPolicy);
        return { preparePr: (await this.openPr("prepare", state)).number, authorityPolicy: authority.policy };
      }
      case "merge-prepare": {
        const current = await this.readPr(step.pr!.number);
        const main = (await this.api<{ sha: string }>("commits/main"))!.sha;
        if (main !== (current.merged ? current.mergeCommit : state.selectedMain)) throw new RoutineHoldError("stale-source");
        return { candidateCommit: (await this.merge(step.pr!, false)).mergeCommit };
      }
      case "tag-candidate": {
        const pr = await this.readPr(state.preparePr!);
        if (!pr.merged || pr.mergedBy !== this.config.bot || pr.mergeCommit !== state.candidateCommit || pr.mergeTree !== pr.tree) throw new RoutineHoldError("merge-tree-changed");
        this.requireSourceAuthority(await this.authority(state, (await this.api<{ sha: string }>("commits/main"))!.sha, pr), state.authorityPolicy);
        await this.tag(state.candidate, state.candidateCommit!); return {};
      }
      case "verify-candidate": return { candidateDigest: await this.verify(state.candidate, state.candidateCommit!, false, state) };
      case "start-campaign": {
        let bound: DriverState;
        try {
          const launchState = state.retryPlan === undefined ? state : campaignRetryLaunchState(state);
          bound = await this.campaignLaunchState(launchState);
        } catch (error) {
          if (state.retryPlan !== undefined) throw new StaleIntentError("campaign retry launch binding changed");
          throw error;
        }
        if (bound.retryPlan !== undefined) {
          parseCampaignRetryPlan(bound.retryPlan, bound);
          if (!Number.isSafeInteger(bound.retryNotBefore) || Date.now() < bound.retryNotBefore!) throw new StaleIntentError("campaign retry backoff pending");
          const directory = this.jobDirectory("campaign", bound);
          // A claimed or live launch is reconciliation, not fresh authorization. Its receipt may
          // already have advanced; never revalidate it against the previous working bytes.
          if (!await Bun.file(join(directory, "started")).exists() && !await Bun.file(join(directory, "result.json")).exists() &&
            !await this.campaignWorkerRunning(bound)) await this.validateCampaignRetry(bound);
        }
        await this.launch("campaign", bound);
        return { macHost: bound.macHost, ...(bound.retryPlan === undefined ? {} : { campaignAttempt: campaignAttempt(bound) }),
          ...(bound.qualificationExecution === undefined ? {} : { qualificationExecution: bound.qualificationExecution }) };
      }
      case "open-approve": return { approvePr: (await this.openPr("approve", state)).number };
      case "start-approve-checks": await this.launch("approve", applyDecisionPatch(state, step)); return {};
      case "merge-approve": {
        const repo = await this.promotionSnapshot(state);
        const reason = promotionHold(state, repo, this.config);
        if (reason !== undefined) throw new RoutineHoldError(reason, repo.authority?.unreviewedCommit);
        const pr = await this.merge(repo.approve!, false);
        const after = await this.promotionSnapshot({ ...state, stableCommit: pr.mergeCommit });
        const changed = promotionHold({ ...state, stableCommit: pr.mergeCommit }, after, this.config, true);
        if (changed !== undefined) throw new RoutineHoldError(changed, after.authority?.unreviewedCommit);
        return { stableCommit: pr.mergeCommit };
      }
      case "tag-stable": {
        const repo = await this.promotionSnapshot(state);
        const reason = promotionHold(state, repo, this.config, true);
        if (reason !== undefined) throw new RoutineHoldError(reason, repo.authority?.unreviewedCommit);
        await this.tag(`v${state.version}`, state.stableCommit!); return {};
      }
      case "verify-stable": return { stableDigest: await this.verify(`v${state.version}`, state.stableCommit!, true, state) };
      case "start-smoke": await this.launch("smoke", state); return {};
      case "open-record": return { recordPr: (await this.openPr("record", state)).number };
      case "merge-record": await this.merge(step.pr!, false); return {};
      case "close":
        for (const issue of await this.issues(state.issue)) if (compareVersions(requestVersion(issue)!, requestVersion(state.issue)!) <= 0
          && (issue.releaseClass !== "minor" || state.issue.releaseClass === "minor")) {
          const body = `release-driver: closed — fulfilled by v${state.version}\nhttps://github.com/${REPOSITORY}/releases/tag/v${state.version}\n<!-- release-driver-close:${state.issue.number}:${issue.number}:${state.version} -->`;
          // The selected issue receives its single transition comment through the state outbox.
          if (issue.number !== state.issue.number) await this.announce(issue.number, body, `<!-- release-driver-close:${state.issue.number}:${issue.number}:${state.version} -->`);
          await this.gh(["api", "--method", "PATCH", `repos/${REPOSITORY}/issues/${issue.number}`, "-f", "state=closed", "-f", "state_reason=completed"]);
        }
        return {};
      default: return {};
    }
  }
  async worker(specPath: string): Promise<void> {
    const spec = await jsonFile<JobSpec>(specPath);
    if (spec === undefined || spec.root !== ROOT || specPath !== join(this.jobDirectory(spec.kind, spec.state), "spec.json")) throw new Error("worker specification is outside its owned job directory");
    const directory = dirname(specPath), state = spec.state;
    try { const claim = await open(join(directory, "started"), "wx", 0o600); await claim.close(); }
    catch (error) {
      // Only pure local approve checks can replay after their tmux owner disappeared.
      if (spec.kind !== "approve" || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let observedCampaignExit: number | undefined, exitCode = 1;
    const qualificationOut = new CommandOutputTail(), qualificationErr = new CommandOutputTail();
    let smokeOut: Buffer = Buffer.alloc(0), smokeErr: Buffer = Buffer.alloc(0), smokeFailure: Error | undefined;
    let terminal: JobObservation & { evidence?: RoutineEvidence } = { status: "failed",
      detail: spec.kind === "campaign" ? "campaign harness:unclassified_failure" : `${spec.kind} failed; inspect private job logs; no retry` };
    try {
      await this.authenticate();
      const source = spec.kind === "campaign" ? state.candidateCommit! : spec.kind === "approve" ? state.approvedHead! : state.stableCommit!;
      const retry = spec.kind === "campaign" && campaignAttempt(state) > 0 ? `-retry-${campaignAttempt(state)}` : "";
      const branch = spec.kind === "campaign" ? `release-driver/${state.issue.number}/${state.candidate}-campaign${retry}` : undefined;
      const checkout = await this.checkout(this.jobCheckoutName(spec.kind, state), source, branch);
      if (await this.git(["rev-parse", "HEAD"], checkout) !== source) throw new Error("job checkout is not its pinned source");
      await command([process.execPath, "install", "--frozen-lockfile"], checkout, this.env);
      if (spec.kind === "campaign") {
        await this.push(`refs/heads/${branch!}`, checkout);
        const macHost = state.macHost;
        if (!macHost || macHost.includes(".example.")) throw new Error("configure OMP_STABLE_MAC_HOST with the retained qualification target before arming");
        const env = { ...this.env, OMP_STABLE_MAC_HOST: macHost, OMP_STABLE_MAC_MODEL: this.env.OMP_STABLE_MAC_MODEL ?? "VirtualMac2,1", OMP_STABLE_OP_TOKEN_FILE: join(homedir(), ".local/state/omp-session-gateway/op-service-account.token") };
        await command(["security", "unlock-keychain", "-p", "", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, env);
        await command(["security", "set-keychain-settings", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, env);
        const executionPath = join(directory, "execution.json");
        if (state.qualificationExecution !== undefined) {
          if (!qualificationExecutionsMatch(state.qualificationExecution, campaignExecution(state))) throw new Error("campaign execution binding changed");
          if (!await immutableJobJson(executionPath, state.qualificationExecution)) throw new Error("campaign execution already exists");
        }
        if (state.retryPlan?.outcome.scope === "preflight") {
          const plan = parseCampaignRetryPlan(state.retryPlan, state);
          const prior = { ...state, campaignAttempt: plan.outcome.execution.campaignAttempt };
          const bytes = await readFile(join(this.jobDirectory("campaign", prior), "failure-outcome.json"));
          if (createHash("sha256").update(bytes).digest("hex") !== plan.outcomeSha256 ||
            JSON.stringify(parseQualificationOutcome(parseRetainedVendorJson(bytes.toString()), plan.outcome.execution)) !== JSON.stringify(plan.outcome) ||
            !await immutableJobBytes(join(directory, "retry-preflight-outcome.json"), bytes)) throw new Error("prior preflight snapshot is invalid");
        }
        const runCampaign = async (flags: string[]) => {
          const outcomePath = join(directory, flags.includes("--preflight") ? "preflight-outcome.json" : "campaign-outcome.json");
          if (await lstat(outcomePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          }) !== undefined) throw new Error("stable machine outcome already exists in this immutable job phase");
          const code = await commandTail([process.execPath, "run", "qualify:stable", "--", "--tag", state.candidate, ...flags], checkout,
            { ...env, OMP_STABLE_OUTCOME_FILE: outcomePath }, qualificationOut, qualificationErr);
          if (code !== 0) observedCampaignExit = code;
          if (code !== 0 && state.qualificationExecution !== undefined) {
            const expected = campaignExecution(state), outcome = await readQualificationOutcomeFile(outcomePath, expected);
            const original = await readFile(outcomePath);
            if (code !== qualificationOutcomeExitCode(outcome, expected) ||
              JSON.stringify(parseQualificationOutcome(parseRetainedVendorJson(original.toString()), expected)) !== JSON.stringify(outcome) ||
              (outcome.scope === "preflight") !== (outcome.receipt === undefined) ||
              (flags.includes("--preflight") && outcome.scope !== "preflight")) throw new Error("qualification terminal evidence disagrees");
            if (outcome.receipt !== undefined) {
              const bytes = await readFile(this.receipt(state));
              const receipt = validateStableQualificationReceipt(JSON.parse(bytes.toString()), state.candidate, state.candidateCommit!, state.previousStable!);
              if (createHash("sha256").update(bytes).digest("hex") !== outcome.receipt.sha256 || receipt.status !== "failed" ||
                !qualificationExecutionsMatch(receipt.execution, expected) ||
                outcome.scope !== (receipt.rigReadiness?.status === "failed" ? "rigReadiness" : "campaign") ||
                JSON.stringify(receipt.failureSummary) !== JSON.stringify(outcome.failureSummary)) throw new Error("failed receipt snapshot is invalid");
              if (code === 75) {
                if (expected.campaignAttempt === 2) this.campaignCleanupComplete(receipt, state);
                else if (this.campaignRetryLanes(receipt, state).length === 0) throw new Error("failed receipt has no restart lanes");
              }
              if (!await immutableJobBytes(join(directory, "failed-qualification.json"), bytes)) throw new Error("failed receipt snapshot already exists");
            } else if (await Bun.file(this.receipt(state)).exists()) throw new Error("preflight failure has a working receipt");
            if (!await immutableJobBytes(join(directory, "failure-outcome.json"), original)) throw new Error("failed outcome already exists");
            throw new CampaignFailureResult(outcome, code);
          }
          if (code === 75) {
            const receipt = await jsonFile<StableQualificationReceipt>(this.receipt(state));
            const hold = this.campaignHoldObservation(state, await readDeviceCloudOutcomeFile(outcomePath), receipt);
            if (hold.scope === "receipt") {
              const archivePath = join(directory, "held-qualification.json");
              if (!await immutableJobJson(archivePath, receipt)) throw new Error("held receipt archive already exists");
            }
            throw new CampaignAvailabilityResult(hold);
          }
          if (code !== 0) throw new Error(`stable qualification exited ${code}; inspect private job logs`, {
            cause: { out: qualificationOut.bytes().toString().trim(), err: qualificationErr.bytes().toString() },
          });
        };
        // Every retry consumes predecessor authority before its own in-process admission.
        if (!state.resumeDeviceCloud && campaignAttempt(state) === 0) await runCampaign(campaignWorkerArguments(state, executionPath, true));
        await runCampaign(campaignWorkerArguments(state, executionPath));
        const receipt = await jsonFile<StableQualificationReceipt>(this.receipt(state));
        if (receipt?.status !== "passed" || receipt.schemaVersion !== 3 || receipt.tag !== state.candidate || receipt.candidate?.sourceCommit !== state.candidateCommit || receipt.candidate?.archiveSha256 !== state.candidateDigest || Object.values(receipt.lanes).some(lane => lane.status !== "passed")) throw new Error("qualification receipt is not fully passed and candidate-bound");
        if (state.qualificationExecution !== undefined && !qualificationExecutionsMatch(receipt.execution, campaignExecution(state))) throw new Error("passed receipt execution changed");
      } else if (spec.kind === "approve") {
        const pr = await this.readPr(state.approvePr!);
        if (pr.head !== state.approvedHead || pr.tree !== state.approvedTree) throw new RoutineHoldError("head-tree-changed");
        this.requireSourceAuthority(await this.authority(state, (await this.api<{ sha: string }>("commits/main"))!.sha, pr), state.authorityPolicy);
        await command([process.execPath, "run", "release:build"], checkout, { ...this.env, OMP_RELEASE_CHANNEL: "stable" });
        const names = releaseAssetNames(state.version);
        const compared = await compareReleaseArchives(join(dirname(this.receipt(state)), "assets", names.archive), state.candidateDigest!, join(checkout, "dist/release", names.archive));
        if (compared.differing.length !== 0) throw new Error("approve runtime differs from the qualified candidate");
        await command([process.execPath, "scripts/release-policy.ts", `v${state.version}`, state.version, "STABLE_RELEASE.lock.json"], checkout, this.env);
        await command([process.execPath, "run", "smoke:release", "--", "--tag", `v${state.version}`, "--plan"], checkout, this.env);
        await command([process.execPath, "run", "check"], checkout, this.env);
      } else {
        await command(["security", "unlock-keychain", "-p", "", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, this.env);
        await command(["security", "set-keychain-settings", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, this.env);
        // --force-reinstall: a retried smoke finds the release already active from the failed run,
        // and the record requires smoke evidence that this run installed the published bytes.
        const smoke = await command([process.execPath, "run", "smoke:release", "--", "--tag", `v${state.version}`, "--archive-sha256", state.stableDigest!, "--force-reinstall", "--rebuild-omp"],
          checkout, { ...this.env, OMP_RELEASE_SMOKE_LOG_DIR: join(directory, "smoke-logs") }, false, (out, err) => {
            smokeOut = commandOutputTail(smokeOut, out);
            smokeErr = commandOutputTail(smokeErr, err);
          });
        await atomicJson(join(directory, "smoke.json"), JSON.parse(smoke.out));
        const installation = join(homedir(), ".local/state/omp-session-gateway/installation");
        const active = (await jsonFile<{ versionDirectory?: string }>(join(installation, "current.json")))?.versionDirectory;
        if (active === undefined || !/^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$/u.test(active)) throw new Error("installed gateway active version is missing or invalid");
        const status = await command([join(homedir(), ".local/lib/omp-session-gateway/bun", `v${PINNED_BUN_VERSION}`, "bun"), join(installation, "versions", active, "apps/gateway/src/cli.js"), "status"], checkout, this.env);
        await atomicJson(join(directory, "status.json"), JSON.parse(status.out));
      }
      const evidence: RoutineEvidence | undefined = spec.kind === "approve" ? {
        head: state.approvedHead!, tree: state.approvedTree!, candidate: state.candidate,
        candidateCommit: state.candidateCommit!, candidateDigest: state.candidateDigest!, policy: state.authorityPolicy!,
        steps: ROUTINE_EVIDENCE_STEPS,
      } : undefined;
      terminal = { status: "passed", ...(evidence === undefined ? {} : { evidence }),
        ...(spec.kind === "smoke" ? { completedAt: new Date().toISOString() } : {}) };
      exitCode = 0;
    } catch (error) {
      exitCode = observedCampaignExit ?? 1;
      if (error instanceof CampaignFailureResult) {
        await atomicJson(join(directory, "diagnostic.json"), { failureSummary: error.outcome.failureSummary });
        terminal = { status: "failed" };
        exitCode = error.exitCode;
      } else if (error instanceof CampaignAvailabilityResult) {
        terminal = { status: "infrastructure-hold", availabilityHold: error.hold };
        exitCode = 75;
      } else {
        if (spec.kind === "smoke") smokeFailure = new Error("release smoke failed", { cause: error });
        console.error("release job failed; private evidence required");
        await atomicJson(join(directory, "diagnostic.json"), { class: "harness", reason: "unclassified_failure" });
      }
    } finally {
      process.exitCode = exitCode;
      if (spec.kind === "campaign") {
        // Preserve exact child bytes across preflight and campaign before publishing any terminal marker.
        await retainJobDiagnostics(directory, "qualification", qualificationOut.bytes(), qualificationErr.bytes());
      } else if (spec.kind === "smoke") {
        await retainJobDiagnostics(directory, "smoke", smokeOut, smokeErr, smokeFailure);
      }
      // A terminal result is the publication marker: its durable exit must already exist.
      await atomicJson(join(directory, "exit"), exitCode);
      await atomicJson(join(directory, "result.json"), terminal);
    }
  }
}

async function drive(args: string[]): Promise<unknown> {
  const [mode, spec, ...extra] = args;
  const retry = mode === "retry-device-cloud";
  const prune = mode === "prune";
  let retryCandidate: string | undefined;
  let retryAttempt: number | undefined;
  if (retry) {
    if (args.length !== 5 || spec !== "--candidate" || args[3] !== "--job-attempt" ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+-prealpha\.[1-9][0-9]*$/u.test(args[2] ?? "") || !/^(?:0|[1-9][0-9]*)$/u.test(args[4] ?? "")) {
      throw new Error("usage: release-driver retry-device-cloud --candidate <exact-tag> --job-attempt <current-attempt>");
    }
    retryCandidate = args[2];
    retryAttempt = Number(args[4]);
    if (!Number.isSafeInteger(retryAttempt) || retryAttempt > 10_000) throw new Error("invalid retry job attempt");
  } else if (prune ? extra.length > 0 || (spec !== undefined && spec !== "--apply") :
    !["plan", "status", "tick", "worker"].includes(mode ?? "") || extra.length > 0 || (mode === "worker") !== (spec !== undefined)) {
    throw new Error("usage: bun scripts/release-driver.ts plan|status|tick|prune [--apply]|worker <private-spec-path>|retry-device-cloud --candidate <tag> --job-attempt <n>");
  }
  const config = driverConfig(), plan = mode === "plan" || mode === "status" || (prune && spec === undefined) || config.dryRun;
  const driver = new StudioDriver(config, plan);
  if (prune && plan) {
    if (spec === "--apply") throw new Error("disable OMP_RELEASE_DRY_RUN before applying work pruning");
    return driver.pruneWork();
  }
  if (plan) {
    const readiness = await driver.readiness(await driver.load());
    if (mode === "status") {
      const state = await driver.load();
      return { readiness, phase: state?.phase, candidate: state?.candidate, intent: state?.intent?.operation,
        holdReason: state?.holdReason, holdCommit: state?.holdCommit, infrastructureHold: state?.infrastructureHold,
        campaignAttempt: state === undefined ? undefined : campaignAttempt(state), outboxPending: state?.announcement !== undefined };
    }
    return { ...await tick(driver, config, true), readiness };
  }
  if (process.platform !== "darwin" || (await command([process.execPath, "--version"], ROOT, process.env)).out !== PINNED_BUN_VERSION) throw new Error(`release driver writes require the Studio Darwin host and Bun ${PINNED_BUN_VERSION}`);
  if (!prune && await Bun.file(join(config.stateDir, "disabled")).exists()) return { operation: "idle", detail: "kill switch is enabled" };
  await privateDirectory(config.stateDir);
  if (mode === "worker") { await driver.worker(spec!); return { operation: "worker", completed: true }; }
  const lockPath = join(config.stateDir, "tick.sqlite");
  try { const file = await open(lockPath, "wx", 0o600); await file.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const lock = new Database(lockPath);
  try {
    lock.exec("PRAGMA busy_timeout=1000");
    lock.exec("BEGIN IMMEDIATE");
    if (prune) return await driver.pruneWork(true);
    const state = await driver.load();
    const readiness = await driver.readiness(state);
    await atomicJson(join(config.stateDir, "readiness.json"), readiness);
    if ((state === undefined || state.phase === "closed") && !readiness.ready) return { operation: "idle", detail: "blocked-prerequisite; inspect readiness.json", readiness };
    await driver.authenticate();
    if (retry) {
      const authorized = await driver.authorizeDeviceCloudRetry(retryCandidate!, retryAttempt!);
      return { operation: "retry-device-cloud-authorized", candidate: authorized.candidate, campaignAttempt: campaignAttempt(authorized) };
    }
    return await tick(driver, config);
  } finally { lock.close(); }
}

/** Keep one bounded operator log; campaign/device evidence stays in private per-job receipts. */
export async function runDriver(args: string[]): Promise<unknown> {
  const config = driverConfig();
  const log = async (entry: unknown) => {
    if (args[0] === "plan" || args[0] === "status" || (args[0] === "prune" && args[1] !== "--apply") || config.dryRun) return;
    try { if (!(await lstat(config.stateDir)).isDirectory()) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const path = join(config.stateDir, "driver.log");
    let previous = "";
    try { previous = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const line = JSON.stringify({ at: new Date().toISOString(), ...(typeof entry === "object" && entry !== null ? entry : { entry }) }) + "\n";
    await writeFile(path, (previous + line).slice(-262144), { mode: 0o600 });
  };
  try { const result = await drive(args); await log(result); return result; }
  catch (error) { await log({ error: error instanceof Error ? error.message : String(error) }); throw error; }
}
