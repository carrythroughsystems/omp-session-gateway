/**
 * Shared qualification contract (no retry effects):
 * - LaneFailure is a lane/reason/class-discriminated, capability-free record. IDs are unique
 *   within one campaign attempt; callers allocate them across lanes, not per lane.
 * - QualificationFailure validates a record; only its evidence is JSON-serializable. Causes
 *   remain in memory. Ordinary Error.cause and structural lookalikes are never classification.
 * - normalizeQualificationFailures traverses AggregateError and the two explicit typed errors.
 *   Unknown/malformed leaves become harness failures. Bounds overflow stops as harness.
 * - parseLaneFailures checks the complete attempt graph; parseLaneFailure checks one leaf.
 *   Collateral references independent roots directly, never other collateral records.
 *   Normalization resolves origins only against authored typed IDs, never generated IDs.
 * - qualificationRetryEligible is a pure predicate, not authorization: the caller must prove
 *   current resource containment and independently validate candidate/authority bindings.
 *   Receipt absence, unknown operation disposition, or missing proof never imply safety.
 *   Cleanup transport failures remain harness evidence; negative containment/reconciliation
 *   observations and mutating infrastructure dispositions block eligibility.
 *   Push/readiness delivery metadata timeouts are harness evidence, not proof of an outage.
 * - qualificationPreflightFailuresEffectFree permits only read-only/not-started admission
 *   surfaces, not later resource observations mislabeled as preflight.
 * - FAILURE_STEPS and parseLaneTimings also govern additive receipt step timings. No raw
 *   errors, host/device identities, notification metadata or provider bodies belong here.
 */
import { DeviceCloudAvailabilityHold, parseDeviceCloudHold } from "./device-cloud-availability.ts";

export type LaneFailureClass = "product" | "infra_transient" | "harness" | "collateral";
export type OperationDisposition = "not_started" | "read_only" | "confirmed" | "unknown";
export const FAILURE_LIMITS = { records: 64, depth: 16, nodes: 256, id: 65_535, elapsedMs: 86_400_000 } as const;

const commonReasons = {
  unclassified_failure: "harness", invalid_evidence: "harness", normalization_limit_exceeded: "harness",
  deadline_exceeded: "harness", dependency_failed: "collateral",
} as const;
const transportReasons = {
  connection_timeout: "infra_transient", connection_reset: "infra_transient", read_timeout: "infra_transient",
  retryable_service_failure: "infra_transient",
} as const;
const cleanupReasons = { ...commonReasons, connection_timeout: "harness", connection_reset: "harness", read_timeout: "harness",
  retryable_service_failure: "harness", containment_unproven: "harness", ownership_changed: "harness" } as const;
