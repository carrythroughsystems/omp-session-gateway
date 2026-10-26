import { describe, expect, test } from "bun:test";
import { DeviceCloudAvailabilityHold } from "./device-cloud-availability.ts";
import {
  FAILURE_LIMITS, QualificationFailure, normalizeQualificationFailures, parseLaneFailure,
  parseLaneFailures, parseLaneTimings, parseQualificationFailureSummary, qualificationRetryEligible,
  type LaneFailure, type QualificationFailureSummary,
} from "./qualification-failure.ts";

const root = (): LaneFailure => ({ id: 1, lane: "windows", step: "transport_ready", class: "infra_transient",
  reason: "connection_timeout", elapsedMs: 90_000, operation: "read_only", observations: { transportFailure: true } });
const collateral = (): LaneFailure => ({ id: 2, lane: "ompPublication", step: "cleanup", class: "collateral",
  reason: "dependency_failed", elapsedMs: 100, operation: "confirmed", observations: {}, originIds: [1] });
const summary = (): QualificationFailureSummary => ({ failures: [root(), collateral()], timings: { attemptMs: 100_000, cleanupMs: 1_000 },
  containment: { proven: true, cleanupComplete: true, unresolvedMutation: false } });
const secret = "SYNTHETIC_PRIVATE_FAILURE_SENTINEL";

