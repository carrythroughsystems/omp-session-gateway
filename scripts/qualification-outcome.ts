/**
 * General worker/CLI contract, deliberately not wired into legacy workers in this change:
 * - QualificationExecution format 1 binds attempt 0..2 to exact candidate/source/archive,
 *   predecessor, orchestrator, policy and retained Mac. Retry attempts require retryPlanSha256.
 *   macHostSha256 is SHA-256 of the exact SSH target bytes; never persist the host address in
 *   this channel. These digests are private authority bindings, not log/issue fields.
 * - QualificationOutcome is failure-only. A receipt digest hashes its exact persisted bytes;
 *   receipt absence is permitted only for effects-free preflight (no confirmed/unknown writes).
 * - parseQualificationOutcome optionally checks an independently supplied expected execution.
 *   qualificationOutcomeExitCode requires that expectation: 75 means eligible evidence, 1
 *   means stop. Neither the code nor this file alone authorizes a retry. Workers must validate
 *   the receipt/job, prove current containment, and persist successfully before using code 75.
 * - read/writeQualificationOutcomeFile use a bounded, duplicate-key-rejecting private atomic
 *   channel at OMP_STABLE_OUTCOME_FILE. Errors never include file paths, raw input or causes.
 *   Legacy device-cloud files are not upgraded; their parsers and manual recovery remain separate.
 *   Persistence is POSIX-only for the Studio driver: file data and parent directory are synced.
 *   Windows refuses persistence before filesystem effects; schema and JSON parsing stay portable.
 *   Supply a physical path: every ancestor is checked for symlinks, and size/metadata changes
 *   during reading are refused. Cleanup disposition must agree with the containment summary.
 * - RigReadinessReceipt and its parser define additive schema-3 readiness observations only;
 *   the effectful readiness owner is responsible for actually measuring and restoring them.
 *   Its optional epoch/phase pair names a private resource-owning attempt (canonical UUIDv4
 *   and closed readiness step), never a host/device identity. Absence remains legacy/pre-owner
 *   evidence; neither the pair nor a deterministic progress path proves containment by itself.
 */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseRetainedVendorJson } from "./device-cloud-record-json.ts";
import {
  FAILURE_LIMITS, FAILURE_STEPS, parseLaneTimings, parseQualificationFailureSummary, qualificationPreflightFailuresEffectFree, qualificationRetryEligible,
  type LaneStep, type LaneTimings, type QualificationFailureSummary,
} from "./qualification-failure.ts";

