import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


test("local and API control fingerprints normalize the same source framing", async () => {
  const text = 'export const PRODUCT_VERSION = "0.7.5";\n';
  class Controls extends StudioDriver {
    override async git(args: string[]) { return args[0] === "ls-tree" ? "100644 blob abc\tscripts/build-release.ts" : text.trim(); }
    override async api<T>(path: string): Promise<T | undefined> {
      return (path.startsWith("git/trees/") ? { truncated: false, tree: [{ mode: "100644", type: "blob", sha: "abc", path: "scripts/build-release.ts" }] }
        : { content: Buffer.from(text).toString("base64") }) as T;
    }
  }
  const runtime = new Controls(driverConfig(), true);
  expect(await runtime.controls("source", true)).toEqual(await runtime.controls("source"));
});

test("routine merge accepted before crash reconciles without another merge or tag", async () => {
  const fake = new FakeDriver();
  fake.state = { ...state("approval-required"), approvedHead: evidence.head, approvedTree: evidence.tree, candidateCommit: evidence.candidateCommit, candidateDigest: evidence.candidateDigest, approvePr: 401 };
  fake.repo.approve = pr(); fake.failSave = 2;
  await expect(tick(fake, config)).rejects.toThrow("simulated crash");
  expect(fake.state.intent?.operation).toBe("merge-approve");
  expect(fake.repo.approve.merged).toBe(true);
  expect((await tick(fake, config)).operation).toBe("merge-approve");
  expect(fake.performed.filter(op => op === "merge-approve")).toHaveLength(1);
  expect(fake.state.stableCommit).toBe("2".repeat(40));
});
test("changed authority during effect replay becomes a durable typed hold and reconciled outbox", async () => {
  class ChangedAuthority extends FakeDriver {
    override async perform(): Promise<Partial<DriverState>> { throw new RoutineHoldError("policy-changed"); }
  }
  const fake = new ChangedAuthority(); fake.state = state();
  expect((await tick(fake, config)).holdReason).toBe("policy-changed");
  expect(fake.state.holdReason).toBe("policy-changed");
  expect(fake.state.intent).toBeUndefined();
  expect((await tick(fake, config)).operation).toBe("idle");
  expect(fake.comments.size).toBe(1);
});
test("only a vanished same-subject local approve job resumes; campaign and smoke remain diagnostic", () => {
  const checking = { ...state("approve-checking"), approvedHead: evidence.head, approvedTree: evidence.tree };
  expect(nextStep(checking, snapshot({ approve: pr(), approveChecks: { status: "absent" } }), config).operation).toBe("start-approve-checks");
  expect(nextStep(checking, snapshot({ approve: pr({ head: "d".repeat(40) }), approveChecks: { status: "absent" } }), config).holdReason).toBe("head-tree-changed");
  for (const phase of ["qualifying", "smoking"] as const) expect(nextStep(state(phase), snapshot({ campaign: { status: "absent" }, smoke: { status: "absent" } }), config).operation).toBe("stop");
});
test("GitHub credential expiry is reported without persisting raw credential headers", () => {
  expect(credentialExpiry("x-oauth-scopes: repo")).toEqual({ status: "unknown" });
  expect(credentialExpiry("GitHub-Authentication-Token-Expiration: 2026-10-10 00:00:00 UTC", Date.parse("2026-10-09"))).toEqual({ status: "valid", expiresAt: "2026-10-10T00:00:00.000Z" });
  expect(credentialExpiry("github-authentication-token-expiration: 2026-10-08", Date.parse("2026-10-09")).status).toBe("expired");
});
test("routine controls normalize generated versions but retain policy and dependency changes", async () => {
  class Controls extends StudioDriver {
    override async git(args: string[]) {
      if (args[0] === "ls-tree") return ["100644 blob a\tpackage.json", "100644 blob b\tbun.lock", "100644 blob c\tscripts/build-release.ts", "100644 blob d\t.github/workflows/signed-release.yml"].join("\n");
      const version = args[1]!.startsWith("old:") ? "0.7.5" : "0.7.6";
      if (args[1]!.endsWith(":package.json")) return JSON.stringify({ version, scripts: { check: "bun test" } });
      if (args[1]!.endsWith(":bun.lock")) return '{\n    "apps/gateway": {\n      "name": "gateway",\n      "version": "' + version + '",\n    },\n}';
      return 'export const PRODUCT_VERSION = "' + version + '";';
    }
  }
  const runtime = new Controls(driverConfig(), true);
  expect(await runtime.controls("old", true)).toEqual(await runtime.controls("new", true));
});

import { botEnvironment, campaignAvailabilityObservation, credentialExpiry, driverConfig, StudioDriver } from "./release-driver-runtime.ts";
import { campaignAttempt, compareVersions, isOrder, nextCandidate, nextStep, ORDER_SCOPE, outsideOrderScope, parseCampaignInfrastructureHold, REPOSITORY, selectRequest, StaleIntentError, tick } from "./release-driver.ts";
import type { CampaignInfrastructureHold, Decision, DriverPort, DriverState, JobObservation, Operation, PullRequest, RepositorySnapshot, TrackingIssue } from "./release-driver.ts";
import { createStableQualificationReceipt } from "./stable-qualification.ts";
import type { ExternalLaneModule, StableQualificationLaneModules, StableQualificationReceipt } from "./stable-qualification.ts";
import { readDeviceCloudOutcomeFile, writeDeviceCloudOutcomeFile } from "./device-cloud-outcome.ts";