describe("closed qualification failure contracts", () => {
  test("council R1 collateral cannot bind a generated availability ID", () => {
    const hold = new DeviceCloudAvailabilityHold({ kind: "device-cloud-availability", stage: "preflight", target: "iphone",
      vendors: ["testingbot"], reason: "pinned-pool-busy", waitedMs: 0 });
    for (const leaf of [hold, new Error("unknown")]) {
      const failures = normalizeQualificationFailures(new AggregateError([leaf, new QualificationFailure(collateral())]));
      expect(failures.some(item => item.class === "harness")).toBe(true);
      expect(qualificationRetryEligible({ ...summary(), failures }, true)).toBe(false);
    }
  });
  test("council R4 cleanup transports cannot authorize infrastructure recovery", () => {
    for (const lane of ["androidPushCleanup", "windowsCleanup", "deviceCloudCleanup", "cleanup"]) {
      expect(() => parseLaneFailure({ ...root(), lane, step: "containment" })).toThrow();
    }
  });
  test("council R4 negative containment and reconciliation observations block retry", () => {
    for (const observations of [{ cleanupVerified: false }, { mutationReconciled: false }, { remainingResources: 1 }]) {
      expect(qualificationRetryEligible({ ...summary(), failures: [{ ...root(), observations: { ...root().observations, ...observations } }] }, true)).toBe(false);
    }
  });
  test("council R4 push and outage mutations never acquire read-only retry authority", () => {
    for (const reason of ["push_service_failure", "device_outage", "tailnet_outage"]) {
      for (const operation of ["unknown", "confirmed"]) {
        const failure = { ...root(), lane: "androidPush", step: "network_verified", reason, operation,
          observations: { pushServiceFailure: true, retryableStatus: true, outageSpansWindow: true, deviceUnavailable: true, tailnetUnavailable: true } };
        expect(qualificationRetryEligible({ ...summary(), failures: [failure] }, true)).toBe(false);
      }
    }
  });
  test("round trips typed roots and collateral without widening their lane", () => {
    const value = summary();
    expect(parseQualificationFailureSummary(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(parseLaneTimings("windows", { transport_ready: 90_000 })).toEqual({ transport_ready: 90_000 });
    expect(() => parseLaneTimings("windows", { permission_verified: 1 })).toThrow();
  });
  test("typed errors validate their evidence and serialize neither cause nor stack", () => {
    const failure = new QualificationFailure(root(), { cause: new Error(secret) });
    expect(failure.cause).toBeInstanceOf(Error);
    expect(JSON.parse(JSON.stringify(failure))).toEqual(root());
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(() => new QualificationFailure({ ...root(), reason: secret } as never)).toThrow();
  });
  test.each([new Error("connection timeout"), new Error("python exited 143"), new Error("push timed out"), undefined, null, 143])(
    "unknown failures never acquire infrastructure authority (%#)", error => {
      expect(normalizeQualificationFailures(error)).toMatchObject([{ class: "harness", reason: "unclassified_failure" }]);
    },
  );
  test("ordinary causes and lookalike envelopes are not trusted wrappers", () => {
    const typed = new QualificationFailure(root());
    for (const error of [new Error(secret, { cause: typed }), { evidence: root() }, root()]) {
      expect(normalizeQualificationFailures(error)[0]?.class).toBe("harness");
    }
  });
  test("nested mixed aggregates preserve every independent typed and unknown leaf", () => {
    const product = parseLaneFailure({ ...root(), id: 3, class: "product", reason: "assertion_failed" });
    const result = normalizeQualificationFailures(new AggregateError([
      new QualificationFailure(root()), new AggregateError([new QualificationFailure(product), new Error(secret)]),
    ]));
    expect(result.map(item => item.class)).toEqual(["infra_transient", "product", "harness"]);
    expect(result.map(item => item.id)).toEqual([1, 3, 2]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  test("legacy availability wrappers require validation, not a legacy outcome envelope", () => {
    const hold = new DeviceCloudAvailabilityHold({ kind: "device-cloud-availability", stage: "preflight", target: "iphone",
      vendors: ["testingbot"], reason: "pinned-pool-busy", waitedMs: 0 });
    expect(normalizeQualificationFailures(hold)).toMatchObject([{ lane: "deviceCloud", class: "infra_transient",
      reason: "pinned_pool_busy", step: "preflight", operation: "not_started" }]);
    expect(normalizeQualificationFailures({ outcome: "infrastructure-hold", availabilityHolds: [hold.evidence] })[0]?.class).toBe("harness");
    Object.assign(hold.evidence, { host: secret });
    expect(normalizeQualificationFailures(hold)[0]?.class).toBe("harness");
  });
  test("malformed or cyclic aggregates and bounded overflow stop conservatively", () => {
    const cycle = new AggregateError([]); cycle.errors.push(cycle);
    let deep: unknown = new QualificationFailure(root());
    for (let index = 0; index <= FAILURE_LIMITS.depth; index += 1) deep = new AggregateError([deep]);
    const wide = new AggregateError(Array.from({ length: FAILURE_LIMITS.records + 1 }, () => new Error(secret)));
    for (const error of [cycle, deep, wide]) {
      expect(normalizeQualificationFailures(error)).toMatchObject([{ class: "harness", reason: "normalization_limit_exceeded" }]);
    }
    expect(normalizeQualificationFailures(new AggregateError([]))[0]?.reason).toBe("unclassified_failure");
  });
  test("record counts, durations, numeric observations and IDs are bounded", () => {
    for (const change of [{ id: 0 }, { id: 1.5 }, { id: 65_536 }, { elapsedMs: -1 }, { elapsedMs: Infinity },
      { elapsedMs: FAILURE_LIMITS.elapsedMs + 1 }, { observations: { attempts: NaN } }, { observations: { attempts: 1_001 } },
      { observations: { httpStatus: 600 } }, { observations: { transportFailure: 1 } }]) {
      expect(() => parseLaneFailure({ ...root(), ...change })).toThrow();
    }
    expect(() => parseLaneFailures([])).toThrow();
    expect(() => parseLaneFailures(Array.from({ length: FAILURE_LIMITS.records + 1 }, (_, index) => ({ ...root(), id: index + 1 })))).toThrow();
  });
  test("reason/class, step/lane and transport/disposition combinations are closed", () => {
    for (const change of [{ lane: "androidPush" }, { step: "permission_verified" }, { class: "product" },
      { operation: "confirmed" }, { observations: {} }, { reason: "raw_exit_143" }]) {
      expect(() => parseLaneFailure({ ...root(), ...change })).toThrow();
    }
    expect(() => parseLaneFailure({ ...root(), lane: "androidPush", step: "network_verified", reason: "delivery_timeout", class: "infra_transient" })).toThrow();
  });
  test("closed keys reject secrets and identifiers without echoing them", () => {
    for (const change of [{ detail: secret }, { cause: { message: secret } }, { host: "private.example.ts.net" },
      { observations: { [secret]: true } }, { observations: { transportFailure: secret } }, { reason: secret }, { step: secret }]) {
      let error: unknown;
      try { parseLaneFailure({ ...root(), ...change }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("private.example.ts.net");
    }
  });
  test("collateral must reference unique independent roots in this attempt", () => {
    for (const failures of [[collateral()], [root(), { ...collateral(), originIds: [99] }],
      [root(), { ...collateral(), originIds: [2] }], [root(), { ...collateral(), originIds: [1, 1] }],
      [root(), collateral(), { ...collateral(), id: 3, originIds: [2] }], [root(), root()]]) {
      expect(() => parseLaneFailures(failures)).toThrow();
    }
    expect(parseLaneFailures([root(), collateral()])).toHaveLength(2);
    expect(normalizeQualificationFailures(new QualificationFailure(collateral()))[0]?.class).toBe("harness");
  });
  test("normalization retains valid root IDs and never hides conflicting duplicates", () => {
    const result = normalizeQualificationFailures(new AggregateError([
      new QualificationFailure(root()), new QualificationFailure(root()), new QualificationFailure(collateral()),
    ]));
    expect(result.map(item => item.class)).toEqual(["infra_transient", "harness", "collateral"]);
    expect(new Set(result.map(item => item.id)).size).toBe(3);
  });
  test("retry requires all infrastructure roots, direct collateral references, containment and matching authority", () => {
    expect(qualificationRetryEligible(summary(), true)).toBe(true);
    expect(qualificationRetryEligible(summary(), false)).toBe(false);
    for (const change of [{ proven: false }, { cleanupComplete: false }, { unresolvedMutation: true }]) {
      expect(qualificationRetryEligible({ ...summary(), containment: { ...summary().containment, ...change } }, true)).toBe(false);
    }
    for (const failure of [{ ...root(), class: "product", reason: "assertion_failed" },
      { ...root(), class: "harness", reason: "unclassified_failure" }, { ...collateral(), operation: "unknown" }]) {
      expect(qualificationRetryEligible({ ...summary(), failures: [root(), { ...failure, id: 3 }] }, true)).toBe(false);
    }
    expect(qualificationRetryEligible(undefined, true)).toBe(false);
    expect(qualificationRetryEligible({ ...summary(), failures: [collateral()] }, true)).toBe(false);
  });
});
