import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { PRODUCT_VERSION as VERSION } from "./build-release.ts";
import { runAdb, parseAndroidPackageVersion, readAndroidQualificationPin, requireAndroidDevicePreconditions, requireAndroidGatewayReachability, requireSingleDevice, resolveAndroidBrowserTarget } from "./android-device.ts";
import { downloadReleaseAssets } from "./release-download.ts";
import { releaseVersion } from "./release-policy.ts";
import { historicalPredecessor, verifyReleaseSignatures } from "./post-release-smoke.ts";
import { fixtureModelError, OMP_FIXTURE_MODEL } from "./omp-fixture.ts";
import { isSupportedOmpVersion, parseOmpVersion } from "./upstream-canary.ts";
import { defaultLaneModules, retainedMacLogs } from "./stable-lanes.ts";
import { pixelUnrestored } from "./restoration.ts";
import { deviceCloudHolds, type DeviceCloudHold } from "./device-cloud-availability.ts";
import { parseDeviceCloudHoldSet, recognizedDeviceCloudOutcome, writeDeviceCloudOutcomeFile } from "./device-cloud-outcome.ts";
import { withReleaseHostLease } from "./release-host-lease.ts";
import { createOmpStdinDriver, OmpLifecycleFailure, runOmpLifecycle, type OmpLifecycleEvidence, type OmpLifecycleHost, type OmpSessionWait } from "./omp-lifecycle-qualification.ts";
import { FAILURE_LIMITS, FAILURE_STEPS, FAILURE_REASONS, QualificationFailure, normalizeQualificationFailures, qualificationRetryEligible, parseLaneFailure, parseLaneTimings, parseQualificationFailureSummary, type QualificationFailureLane, type LaneFailure, type LaneTimings, type QualificationFailureSummary } from "./qualification-failure.ts";
import { parseQualificationExecution, qualificationExecutionsMatch, parseRigReadinessReceipt, writeQualificationOutcomeFile, readQualificationOutcomeFile, qualificationOutcomeExitCode, type QualificationExecution, type RigReadinessReceipt } from "./qualification-outcome.ts";

/** Candidate-source rollout marker: contract modules alone do not enable new worker arguments. */
export const QUALIFICATION_EXECUTION_FORMAT = 1;
export interface QualificationExecutionContext {
  readonly signal: AbortSignal;
  /** Absolute performance.now() deadline; UTC timestamps are chronology only. */
  readonly deadline: number;
  readonly nextFailureId: () => number;
}
export const QUALIFICATION_CEILINGS_MS = {
  windows: 180 * 60_000, androidPush: 90 * 60_000, deviceCloud: 90 * 60_000,
  android: 30 * 60_000, windowsCleanup: 30 * 60_000, deviceCloudCleanup: 30 * 60_000,
  // Existing Mac cleanup allows two 10-minute scripts and two 30-minute SSH operations.
  // Do not shorten those owners to fit the proposed 30-minute outer ceiling.
  androidPushCleanup: 15 * 60_000, cleanup: 90 * 60_000,
} as const;

/** Abort the owner, await its settlement, then allow its caller to begin cleanup. Never race it. */
export async function withQualificationDeadline<T>(
  lane: QualificationFailureLane,
  timeoutMs: number,
  nextFailureId: () => number,
  run: (execution: QualificationExecutionContext) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const started = performance.now();
  const execution = { signal: controller.signal, deadline: started + timeoutMs, nextFailureId };
  const timer = setTimeout(() => controller.abort(new QualificationFailure({
    id: nextFailureId(), lane, step: FAILURE_STEPS[lane][0], class: "harness", reason: "deadline_exceeded",
    elapsedMs: Math.min(timeoutMs, FAILURE_LIMITS.elapsedMs), operation: "unknown", observations: { controllerDeadline: true },
  } as LaneFailure)), timeoutMs);
  try {
    const result = await run(execution);
    execution.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (execution.signal.aborted && error !== execution.signal.reason) {
      throw new AggregateError([execution.signal.reason, error], "qualification deadline and owner failed");
    }
    throw error;
  } finally { clearTimeout(timer); }
}

const failureSequences = new WeakMap<StableQualificationReceipt, number>();
const cleanupIntervals = new WeakMap<StableQualificationReceipt, [number, number][]>();
async function trackCleanup<T>(receipt: StableQualificationReceipt, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await run(); }
  finally {
    let intervals = cleanupIntervals.get(receipt);
    if (intervals === undefined) { intervals = []; cleanupIntervals.set(receipt, intervals); }
    intervals.push([start, performance.now()]);
  }
}
function cleanupElapsed(receipt: StableQualificationReceipt): number {
  let total = 0, end = 0;
  for (const [start, finish] of (cleanupIntervals.get(receipt) ?? []).sort((left, right) => left[0] - right[0])) {
    total += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return total;
}
function nextReceiptFailureId(receipt: StableQualificationReceipt): number {
  const next = (failureSequences.get(receipt) ?? 0) + 1;
  failureSequences.set(receipt, next);
  return next;
}

function laneFailure(error: unknown, lane: QualificationFailureLane, nextFailureId: () => number): unknown {
  if (error instanceof QualificationFailure) return error;
  if (error instanceof AggregateError) return new AggregateError(error.errors.map(child => laneFailure(child, lane, nextFailureId)), "qualification failures");
  const holds = deviceCloudHolds(error);
  if (holds !== undefined) return error; // The normalizer validates the closed legacy wrapper.
  return Object.assign(new QualificationFailure({
    id: nextFailureId(), lane, step: FAILURE_STEPS[lane][0], reason: "unclassified_failure", class: "harness",
    elapsedMs: 0, operation: "unknown", observations: {},
  } as LaneFailure, { cause: error }), pixelUnrestored(error) ? { pixelUnrestored: true } : {});
}

const REPOSITORY = "carrythroughsystems/omp-session-gateway";
const ESCAPED_VERSION = VERSION.replaceAll(".", "\\.");
const CANDIDATE_TAG_PATTERN = new RegExp(`^v${ESCAPED_VERSION}-prealpha\\.[1-9][0-9]*$`, "u");

const DEBIAN_WORKFLOW = "droplet-qualification.yml";
const DEBIAN_RUN_TITLE_PREFIX = "Stable qualification";
const DEFAULT_MAC_LOGIN = "alphastorm@github";
const MAC_PATH_SETUP = 'export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin"';
const MAC_HOST_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u;
const MAC_MODEL_PATTERN = /^[A-Za-z][A-Za-z0-9]*[0-9],[0-9]+$/u;
const DEFAULT_SESSION_LABEL = "omp-stable-pixel-qualification";
const MINIMUM_RELAY_SECONDS = 1_800;
const PROTECTED_REPOSITORY_FILES = ["STABLE_RELEASE.lock.json", "docs/RELEASE_STATUS.md"] as const;
function releaseAssetNames(version: string): readonly string[] {
  return [
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
    `omp-session-gateway-${version}-bun.tar`,
    `omp-session-gateway-${version}-bun.tar.sigstore.json`,
    `omp-session-gateway-${version}.spdx.json`,
    `omp-session-gateway-${version}.spdx.json.sigstore.json`,
  ];
}
function attestedAssetNames(version: string): readonly string[] {
  return [`omp-session-gateway-${version}-bun.tar`, `omp-session-gateway-${version}.spdx.json`, "SHA256SUMS"];
}
const LANE_NAMES = [
  "artifacts",
  "debian",
  "macos",
  "ompPublication",
  "android",
  "androidPush",
  "androidPushCleanup",
  "deviceCloud",
  "deviceCloudCleanup",
  "relay",
  "cleanup",
  "windows",
  "windowsCleanup",
] as const;
/** Lanes that own external resources, each paired with the lane that must release them. */
const CLEANUP_LANES = {
  windows: "windowsCleanup",
  androidPush: "androidPushCleanup",
  deviceCloud: "deviceCloudCleanup",
} as const;
const RECEIPT_SCHEMA_VERSION = 3;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The stable release this working tree's candidate must upgrade from and roll back to. Reads the
 * lock directly because argument parsing is synchronous, and fails loudly rather than qualifying
 * against a predecessor nobody can name.
 *
 * The lock answers this across both phases of a release, so both are handled rather than assuming
 * one: while a candidate is being qualified it still names the published stable, and once the ledger
 * is approved it names this version and records that same stable as `previousTag`.
 */
function publishedStableTag(): string {
  const lock: unknown = JSON.parse(readFileSync(join(repositoryRoot, "STABLE_RELEASE.lock.json"), "utf8"));
  const releaseTag = isRecord(lock) ? lock.releaseTag : undefined;
  const previousTag = isRecord(lock) ? lock.previousTag : undefined;
  const predecessor = releaseTag === `v${VERSION}` ? previousTag : releaseTag;
  if (typeof predecessor !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(predecessor)) {
    throw new Error("STABLE_RELEASE.lock.json must record the stable this version rolls back to");
  }
  // A release that claims itself as its own predecessor would qualify the upgrade and rollback pair
  // against nothing at all.
  if (predecessor === `v${VERSION}`) {
    throw new Error(`STABLE_RELEASE.lock.json names v${VERSION} as its own predecessor`);
  }
  return predecessor;
}
/**
 * The rollback predecessor a candidate must upgrade from and fall back to: always the currently
 * published stable, which the Debian and macOS lanes both install before the candidate.
 *
 * Derived from the stable lock rather than restated as a literal. A hand-maintained constant goes
 * stale exactly once per release and then qualifies the upgrade/rollback pair against a release
 * nobody is running: #200 fixed it from `v0.3.0` to `v0.4.0`, and it was still `v0.4.0` when 0.4.2
 * was cut. Publication rewrites the lock, so every later campaign inherits the right predecessor
 * with no edit here.
 */
const PREVIOUS_TAG = publishedStableTag();

export type StableQualificationLane = (typeof LANE_NAMES)[number];
export type LaneStatus = "pending" | "running" | "passed" | "failed";

export interface LaneReceipt {
  status: LaneStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  evidence?: Record<string, unknown>;
  error?: string;
  /** Additive evidence only: absence never grants automatic recovery authority. */
  failure?: readonly LaneFailure[];
  timings?: LaneTimings;
  notStartedReason?: "admission_failed" | "readiness_failed" | "dependency_failed";
}

export interface CandidateIdentity {
  tag: string;
  sourceCommit: string;
  archiveSha256: string;
}

export interface StableQualificationReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  tag: string;
  previousTag: string;
  status: "running" | "passed" | "failed";
  orchestratorCommit: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  candidate?: CandidateIdentity;
  /** The verified rollback predecessor that host lanes install before the candidate. */
  predecessor?: CandidateIdentity;
  /** SSH target bound before the first Mac effect; absent only in pre-Mac or historical receipts. */
  macHost?: string;
  lanes: Record<StableQualificationLane, LaneReceipt>;
  error?: string;
  execution?: QualificationExecution;
  failureSummary?: QualificationFailureSummary;
  rigReadiness?: RigReadinessReceipt;
}

export interface StableQualificationOptions {
  readonly preflight: boolean;
  readonly resumeDeviceCloud?: boolean;
  readonly outcomeFile?: string;
  readonly executionFile?: string;
  readonly retryReceiptSha256?: string;
  /** Internal, explicit qualification-only structured event destination. */
  readonly qualificationLogDirectory?: string;
  readonly tag: string;
  readonly previousTag: string;
  readonly receiptRoot: string;
  readonly macHost: string;
  readonly macModel: string;
  readonly macSudoPasswordFile?: string;
  readonly macLogin: string;
  readonly sessionLabel: string;
  readonly relaySeconds: number;
}

interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly echo?: boolean;
  readonly allowFailure?: boolean;
  readonly stdin?: Uint8Array;
  readonly execution?: QualificationExecutionContext;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ManagedProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): void;
}

interface MacTarget {
  readonly sshDestination: string;
  readonly sudoPassword: string;
}

interface MacContext {
  readonly target: MacTarget;
  readonly environment: Record<string, string>;
  readonly publicOrigin: string;
}

interface StagedMacRun {
  readonly context: MacContext;
  readonly output: string;
}

export interface OmpPins {
  readonly bunVersion: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly version: string;
  readonly nativeTarballSha256: string;
  readonly nativeBinarySha256: string;
}

export interface CandidateVerification extends CandidateIdentity {
  readonly assetDirectory: string;
  readonly releaseUrl: string;
}

export interface ProtectedFileSnapshot {
  readonly path: string;
  readonly sha256: string;
}

interface Checkpoint {
  (evidence: Record<string, unknown>): Promise<void>;
}

/** A signed release whose assets the orchestrator verified; lanes install from `archivePath`. */
export interface VerifiedRelease extends CandidateIdentity {
  readonly archivePath: string;
}

/** What every resource-owning lane is bound to. Nothing here is secret. */
export interface ExternalLaneIdentity {
  readonly tag: string;
  readonly previousTag: string;
  readonly orchestratorCommit: string;
  readonly receiptRoot: string;
  readonly candidate: VerifiedRelease;
  readonly predecessor: VerifiedRelease;
  readonly omp: OmpPins;
}

/** Serializes every lane that drives the single attached Pixel. */
export type PixelLease = <T>(owner: string, action: () => Promise<T>) => Promise<T>;

export interface ExternalLaneContext {
  readonly identity: ExternalLaneIdentity;
  /** The last checkpoint of an attempt a crash left running, which the lane may resume; otherwise undefined. */
  readonly progress: unknown;
  /** Persists the complete progress object, replacing the previous one. */
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
  readonly pixel: PixelLease;
  readonly execution?: QualificationExecutionContext;
}

export interface ExternalLanePreflightContext {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The admitted Pixel; read-only probes only. */
  readonly serial: string;
  readonly omp: OmpPins;
  /** The retained Mac's Tailscale Serve origin, where the candidate gateway will run. */
  readonly macOrigin: string;
}

export interface RemoteCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
/** Runs one bounded command on the retained Mac. Arguments are quoted, never interpreted locally. */
export type RemoteExecutor = (
  argv: readonly string[],
  options?: { readonly stdin?: Uint8Array; readonly timeoutMs?: number; readonly execution?: QualificationExecutionContext },
) => Promise<RemoteCommandResult>;

/** What the lanes that drive the retained Mac's live candidate gateway need beyond their identity. */
export interface RetainedMacLaneContext {
  /** The candidate gateway's Tailscale Serve origin on the retained Mac. */
  readonly origin: string;
  readonly mac: RemoteExecutor;
  /** The campaign's live OMP session on that gateway, which the Pixel's core lane also drives. */
  readonly sessionLabel: string;
  readonly qualificationLogs?: import("./qualification-logs.ts").QualificationLogs;
}

/**
 * A lane that owns external resources (a billed VM, a phone's radios and permissions) and so has a
 * cleanup lane of its own. Its progress carries a non-empty `epoch` from the first checkpoint, and
 * cleanup is idempotent: it attempts every step and fails if anything it recorded remains.
 */
export interface ExternalLaneModule<Extra extends object = object> {
  readonly preflight: (context: ExternalLanePreflightContext) => Promise<void>;
  readonly run: (context: ExternalLaneContext & Extra) => Promise<Record<string, unknown>>;
  readonly needsCleanup: (progress: unknown) => boolean;
  readonly cleanup: (context: ExternalLaneContext & Extra) => Promise<Record<string, unknown>>;
}