import { REQUIRED_CHECKS, ROUTINE_EVIDENCE_STEPS, RoutineHoldError } from "./release-policy.ts";
const authority = { policy: "policy-1", protectedChanges: [], sourceReviewed: true, sourceFresh: true, patchRelease: true };
const evidence = { head: "b".repeat(40), tree: "c".repeat(40), candidate: "v0.7.5-prealpha.1", candidateCommit: "e".repeat(40), candidateDigest: "f".repeat(64), policy: authority.policy, steps: ROUTINE_EVIDENCE_STEPS };
const config = { bot: "alphastorm-release", founder: "alphastorm" };
const issue: TrackingIssue = { number: 400, title: "Upstream tracking: v18.8.3", author: "github-actions[bot]", request: "42:1", url: "https://github.com/carrythroughsystems/omp-session-gateway/issues/400" };
function state(phase: DriverState["phase"] = "selected"): DriverState {
  return { schemaVersion: 1, sequence: 1, phase, issue: { ...issue }, version: "0.7.5", candidate: "v0.7.5-prealpha.1", selectedMain: "a".repeat(40), previousStable: "v0.7.4", authorityPolicy: authority.policy, date: "2026-10-07" };
}
function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return { number: 401, author: config.bot, authorType: "User", headRepository: REPOSITORY, base: "main", headRef: "release-driver/400/v0.7.5-prealpha.1-approve", head: "b".repeat(40), tree: "c".repeat(40), draft: false, state: "open", merged: false, mergeVerified: true, behind: false, checksPassed: true, files: [], url: "https://github.com/carrythroughsystems/omp-session-gateway/pull/401", ...overrides };
}
function order(overrides: Partial<PullRequest> = {}): PullRequest {
  return pr({ author: "carrythroughsystems[bot]", authorType: "Bot", headRef: "carrythrough/order-400", draft: true, files: ORDER_SCOPE.map(filename => ({ filename })), ...overrides });
}
function snapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return { main: "a".repeat(40), upstreamTag: "v18.8.3", latestStable: "v0.7.4", tags: ["v0.7.4", "v0.7.4-prealpha.1"], issues: [{ ...issue }], authority, evidence, ...overrides };
}
class FakeDriver implements DriverPort {
  state: DriverState | undefined;
  repo = snapshot();
  effects = new Map<string, Partial<DriverState>>();
  prepareSources: string[] = [];
  comments = new Map<string, string>();
  saves = 0;
  failSave = 0;
  crashAfterComment = false;
  commentWrites = 0;
  performed: Operation[] = [];
  async load() { return structuredClone(this.state); }
  async save(next: DriverState) {
    this.saves++;
    if (this.saves === this.failSave) throw new Error("simulated crash before state save");
    this.state = structuredClone(next);
  }
  async snapshot() { return structuredClone(this.repo); }
  async perform(step: Decision, current: DriverState) {
    const key = `${current.candidate}:${step.operation}`;
    const existing = this.effects.get(key);
    if (existing !== undefined) return existing;
    this.performed.push(step.operation);
    let patch: Partial<DriverState> = {};
    switch (step.operation) {
      case "update-order": this.repo.order!.behind = false; this.repo.order!.head = "d".repeat(40); break;
      case "ready-order": this.repo.order!.draft = false; break;
      case "merge-order": this.repo.upstreamTag = "v18.8.3"; this.repo.main = "9".repeat(40); break;
      case "open-prepare": this.prepareSources.push(current.selectedMain); this.repo.prepare = pr({ number: 402 }); patch = { preparePr: 402, authorityPolicy: authority.policy }; break;
      case "merge-prepare": patch = { candidateCommit: "e".repeat(40) }; break;
      case "tag-candidate": this.repo.candidateWorkflow = "passed"; break;
      case "verify-candidate": patch = { candidateDigest: "f".repeat(64) }; break;
      case "start-campaign": this.repo.campaign = { status: "passed" }; break;
      case "open-approve": this.repo.approve = pr(); patch = { approvePr: 401 }; break;
      case "start-approve-checks": this.repo.approveChecks = { status: "passed" }; break;
      case "merge-approve": Object.assign(this.repo.approve!, { state: "closed", merged: true, mergedBy: config.bot, mergeTree: current.approvedTree, mergeCommit: "2".repeat(40) }); patch = { stableCommit: "2".repeat(40) }; break;
      case "tag-stable": this.repo.stableWorkflow = "passed"; break;
      case "verify-stable": patch = { stableDigest: "1".repeat(64) }; break;
      case "start-smoke": this.repo.smoke = { status: "passed" }; break;
      case "open-record": this.repo.record = pr({ number: 403 }); patch = { recordPr: 403 }; break;
      case "close": this.repo.issues = []; break;
    }
    this.effects.set(key, patch);
    return patch;
  }
  async announce(_issue: number, body: string, marker: string) {
    if (!this.comments.has(marker)) { this.comments.set(marker, body); this.commentWrites++; }
    if (this.crashAfterComment) { this.crashAfterComment = false; throw new Error("simulated accepted comment then crash"); }
  }
}


describe("review remediations", () => {
  test.each(["prepare", "record"])("R1 rejects protected generated %s bytes even on accepted-merge replay", async kind => {
    const current = pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-" + kind, merged: true, mergedBy: config.bot,
      files: [{ filename: "docs/RELEASE_STATUS.md", previous_filename: "scripts/release-policy.ts" }] });
    class Runtime extends StudioDriver {
      override async readPr() { return current; }
      override async controls() { return new Map<string, string>(); }
    }
    await expect(new Runtime(driverConfig(), false).merge(current, false)).rejects.toThrow("generated-content-mismatch");
  });
  test("R1 generated version exception admits equal controls and refuses changed executable controls", async () => {
    const current = pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-prepare", merged: true, mergedBy: config.bot,
      files: [{ filename: "scripts/build-release.ts" }, { filename: "package.json" }, { filename: "bun.lock" }] });
    class Runtime extends StudioDriver {
      changed = false;
      override async readPr() { return current; }
      override async git() { return "installed"; }
      override async controls(_source: string, local = false) { return new Map([["scripts/build-release.ts", local || !this.changed ? "unchanged" : "executable-edit"]]); }
    }
    const runtime = new Runtime(driverConfig(), false);
    expect(await runtime.merge(current, false)).toEqual(current);
    runtime.changed = true;
    await expect(runtime.merge(current, false)).rejects.toThrow("generated-content-mismatch");
  });
  test.each([{ author: "foreign", verified: true }, { author: config.bot, verified: false }])("R1 refuses foreign or unsigned existing PR checkpoints %j", async identity => {
    class Runtime extends StudioDriver {
      override async pages<T>(): Promise<T[]> { return [{ number: 401 }] as T[]; }
      override async readPr() { return pr(); }
      override async api<T>(): Promise<T | undefined> { return { author: { login: identity.author }, commit: { verification: { verified: identity.verified } } } as T; }
    }
    await expect(new Runtime(driverConfig(), false).openPr("approve", state())).rejects.toThrow("pr-identity-changed");
  });
  test("R1 refuses an unsigned remote branch before creating its checkout", async () => {
    class Runtime extends StudioDriver {
      override async pages<T>(): Promise<T[]> { return []; }
      override async api<T>(path: string): Promise<T | undefined> {
        return (path.startsWith("git/ref/") ? { object: { sha: "b".repeat(40) } }
          : { author: { login: config.bot }, commit: { verification: { verified: false } } }) as T;
      }
      override async checkout(): Promise<string> { throw new Error("unsafe checkpoint reached checkout"); }
    }
    await expect(new Runtime(driverConfig(), false).openPr("prepare", state())).rejects.toThrow("pr-identity-changed");
  });
  class SourceRuntime extends StudioDriver {
    title = "fix(gateway): mutable title";
    subject = "feat(gateway): immutable feature";
    sourcePr = pr({ merged: true, mergedBy: config.founder, mergeCommit: "a".repeat(40) });
    dirty = false;
    override async controls() { return new Map<string, string>(); }
    override async git(args: string[]) {
      if (args[0] === "rev-parse") return "installed";
      if (args[0] === "status") return this.dirty && !args.includes("--untracked-files=no") ? "?? .env" : "";
      throw new Error("unexpected git read");
    }
    override async pages<T>(): Promise<T[]> { return [{ number: 401 }] as T[]; }
    override async readPr() { return this.sourcePr; }
    override async api<T>(path: string): Promise<T | undefined> {
      if (path === "branches/main") return { protected: true, protection: { enabled: true, required_status_checks: { contexts: [...REQUIRED_CHECKS], enforcement_level: "everyone" } } } as T;
      if (path.startsWith("compare/")) return { status: "ahead", total_commits: 1, commits: [{ sha: "a".repeat(40) }] } as T;
      if (path.startsWith("git/commits/")) return { message: this.subject } as T;
      if (path === "pulls/401") return { merged: true, base: { ref: "main" }, merge_commit_sha: "a".repeat(40), merged_by: { login: this.sourcePr.mergedBy }, title: this.title } as T;
      throw new Error("unexpected API read " + path);
    }
  }
  test("R2 ignores a mutable fix title when immutable merge subject is out of class", async () => {
    const runtime = new SourceRuntime(driverConfig(), true);
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
    runtime.title = "feat(gateway): title edited after merge"; runtime.subject = "fix(gateway): immutable reviewed fix";
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(true);
  });
  test("R1 release-record classification refuses files outside generator output", async () => {
    const runtime = new SourceRuntime(driverConfig(), true);
    runtime.title = runtime.subject = "docs(release): record v0.7.5";
    runtime.sourcePr = pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-record", merged: true, mergedBy: config.bot,
      files: [{ filename: "apps/gateway/src/doctor.ts" }] });
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
  });
  test("U2 untracked non-ignored runtime inputs make installed policy dirty", async () => {
    const runtime = new SourceRuntime(driverConfig(), true); runtime.dirty = true;
    expect((await runtime.authority(state(), state().selectedMain)).protectedChanges).toContain("installed-checkout-dirty");
  });
  test("R3 fingerprints package lifecycle scripts at arbitrary depth", async () => {
    class Runtime extends StudioDriver {
      override async git(args: string[]) {
        if (args[0] === "ls-tree") return "100644 blob a\ttools/fixtures/nested/package.json";
        return JSON.stringify({ version: args[1]!.startsWith("next:") ? "2.0.0" : "1.0.0", scripts: { postinstall: args[1]!.startsWith("changed:") ? "changed" : "original" } });
      }
    }
    const runtime = new Runtime(driverConfig(), true);
    const first = await runtime.controls("old", true);
    expect(first.has("tools/fixtures/nested/package.json")).toBe(true);
    expect(first).toEqual(await runtime.controls("next", true));
    expect(first).not.toEqual(await runtime.controls("changed", true));
  });
  test("R4 installation instructions quiesce and drain before checkout mutation", async () => {
    const doc = await Bun.file(new URL("../docs/RELEASE.md", import.meta.url)).text();
    const instructions = doc.split("### Studio installation (run as gwops after integration)")[1]!.split("### Readiness")[0]!;
    const fetch = instructions.indexOf("git fetch origin main");
    expect(instructions.indexOf("\ntouch ")).toBeGreaterThan(0);
    expect(instructions.indexOf("\ntouch ")).toBeLessThan(fetch);
    expect(instructions.indexOf('launchctl bootout "gui/$(id -u)/com.omp.gateway-release-driver"')).toBeLessThan(fetch);
    expect(instructions.indexOf("Confirm no driver tick/worker or tmux job remains")).toBeGreaterThan(0);
    expect(instructions.indexOf("Confirm no driver tick/worker or tmux job remains")).toBeLessThan(fetch);
  });
  test("U1 documents squash-only fix admission and names held source commits", async () => {
    const doc = await Bun.file(new URL("../docs/RELEASE.md", import.meta.url)).text();
    expect(doc).toContain("Founder fixes must be squash-merged");
    const runtime = new SourceRuntime(driverConfig(), true);
    const observed = await runtime.authority(state(), state().selectedMain);
    expect(observed).toHaveProperty("unreviewedCommit", "a".repeat(40));
    const current = { ...state("approve-open"), authorityPolicy: observed.policy };
    const hold = nextStep(current, snapshot({ approve: pr(), authority: observed }), config);
    expect(hold.detail).toContain("at source commit " + "a".repeat(40));
    const fake = new FakeDriver(); fake.state = current; fake.repo = snapshot({ approve: pr(), authority: observed });
    await tick(fake, config);
    expect(fake.state.holdCommit).toBe("a".repeat(40));
    expect((await tick(fake, config)).detail).toContain("a".repeat(40));
  });
});

