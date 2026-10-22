import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ORDER_AUTHOR, ORDER_HEAD_PREFIX, REPOSITORY, StaleIntentError, campaignAttempt, compareVersions, isOrder, outsideOrderScope, parseCampaignInfrastructureHold, requestVersion, promotionHold, tick } from "./release-driver.ts";
import type { CampaignInfrastructureHold, Decision, DriverConfig, DriverPort, DriverState, JobObservation, PullRequest, RepositorySnapshot, TrackingIssue } from "./release-driver.ts";
import { assertReleaseTagState } from "./release-tag-state.ts";
import { releaseAssetNames, verifyReleaseSignatures } from "./post-release-smoke.ts";
import { downloadReleaseAssets } from "./release-download.ts";
import { compareReleaseArchives } from "./release-runtime-compare.ts";
import { assertDeviceCloudResumeEligible, validateStableQualificationReceipt, type StableQualificationLaneModules, type StableQualificationReceipt } from "./stable-qualification.ts";
import { parseDeviceCloudMachineOutcome, readDeviceCloudOutcomeFile } from "./device-cloud-outcome.ts";
import { nextReleaseVersion, parseReleaseClass, REQUIRED_CHECKS, ROUTINE_BRANCH_PROTECTION, routineBranchProtectionMatches, ROUTINE_EVIDENCE_STEPS, RoutineHoldError, routineProtectedPath, routineSourceHold, generatedReleaseKind, generatedReleaseFilesMatch } from "./release-policy.ts";
import type { RoutineAuthority, RoutineEvidence } from "./release-policy.ts";
import { runAdb } from "./android-device.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  for (const path of [config.ghConfig, config.signingKey, config.stateDir]) if (!isAbsolute(path)) throw new Error("driver paths must be absolute");
  return config;
}
/** Never let ambient founder tokens or git identity override the dedicated machine account. */
export function botEnvironment(config: RuntimeConfig, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ambient, GH_CONFIG_DIR: config.ghConfig, GH_HOST: "github.com", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_COUNT", "OMP_STABLE_PREVIOUS_TAG", "OMP_STABLE_MAC_SUDO_PASSWORD_FILE", "OMP_STABLE_QUALIFICATION_DIR", "OMP_STABLE_OUTCOME_FILE"]) delete env[key];
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_/u.test(key)) delete env[key];
  return env;
}
async function command(argv: string[], cwd: string, env: NodeJS.ProcessEnv, allowedFailure = false): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0 && !allowedFailure) throw new Error(`${argv[0]} ${argv[1] ?? ""} exited ${code}; inspect the private release-driver job logs`, { cause: { out: out.slice(-262144), err: err.slice(-262144) } });
  return { code, out: out.trim(), err };
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
  const parent = await open(dirname(path), "r");
  try { await parent.sync(); } finally { await parent.close(); }
}
async function immutableJobJson(path: string, value: unknown): Promise<boolean> {
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  const parent = await open(dirname(path), "r");
  try { await parent.sync(); } finally { await parent.close(); }
  return true;
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
  base: { ref: string }; draft: boolean; state: "open" | "closed"; merged: boolean;
  merged_by: { login: string } | null; merge_commit_sha: string | null; mergeable_state: string; html_url: string;
}
interface WorkflowRun { id: number; run_attempt: number; head_sha: string; head_branch: string; conclusion: string | null; status: string; html_url: string; created_at: string }
interface JobSpec { kind: "campaign" | "approve" | "smoke"; state: DriverState; root: string }

