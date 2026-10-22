import { createHash } from "node:crypto";
import { runDriver } from "./release-driver-runtime.ts";
import { nextReleaseVersion, parseReleaseClass, RoutineHoldError, routineReleaseHold, routineSourceHold } from "./release-policy.ts";
import type { ReleaseClass, RoutineAuthority, RoutineEvidence, RoutineHoldReason } from "./release-policy.ts";
import type { DeviceCloudHold } from "./device-cloud-availability.ts";
import { parseDeviceCloudHoldSet } from "./device-cloud-outcome.ts";

export const REPOSITORY = "carrythroughsystems/omp-session-gateway";
// The delivery App's bot opens an order from a branch under this prefix.
export const ORDER_AUTHOR = "carrythroughsystems[bot]";
export const ORDER_HEAD_PREFIX = "carrythrough/";
export const ORDER_SCOPE = [
  "CHANGELOG.md", "UPSTREAM.lock.json", "docs/COMPATIBILITY.md", "docs/DECISIONS.md",
  "docs/OMP_INTEGRATION.md", "docs/RELEASE_STATUS.md", "scripts/windows-qualification-pins.json",
] as const;
export interface TrackingIssue {
  number: number;
  title: string;
  author: string;
  /** Creation time or the newest successful release-request workflow run/attempt; never issue body text. */
  request: string;
  /** Legacy requests are patch releases; minor requests require a matching successful filing job. */
  releaseClass?: ReleaseClass;
  url: string;
}
export interface PullRequest {
  number: number;
  author: string;
  authorType: string;
  headRepository: string;
  base: string;
  headRef: string;
  head: string;
  tree: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  mergedBy?: string | undefined;
  mergeCommit?: string | undefined;
  mergeTree?: string | undefined;
  mergeVerified?: boolean | undefined;
  behind: boolean;
  checksPassed: boolean;
  files: { filename: string; previous_filename?: string }[];
  url: string;
}
export type Phase = "selected" | "order-updated" | "order-ready" | "order-landed" | "held"
  | "prepare-open" | "prepared" | "candidate-tagged" | "candidate-published" | "candidate-verified"
  | "qualifying" | "qualified" | "approve-open" | "approve-checking" | "approval-required"
  | "approved" | "stable-tagged" | "stable-published" | "stable-verified" | "smoking" | "smoked"
  | "record-open" | "recorded" | "closed" | "diagnostic-required" | "infrastructure-held" | "stopped";
export type Operation = "select" | "hold" | "stop" | "update-order" | "update-release-pr" | "ready-order" | "merge-order"
  | "open-prepare" | "merge-prepare" | "tag-candidate" | "observe-candidate" | "verify-candidate"
  | "start-campaign" | "finish-campaign" | "open-approve" | "start-approve-checks" | "finish-approve-checks"
  | "merge-approve" | "accept-approval" | "tag-stable" | "observe-stable" | "verify-stable" | "start-smoke"
  | "finish-smoke" | "open-record" | "merge-record" | "close" | "rerequest" | "hold-device-cloud";
export interface DriverState {
  schemaVersion: 1;
  sequence: number;
  phase: Phase;
  issue: TrackingIssue;
  version: string;
  candidate: string;
  selectedMain: string;
  previousStable?: string;
  date: string;
  preparePr?: number | undefined;
  orderPr?: number | undefined;
  candidateCommit?: string | undefined;
  candidateDigest?: string | undefined;
  approvePr?: number | undefined;
  approvedHead?: string | undefined;
  approvedTree?: string | undefined;
  authorityPolicy?: string | undefined;
  holdReason?: RoutineHoldReason | undefined;
  holdCommit?: string | undefined;
  stableCommit?: string | undefined;
  stableDigest?: string | undefined;
  publicationRun?: string | undefined;
  recordPr?: number | undefined;
  failedMain?: string | undefined;
  /** Attempt zero preserves the original job paths. Each authorized retry gets a new ordinal. */
  campaignAttempt?: number | undefined;
  resumeDeviceCloud?: boolean | undefined;
  /** Bound in the immutable campaign specification, never retargeted from operator CLI ambient env. */
  macHost?: string | undefined;
  infrastructureHold?: CampaignInfrastructureHold | undefined;
  updatedHead?: string | undefined;
  /** Saved before any effect. Its operation must reconcile existing provider state on replay. */
  intent?: Decision;
  /** Transactional outbox: committed state is exposed only after this comment is reconciled. */
  announcement?: { body: string; marker: string };
}
export interface CampaignInfrastructureHold {
  readonly scope: "preflight" | "receipt";
  readonly candidate: string;
  readonly sourceCommit: string;
  readonly archiveSha256: string;
  readonly orchestratorCommit: string;
  readonly policy: string;
  readonly campaignAttempt: number;
  readonly macHost: string;
  readonly availabilityHolds: readonly DeviceCloudHold[];
}
export interface JobObservation {
  status: "absent" | "running" | "passed" | "failed" | "infrastructure-hold";
  detail?: string;
  availabilityHold?: CampaignInfrastructureHold;
}