test("stock numeric requests choose highest trusted exact title; fixes-only requests are selected", () => {
  const newer = { ...issue, number: 402, title: "Upstream tracking: v18.10.1" };
  expect(selectRequest([issue, { ...newer, author: "attacker" }, newer])).toEqual(newer);
  expect(selectRequest([{ ...issue, title: "Upstream tracking: v18.8.3 trailing" }])).toBeUndefined();
  expect(compareVersions("v18.10.1", "18.8.3")).toBe(1);
  expect(() => compareVersions("v18.8.3-rc.1", "18.8.3")).toThrow();
  expect(nextStep(state(), snapshot(), config).operation).toBe("open-prepare");
  expect(nextCandidate("0.7.5", ["v0.7.5-prealpha.2", "v0.7.5-prealpha.10", "v0.7.5-prealpha.0"])).toBe("v0.7.5-prealpha.11");
});

test("one tick advances at most one step across the complete happy path", async () => {
  const fake = new FakeDriver();
  fake.repo.upstreamTag = "v18.5.1";
  fake.repo.order = order({ behind: true });
  const expected: Operation[] = ["select", "update-order", "ready-order", "merge-order", "open-prepare", "merge-prepare", "tag-candidate", "observe-candidate", "verify-candidate", "start-campaign", "finish-campaign", "open-approve", "start-approve-checks", "finish-approve-checks", "merge-approve", "tag-stable", "observe-stable", "verify-stable", "start-smoke", "finish-smoke", "open-record", "merge-record", "close"];
  for (const operation of expected) {
    const previous = fake.state?.sequence ?? 0;
    expect((await tick(fake, config)).operation).toBe(operation);
    expect(fake.state!.sequence).toBe(previous + 1);
    expect(fake.comments.size).toBe(previous + 1);
  }
  expect(fake.state!.phase).toBe("closed");
  expect((await tick(fake, config)).operation).toBe("idle");
  expect(fake.performed).toEqual(expected);
  expect(fake.prepareSources).toEqual(["9".repeat(40)]);
  for (const comment of fake.comments.values()) expect(comment.split("\n")[0]).toMatch(/^release-driver: [a-z-]+ — [^\n]+$/u);
});

describe("Carrythrough order authority and scope", () => {
  test.each([
    { filename: "scripts/build-release.ts" },
    { filename: "CHANGELOG.md", previous_filename: "scripts/build-release.ts" },
    { filename: "apps/gateway/src/http.ts", previous_filename: "docs/COMPATIBILITY.md" },
  ])("holds out-of-scope content and both sides of renames: %j", async file => {
    const fake = new FakeDriver(); fake.state = state(); fake.repo.upstreamTag = "v18.5.1"; fake.repo.order = order({ files: [file] });
    expect(outsideOrderScope(fake.repo.order).length).toBeGreaterThan(0);
    expect((await tick(fake, config)).operation).toBe("hold");
    expect(fake.state.phase).toBe("held");
    expect((await tick(fake, config)).operation).toBe("idle");
    fake.repo.order.files = [{ filename: "CHANGELOG.md" }];
    expect((await tick(fake, config)).operation).toBe("idle");
    expect(fake.performed).not.toContain("merge-order");
    expect(fake.comments.size).toBe(1);
  });
  test.each([
    { author: "alphastorm" }, { authorType: "User" }, { headRepository: "attacker/fork" },
    { headRef: "other/order" }, { base: "other" },
  ])("rejects an order outside the exact identity contract: %j", change => {
    expect(isOrder(order(change))).toBe(false);
    expect(nextStep(state(), snapshot({ upstreamTag: "v18.5.1", order: order(change) }), config).operation).toBe("idle");
  });
  test("requires every head check before update/ready/merge and waits after update", () => {
    expect(nextStep(state(), snapshot({ upstreamTag: "v18.5.1", order: order({ checksPassed: false }) }), config).operation).toBe("idle");
    const updated = { ...state("order-updated"), updatedHead: "b".repeat(40) };
    expect(nextStep(updated, snapshot({ upstreamTag: "v18.5.1", order: order({ behind: true }) }), config).operation).toBe("idle");
  });
});