export interface StableQualificationLaneModules {
  readonly windows: ExternalLaneModule;
  readonly androidPush: ExternalLaneModule<RetainedMacLaneContext>;
  readonly deviceCloud: ExternalLaneModule<RetainedMacLaneContext>;
  readonly createPixelLease: (nextFailureId?: () => number) => PixelLease;
  readonly readiness?: {
    readonly windows: (identity: ExternalLaneIdentity) => Promise<RigReadinessReceipt["observations"]>;
    readonly push: (context: ExternalLaneContext & RetainedMacLaneContext) => Promise<Record<string, unknown>>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(): string {
  return new Date().toISOString();
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parsePositiveInteger(value: string, name: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return parsed;
}

export interface CandidateTagOptions {
  readonly preflight: boolean;
  readonly tag: string;
  readonly previousTag: string;
}

/**
 * The campaign's tag grammar and published predecessor, with no host configuration: lanes that
 * probe one surface (the Windows development CLI) share the candidate pair a campaign would use.
 */
export function parseCandidateTagArgs(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CandidateTagOptions {
  let tag: string | undefined;
  let preflight = false;
  let previousTag = environment.OMP_STABLE_PREVIOUS_TAG ?? PREVIOUS_TAG;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--preflight") preflight = true;
    else if (argument === "--tag") tag = argv[++index];
    else if (argument === "--previous-tag") previousTag = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${argument ?? ""}`);
  }
  if (tag === undefined) throw new Error(`usage: bun run qualify:stable [--preflight] --tag v${VERSION}-prealpha.<n> [--previous-tag ${PREVIOUS_TAG}]`);
  if (!CANDIDATE_TAG_PATTERN.test(tag)) {
    throw new Error(`--tag must match v${VERSION}-prealpha.<positive integer>`);
  }
  if (previousTag !== PREVIOUS_TAG) {
    throw new Error(`--previous-tag must name the published ${PREVIOUS_TAG} stable`);
  }
  return { preflight, tag, previousTag };
}

export function parseStableQualificationArgs(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StableQualificationOptions {
  let executionFile: string | undefined, retryReceiptSha256: string | undefined;
  const candidateArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--execution-file" || argument === "--retry-receipt-sha256") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("missing qualification execution argument");
      if (argument === "--execution-file") {
        if (executionFile !== undefined) throw new Error("duplicate execution file");
        executionFile = resolve(value);
      } else {
        if (retryReceiptSha256 !== undefined || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("invalid retry receipt digest");
        retryReceiptSha256 = value;
      }
    } else candidateArgs.push(argument);
  }
  const resumeDeviceCloud = argv.includes("--resume-device-cloud");
  if (argv.filter(argument => argument === "--resume-device-cloud").length > 1) throw new Error("--resume-device-cloud may be supplied only once");
  const { preflight, tag, previousTag } = parseCandidateTagArgs(candidateArgs.filter(argument => argument !== "--resume-device-cloud"), environment);
  if (resumeDeviceCloud && preflight) throw new Error("--resume-device-cloud requires a failed allocation receipt, not --preflight");
  if ((retryReceiptSha256 !== undefined && (executionFile === undefined || preflight)) ||
    (resumeDeviceCloud && executionFile !== undefined)) throw new Error("incompatible qualification retry arguments");
  const receiptRoot = resolve(
    environment.OMP_STABLE_QUALIFICATION_DIR ??
      join(homedir(), ".local", "share", "omp-session-gateway", "qualification", tag),
  );
  const sessionLabel = environment.OMP_STABLE_SESSION_LABEL ?? DEFAULT_SESSION_LABEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sessionLabel)) {
    throw new Error("OMP_STABLE_SESSION_LABEL must be a safe single path component of at most 128 characters");
  }
  const relaySeconds = parsePositiveInteger(
    environment.OMP_STABLE_RELAY_SECONDS ?? String(MINIMUM_RELAY_SECONDS),
    "OMP_STABLE_RELAY_SECONDS",
    3_600,
  );
  if (relaySeconds < MINIMUM_RELAY_SECONDS) throw new Error("OMP_STABLE_RELAY_SECONDS must be at least 1800");
  const macHost = environment.OMP_STABLE_MAC_HOST;
  if (macHost === undefined || !MAC_HOST_PATTERN.test(macHost)) {
    throw new Error("OMP_STABLE_MAC_HOST is required as user@host (DNS name or IPv4 address, without SSH options or a port)");
  }
  const macModel = environment.OMP_STABLE_MAC_MODEL;
  if (macModel === undefined || !MAC_MODEL_PATTERN.test(macModel)) {
    throw new Error("OMP_STABLE_MAC_MODEL is required as an exact hardware model, for example Mac17,14");
  }
  const macSudoPasswordFile = environment.OMP_STABLE_MAC_SUDO_PASSWORD_FILE;
  if (macSudoPasswordFile !== undefined && macSudoPasswordFile.trim() === "") {
    throw new Error("OMP_STABLE_MAC_SUDO_PASSWORD_FILE must name a private password file or be unset for passwordless sudo");
  }
  return {
    preflight,
    resumeDeviceCloud,
    ...(executionFile === undefined ? {} : { executionFile }),
    ...(retryReceiptSha256 === undefined ? {} : { retryReceiptSha256 }),
    ...(environment.OMP_STABLE_OUTCOME_FILE === undefined ? {} : { outcomeFile: resolve(environment.OMP_STABLE_OUTCOME_FILE) }),
    tag,
    previousTag,
    receiptRoot,
    macHost,
    macModel,
    ...(macSudoPasswordFile === undefined ? {} : { macSudoPasswordFile: resolve(macSudoPasswordFile) }),
    macLogin: (environment.OMP_STABLE_MAC_LOGIN ?? DEFAULT_MAC_LOGIN).trim().toLowerCase(),
    sessionLabel,
    relaySeconds,
  };
}

function emptyLanes(): Record<StableQualificationLane, LaneReceipt> {
  return Object.fromEntries(LANE_NAMES.map(name => [name, { status: "pending", attempts: 0 }])) as Record<
    StableQualificationLane,
    LaneReceipt
  >;
}

export function createStableQualificationReceipt(
  tag: string,
  orchestratorCommit: string,
  previousTag: string,
): StableQualificationReceipt {
  const startedAt = now();
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    tag,
    previousTag,
    status: "running",
    orchestratorCommit,
    startedAt,
    updatedAt: startedAt,
    lanes: emptyLanes(),
  };
}

export function validateStableQualificationReceipt(
  value: unknown,
  expectedTag: string,
  expectedCommit: string,
  expectedPreviousTag: string,
): StableQualificationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("qualification receipt is invalid");
  const receipt = value as Partial<StableQualificationReceipt>;
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `qualification receipt schema ${String(receipt.schemaVersion)} predates the real-device cloud lane; ` +
        "start a new campaign directory rather than resuming it",
    );
  }
  if (
    receipt.tag !== expectedTag ||
    receipt.previousTag !== expectedPreviousTag ||
    receipt.orchestratorCommit !== expectedCommit
  ) {
    throw new Error(
      "qualification receipt identity is invalid; do not resume evidence across orchestrator commits or rollback predecessors",
    );
  }
  if (receipt.macHost !== undefined && (typeof receipt.macHost !== "string" || !MAC_HOST_PATTERN.test(receipt.macHost))) {
    throw new Error("qualification receipt Mac host is invalid");
  }
  if (typeof receipt.lanes !== "object" || receipt.lanes === null) throw new Error("qualification receipt lanes are invalid");
  for (const name of LANE_NAMES) {
    const lane = receipt.lanes[name];
    if (!lane || !["pending", "running", "passed", "failed"].includes(lane.status) || !Number.isInteger(lane.attempts)) {
      throw new Error(`qualification receipt lane ${name} is invalid`);
    }
    if (lane.notStartedReason !== undefined && (lane.status !== "pending" ||
      !["admission_failed", "readiness_failed", "dependency_failed"].includes(lane.notStartedReason))) {
      throw new Error("qualification not-started reason is invalid");
    }
  }
  validateReceiptExecution(receipt as StableQualificationReceipt);
  return receipt as StableQualificationReceipt;
}

/** Validate new authority-bearing fields without rewriting or upgrading historical schema-3 receipts. */
function validateReceiptExecution(receipt: StableQualificationReceipt): void {
  const execution = receipt.execution === undefined ? undefined : parseQualificationExecution(receipt.execution);
  if (execution !== undefined) {
    const binding = execution.binding;
    if (binding.candidateTag !== receipt.tag || binding.previousTag !== receipt.previousTag ||
      binding.orchestratorCommit !== receipt.orchestratorCommit ||
      (receipt.candidate !== undefined && (receipt.candidate.tag !== binding.candidateTag ||
        receipt.candidate.sourceCommit !== binding.sourceCommit || receipt.candidate.archiveSha256 !== binding.archiveSha256)) ||
      (receipt.macHost !== undefined && createHash("sha256").update(receipt.macHost).digest("hex") !== binding.macHostSha256)) {
      throw new Error("qualification receipt execution binding is invalid");
    }
  }
  const summary = receipt.failureSummary === undefined ? undefined : parseQualificationFailureSummary(receipt.failureSummary);
  if (summary !== undefined && (execution === undefined || receipt.status !== "failed")) {
    throw new Error("qualification receipt failure summary is unbound or nonterminal");
  }
  if (receipt.rigReadiness !== undefined) {
    const readiness = parseRigReadinessReceipt(receipt.rigReadiness);
    if (readiness.campaignAttempt !== (execution?.campaignAttempt ?? 0)) {
      throw new Error("qualification receipt readiness attempt is unbound");
    }
  }
  const ids = new Set<number>();
  for (const name of LANE_NAMES) {
    const lane = receipt.lanes[name];
    if (lane.timings !== undefined) parseLaneTimings(name, lane.timings);
    if (lane.failure === undefined) continue;
    if (execution === undefined || lane.status !== "failed" || !Array.isArray(lane.failure) ||
      lane.failure.length < 1 || lane.failure.length > FAILURE_LIMITS.records) {
      throw new Error("qualification receipt lane failure is invalid");
    }
    const failures = lane.failure.map(parseLaneFailure);
    for (const failure of failures) {
      if (failure.lane !== name || ids.has(failure.id)) throw new Error("qualification receipt lane failure identity is invalid");
      ids.add(failure.id);
      if (summary !== undefined) {
        const recorded = summary.failures.find(item => item.id === failure.id);
        if (recorded === undefined || !isDeepStrictEqual(recorded, failure)) {
          throw new Error("qualification receipt lane failure differs from its summary");
        }
      }
    }
  }
  if (ids.size > FAILURE_LIMITS.records) throw new Error("qualification receipt failure count is invalid");
}

function assertNoSecretFields(value: unknown, path = "receipt"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:capability|password|secret|authKey|token|bearer)/iu.test(key)) {
      throw new Error(`refusing to persist secret-bearing receipt field ${path}.${key}`);
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
}

async function saveReceipt(path: string, receipt: StableQualificationReceipt): Promise<void> {
  receipt.updatedAt = now();
  validateReceiptExecution(receipt);
  assertNoSecretFields(receipt);
  const bytes = `${JSON.stringify(receipt, undefined, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const metadata = await lstat(dirname(path));
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new Error("unsafe qualification receipt directory");
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
/** Serializes writes because Android and relay lanes checkpoint the same receipt concurrently. */
export function createReceiptPersister(
  path: string,
  receipt: StableQualificationReceipt,
): () => Promise<void> {
  let tail = Promise.resolve();
  return () => {
    const operation = tail.then(() => saveReceipt(path, receipt));
    tail = operation.catch(() => {});
    return operation;
  };
}

async function loadReceipt(
  path: string,
  tag: string,
  commit: string,
  previousTag: string,
): Promise<StableQualificationReceipt> {
  if (!(await Bun.file(path).exists())) return createStableQualificationReceipt(tag, commit, previousTag);
  return validateStableQualificationReceipt(JSON.parse(await readFile(path, "utf8")), tag, commit, previousTag);
}

export async function executeReceiptLane<T extends Record<string, unknown>>(
  receipt: StableQualificationReceipt,
  name: StableQualificationLane,
  persist: () => Promise<void>,
  action: (checkpoint: Checkpoint) => Promise<T>,
  force = false,
): Promise<T> {
  const lane = receipt.lanes[name];
  if (!force && lane.status === "passed") return (lane.evidence ?? {}) as T;
  lane.status = "running";
  lane.attempts += 1;
  lane.startedAt = now();
  delete lane.completedAt;
  delete lane.error;
  delete lane.failure;
  delete lane.notStartedReason;
  await persist();
  const checkpoint: Checkpoint = async evidence => {
    lane.evidence = { ...(lane.evidence ?? {}), ...evidence };
    await persist();
  };
  try {
    const evidence = await action(checkpoint);
    lane.status = "passed";
    lane.completedAt = now();
    lane.evidence = evidence;
    delete lane.error;
    await persist();
    return evidence;
  } catch (error) {
    lane.status = "failed";
    lane.completedAt = now();
    lane.error = "lane execution failed; inspect the qualification process output";
    const outcome = name === "deviceCloud" ? recognizedDeviceCloudOutcome(error) : undefined;
    if (name === "deviceCloud") {
      if (outcome !== undefined) lane.evidence = { ...lane.evidence, availabilityHold: outcome.availabilityHolds };
      else if (lane.evidence !== undefined) delete lane.evidence.availabilityHold;
    }
    const failure = receipt.execution === undefined ? error : laneFailure(error, name, () => nextReceiptFailureId(receipt));
    if (receipt.execution !== undefined) {
      // Collateral references are validated against the full campaign graph at finalization.
      const leaves = (value: unknown): LaneFailure[] => value instanceof QualificationFailure ? [value.evidence] :
        value instanceof AggregateError ? value.errors.flatMap(leaves) : [];
      const own = leaves(failure).filter(item => item.lane === name);
      if (own.length > 0) lane.failure = own;
    }
    await persist();
    throw failure;
  }
}

/**
 * One attached Pixel serves the core Android lane, background Push, and the Windows physical
 * client. Push changes radios, Doze and notification permission, which would corrupt either other
 * lane mid-run, so every Pixel action runs alone. In-process only: RELEASE.md allows one campaign
 * at a time, and a second orchestrator process is not coordinated.
 *
 * An action that could not restore the device throws an error carrying `pixelUnrestored: true`.
 * The lease then refuses every later action, so no lane measures a phone another lane left in an
 * unknown state, and a failed restore can never be mistaken for the next lane's baseline.
 */
export function createPixelLease(
  log: (line: string) => void = line => console.error(line),
  allocate?: () => number,
): PixelLease {
  let tail: Promise<unknown> = Promise.resolve();
  let holder: string | undefined;
  let unrestoredBy: string | undefined;
  let sequence = 0;
  const nextId = allocate ?? (() => ++sequence);
  let origins: readonly number[] = [];
  return (owner, action) => {
    if (holder !== undefined) log(`pixel lease: ${owner} waits for ${holder}`);
    const turn = tail.then(async () => {
      if (unrestoredBy !== undefined) {
        const lane = (owner.startsWith("windows") ? "windows" : owner.startsWith("deviceCloud") ? "deviceCloud" :
          owner.startsWith("androidPush") ? "androidPush" : owner === "android" ? "android" : "rigReadiness");
        throw new QualificationFailure({
          id: nextId(), lane, step: FAILURE_STEPS[lane][0], class: "collateral", reason: "dependency_failed",
          elapsedMs: 0, operation: "not_started", observations: {}, originIds: origins,
        } as LaneFailure);
      }
      holder = owner;
      try {
        return await action();
      } catch (error) {
        if (pixelUnrestored(error)) {
          unrestoredBy = owner;
          const source = laneFailure(error, owner === "android" ? "android" : owner.startsWith("windows") ? "windows" :
            owner.startsWith("deviceCloud") ? "deviceCloud" : owner.startsWith("androidPush") ? "androidPush" : "rigReadiness", nextId);
          origins = normalizeQualificationFailures(source).filter(item => item.class !== "collateral").map(item => item.id);
          throw Object.assign(source as Error, { pixelUnrestored: true });
        }
        throw error;
      } finally {
        holder = undefined;
      }
    });
    tail = turn.catch(() => {});
    return turn;
  };
}

type ExternalLaneName = keyof typeof CLEANUP_LANES;

function laneProgress(lane: LaneReceipt): unknown {
  return isRecord(lane.evidence) ? lane.evidence.progress : undefined;
}

/** Whether a lane's receipt still records external effects. Unreadable progress counts as effects. */
function recordedEffects(module: ExternalLaneModule<never>, lane: LaneReceipt): boolean {
  if (lane.attempts === 0 && lane.status === "pending" && lane.evidence === undefined) return false;
  try {
    return module.needsCleanup(laneProgress(lane));
  } catch {
    return true;
  }
}

function progressEpoch(progress: unknown): string | undefined {
  return isRecord(progress) && typeof progress.epoch === "string" && progress.epoch !== "" ? progress.epoch : undefined;
}

/** True only when the cleanup lane passed for the attempt its primary lane last recorded. */
export function externalCleanupCurrent(receipt: StableQualificationReceipt, name: ExternalLaneName): boolean {
  const epoch = progressEpoch(laneProgress(receipt.lanes[name]));
  const cleanup = receipt.lanes[CLEANUP_LANES[name]];
  return epoch !== undefined && cleanup.status === "passed" && cleanup.evidence?.epoch === epoch;
}

/** Eligibility is read-only and must run before admission, receipt mutation, or renewed effects. */
export function assertDeviceCloudResumeEligible(
  receipt: StableQualificationReceipt,
  expected: { readonly tag: string; readonly previousTag: string; readonly orchestratorCommit: string; readonly macHost: string },
  modules: StableQualificationLaneModules = defaultLaneModules,
): readonly DeviceCloudHold[] {
  validateStableQualificationReceipt(receipt, expected.tag, expected.orchestratorCommit, expected.previousTag);
  if (receipt.status !== "failed" || receipt.macHost !== expected.macHost || receipt.candidate?.tag !== expected.tag ||
    receipt.predecessor?.tag !== expected.previousTag || !/^[a-f0-9]{40}$/u.test(receipt.candidate.sourceCommit) ||
    !/^[a-f0-9]{64}$/u.test(receipt.candidate.archiveSha256) || !/^[a-f0-9]{40}$/u.test(receipt.predecessor.sourceCommit) ||
    !/^[a-f0-9]{64}$/u.test(receipt.predecessor.archiveSha256)) throw new Error("device-cloud resume receipt identity or campaign verdict is ineligible");
  for (const name of LANE_NAMES) {
    if (receipt.lanes[name].status !== (name === "deviceCloud" ? "failed" : "passed") || receipt.lanes[name].attempts < 1) {
      throw new Error("device-cloud resume requires every other qualification and cleanup lane passed");
    }
  }
  const holds = parseDeviceCloudHoldSet(receipt.lanes.deviceCloud.evidence?.availabilityHold);
  if (holds.some(hold => hold.stage === "allocation" && hold.epoch !== progressEpoch(laneProgress(receipt.lanes.deviceCloud)))) {
    throw new Error("device-cloud resume hold does not identify the failed allocation attempt");
  }
  for (const name of Object.keys(CLEANUP_LANES) as ExternalLaneName[]) {
    if (!externalCleanupCurrent(receipt, name) || modules[name].needsCleanup(laneProgress(receipt.lanes[name]))) {
      throw new Error("device-cloud resume refuses dirty resources or stale cleanup");
    }
    const result = receipt.lanes[name].evidence?.result;
    if (name !== "deviceCloud" && (!isRecord(result) || result.passed === false)) {
      throw new Error("device-cloud resume requires passed external-lane results");
    }
  }
  assertPublicationProof(receipt);
  return holds;
}

function assertPublicationProof(receipt: StableQualificationReceipt): void {
  const publication = receipt.lanes.ompPublication.evidence;
  const lifecycle = isRecord(publication?.lifecycle) ? publication.lifecycle : undefined;
  if (publication?.published !== true || publication.revoked !== true || lifecycle === undefined ||
    !isRecord(lifecycle.newGeneration) || !isRecord(lifecycle.fork) || !isRecord(lifecycle.resumed) ||
    lifecycle.newGeneration.sameInstance !== true || lifecycle.newGeneration.generationDelta !== 1 ||
    lifecycle.newGeneration.staleRejected !== true || lifecycle.newGeneration.liveLaunches !== 2 || lifecycle.newGeneration.noStore !== true ||
    lifecycle.fork.sameInstance !== true || lifecycle.fork.generationDelta !== 1 || lifecycle.fork.syntheticMessages !== 2 ||
    lifecycle.fork.staleRejected !== true || lifecycle.fork.liveLaunches !== 2 || lifecycle.fork.noStore !== true ||
    lifecycle.resumed.newInstance !== true || lifecycle.resumed.generation !== 1 || lifecycle.resumed.sameLabel !== true ||
    lifecycle.resumed.liveLaunches !== 2 || lifecycle.resumed.noStore !== true || lifecycle.resumed.revocations !== 2) {
    throw new Error("device-cloud resume requires completed OMP publication lifecycle proof");
  }
}

/** Read-only authority check shared by the worker and driver; historical receipts grant none. */
export function assertCampaignRetryEligible(
  receipt: StableQualificationReceipt,
  expected: QualificationExecution,
  modules: StableQualificationLaneModules = defaultLaneModules,
): readonly StableQualificationLane[] {
  assertCampaignCleanupComplete(receipt, expected, modules);
  const execution = parseQualificationExecution(expected);
  if (!qualificationRetryEligible(receipt.failureSummary, true) || execution.campaignAttempt >= 2) {
    throw new Error("campaign retry lacks terminal bound infrastructure evidence");
  }
  if (receipt.lanes.ompPublication.status === "passed") assertPublicationProof(receipt);
  const holds = receipt.lanes.deviceCloud.evidence?.availabilityHold;
  if (holds !== undefined && parseDeviceCloudHoldSet(holds).some(hold =>
    hold.stage === "allocation" && hold.epoch !== progressEpoch(laneProgress(receipt.lanes.deviceCloud)))) {
    throw new Error("campaign retry cloud hold epoch changed");
  }
  return LANE_NAMES.filter(name => receipt.lanes[name].status !== "passed");
}

/** Containment-only retirement check; it grants neither retry authority nor a qualification pass. */
export function assertCampaignCleanupComplete(
  receipt: StableQualificationReceipt,
  expected: QualificationExecution,
  modules: StableQualificationLaneModules = defaultLaneModules,
): void {
  const execution = parseQualificationExecution(expected);
  validateStableQualificationReceipt(receipt, execution.binding.candidateTag, execution.binding.orchestratorCommit, execution.binding.previousTag);
  if (!qualificationExecutionsMatch(receipt.execution, execution) || receipt.status !== "failed" || receipt.completedAt === undefined ||
    receipt.failureSummary?.containment.proven !== true || receipt.failureSummary.containment.cleanupComplete !== true ||
    Object.values(receipt.lanes).some(lane => lane.status === "running")) {
    throw new Error("campaign cleanup lacks terminal bound containment evidence");
  }
  if (receipt.lanes.artifacts.status === "passed" && (receipt.candidate === undefined || receipt.predecessor === undefined)) {
    throw new Error("campaign cleanup lacks verified release identities");
  }
  if (receipt.predecessor !== undefined && (receipt.predecessor.tag !== execution.binding.previousTag ||
    !/^[a-f0-9]{40}$/u.test(receipt.predecessor.sourceCommit) || !/^[a-f0-9]{64}$/u.test(receipt.predecessor.archiveSha256))) throw new Error("campaign predecessor identity changed");
  if (receipt.macHost !== undefined && sha256(receipt.macHost) !== execution.binding.macHostSha256) {
    throw new Error("campaign retry Mac binding changed");
  }
  if (receipt.rigReadiness?.cleanupDisposition === "unresolved" || receiptNeedsMacCleanup(receipt)) {
    throw new Error("campaign retry refuses unresolved Mac or readiness effects");
  }
  const debian = receipt.lanes.debian;
  if (debian.status !== "passed" && !(debian.status === "pending" && debian.attempts === 0 && debian.evidence === undefined)) {
    throw new Error("campaign Debian workflow teardown is unproven");
  }
  for (const name of Object.keys(CLEANUP_LANES) as ExternalLaneName[]) {
    const lane = receipt.lanes[name];
    if (lane.attempts === 0 && lane.status === "pending" && lane.evidence === undefined) continue;
    // A refused lease/admission before its epoch has no resources; still require the cleanup proof.
    const empty = laneProgress(lane) === undefined && receipt.lanes[CLEANUP_LANES[name]].evidence?.noAttempt === true;
    if ((!empty && !externalCleanupCurrent(receipt, name)) || modules[name].needsCleanup(laneProgress(lane)) ||
      receipt.lanes[CLEANUP_LANES[name]].status !== "passed") throw new Error("campaign retry refuses dirty resources or stale cleanup");
  }
  const cloud = laneProgress(receipt.lanes.deviceCloud);
  if (cloud !== undefined) {
    if (!isRecord(cloud) || !Array.isArray(cloud.resources)) throw new Error("campaign cloud allocation inventory is unproven");
    const audit = isRecord(cloud.results) && isRecord(cloud.results.audit) ? cloud.results.audit : undefined;
    if (cloud.resources.some(resource => !isRecord(resource) || typeof resource.sessionId !== "string" ||
      resource.ended !== true || resource.audited !== true || resource.incident === true || resource.unauditedDeletion === true ||
      (resource.vendor === "browserstack" && resource.recordRemoved !== true)) ||
      (cloud.resources.length > 0 && audit?.records !== cloud.resources.length) ||
      (audit !== undefined && (audit.records !== cloud.resources.length || audit.recordsExposingLinks !== 0 ||
        audit.recordsWithMedia !== 0 || (audit.lingeringSignedArtifacts !== undefined && audit.lingeringSignedArtifacts !== 0)))) {
      throw new Error("campaign cloud retained-record audit is unresolved");
    }
  }
}

/** The previous job snapshot is immutable; only the working receipt advances, before admission. */
export async function withConsumedCampaignRetry<T>(
  receipt: StableQualificationReceipt,
  nextExecution: QualificationExecution,
  persist: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const next = parseQualificationExecution(nextExecution);
  const previous = receipt.execution;
  if (previous === undefined || next.campaignAttempt !== previous.campaignAttempt + 1 ||
    !isDeepStrictEqual(next.binding, previous.binding)) throw new Error("campaign retry execution does not advance the exact subject");
  receipt.execution = next;
  receipt.status = "running";
  delete receipt.completedAt;
  delete receipt.failureSummary;
  delete receipt.rigReadiness;
  delete receipt.error;
  for (const lane of Object.values(receipt.lanes)) {
    delete lane.failure;
    if (lane.status === "failed") {
      lane.status = "pending";
      delete lane.startedAt;
      delete lane.completedAt;
      delete lane.error;
    }
  }
  if (receipt.lanes.deviceCloud.evidence !== undefined) delete receipt.lanes.deviceCloud.evidence.availabilityHold;
  await persist();
  return run();
}

/** Consume old authorization durably before any resumed setup, including setup outside finally. */
export async function withConsumedDeviceCloudHold<T>(
  receipt: StableQualificationReceipt,
  persist: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  if (receipt.lanes.deviceCloud.evidence !== undefined) delete receipt.lanes.deviceCloud.evidence.availabilityHold;
  await persist();
  try { return await run(); }
  catch (error) {
    if (recognizedDeviceCloudOutcome(error) === undefined) {
      if (receipt.lanes.deviceCloud.evidence !== undefined) delete receipt.lanes.deviceCloud.evidence.availabilityHold;
      receipt.status = "failed";
      receipt.error = "qualification failed; inspect the qualification process output";
      await persist();
    }
    throw error;
  }
}

/** Only a newly validated, all-hold failure can grant same-receipt authorization again. */
export async function recordDeviceCloudCampaignFailure(
  receipt: StableQualificationReceipt,
  error: unknown,
  expected: { readonly tag: string; readonly previousTag: string; readonly orchestratorCommit: string; readonly macHost: string },
  persist: () => Promise<void>,
  modules: StableQualificationLaneModules = defaultLaneModules,
  outcomeFile?: string,
): Promise<unknown> {
  receipt.status = "failed";
  receipt.completedAt = now();
  receipt.error = "qualification failed; inspect the qualification process output";
  if (receipt.lanes.deviceCloud.evidence !== undefined) delete receipt.lanes.deviceCloud.evidence.availabilityHold;
  const outcome = recognizedDeviceCloudOutcome(error);
  let failure = error;
  if (outcome !== undefined) {
    receipt.lanes.deviceCloud.evidence = { ...receipt.lanes.deviceCloud.evidence, availabilityHold: outcome.availabilityHolds };
    try {
      assertDeviceCloudResumeEligible(receipt, expected, modules);
      await writeDeviceCloudOutcomeFile(outcomeFile, outcome);
    } catch (eligibilityError) {
      delete receipt.lanes.deviceCloud.evidence.availabilityHold;
      failure = new AggregateError([error, eligibilityError], "qualification availability and eligibility failed");
    }
  }
  await persist();
  return failure;
}

/** One terminal write after all owned operations and cleanup have actually settled. */
export async function finalizeCampaignFailure(
  receipt: StableQualificationReceipt,
  error: unknown,
  persist: () => Promise<void>,
  modules: StableQualificationLaneModules = defaultLaneModules,
  timings = { attemptMs: 0, cleanupMs: 0 },
): Promise<void> {
  const unique: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof AggregateError) { for (const child of value.errors) visit(child); }
    else unique.push(value);
  };
  visit(error);
  const failures = [...normalizeQualificationFailures(new AggregateError(unique, "qualification failed"))];
  const ids = new Set(failures.map(item => item.id));
  for (const lane of Object.values(receipt.lanes)) for (const failure of lane.failure ?? []) {
    if (!ids.has(failure.id)) { failures.push(failure); ids.add(failure.id); }
  }
  for (const name of LANE_NAMES) {
    const lane = receipt.lanes[name];
    if (lane.status === "pending") {
      lane.notStartedReason = receipt.rigReadiness?.status === "failed" ? "readiness_failed" :
        receipt.lanes.artifacts.attempts === 0 ? "admission_failed" : "dependency_failed";
    }
    if (lane.status === "failed" && lane.completedAt === undefined) lane.completedAt = now();
    if (lane.status !== "running") continue;
    lane.status = "failed";
    lane.completedAt = now();
    lane.error = "qualification dependency did not complete";
    let id = nextReceiptFailureId(receipt);
    while (ids.has(id)) id = nextReceiptFailureId(receipt);
    const origins = failures.filter(item => item.class !== "collateral").map(item => item.id);
    const failure = parseLaneFailure({ id, lane: name, step: FAILURE_STEPS[name][0], reason: "dependency_failed",
      class: "collateral", elapsedMs: 0, operation: "not_started", observations: {}, originIds: origins });
    failures.push(failure);
    ids.add(id);
    if (receipt.execution !== undefined) lane.failure = [failure];
  }
  receipt.status = "failed";
  receipt.completedAt = now();
  receipt.error = "qualification failed; inspect fixed failure evidence";
  if (receipt.execution !== undefined) {
    for (const name of LANE_NAMES) {
      const lane = receipt.lanes[name];
      if (lane.status !== "failed") continue;
      let own = failures.filter(item => item.lane === name);
      if (own.length === 0) {
        let id = nextReceiptFailureId(receipt);
        while (ids.has(id)) id = nextReceiptFailureId(receipt);
        const missing = parseLaneFailure({ id, lane: name, step: FAILURE_STEPS[name][0], reason: "unclassified_failure",
          class: "harness", elapsedMs: 0, operation: "unknown", observations: {} });
        failures.push(missing);
        ids.add(id);
        own = [missing];
      }
      lane.failure = own;
    }
    let cleanupComplete = !receiptNeedsMacCleanup(receipt) && receipt.rigReadiness?.cleanupDisposition !== "unresolved";
    for (const name of Object.keys(CLEANUP_LANES) as ExternalLaneName[]) {
      const lane = receipt.lanes[name];
      if (lane.attempts === 0 && lane.status === "pending" && lane.evidence === undefined) continue;
      try {
        cleanupComplete &&= !modules[name].needsCleanup(laneProgress(lane)) &&
          receipt.lanes[CLEANUP_LANES[name]].status === "passed" &&
          (externalCleanupCurrent(receipt, name) || (laneProgress(lane) === undefined && receipt.lanes[CLEANUP_LANES[name]].evidence?.noAttempt === true));
      } catch { cleanupComplete = false; }
    }
    const summary = parseQualificationFailureSummary({
      failures, timings,
      containment: { proven: cleanupComplete, cleanupComplete, unresolvedMutation: failures.some(item => item.operation === "unknown") },
    });
    receipt.failureSummary = summary;
  }
  await persist();
}

type ExternalLaneRunContext<Extra extends object> = {
  readonly identity: ExternalLaneIdentity;
  readonly pixel: PixelLease;
  readonly execution?: QualificationExecutionContext;
} & Extra;

const cleanupQueues = new WeakMap<StableQualificationReceipt, Map<ExternalLaneName, Promise<void>>>();

/** Replaces the whole progress object, so no phase can pair with a previous attempt's resources. */
function externalCheckpoint(primary: LaneReceipt, persist: () => Promise<void>) {
  return async (progress: Record<string, unknown>): Promise<void> => {
    const result = primary.evidence?.result;
    primary.evidence = result === undefined ? { progress } : { progress, result };
    await persist();
  };
}

/** Releases what the primary lane recorded and binds the cleanup lane to that attempt's epoch. */
export async function cleanExternalLane<Extra extends object>(
  receipt: StableQualificationReceipt,
  name: ExternalLaneName,
  persist: () => Promise<void>,
  module: ExternalLaneModule<Extra>,
  context: ExternalLaneRunContext<Extra>,
): Promise<void> {
  let queues = cleanupQueues.get(receipt);
  if (queues === undefined) { queues = new Map(); cleanupQueues.set(receipt, queues); }
  const prior = queues.get(name) ?? Promise.resolve();
  const operation = prior.catch(() => {}).then(() => trackCleanup(receipt, async () => {
  const primary = receipt.lanes[name];
  await executeReceiptLane(receipt, CLEANUP_LANES[name], persist, async () => {
    const epoch = progressEpoch(laneProgress(primary)) ?? null;
    const evidence = await withQualificationDeadline(CLEANUP_LANES[name], QUALIFICATION_CEILINGS_MS[CLEANUP_LANES[name]],
      () => nextReceiptFailureId(receipt), execution => module.cleanup({
      ...context,
      execution,
      progress: laneProgress(primary),
      checkpoint: externalCheckpoint(primary, persist),
    }));
    if (module.needsCleanup(laneProgress(primary))) {
      throw new Error(`${name} cleanup returned while its progress still records resources`);
    }
    return { ...evidence, epoch };
  }, true);
  }));
  queues.set(name, operation);
  try { await operation; }
  finally { if (queues.get(name) === operation) queues.delete(name); }
}

/**
 * Runs one resource-owning lane, then always its cleanup lane.
 *
 * A crash leaves the lane `running`, and the module may resume that attempt from its last
 * checkpoint. A caught failure is never resumed: its resources are released before a new attempt
 * begins, and a failed release stops the lane there, because a second VM or a second device
 * mutation on top of unreleased ones is exactly what cleanup exists to prevent.
 */
export async function runExternalLane<Extra extends object>(
  receipt: StableQualificationReceipt,
  name: ExternalLaneName,
  persist: () => Promise<void>,
  module: ExternalLaneModule<Extra>,
  context: ExternalLaneRunContext<Extra>,
): Promise<void> {
  const primary = receipt.lanes[name];
  const cleanUp = () => cleanExternalLane(receipt, name, persist, module, context);
  const initial = primary.status;
  if (initial === "passed") {
    if (!externalCleanupCurrent(receipt, name) || module.needsCleanup(laneProgress(primary))) await cleanUp();
    return;
  }
  if (initial === "failed" && (module.needsCleanup(laneProgress(primary)) || !externalCleanupCurrent(receipt, name))) {
    await cleanUp();
  }
  const resumable = initial === "running" ? laneProgress(primary) : undefined;
  if (resumable === undefined) delete primary.evidence;
  let failure: unknown;
  try {
    await executeReceiptLane(receipt, name, persist, async () => {
      const result = await withQualificationDeadline(name, QUALIFICATION_CEILINGS_MS[name], () => nextReceiptFailureId(receipt),
        execution => module.run({ ...context, execution, progress: resumable, checkpoint: externalCheckpoint(primary, persist) }));
      if (progressEpoch(laneProgress(primary)) === undefined) {
        throw new Error(`${name} returned without checkpointing an attempt epoch`);
      }
      // A lane may finish its sequence and still report a blocked phase; that is evidence, not a pass.
      // Its checkpointed progress keeps the per-phase results.
      if (result.passed === false) throw new Error(`${name} completed without passing every phase`);
      return { progress: laneProgress(primary), result };
    });
  } catch (error) {
    failure = error;
  }
  try {
    await cleanUp();
  } catch (cleanupError) {
    failure = failure === undefined ? cleanupError : new AggregateError([failure, cleanupError], `${name} and its cleanup failed`);
  }
  if (failure !== undefined) throw failure;
}

/** The first reason the receipt cannot be a pass, or undefined when every lane holds. */
export function incompleteQualification(receipt: StableQualificationReceipt): string | undefined {
  const lane = LANE_NAMES.find(name => receipt.lanes[name].status !== "passed");
  if (lane !== undefined) return `qualification lane ${lane} did not pass`;
  for (const name of Object.keys(CLEANUP_LANES) as ExternalLaneName[]) {
    const result = receipt.lanes[name].evidence?.result;
    if (!isRecord(result)) return `qualification lane ${name} passed without a result`;
    if (result.passed === false) return `qualification lane ${name} recorded a result that did not pass`;
    if (!externalCleanupCurrent(receipt, name)) {
      return `${CLEANUP_LANES[name]} did not pass for the attempt that ${name} recorded`;
    }
  }
  return undefined;
}

async function runCommand(command: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
  options.execution?.signal.throwIfAborted();
  const environment = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const subprocess = Bun.spawn([...command], {
    cwd: options.cwd ?? repositoryRoot,
    env: environment,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const signalOwner = (signal: NodeJS.Signals) => {
    if (process.platform === "win32") { subprocess.kill(signal); return; }
    try { process.kill(-subprocess.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const terminate = () => {
    if (forceKillTimer !== undefined) return;
    signalOwner("SIGTERM");
    forceKillTimer = setTimeout(() => signalOwner("SIGKILL"), 10_000);
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); },
    Math.max(1, Math.min(options.timeoutMs ?? 30 * 60_000, (options.execution?.deadline ?? Infinity) - performance.now())));
  options.execution?.signal.addEventListener("abort", terminate, { once: true });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  clearTimeout(timer);
  options.execution?.signal.removeEventListener("abort", terminate);
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  if (options.echo) {
    if (stdout.length > 0) process.stdout.write(stdout);
    if (stderr.length > 0) process.stderr.write(stderr);
  }
  options.execution?.signal.throwIfAborted();
  if (timedOut) throw new Error("qualification command timed out; output withheld");
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`qualification command exited ${exitCode}; output withheld`);
  }
  return { exitCode, stdout, stderr };
}

/**
 * Runs a child that mutates the Pixel and restores it itself. From outside, a failed or timed-out
 * child cannot prove its restoration ran (a killed process restores nothing, and a restoration
 * failure arrives only as text), so its failure leaves the Pixel lease refusing later device lanes.
 */
export async function runPixelRestoringChild(command: readonly string[], options: CommandOptions): Promise<CommandResult> {
  try {
    return await runCommand(command, options);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("Pixel child failed"), { pixelUnrestored: true });
  }
}

async function commandOutput(command: readonly string[], options: CommandOptions = {}): Promise<string> {
  return (await runCommand(command, options)).stdout.trim();
}

async function captureProtectedFiles(): Promise<ProtectedFileSnapshot[]> {
  return Promise.all(
    PROTECTED_REPOSITORY_FILES.map(async path => ({
      path,
      sha256: sha256(await readFile(join(repositoryRoot, path))),
    })),
  );
}

export async function assertProtectedFilesUnchanged(
  snapshots: readonly ProtectedFileSnapshot[],
  root = repositoryRoot,
): Promise<void> {
  for (const snapshot of snapshots) {
    const current = sha256(await readFile(join(root, snapshot.path)));
    if (current !== snapshot.sha256) {
      throw new Error(`qualification modified protected release state: ${snapshot.path}`);
    }
  }
}

export function releaseArchivePath(assetDirectory: string, tag: string): string {
  return join(assetDirectory, `omp-session-gateway-${releaseVersion(tag)}-bun.tar`);
}

function candidateAssetDirectory(options: StableQualificationOptions): string {
  return join(options.receiptRoot, "assets");
}

function predecessorAssetDirectory(options: StableQualificationOptions): string {
  return join(options.receiptRoot, "predecessor-assets");
}

/**
 * Verifies one published release end to end: the signed tag, the exact asset set, GitHub release
 * state, checksums, and signatures. Candidates and non-allowlisted predecessors require every
 * GitHub attestation; only a digest-pinned historical predecessor uses its original Cosign proof.
 * The candidate is a prerelease; the predecessor must be the stable that is GitHub Latest.
 */
export async function verifyRelease(
  tag: string,
  assetDirectory: string,
  stable: boolean,
  ghToken: string,
): Promise<CandidateVerification & {
  readonly githubAttestations: "3/3" | "historical-cosign";
  readonly historicalSignature?: NonNullable<ReturnType<typeof historicalPredecessor>>;
}> {
  const version = releaseVersion(tag);
  await runCommand(["git", "fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`], { timeoutMs: 120_000 });
  await runCommand(["git", "tag", "-v", tag], { timeoutMs: 120_000 });
  const sourceCommit = await commandOutput(["git", "rev-list", "-n1", tag]);
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error(`${tag} did not resolve to a commit`);

  await downloadReleaseAssets(assetDirectory, () =>
    runCommand(["gh", "release", "download", tag, "--repo", REPOSITORY, "--dir", assetDirectory], {
      timeoutMs: 300_000,
    }),
  );
  const downloaded = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: assetDirectory }))).sort();
  if (JSON.stringify(downloaded) !== JSON.stringify([...releaseAssetNames(version)].sort())) {
    throw new Error(`${tag} release assets differ: ${downloaded.join(", ")}`);
  }
  const ghEnvironment = { GH_TOKEN: ghToken };
  await runCommand([process.execPath, "scripts/release-tag-state.ts", REPOSITORY, tag, sourceCommit], {
    env: ghEnvironment,
  });
  await runCommand(
    [process.execPath, "scripts/release-state.ts", REPOSITORY, tag, "false", String(!stable), String(stable), assetDirectory],
    { env: ghEnvironment },
  );
  await runCommand(["shasum", "-a", "256", "-c", "SHA256SUMS"], { cwd: assetDirectory });

  const archiveSha256 = sha256(await readFile(releaseArchivePath(assetDirectory, tag)));
  const historicalSignature = stable ? historicalPredecessor(REPOSITORY, tag, archiveSha256) : undefined;
  for (const asset of attestedAssetNames(version)) {
    await verifyReleaseSignatures(join(assetDirectory, asset), REPOSITORY, tag, argv =>
      runCommand(argv, { timeoutMs: 300_000 }),
      stable ? archiveSha256 : undefined,
    );
  }
  const release = JSON.parse(
    await commandOutput(["gh", "release", "view", tag, "--repo", REPOSITORY, "--json", "url"]),
  ) as { url?: unknown };
  if (typeof release.url !== "string") throw new Error(`${tag} release URL is missing`);
  return { tag, sourceCommit, archiveSha256, assetDirectory, releaseUrl: release.url,
    githubAttestations: historicalSignature === undefined ? "3/3" : "historical-cosign",
    ...(historicalSignature === undefined ? {} : { historicalSignature }) };
}

function assertSameRelease(recorded: CandidateIdentity | undefined, verified: CandidateIdentity, role: string): void {
  if (
    recorded !== undefined &&
    (recorded.tag !== verified.tag ||
      recorded.sourceCommit !== verified.sourceCommit ||
      recorded.archiveSha256 !== verified.archiveSha256)
  ) {
    throw new Error(`${role} identity changed since the resumable receipt was created`);
  }
}

/** Built from the receipt alone, so recorded external effects stay cleanable without admission. */
function externalLaneIdentity(
  options: StableQualificationOptions,
  receipt: StableQualificationReceipt,
  orchestratorCommit: string,
  omp: OmpPins,
): ExternalLaneIdentity {
  const { candidate, predecessor } = receipt;
  if (candidate === undefined || predecessor === undefined) {
    throw new Error("external lanes require verified candidate and predecessor identities");
  }
  return {
    tag: options.tag,
    previousTag: options.previousTag,
    orchestratorCommit,
    receiptRoot: options.receiptRoot,
    candidate: { ...candidate, archivePath: releaseArchivePath(candidateAssetDirectory(options), candidate.tag) },
    predecessor: {
      ...predecessor,
      archivePath: releaseArchivePath(predecessorAssetDirectory(options), predecessor.tag),
    },
    omp,
  };
}

/** The single remote shell line for `argv`: ssh hands it to the login shell, which must see each element verbatim. */
export function remoteCommandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

export function remoteExecutor(target: MacTarget): RemoteExecutor {
  return (argv, options = {}) =>
    runCommand(
      [
        "ssh",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "BatchMode=yes",
        "-q",
        target.sshDestination,
        `${MAC_PATH_SETUP}; ${remoteCommandLine(argv)}`,
      ],
      {
        allowFailure: true,
        timeoutMs: options.timeoutMs ?? 5 * 60 * 1_000,
        ...(options.execution === undefined ? {} : { execution: options.execution }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      },
    );
}

async function gitQualificationRef(commit: string, output: StablePreflightRuntime["output"]): Promise<string> {
  const status = await output(["git", "--no-optional-locks", "status", "--porcelain"]);
  if (status !== "") throw new Error("stable qualification requires a clean working tree");
  const branch = await output(["git", "branch", "--show-current"]);
  if (branch === "") throw new Error("stable qualification requires a published branch, not detached HEAD");
  const remote = await output(["git", "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
  if (remote !== `${commit}\trefs/heads/${branch}`) throw new Error("published qualification branch does not match HEAD");
  return branch;
}

interface DebianWorkflowRun {
  readonly id: number;
  readonly title: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
}

export interface DebianQualificationRuntime {
  readonly output: (command: readonly string[], timeoutMs?: number) => Promise<string>;
  readonly execute: (
    command: readonly string[],
    options?: { readonly timeoutMs?: number; readonly allowFailure?: boolean; readonly echo?: boolean },
  ) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly createDispatchId: () => string;
}

const defaultDebianRuntime: DebianQualificationRuntime = {
  output: (command, timeoutMs) => commandOutput(command, timeoutMs === undefined ? {} : { timeoutMs }),
  execute: async (command, options = {}) => {
    await runCommand(command, options);
  },
  sleep: Bun.sleep,
  createDispatchId: randomUUID,
};

async function findDebianRun(
  qualificationRef: string,
  dispatchId: string,
  orchestratorCommit: string,
  runtime: DebianQualificationRuntime,
): Promise<DebianWorkflowRun | undefined> {
  const payload = JSON.parse(
    await runtime.output(
      [
        "gh",
        "api",
        "--method",
        "GET",
        `repos/${REPOSITORY}/actions/workflows/${DEBIAN_WORKFLOW}/runs`,
        "-f",
        "event=workflow_dispatch",
        "-f",
        `branch=${qualificationRef}`,
        "-f",
        "per_page=100",
      ],
      120_000,
    ),
  ) as { workflow_runs?: unknown };
  if (!Array.isArray(payload.workflow_runs)) throw new Error("GitHub workflow-run lookup returned an invalid response");
  const title = `${DEBIAN_RUN_TITLE_PREFIX} ${dispatchId}`;
  const matches = payload.workflow_runs.filter(run => {
    if (!isRecord(run)) return false;
    return run.display_title === title && run.head_sha === orchestratorCommit;
  });
  if (matches.length > 1) throw new Error(`multiple Debian workflow runs matched dispatch ${dispatchId}`);
  const match = matches[0];
  if (!isRecord(match)) return undefined;
  if (
    typeof match.id !== "number" ||
    typeof match.display_title !== "string" ||
    typeof match.head_sha !== "string" ||
    typeof match.status !== "string" ||
    !(typeof match.conclusion === "string" || match.conclusion === null) ||
    typeof match.html_url !== "string"
  ) {
    throw new Error("GitHub workflow-run match returned invalid fields");
  }
  return {
    id: match.id,
    title: match.display_title,
    headSha: match.head_sha,
    status: match.status,
    conclusion: match.conclusion,
    url: match.html_url,
  };
}

async function waitForDebianRun(
  qualificationRef: string,
  dispatchId: string,
  orchestratorCommit: string,
  runtime: DebianQualificationRuntime,
): Promise<DebianWorkflowRun | undefined> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const run = await findDebianRun(qualificationRef, dispatchId, orchestratorCommit, runtime);
    if (run !== undefined) return run;
    await runtime.sleep(2_000);
  }
  return undefined;
}

export async function qualifyDebian(
  options: StableQualificationOptions,
  receipt: StableQualificationReceipt,
  checkpoint: Checkpoint,
  qualificationRef: string,
  runtime: DebianQualificationRuntime = defaultDebianRuntime,
): Promise<Record<string, unknown>> {
  const laneEvidence = receipt.lanes.debian.evidence ?? {};
  let dispatchId = typeof laneEvidence.dispatchId === "string" ? laneEvidence.dispatchId : undefined;
  let dispatchRequestedAt = typeof laneEvidence.dispatchRequestedAt === "string"
    ? laneEvidence.dispatchRequestedAt
    : undefined;
  let runId = typeof laneEvidence.runId === "number" ? laneEvidence.runId : undefined;
  let priorFailed = false;
  if (runId !== undefined) {
    const prior = JSON.parse(await runtime.output(["gh", "run", "view", String(runId), "--json", "status,conclusion,url"])) as {
      status?: string;
      conclusion?: string;
      url?: string;
    };
    priorFailed = prior.status === "completed" && prior.conclusion !== "success";
    if (priorFailed) {
      dispatchId = undefined;
      dispatchRequestedAt = undefined;
      runId = undefined;
    }
  }
  if (runId === undefined) {
    if (dispatchId === undefined) {
      dispatchId = runtime.createDispatchId();
      if (!/^[0-9a-f-]{36}$/u.test(dispatchId)) throw new Error("Debian dispatch id generator returned an invalid value");
      dispatchRequestedAt = undefined;
      await checkpoint({ dispatchId, dispatchRequestedAt: null, runId: null, url: null });
    }

    let discovered = await findDebianRun(qualificationRef, dispatchId, receipt.orchestratorCommit, runtime);
    if (discovered === undefined && dispatchRequestedAt === undefined) {
      dispatchRequestedAt = now();
      await checkpoint({ dispatchId, dispatchRequestedAt });
      await runtime.execute([
        "gh",
        "workflow",
        "run",
        DEBIAN_WORKFLOW,
        "--ref",
        qualificationRef,
        "-f",
        `qualification_id=${dispatchId}`,
        "-f",
        `release_tag=${options.tag}`,
        "-f",
        `previous_tag=${options.previousTag}`,
        "-f",
        "lanes=",
        "-f",
        "droplet_size=s-2vcpu-8gb-amd",
      ]);
    }
    discovered ??= await waitForDebianRun(qualificationRef, dispatchId, receipt.orchestratorCommit, runtime);
    if (discovered === undefined) {
      throw new Error(
        `Debian dispatch ${dispatchId} is not discoverable; refusing to dispatch again until the existing request is resolved`,
      );
    }
    runId = discovered.id;
    await checkpoint({ dispatchId, dispatchRequestedAt, runId, url: discovered.url });
  }
  await runtime.execute(["gh", "run", "watch", String(runId), "--exit-status"], {
    timeoutMs: 55 * 60 * 1_000,
    allowFailure: true,
    echo: true,
  });
  const result = JSON.parse(
    await runtime.output(["gh", "run", "view", String(runId), "--json", "status,conclusion,headSha,url,jobs"]),
  ) as { status?: string; conclusion?: string; headSha?: string; url?: string; jobs?: unknown[] };
  if (result.status !== "completed" || result.conclusion !== "success") {
    throw new Error(`Debian qualification run ${runId} concluded ${result.conclusion ?? result.status ?? "unknown"}`);
  }
  if (result.headSha !== receipt.orchestratorCommit) throw new Error("Debian qualification ran different orchestration source");
  if (!Array.isArray(result.jobs)) throw new Error("Debian qualification did not return job evidence");
  const observedJobs = result.jobs.map(job => isRecord(job) ? { name: job.name, conclusion: job.conclusion } : {});
  const requiredJob = observedJobs.find(job => job.name === "Qualify on disposable droplet");
  if (requiredJob?.conclusion !== "success") {
    throw new Error("Debian qualification missed successful job: Qualify on disposable droplet");
  }
  return {
    dispatchId,
    dispatchRequestedAt,
    runId,
    url: result.url,
    headSha: result.headSha,
    conclusion: result.conclusion,
  };
}

export function parseQualificationPins(text: string): OmpPins {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !isRecord(value.darwinArm64Native) || !isRecord(value.packageVersions)) throw new Error("OMP qualification pin is invalid");
  const pins = {
    bunVersion: value.bunVersion,
    sourceCommit: value.commit,
    sourceTree: value.tree,
    version: value.packageVersions["@oh-my-pi/pi-coding-agent"],
    nativeTarballSha256: value.darwinArm64Native.tarballSha256,
    nativeBinarySha256: value.darwinArm64Native.binarySha256,
  };
  if (
    typeof pins.bunVersion !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/u.test(pins.bunVersion) ||
    typeof pins.sourceCommit !== "string" || !/^[0-9a-f]{40}$/u.test(pins.sourceCommit) ||
    typeof pins.sourceTree !== "string" || !/^[0-9a-f]{40}$/u.test(pins.sourceTree) ||
    typeof pins.version !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/u.test(pins.version) ||
    pins.version !== value.packageVersion || !isSupportedOmpVersion(pins.version) ||
    typeof pins.nativeTarballSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pins.nativeTarballSha256) ||
    typeof pins.nativeBinarySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pins.nativeBinarySha256)
  ) {
    throw new Error("OMP qualification pin is invalid");
  }
  return pins as OmpPins;
}

async function loadQualificationPins(): Promise<OmpPins> {
  return parseQualificationPins(await readFile(join(repositoryRoot, "UPSTREAM.lock.json"), "utf8"));
}

export async function loadConfiguredMacTarget(options: StableQualificationOptions): Promise<MacTarget> {
  let sudoPassword = "";
  if (options.macSudoPasswordFile !== undefined) {
    const metadata = await lstat(options.macSudoPasswordFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
      throw new Error("Mac sudo password file must be a current-user regular file with no group or other access");
    }
    sudoPassword = (await readFile(options.macSudoPasswordFile, "utf8")).replace(/\r?\n$/u, "");
    if (sudoPassword === "" || /[\r\n\0]/u.test(sudoPassword)) {
      throw new Error("Mac sudo password file must contain one nonempty password line");
    }
  }
  return { sshDestination: options.macHost, sudoPassword };
}

export interface StablePreflightRuntime {
  readonly withReleaseLease: typeof withReleaseHostLease;
  readonly platform: string;
  readonly arch: string;
  readonly bunVersion: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executable: (name: string) => string | null;
  readonly output: (command: readonly string[]) => Promise<string>;
  readonly adb: (serial: string | undefined, args: readonly string[]) => Promise<string>;
  readonly loadMacTarget: (options: StableQualificationOptions) => Promise<MacTarget>;
}

const defaultPreflightRuntime: StablePreflightRuntime = {
  withReleaseLease: withReleaseHostLease,
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  environment: process.env,
  executable: Bun.which,
  output: command => commandOutput(command, { timeoutMs: 15_000 }),
  adb: (serial, args) => runAdb(serial, args, { timeoutMs: 15_000 }),
  loadMacTarget: loadConfiguredMacTarget,
};

/** Discard raw probe errors: SSH, adb and credential tools can include private identifiers or secrets. */
async function prerequisite<T>(description: string, probe: () => Promise<T>): Promise<T> {
  try {
    return await probe();
  } catch {
    throw new Error("Stable preflight: " + description);
  }
}

/** Admission only. No staging, receipts, dispatch, host start, or client/service mutation. */
export async function preflightStableQualification(
  options: StableQualificationOptions,
  runtime: StablePreflightRuntime = defaultPreflightRuntime,
  lanes: StableQualificationLaneModules = defaultLaneModules,
) {
  if (runtime.platform !== "darwin" || runtime.arch !== "arm64") {
    throw new Error("stable qualification orchestration currently requires a Darwin-arm64 workstation");
  }
  const ompPins = await loadQualificationPins();
  if (runtime.bunVersion !== ompPins.bunVersion) {
    throw new Error("Stable preflight: local Bun must be " + ompPins.bunVersion);
  }
  for (const name of ["adb", "security", "git", "gh", "cosign", "shasum", "ssh", "scp", "bash", "python3", "curl"]) {
    if (runtime.executable(name) === null) throw new Error("Stable preflight: required executable is missing: " + name);
  }
  const browser = resolveAndroidBrowserTarget(runtime.environment);
  const serial = await prerequisite("attach exactly one authorized Android device; resolve absent, unauthorized or ambiguous adb devices", () =>
    requireSingleDevice((...args) => runtime.adb(undefined, args)),
  );
  await requireAndroidDevicePreconditions((...args) => runtime.adb(serial, args), { switchesRadios: true, needsNotifications: true });
  await prerequisite("attached Android must be an identified Pixel with the selected browser installed", async () => {
    const model = await runtime.adb(serial, ["shell", "getprop", "ro.product.model"]);
    if (!model.startsWith("Pixel ")) throw new Error("not a Pixel");
    for (const property of ["ro.build.version.release", "ro.build.id"]) {
      if ((await runtime.adb(serial, ["shell", "getprop", property])).trim() === "") throw new Error("missing build");
    }
    parseAndroidPackageVersion(await runtime.adb(serial, ["shell", "dumpsys", "package", browser.packageName]));
  });
  await prerequisite("device-scoped Android qualification PIN is unavailable or invalid in the macOS Keychain", async () => {
    const pin = await readAndroidQualificationPin(serial, async (account, service) =>
      new TextEncoder().encode(await runtime.output(["security", "find-generic-password", "-a", account, "-s", service, "-w"])),
    );
    pin.fill(0);
  });
  const ghToken = await prerequisite("GitHub CLI authentication is unavailable", async () => {
    const token = await runtime.output(["gh", "auth", "token"]);
    if (token === "") throw new Error("empty token");
    const repository = JSON.parse(await runtime.output(["gh", "api", "repos/" + REPOSITORY]));
    if (!isRecord(repository) || !isRecord(repository.permissions) || repository.permissions.push !== true) {
      throw new Error("repository write permission unavailable");
    }
    return token;
  });
  for (const tag of [options.tag, options.previousTag]) {
    await prerequisite("candidate and published predecessor releases must be available with the expected release status", async () => {
      const release = JSON.parse(await runtime.output([
        "gh", "release", "view", tag, "--repo", REPOSITORY, "--json", "tagName,isDraft,isPrerelease",
      ]));
      if (!isRecord(release) || release.tagName !== tag || release.isDraft !== false || release.isPrerelease !== (tag === options.tag)) {
        throw new Error("release metadata mismatch");
      }
    });
  }
  const orchestratorCommit = await prerequisite("cannot resolve the qualification source commit", async () => {
    const commit = await runtime.output(["git", "rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("invalid commit");
    return commit;
  });
  const qualificationRef = await prerequisite("qualification source must be a clean branch whose published HEAD matches locally", () =>
    gitQualificationRef(orchestratorCommit, runtime.output),
  );
  const target = await prerequisite("configured Mac target unavailable; check the optional private sudo password file", () =>
    runtime.loadMacTarget(options),
  );
  const macProbe = await prerequisite("retained Mac SSH, Darwin-arm64, pinned Bun, required tools or user-owned TUN-mode Tailscale prerequisites are unavailable", async () => {
    // Match the qualifier's PATH; ~/qual is created later by artifact staging, not a prerequisite.
    const probe = [
      'set -eu',
      MAC_PATH_SETUP,
      '[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]',
      '[ "$(bun --version)" = ' + shellQuote(ompPins.bunVersion) + ' ]',
      'for tool in bash python3 curl git shasum tar lsof launchctl sudo tailscale ifconfig sysctl; do command -v "$tool" >/dev/null; done',
      'ifconfig | python3 -c ' + shellQuote('import sys; assert "inet6 fd7a:115c:a1e0:" in sys.stdin.read()'),
      '/usr/sbin/sysctl -n hw.model',
      'tailscale status --json | python3 -c ' + shellQuote('import json,sys; d=json.load(sys.stdin); s=d.get("Self",{}); assert d.get("BackendState")=="Running" and not s.get("Tags") and s.get("DNSName","").rstrip("."); print(s["DNSName"].rstrip("."))'),
      'omp_version="$(omp --version </dev/null 2>/dev/null)" || omp_version=MISSING',
      'printf "%s\n" "${omp_version:-MISSING}"',
      // Hex framing keeps multiline guard diagnostics inside one fixed protocol line.
      'python3 -c ' + shellQuote(`
import os,stat,subprocess
path = os.path.join(os.environ["HOME"], ".config/omp-qualification/reboot-guard")
if not os.path.lexists(path):
    print("guard=absent")
elif not os.path.isfile(path) or not os.access(path, os.X_OK) or not os.stat(path).st_mode & stat.S_IXUSR:
    print("guard=invalid:" + os.fsencode(path).hex())
else:
    try:
        result = subprocess.run([path], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print("guard=passed" if result.returncode == 0 else "guard=refused:" + result.stdout[:400].hex())
    except OSError as error:
        print("guard=refused:" + str(error).encode()[:400].hex())
`),
    ].join("; ");
    const result = (await runtime.output([
      "ssh", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes", "-q", target.sshDestination, "/bin/bash -c " + shellQuote(probe),
    ])).trim();
    const [hardware, dnsName, ompBanner, guard, extra] = result.split(/\r?\n/u);
    if (extra !== undefined || dnsName === undefined || ompBanner === undefined || guard === undefined ||
      !/^guard=(?:absent|passed|refused:(?:[0-9a-f]{2}){0,400}|invalid:(?:[0-9a-f]{2})+)$/u.test(guard) ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(dnsName)) {
      throw new Error("retained Mac probe did not return exactly its model, tailnet DNS name, OMP version banner and reboot guard result");
    }
    return { hardware, dnsName, ompBanner, guard };
  });
  if (macProbe.guard.startsWith("guard=refused:")) {
    throw new Error("Stable preflight: the host's reboot guard refused: " + Buffer.from(macProbe.guard.slice(14), "hex").toString("utf8"));
  }
  if (macProbe.guard.startsWith("guard=invalid:")) {
    throw new Error("Stable preflight: the host's reboot guard must be a regular, owner-executable file: " + Buffer.from(macProbe.guard.slice(14), "hex").toString("utf8"));
  }
  assertMacHardware(macProbe.hardware, options.macModel);
  const installedOmpVersion = parseOmpVersion(macProbe.ompBanner);
  if (installedOmpVersion === undefined || !isSupportedOmpVersion(installedOmpVersion)) {
    throw new Error(`Stable preflight: Mac requires stock OMP >=18.1.20 on PATH for doctor compatibility; install it with: bun add --global --exact @oh-my-pi/pi-coding-agent@${ompPins.version}`);
  }
  const macOrigin = `https://${macProbe.dnsName}`;
  await requireAndroidGatewayReachability(macOrigin, (...args) => runtime.adb(serial, args));
  const laneContext: ExternalLanePreflightContext = { environment: runtime.environment, serial, omp: ompPins, macOrigin };
  for (const [name, lane] of [
    ["Windows", lanes.windows],
    ["background Push", lanes.androidPush],
    ["real-device cloud", lanes.deviceCloud],
  ] as const) {
    try {
      await lane.preflight(laneContext);
    } catch (error) {
      if (deviceCloudHolds(error) !== undefined) throw error;
      throw new Error(`Stable preflight: ${name} lane admission failed`, { cause: error });
    }
  }
  return { ompPins, ghToken, orchestratorCommit, qualificationRef, target, macOrigin };
}

function macEnvironment(
  options: StableQualificationOptions,
  target: MacTarget,
  candidate: CandidateIdentity,
): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    OMP_MAC_HOST: target.sshDestination,
    OMP_MAC_TAG: options.tag,
    OMP_MAC_PREVIOUS_TAG: options.previousTag,
    OMP_MAC_LOGIN: options.macLogin,
    OMP_MAC_SUDO_PW: target.sudoPassword,
    OMP_MAC_ARCHIVE_SHA256: candidate.archiveSha256,
    OMP_MAC_SESSION_LABEL: options.sessionLabel,
    ...(options.qualificationLogDirectory === undefined ? {} : { OMP_MAC_QUALIFICATION_LOG_DIR: options.qualificationLogDirectory }),
  };
}

export function assertMacBuildOutput(output: string, candidate: CandidateIdentity, pins: OmpPins): void {
  if (!/doctor\s+([1-9][0-9]*)\/\1 true/u.test(output)) {
    throw new Error("Mac build output missed a passing doctor summary");
  }
  for (const expected of [
    `release-info commit:                   ${candidate.sourceCommit}`,
    candidate.archiveSha256,
    `"version":"${pins.version}"`,
    `"sourceCommit":"${pins.sourceCommit}"`,
    `"sourceTree":"${pins.sourceTree}"`,
    `"nativeSha256":"${pins.nativeBinarySha256}"`,
  ]) {
    if (!output.includes(expected)) throw new Error(`Mac build output missed required evidence: ${expected}`);
  }
}

/** Lane 3 probes the backend from a distinct node; both addresses must record no HTTP answer (#98). */
export function assertMacExposureEvidence(output: string): void {
  for (const address of ["tailnet", "ssh"]) {
    if (!new RegExp(`^\\s*backend at ${address} address:\\s+no HTTP answer \\(curl exit [0-9]+\\)$`, "mu").test(output)) {
      throw new Error(`Mac lifecycle output missed required evidence: backend at ${address} address: no HTTP answer`);
    }
  }
}

function assertMacHardware(measured: string | undefined, expected: string): string {
  if (measured === undefined || !MAC_MODEL_PATTERN.test(measured)) {
    throw new Error("Mac hardware measurement is missing or invalid");
  }
  if (measured !== expected) throw new Error(`Mac hardware mismatch: expected ${expected}, measured ${measured}`);
  return measured;
}

export function assertMacLifecycleOutput(output: string, candidate: CandidateIdentity, pins: OmpPins, expectedHardware: string) {
  assertMacBuildOutput(output, candidate, pins);
  const measurements = [...output.matchAll(/^\s*hardware:[ \t]+(\S+)[ \t]*$/gmu)];
  if (measurements.length === 0) throw new Error("Mac lifecycle output missed required hardware evidence");
  // Each staged shell invocation probes the host again; all measurements must agree.
  const hardware = assertMacHardware(measurements[0]?.[1], expectedHardware);
  for (const measurement of measurements.slice(1)) assertMacHardware(measurement[1], expectedHardware);
  for (const expected of [
    "doctor false checks                    (none)",
    "token bytes in bundle:                 0",
    "login in bundle:                       0",
    "forged header, real login allowed:     200",
    "gateway returned after:",
  ]) {
    if (!output.includes(expected)) throw new Error(`Mac lifecycle output missed required evidence: ${expected}`);
  }
  assertMacExposureEvidence(output);
  const doctor = output.match(/doctor\s+(([1-9][0-9]*)\/\2) true/u)?.[1];
  const rollbackInvariants = output.match(/\b(([1-9][0-9]*)\/\2) invariants PASS\b/u)?.[1];
  const os = output.match(/^\s*host:\s+(macOS [0-9.]+ arm64)\s*$/mu)?.[1];
  if (doctor === undefined || rollbackInvariants === undefined || os === undefined) {
    throw new Error("Mac lifecycle output missed a passing doctor, rollback or host summary");
  }
  for (const label of ["guest reboot changed", "console login", "readiness token preserved"]) {
    const verdicts = [...output.matchAll(new RegExp(`^[\\t ]*${label}:[\\t ]*(.*)$`, "gmu"))];
    if (verdicts.length !== 1 || verdicts[0]?.[1]?.trim() !== "yes") {
      throw new Error(`Mac lifecycle output missed required passing verdict: ${label}`);
    }
  }
  return { hardware, doctor, rollbackInvariants, os, guestRebootChanged: true, consoleLogin: true, readinessPreserved: true };
}
async function readMacPublicOrigin(target: MacTarget): Promise<string> {
  const result = await commandOutput([
    "ssh",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "BatchMode=yes",
    "-q",
    target.sshDestination,
    MAC_PATH_SETUP + '; TS="$(command -v tailscale || echo "$HOME/go/bin/tailscale")"; "$TS" status --json',
  ]);
  const status = JSON.parse(result) as { Self?: { DNSName?: unknown; Tags?: unknown[] }; BackendState?: unknown };
  const dnsName = status.Self?.DNSName;
  if (status.BackendState !== "Running" || typeof dnsName !== "string" || dnsName === "" || (status.Self?.Tags?.length ?? 0) > 0) {
    throw new Error("retained Mac is not a running user-owned Tailscale node");
  }
  return `https://${dnsName.replace(/\.$/u, "")}`;
}

async function runMacScript(environment: Record<string, string>, lanes: readonly string[], timeoutMs: number, execution?: QualificationExecutionContext): Promise<string> {
  const result = await runCommand(["bash", "scripts/qualify-macos-host.sh", ...lanes], {
    env: environment,
    timeoutMs,
    echo: true,
    ...(execution === undefined ? {} : { execution }),
  });
  return `${result.stdout}${result.stderr}`;
}

async function runStagedMac(
  options: StableQualificationOptions,
  target: MacTarget,
  candidate: CandidateVerification,
  lanes: readonly string[],
  timeoutMs: number,
): Promise<StagedMacRun> {
  const environment = macEnvironment(options, target, candidate);
  const cleanupContext: Pick<MacContext, "target" | "environment"> = { target, environment };
  try {
    const artifactOutput = await runMacScript(environment, ["artifact"], 10 * 60 * 1_000);
    const context: MacContext = { ...cleanupContext, publicOrigin: await readMacPublicOrigin(target) };
    const laneOutput = await runMacScript(environment, lanes, timeoutMs);
    return { context, output: `${artifactOutput}${laneOutput}` };
  } catch (error) {
    try {
      await cleanupMac(cleanupContext);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Mac qualification and recovery cleanup failed");
    }
    throw error;
  }
}

async function qualifyMacLifecycle(
  options: StableQualificationOptions,
  target: MacTarget,
  candidate: CandidateVerification,
  pins: OmpPins,
): Promise<Record<string, unknown>> {
  const run = await runStagedMac(
    options,
    target,
    candidate,
    ["omp-clean", "uninstall", "install", "identity", "persistence", "rollback", "omp-build"],
    50 * 60 * 1_000,
  );
  const summaries = assertMacLifecycleOutput(run.output, candidate, pins, options.macModel);
  return {
    ...summaries,
    archiveSha256: candidate.archiveSha256,
    nativeAddonSha256: pins.nativeBinarySha256,
    outputSha256: sha256(run.output),
  };
}

async function prepareMacFixture(
  options: StableQualificationOptions,
  target: MacTarget,
  candidate: CandidateVerification,
  pins: OmpPins,
): Promise<MacContext> {
  const run = await runStagedMac(
    options,
    target,
    candidate,
    ["omp-clean", "uninstall", "install", "omp-build"],
    45 * 60 * 1_000,
  );
  assertMacBuildOutput(run.output, candidate, pins);
  return run.context;
}

function ompRemoteCommand(options: StableQualificationOptions, pins: OmpPins, mode: "run" | "continue"): string {
  return [
    MAC_PATH_SETUP,
    'root="$HOME/qual/$(cd "$HOME/qual" && ls -d omp-session-gateway-*-bun)"',
    `OMP_QUAL_GATEWAY_ROOT="$root" OMP_PIN_SOURCE_COMMIT=${shellQuote(pins.sourceCommit)} OMP_PIN_SOURCE_TREE=${shellQuote(pins.sourceTree)} OMP_PIN_VERSION=${shellQuote(pins.version)} OMP_PIN_BUN_VERSION=${shellQuote(pins.bunVersion)} OMP_PIN_NATIVE_TARBALL_SHA256=${shellQuote(pins.nativeTarballSha256)} OMP_PIN_NATIVE_BINARY_SHA256=${shellQuote(pins.nativeBinarySha256)} OMP_QUAL_SESSION_LABEL=${shellQuote(options.sessionLabel)} OMP_FIXTURE_MODEL=${shellQuote(OMP_FIXTURE_MODEL)} exec bash "$HOME/qual-tools/qualify-macos-omp.sh" ${mode}`,
  ].join("; ");
}

function startOmpSession(options: StableQualificationOptions, target: MacTarget, pins: OmpPins, mode: "run" | "continue" = "run") {
  return Bun.spawn(
    [
      "ssh",
      "-tt",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-q",
      target.sshDestination,
      ompRemoteCommand(options, pins, mode),
    ],
    { cwd: repositoryRoot, stdin: "pipe", stdout: "ignore", stderr: "ignore" },
  );
}

async function stopSubprocess(process: ManagedProcess | undefined): Promise<void> {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  const timer = setTimeout(() => process.kill("SIGKILL"), 10_000);
  try { await process.exited; } finally { clearTimeout(timer); }
}

/** A list read still pending at its caller's deadline fails as that deadline, not as a transport error. */
async function readSessionList(origin: string, deadline: number): Promise<Response | undefined> {
  const remaining = Math.ceil(deadline - performance.now());
  try {
    return await fetch(`${origin}/api/v1/sessions`, { cache: "no-store", signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, remaining))) });
  } catch (error) {
    if (remaining <= 5_000 && error instanceof Error && error.name === "TimeoutError") return undefined;
    throw error;
  }
}