export const OUTCOME_MAX_BYTES = 131_072;
export interface QualificationBinding {
  readonly candidateTag: string;
  readonly sourceCommit: string;
  readonly archiveSha256: string;
  readonly previousTag: string;
  readonly orchestratorCommit: string;
  readonly policySha256: string;
  readonly macHostSha256: string;
}
export interface QualificationExecution {
  readonly formatVersion: 1;
  readonly campaignAttempt: 0 | 1 | 2;
  readonly binding: QualificationBinding;
  readonly retryPlanSha256?: string;
}
export type CleanupDisposition = "not_required" | "restored" | "unresolved";
export interface QualificationOutcome {
  readonly formatVersion: 1;
  readonly outcome: "qualification-failed";
  readonly scope: "preflight" | "rigReadiness" | "campaign";
  readonly execution: QualificationExecution;
  readonly failureSummary: QualificationFailureSummary;
  readonly receipt?: { readonly sha256: string; readonly cleanupDisposition: CleanupDisposition };
}
const readinessBounds = {
  leaseOwned: "boolean", pixelReachable: "boolean", pushSent: "boolean", pushAcknowledged: "boolean",
  gcmConnected: "boolean", gcmRemedyApplied: "boolean",
  pushPresented: "boolean", pushCleared: "boolean", baselineRestored: "boolean", windowsApiReady: "boolean",
  windowsResourcesAbsent: "boolean", creationAllowance: 1_000, quotaObservable: "boolean", quotaAvailable: 1_000_000,
  macEgress: "boolean", macDoctor: "boolean", loopbackOnly: "boolean", serveExpected: "boolean", funnelOff: "boolean",
  fixturePinned: "boolean", deliveryMs: FAILURE_LIMITS.elapsedMs, clearMs: FAILURE_LIMITS.elapsedMs,
  subscriptionCount: 8, sendCount: 16_384, ackCount: 16_384,
} as const;
export interface RigReadinessReceipt {
  readonly status: "pending" | "running" | "passed" | "failed";
  readonly campaignAttempt: 0 | 1 | 2;
  readonly observations: { readonly [K in keyof typeof readinessBounds]?: (typeof readinessBounds)[K] extends "boolean" ? boolean : number };
  readonly timings: LaneTimings<"rigReadiness">;
  readonly cleanupDisposition: CleanupDisposition;
  /** Private owner identity; epoch and phase must either both be present or both be absent. */
  readonly epoch?: string;
  readonly phase?: LaneStep<"rigReadiness">;
}
const SHA = /^[a-f0-9]{40}$/u, DIGEST = /^[a-f0-9]{64}$/u;
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TAG = /^v(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/u;
const CANDIDATE = /^v(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})-prealpha\.[1-9][0-9]{0,8}$/u;
const BINDING_KEYS = ["candidateTag", "sourceCommit", "archiveSha256", "previousTag", "orchestratorCommit", "policySha256", "macHostSha256"] as const;
function invalid(): never { throw new Error("invalid qualification outcome evidence"); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid();
}
function attempt(value: unknown): value is 0 | 1 | 2 { return value === 0 || value === 1 || value === 2; }
function matches(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value); }
function cleanup(value: unknown): value is CleanupDisposition { return value === "not_required" || value === "restored" || value === "unresolved"; }

export function parseQualificationExecution(value: unknown): QualificationExecution {
  const execution = record(value);
  keys(execution, ["formatVersion", "campaignAttempt", "binding", ...(Object.hasOwn(execution, "retryPlanSha256") ? ["retryPlanSha256"] : [])]);
  if (execution.formatVersion !== 1 || !attempt(execution.campaignAttempt) ||
    (execution.campaignAttempt === 0 ? Object.hasOwn(execution, "retryPlanSha256") : !matches(execution.retryPlanSha256, DIGEST))) invalid();
  const binding = record(execution.binding);
  keys(binding, BINDING_KEYS);
  for (const key of BINDING_KEYS) {
    const pattern = key === "candidateTag" ? CANDIDATE : key === "previousTag" ? TAG : key.endsWith("Commit") ? SHA : DIGEST;
    if (!matches(binding[key], pattern)) invalid();
  }
  if ((binding.candidateTag as string).split("-prealpha.")[0] === binding.previousTag) invalid();
  return structuredClone(execution) as unknown as QualificationExecution;
}

export function qualificationExecutionsMatch(value: unknown, expected: unknown): boolean {
  try {
    const actual = parseQualificationExecution(value), wanted = parseQualificationExecution(expected);
    return actual.campaignAttempt === wanted.campaignAttempt && actual.retryPlanSha256 === wanted.retryPlanSha256 &&
      BINDING_KEYS.every(key => actual.binding[key] === wanted.binding[key]);
  } catch { return false; }
}