/** Reason-to-class mappings are authority, not caller-supplied labels. */
export const FAILURE_REASONS = {
  campaign: { ...commonReasons, ...transportReasons, binding_mismatch: "harness", outcome_persistence_failed: "harness",
    prerequisite_failed: "harness", pinned_pool_busy: "infra_transient", assertion_failed: "product",
    authentication_failed: "harness", helper_failed: "harness", mutation_unconfirmed: "harness", ownership_changed: "harness",
    probe_deadline: "infra_transient", allocation_rejected: "infra_transient", privacy_failed: "product", delivery_timeout: "harness",
    push_service_failure: "infra_transient", device_outage: "infra_transient", tailnet_outage: "infra_transient" },
  preflight: { ...commonReasons, ...transportReasons, prerequisite_failed: "harness" },
  rigReadiness: { ...commonReasons, ...transportReasons, prerequisite_failed: "harness", assertion_failed: "product",
    push_service_failure: "infra_transient", device_outage: "infra_transient", tailnet_outage: "infra_transient",
    delivery_timeout: "harness", delivery_metadata_timeout: "harness" },
  artifacts: { ...commonReasons, ...transportReasons, signature_failed: "harness", digest_mismatch: "harness" },
  debian: { ...commonReasons, ...transportReasons, assertion_failed: "product", workflow_unknown: "harness" },
  macos: { ...commonReasons, ...transportReasons, assertion_failed: "product", prerequisite_failed: "harness" },
  ompPublication: { ...commonReasons, ...transportReasons, assertion_failed: "product", lifecycle_unconfirmed: "harness" },
  relay: { ...commonReasons, ...transportReasons, assertion_failed: "product" },
  android: { ...commonReasons, ...transportReasons, assertion_failed: "product", device_outage: "infra_transient", prerequisite_failed: "harness" },
  androidPush: { ...commonReasons, ...transportReasons, assertion_failed: "product", privacy_failed: "product",
    delivery_timeout: "harness", delivery_metadata_timeout: "harness",
    push_service_failure: "infra_transient", device_outage: "infra_transient", tailnet_outage: "infra_transient" },
  windows: { ...commonReasons, ...transportReasons, probe_deadline: "infra_transient", allocation_rejected: "infra_transient",
    assertion_failed: "product", authentication_failed: "harness", helper_failed: "harness", mutation_unconfirmed: "harness", ownership_changed: "harness" },
  deviceCloud: { ...commonReasons, pinned_pool_busy: "infra_transient", journey_failed: "product", audit_failed: "product",
    identity_mismatch: "harness", allocation_unknown: "harness", containment_unproven: "harness" },
  androidPushCleanup: cleanupReasons, windowsCleanup: cleanupReasons, deviceCloudCleanup: cleanupReasons,
  cleanup: { ...cleanupReasons, remote_unsettled: "collateral" },
} as const;
export type QualificationFailureLane = keyof typeof FAILURE_REASONS;
export const FAILURE_STEPS = {
  campaign: ["execution", "finalization", "outcome", "admission", "teardown"],
  preflight: ["admission", "tools", "pixel", "macos", "windows", "deviceCloud", "lease"],
  rigReadiness: ["lease", "artifacts", "fixture", "pixel_push", "tailnet", "windows", "quota", "macos", "cleanup"],
  artifacts: ["download", "signature", "digest"],
  debian: ["dispatch", "observe", "teardown"],
  macos: ["setup", "install", "upgrade", "reboot", "doctor", "rollback", "restore", "uninstall"],
  ompPublication: ["bounds", "initial_publication", "new_generation", "fork_messages", "fork", "first_stop", "first_revocation",
    "continue_start", "continue_publication", "continue_launches", "final_stop", "final_revocation", "cleanup"],
  relay: ["setup", "connect", "observe", "reconnect", "cleanup"],
  android: ["admission", "launch", "journey", "cleanup"],
  androidPush: ["baseline_captured", "subscription_ready", "private_verified", "session_verified", "preview_verified",
    "attention_tap_verified", "activity_stop_verified", "stale_generation_verified", "clear_verified", "triage_verified", "stale_taps_verified",
    "force_stop_verified", "permission_verified", "lock_resume_verified", "network_verified", "doze_verified", "forbidden_sinks_verified",
    "evidence_complete", "restored"],
  windows: ["preflight", "connection", "command", "output", "upload", "intent_checkpointed", "firewall_created", "instance_created",
    "transport_ready", "toolchain_staged", "predecessor_installed", "candidate_upgraded", "reboot_requested", "prelogin_verified", "postlogin_ready",
    "doctor_passed", "omp_published", "pixel_verified", "omp_revoked", "readiness_rotated", "predecessor_restored", "candidate_restored",
    "candidate_uninstalled", "standard_user_prepared", "standard_tailnet_released", "standard_tailnet_joined", "standard_interactive_ready",
    "standard_candidate_installed", "standard_reboot_requested", "standard_prelogin_verified", "standard_postlogin_ready", "standard_doctor_passed",
    "standard_readiness_rotated", "standard_candidate_uninstalled", "evidence_complete"],
  deviceCloud: ["preflight", "allocation", "attempt_started", "fixture_ready", "tunnel_ready", "iphone_verified", "ipad_verified",
    "android_verified", "records_audited", "evidence_complete", "restored"],
  androidPushCleanup: ["fixtureAsk", "notifications", "browser", "doze", "network", "task", "fixture", "containment"],
  windowsCleanup: ["reconnect", "stopOmp", "uninstall", "resetServe", "logout", "instance", "firewall", "tailnet", "pixelRestore", "vault", "containment"],
  deviceCloudCleanup: ["sessions", "audit", "records", "tunnels", "fixture", "pixelRestore", "containment"],
  cleanup: ["omp", "gateway", "serve", "artifacts", "containment"],
} as const satisfies Record<QualificationFailureLane, readonly string[]>;
export type LaneStep<L extends QualificationFailureLane> = (typeof FAILURE_STEPS)[L][number];
export type LaneTimings<L extends QualificationFailureLane = QualificationFailureLane> = Partial<Record<LaneStep<L>, number>>;