export async function waitForPublishedSession(origin: string, label: string, options: OmpSessionWait = {}): Promise<Record<string, unknown>> {
  const deadline = performance.now() + (options.timeoutMs ?? 90_000);
  while (performance.now() < deadline) {
    const response = await readSessionList(origin, deadline);
    if (response === undefined) break;
    if (response.ok) {
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.sessions)) throw new Error("session list is invalid");
      const session = payload.sessions.find(
        (entry): entry is Record<string, unknown> => isRecord(entry) && entry.cwdLabel === label && (options.matches?.(entry) ?? true),
      );
      if (session) {
        if (!response.headers.get("cache-control")?.includes("no-store")) throw new Error("session list was cacheable");
        if (session.canView !== true || session.canControl !== true || typeof session.instanceId !== "string" ||
          !Number.isSafeInteger(session.generation) || (typeof session.generation !== "number" || session.generation < 1) ||
          (options.matches === undefined && session.generation !== 1)) {
          throw new Error("mainline OMP metadata did not publish the required View and Control generation");
        }
        const modelError = fixtureModelError(session);
        if (modelError !== undefined) throw new Error(modelError);
        return session;
      }
    }
    await Bun.sleep(Math.min(1_000, Math.max(0, deadline - performance.now())));
  }
  throw new Error("mainline OMP session did not publish before the deadline");
}