class CampaignAvailabilityResult extends Error {
  constructor(readonly hold: CampaignInfrastructureHold) { super("candidate device-cloud infrastructure held"); }
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
  async readiness(): Promise<Record<string, unknown> & { ready: boolean }> {
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
    checks.platform = process.platform === "darwin" && process.arch === "arm64" && Bun.version === "1.4.0";
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
    let lease: "free" | "owned" | "unreadable" = "free";
    if (await Bun.file(leasePath).exists()) {
      try { const db = new Database(leasePath, { readonly: true });
        try { if (db.query("SELECT owner FROM campaign WHERE id = 1").get() !== null) lease = "owned"; } finally { db.close(); }
      } catch { lease = "unreadable"; }
    }
    checks.hostLeaseFree = lease === "free";
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
    if (state !== undefined) { campaignAttempt(state); parseReleaseClass(state.issue.releaseClass); }
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
      this.pages<{ filename: string; previous_filename?: string }>(`pulls/${number}/files?per_page=100`),
      this.gh<{ check_runs: { name: string; status: string; conclusion: string; app: { slug: string } }[] }[]>(["api", "--paginate", "--slurp", `repos/${REPOSITORY}/commits/${pr.head.sha}/check-runs?per_page=100&filter=latest`]),
      pr.merged && pr.merge_commit_sha !== null ? this.api<{ tree: { sha: string }; verification: { verified: boolean } }>(`git/commits/${pr.merge_commit_sha}`) : undefined,
    ]);
    const runs = checks!.flatMap(page => page.check_runs);
    return { number, author: pr.user.login, authorType: pr.user.type, headRepository: pr.head.repo?.full_name ?? "",
      base: pr.base.ref, headRef: pr.head.ref, head: pr.head.sha, tree: head!.tree.sha, draft: pr.draft,
      state: pr.state, merged: pr.merged, mergedBy: pr.merged_by?.login, mergeCommit: pr.merge_commit_sha ?? undefined,
      mergeTree: merge?.tree.sha, mergeVerified: merge?.verification.verified, behind: pr.mergeable_state === "behind" || pr.mergeable_state === "unknown",
      checksPassed: REQUIRED_CHECKS.every(name => runs.some(run => run.name === name && run.status === "completed" && run.conclusion === "success" && run.app.slug === "github-actions")), files, url: pr.html_url };
  }
  async issues(): Promise<TrackingIssue[]> {
    const raw = await this.pages<{ number: number; title: string; user: { login: string }; html_url: string; created_at: string; labels?: { name: string }[]; pull_request?: unknown }>("issues?state=open&creator=github-actions%5Bbot%5D&per_page=100");
    const issues: TrackingIssue[] = raw.filter(issue => issue.pull_request === undefined).map(issue => ({
      number: issue.number, title: issue.title, author: issue.user.login, request: issue.created_at, url: issue.html_url,
      releaseClass: parseReleaseClass(issue.labels?.some(label => label.name === "release-minor") ? "minor" : "patch"),
    })).filter(issue => requestVersion(issue) !== undefined);
    if (issues.length === 0) return issues;
    const requests = await this.api<{ workflow_runs: WorkflowRun[] }>("actions/workflows/release-request.yml/runs?status=success&per_page=100", true);
    const jobName = (issue: TrackingIssue) => `Request OMP ${requestVersion(issue)}${issue.releaseClass === "minor" ? " (minor)" : ""}`;
    const unmatched = new Set(issues.map(jobName));
    for (const run of requests?.workflow_runs ?? []) {
      if (unmatched.size === 0) break;
      const jobs = await this.api<{ jobs: { name: string; conclusion: string }[] }>(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      for (const name of unmatched) {
        if (!jobs!.jobs.some(job => job.name === name && job.conclusion === "success")) continue;
        for (const issue of issues) if (jobName(issue) === name) issue.request = `${run.id}:${run.run_attempt}`;
        unmatched.delete(name);
      }
    }
    // A mutable label alone cannot opt a legacy patch request into minor-release authority.
    return issues.filter(issue => issue.releaseClass !== "minor" || !unmatched.has(jobName(issue)));
  }
  async workflow(tag: string, source: string): Promise<"passed" | "failed" | "pending"> {
    const result = await this.api<{ workflow_runs: WorkflowRun[] }>(`actions/workflows/signed-release.yml/runs?event=push&head_sha=${source}&per_page=100`);
    const run = result!.workflow_runs.find(run => run.head_branch === tag && run.head_sha === source);
    return run?.status !== "completed" ? "pending" : run.conclusion === "success" ? "passed" : "failed";
  }
  async job(kind: JobSpec["kind"], state: DriverState): Promise<JobObservation> {
    const directory = this.jobDirectory(kind, state);
    const result = await jsonFile<JobObservation>(join(directory, "result.json"));
    if (result !== undefined) return result;
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
  async campaignWorkerRunning(state: DriverState): Promise<boolean> {
    return (await command(["tmux", "has-session", "-t", this.session("campaign", state)], ROOT, this.env, true)).code === 0;
  }
  async releaseHostOwner(): Promise<string | undefined> {
    const path = join(homedir(), ".local/state/omp-session-gateway/release-host/lease.sqlite");
    if (!await Bun.file(path).exists()) return undefined;
    const db = new Database(path, { readonly: true });
    try {
      return db.query<{ owner: string }, []>("SELECT owner FROM campaign WHERE id = 1").get()?.owner;
    } finally { db.close(); }
  }
  async campaignBinding(state: DriverState): Promise<DriverState> {
    const specification = await jsonFile<JobSpec>(join(this.jobDirectory("campaign", state), "spec.json"));
    if (specification?.kind !== "campaign" || specification.root !== ROOT ||
      this.jobDirectory("campaign", specification.state) !== this.jobDirectory("campaign", state) ||
      specification.state.previousStable !== state.previousStable) throw new Error("held campaign worker binding is missing or changed");
    return specification.state;
  }
  campaignHoldObservation(state: DriverState, output: unknown, receipt: StableQualificationReceipt | undefined): CampaignInfrastructureHold {
    return campaignAvailabilityObservation(state, output, receipt);
  }
  /** One operator authorization, no device allocation. The next tick launches a fresh immutable job. */
  async authorizeDeviceCloudRetry(candidate: string, attempt: number): Promise<DriverState> {
    const state = await this.load();
    if (state === undefined || state.phase !== "infrastructure-held" || state.candidate !== candidate || campaignAttempt(state) !== attempt ||
      state.intent !== undefined || state.announcement !== undefined || state.stableCommit !== undefined || state.approvePr !== undefined) {
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
  /** Installed controls are the separately reviewed trust root, not candidate-supplied policy. */
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
        // The source fix was reviewed by its maintainer merge, not by the release bot evaluating itself.
        const fix = /^(fix|perf|revert)(\([^)]+\))?: /u.test(subject) && candidate.merged_by?.login === this.config.founder;
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
  async snapshot(state: DriverState | undefined): Promise<RepositorySnapshot> {
    const [main, upstream, latest, tags, issues] = await Promise.all([
      this.api<{ sha: string }>("commits/main"), this.api<{ content: string }>("contents/UPSTREAM.lock.json?ref=main"),
      this.api<{ tag_name: string }>("releases/latest"), this.pages<{ name: string }>("tags?per_page=100"), this.issues(),
    ]);
    const lock: { tag: string } = JSON.parse(Buffer.from(upstream!.content, "base64").toString());
    compareVersions(lock.tag, lock.tag);
    const stableTags = tags.map(tag => tag.name).filter(tag => /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(tag)).sort(compareVersions);
    const repo: RepositorySnapshot = { main: main!.sha, upstreamTag: lock.tag, latestStable: stableTags.at(-1) ?? latest!.tag_name, tags: tags.map(tag => tag.name), issues };
    if (state === undefined || state.phase === "closed") return repo;
    if (compareVersions(repo.upstreamTag, requestVersion(state.issue)!) < 0) {
      const prs = await this.pages<ApiPr>("pulls?state=open&base=main&per_page=100");
      const matching = prs.filter(pr => pr.user.login === ORDER_AUTHOR && pr.user.type === "Bot" && pr.head.repo?.full_name === REPOSITORY && pr.head.ref.startsWith(ORDER_HEAD_PREFIX));
      // Multiple matching orders are ambiguous. Never select by attacker-controlled title/body.
      if (matching.length === 1) repo.order = await this.readPr(matching[0]!.number);
    }
    if (state.preparePr !== undefined) repo.prepare = await this.readPr(state.preparePr);
    if (state.approvePr !== undefined) repo.approve = await this.readPr(state.approvePr);
    if (state.recordPr !== undefined) repo.record = await this.readPr(state.recordPr);
    if (["approve-open", "approve-checking", "approval-required", "approved"].includes(state.phase)) {
      try { repo.authority = await this.authority(state, repo.main, repo.approve); }
      catch (error) { if (!(error instanceof RoutineHoldError)) throw error; repo.authorityFailure = error.reason; }
      const evidence = await this.evidence(state);
      if (evidence !== undefined) repo.evidence = evidence;
    }
    if (state.phase === "candidate-tagged") repo.candidateWorkflow = await this.workflow(state.candidate, state.candidateCommit!);
    if (state.phase === "stable-tagged") repo.stableWorkflow = await this.workflow(`v${state.version}`, state.stableCommit!);
    if (state.phase === "qualifying") repo.campaign = await this.job("campaign", state);
    if (state.phase === "approve-checking") repo.approveChecks = await this.job("approve", state);
    if (state.phase === "smoking") repo.smoke = await this.job("smoke", state);
    if (state.phase === "diagnostic-required") {
      const path = join(homedir(), ".local/state/omp-session-gateway/release-host/lease.sqlite");
      if (await Bun.file(path).exists()) {
        try {
          const db = new Database(path, { readonly: true });
          try { repo.hostRecoveryRequired = db.query("SELECT owner FROM campaign WHERE id = 1").get() !== null; }
          finally { db.close(); }
        } catch { repo.hostRecoveryRequired = true; }
      }
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
  async push(ref: string, cwd = ROOT): Promise<void> {
    if (!(ref.startsWith("refs/heads/release-driver/") || /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+(?:-prealpha\.[1-9][0-9]*)?$/u.test(ref))) throw new Error("driver refuses push outside owned release branches/tags");
    await this.git(["push", `https://github.com/${REPOSITORY}.git`, `${ref}:${ref}`], cwd);
  }
  async assertGeneratedControls(pr: PullRequest): Promise<void> {
    if (!generatedReleaseFilesMatch(generatedReleaseKind(pr.headRef), pr.files)) throw new RoutineHoldError("generated-content-mismatch");
    const [installed, candidate] = await Promise.all([this.controls(await this.git(["rev-parse", "HEAD"]), true), this.controls(pr.head)]);
    if ([...new Set([...installed.keys(), ...candidate.keys()])].some(path => installed.get(path) !== candidate.get(path))) throw new RoutineHoldError("generated-content-mismatch");
  }
  async assertCheckpointAuthor(head: string): Promise<void> {
    const commit = await this.api<{ author: { login: string } | null; commit: { verification: { verified: boolean } } }>("commits/" + head);
    if (commit?.author?.login !== this.config.bot || commit.commit.verification.verified !== true) throw new RoutineHoldError("pr-identity-changed");
  }
  async openPr(kind: "prepare" | "approve" | "record", state: DriverState): Promise<PullRequest> {
    const branch = `release-driver/${state.issue.number}/${state.candidate}-${kind}`;
    const existing = await this.pages<ApiPr>(`pulls?state=all&base=main&head=carrythroughsystems:${encodeURIComponent(branch)}&per_page=100`);
    if (existing.length > 1) throw new Error("multiple PRs use the deterministic release branch");
    if (existing.length === 1) {
      const pr = await this.readPr(existing[0]!.number);
      if (pr.author !== this.config.bot || pr.headRepository !== REPOSITORY || pr.base !== "main" || pr.headRef !== branch) throw new RoutineHoldError("pr-identity-changed");
      await this.assertCheckpointAuthor(pr.head);
      await this.assertGeneratedControls(pr);
      return pr;
    }
    const source = kind === "prepare" ? state.selectedMain : kind === "approve" ? state.candidateCommit! : state.stableCommit!;
    const remote = await this.api<{ object: { sha: string } }>(`git/ref/heads/${branch}`, true);
    if (remote !== undefined) await this.assertCheckpointAuthor(remote.object.sha);
    const directory = await this.checkout(`${state.issue.number}-${state.candidate}-${kind}`, remote?.object.sha ?? source, branch);
    if (remote === undefined) {
      const args = [process.execPath, "scripts/release-generate.ts", kind, kind === "prepare" ? state.version : `v${state.version}`, "--date", state.date];
      if (kind === "prepare") args.push("--candidate-tag", state.candidate, "--release-class", parseReleaseClass(state.issue.releaseClass));
      if (kind === "approve") args.push("--receipt", this.receipt(state), "--candidate-tag", state.candidate);
      if (kind === "record") args.push("--smoke", join(this.jobDirectory("smoke", state), "smoke.json"), "--status", join(this.jobDirectory("smoke", state), "status.json"), "--publication", join(this.config.stateDir, `${state.candidate}-publication.json`));
      // A committed local head is the crash checkpoint before a push; never regenerate its content.
      if (await this.git(["rev-parse", "HEAD"], directory) === source) {
        await command([process.execPath, "install", "--frozen-lockfile"], directory, this.env);
        await command(args, directory, this.env);
        await this.git(["add", "--all"], directory);
        const changed = await this.git(["diff", "--cached", "--name-only"], directory);
        if (changed === "") throw new Error("release generator produced no changes; refusing an empty release PR");
        await this.git([...this.signingArgs(), "commit", "-S", "-m", `${kind === "record" ? "docs" : "chore"}(release): ${kind} v${state.version}`], directory);
      }
      await this.push(`refs/heads/${branch}`, directory);
    }
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
    if (current.state !== "open" || current.draft || current.behind || !current.checksPassed) throw new StaleIntentError("PR is not eligible for strict checked merge");
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
    const prior = state.macHost === undefined ? await jsonFile<JobSpec>(join(this.jobDirectory("campaign", state), "spec.json")) : undefined;
    const macHost = state.macHost ?? prior?.state.macHost ?? this.env.OMP_STABLE_MAC_HOST;
    if (macHost === undefined || macHost.includes(".example.") || !/^[A-Za-z_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(macHost)) {
      throw new Error("configure OMP_STABLE_MAC_HOST with the retained qualification target before arming");
    }
    return { ...state, macHost };
  }
  async launch(kind: JobSpec["kind"], state: DriverState): Promise<void> {
    const directory = this.jobDirectory(kind, state);
    await privateDirectory(directory);
    if (await Bun.file(join(directory, "result.json")).exists()) return;
    if ((await command(["tmux", "has-session", "-t", this.session(kind, state)], ROOT, this.env, true)).code === 0) return;
    if (kind !== "approve" && await Bun.file(join(directory, "started")).exists()) return; // Never infer device/cloud action absence from a missing reply.
    const specification = { kind, state, root: ROOT } satisfies JobSpec;
    if (kind === "approve") await atomicJson(join(directory, "spec.json"), specification);
    else if (!await immutableJobJson(join(directory, "spec.json"), specification)) {
      const prior = await jsonFile<JobSpec>(join(directory, "spec.json"));
      if (prior?.kind !== kind || prior.root !== ROOT || this.jobDirectory(kind, prior.state) !== directory ||
        prior.state.candidateCommit !== state.candidateCommit || prior.state.candidateDigest !== state.candidateDigest ||
        prior.state.authorityPolicy !== state.authorityPolicy || prior.state.previousStable !== state.previousStable ||
        prior.state.stableCommit !== state.stableCommit || prior.state.stableDigest !== state.stableDigest ||
        (kind === "campaign" && (prior.state.macHost !== state.macHost || prior.state.resumeDeviceCloud !== state.resumeDeviceCloud))) {
        throw new Error("immutable release job specification differs from its launch binding");
      }
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
      case "update-order":
      case "update-release-pr": {
        const pr = await this.readPr(step.pr!.number);
        if (step.operation === "update-order" ? !isOrder(pr) || outsideOrderScope(pr).length > 0 : pr.author !== this.config.bot || pr.base !== "main" || pr.headRepository !== REPOSITORY) throw new Error("PR scope/identity changed");
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
        const bound = await this.campaignLaunchState(state);
        await this.launch("campaign", bound);
        return { macHost: bound.macHost };
      }
      case "open-approve": return { approvePr: (await this.openPr("approve", state)).number };
      case "start-approve-checks": await this.launch("approve", { ...state, ...step.patch }); return {};
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
        for (const issue of await this.issues()) if (compareVersions(requestVersion(issue)!, requestVersion(state.issue)!) <= 0
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
    try {
      await this.authenticate();
      const source = spec.kind === "campaign" ? state.candidateCommit! : spec.kind === "approve" ? state.approvedHead! : state.stableCommit!;
      const retry = spec.kind === "campaign" && campaignAttempt(state) > 0 ? `-retry-${campaignAttempt(state)}` : "";
      const branch = spec.kind === "campaign" ? `release-driver/${state.issue.number}/${state.candidate}-campaign${retry}` : undefined;
      const checkout = await this.checkout(`${state.issue.number}-${state.candidate}-${spec.kind}-job${retry}`, source, branch);
      if (await this.git(["rev-parse", "HEAD"], checkout) !== source) throw new Error("job checkout is not its pinned source");
      await command([process.execPath, "install", "--frozen-lockfile"], checkout, this.env);
      if (spec.kind === "campaign") {
        await this.push(`refs/heads/${branch!}`, checkout);
        const macHost = state.macHost;
        if (!macHost || macHost.includes(".example.")) throw new Error("configure OMP_STABLE_MAC_HOST with the retained qualification target before arming");
        const env = { ...this.env, OMP_STABLE_MAC_HOST: macHost, OMP_STABLE_MAC_MODEL: this.env.OMP_STABLE_MAC_MODEL ?? "VirtualMac2,1", OMP_STABLE_OP_TOKEN_FILE: join(homedir(), ".local/state/omp-session-gateway/op-service-account.token") };
        await command(["security", "unlock-keychain", "-p", "", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, env);
        await command(["security", "set-keychain-settings", join(homedir(), "Library/Keychains/omp-qualification.keychain-db")], checkout, env);
        const runCampaign = async (flags: string[]) => {
          const outcomePath = join(directory, flags.includes("--preflight") ? "preflight-outcome.json" : "campaign-outcome.json");
          if (await lstat(outcomePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          }) !== undefined) throw new Error("stable machine outcome already exists in this immutable job phase");
          const result = await command([process.execPath, "run", "qualify:stable", "--", "--tag", state.candidate, ...flags], checkout, { ...env, OMP_STABLE_OUTCOME_FILE: outcomePath }, true);
          if (result.code === 75) {
            const receipt = await jsonFile<StableQualificationReceipt>(this.receipt(state));
            const hold = this.campaignHoldObservation(state, await readDeviceCloudOutcomeFile(outcomePath), receipt);
            if (hold.scope === "receipt") {
              const archivePath = join(directory, "held-qualification.json");
              if (!await immutableJobJson(archivePath, receipt)) throw new Error("held receipt archive already exists");
            }
            throw new CampaignAvailabilityResult(hold);
          }
          if (result.code !== 0) throw new Error(`stable qualification exited ${result.code}; inspect private job logs`, { cause: { out: result.out.slice(-262144), err: result.err.slice(-262144) } });
        };
        // Resume consumes the receipt's old eligibility before its own in-process admission.
        if (!state.resumeDeviceCloud) await runCampaign(["--preflight"]);
        await runCampaign(state.resumeDeviceCloud ? ["--resume-device-cloud"] : []);
        const receipt = await jsonFile<StableQualificationReceipt>(this.receipt(state));
        if (receipt?.status !== "passed" || receipt.schemaVersion !== 3 || receipt.tag !== state.candidate || receipt.candidate?.sourceCommit !== state.candidateCommit || receipt.candidate?.archiveSha256 !== state.candidateDigest || Object.values(receipt.lanes).some(lane => lane.status !== "passed")) throw new Error("qualification receipt is not fully passed and candidate-bound");
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
        const smoke = await command([process.execPath, "run", "smoke:release", "--", "--tag", `v${state.version}`, "--archive-sha256", state.stableDigest!, "--force-reinstall", "--rebuild-omp"], checkout, this.env);
        await atomicJson(join(directory, "smoke.json"), JSON.parse(smoke.out));
        const installation = join(homedir(), ".local/state/omp-session-gateway/installation");
        const active = (await jsonFile<{ versionDirectory?: string }>(join(installation, "current.json")))?.versionDirectory;
        if (active === undefined || !/^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$/u.test(active)) throw new Error("installed gateway active version is missing or invalid");
        const status = await command([join(homedir(), ".local/lib/omp-session-gateway/bun/v1.4.0/bun"), join(installation, "versions", active, "apps/gateway/src/cli.js"), "status"], checkout, this.env);
        await atomicJson(join(directory, "status.json"), JSON.parse(status.out));
      }
      const evidence: RoutineEvidence | undefined = spec.kind === "approve" ? {
        head: state.approvedHead!, tree: state.approvedTree!, candidate: state.candidate,
        candidateCommit: state.candidateCommit!, candidateDigest: state.candidateDigest!, policy: state.authorityPolicy!,
        steps: ROUTINE_EVIDENCE_STEPS,
      } : undefined;
      await atomicJson(join(directory, "result.json"), { status: "passed", ...(evidence === undefined ? {} : { evidence }) });
    } catch (error) {
      if (error instanceof CampaignAvailabilityResult) {
        await atomicJson(join(directory, "result.json"), { status: "infrastructure-hold", availabilityHold: error.hold } satisfies JobObservation);
        process.exitCode = 75;
      } else {
        console.error(error instanceof Error ? error.message : String(error));
        if (error instanceof Error && error.cause !== undefined) await atomicJson(join(directory, "diagnostic.json"), error.cause);
        let detail = `${spec.kind} failed; inspect private job logs; no retry`;
        if (spec.kind === "campaign") {
          const receipt = await jsonFile<StableQualificationReceipt>(this.receipt(state));
          if (receipt !== undefined) detail = `campaign failed lanes: ${Object.entries(receipt.lanes).filter(([, lane]) => lane.status !== "passed").map(([name, lane]) => `${name} (${lane.status})`).join(", ")}; no retry`;
        }
        await atomicJson(join(directory, "result.json"), { status: "failed", detail } satisfies JobObservation);
        process.exitCode = 1;
      }
    } finally { await writeFile(join(directory, "exit"), `${process.exitCode ?? 0}\n`, { mode: 0o600 }); }
  }
}

async function drive(args: string[]): Promise<unknown> {
  const [mode, spec, ...extra] = args;
  const retry = mode === "retry-device-cloud";
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
  } else if (!["plan", "status", "tick", "worker"].includes(mode ?? "") || extra.length > 0 || (mode === "worker") !== (spec !== undefined)) {
    throw new Error("usage: bun scripts/release-driver.ts plan|status|tick|worker <private-spec-path>|retry-device-cloud --candidate <tag> --job-attempt <n>");
  }
  const config = driverConfig(), plan = mode === "plan" || mode === "status" || config.dryRun;
  const driver = new StudioDriver(config, plan);
  if (plan) {
    const readiness = await driver.readiness();
    if (mode === "status") {
      const state = await driver.load();
      return { readiness, phase: state?.phase, candidate: state?.candidate, intent: state?.intent?.operation,
        holdReason: state?.holdReason, holdCommit: state?.holdCommit, infrastructureHold: state?.infrastructureHold,
        campaignAttempt: state === undefined ? undefined : campaignAttempt(state), outboxPending: state?.announcement !== undefined };
    }
    return { ...await tick(driver, config, true), readiness };
  }
  if (process.platform !== "darwin" || (await command([process.execPath, "--version"], ROOT, process.env)).out !== "1.4.0") throw new Error("release driver writes require the Studio Darwin host and Bun 1.4.0");
  if (await Bun.file(join(config.stateDir, "disabled")).exists()) return { operation: "idle", detail: "kill switch is enabled" };
  await privateDirectory(config.stateDir);
  if (mode === "worker") { await driver.worker(spec!); return { operation: "worker", completed: true }; }
  const lockPath = join(config.stateDir, "tick.sqlite");
  try { const file = await open(lockPath, "wx", 0o600); await file.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const lock = new Database(lockPath);
  try {
    lock.exec("PRAGMA busy_timeout=1000");
    lock.exec("BEGIN IMMEDIATE");
    const readiness = await driver.readiness();
    await atomicJson(join(config.stateDir, "readiness.json"), readiness);
    const state = await driver.load();
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
    if (args[0] === "plan" || args[0] === "status" || config.dryRun) return;
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
