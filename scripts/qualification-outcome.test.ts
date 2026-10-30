import { describe, expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OUTCOME_MAX_BYTES, parseQualificationExecution, parseQualificationOutcome, parseRigReadinessReceipt, qualificationOutcomeExitCode,
  readQualificationOutcomeFile, writeQualificationOutcomeFile, type QualificationExecution, type QualificationOutcome,
} from "./qualification-outcome.ts";
import { parseRetainedVendorJson } from "./device-cloud-record-json.ts";
import { FAILURE_STEPS, QualificationFailure } from "./qualification-failure.ts";
import { request } from "./windows-qualification-runtime.ts";
const privateTmpdir = realpathSync(tmpdir());

const execution = (): QualificationExecution => ({ formatVersion: 1, campaignAttempt: 0, binding: {
  candidateTag: "v0.9.0-prealpha.1", sourceCommit: "a".repeat(40), archiveSha256: "b".repeat(64),
  previousTag: "v0.8.0", orchestratorCommit: "c".repeat(40), policySha256: "d".repeat(64), macHostSha256: "e".repeat(64),
} });
const outcome = (): QualificationOutcome => ({ formatVersion: 1, outcome: "qualification-failed", scope: "campaign", execution: execution(),
  failureSummary: { failures: [{ id: 1, lane: "windows", step: "transport_ready", class: "infra_transient", reason: "connection_timeout",
    elapsedMs: 90_000, operation: "read_only", observations: { transportFailure: true } }],
  timings: { attemptMs: 100_000, cleanupMs: 1_000 }, containment: { proven: true, cleanupComplete: true, unresolvedMutation: false } },
  receipt: { sha256: "f".repeat(64), cleanupDisposition: "restored" } });