export async function verifyLaunchContracts(origin: string, session: Record<string, unknown>, expected: "live" | "stale" = "live"): Promise<Record<string, unknown>> {
  const instanceId = session.instanceId;
  const generation = session.generation;
  if (typeof instanceId !== "string" || typeof generation !== "number") throw new Error("published session identity is invalid");
  const modes: Record<string, unknown>[] = [];
  for (const mode of ["view", "control"] as const) {
    const response = await fetch(`${origin}/api/v1/sessions/${encodeURIComponent(instanceId)}/launch`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ generation, mode }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json();
    if (!isRecord(payload)) throw new Error("launch response is invalid");
    const capabilityField = "capability" in payload;
    const valuePresent = typeof payload.capability === "string" && payload.capability !== "";
    delete payload.capability;
    const keys = Object.keys(payload).sort();
    const valid = expected === "live"
      ? response.status === 200 && valuePresent && payload.generation === generation && payload.mode === mode
      : response.status === 409 && payload.code === "generation_mismatch" && !capabilityField;
    if (!valid || !response.headers.get("cache-control")?.includes("no-store")) {
      throw new Error("OMP launch contract failed");
    }
    if (capabilityField) keys.push("capability");
    keys.sort();
    modes.push({ mode, status: response.status, keys, valuePresent, noStore: true });
  }
  return { instanceId, generation, modes };
}