export function parseRigReadinessReceipt(value: unknown): RigReadinessReceipt {
  const readiness = record(value);
  const owner = Object.hasOwn(readiness, "epoch") || Object.hasOwn(readiness, "phase");
  keys(readiness, ["status", "campaignAttempt", "observations", "timings", "cleanupDisposition", ...(owner ? ["epoch", "phase"] : [])]);
  if (owner && (!matches(readiness.epoch, EPOCH) || typeof readiness.phase !== "string" ||
    !(FAILURE_STEPS.rigReadiness as readonly string[]).includes(readiness.phase))) invalid();
  if (!attempt(readiness.campaignAttempt) || typeof readiness.status !== "string" ||
    !["pending", "running", "passed", "failed"].includes(readiness.status) || !cleanup(readiness.cleanupDisposition) ||
    (readiness.status === "passed" && readiness.cleanupDisposition !== "restored")) invalid();
  const observations = record(readiness.observations);
  for (const [key, value] of Object.entries(observations)) {
    if (!Object.hasOwn(readinessBounds, key)) invalid();
    const bound = readinessBounds[key as keyof typeof readinessBounds];
    if (bound === "boolean" ? typeof value !== "boolean" :
      typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > bound) invalid();
    if (["quotaAvailable", "creationAllowance", "subscriptionCount", "sendCount", "ackCount"].includes(key) && !Number.isSafeInteger(value)) invalid();
  }
  if (observations.quotaObservable !== true && Object.hasOwn(observations, "quotaAvailable")) invalid();
  // Historical schema-3 receipts omit both; new evidence must carry the complete boolean pair.
  if ((Object.hasOwn(observations, "gcmConnected") || Object.hasOwn(observations, "gcmRemedyApplied")) &&
    (typeof observations.gcmConnected !== "boolean" || typeof observations.gcmRemedyApplied !== "boolean" ||
      readiness.status === "passed" && observations.gcmConnected !== true)) invalid();
  if ((readiness.cleanupDisposition === "restored" && observations.baselineRestored !== true) ||
    (observations.baselineRestored === true && readiness.cleanupDisposition === "unresolved") ||
    (observations.baselineRestored === false && readiness.cleanupDisposition !== "unresolved")) invalid();
  if (readiness.status === "passed" &&
    (["pixelReachable", "pushSent", "pushAcknowledged", "pushPresented", "pushCleared"].some(key => observations[key] !== true) ||
      ["subscriptionCount", "sendCount", "ackCount"].some(key => typeof observations[key] !== "number" || observations[key] < 1) ||
      observations.sendCount !== observations.ackCount)) invalid();
  return { ...readiness, observations: { ...observations }, timings: parseLaneTimings("rigReadiness", readiness.timings) } as unknown as RigReadinessReceipt;
}

export function parseQualificationOutcome(value: unknown, expected?: QualificationExecution): QualificationOutcome {
  const outcome = record(value);
  keys(outcome, ["formatVersion", "outcome", "scope", "execution", "failureSummary", ...(Object.hasOwn(outcome, "receipt") ? ["receipt"] : [])]);
  if (outcome.formatVersion !== 1 || outcome.outcome !== "qualification-failed" ||
    !["preflight", "rigReadiness", "campaign"].includes(outcome.scope as string)) invalid();
  const execution = parseQualificationExecution(outcome.execution);
  if (expected !== undefined && !qualificationExecutionsMatch(execution, expected)) invalid();
  const failureSummary = parseQualificationFailureSummary(outcome.failureSummary);
  if (outcome.scope === "preflight" && !qualificationPreflightFailuresEffectFree(failureSummary.failures)) invalid();
  let receipt: QualificationOutcome["receipt"];
  if (Object.hasOwn(outcome, "receipt")) {
    const raw = record(outcome.receipt);
    keys(raw, ["sha256", "cleanupDisposition"]);
    if (!matches(raw.sha256, DIGEST) || !cleanup(raw.cleanupDisposition)) invalid();
    receipt = { sha256: raw.sha256, cleanupDisposition: raw.cleanupDisposition };
    const contained = failureSummary.containment.proven && failureSummary.containment.cleanupComplete &&
      !failureSummary.containment.unresolvedMutation;
    if ((receipt.cleanupDisposition === "unresolved") === contained ||
      (receipt.cleanupDisposition === "not_required" && failureSummary.failures.some(item =>
        item.operation !== "not_started" && item.operation !== "read_only"))) invalid();
  } else if (outcome.scope !== "preflight" || failureSummary.failures.some(item => item.operation !== "not_started" && item.operation !== "read_only")) invalid();
  return { formatVersion: 1, outcome: "qualification-failed", scope: outcome.scope as QualificationOutcome["scope"], execution, failureSummary,
    ...(receipt === undefined ? {} : { receipt }) };
}