// A closed numeric/boolean vocabulary prevents identifiers hidden in field names or values.
const observationBounds = {
  attempts: 1_000, httpStatus: 599, exitCode: 255, signal: 64, samples: 1_000_000,
  timeoutMs: FAILURE_LIMITS.elapsedMs, firstResponseMs: FAILURE_LIMITS.elapsedMs, waitedMs: FAILURE_LIMITS.elapsedMs,
  firstDeliveryMs: FAILURE_LIMITS.elapsedMs, secondDeliveryMs: FAILURE_LIMITS.elapsedMs, latePostMs: FAILURE_LIMITS.elapsedMs,
  clearMs: FAILURE_LIMITS.elapsedMs, rearmCount: 1, latePostCount: 1_000, remainingResources: 1_000_000,
  transportFailure: "boolean", controllerDeadline: "boolean", readOnlyProbe: "boolean", retryableStatus: "boolean",
  pushServiceFailure: "boolean", outageSpansWindow: "boolean", deviceUnavailable: "boolean", tailnetUnavailable: "boolean",
  allocationRejected: "boolean", noAllocation: "boolean", cleanupVerified: "boolean", mutationReconciled: "boolean",
  persistenceFailed: "boolean",
} as const;
export type FailureObservations = { readonly [K in keyof typeof observationBounds]?: (typeof observationBounds)[K] extends "boolean" ? boolean : number };
type FailureFor<L extends QualificationFailureLane> = {
  [R in keyof (typeof FAILURE_REASONS)[L]]: {
    readonly id: number; readonly lane: L; readonly step: LaneStep<L>; readonly reason: R;
    readonly class: (typeof FAILURE_REASONS)[L][R]; readonly elapsedMs: number;
    readonly operation: OperationDisposition; readonly observations: FailureObservations;
  } & ((typeof FAILURE_REASONS)[L][R] extends "collateral" ? { readonly originIds: readonly number[] } : { readonly originIds?: never });
}[keyof (typeof FAILURE_REASONS)[L]];
export type LaneFailure = { [L in QualificationFailureLane]: FailureFor<L> }[QualificationFailureLane];
export interface QualificationFailureSummary {
  readonly failures: readonly LaneFailure[];
  readonly timings: { readonly attemptMs: number; readonly cleanupMs: number };
  readonly containment: { readonly proven: boolean; readonly cleanupComplete: boolean; readonly unresolvedMutation: boolean };
}

function invalid(): never { throw new Error("invalid qualification failure evidence"); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid();
}
function bounded(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function duration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= FAILURE_LIMITS.elapsedMs;
}
function failureId(value: unknown): value is number { return bounded(value, FAILURE_LIMITS.id) && value > 0; }