export async function waitForRevocation(origin: string, label: string, timeoutMs = 45_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const response = await readSessionList(origin, deadline);
    if (response === undefined) break;
    // A refused read is retried like publication; only a valid no-store list can prove revocation.
    if (response.ok) {
      const payload: unknown = await response.json();
      if (!response.headers.get("cache-control")?.includes("no-store") || !isRecord(payload) || !Array.isArray(payload.sessions)) {
        throw new Error("revocation session list is invalid");
      }
      if (!payload.sessions.some(session => isRecord(session) && session.cwdLabel === label)) return;
    }
    await Bun.sleep(Math.min(1_000, Math.max(0, deadline - performance.now())));
  }
  throw new Error("mainline OMP session did not revoke before the deadline");
}

function chooseTunnelPort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("could not allocate a loopback tunnel port");
  return port;
}

async function startTunnel(target: MacTarget, port: number): Promise<ManagedProcess> {
  const process = Bun.spawn(
    [
      "ssh",
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-L",
      `127.0.0.1:${port}:127.0.0.1:4317`,
      target.sshDestination,
    ],
    { cwd: repositoryRoot, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    if (process.exitCode !== null) {
      const stderr = await new Response(process.stderr).text();
      throw new Error(`SSH tunnel exited before readiness: ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return process;
    } catch {
      // The listener is not ready yet.
    }
    await Bun.sleep(250);
  }
  await stopSubprocess(process);
  throw new Error("SSH loopback tunnel did not become ready");
}

export async function runAndroidAcceptance(
  options: StableQualificationOptions,
  context: MacContext,
  runtime: Pick<StablePreflightRuntime, "adb"> = defaultPreflightRuntime,
  execution?: QualificationExecutionContext,
): Promise<Record<string, unknown>> {
  // A read-only refusal is not an unrestored child: no potentially mutating process ran.
  const admittedSerial = await requireSingleDevice((...args) => runtime.adb(undefined, args));
  await requireAndroidGatewayReachability(context.publicOrigin, (...args) => runtime.adb(admittedSerial, args));
  const browser = resolveAndroidBrowserTarget();
  const androidEnvironment = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    OMP_ANDROID_BROWSER_PACKAGE: browser.packageName,
    OMP_ANDROID_BROWSER_ACTIVITY: browser.activity,
    OMP_ANDROID_DEVTOOLS_SOCKET: browser.devtoolsSocket,
  };
  const acceptance = await runPixelRestoringChild(
    [process.execPath, "scripts/android-acceptance.ts", context.publicOrigin, options.sessionLabel],
    { env: androidEnvironment, timeoutMs: 15 * 60 * 1_000, echo: true, ...(execution === undefined ? {} : { execution }) },
  );
  const summary = JSON.parse(acceptance.stdout) as Record<string, unknown>;
  if (summary.packageName !== androidEnvironment.OMP_ANDROID_BROWSER_PACKAGE || summary.outageBanner !== true) {
    throw new Error("physical Android acceptance summary is incomplete");
  }
  for (const field of ["unlockMs", "airplaneRecoveredMs", "dozeRecoveredMs"] as const) {
    if (typeof summary[field] !== "number") throw new Error(`physical Android acceptance missed ${field}`);
  }
  const serial = summary.serial;
  if (typeof serial !== "string" || serial === "") throw new Error("physical Android acceptance did not identify its device");
  const [model, androidRelease, buildId] = await Promise.all([
    runAdb(serial, ["shell", "getprop", "ro.product.model"], { timeoutMs: 120_000 }).then(value => value.trim()),
    runAdb(serial, ["shell", "getprop", "ro.build.version.release"], { timeoutMs: 120_000 }).then(value => value.trim()),
    runAdb(serial, ["shell", "getprop", "ro.build.id"], { timeoutMs: 120_000 }).then(value => value.trim()),
  ]);
  if (!model.startsWith("Pixel ") || androidRelease === "" || buildId === "") {
    throw new Error("physical Android acceptance did not run on an identified Pixel build");
  }
  const collaboration = await runCommand(
    [process.execPath, "scripts/android-collab-smoke.ts", context.publicOrigin, options.sessionLabel],
    { env: androidEnvironment, timeoutMs: 5 * 60 * 1_000, echo: true, ...(execution === undefined ? {} : { execution }) },
  );
  const collaborationSummary = JSON.parse(collaboration.stdout) as Record<string, unknown>;
  for (const field of ["viewReadOnly", "controlWritable", "promptAccepted", "returnedToDirectory"] as const) {
    if (collaborationSummary[field] !== true) throw new Error(`physical Android collaboration missed ${field}`);
  }
  const leak = await runCommand(
    [process.execPath, "scripts/android-leak-sweep.ts", context.publicOrigin, options.sessionLabel],
    { env: androidEnvironment, timeoutMs: 5 * 60 * 1_000, echo: true, ...(execution === undefined ? {} : { execution }) },
  );
  const leakOutput = `${leak.stdout}${leak.stderr}`;
  for (const expected of ["planted 7, detected 7", "all 7 sinks proven detectable, no residue", "result        clean"]) {
    if (!leakOutput.includes(expected)) throw new Error(`physical Android leak sweep missed: ${expected}`);
  }
  return {
    serial,
    model,
    androidRelease,
    buildId,
    packageName: summary.packageName,
    androidPackageVersion: summary.androidPackageVersion,
    browserVersion: summary.browserVersion,
    unlockMs: summary.unlockMs,
    airplaneRecoveredMs: summary.airplaneRecoveredMs,
    dozeRecoveredMs: summary.dozeRecoveredMs,
    acceptanceOutputSha256: sha256(`${acceptance.stdout}${acceptance.stderr}`),
    collaboration: collaborationSummary,
    leakSweepOutputSha256: sha256(leakOutput),
    forbiddenSinkSweep: "7/7 detectable; clean",
  };
}

function evidenceTimestamp(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : Number.NaN;
}

function validateRelayEvidence(
  summary: unknown,
  requiredSeconds: number,
  startedAt: unknown,
  completedAt: unknown,
): Record<string, unknown> {
  const start = isRecord(summary) ? evidenceTimestamp(summary.startedAt) : Number.NaN;
  const end = isRecord(summary) ? evidenceTimestamp(summary.completedAt) : Number.NaN;
  if (
    !isRecord(summary) ||
    typeof summary.durationSeconds !== "number" ||
    !Number.isSafeInteger(summary.durationSeconds) ||
    summary.durationSeconds < requiredSeconds ||
    summary.finalPhase !== "live" ||
    typeof summary.transitions !== "number" ||
    !Number.isSafeInteger(summary.transitions) ||
    summary.transitions < 0 ||
    !(start >= evidenceTimestamp(startedAt)) ||
    !(end > start && end <= evidenceTimestamp(completedAt)) ||
    // The runner floors monotonic seconds; its wall-clock timestamps may differ by a fraction of a second.
    Math.abs((end - start) / 1_000 - summary.durationSeconds) > 1
  ) {
    throw new Error(`relay evidence is missing, invalid, stale, or shorter than the required ${requiredSeconds} seconds`);
  }
  return {
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    durationSeconds: summary.durationSeconds,
    transitions: summary.transitions,
    finalPhase: summary.finalPhase,
  };
}

function assertPassedRelayEvidence(receipt: StableQualificationReceipt, requiredSeconds: number): void {
  const lane = receipt.lanes.relay;
  if (lane.status !== "passed") return;
  if (
    !Number.isSafeInteger(lane.attempts) || lane.attempts < 1 ||
    !(evidenceTimestamp(lane.startedAt) >= evidenceTimestamp(receipt.startedAt)) ||
    !(evidenceTimestamp(lane.completedAt) <= Date.now())
  ) throw new Error("passed relay evidence has invalid or stale campaign/attempt boundaries");
  validateRelayEvidence(lane.evidence, requiredSeconds, lane.startedAt, lane.completedAt);
}

async function runRelaySmoke(
  options: StableQualificationOptions,
  context: MacContext,
  tunnelPort: number,
  instanceId: string,
  execution?: QualificationExecutionContext,
): Promise<Record<string, unknown>> {
  const startedAt = now();
  const result = await runCommand([process.execPath, "scripts/relay-soak.ts"], {
    env: {
      OMP_GATEWAY_SOAK_GATEWAY_ORIGIN: `http://127.0.0.1:${tunnelPort}`,
      OMP_GATEWAY_SOAK_PUBLIC_ORIGIN: context.publicOrigin,
      OMP_GATEWAY_SOAK_TAILSCALE_LOGIN: options.macLogin,
      OMP_GATEWAY_SOAK_INSTANCE_ID: instanceId,
      OMP_GATEWAY_SOAK_SECONDS: String(options.relaySeconds),
      // The lane's gateway is remote behind the SSH forward; an operator's ambient sampling
      // controls must not couple it to a local process or create a samples file.
      OMP_GATEWAY_SOAK_GATEWAY_PID: undefined,
      OMP_GATEWAY_SOAK_SAMPLES: undefined,
    },
    timeoutMs: (options.relaySeconds + 60) * 1_000,
    echo: true,
    ...(execution === undefined ? {} : { execution }),
  });
  return validateRelayEvidence(JSON.parse(result.stdout), options.relaySeconds, startedAt, now());
}

async function cleanupMac(
  context: Pick<MacContext, "target" | "environment">,
  collect?: () => Promise<unknown>,
  execution?: QualificationExecutionContext,
): Promise<Record<string, unknown>> {
  const errors: unknown[] = [];
  let uninstallOutput = "";
  let ompOutput = "";
  const attempt = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      errors.push(new Error(`${label} failed`, { cause: error }));
    }
  };

  await attempt("gateway uninstall", async () => {
    uninstallOutput = await runMacScript(context.environment, ["uninstall"], 10 * 60 * 1_000, execution);
  });
  if (collect !== undefined) await attempt("structured log collection", async () => {
    if (!uninstallOutput.includes("gateway pids:                          0")) throw new Error("gateway log writer termination is unproven");
    await collect();
  });
  await attempt("Tailscale Serve reset", async () => {
    await runCommand([
      "ssh",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-q",
      context.target.sshDestination,
      MAC_PATH_SETUP + '; TS="$(command -v tailscale || echo "$HOME/go/bin/tailscale")"; "$TS" serve reset >/dev/null',
    ], execution === undefined ? {} : { execution });
  });
  await attempt("mainline OMP cleanup", async () => {
    ompOutput = await runMacScript(context.environment, ["omp-clean"], 10 * 60 * 1_000, execution);
  });
  await attempt("qualification artifact cleanup", async () => {
    await runCommand([
      "ssh",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      "-q",
      context.target.sshDestination,
      MAC_PATH_SETUP + '; rm -rf "$HOME/qual" "$HOME/qual-tools"',
    ], execution === undefined ? {} : { execution });
  });

  for (const [output, expected] of [
    [ompOutput, '"liveOmpHosts":0,"binaryPresent":false,"sourcePresent":false'],
    [uninstallOutput, "plist present:                         no"],
    [uninstallOutput, "gui job:                               absent"],
    [uninstallOutput, "gateway pids:                          0"],
    [uninstallOutput, "listeners:                             0"],
  ] as const) {
    if (!output.includes(expected)) errors.push(new Error(`Mac cleanup missed required evidence: ${expected}`));
  }
  if (errors.length > 0) throw new AggregateError(errors, "Mac cleanup did not fully remove qualification state");
  return {
    gatewayProcesses: 0,
    gatewayListeners: 0,
    liveOmpHosts: 0,
    outputSha256: sha256(`${uninstallOutput}${ompOutput}`),
  };
}