export function qualificationOutcomeExitCode(value: unknown, expected: QualificationExecution | undefined): 1 | 75 {
  if (expected === undefined) return 1;
  try {
    const outcome = parseQualificationOutcome(value, expected);
    if (outcome.receipt?.cleanupDisposition === "unresolved" ||
      (outcome.receipt?.cleanupDisposition === "not_required" && outcome.failureSummary.failures.some(item => item.operation === "confirmed"))) return 1;
    return qualificationRetryEligible(outcome.failureSummary, true) ? 75 : 1;
  } catch { return 1; }
}

function fileError(): Error { return new Error("qualification outcome file is missing, unsafe or invalid"); }
function privateMetadata(metadata: Stats, directory: boolean): boolean {
  return (directory ? metadata.isDirectory() : metadata.isFile()) && !metadata.isSymbolicLink() &&
    metadata.uid === process.getuid?.() && (metadata.mode & 0o777) === (directory ? 0o700 : 0o600) &&
    (directory || metadata.nlink === 1);
}
async function privateDirectory(path: string, create: boolean): Promise<void> {
  const components: string[] = [];
  for (let component = path; ; component = dirname(component)) {
    components.push(component);
    if (dirname(component) === component) break;
  }
  for (const component of components.reverse()) {
    let metadata;
    try { metadata = await lstat(component); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw fileError();
      await mkdir(component, { mode: 0o700 });
      metadata = await lstat(component);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (component === path && !privateMetadata(metadata, true))) throw fileError();
  }
}
async function validateDestination(path: string): Promise<void> {
  try { if (!privateMetadata(await lstat(path), false)) throw fileError(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fileError(); }
}

/** Private job directories are owned by this user; hostile same-uid directory replacement is out of scope. */
export async function writeQualificationOutcomeFile(path: string, value: QualificationOutcome): Promise<void> {
  if (process.platform === "win32") throw new Error("qualification outcome persistence requires a POSIX host");
  const outcome = parseQualificationOutcome(value);
  const bytes = Buffer.from(`${JSON.stringify(outcome)}\n`);
  if (bytes.length > OUTCOME_MAX_BYTES) throw fileError();
  let temporary: string | undefined;
  try {
    const destination = resolve(path), parent = dirname(destination);
    await privateDirectory(parent, true);
    await validateDestination(destination);
    temporary = `${destination}.tmp-${randomUUID()}`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await validateDestination(destination);
    await rename(temporary, destination);
    temporary = undefined;
    const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { throw fileError(); }
  finally { if (temporary !== undefined) await unlink(temporary).catch(() => {}); }
}

export async function readQualificationOutcomeFile(path: string, expected?: QualificationExecution): Promise<QualificationOutcome> {
  if (process.platform === "win32") throw new Error("qualification outcome persistence requires a POSIX host");
  try {
    const destination = resolve(path);
    await privateDirectory(dirname(destination), false);
    const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await file.stat();
      if (!privateMetadata(metadata, false) || metadata.size < 1 || metadata.size > OUTCOME_MAX_BYTES) throw fileError();
      // Read one bounded buffer, including one overflow byte; never readFile a growing input.
      const bytes = Buffer.alloc(OUTCOME_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const after = await file.stat();
      if (length < 1 || length > OUTCOME_MAX_BYTES || length !== metadata.size || after.size !== metadata.size ||
        after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs || !privateMetadata(after, false)) throw fileError();
      return parseQualificationOutcome(parseRetainedVendorJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))), expected);
    } finally { await file.close(); }
  } catch { throw fileError(); }
}