export function parseLaneFailure(value: unknown): LaneFailure {
  const item = record(value);
  keys(item, ["id", "lane", "step", "class", "reason", "elapsedMs", "operation", "observations", ...(item.class === "collateral" ? ["originIds"] : [])]);
  if (!failureId(item.id) || typeof item.lane !== "string" || !Object.hasOwn(FAILURE_REASONS, item.lane)) invalid();
  const lane = item.lane as QualificationFailureLane;
  const reasons: Readonly<Record<string, LaneFailureClass>> = FAILURE_REASONS[lane];
  if (typeof item.reason !== "string" || !Object.hasOwn(reasons, item.reason) || reasons[item.reason] !== item.class ||
    typeof item.step !== "string" || !(FAILURE_STEPS[lane] as readonly string[]).includes(item.step) || !duration(item.elapsedMs) ||
    typeof item.operation !== "string" || !["not_started", "read_only", "confirmed", "unknown"].includes(item.operation)) invalid();
  const observations = record(item.observations);
  for (const [key, observed] of Object.entries(observations)) {
    if (!Object.hasOwn(observationBounds, key)) invalid();
    const bound = observationBounds[key as keyof typeof observationBounds];
    if (bound === "boolean" ? typeof observed !== "boolean" : !bounded(observed, bound)) invalid();
  }
  if (item.class === "collateral") {
    if (!Array.isArray(item.originIds) || item.originIds.length < 1 || item.originIds.length > FAILURE_LIMITS.records ||
      item.originIds.some(id => !failureId(id) || id === item.id) || new Set(item.originIds).size !== item.originIds.length) invalid();
  }
  if (lane === "campaign" && item.class !== "harness" &&
    (item.step !== "admission" || !["not_started", "read_only"].includes(item.operation))) invalid();
  if (item.class === "infra_transient") {
    switch (item.reason) {
      case "connection_timeout": case "connection_reset": case "read_timeout":
        if (item.operation !== "read_only" || observations.transportFailure !== true) invalid();
        break;
      case "retryable_service_failure":
        if (item.operation !== "read_only" || !(observations.httpStatus === 429 ||
          (typeof observations.httpStatus === "number" && observations.httpStatus >= 500))) invalid();
        break;
      case "probe_deadline":
        if (item.operation !== "read_only" || observations.controllerDeadline !== true || observations.readOnlyProbe !== true) invalid();
        break;
      case "allocation_rejected":
        if (item.operation !== "not_started" || observations.allocationRejected !== true || observations.noAllocation !== true) invalid();
        break;
      case "push_service_failure":
        if (observations.pushServiceFailure !== true || observations.retryableStatus !== true) invalid();
        break;
      case "device_outage": case "tailnet_outage":
        if (observations.outageSpansWindow !== true || observations[item.reason === "device_outage" ? "deviceUnavailable" : "tailnetUnavailable"] !== true) invalid();
        break;
      case "pinned_pool_busy":
        if (item.operation !== "not_started" || !["preflight", "allocation", ...(lane === "campaign" ? ["admission"] : [])].includes(item.step) ||
          !bounded(observations.waitedMs, 600_000) || (["preflight", "admission"].includes(item.step) && observations.waitedMs !== 0)) invalid();
        break;
      default: invalid();
    }
  }
  return structuredClone(item) as LaneFailure;
}

export function parseLaneFailures(value: unknown): readonly LaneFailure[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > FAILURE_LIMITS.records) invalid();
  const failures = value.map(parseLaneFailure);
  const ids = new Map(failures.map(item => [item.id, item]));
  if (ids.size !== failures.length) invalid();
  for (const item of failures) if (item.class === "collateral" && item.originIds.some(id => !ids.has(id) || ids.get(id)!.class === "collateral")) invalid();
  return failures;
}

export function parseLaneTimings<L extends QualificationFailureLane>(lane: L, value: unknown): LaneTimings<L> {
  const timings = record(value);
  for (const [step, elapsedMs] of Object.entries(timings)) {
    if (!(FAILURE_STEPS[lane] as readonly string[]).includes(step) || !duration(elapsedMs)) invalid();
  }
  return { ...timings } as LaneTimings<L>;
}

export function parseQualificationFailureSummary(value: unknown): QualificationFailureSummary {
  const summary = record(value);
  keys(summary, ["failures", "timings", "containment"]);
  const timings = record(summary.timings), containment = record(summary.containment);
  keys(timings, ["attemptMs", "cleanupMs"]);
  keys(containment, ["proven", "cleanupComplete", "unresolvedMutation"]);
  if (!duration(timings.attemptMs) || !duration(timings.cleanupMs) || timings.cleanupMs > timings.attemptMs ||
    Object.values(containment).some(value => typeof value !== "boolean")) invalid();
  return { failures: parseLaneFailures(summary.failures), timings: { ...timings }, containment: { ...containment } } as QualificationFailureSummary;
}

export class QualificationFailure extends Error {
  readonly evidence: LaneFailure;
  constructor(evidence: LaneFailure, options?: ErrorOptions) {
    const safe = parseLaneFailure(evidence);
    super(`qualification ${safe.lane} ${safe.reason}`, options);
    this.name = "QualificationFailure";
    this.evidence = safe;
  }
  toJSON(): LaneFailure { return parseLaneFailure(this.evidence); }
}

function unclassified(id: number, reason: "unclassified_failure" | "normalization_limit_exceeded" = "unclassified_failure"): LaneFailure {
  return { id, lane: "campaign", step: "execution", reason, class: "harness", elapsedMs: 0, operation: "unknown", observations: {} };
}