function receiptHasMacEffects(receipt: StableQualificationReceipt): boolean {
  return (["macos", "ompPublication", "android", "androidPush", "androidPushCleanup", "deviceCloud", "deviceCloudCleanup", "relay", "cleanup"] as const).some(
    name => receipt.lanes[name].attempts > 0 || receipt.lanes[name].status !== "pending" || receipt.lanes[name].evidence !== undefined,
  );
}

function assertMacHostBinding(receipt: StableQualificationReceipt, macHost: string): void {
  if (receipt.macHost !== undefined && receipt.macHost !== macHost) {
    throw new Error("configured Mac host differs from the receipt; restore OMP_STABLE_MAC_HOST to the recorded host before resuming");
  }
  if (receipt.macHost === undefined && receiptHasMacEffects(receipt)) {
    throw new Error("receipt records Mac effects without a bound host; automated cleanup is refused. Perform manual cleanup of the original Mac's gateway, Tailscale Serve, OMP fixtures and qualification artifacts using the original campaign checkout before starting a new campaign directory");
  }
}

export function receiptNeedsMacCleanup(receipt: StableQualificationReceipt): boolean {
  if (receipt.rigReadiness?.cleanupDisposition === "unresolved") return true;
  if (receipt.lanes.cleanup.status === "passed") return false;
  return (["macos", "ompPublication", "android", "androidPush", "deviceCloud", "relay", "cleanup"] as const).some(
    name => receipt.lanes[name].attempts > 0,
  );
}

export function markMacCleanupRequired(receipt: StableQualificationReceipt, macHost: string): boolean {
  assertMacHostBinding(receipt, macHost);
  const newlyBound = receipt.macHost === undefined;
  receipt.macHost = macHost;
  const cleanup = receipt.lanes.cleanup;
  if (cleanup.status !== "passed") return newlyBound;
  cleanup.status = "pending";
  delete cleanup.startedAt;
  delete cleanup.completedAt;
  delete cleanup.error;
  delete cleanup.evidence;
  return true;
}