describe("approve is a standing routine exact-tree gate", () => {
  const approved = { ...state("approval-required"), candidateCommit: evidence.candidateCommit, candidateDigest: evidence.candidateDigest, approvePr: 401, approvedHead: "b".repeat(40), approvedTree: "c".repeat(40) };
  test.each([
    [{ merged: true, state: "closed", mergedBy: config.founder, mergeTree: "c".repeat(40) }, "unexpected-merger"],
    [{ merged: true, state: "closed", mergedBy: config.bot, mergeTree: "d".repeat(40) }, "merge-tree-changed"],
    [{ state: "closed", merged: false }, "pr-identity-changed"],
    [{ head: "d".repeat(40) }, "head-tree-changed"],
    [{ author: "attacker" }, "pr-identity-changed"],
  ] as const)("refuses unsafe approval %j", (change, reason) => {
    const result = nextStep(approved, snapshot({ approve: pr(change) }), config);
    expect(result.operation).toBe("hold"); expect(result.holdReason).toBe(reason);
  });
  test("cannot bypass Studio checks by merging early", () => {
    expect(nextStep(state("approve-open"), snapshot({ approve: pr({ merged: true }) }), config).holdReason).toBe("missing-evidence");
  });
});

test.each(["qualifying", "approve-checking", "smoking"] as const)("%s failure stops without retry; campaign reports failing lanes", async phase => {
  const fake = new FakeDriver(); fake.state = state(phase);
  const job = { status: "failed" as const, detail: "campaign failed lanes: android (failed), cleanup (failed); no retry" };
  fake.repo.campaign = job; fake.repo.approveChecks = job; fake.repo.smoke = job;
  expect((await tick(fake, config)).operation).toBe("stop");
  expect(fake.state.phase).toBe("diagnostic-required");
  expect([...fake.comments.values()][0]).toContain("android (failed)");
  if (phase !== "approve-checking") expect([...fake.comments.values()][0]!.split("\n")[0]).toContain("recover the exact owning release-host lease");
  expect((await tick(fake, config)).operation).toBe("idle");
});

test("diagnostic rerequest requires a new green dispatch, main fix, and recovered host lease", () => {
  const failed = { ...state("diagnostic-required"), failedMain: "a".repeat(40), candidateCommit: "b".repeat(40) };
  const repo = snapshot({ main: "d".repeat(40), tags: ["v0.7.5-prealpha.1"], issues: [{ ...issue, request: "43:1" }] });
  expect(nextStep(failed, { ...repo, hostRecoveryRequired: true }, config).operation).toBe("idle");
  expect(nextStep(failed, { ...repo, main: failed.failedMain }, config).operation).toBe("idle");
  expect(nextStep(failed, { ...repo, issues: [issue] }, config).operation).toBe("idle");
  const step = nextStep(failed, repo, config);
  expect(step.operation).toBe("rerequest");
  if (step.operation !== "idle") { expect(step.patch?.candidate).toBe("v0.7.5-prealpha.2"); expect(step.patch?.candidateCommit).toBeUndefined(); }
});

test("a later passing observation cannot erase a diagnostic host fault or restart the failed candidate", async () => {
  const fake = new FakeDriver();
  fake.state = { ...state("diagnostic-required"), failedMain: fake.repo.main, candidateCommit: "b".repeat(40), candidateDigest: "c".repeat(64) };
  fake.repo.campaign = { status: "passed", detail: "later preflight passed after host-fault repair" };
  const before = structuredClone(fake.state);
  expect((await tick(fake, config)).operation).toBe("idle");
  expect(fake.state).toEqual(before);
  expect(fake.saves).toBe(0);
  expect(fake.performed).toEqual([]);
});

test("an unvalidated temporary-failure exit remains a diagnostic failed observation", () => {
  expect(nextStep(state("qualifying"), snapshot({ campaign: { status: "failed", detail: "campaign exited 75" } }), config).operation).toBe("stop");
});

function heldCampaign() {
  const selected: DriverState = {
    ...state("infrastructure-held"), candidateCommit: "e".repeat(40), candidateDigest: "f".repeat(64), authorityPolicy: "1".repeat(64), preparePr: 399, macHost: "gwqual@fixture.invalid",
  };
  const hold: CampaignInfrastructureHold = {
    scope: "preflight", candidate: selected.candidate, sourceCommit: selected.candidateCommit!, archiveSha256: selected.candidateDigest!,
    orchestratorCommit: selected.candidateCommit!, policy: selected.authorityPolicy!, campaignAttempt: 0, macHost: selected.macHost!,
    availabilityHolds: [{ kind: "device-cloud-availability", stage: "preflight", target: "android", vendors: ["testingbot"], reason: "pinned-pool-busy", waitedMs: 0 }],
  };
  selected.infrastructureHold = hold;
  return { selected, hold };
}