/** Overflow discards the incomplete traversal rather than accidentally approving a prefix. */
export function normalizeQualificationFailures(error: unknown): readonly LaneFailure[] {
  const leaves: (LaneFailure | undefined)[] = [];
  let nodes = 0, exceeded = false;
  const ancestors = new Set<AggregateError>();
  const visit = (current: unknown, depth: number): void => {
    if (exceeded) return;
    if (++nodes > FAILURE_LIMITS.nodes || depth > FAILURE_LIMITS.depth || leaves.length >= FAILURE_LIMITS.records) { exceeded = true; return; }
    if (current instanceof AggregateError) {
      if (ancestors.has(current)) { exceeded = true; return; }
      if (!Array.isArray(current.errors) || current.errors.length === 0) { leaves.push(undefined); return; }
      ancestors.add(current);
      for (const child of current.errors) { visit(child, depth + 1); if (exceeded) break; }
      ancestors.delete(current);
      return;
    }
    try {
      if (current instanceof QualificationFailure) { leaves.push(parseLaneFailure(current.evidence)); return; }
      if (current instanceof DeviceCloudAvailabilityHold) {
        const hold = parseDeviceCloudHold(current.evidence);
        // Epochs/target identities remain in the legacy owner; this projection grants no cleanup proof.
        leaves.push(parseLaneFailure({ id: 1, lane: "deviceCloud", step: hold.stage, class: "infra_transient", reason: "pinned_pool_busy",
          elapsedMs: hold.waitedMs, operation: "not_started", observations: { waitedMs: hold.waitedMs } }));
        generated.add(leaves.length - 1);
        return;
      }
    } catch { /* Invalid explicitly typed evidence is still an unknown failure. */ }
    leaves.push(undefined);
  };
  const generated = new Set<number>();
  visit(error, 0);
  if (exceeded) return [unclassified(1, "normalization_limit_exceeded")];
  const used = new Set<number>();
  for (let index = 0; index < leaves.length; index += 1) {
    const leaf = leaves[index];
    if (leaf === undefined || generated.has(index)) continue;
    if (used.has(leaf.id)) leaves[index] = undefined;
    else used.add(leaf.id);
  }
  // Capture authored root identities before allocating IDs for unknown/legacy projections.
  // A dangling reference must not acquire an origin merely because that numeric slot is free.
  const roots = new Set(leaves.flatMap((item, index) =>
    item !== undefined && !generated.has(index) && item.class !== "collateral" ? [item.id] : []));
  let next = 1;
  const failures = leaves.map((leaf, index) => {
    if (leaf !== undefined && !generated.has(index)) return leaf;
    while (used.has(next)) next += 1;
    used.add(next);
    return leaf === undefined ? unclassified(next++) : { ...leaf, id: next++ };
  });
  return failures.map(item => item.class === "collateral" && item.originIds.some(id => !roots.has(id)) ? unclassified(item.id) : item);
}

/** Admission-only surfaces; a read-only observation of an allocated resource is not preflight. */
export function qualificationPreflightFailuresEffectFree(failures: readonly LaneFailure[]): boolean {
  return failures.every(item => (item.operation === "not_started" || item.operation === "read_only") &&
    (item.lane === "preflight" ||
      ((item.lane === "windows" || item.lane === "deviceCloud") && item.step === "preflight") ||
      (item.lane === "android" && item.step === "admission")));
}

export function qualificationRetryEligible(value: unknown, bindingsMatch: boolean): boolean {
  if (bindingsMatch !== true) return false;
  try {
    const summary = parseQualificationFailureSummary(value);
    return summary.containment.proven && summary.containment.cleanupComplete && !summary.containment.unresolvedMutation &&
      summary.failures.some(item => item.class === "infra_transient") &&
      summary.failures.every(item =>
        !(item.class === "infra_transient" && item.step === "cleanup") &&
        (item.class === "infra_transient" ? item.operation === "not_started" || item.operation === "read_only" :
          item.class === "collateral" && item.operation !== "unknown") &&
        item.observations.cleanupVerified !== false && item.observations.mutationReconciled !== false &&
        (item.observations.remainingResources ?? 0) === 0);
  } catch { return false; }
}