/** Commit the publication verdict only after the complete, repeatable lifecycle has finished. */
export async function completeOmpPublicationLifecycle(
  lane: LaneReceipt,
  persist: () => Promise<void>,
  run: () => Promise<OmpLifecycleEvidence>,
  nextFailureId: () => number = () => 1,
): Promise<void> {
  lane.status = "running";
  delete lane.completedAt;
  delete lane.error;
  if (lane.evidence !== undefined) {
    delete lane.evidence.lifecycle;
    delete lane.evidence.revoked;
  }
  await persist();
  try {
    const lifecycle = await run();
    lane.evidence = { ...lane.evidence, lifecycle, revoked: true };
    lane.status = "passed";
    lane.completedAt = now();
    await persist();
  } catch (error) {
    // Fixed step names only: the runner never carries host, link or terminal text.
    const reason = error instanceof OmpLifecycleFailure ? error.message : "OMP publication lifecycle failed";
    lane.status = "failed";
    lane.error = reason;
    lane.completedAt = now();
    await persist();
    throw error instanceof QualificationFailure ? error : new QualificationFailure({
      id: nextFailureId(), lane: "ompPublication", step: error instanceof OmpLifecycleFailure ? error.step : "cleanup",
      class: "harness", reason: "lifecycle_unconfirmed", operation: "unknown", elapsedMs: 0, observations: {},
    }, { cause: error });
  }
}

/** Consumers have settled; their failures do not invalidate the independent publication lifecycle. */
export async function finishLiveQualification(
  failures: readonly unknown[],
  publication: LaneReceipt,
  persist: () => Promise<void>,
  stopRelay: () => Promise<void>,
  lifecycle: () => Promise<OmpLifecycleEvidence>,
  preservePublication = false,
  nextFailureId: () => number = () => 1,
): Promise<void> {
  const failure = failures.length === 0 ? undefined : new AggregateError(failures, "live qualification consumers failed");
  try {
    await stopRelay();
    if (!preservePublication) await completeOmpPublicationLifecycle(publication, persist, lifecycle, nextFailureId);
  } catch (error) {
    if (!preservePublication && publication.status === "running") {
      publication.status = "failed";
      publication.completedAt = now();
      publication.error = "publication dependency did not settle";
      await persist();
    }
    const publicationFailure = laneFailure(error, "ompPublication", nextFailureId);
    if (failure !== undefined) throw new AggregateError([failure, publicationFailure], "consumers and publication completion failed");
    throw publicationFailure;
  }
  if (failure !== undefined) throw failure;
}

export interface RigReadinessActions {
  prepare(): Promise<void>;
  windows(): Promise<RigReadinessReceipt["observations"]>;
  macos(): Promise<RigReadinessReceipt["observations"]>;
  push(execution: QualificationExecutionContext): Promise<RigReadinessReceipt["observations"]>;
  restorePixel(execution: QualificationExecutionContext): Promise<void>;
  restoreMac(execution: QualificationExecutionContext): Promise<void>;
}

/** Effects are fenced before setup and all restoration runs before the fan-out gate can pass. */
export async function runRigReadiness(
  receipt: StableQualificationReceipt,
  persist: () => Promise<void>,
  actions: RigReadinessActions,
  epoch = randomUUID(),
): Promise<void> {
  const readiness = {
    status: "running", campaignAttempt: receipt.execution?.campaignAttempt ?? 0,
    epoch, phase: "lease", observations: { leaseOwned: true }, timings: {}, cleanupDisposition: "unresolved",
  } as RigReadinessReceipt;
  receipt.rigReadiness = readiness;
  await persist();
  const failures: unknown[] = [];
  const ownedFailure = (error: unknown): unknown => {
    if (error instanceof AggregateError) return new AggregateError(error.errors.map(ownedFailure), "readiness failures");
    if (error instanceof QualificationFailure) {
      const evidence = error.evidence;
      if (evidence.lane === "cleanup" && receipt.lanes.cleanup.status === "failed") return error;
      const reason = Object.hasOwn(FAILURE_REASONS.rigReadiness, evidence.reason) ? evidence.reason :
        evidence.class === "product" ? "assertion_failed" : "prerequisite_failed";
      return new QualificationFailure(parseLaneFailure({ ...evidence, lane: "rigReadiness",
        step: receipt.rigReadiness?.phase ?? "fixture", reason,
        class: FAILURE_REASONS.rigReadiness[reason as keyof typeof FAILURE_REASONS.rigReadiness] }));
    }
    return laneFailure(error, "rigReadiness", () => nextReceiptFailureId(receipt));
  };
  const step = async <T>(phase: keyof RigReadinessReceipt["timings"], action: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    receipt.rigReadiness = { ...receipt.rigReadiness!, phase };
    await persist();
    try { return await action(); }
    finally {
      receipt.rigReadiness = { ...receipt.rigReadiness!, timings: { ...receipt.rigReadiness!.timings, [phase]: performance.now() - start } };
      await persist();
    }
  };
  try {
    await step("fixture", actions.prepare);
    const windows = await step("windows", actions.windows);
    receipt.rigReadiness = { ...receipt.rigReadiness!, observations: { ...receipt.rigReadiness!.observations, ...windows } };
    await persist();
    const macos = await step("macos", actions.macos);
    receipt.rigReadiness = { ...receipt.rigReadiness!, observations: { ...receipt.rigReadiness!.observations, ...macos } };
    await persist();
    const push = await step("pixel_push", () => withQualificationDeadline("rigReadiness", 30 * 60_000,
      () => nextReceiptFailureId(receipt), actions.push));
    receipt.rigReadiness = { ...receipt.rigReadiness!, observations: { ...receipt.rigReadiness!.observations, ...push } };
    await persist();
    const observed = receipt.rigReadiness.observations;
    for (const field of ["leaseOwned", "pixelReachable", "pushSent", "pushAcknowledged", "pushPresented", "pushCleared",
      "windowsApiReady", "windowsResourcesAbsent", "macEgress", "macDoctor", "loopbackOnly", "serveExpected", "funnelOff", "fixturePinned"] as const) {
      if (observed[field] !== true) throw new Error("rig readiness prerequisite is unproven");
    }
    if (typeof observed.creationAllowance !== "number" || observed.creationAllowance < 1 ||
      typeof observed.deliveryMs !== "number" || observed.deliveryMs > 160_000) throw new Error("rig readiness bounds are unproven");
  } catch (error) { failures.push(ownedFailure(error)); }
  finally {
    let restored = true;
    await step("cleanup", () => trackCleanup(receipt, async () => {
      for (const [lane, timeout, action] of [
        ["androidPushCleanup", QUALIFICATION_CEILINGS_MS.androidPushCleanup, actions.restorePixel],
        ["cleanup", QUALIFICATION_CEILINGS_MS.cleanup, actions.restoreMac],
      ] as const) {
        try { await withQualificationDeadline(lane, timeout, () => nextReceiptFailureId(receipt), action); }
        catch (error) { restored = false; failures.push(ownedFailure(error)); }
      }
    }));
    receipt.rigReadiness = {
      ...receipt.rigReadiness!, status: failures.length === 0 ? "passed" : "failed",
      observations: { ...receipt.rigReadiness!.observations, baselineRestored: restored },
      cleanupDisposition: restored ? "restored" : "unresolved",
    };
    await persist();
  }
  if (failures.length > 0) throw new AggregateError(failures, "rig readiness failed");
}

async function probeMacReadiness(mac: RemoteExecutor): Promise<RigReadinessReceipt["observations"]> {
  // Required build/provider endpoints, no credentials and no response bodies retained.
  for (const endpoint of ["https://github.com", "https://registry.npmjs.org", "https://api.vultr.com"]) {
    const response = await mac(["curl", "--silent", "--output", "/dev/null", "--max-time", "15", "--write-out", "%{http_code}", endpoint], { timeoutMs: 20_000 });
    if (response.exitCode !== 0 || !/^[1-4][0-9]{2}$/u.test(response.stdout.trim())) throw new Error("retained Mac required egress is unavailable");
  }
  const doctor = await mac(["/bin/sh", "-c",
    'set -eu; set -- "$HOME"/qual/omp-session-gateway-*-bun/apps/gateway/src/cli.js; test "$#" = 1; "$HOME/.bun/bin/bun" "$1" doctor'],
  { timeoutMs: 120_000 });
  const parsed: unknown = JSON.parse(doctor.stdout);
  const checks = isRecord(parsed) && isRecord(parsed.checks) ? parsed.checks : undefined;
  if (doctor.exitCode !== 0 || checks === undefined || Object.keys(checks).length === 0 || Object.values(checks).some(value => value !== true) ||
    ["loopbackTrustSound", "listenerLoopbackOnly", "identityAllowed", "serveMapping", "funnelDisabled"].some(key => checks[key] !== true)) {
    throw new Error("retained Mac candidate doctor invariants failed");
  }
  return { macEgress: true, macDoctor: true, loopbackOnly: true, serveExpected: true, funnelOff: true, fixturePinned: true };
}

async function runCampaignReadiness(
  options: StableQualificationOptions, target: MacTarget, candidate: CandidateVerification, pins: OmpPins,
  identity: ExternalLaneIdentity, pixel: PixelLease, receipt: StableQualificationReceipt, persist: () => Promise<void>,
  lanes: StableQualificationLaneModules,
): Promise<void> {
  if (lanes.readiness === undefined) throw new Error("effectful rig readiness adapter is unavailable");
  const epoch = randomUUID(), root = join(options.receiptRoot, "rig-readiness", epoch);
  let progress: unknown;
  let context: MacContext | undefined;
  let logs: Awaited<ReturnType<typeof retainedMacLogs>> | undefined;
  let ownsMac = false;
  const mac = remoteExecutor(target);
  const checkpoint = async (value: Record<string, unknown>) => {
    // Push's owner validates its complete baseline/progress; it is private recovery state, not telemetry.
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, "push-progress.json");
    await writeFile(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    progress = value;
  };
  await runRigReadiness(receipt, persist, {
    prepare: async () => {
      const baseline = await mac(["/bin/sh", "-c",
        'test ! -e "$HOME/Library/LaunchAgents/omp-session-gateway.plist" && ! launchctl print "gui/$(id -u)/omp-session-gateway" >/dev/null 2>&1 && ! lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1 && tailscale serve status --json'],
      { timeoutMs: 30_000 });
      const serve: unknown = JSON.parse(baseline.stdout || "null");
      if (baseline.exitCode !== 0 || !isRecord(serve) || Object.keys(serve).length !== 0) {
        throw new Error("readiness refuses a pre-existing retained Mac gateway or Serve mapping");
      }
      ownsMac = true;
      markMacCleanupRequired(receipt, options.macHost);
      await persist();
      logs = await retainedMacLogs(mac, epoch, options.executionFile === undefined ? join(root, "logs") :
        join(dirname(options.executionFile), "rig-readiness-logs"));
      await logs.logs.prepare();
      context = await prepareMacFixture({ ...options, qualificationLogDirectory: logs.directory }, target, candidate, pins);
    },
    windows: () => lanes.readiness!.windows(identity),
    macos: () => probeMacReadiness(mac),
    push: async execution => {
      const result = await lanes.readiness!.push({
        identity, pixel, progress, checkpoint, execution, mac, origin: context!.publicOrigin,
        sessionLabel: options.sessionLabel, qualificationLogs: logs!.logs,
      });
      if (result.delivered !== true || result.acknowledged !== true || typeof result.elapsedMs !== "number" || typeof result.clearMs !== "number") {
        throw new Error("rig readiness push path is unproven");
      }
      return { pixelReachable: true, pushSent: true, pushAcknowledged: true, pushPresented: true, pushCleared: true,
        deliveryMs: result.elapsedMs, clearMs: result.clearMs };
    },
    restorePixel: async execution => {
      if (progress === undefined) return;
      await lanes.androidPush.cleanup({ identity, pixel, progress, checkpoint, execution, mac,
        origin: context?.publicOrigin ?? await readMacPublicOrigin(target), sessionLabel: options.sessionLabel,
        ...(logs === undefined ? {} : { qualificationLogs: logs.logs }) });
      if (lanes.androidPush.needsCleanup(progress)) throw new Error("rig readiness Pixel restoration is unproven");
    },
    restoreMac: async execution => {
      if (!ownsMac) return;
      await executeReceiptLane(receipt, "cleanup", persist, () =>
        cleanupMac(context ?? { target, environment: macEnvironment(options, target, candidate) },
          logs === undefined ? undefined : () => logs!.logs.collect(), execution), true);
    },
  }, epoch);
}

export async function runStableQualification(
  argv: readonly string[],
  runtime: StablePreflightRuntime = defaultPreflightRuntime,
  lanes: StableQualificationLaneModules = defaultLaneModules,
): Promise<Record<string, unknown>> {
  const options = parseStableQualificationArgs(argv, runtime.environment);
  const execution = await readExecution(options);
  if (options.preflight) {
    try { await preflightStableQualification(options, runtime, lanes); }
    catch (error) {
      if (execution !== undefined && options.outcomeFile !== undefined) {
        await writeQualificationOutcomeFile(options.outcomeFile, {
          formatVersion: 1, outcome: "qualification-failed", scope: "preflight", execution,
          failureSummary: {
            failures: normalizeQualificationFailures(error).map(item => item.class === "harness" ?
              { ...item, operation: "not_started" } : item),
            timings: { attemptMs: 0, cleanupMs: 0 },
            containment: { proven: true, cleanupComplete: true, unresolvedMutation: false },
          },
        });
        throw error;
      }
      const outcome = recognizedDeviceCloudOutcome(error);
      if (outcome !== undefined) await writeDeviceCloudOutcomeFile(options.outcomeFile, outcome);
      throw error;
    }
    return {
      status: "preflight-passed",
      effects: "none; bounded read-only prerequisite probes only",
      notProven: [
        "candidate and predecessor signatures, checksums and attestations",
        "workflow dispatch authority and hosted credentials",
        "Debian and Mac lifecycle, migration, rollback and sudo authorization",
        "OMP publication/revocation and physical Android acceptance",
        "configured relay check, longer endurance coverage and cleanup",
        "Windows VM provisioning, interactive logon, lifecycle, physical client and destruction",
        "background Web Push delivery, notification taps, degraded device states and device restore",
        "real-device cloud iPhone, iPad and Android journeys, iPhone Home Screen alerts, and the vendor-record audit",
      ],
    };
  }
  if (runtime.platform !== "darwin" || runtime.arch !== "arm64") {
    throw new Error("stable qualification orchestration currently requires a Darwin-arm64 workstation");
  }
  const receiptPath = join(options.receiptRoot, "stable-qualification.json");
  // New attempts admit without effects before acquiring the lease. A receipt retry must consume
  // its exact authorization under the lease first, then admit; an interrupted owner needs recovery.
  let admission: Awaited<ReturnType<typeof preflightStableQualification>> | undefined;
  if (!await Bun.file(receiptPath).exists()) {
    try { admission = await preflightStableQualification(options, runtime, lanes); }
    catch (error) {
      if (execution !== undefined && options.outcomeFile !== undefined) await writeQualificationOutcomeFile(options.outcomeFile, {
        formatVersion: 1, outcome: "qualification-failed", scope: "preflight", execution,
        failureSummary: {
          failures: normalizeQualificationFailures(error).map(item => item.class === "harness" ? { ...item, operation: "not_started" } : item),
          timings: { attemptMs: 0, cleanupMs: 0 }, containment: { proven: true, cleanupComplete: true, unresolvedMutation: false },
        },
      });
      throw error;
    }
  }
  return runtime.withReleaseLease(`qualification:${options.tag}:${receiptPath}`, () =>
    runOwnedStableQualification(options, runtime, lanes, receiptPath, execution, admission));
}

async function readExecution(options: StableQualificationOptions): Promise<QualificationExecution | undefined> {
  if (options.executionFile === undefined) return undefined;
  const metadata = await lstat(options.executionFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1 || metadata.size > 16_384) throw new Error("unsafe qualification execution file");
  const execution = parseQualificationExecution(JSON.parse(await readFile(options.executionFile, "utf8")));
  if (execution.binding.candidateTag !== options.tag || execution.binding.previousTag !== options.previousTag ||
    execution.binding.macHostSha256 !== sha256(options.macHost)) throw new Error("qualification execution subject changed");
  return execution;
}

async function runOwnedStableQualification(
  options: StableQualificationOptions,
  runtime: StablePreflightRuntime,
  lanes: StableQualificationLaneModules,
  receiptPath: string,
  execution?: QualificationExecution,
  admission?: Awaited<ReturnType<typeof preflightStableQualification>>,
): Promise<Record<string, unknown>> {
  const orchestratorCommit = await prerequisite("cannot resolve the qualification source commit", () =>
    runtime.output(["git", "rev-parse", "HEAD"]),
  );
  const receipt = await loadReceipt(receiptPath, options.tag, orchestratorCommit, options.previousTag);
  if (execution !== undefined && execution.binding.orchestratorCommit !== orchestratorCommit) throw new Error("qualification execution source changed");
  // Refuse retargeting before admission, target resolution, or any finally-path remote cleanup.
  assertMacHostBinding(receipt, options.macHost);
  const resumeIdentity = { tag: options.tag, previousTag: options.previousTag, orchestratorCommit, macHost: options.macHost };
  if (options.resumeDeviceCloud) assertDeviceCloudResumeEligible(receipt, resumeIdentity, lanes);
  else if (receipt.lanes.deviceCloud.evidence?.availabilityHold !== undefined) {
    let eligible = false;
    try { assertDeviceCloudResumeEligible(receipt, resumeIdentity, lanes); eligible = true; } catch { /* Other failures retain normal cleanup recovery. */ }
    if (eligible) throw new Error("this availability-held receipt requires explicit --resume-device-cloud");
  }
  const persist = createReceiptPersister(receiptPath, receipt);
  const began = performance.now();
  const run = async () => {
    try { return await runReceiptStableQualification(options, runtime, lanes, receiptPath, receipt, orchestratorCommit, persist, admission); }
    catch (error) {
      await finalizeCampaignFailure(receipt, error, persist, lanes, { attemptMs: performance.now() - began, cleanupMs: cleanupElapsed(receipt) });
      if (receipt.execution !== undefined && options.outcomeFile !== undefined) {
        await writeQualificationOutcomeFile(options.outcomeFile, {
          formatVersion: 1, outcome: "qualification-failed",
          scope: receipt.rigReadiness?.status === "failed" ? "rigReadiness" : "campaign",
          execution: receipt.execution, failureSummary: receipt.failureSummary!,
          receipt: { sha256: sha256(await readFile(receiptPath)), cleanupDisposition: receipt.failureSummary!.containment.proven ? "restored" : "unresolved" },
        });
      }
      throw error;
    }
  };
  if (execution !== undefined) {
    if (options.retryReceiptSha256 !== undefined) {
      if (sha256(await readFile(receiptPath)) !== options.retryReceiptSha256 || receipt.execution === undefined) throw new Error("retry receipt snapshot changed");
      assertCampaignRetryEligible(receipt, receipt.execution, lanes);
      return withConsumedCampaignRetry(receipt, execution, persist, run);
    }
    // A started working receipt is never implicit replay authority, even for the same ordinal.
    if (receipt.execution !== undefined || Object.values(receipt.lanes).some(lane => lane.attempts > 0)) throw new Error("campaign retry requires immutable prior receipt authorization");
    receipt.execution = execution;
    await persist();
  } else if (receipt.execution !== undefined) {
    throw new Error("new-format campaign requires bound retry execution");
  }
  return options.resumeDeviceCloud ? withConsumedDeviceCloudHold(receipt, persist, run) : run();
}