describe("general qualification machine outcome", () => {
  test.skipIf(process.platform === "win32")("council498r1 actual Windows admission GET503 produces receiptless retry evidence", async () => {
    const root = await mkdtemp(join(privateTmpdir, "windows-admission-outcome-"));
    const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      async () => Response.json({ synthetic: true }, { status: 503 }), { preconnect: () => {} }));
    try {
      const failure = await request("https://synthetic.invalid", {}, "GET", undefined,
        { signal: new AbortController().signal, deadline: performance.now() + 40_000, nextFailureId: () => 1 }).catch(error => error);
      expect(failure).toBeInstanceOf(QualificationFailure);
      if (!(failure instanceof QualificationFailure)) throw new Error("expected typed Windows admission failure");
      expect(failure.evidence).toMatchObject({ step: "connection", reason: "retryable_service_failure", operation: "read_only" });
      const { receipt: _receipt, ...without } = outcome();
      const value = { ...without, scope: "preflight" as const,
        failureSummary: { ...without.failureSummary, failures: [failure.evidence] } };
      const path = join(root, "preflight-outcome.json");
      await writeQualificationOutcomeFile(path, value);
      const saved = await readQualificationOutcomeFile(path, execution());
      expect(saved.receipt).toBeUndefined();
      expect(qualificationOutcomeExitCode(saved, execution())).toBe(75);
    } finally { transport.mockRestore(); await rm(root, { recursive: true, force: true }); }
  }, 45_000);
  test.each([
    ["restored", false], ["restored", undefined], ["unresolved", true], ["not_required", false],
  ] as const)("council P2 readiness %s cannot contradict baseline %s", (cleanupDisposition, baselineRestored) => {
    expect(() => parseRigReadinessReceipt({ status: "failed", campaignAttempt: 0, observations:
      baselineRestored === undefined ? {} : { baselineRestored }, timings: {}, cleanupDisposition })).toThrow();
  });
  test("council P2 preflight scope cannot launder post-allocation observations", () => {
    const value = outcome();
    for (const step of ["instance_created", "transport_ready", "candidate_upgraded"]) {
      const preflight = { ...value, scope: "preflight", failureSummary: { ...value.failureSummary,
        failures: [{ ...value.failureSummary.failures[0]!, step }] } };
      expect(qualificationOutcomeExitCode(preflight, execution())).toBe(1);
    }
  });
  test.each(["restored", "not_required", "unresolved"] as const)("council P2 cleanup disposition %s must agree with containment", cleanupDisposition => {
    const value = outcome();
    const containment = cleanupDisposition === "unresolved" ? value.failureSummary.containment :
      { proven: false, cleanupComplete: false, unresolvedMutation: true };
    expect(() => parseQualificationOutcome({ ...value, receipt: { ...value.receipt, cleanupDisposition },
      failureSummary: { ...value.failureSummary, containment } })).toThrow();
  });
  test("readiness allowances, counts and durations are integers", () => {
    for (const observations of [{ quotaObservable: true, quotaAvailable: 1.5 }, { creationAllowance: 1.5 },
      { deliveryMs: 1.5 }, { clearMs: 1.5 }]) {
      expect(() => parseRigReadinessReceipt({ status: "failed", campaignAttempt: 0, observations: { baselineRestored: true, ...observations },
        timings: {}, cleanupDisposition: "restored" })).toThrow();
    }
  });
  test("readiness delivery observations are finite bounded integer counts", () => {
    const base = { status: "failed", campaignAttempt: 0, timings: {}, cleanupDisposition: "restored" };
    expect(parseRigReadinessReceipt({ ...base, observations: { baselineRestored: true, subscriptionCount: 2, sendCount: 4, ackCount: 4 } })
      .observations).toMatchObject({ subscriptionCount: 2, sendCount: 4, ackCount: 4 });
    for (const key of ["subscriptionCount", "sendCount", "ackCount"]) {
      for (const value of [-1, 1.5, Infinity, NaN, 16_385]) {
        expect(() => parseRigReadinessReceipt({ ...base, observations: { baselineRestored: true, [key]: value } })).toThrow();
      }
    }
  });
  test("506 council passed readiness requires positive matching counts and presentation/clear proofs", () => {
    const observations: Record<string, boolean | number> = { baselineRestored: true, pixelReachable: true, pushSent: true,
      pushAcknowledged: true, pushPresented: true, pushCleared: true, subscriptionCount: 1, sendCount: 2, ackCount: 2,
      deliveryMs: 1, clearMs: 2 };
    const base = { status: "passed", campaignAttempt: 0, timings: {}, cleanupDisposition: "restored" };
    expect(parseRigReadinessReceipt({ ...base, observations }).status).toBe("passed");
    for (const key of ["deliveryMs", "clearMs"]) {
      expect(() => parseRigReadinessReceipt({ ...base, observations: { ...observations, [key]: 1.5 } })).toThrow();
    }
    for (const key of ["subscriptionCount", "sendCount", "ackCount", "pixelReachable", "pushSent", "pushAcknowledged", "pushPresented", "pushCleared"]) {
      const missing = { ...observations };
      delete missing[key];
      expect(() => parseRigReadinessReceipt({ ...base, observations: missing })).toThrow();
      expect(() => parseRigReadinessReceipt({ ...base, observations: { ...observations, [key]: key.endsWith("Count") ? 0 : false } })).toThrow();
    }
    expect(() => parseRigReadinessReceipt({ ...base, observations: { ...observations, ackCount: 1 } })).toThrow();
  });
  test("schema-3 GCM observations are an optional boolean pair, never a disconnected passing proof", () => {
    const observations = { baselineRestored: true, pixelReachable: true, pushSent: true, pushAcknowledged: true,
      pushPresented: true, pushCleared: true, subscriptionCount: 1, sendCount: 1, ackCount: 1 };
    const base = { status: "passed", campaignAttempt: 0, timings: {}, cleanupDisposition: "restored", observations };
    expect(parseRigReadinessReceipt(base).observations).toEqual(observations);
    for (const gcmRemedyApplied of [false, true]) {
      expect(parseRigReadinessReceipt({ ...base, observations: { ...observations, gcmConnected: true, gcmRemedyApplied } })
        .observations).toMatchObject({ gcmConnected: true, gcmRemedyApplied });
    }
    for (const fields of [{ gcmConnected: true }, { gcmRemedyApplied: false },
      { gcmConnected: 1, gcmRemedyApplied: false }, { gcmConnected: true, gcmRemedyApplied: "false" },
      { gcmConnected: false, gcmRemedyApplied: true }]) {
      expect(() => parseRigReadinessReceipt({ ...base, observations: { ...observations, ...fields } })).toThrow();
    }
    expect(parseRigReadinessReceipt({ ...base, status: "failed",
      observations: { ...observations, gcmConnected: false, gcmRemedyApplied: true } }).status).toBe("failed");
  });
  test("council U1 complete outcomes reject duplicate and escaped-equivalent keys through portable parsing and POSIX file reads", async () => {
    const root = process.platform === "win32" ? undefined : await mkdtemp(join(privateTmpdir, "qualification-duplicate-"));
    try {
      const valid = JSON.stringify(outcome());
      expect(parseQualificationOutcome(parseRetainedVendorJson(valid), execution())).toEqual(outcome());
      for (const text of [
        valid.replace('"formatVersion":1', '"formatVersion":1,"formatVersion":1'),
        valid.replace('"formatVersion":1', '"formatVersion":1,"format\\u0056ersion":1'),
        valid.replace('"campaignAttempt":0', '"campaignAttempt":0,"campaignAttempt":0'),
        valid.replace('"campaignAttempt":0', '"campaignAttempt":0,"campaign\\u0041ttempt":0'),
        valid.replace('"proven":true', '"proven":true,"proven":true'),
      ]) {
        // Native decoding gives the exact valid fixture; only duplicate-member preservation differs.
        expect(JSON.parse(text)).toEqual(outcome());
        expect(() => parseQualificationOutcome(parseRetainedVendorJson(text), execution())).toThrow();
        if (root !== undefined) {
          const path = join(root, "outcome.json");
          await writeFile(path, text, { mode: 0o600 });
          await expect(readQualificationOutcomeFile(path, execution())).rejects.toThrow();
        }
      }
    } finally { if (root !== undefined) await rm(root, { recursive: true, force: true }); }
  });
  // Persistence belongs to the POSIX Studio driver; Windows exercises the explicit refusal below.
  test.skipIf(process.platform === "win32")("council P2 existing private leaves below symlinked ancestors are refused", async () => {
    const root = await mkdtemp(join(privateTmpdir, "qualification-ancestor-"));
    const actual = join(root, "actual"), alias = join(root, "alias"), parent = join(actual, "job");
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await symlink(actual, alias);
      await writeQualificationOutcomeFile(join(parent, "outcome.json"), outcome());
      await expect(readQualificationOutcomeFile(join(alias, "job", "outcome.json"))).rejects.toThrow();
      await expect(writeQualificationOutcomeFile(join(alias, "job", "outcome.json"), outcome())).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform === "win32")("council P2 a file that grows during bounded reading is refused", async () => {
    const root = await mkdtemp(join(privateTmpdir, "qualification-size-change-")), path = join(root, "outcome.json");
    await writeQualificationOutcomeFile(path, outcome());
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read(buffer: Uint8Array, offset: number, length: number, position: null): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    };
    const originalRead = prototype.read;
    let changed = false;
    const reading = spyOn(prototype, "read").mockImplementation(async function (this: typeof prototype, buffer, offset, length, position) {
      const result = await originalRead.call(this, buffer, offset, length, position);
      if (!changed) { changed = true; await appendFile(path, " "); }
      return result;
    });
    try {
      await expect(readQualificationOutcomeFile(path)).rejects.toThrow();
      expect(changed).toBe(true);
    } finally { reading.mockRestore(); await probe.close(); await rm(root, { recursive: true, force: true }); }
  });
  test("readiness owner epoch and phase round trip together through every closed phase", () => {
    for (const phase of FAILURE_STEPS.rigReadiness) {
      const readiness = { status: "running", campaignAttempt: 0, observations: {}, timings: {},
        cleanupDisposition: "unresolved", epoch: "0b8a2f64-3c1d-4e5f-9a7b-2c4d6e8f0a1b", phase } as const;
      expect(parseRigReadinessReceipt(JSON.parse(JSON.stringify(readiness)))).toEqual(readiness);
    }
  });
  test("readiness without an owner pair remains readable", () => {
    const readiness = { status: "pending", campaignAttempt: 0, observations: {}, timings: {}, cleanupDisposition: "not_required" } as const;
    expect(parseRigReadinessReceipt(readiness)).toEqual(readiness);
  });
  test("readiness owner pairs reject incomplete, foreign, malformed and secret values without echo", () => {
    const readiness = { status: "running", campaignAttempt: 0, observations: {}, timings: {}, cleanupDisposition: "unresolved" };
    const epoch = "0b8a2f64-3c1d-4e5f-9a7b-2c4d6e8f0a1b";
    for (const pair of [{ epoch }, { phase: "fixture" }, { epoch, phase: undefined }, { epoch: undefined, phase: "fixture" },
      { epoch: epoch.toUpperCase(), phase: "fixture" }, { epoch: epoch.replace("-4e5f-", "-1e5f-"), phase: "fixture" },
      { epoch: "../SYNTHETIC_PRIVATE_OWNER", phase: "fixture" }, { epoch: "private.example.ts.net", phase: "fixture" },
      { epoch, phase: "transport_ready" }, { epoch, phase: "SYNTHETIC_PRIVATE_OWNER" },
      { epoch, phase: "fixture", owner: "SYNTHETIC_PRIVATE_OWNER" }]) {
      let error: unknown;
      try { parseRigReadinessReceipt({ ...readiness, ...pair }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_OWNER");
      expect(String(error)).not.toContain("private.example.ts.net");
    }
  });
  test("JSON round trip keeps exact attempt and authority bindings", () => {
    const value = outcome();
    expect(parseQualificationOutcome(JSON.parse(JSON.stringify(value)), execution())).toEqual(value);
    expect(qualificationOutcomeExitCode(value, execution())).toBe(75);
    const retry = { ...execution(), campaignAttempt: 1 as const, retryPlanSha256: "1".repeat(64) };
    expect(parseQualificationExecution(retry)).toEqual(retry);
  });
  test("every foreign binding and retry-plan identity is refused", () => {
    const value = outcome();
    for (const key of Object.keys(value.execution.binding)) {
      const expected = execution();
      Object.assign(expected.binding, { [key]: key.endsWith("Tag") ? "v1.0.0" : "1".repeat(key.endsWith("Commit") ? 40 : 64) });
      expect(() => parseQualificationOutcome(value, expected)).toThrow();
      expect(qualificationOutcomeExitCode(value, expected)).toBe(1);
    }
    expect(() => parseQualificationOutcome(value, { ...execution(), campaignAttempt: 1, retryPlanSha256: "1".repeat(64) })).toThrow();
  });
  test("attempt bounds and plan presence cannot silently add retry authority", () => {
    for (const change of [{ campaignAttempt: -1 }, { campaignAttempt: 3 }, { campaignAttempt: 0.5 },
      { campaignAttempt: 1 }, { retryPlanSha256: "1".repeat(64) }, { formatVersion: 2 }]) {
      expect(() => parseQualificationExecution({ ...execution(), ...change })).toThrow();
    }
  });
  test("legacy, malformed, open and identifier-bearing outcomes fail closed without echo", () => {
    const secret = "SYNTHETIC_OUTCOME_SECRET_SENTINEL";
    for (const value of [null, {}, { outcome: "infrastructure-hold", availabilityHolds: [] }, { ...outcome(), formatVersion: 2 },
      { ...outcome(), detail: secret }, { ...outcome(), error: new Error(secret) }, { ...outcome(), receipt: { ...outcome().receipt, path: secret } },
      { ...outcome(), execution: { ...execution(), binding: { ...execution().binding, macHost: secret } } },
      { ...outcome(), failureSummary: { ...outcome().failureSummary, observations: { [secret]: true } } }]) {
      let error: unknown;
      try { parseQualificationOutcome(value); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
      expect(qualificationOutcomeExitCode(value, execution())).toBe(1);
    }
  });
  test("receipt absence only permits effects-free preflight failures", () => {
    const { receipt: _receipt, ...without } = outcome();
    expect(() => parseQualificationOutcome(without)).toThrow();
    const preflight = { ...without, scope: "preflight", failureSummary: { ...without.failureSummary,
      failures: [{ ...without.failureSummary.failures[0]!, lane: "preflight", step: "windows" }] } };
    expect(parseQualificationOutcome(preflight).receipt).toBeUndefined();
    expect(qualificationOutcomeExitCode(preflight, execution())).toBe(75);
    expect(() => parseQualificationOutcome({ ...preflight, failureSummary: { ...preflight.failureSummary,
      failures: [{ ...preflight.failureSummary.failures[0], class: "harness", reason: "unclassified_failure", operation: "confirmed" }] } })).toThrow();
  });
  test("exit status never upgrades mixed, unresolved or uncontained evidence", () => {
    const value = outcome();
    expect(qualificationOutcomeExitCode({ ...value, receipt: { ...value.receipt, cleanupDisposition: "unresolved" } }, execution())).toBe(1);
    expect(qualificationOutcomeExitCode({ ...value, failureSummary: { ...value.failureSummary,
      failures: [{ ...value.failureSummary.failures[0], class: "product", reason: "assertion_failed" }] } }, execution())).toBe(1);
    expect(qualificationOutcomeExitCode(value, undefined)).toBe(1);
  });
  // These filesystem assertions require POSIX ownership, modes, no-follow opens and directory sync.
  test.skipIf(process.platform === "win32")("atomic private publication round trips, replaces safely, and leaves no temporary file", async () => {
    const root = await mkdtemp(join(privateTmpdir, "qualification-outcome-"));
    const path = join(root, "job", "outcome.json");
    try {
      await writeQualificationOutcomeFile(path, outcome());
      expect(await readQualificationOutcomeFile(path, execution())).toEqual(outcome());
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "job"))).mode & 0o777).toBe(0o700);
      await writeQualificationOutcomeFile(path, outcome());
      expect(await readdir(join(root, "job"))).toEqual(["outcome.json"]);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(outcome());
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform === "win32")("missing, oversized, duplicate-key and non-private files are refused", async () => {
    const root = await mkdtemp(join(privateTmpdir, "qualification-outcome-invalid-"));
    const path = join(root, "outcome.json");
    try {
      await expect(readQualificationOutcomeFile(path)).rejects.toThrow("qualification outcome file");
      for (const text of ["", " ".repeat(OUTCOME_MAX_BYTES + 1), '{"outcome":"SYNTHETIC_SECRET","outcome":"qualification-failed"}', "{"]) {
        await writeFile(path, text, { mode: 0o600 });
        const error = await readQualificationOutcomeFile(path).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain("SYNTHETIC_SECRET");
      }
      await writeFile(path, JSON.stringify(outcome()));
      await chmod(path, 0o644);
      await expect(readQualificationOutcomeFile(path)).rejects.toThrow();
      await expect(writeQualificationOutcomeFile(path, outcome())).rejects.toThrow();
      expect(await readdir(root)).toEqual(["outcome.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform === "win32")("symlink destinations and non-private parents are not followed or repaired", async () => {
    const root = await mkdtemp(join(privateTmpdir, "qualification-outcome-links-"));
    const target = join(root, "target.json"), path = join(root, "outcome.json");
    try {
      await writeFile(target, "preserve", { mode: 0o600 });
      await symlink(target, path);
      await expect(writeQualificationOutcomeFile(path, outcome())).rejects.toThrow();
      await expect(readQualificationOutcomeFile(path)).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("preserve");
      await rm(path);
      await chmod(root, 0o755);
      await expect(writeQualificationOutcomeFile(path, outcome())).rejects.toThrow();
      await chmod(root, 0o700);
      const alias = join(root, "alias"); await symlink(root, alias);
      await expect(writeQualificationOutcomeFile(join(alias, "job", "outcome.json"), outcome())).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform === "win32")("invalid writes preserve the previous outcome and withhold native path diagnostics", async () => {
    const root = await mkdtemp(join(privateTmpdir, "qualification-outcome-errors-"));
    const path = join(root, "outcome.json");
    try {
      await writeQualificationOutcomeFile(path, outcome());
      await expect(writeQualificationOutcomeFile(path, { ...outcome(), secret: "SYNTHETIC_SECRET" } as never)).rejects.toThrow();
      expect(await readQualificationOutcomeFile(path)).toEqual(outcome());
      const error = await writeQualificationOutcomeFile(join(path, "child.json"), outcome()).catch((error: unknown) => error);
      expect(String(error)).not.toContain(root);
      expect(String(error)).toContain("qualification outcome file");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform !== "win32")("Windows refuses outcome persistence before filesystem effects", async () => {
    const root = await mkdtemp(join(privateTmpdir, "qualification-outcome-unsupported-"));
    const path = join(root, "job", "outcome.json");
    try {
      const message = "qualification outcome persistence requires a POSIX host";
      await expect(writeQualificationOutcomeFile(path, outcome())).rejects.toThrow(message);
      await expect(readQualificationOutcomeFile(path, execution())).rejects.toThrow(message);
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