describe("device-cloud infrastructure-held driver", () => {
  test("only a closed candidate/policy/attempt-bound observation enters the durable hold", async () => {
    const { selected, hold } = heldCampaign();
    const fake = new FakeDriver();
    fake.state = { ...selected, phase: "qualifying" };
    fake.repo.campaign = { status: "infrastructure-hold", availabilityHold: hold };
    expect((await tick(fake, config)).operation).toBe("hold-device-cloud");
    expect(fake.state.phase).toBe("infrastructure-held");
    expect(fake.state.infrastructureHold).toEqual(hold);
    const before = structuredClone(fake.state);
    fake.repo.campaign = { status: "passed" };
    fake.repo.main = "9".repeat(40);
    fake.repo.issues = [{ ...issue, request: "999:1" }];
    expect((await tick(fake, config)).operation).toBe("idle");
    expect(fake.state).toEqual(before);
    expect(fake.performed).toEqual(["hold-device-cloud"]);
  });
  test.each([
    { candidate: "v0.7.5-prealpha.99" }, { campaignAttempt: 1 }, { policy: "2".repeat(64) }, { sourceCommit: "d".repeat(40) },
    { availabilityHolds: [] }, { macHost: "other@fixture.invalid" }, { detail: "unknown-vendor-output" },
  ])("malformed or foreign holds are diagnostic: %j", change => {
    const { selected, hold } = heldCampaign();
    expect(nextStep({ ...selected, phase: "qualifying" }, snapshot({
      campaign: { status: "infrastructure-hold", availabilityHold: { ...hold, ...change } },
    }), config).operation).toBe("stop");
  });
  test("exit-75 output is validated rather than inferred from messages or exit code", () => {
    const { selected, hold } = heldCampaign();
    const output = { outcome: "infrastructure-hold", availabilityHolds: hold.availabilityHolds };
    expect(campaignAvailabilityObservation(selected, output, undefined)).toEqual(hold);
    for (const bad of ["no devices free", {}, { outcome: "infrastructure-hold", availabilityHolds: [], raw: "untrusted" }]) {
      expect(() => campaignAvailabilityObservation(selected, bad, undefined)).toThrow();
    }
    const allocation = { ...hold.availabilityHolds[0]!, stage: "allocation", epoch: "11111111-2222-4333-8444-555555555555" };
    expect(() => campaignAvailabilityObservation(selected, { outcome: "infrastructure-hold", availabilityHolds: [allocation] }, undefined)).toThrow("no resumable receipt");
    expect(campaignAttempt(selected)).toBe(0);
    expect(() => parseCampaignInfrastructureHold({ ...hold, campaignAttempt: -1 }, selected)).toThrow();
    expect(() => parseCampaignInfrastructureHold({ ...hold, macHost: undefined }, selected)).toThrow();
  });
  test.each([2, 3])("accepts all %i free-admission hold leaves from a dedicated outcome file despite noisy stdout", async count => {
    const { selected, hold } = heldCampaign();
    const availabilityHolds = (["iphone", "ipad", "android"] as const).slice(3 - count).map(target => ({ ...hold.availabilityHolds[0]!, target }));
    const root = await mkdtemp(join(tmpdir(), "release-cloud-outcome-"));
    try {
      const stdout = "gh run watch: noisy lane output\nMac fixture: noisy lane output\n";
      expect(() => JSON.parse(stdout)).toThrow();
      const path = join(root, "preflight-outcome.json");
      await writeDeviceCloudOutcomeFile(path, { outcome: "infrastructure-hold", availabilityHolds });
      expect(campaignAvailabilityObservation(selected, await readDeviceCloudOutcomeFile(path), undefined)).toMatchObject({ scope: "preflight", availabilityHolds });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

const retryReceiptModules: StableQualificationLaneModules = (() => {
  const lane: ExternalLaneModule = {
    preflight: async () => {}, run: async () => { throw new Error("not a live fixture"); }, cleanup: async () => ({}),
    needsCleanup: progress => typeof progress !== "object" || progress === null || !("cleanupRequired" in progress) || progress.cleanupRequired !== false,
  };
  return { windows: lane, androidPush: lane, deviceCloud: lane, createPixelLease: () => async (_owner, action) => action() };
})();

function receiptScopedCampaign(selected: DriverState) {
  const receipt = createStableQualificationReceipt(selected.candidate, selected.candidateCommit!, selected.previousStable!);
  receipt.status = "failed"; receipt.macHost = selected.macHost!;
  receipt.candidate = { tag: selected.candidate, sourceCommit: selected.candidateCommit!, archiveSha256: selected.candidateDigest! };
  receipt.predecessor = { tag: selected.previousStable!, sourceCommit: "c".repeat(40), archiveSha256: "d".repeat(64) };
  const epoch = "11111111-2222-4333-8444-555555555555";
  for (const lane of Object.values(receipt.lanes)) Object.assign(lane, { status: "passed", attempts: 1, evidence: {} });
  for (const name of ["windows", "androidPush", "deviceCloud"] as const) {
    receipt.lanes[name].evidence = { progress: { epoch, cleanupRequired: false }, result: { passed: true } };
    receipt.lanes[`${name}Cleanup`].evidence = { epoch };
  }
  receipt.lanes.deviceCloud.status = "failed";
  const availabilityHolds = [{
    kind: "device-cloud-availability", stage: "allocation", target: "ipad", vendors: ["testingbot"],
    reason: "pinned-pool-busy", waitedMs: 600_000, epoch,
  }] as const;
  receipt.lanes.deviceCloud.evidence!.availabilityHold = availabilityHolds;
  receipt.lanes.ompPublication.evidence = { published: true, revoked: true, lifecycle: {
    newGeneration: { sameInstance: true, generationDelta: 1, staleRejected: true, liveLaunches: 2, noStore: true },
    fork: { sameInstance: true, generationDelta: 1, syntheticMessages: 2, staleRejected: true, liveLaunches: 2, noStore: true },
    resumed: { newInstance: true, generation: 1, sameLabel: true, liveLaunches: 2, noStore: true, revocations: 2 },
  } };
  return { receipt, hold: campaignAvailabilityObservation(selected, { outcome: "infrastructure-hold", availabilityHolds }, receipt, retryReceiptModules) };
}

class RetryDriver extends StudioDriver {
  current = heldCampaign().selected;
  observation: JobObservation = { status: "infrastructure-hold", availabilityHold: heldCampaign().hold };
  saves = 0;
  active = false;
  owner: string | undefined;
  published = false;
  policyChanged = false;
  bindingChange: Partial<DriverState> = {};
  receiptPath = "";
  override async load() { return structuredClone(this.current); }
  override async save(value: DriverState) { this.saves += 1; this.current = structuredClone(value); }
  override async job() { return this.observation; }
  override async campaignWorkerRunning() { return this.active; }
  override async releaseHostOwner() { return this.owner; }
  override async campaignBinding(state: DriverState) { return { ...state, ...this.bindingChange }; }
  override campaignHoldObservation(state: DriverState, output: unknown, receipt: StableQualificationReceipt | undefined) {
    return campaignAvailabilityObservation(state, output, receipt, retryReceiptModules);
  }
  override receipt() { return this.receiptPath; }
  override async readPr() { return pr({ merged: true, mergeCommit: this.current.candidateCommit, mergedBy: config.bot }); }
  override async authority() { return { ...authority, policy: this.policyChanged ? "2".repeat(64) : this.current.authorityPolicy! }; }
  override async api<T>(path: string): Promise<T | undefined> {
    return (path === "commits/main" ? { sha: this.current.candidateCommit } : this.published ? { exists: true } : undefined) as T | undefined;
  }
}

describe("guarded one-shot operator retry", () => {
  test("receipt-scoped authorization uses the immutable worker host, not the invoking CLI environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-cloud-receipt-retry-"));
    const previousHost = process.env.OMP_STABLE_MAC_HOST;
    try {
      process.env.OMP_STABLE_MAC_HOST = "foreign-cli@other.invalid";
      const runtime = new RetryDriver(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
      runtime.receiptPath = join(root, "receipt.json");
      const { receipt, hold } = receiptScopedCampaign(runtime.current);
      runtime.current.infrastructureHold = hold;
      runtime.observation = { status: "infrastructure-hold", availabilityHold: hold };
      await writeFile(runtime.receiptPath, JSON.stringify(receipt));
      const oldJob = runtime.jobDirectory("campaign", runtime.current);
      await mkdir(oldJob, { recursive: true });
      await writeFile(join(oldJob, "held-qualification.json"), JSON.stringify(receipt));
      const next = await runtime.authorizeDeviceCloudRetry(runtime.current.candidate, 0);
      expect(next).toMatchObject({ resumeDeviceCloud: true, campaignAttempt: 1, macHost: "gwqual@fixture.invalid" });
      expect(JSON.parse(await readFile(runtime.receiptPath, "utf8"))).toEqual(receipt);
      expect(runtime.saves).toBe(1);
    } finally {
      if (previousHost === undefined) delete process.env.OMP_STABLE_MAC_HOST; else process.env.OMP_STABLE_MAC_HOST = previousHost;
      await rm(root, { recursive: true, force: true });
    }
  });
  test.each(["preflight scope over eligible receipt", "changed snapshot", "foreign receipt host", "different outcome leaves"] as const)(
    "refuses receipt-scoped %s without authorization", async variant => {
      const root = await mkdtemp(join(tmpdir(), "release-cloud-receipt-refusal-"));
      try {
        const runtime = new RetryDriver(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
        runtime.receiptPath = join(root, "receipt.json");
        const { receipt, hold } = receiptScopedCampaign(runtime.current);
        runtime.current.infrastructureHold = hold;
        runtime.observation = { status: "infrastructure-hold", availabilityHold: hold };
        const oldJob = runtime.jobDirectory("campaign", runtime.current);
        await mkdir(oldJob, { recursive: true });
        await writeFile(join(oldJob, "held-qualification.json"), JSON.stringify(receipt));
        if (variant === "preflight scope over eligible receipt") {
          // A fresh read-only admission may hold an existing eligible receipt too; scope is still receipt.
          const availabilityHolds = heldCampaign().hold.availabilityHolds;
          receipt.lanes.deviceCloud.evidence!.availabilityHold = availabilityHolds;
          runtime.current.infrastructureHold = { ...hold, scope: "preflight", availabilityHolds };
          runtime.observation = { status: "infrastructure-hold", availabilityHold: runtime.current.infrastructureHold };
        }
        if (variant === "changed snapshot") receipt.updatedAt = "2026-10-20T12:00:00.000Z";
        if (variant === "foreign receipt host") receipt.macHost = "other@fixture.invalid";
        if (variant === "different outcome leaves") receipt.lanes.deviceCloud.evidence!.availabilityHold = heldCampaign().hold.availabilityHolds;
        await writeFile(runtime.receiptPath, JSON.stringify(receipt));
        await expect(runtime.authorizeDeviceCloudRetry(runtime.current.candidate, 0)).rejects.toThrow();
        expect(runtime.saves).toBe(0);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
  test("one authorization creates one new immutable job and never overwrites attempt zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-cloud-retry-"));
    try {
      const runtime = new RetryDriver(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
      runtime.receiptPath = join(root, "absent-receipt.json");
      const initial = structuredClone(runtime.current);
      const oldJob = runtime.jobDirectory("campaign", initial);
      await mkdir(oldJob, { recursive: true });
      await writeFile(join(oldJob, "result.json"), "immutable old result");
      await writeFile(join(oldJob, "out.log"), "immutable old output");
      const next = await runtime.authorizeDeviceCloudRetry(initial.candidate, 0);
      expect(next).toMatchObject({ phase: "candidate-verified", campaignAttempt: 1, resumeDeviceCloud: false });
      expect(runtime.saves).toBe(1);
      expect(await readdir(join(root, "jobs"))).toHaveLength(1);
      expect(runtime.jobDirectory("campaign", next)).toBe(`${oldJob}-retry-1`);
      expect(runtime.session("campaign", next)).toBe(`${runtime.session("campaign", initial)}-retry-1`);
      await expect(runtime.authorizeDeviceCloudRetry(initial.candidate, 0)).rejects.toThrow("exact held candidate");
      let jobsStarted = 0;
      const port: DriverPort = {
        load: () => runtime.load(),
        save: value => runtime.save(value),
        snapshot: async () => snapshot({ campaign: { status: "running" } }),
        perform: async (step, current) => {
          expect(step.operation).toBe("start-campaign");
          jobsStarted += 1;
          const directory = runtime.jobDirectory("campaign", current);
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, "spec.json"), JSON.stringify({ state: current }), { flag: "wx" });
          return {};
        },
        announce: async () => {},
      };
      expect((await tick(port, config)).operation).toBe("start-campaign");
      const specification = await readFile(join(runtime.jobDirectory("campaign", next), "spec.json"), "utf8");
      expect((await tick(port, config)).operation).toBe("idle");
      expect(await readFile(join(runtime.jobDirectory("campaign", next), "spec.json"), "utf8")).toBe(specification);
      expect(jobsStarted).toBe(1);
      expect(await readdir(join(root, "jobs"))).toHaveLength(2);
      expect(await readFile(join(oldJob, "result.json"), "utf8")).toBe("immutable old result");
      expect(await readFile(join(oldJob, "out.log"), "utf8")).toBe("immutable old output");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // The production launcher requires POSIX ownership/modes and /bin/sh/tmux on its macOS host.
  // Keep authorization and tick semantics above portable; do not weaken those production checks.
  test.skipIf(process.platform === "win32")("the POSIX campaign launcher preserves immutable job files on repeated launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-cloud-launch-"));
    const previousPath = process.env.PATH;
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const launched = join(root, "launched");
      await writeFile(join(bin, "tmux"), `#!/bin/sh\n[ "$1" != has-session ] || { [ -f '${launched}' ]; exit $?; }\nprintf '%s\\n' "$*" >> '${launched}'\n`, { mode: 0o700 });
      process.env.PATH = `${bin}:${previousPath}`;
      const runtime = new RetryDriver(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
      process.env.PATH = previousPath;
      const initial = structuredClone(runtime.current);
      const next: DriverState = { ...initial, phase: "candidate-verified", campaignAttempt: 1, resumeDeviceCloud: false };
      const oldJob = runtime.jobDirectory("campaign", initial);
      await mkdir(oldJob, { recursive: true });
      await writeFile(join(oldJob, "result.json"), "immutable old result");
      await writeFile(join(oldJob, "out.log"), "immutable old output");
      await runtime.launch("campaign", next);
      const specification = await readFile(join(runtime.jobDirectory("campaign", next), "spec.json"), "utf8");
      await runtime.launch("campaign", next);
      expect(await readFile(join(runtime.jobDirectory("campaign", next), "spec.json"), "utf8")).toBe(specification);
      expect((await readFile(launched, "utf8")).trim().split("\n")).toHaveLength(1);
      expect(await readFile(join(oldJob, "result.json"), "utf8")).toBe("immutable old result");
      expect(await readFile(join(oldJob, "out.log"), "utf8")).toBe("immutable old output");
    } finally { process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform === "win32")("a tmux failure after spec write replays the same unclaimed job exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-cloud-launch-replay-"));
    const previousPath = process.env.PATH, previousHost = process.env.OMP_STABLE_MAC_HOST;
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const failed = join(root, "first-launch-failed"), running = join(root, "running"), launched = join(root, "launched");
      await writeFile(join(bin, "tmux"), `#!/bin/sh\n[ "$1" != has-session ] || { [ -f '${running}' ]; exit $?; }\n[ -f '${failed}' ] || { touch '${failed}'; exit 9; }\nprintf '%s\\n' "$*" >> '${launched}'\ntouch '${running}'\n`, { mode: 0o700 });
      process.env.PATH = `${bin}:${previousPath}`;
      process.env.OMP_STABLE_MAC_HOST = "first@fixture.invalid";
      const first = new RetryDriver(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
      const selected: DriverState = { ...first.current, phase: "candidate-verified", campaignAttempt: 1, macHost: undefined };
      const step: Decision = { operation: "start-campaign", phase: "qualifying", detail: "authorized retry" };
      await expect(first.perform(step, selected)).rejects.toThrow("exited 9");
      const directory = first.jobDirectory("campaign", selected);
      const specification = await readFile(join(directory, "spec.json"), "utf8");
      expect(JSON.parse(specification).state.macHost).toBe("first@fixture.invalid");
      expect(await Bun.file(join(directory, "started")).exists()).toBe(false);
      process.env.OMP_STABLE_MAC_HOST = "changed-cli@other.invalid";
      const replay = new RetryDriver(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
      expect(await replay.perform(step, selected)).toEqual({ macHost: "first@fixture.invalid" });
      expect(await replay.perform(step, selected)).toEqual({ macHost: "first@fixture.invalid" });
      expect((await readFile(launched, "utf8")).trim().split("\n")).toHaveLength(1);
      expect(await readFile(join(directory, "spec.json"), "utf8")).toBe(specification);
      expect(await readdir(join(root, "jobs"))).toEqual([directory.slice(directory.lastIndexOf("/") + 1)]);
      await rm(running);
      await writeFile(join(directory, "started"), "");
      await replay.perform(step, selected); // The durable worker claim forbids relaunch even without tmux.
      expect((await readFile(launched, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      process.env.PATH = previousPath;
      if (previousHost === undefined) delete process.env.OMP_STABLE_MAC_HOST; else process.env.OMP_STABLE_MAC_HOST = previousHost;
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["candidate", "attempt", "intent", "outbox", "active worker", "publication", "policy", "foreign lease", "ordinary failure", "missing job", "dirty receipt", "occupied retry", "foreign host binding", "foreign source binding", "foreign policy binding"] as const)(
    "refuses %s without allocating or authorizing another job", async variant => {
      const root = await mkdtemp(join(tmpdir(), "release-cloud-retry-refusal-"));
      try {
        const runtime = new RetryDriver(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
        runtime.receiptPath = join(root, "receipt.json");
        if (variant === "intent") runtime.current.intent = { operation: "start-campaign", phase: "qualifying", detail: "pending" };
        if (variant === "outbox") runtime.current.announcement = { body: "pending", marker: "pending" };
        if (variant === "active worker") runtime.active = true;
        if (variant === "publication") runtime.published = true;
        if (variant === "policy") runtime.policyChanged = true;
        if (variant === "foreign lease") runtime.owner = "qualification:another-candidate:another-receipt";
        if (variant === "ordinary failure") runtime.observation = { status: "failed" };
        if (variant === "missing job") runtime.observation = { status: "absent" };
        if (variant === "foreign host binding") runtime.bindingChange = { macHost: "other@fixture.invalid" };
        if (variant === "foreign source binding") runtime.bindingChange = { candidateCommit: "9".repeat(40) };
        if (variant === "foreign policy binding") runtime.bindingChange = { authorityPolicy: "9".repeat(64) };
        if (variant === "dirty receipt") await writeFile(runtime.receiptPath, JSON.stringify({ lanes: { deviceCloud: { attempts: 1, status: "failed" } } }));
        if (variant === "occupied retry") await mkdir(runtime.jobDirectory("campaign", { ...runtime.current, campaignAttempt: 1 }), { recursive: true });
        await expect(runtime.authorizeDeviceCloudRetry(variant === "candidate" ? "v0.7.5-prealpha.99" : runtime.current.candidate, variant === "attempt" ? 1 : 0)).rejects.toThrow();
        expect(runtime.saves).toBe(0);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
});

test("a retry request on a new tracking issue for the same version re-selects the failed release", () => {
  // v0.7.5: order #369's "Closes #368" closed the request when it merged; the retry request opened #374.
  const failed = { ...state("diagnostic-required"), failedMain: "a".repeat(40), candidateCommit: "b".repeat(40) };
  const retry = { ...issue, number: 405, request: "43:1", url: "https://github.com/carrythroughsystems/omp-session-gateway/issues/405" };
  const repo = snapshot({ main: "d".repeat(40), tags: ["v0.7.5-prealpha.1"], issues: [retry] });
  const step = nextStep(failed, repo, config);
  expect(step.operation).toBe("rerequest");
  if (step.operation !== "idle") { expect(step.patch?.issue?.number).toBe(405); expect(step.patch?.candidate).toBe("v0.7.5-prealpha.2"); }
  expect(nextStep(failed, { ...repo, issues: [{ ...retry, title: "Upstream tracking: v18.8.4" }] }, config).operation).toBe("idle");
  expect(nextStep(failed, { ...repo, issues: [{ ...retry, request: failed.issue.request }] }, config).operation).toBe("idle");
});

test.each(["candidate-tagged", "stable-tagged"] as const)("%s waits for workflow and stops on red", phase => {
  const repo = snapshot();
  expect(nextStep(state(phase), repo, config).operation).toBe("idle");
  repo.candidateWorkflow = "failed"; repo.stableWorkflow = "failed";
  expect(nextStep(state(phase), repo, config).operation).toBe("stop");
});

test("prepare and record PRs require bot identity, open/merged state and strict checks", () => {
  for (const phase of ["prepare-open", "record-open"] as const) {
    expect(nextStep(state(phase), snapshot({ prepare: pr({ state: "closed" }), record: pr({ state: "closed" }) }), config).operation).toBe("stop");
    expect(nextStep(state(phase), snapshot({ prepare: pr({ checksPassed: false }), record: pr({ checksPassed: false }) }), config).operation).toBe("idle");
    expect(nextStep(state(phase), snapshot({ prepare: pr({ behind: true }), record: pr({ behind: true }) }), config).operation).toBe("update-release-pr");
  }
});

test("crash between provider write and state save reconciles the same effect without duplication", async () => {
  const fake = new FakeDriver(); fake.state = state("selected"); fake.failSave = 2;
  await expect(tick(fake, config)).rejects.toThrow("simulated crash");
  expect(fake.state.intent?.operation).toBe("open-prepare");
  expect(fake.repo.prepare?.number).toBe(402);
  expect((await tick(fake, config)).operation).toBe("open-prepare");
  expect(fake.performed.filter(operation => operation === "open-prepare")).toHaveLength(1);
  expect(fake.state.phase).toBe("prepare-open"); expect(fake.comments.size).toBe(1);
});

test("a pinned merge whose PR moved re-plans from a fresh snapshot instead of replaying its intent", async () => {
  // v0.7.5: #369's head was replaced after the driver pinned it, and every tick replayed the stale merge.
  class MovedHead extends FakeDriver {
    override async perform(step: Decision, current: DriverState) {
      if (step.operation === "merge-prepare" && step.pr?.head !== this.repo.prepare?.head) throw new StaleIntentError("PR head changed before pinned merge");
      return super.perform(step, current);
    }
  }
  const fake = new MovedHead();
  fake.state = { ...state("prepare-open"), preparePr: 402 };
  fake.repo.prepare = pr({ number: 402 });
  fake.state.intent = nextStep(fake.state, fake.repo, config) as Decision;
  expect(fake.state.intent.operation).toBe("merge-prepare");
  fake.repo.prepare = pr({ number: 402, head: "d".repeat(40), checksPassed: false });
  expect((await tick(fake, config)).operation).toBe("idle");
  expect(fake.state.intent).toBeUndefined();
  expect(fake.state.phase).toBe("prepare-open");
  expect((await tick(fake, config)).detail).toContain("waiting for strict required PR checks");
  fake.repo.prepare.checksPassed = true;
  expect((await tick(fake, config)).operation).toBe("merge-prepare");
  expect(fake.performed).toEqual(["merge-prepare"]);
  expect(fake.state.phase).toBe("prepared");
});

test("runtime finds an existing release PR under the organization owner", async () => {
  const existing = pr();
  class TransferredRuntime extends StudioDriver {
    override async pages<T>(path: string): Promise<T[]> {
      expect(path).toBe("pulls?state=all&base=main&head=carrythroughsystems:release-driver%2F400%2Fv0.7.5-prealpha.1-approve&per_page=100");
      return [{ number: existing.number }] as T[];
    }
    override async readPr() { return existing; }
    override async git() { return "installed"; }
    override async controls() { return new Map<string, string>(); }
    override async api<T>(): Promise<T | undefined> { return { author: { login: config.bot }, commit: { verification: { verified: true } } } as T; }
  }
  expect(REPOSITORY).toBe("carrythroughsystems/omp-session-gateway");
  const runtime = new TransferredRuntime(driverConfig(), false);
  expect(await runtime.openPr("approve", state())).toEqual(existing);
});

test("runtime refuses a moved pinned merge as stale, but a merge at another head as a hard stop", async () => {
  let current = pr({ head: "d".repeat(40) });
  class MovedRuntime extends StudioDriver {
    override async readPr() { return current; }
    override async git() { return "installed"; }
    override async controls() { return new Map<string, string>(); }
  }
  const runtime = new MovedRuntime(driverConfig(), false);
  await expect(runtime.merge(pr(), false)).rejects.toThrow(StaleIntentError);
  current = pr({ checksPassed: false });
  await expect(runtime.merge(pr(), false)).rejects.toThrow(StaleIntentError);
  current = pr({ head: "d".repeat(40), merged: true, mergedBy: config.bot, state: "closed" });
  const foreign = await runtime.merge(pr(), false).catch((error: unknown) => error);
  expect(foreign).not.toBeInstanceOf(StaleIntentError);
  expect(String(foreign)).toContain("merged at a head other than the pinned one");
});

test("accepted progress comment followed by a crash never posts another comment", async () => {
  const fake = new FakeDriver(); fake.crashAfterComment = true;
  await expect(tick(fake, config)).rejects.toThrow("accepted comment");
  expect(fake.state?.announcement).toBeDefined();
  expect((await tick(fake, config)).operation).toBe("idle");
  expect(fake.comments.size).toBe(1); expect(fake.state?.announcement).toBeUndefined();
  expect(fake.commentWrites).toBe(1);
  expect(fake.performed).toEqual(["select"]);
});

test("plan reads live inputs but writes no state, effects, comments, or bot credentials", async () => {
  const fake = new FakeDriver();
  expect((await tick(fake, config, true)).operation).toBe("select");
  expect(fake.saves).toBe(0); expect(fake.performed).toEqual([]); expect(fake.comments.size).toBe(0);
  fake.repo.issues = [];
  expect((await tick(fake, config, true)).detail).toBe("no open tracking issue; idle");
  const driver = new StudioDriver(driverConfig(), true);
  await expect(driver.authenticate()).rejects.toThrow("plan mode");
  await expect(driver.save(state())).rejects.toThrow("plan attempted");
  await expect(driver.perform({ operation: "tag-stable", phase: "stable-tagged", detail: "x" }, state())).rejects.toThrow("plan attempted");
});

test("dedicated bot environment strips founder credential/identity and preserves no arbitrary qualification override", () => {
  expect(() => driverConfig({ OMP_RELEASE_DRY_RUN: "yes" })).toThrow("OMP_RELEASE_DRY_RUN");
  const cfg = driverConfig({ OMP_RELEASE_BOT_LOGIN: "release-user", OMP_RELEASE_FOUNDER_LOGIN: "founder", OMP_RELEASE_GH_CONFIG_DIR: "/private/bot-gh", OMP_RELEASE_SIGNING_KEY: "/private/key", OMP_RELEASE_STATE_DIR: "/private/state" });
  const env = botEnvironment(cfg, { GH_TOKEN: "founder-value", GITHUB_TOKEN: "founder-value", GH_CONFIG_DIR: "/founder", GIT_AUTHOR_EMAIL: "founder@example.com", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "founder-helper", OMP_STABLE_PREVIOUS_TAG: "v0.0.1", PATH: "/bin" });
  expect(env.GH_CONFIG_DIR).toBe("/private/bot-gh");
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_AUTHOR_EMAIL", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "OMP_STABLE_PREVIOUS_TAG"]) expect(env[key]).toBeUndefined();
  expect(env.PATH).toBe("/bin");
});
test("runtime refuses a changed order scope at the last merge boundary, including rename history", async () => {
  class RefusingRuntime extends StudioDriver {
    override async readPr() { return order({ draft: false, files: [{ filename: "CHANGELOG.md", previous_filename: ".github/workflows/signed-release.yml" }] }); }
  }
  const runtime = new RefusingRuntime(driverConfig(), false);
  await expect(runtime.merge(order({ draft: false }), true)).rejects.toThrow("scope changed");
});

test("runtime rechecks authority, merge commit and checked tree before a stable tag effect", async () => {
  class RefusingRuntime extends StudioDriver {
    override async promotionSnapshot() { return snapshot({ approve: pr({ merged: true, mergedBy: config.founder, mergeTree: "c".repeat(40), mergeCommit: "e".repeat(40) }) }); }
  }
  const runtime = new RefusingRuntime(driverConfig(), false);
  const approved = { ...state("approved"), candidateCommit: evidence.candidateCommit, candidateDigest: evidence.candidateDigest, approvePr: 401, stableCommit: "e".repeat(40), approvedHead: "b".repeat(40), approvedTree: "c".repeat(40) };
  await expect(runtime.perform({ operation: "tag-stable", phase: "stable-tagged", detail: "publish" }, approved)).rejects.toThrow("unexpected-merger");
});

test("runtime adopts an already-accepted pinned bot merge after a crash without another write", async () => {
  const merged = pr({ merged: true, mergedBy: config.bot, mergeCommit: "e".repeat(40), state: "closed" });
  class ReconciledRuntime extends StudioDriver {
    override async readPr() { return merged; }
    override async git() { return "installed"; }
    override async controls() { return new Map<string, string>(); }
  }
  const runtime = new ReconciledRuntime(driverConfig(), false);
  expect(await runtime.merge(pr(), false)).toEqual(merged);
});

test("runtime comment reconciliation ignores impersonated markers and adopts its own accepted comment", async () => {
  class CommentsRuntime extends StudioDriver {
    writes = 0;
    readonly remote: { body: string; user: { login: string } }[] = [{ body: "marker", user: { login: "attacker" } }];
    override async pages<T>(): Promise<T[]> { return this.remote as T[]; }
    override async gh<T>(): Promise<T | undefined> {
      this.writes++;
      this.remote.push({ body: "marker", user: { login: config.bot } });
      return undefined;
    }
  }
  const runtime = new CommentsRuntime(driverConfig(), false);
  await runtime.announce(400, "release-driver: selected — request", "marker");
  await runtime.announce(400, "release-driver: selected — request", "marker");
  expect(runtime.writes).toBe(1);
});

test("a diagnostic after publication never restarts an immutable stable version", () => {
  const stopped = { ...state("diagnostic-required"), stableCommit: "e".repeat(40), failedMain: "a".repeat(40) };
  const repo = snapshot({ main: "d".repeat(40), issues: [{ ...issue, request: "99:1" }] });
  expect(nextStep(stopped, repo, config).detail).toContain("preserve the immutable release");
});