async function runReceiptStableQualification(
  options: StableQualificationOptions,
  runtime: StablePreflightRuntime,
  lanes: StableQualificationLaneModules,
  receiptPath: string,
  receipt: StableQualificationReceipt,
  orchestratorCommit: string,
  persist: () => Promise<void>,
  priorAdmission?: Awaited<ReturnType<typeof preflightStableQualification>>,
): Promise<Record<string, unknown>> {
  const resumeIdentity = { tag: options.tag, previousTag: options.previousTag, orchestratorCommit, macHost: options.macHost };
  receipt.status = "running";
  delete receipt.completedAt;
  delete receipt.error;
  const ompPins = await loadQualificationPins();
  const protectedFiles = await captureProtectedFiles();
  let admitted = false;
  let externalEffects = false;
  const pixel = lanes.createPixelLease(() => nextReceiptFailureId(receipt));
  let windowsBranch: Promise<void> | undefined;
  // Lanes this invocation drove through runExternalLane, which always runs their cleanup itself.
  const driven: Record<"androidPush" | "deviceCloud", boolean> = { androidPush: false, deviceCloud: false };

  let target: MacTarget | undefined;
  let macCleanupContext: Pick<MacContext, "target" | "environment"> | undefined;
  let macContext: MacContext | undefined;
  let ompHost: OmpLifecycleHost | undefined;
  let tunnelProcess: ManagedProcess | undefined;
  let campaignLogs: Awaited<ReturnType<typeof retainedMacLogs>> | undefined;
  let primaryError: unknown;
  let cleanupRequired = receiptNeedsMacCleanup(receipt);
  const requireMacCleanup = async (): Promise<void> => {
    cleanupRequired = true;
    if (markMacCleanupRequired(receipt, options.macHost)) await persist();
  };
  try {
    if (cleanupRequired) {
      if (receipt.candidate === undefined) throw new Error("receipt records Mac effects without a candidate identity");
      target = await prerequisite("configured Mac cleanup access is unavailable", () => runtime.loadMacTarget(options));
      macCleanupContext = {
        target,
        environment: macEnvironment(options, target, receipt.candidate),
      };
    }

    // A passed lane is otherwise skipped on resume. Reject inadequate proof without reopening it
    // or dispatching work, but only after recovering any recorded Mac effects for finally cleanup.
    try {
      assertPassedRelayEvidence(receipt, options.relaySeconds);
    } catch (error) {
      receipt.status = "failed";
      receipt.error = "qualification relay evidence rejected; inspect the qualification process output";
      await persist();
      throw error;
    }

    const admission = priorAdmission ?? await preflightStableQualification(options, runtime, lanes);
    if (admission.orchestratorCommit !== orchestratorCommit) throw new Error("qualification source changed during preflight");
    const { ghToken, qualificationRef } = admission;
    target = admission.target;
    admitted = true;
    await persist();
    if (receipt.lanes.artifacts.status === "passed") {
      // Reverify bytes on every attempt, without rewriting passed qualification proof.
      assertSameRelease(receipt.candidate, await verifyRelease(options.tag, candidateAssetDirectory(options), false, ghToken), "candidate");
      assertSameRelease(receipt.predecessor, await verifyRelease(options.previousTag, predecessorAssetDirectory(options), true, ghToken), "predecessor");
    }
    const candidate = await executeReceiptLane(receipt, "artifacts", persist, async checkpoint => {
      const verified = await verifyRelease(options.tag, candidateAssetDirectory(options), false, ghToken);
      const predecessor = await verifyRelease(options.previousTag, predecessorAssetDirectory(options), true, ghToken);
      assertSameRelease(receipt.candidate, verified, "candidate");
      assertSameRelease(receipt.predecessor, predecessor, "predecessor");
      receipt.candidate = { tag: verified.tag, sourceCommit: verified.sourceCommit, archiveSha256: verified.archiveSha256 };
      receipt.predecessor = {
        tag: predecessor.tag,
        sourceCommit: predecessor.sourceCommit,
        archiveSha256: predecessor.archiveSha256,
      };
      const evidence = {
        sourceCommit: verified.sourceCommit,
        archiveSha256: verified.archiveSha256,
        releaseUrl: verified.releaseUrl,
        signedTag: true,
        checksums: "passed",
        githubAttestations: "3/3",
        sigstoreBundles: "3/3",
        predecessor: {
          tag: predecessor.tag,
          sourceCommit: predecessor.sourceCommit,
          archiveSha256: predecessor.archiveSha256,
          signedTag: true,
          checksums: "passed",
          githubAttestations: predecessor.githubAttestations,
          sigstoreBundles: "3/3",
          ...(predecessor.historicalSignature === undefined ? {} : { historicalSignature: predecessor.historicalSignature }),
        },
      };
      await checkpoint(evidence);
      return evidence;
    });
    const candidateVerification: CandidateVerification = {
      tag: options.tag,
      sourceCommit: String(candidate.sourceCommit),
      archiveSha256: String(candidate.archiveSha256),
      releaseUrl: String(candidate.releaseUrl),
      assetDirectory: candidateAssetDirectory(options),
    };
    const identity = externalLaneIdentity(options, receipt, orchestratorCommit, ompPins);
    if (receipt.execution !== undefined) validateReceiptExecution(receipt);
    await runCampaignReadiness(options, target, candidateVerification, ompPins, identity, pixel, receipt, persist, lanes);
    // Windows owns a billed VM and waits for the Pixel only at its physical-client step, so it runs
    // beside the Debian and Mac lanes and settles, with its own cleanup lane, before the verdict.
    windowsBranch = runExternalLane(receipt, "windows", persist, lanes.windows, { identity, pixel });
    windowsBranch.catch(() => {});

    await executeReceiptLane(receipt, "debian", persist, checkpoint =>
      qualifyDebian(options, receipt, checkpoint, qualificationRef),
    );
    macCleanupContext ??= {
      target,
      environment: macEnvironment(options, target, candidateVerification),
    };
    const macWasPassed = receipt.lanes.macos.status === "passed";
    const livePending = (["macos", "ompPublication", "android", "androidPush", "deviceCloud", "relay"] as const)
      .some(name => receipt.lanes[name].status !== "passed");
    if (livePending) {
      await requireMacCleanup();
      const logEpoch = randomUUID();
      campaignLogs = await retainedMacLogs(remoteExecutor(target), logEpoch, options.executionFile === undefined ?
        join(options.receiptRoot, "attempts", logEpoch, "logs") : join(dirname(options.executionFile), "qualification-logs"));
      await campaignLogs.logs.prepare();
      options = { ...options, qualificationLogDirectory: campaignLogs.directory };
      macCleanupContext = { target, environment: macEnvironment(options, target, candidateVerification) };
    }
    if (!macWasPassed) {
      await requireMacCleanup();
      await executeReceiptLane(receipt, "macos", persist, async () =>
        qualifyMacLifecycle(options, target!, candidateVerification, ompPins),
      );
      macContext = {
        ...macCleanupContext,
        publicOrigin: await readMacPublicOrigin(target),
      };
    }

    const pushCurrent = receipt.lanes.androidPush.status === "passed" && externalCleanupCurrent(receipt, "androidPush");
    const cloudCurrent = receipt.lanes.deviceCloud.status === "passed" && externalCleanupCurrent(receipt, "deviceCloud");
    const liveEvidenceNeeded = !pushCurrent || !cloudCurrent || (["ompPublication", "android", "relay"] as const).some(
      name => receipt.lanes[name].status !== "passed",
    );
    if (liveEvidenceNeeded) {
      await requireMacCleanup();
      if (macWasPassed) {
        macContext = await prepareMacFixture(options, target, candidateVerification, ompPins);
        macCleanupContext = macContext;
      }
      if (macContext === undefined) throw new Error("Mac live fixture was not prepared");
      const publicationLane = receipt.lanes.ompPublication;
      const preservePublication = publicationLane.status === "passed";
      if (!preservePublication) {
        publicationLane.status = "running";
        publicationLane.attempts += 1;
        publicationLane.startedAt = now();
        delete publicationLane.error;
        delete publicationLane.completedAt;
        delete publicationLane.evidence;
        await persist();
      }

      // Only this driver writes the SSH stdin pipe; it stays open until its owned host stops.
      ompHost = createOmpStdinDriver(
        startOmpSession(options, target, ompPins),
        () => startOmpSession(options, target!, ompPins, "continue"),
        async child => {
          if (child.exitCode !== null) return;
          try { child.stdin.end(); } finally { await stopSubprocess(child); }
        },
      );
      const session = await waitForPublishedSession(macContext.publicOrigin, options.sessionLabel);
      const launchEvidence = await verifyLaunchContracts(macContext.publicOrigin, session);
      if (!preservePublication) {
        publicationLane.evidence = { ...launchEvidence, published: true };
        await persist();
      }
      const instanceId = launchEvidence.instanceId;
      if (typeof instanceId !== "string") throw new Error("published OMP instance id is missing");

      const tunnelPort = chooseTunnelPort();
      tunnelProcess = await startTunnel(target, tunnelPort);
      const pending: Promise<unknown>[] = [];
      if (receipt.lanes.android.status !== "passed") {
        pending.push(
          executeReceiptLane(receipt, "android", persist, async () =>
            withQualificationDeadline("android", QUALIFICATION_CEILINGS_MS.android, () => nextReceiptFailureId(receipt),
              execution => pixel("android", () => runAndroidAcceptance(options, macContext!, runtime, execution))),
          ),
        );
      }
      if (!pushCurrent) {
        driven.androidPush = true;
        // Push drives its own OMP fixture: replacing a generation on the shared one would break relay.
        pending.push(
          runExternalLane(receipt, "androidPush", persist, lanes.androidPush, {
            identity,
            pixel,
            origin: macContext.publicOrigin,
            mac: remoteExecutor(target),
            sessionLabel: options.sessionLabel,
            ...(campaignLogs === undefined ? {} : { qualificationLogs: campaignLogs.logs }),
          }),
        );
      }
      if (!cloudCurrent) {
        driven.deviceCloud = true;
        // Its own OMP fixture and TestingBot tunnel. It takes the Pixel lease inside, because its
        // prompts and alert raise Web Push to every subscription on the candidate gateway.
        pending.push(
          runExternalLane(receipt, "deviceCloud", persist, lanes.deviceCloud, {
            identity,
            pixel,
            origin: macContext.publicOrigin,
            mac: remoteExecutor(target),
            sessionLabel: options.sessionLabel,
            ...(campaignLogs === undefined ? {} : { qualificationLogs: campaignLogs.logs }),
          }),
        );
      }
      if (receipt.lanes.relay.status !== "passed") {
        pending.push(
          executeReceiptLane(receipt, "relay", persist, async () =>
            withQualificationDeadline("relay", (options.relaySeconds + 300) * 1_000, () => nextReceiptFailureId(receipt),
              execution => runRelaySmoke(options, macContext!, tunnelPort, instanceId, execution)),
          ),
        );
      }
      const settled = await Promise.allSettled(pending);
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      await finishLiveQualification(failures.map(result => result.reason), publicationLane, persist, async () => {
        await stopSubprocess(tunnelProcess);
        tunnelProcess = undefined;
      }, () => runOmpLifecycle({
        host: ompHost!,
        observer: { origin: macContext!.publicOrigin, waitForPublishedSession, verifyLaunchContracts, waitForRevocation },
        label: options.sessionLabel,
      }), preservePublication, () => nextReceiptFailureId(receipt));
    }
    await assertProtectedFilesUnchanged(protectedFiles);
  } catch (error) {
    primaryError = error;
  } finally {
    for (const stop of [() => stopSubprocess(tunnelProcess), async () => { await ompHost?.stopAll(); }]) {
      try { await stop(); }
      catch {
        const cleanupError = new Error("qualification live-session process cleanup failed");
        primaryError = primaryError === undefined ? cleanupError : new AggregateError([primaryError, cleanupError], "qualification and live-session cleanup failed");
      }
    }
    for (const [name, description] of [["androidPush", "background Push"], ["deviceCloud", "device-cloud"]] as const) {
      if (driven[name] || !recordedEffects(lanes[name], receipt.lanes[name])) continue;
      // A resumed campaign stopped before this lane could release what it recorded. Both lanes
      // resolve their fixture through the candidate gateway, so they run before the Mac is torn down.
      externalEffects = true;
      try {
        const mac = target ?? await prerequisite(`retained Mac access for ${description} cleanup is unavailable`, () =>
          runtime.loadMacTarget(options),
        );
        await cleanExternalLane(receipt, name, persist, lanes[name], {
          identity: externalLaneIdentity(options, receipt, orchestratorCommit, ompPins),
          pixel,
          origin: await readMacPublicOrigin(mac),
          mac: remoteExecutor(mac),
          sessionLabel: options.sessionLabel,
        });
      } catch (cleanupError) {
        primaryError = primaryError === undefined
          ? cleanupError
          : new AggregateError([primaryError, cleanupError], `qualification and ${description} cleanup failed`);
      }
    }
    if (cleanupRequired && macCleanupContext !== undefined) {
      try {
        await executeReceiptLane(receipt, "cleanup", persist, () =>
          trackCleanup(receipt, () => withQualificationDeadline("cleanup", QUALIFICATION_CEILINGS_MS.cleanup, () => nextReceiptFailureId(receipt),
            execution => cleanupMac(macCleanupContext!, campaignLogs === undefined ? undefined : () => campaignLogs!.logs.collect(), execution))), true);
      } catch (cleanupError) {
        primaryError = primaryError === undefined
          ? cleanupError
          : new AggregateError([primaryError, cleanupError], "qualification and cleanup failed");
      }
    }
    if (windowsBranch !== undefined) {
      if (primaryError !== undefined) console.error("stable qualification: waiting for the Windows lane to finish and clean up");
      try {
        await windowsBranch;
      } catch (windowsError) {
        primaryError = primaryError === undefined
          ? windowsError
          : new AggregateError([primaryError, windowsError], "qualification and the Windows lane failed");
      }
    } else if (recordedEffects(lanes.windows, receipt.lanes.windows)) {
      // Admission failed before the Windows lane could resume, but a recorded VM must never outlive it.
      externalEffects = true;
      try {
        await cleanExternalLane(receipt, "windows", persist, lanes.windows, {
          identity: externalLaneIdentity(options, receipt, orchestratorCommit, ompPins),
          pixel,
        });
      } catch (cleanupError) {
        primaryError = primaryError === undefined
          ? cleanupError
          : new AggregateError([primaryError, cleanupError], "qualification and Windows cleanup failed");
      }
    }
    try {
      await assertProtectedFilesUnchanged(protectedFiles);
    } catch (guardError) {
      primaryError = primaryError === undefined
        ? guardError
        : new AggregateError([primaryError, guardError], "qualification modified protected state");
    }
  }

  if (primaryError === undefined) {
    const incomplete = incompleteQualification(receipt);
    if (incomplete !== undefined) primaryError = new Error(incomplete);
  }
  if (primaryError !== undefined) {
    if (!admitted && !cleanupRequired && !externalEffects && !options.resumeDeviceCloud) {
      const outcome = recognizedDeviceCloudOutcome(primaryError);
      if (outcome !== undefined) await writeDeviceCloudOutcomeFile(options.outcomeFile, outcome);
      throw primaryError;
    }
    if (receipt.execution === undefined) throw await recordDeviceCloudCampaignFailure(receipt, primaryError, resumeIdentity, persist, lanes, options.outcomeFile);
    throw primaryError;
  }
  receipt.status = "passed";
  receipt.completedAt = now();
  delete receipt.error;
  await persist();
  return { status: receipt.status, tag: receipt.tag, receipt: receiptPath };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runStableQualification(Bun.argv.slice(2))));
  } catch (error) {
    const hold = recognizedDeviceCloudOutcome(error);
    if (hold !== undefined) console.error("stable qualification held: pinned device-cloud pools are busy; explicit operator retry required");
    else console.error("stable qualification failed; inspect the private receipt and outcome");
    process.exitCode = hold === undefined ? 1 : 75;
    try {
      const options = parseStableQualificationArgs(Bun.argv.slice(2));
      const execution = await readExecution(options);
      if (execution !== undefined) process.exitCode = options.outcomeFile === undefined ? 1 :
        qualificationOutcomeExitCode(await readQualificationOutcomeFile(options.outcomeFile, execution), execution);
    } catch { process.exitCode = 1; }
  }
}