export function campaignAttempt(state: DriverState): number {
  const attempt = state.campaignAttempt ?? 0;
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > 10_000) throw new Error("invalid campaign job attempt");
  return attempt;
}

export function parseCampaignInfrastructureHold(value: unknown, state: DriverState): CampaignInfrastructureHold {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid campaign infrastructure hold");
  const hold = value as Record<string, unknown>;
  if (Object.keys(hold).sort().join(",") !== "archiveSha256,availabilityHolds,campaignAttempt,candidate,macHost,orchestratorCommit,policy,scope,sourceCommit" ||
    (hold.scope !== "preflight" && hold.scope !== "receipt") || hold.candidate !== state.candidate || !/^v[0-9]+\.[0-9]+\.[0-9]+-prealpha\.[1-9][0-9]*$/u.test(state.candidate) ||
    hold.sourceCommit !== state.candidateCommit || typeof hold.sourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(hold.sourceCommit) ||
    hold.orchestratorCommit !== state.candidateCommit || hold.archiveSha256 !== state.candidateDigest ||
    typeof hold.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(hold.archiveSha256) ||
    typeof hold.policy !== "string" || !/^[a-f0-9]{64}$/u.test(hold.policy) || hold.policy !== state.authorityPolicy ||
    typeof hold.macHost !== "string" || hold.macHost !== state.macHost || !/^[A-Za-z_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(hold.macHost) ||
    hold.campaignAttempt !== campaignAttempt(state) || !Array.isArray(hold.availabilityHolds) || hold.availabilityHolds.length < 1 ||
    hold.availabilityHolds.length > 3) throw new Error("invalid campaign infrastructure hold");
  const availabilityHolds = parseDeviceCloudHoldSet(hold.availabilityHolds);
  if (hold.scope === "preflight" && availabilityHolds.some(item => item.stage !== "preflight")) throw new Error("incoherent campaign infrastructure hold");
  return {
    scope: hold.scope, candidate: state.candidate, sourceCommit: state.candidateCommit!, archiveSha256: state.candidateDigest!,
    orchestratorCommit: state.candidateCommit!, policy: state.authorityPolicy!, campaignAttempt: campaignAttempt(state), macHost: hold.macHost, availabilityHolds,
  };
}
export interface RepositorySnapshot {
  main: string;
  upstreamTag: string;
  latestStable: string;
  tags: string[];
  issues: TrackingIssue[];
  order?: PullRequest;
  prepare?: PullRequest;
  approve?: PullRequest;
  record?: PullRequest;
  candidateWorkflow?: "pending" | "passed" | "failed";
  stableWorkflow?: "pending" | "passed" | "failed";
  campaign?: JobObservation;
  approveChecks?: JobObservation;
  authority?: RoutineAuthority;
  authorityFailure?: RoutineHoldReason;
  evidence?: RoutineEvidence;
  smoke?: JobObservation;
  /** A failed host lease must first be recovered manually; a new request cannot steal it. */
  hostRecoveryRequired?: boolean;
}
export interface DriverConfig { bot: string; founder: string }
export interface Decision {
  operation: Operation;
  phase: Phase;
  detail: string;
  links?: string[];
  pr?: PullRequest;
  patch?: Partial<DriverState>;
  holdReason?: RoutineHoldReason;
}
export interface Idle { operation: "idle"; detail: string; holdReason?: RoutineHoldReason }
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    if (!/^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value)) throw new Error("expected exact stock/stable version");
    return value.replace(/^v/u, "").split(".").map(BigInt);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
}
export function requestVersion(issue: TrackingIssue): string | undefined {
  return issue.author === "github-actions[bot]" ? /^Upstream tracking: (v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u.exec(issue.title)?.[1] : undefined;
}
export function selectRequest(issues: TrackingIssue[]): TrackingIssue | undefined {
  return issues.filter(issue => requestVersion(issue) !== undefined).sort((a, b) =>
    compareVersions(requestVersion(b)!, requestVersion(a)!) || b.number - a.number)[0];
}
export function nextCandidate(version: string, tags: string[]): string {
  const prefix = `v${version}-prealpha.`;
  const existing = tags.filter(tag => tag.startsWith(prefix)).map(tag => tag.slice(prefix.length)).filter(n => /^[1-9][0-9]*$/u.test(n)).map(BigInt);
  const next = existing.reduce((max, n) => n > max ? n : max, 0n) + 1n;
  return `${prefix}${next}`;
}
export function isOrder(pr: PullRequest): boolean {
  return pr.author === ORDER_AUTHOR && pr.authorType === "Bot"
    && pr.headRepository === REPOSITORY && pr.headRef.startsWith(ORDER_HEAD_PREFIX) && pr.base === "main";
}
export function outsideOrderScope(pr: PullRequest): string[] {
  return [...new Set(pr.files.flatMap(file => [file.filename, ...(file.previous_filename === undefined ? [] : [file.previous_filename])]))].filter(path => !ORDER_SCOPE.some(allowed => allowed === path));
}
function idle(detail: string): Idle { return { operation: "idle", detail }; }
function decision(operation: Operation, phase: Phase, detail: string, extra: Partial<Decision> = {}): Decision {
  return { operation, phase, detail, ...extra };
}
function refuse(pr: PullRequest | undefined, config: DriverConfig, role: string): string | undefined {
  if (pr === undefined) return `${role} PR disappeared`;
  if (pr.author !== config.bot || pr.base !== "main" || pr.headRepository !== REPOSITORY) return `${role} PR identity changed`;
  if (pr.state === "closed" && !pr.merged) return `${role} PR closed without merging`;
  return undefined;
}
export function routineHold(reason: RoutineHoldReason, sourceCommit?: string): Decision {
  const holdCommit = reason === "out-of-class" ? sourceCommit : undefined;
  return decision("hold", "held", "routine release held: " + reason + (holdCommit === undefined ? "" : " at source commit " + holdCommit),
    { holdReason: reason, patch: { holdReason: reason, holdCommit } });
}
export function promotionHold(state: DriverState, repo: RepositorySnapshot, config: DriverConfig, merged = false): RoutineHoldReason | undefined {
  const reason = routineReleaseHold({
    subject: { head: state.approvedHead, tree: state.approvedTree, candidate: state.candidate, candidateCommit: state.candidateCommit, candidateDigest: state.candidateDigest, policy: state.authorityPolicy },
    authority: repo.authority, evidence: repo.evidence, pr: repo.approve, bot: config.bot, repository: REPOSITORY,
    branch: "release-driver/" + state.issue.number + "/" + state.candidate + "-approve", merged,
  });
  return reason ?? (merged && repo.approve?.mergeCommit !== state.stableCommit ? "merge-missing" : undefined);
}
export function nextStep(state: DriverState | undefined, repo: RepositorySnapshot, config: DriverConfig, date = new Date().toISOString().slice(0, 10)): Decision | Idle {
  if (state?.intent !== undefined) return state.intent;
  if (state?.phase === "infrastructure-held") return idle("device-cloud infrastructure held; explicit retry-device-cloud authorization required; no automatic retry");
  if (repo.authorityFailure !== undefined) return routineHold(repo.authorityFailure);
  if (state?.holdReason !== undefined) return idle("held: " + state.holdReason + (state.holdCommit === undefined ? "" : " at source commit " + state.holdCommit) + "; inspect exact subject before operator recovery");
  if (state === undefined || state.phase === "closed") {
    const issue = selectRequest(repo.issues);
    if (issue === undefined) return idle("no open tracking issue; idle");
    const version = nextReleaseVersion(repo.latestStable, parseReleaseClass(issue.releaseClass));
    return decision("select", "selected", `request ${requestVersion(issue)} for gateway v${version}`, { patch: {
      schemaVersion: 1, sequence: 0, issue, version, candidate: nextCandidate(version, repo.tags), selectedMain: repo.main, previousStable: repo.latestStable, date,
    }, links: [issue.url] });
  }
  const failure = (detail: string) => decision("stop", "diagnostic-required", detail + (["qualifying", "smoking"].includes(state.phase) ? "; inspect and recover the exact owning release-host lease before further device work" : ""), { patch: { failedMain: repo.main } });
  if (state.phase === "stopped") return idle("stopped; founder/operator intervention required");
  if (state.phase === "diagnostic-required") {
    if (state.stableCommit !== undefined) return idle("diagnostic-required after approval/publication; preserve the immutable release and reconcile manually");
    // An order PR's "Closes #N" closes the tracking issue when it merges, so a retry request for the
    // same version opens a new one (v0.7.5: #369 closed #368; the retry opened #374).
    const matching = repo.issues.filter(issue => requestVersion(issue) === requestVersion(state.issue)
      && parseReleaseClass(issue.releaseClass) === parseReleaseClass(state.issue.releaseClass));
    const request = matching.find(issue => issue.number === state.issue.number) ?? selectRequest(matching);
    if (request === undefined || request.request === state.issue.request || repo.main === state.failedMain) return idle("diagnostic-required; no retry without a new request and a main fix");
    if (repo.hostRecoveryRequired) return idle("diagnostic-required; recover the failed release-host lease before a new candidate");
    return decision("rerequest", "selected", "new request after a main fix; preserve failed receipt and use next prealpha", { patch: {
      issue: request, selectedMain: repo.main, candidate: nextCandidate(state.version, repo.tags),
      preparePr: undefined, orderPr: undefined, updatedHead: undefined, candidateCommit: undefined, candidateDigest: undefined, approvePr: undefined,
      approvedHead: undefined, approvedTree: undefined, stableCommit: undefined, stableDigest: undefined,
      publicationRun: undefined, recordPr: undefined, failedMain: undefined,
      campaignAttempt: 0, infrastructureHold: undefined, resumeDeviceCloud: undefined, macHost: undefined,
    } });
  }
  if (["selected", "order-updated", "order-ready", "order-landed", "held"].includes(state.phase)) {
    const comparison = compareVersions(repo.upstreamTag, requestVersion(state.issue)!);
    if (comparison > 0) return state.phase === "held" ? idle("main baseline is newer than this request") : decision("hold", "held", "main baseline is newer than this request");
    if (comparison < 0) {
      const pr = repo.order;
      if (pr === undefined || !isOrder(pr) || pr.state !== "open") return idle("waiting for matching Carrythrough draft order PR");
      const outside = outsideOrderScope(pr);
      if (outside.length > 0) return state.phase === "held" ? idle("held: order changes outside ORDER_SCOPE") : decision("hold", "held", `order #${pr.number} changes outside ORDER_SCOPE: ${outside.join(", ")}`, { links: [pr.url] });
      // A held order is never auto-landed later, even if somebody edits it into scope.
      if (state.phase === "held") return idle("held order requires a new request; never auto-land it");
      if (!pr.draft && state.orderPr !== pr.number) return idle("waiting for an order first observed as a draft");
      if (!pr.checksPassed) return idle(`waiting for all required checks on order #${pr.number} head ${pr.head}`);
      if (pr.behind) return state.updatedHead === pr.head ? idle("waiting for order update-branch") : decision("update-order", "order-updated", `updating order #${pr.number} from main`, { pr, patch: { updatedHead: pr.head } });
      if (pr.draft) return decision("ready-order", "order-ready", `marking order #${pr.number} ready`, { pr, patch: { orderPr: pr.number } });
      return decision("merge-order", "order-landed", `squash-merging order #${pr.number} with pinned head`, { pr });
    }
    return decision("open-prepare", "prepare-open", `prepare v${state.version}`, { patch: { selectedMain: repo.main } });
  }
  if (state.phase === "prepare-open" || state.phase === "record-open") {
    const prepare = state.phase === "prepare-open", pr = prepare ? repo.prepare : repo.record;
    if (prepare && !pr?.merged && repo.main !== state.selectedMain) return routineHold("stale-source");
    const invalid = refuse(pr, config, prepare ? "prepare" : "record");
    if (invalid !== undefined) return decision("stop", "stopped", invalid);
    if (!pr!.merged && pr!.behind && pr!.checksPassed && state.updatedHead !== pr!.head) return decision("update-release-pr", state.phase, "update release PR before strict checked merge", { pr: pr!, patch: { updatedHead: pr!.head } });
    if (!pr!.merged && (pr!.behind || !pr!.checksPassed)) return idle("waiting for strict required PR checks against current main");
    return decision(prepare ? "merge-prepare" : "merge-record", prepare ? "prepared" : "recorded", `merge ${prepare ? "prepare" : "record"} PR with pinned head`, { pr: pr! });
  }
  if (state.phase === "prepared") return decision("tag-candidate", "candidate-tagged", `sign and push ${state.candidate}`);
  if (state.phase === "candidate-tagged" || state.phase === "stable-tagged") {
    const candidate = state.phase === "candidate-tagged", workflow = candidate ? repo.candidateWorkflow : repo.stableWorkflow;
    if (workflow === "failed") return failure(`${candidate ? "candidate" : "stable"} signed-release workflow failed; no retry`);
    if (workflow !== "passed") return idle("waiting for signed-release.yml at the exact tag and source");
    return decision(candidate ? "observe-candidate" : "observe-stable", candidate ? "candidate-published" : "stable-published", "signed-release.yml passed");
  }
  if (state.phase === "candidate-published") return decision("verify-candidate", "candidate-verified", `verify all six assets and provenance of ${state.candidate}`);
  if (state.phase === "candidate-verified") return decision("start-campaign", "qualifying", `preflight then detached qualification of ${state.candidate}`);
  if (state.phase === "qualifying" || state.phase === "approve-checking" || state.phase === "smoking") {
    const job = state.phase === "qualifying" ? repo.campaign : state.phase === "smoking" ? repo.smoke : repo.approveChecks;
    if (job?.status === "infrastructure-hold") {
      if (state.phase !== "qualifying") return failure("unexpected infrastructure hold outside candidate qualification");
      try {
        const hold = parseCampaignInfrastructureHold(job.availabilityHold, state);
        return decision("hold-device-cloud", "infrastructure-held", "candidate device-cloud availability held; no automatic retry", { patch: { infrastructureHold: hold } });
      } catch { return failure("invalid device-cloud infrastructure-hold observation; inspect private job evidence"); }
    }
    if (state.phase === "approve-checking" && job?.status === "absent") {
      const pr = repo.approve;
      if (!pr || pr.head !== state.approvedHead || pr.tree !== state.approvedTree) return routineHold("head-tree-changed");
      if (repo.authority?.policy !== state.authorityPolicy) return routineHold("policy-changed");
      return decision("start-approve-checks", "approve-checking", "resume only the same-subject local checks; no device/cloud action is replayed", { pr });
    }
    if (job?.status === "failed" || job?.status === "absent") return failure(job.detail ?? `${state.phase} process disappeared; inspect private job logs; no retry`);
    if (job?.status !== "passed") return idle(`waiting for detached ${state.phase}`);
    if (state.phase === "qualifying") return decision("finish-campaign", "qualified", "all candidate qualification lanes passed");
    if (state.phase === "smoking") return decision("finish-smoke", "smoked", "published-byte smoke passed with --force-reinstall and --rebuild-omp");
    const pr = repo.approve;
    const invalid = refuse(pr, config, "approve");
    if (invalid !== undefined) return routineHold("pr-identity-changed");
    if (pr!.head !== state.approvedHead || pr!.tree !== state.approvedTree) return routineHold("head-tree-changed");
    return decision("finish-approve-checks", "approval-required", "exact-subject checks completed; evaluate standing routine authority", { links: [pr!.url] });
  }
  if (state.phase === "qualified") return decision("open-approve", "approve-open", `open receipt-derived stable approval for v${state.version}`);
  if (state.phase === "approve-open") {
    const pr = repo.approve;
    const invalid = refuse(pr, config, "approve");
    if (invalid !== undefined) return routineHold("pr-identity-changed");
    if (pr!.merged) return routineHold("missing-evidence");
    const reason = routineSourceHold(repo.authority, state.authorityPolicy);
    if (reason !== undefined) return routineHold(reason, repo.authority?.unreviewedCommit);
    if (!state.authorityPolicy) return routineHold("policy-changed");
    return decision("start-approve-checks", "approve-checking", "run stable build, runtime comparison, policy, smoke plan and full local checks", { pr: pr!, patch: { approvedHead: pr!.head, approvedTree: pr!.tree, authorityPolicy: state.authorityPolicy } });
  }
  if (state.phase === "approval-required" || state.phase === "approved") {
    const reason = promotionHold(state, repo, config, state.phase === "approved");
    if (reason === "required-checks-missing") return { operation: "idle", detail: "held: required-checks-missing; waiting for exact-head strict checks", holdReason: reason };
    if (reason !== undefined) return routineHold(reason, repo.authority?.unreviewedCommit);
    const pr = repo.approve!;
    if (state.phase === "approved") return decision("tag-stable", "stable-tagged", "sign and push the exact routine-authorized stable merge");
    if (!pr.merged) return decision("merge-approve", "approved", "standing routine authority: merge the exact checked promotion", { pr });
    return decision("accept-approval", "approved", "observed exact-subject release-bot merge", { patch: { stableCommit: pr.mergeCommit }, links: [pr.url] });
  }
  if (state.phase === "stable-published") return decision("verify-stable", "stable-verified", `verify v${state.version}, GitHub Latest and rebuilt archive digest`);
  if (state.phase === "stable-verified") return decision("start-smoke", "smoking", `detached published-byte smoke for v${state.version} with --force-reinstall and --rebuild-omp`);
  if (state.phase === "smoked") return decision("open-record", "record-open", `record v${state.version} publication and smoke evidence`);
  if (state.phase === "recorded") return decision("close", "closed", `v${state.version} recorded; close request and lower open requests`, { links: [`https://github.com/${REPOSITORY}/releases/tag/v${state.version}`] });
  return idle("waiting");
}
export interface DriverPort {
  load(): Promise<DriverState | undefined>;
  save(state: DriverState): Promise<void>;
  snapshot(state: DriverState | undefined): Promise<RepositorySnapshot>;
  /** Must be replay-safe: inspect deterministic PR branch/tag/job identity before creating.
   *  Throws StaleIntentError only when it refused before any effect because a pinned input moved. */
  perform(step: Decision, state: DriverState): Promise<Partial<DriverState>>;
  /** Reconcile marker on the issue, accepting only comments authored by the configured bot. */
  announce(issue: number, body: string, marker: string): Promise<void>;
}
/** A saved intent's pinned input (a PR head, its checks) moved before the intent had any effect.
 *  Replaying it can never succeed, so the tick drops it and the next tick plans afresh. */
export class StaleIntentError extends Error {}
/** At most one state transition. The caller holds the tick mutex; plan never calls save/perform. */
export async function tick(port: DriverPort, config: DriverConfig, plan = false): Promise<Decision | Idle> {
  let state = await port.load();
  if (state?.announcement !== undefined) {
    if (plan) return idle(`reconcile progress comment for ${state.phase}`);
    await port.announce(state.issue.number, state.announcement.body, state.announcement.marker);
    delete state.announcement;
    await port.save(state);
    return idle(`reconciled ${state.phase} progress comment`);
  }
  let step = nextStep(state, await port.snapshot(state), config);
  if (plan || step.operation === "idle") return step;
  if (state === undefined || step.operation === "select") state = { ...step.patch, phase: "selected" } as DriverState;
  state.intent = step;
  await port.save(state);
  let result: Partial<DriverState>;
  try {
    result = await port.perform(step, { ...state, ...step.patch });
  } catch (error) {
    if (error instanceof RoutineHoldError) {
      step = routineHold(error.reason, error.sourceCommit);
      result = {};
    } else {
      if (!(error instanceof StaleIntentError)) throw error;
      delete state.intent;
      await port.save(state);
      return idle("re-planning: " + step.operation + " refused before any effect (" + error.message + ")");
    }
  }
  state = { ...state, ...step.patch, ...result, phase: step.phase, sequence: state.sequence + 1 };
  delete state.intent;
  const marker = `<!-- release-driver:${createHash("sha256").update(`${state.issue.number}:${state.issue.request}:${state.candidate}:${state.sequence}:${state.phase}`).digest("hex")} -->`;
  state.announcement = { marker, body: [`release-driver: ${state.phase} — ${step.detail.replace(/[\r\n]/gu, " ")}`, ...(step.links ?? []), marker].join("\n") };
  await port.save(state);
  await port.announce(state.issue.number, state.announcement.body, marker);
  delete state.announcement;
  await port.save(state);
  return step;
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runDriver(Bun.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
