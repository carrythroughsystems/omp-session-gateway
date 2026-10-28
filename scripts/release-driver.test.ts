import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

import { assertFailedCampaignCleanup, botEnvironment, campaignAvailabilityObservation, campaignWorkerArguments, credentialExpiry, driverConfig, StudioDriver } from "./release-driver-runtime.ts";
import { applyDecisionPatch, campaignAttempt, campaignExecution, campaignRetryLaunchState, parseCampaignRetryPlan, compareVersions, isOrder, nextCandidate, nextStep, ORDER_SCOPE, outsideOrderScope, parseCampaignInfrastructureHold, REPOSITORY, requestVersion, selectRequest, StaleIntentError, tick } from "./release-driver.ts";
import type { CampaignFailureObservation, CampaignInfrastructureHold, Decision, DriverPort, DriverState, JobObservation, Operation, PullRequest, RepositorySnapshot, TrackingIssue } from "./release-driver.ts";
import { assertCampaignCleanupComplete, assertCampaignRetryEligible, createStableQualificationReceipt, withConsumedCampaignRetry } from "./stable-qualification.ts";
import type { ExternalLaneModule, StableQualificationLaneModules, StableQualificationReceipt } from "./stable-qualification.ts";
import { readDeviceCloudOutcomeFile, writeDeviceCloudOutcomeFile } from "./device-cloud-outcome.ts";
import { writeQualificationOutcomeFile } from "./qualification-outcome.ts";
import { withReleaseHostLease } from "./release-host-lease.ts";
import type { QualificationFailureSummary } from "./qualification-failure.ts";

import { REQUIRED_CHECKS, ROUTINE_EVIDENCE_STEPS, RoutineHoldError, routineSourceHold } from "./release-policy.ts";
const authority = { policy: "policy-1", protectedChanges: [], sourceReviewed: true, sourceFresh: true, releaseClassAllowed: true };
const evidence = { head: "b".repeat(40), tree: "c".repeat(40), candidate: "v0.7.5-prealpha.1", candidateCommit: "e".repeat(40), candidateDigest: "f".repeat(64), policy: authority.policy, steps: ROUTINE_EVIDENCE_STEPS };
const config = { bot: "alphastorm-release", founder: "alphastorm" };
const issue: TrackingIssue = { number: 400, title: "Upstream tracking: v18.8.3", author: "github-actions[bot]", request: "42:1", url: "https://github.com/carrythroughsystems/omp-session-gateway/issues/400" };
function filingJob(name: string, number: number, conclusion = "success") {
  return { name, conclusion, steps: [{ name: `Record tracking issue #${number}`, status: "completed", conclusion }] };
}
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
test("explicit minor request selects 0.8.0 instead of the unpublished 0.7.8 chain", () => {
  const minor = { ...issue, releaseClass: "minor" as const };
  const step = nextStep(undefined, snapshot({ latestStable: "v0.7.7", issues: [minor], tags: ["v0.7.8-prealpha.5"] }), config);
  expect(step.operation).toBe("select");
  if (step.operation !== "idle") {
    expect(step.patch?.version).toBe("0.8.0");
    expect(step.patch?.candidate).toBe("v0.8.0-prealpha.1");
    expect(step.patch?.issue).toEqual(minor);
  }
});
test("request identities bind OMP version and class to successful filing jobs", async () => {
  class Requests extends StudioDriver {
    jobs = [filingJob("Request OMP v18.8.3", 439)];
    override async pages<T>(): Promise<T[]> {
      return [
        { number: 439, title: issue.title, user: { login: issue.author }, created_at: "2026-10-22T21:21:24Z", html_url: issue.url, labels: [] },
        { number: 441, title: issue.title, user: { login: issue.author }, created_at: "2026-10-22T21:21:25Z", html_url: issue.url, labels: [{ name: "release-minor" }] },
      ] as T[];
    }
    override async api<T>(path: string): Promise<T | undefined> {
      return (path.startsWith("actions/workflows/") ? { workflow_runs: [{ id: 42, run_attempt: 1 }] } : { jobs: this.jobs }) as T;
    }
  }
  const runtime = new Requests(driverConfig(), true);
  expect((await runtime.issues()).map(value => [value.number, value.releaseClass, value.request])).toEqual([[439, "patch", "42:1"]]);
  runtime.jobs = [filingJob("Request OMP v18.8.3 (minor)", 441, "skipped")];
  expect((await runtime.issues()).map(value => value.number)).toEqual([439]);
  runtime.jobs = [filingJob("Request OMP v18.8.3 (minor)", 441)];
  expect((await runtime.issues()).map(value => [value.number, value.releaseClass, value.request])).toEqual([
    [439, "patch", "2026-10-22T21:21:24Z"], [441, "minor", "42:1"],
  ]);
  expect(selectRequest(await runtime.issues())?.number).toBe(441);
});
test("an open request retains its validated successful run outside the latest workflow page", async () => {
  const previous = { ...issue, releaseClass: "minor" as const };
  class RetainedRequest extends StudioDriver {
    valid = true;
    override async pages<T>(): Promise<T[]> {
      return [{ number: issue.number, title: issue.title, user: { login: issue.author }, created_at: "2026-10-22T21:21:25Z",
        html_url: issue.url, labels: [{ name: "release-minor" }] }] as T[];
    }
    override async api<T>(path: string): Promise<T | undefined> {
      return (path.startsWith("actions/workflows/") ? { workflow_runs: [] }
        : path.endsWith("/jobs?per_page=100") ? { jobs: [filingJob("Request OMP v18.8.3 (minor)", issue.number)] }
        : { path: ".github/workflows/release-request.yml", status: "completed", conclusion: this.valid ? "success" : "failure" }) as T;
    }
  }
  const runtime = new RetainedRequest(driverConfig(), true);
  expect((await runtime.issues(previous))[0]?.request).toBe("42:1");
  runtime.valid = false;
  expect(await runtime.issues(previous)).toEqual([]);
});
test("a completed patch does not close an outstanding minor request", async () => {
  const minor = { ...issue, number: 441, releaseClass: "minor" as const };
  class Closing extends StudioDriver {
    closed: string[] = [];
    override async issues() { return [issue, minor]; }
    override async announce() {}
    override async gh<T>(args: string[]): Promise<T | undefined> { this.closed.push(args[3]!); return undefined; }
  }
  const runtime = new Closing(driverConfig(), false);
  const close: Decision = { operation: "close", phase: "closed", detail: "fulfilled" };
  await runtime.perform(close, state("recorded"));
  expect(runtime.closed).toEqual([`repos/${REPOSITORY}/issues/400`]);
  runtime.closed = [];
  await runtime.perform(close, { ...state("recorded"), issue: minor });
  expect(runtime.closed).toEqual([`repos/${REPOSITORY}/issues/400`, `repos/${REPOSITORY}/issues/441`]);
});
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
    const key = `${current.candidate}:${campaignAttempt(current)}:${step.operation}`;
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
    reviews: { id: number; user: { login: string }; state: string; commit_id: string }[] = [];
    override async controls() { return new Map<string, string>(); }
    override async git(args: string[]) {
      if (args[0] === "rev-parse") return "installed";
      if (args[0] === "status") return this.dirty && !args.includes("--untracked-files=no") ? "?? .env" : "";
      throw new Error("unexpected git read");
    }
    override async pages<T>(path: string): Promise<T[]> { return (path.includes("/reviews") ? this.reviews : [{ number: 401 }]) as T[]; }
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
  test("bot-merged fixes need the latest maintainer approval at the exact head and no authority paths", async () => {
    const runtime = new SourceRuntime(driverConfig(), true);
    runtime.subject = "fix(qualification): repair apt step";
    runtime.sourcePr = pr({ merged: true, mergedBy: config.bot, mergeTree: "c".repeat(40), files: [{ filename: "scripts/provision-linux-qual.sh" }] });
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
    const approval = { id: 1, user: { login: config.founder }, state: "APPROVED", commit_id: runtime.sourcePr.head };
    runtime.reviews = [approval];
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(true);
    for (const review of [
      { ...approval, commit_id: "old-head" }, { ...approval, user: { login: config.bot } },
      { ...approval, state: "DISMISSED" }, { ...approval, state: "CHANGES_REQUESTED" },
    ]) {
      runtime.reviews = [review];
      expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
    }
    runtime.reviews = [approval, { ...approval, id: 2, state: "DISMISSED" }];
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
    runtime.reviews = [approval];
    for (const filename of ["scripts/release-policy.ts", "STABLE_RELEASE.lock.json"]) {
      runtime.sourcePr.files = [{ filename: "docs/RELEASE.md", previous_filename: filename }];
      expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
    }
  });
  test("DB-R2 injected equal identities cannot bypass the bot review branch", async () => {
    const runtime = new SourceRuntime({ ...driverConfig(), bot: config.founder }, true);
    runtime.subject = "fix(qualification): routine repair";
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
  });
  test("round-three GR-R1 approval must cover the landed squash tree, not a later PR head", async () => {
    const runtime = new SourceRuntime(driverConfig(), true);
    runtime.subject = "fix(qualification): reviewed routine repair";
    runtime.sourcePr = pr({ merged: true, mergedBy: config.bot, mergeTree: "d".repeat(40),
      files: [{ filename: "scripts/provision-linux-qual.sh" }] });
    runtime.reviews = [
      { id: 1, user: { login: config.founder }, state: "DISMISSED", commit_id: "old-landed-head" },
      { id: 2, user: { login: config.founder }, state: "APPROVED", commit_id: runtime.sourcePr.head },
    ];
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
    runtime.sourcePr.mergeTree = runtime.sourcePr.tree;
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(true);
    runtime.reviews.push({ id: 3, user: { login: config.founder }, state: "DISMISSED", commit_id: runtime.sourcePr.head });
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
    runtime.reviews.pop();
    delete runtime.sourcePr.mergeTree;
    expect((await runtime.authority(state(), state().selectedMain)).sourceReviewed).toBe(false);
  });
  test("runtime and policy admit the exact requested minor class, not an arbitrary minor jump", async () => {
    const runtime = new SourceRuntime(driverConfig(), true);
    runtime.subject = "fix(gateway): immutable reviewed fix";
    const minor = { ...state(), previousStable: "v0.7.7", version: "0.8.0", candidate: "v0.8.0-prealpha.1",
      issue: { ...issue, releaseClass: "minor" as const } };
    const observed = await runtime.authority(minor, minor.selectedMain);
    expect(routineSourceHold(observed)).toBeUndefined();
    expect(routineSourceHold(await runtime.authority({ ...minor, version: "0.9.0" }, minor.selectedMain))).toBe("out-of-class");
    expect(routineSourceHold(await runtime.authority({ ...minor, issue }, minor.selectedMain))).toBe("out-of-class");
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

test("diagnostic re-selection keeps the successful open request after a main fix", () => {
  const failed = { ...state("diagnostic-required"), failedMain: "a".repeat(40), candidateCommit: "b".repeat(40) };
  const repo = snapshot({ main: "d".repeat(40), tags: ["v0.7.5-prealpha.1"], issues: [{ ...issue, request: "43:1" }] });
  expect(nextStep(failed, { ...repo, hostRecoveryRequired: true }, config).operation).toBe("idle");
  expect(nextStep(failed, { ...repo, main: failed.failedMain }, config).operation).toBe("idle");
  expect(nextStep(failed, { ...repo, issues: [issue] }, config).operation).toBe("rerequest");
  expect(nextStep(failed, { ...repo, issues: [] }, config).operation).toBe("idle");
  expect(nextStep(failed, { ...repo, issues: [{ ...issue, request: "legacy-created-at" }] }, config).operation).toBe("idle");
  const step = nextStep(failed, repo, config);
  expect(step.operation).toBe("rerequest");
  if (step.operation !== "idle") { expect(step.patch?.candidate).toBe("v0.7.5-prealpha.2"); expect(step.patch?.candidateCommit).toBeUndefined(); }
});

test.each([true, false])("late campaign failure observes its own source, not already-fixed main (candidate bound: %s)", async bound => {
  const fake = new FakeDriver();
  fake.state = { ...state("qualifying"), sequence: 7, ...(bound ? { candidateCommit: "b".repeat(40) } : {}) };
  fake.repo.main = "d".repeat(40);
  fake.repo.campaign = { status: "failed" };
  expect(fake.state.failedMain).toBeUndefined();
  expect((await tick(fake, config)).operation).toBe("stop");
  expect(fake.state.failedMain).toBe(bound ? "b".repeat(40) : fake.state.selectedMain);
  expect((await tick(fake, config)).operation).toBe("rerequest");
});

test("consuming a campaign failure on unchanged candidate main cannot trigger a retry", async () => {
  const fake = new FakeDriver();
  fake.state = { ...state("qualifying"), candidateCommit: "b".repeat(40) };
  fake.repo.main = fake.state.candidateCommit!;
  fake.repo.campaign = { status: "failed" };
  expect((await tick(fake, config)).operation).toBe("stop");
  expect((await tick(fake, config)).operation).toBe("idle");
});

test("stale unmerged prepare retires its selection without reusing its branch or clearing other holds", () => {
  const failed = { ...state("held"), holdReason: "stale-source" as const, preparePr: 401 };
  const repo = snapshot({ main: "d".repeat(40), prepare: pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-prepare" }) });
  const step = nextStep(failed, repo, config);
  expect(step.operation).toBe("rerequest");
  if (step.operation !== "idle") {
    expect(step.patch?.candidate).toBe("v0.7.5-prealpha.2");
    expect(step.patch?.retired?.[0]).toMatchObject({ candidate: failed.candidate, reason: "stale-source", issue: 400, preparePr: 401 });
    expect(step.patch?.holdReason).toBeUndefined();
  }
  expect(nextStep(failed, { ...repo, main: failed.selectedMain }, config).operation).toBe("idle");
  expect(nextStep(failed, { ...repo, prepare: pr({ merged: true }) }, config).operation).toBe("idle");
  expect(nextStep({ ...failed, holdReason: "authority-path-changed" }, repo, config).operation).toBe("idle");
});

test("diagnostic rerequests cannot change the pinned release class", () => {
  const failed = { ...state("diagnostic-required"), failedMain: "a".repeat(40) };
  const minor = { ...issue, request: "43:1", releaseClass: "minor" as const };
  expect(nextStep(failed, snapshot({ main: "d".repeat(40), issues: [minor] }), config).operation).toBe("idle");
  const minorFailed = { ...failed, issue: { ...issue, releaseClass: "minor" as const }, version: "0.8.0", candidate: "v0.8.0-prealpha.1" };
  expect(nextStep(minorFailed, snapshot({ main: "d".repeat(40), issues: [{ ...issue, request: "43:1" }] }), config).operation).toBe("idle");
  const step = nextStep(minorFailed, snapshot({ main: "d".repeat(40), issues: [minor], tags: ["v0.8.0-prealpha.1"] }), config);
  expect(step.operation).toBe("rerequest");
  if (step.operation !== "idle") expect(step.patch?.candidate).toBe("v0.8.0-prealpha.2");
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

function automaticCampaign(): DriverState {
  const selected = { ...heldCampaign().selected, phase: "qualifying" as const };
  delete selected.infrastructureHold;
  selected.qualificationExecution = campaignExecution(selected);
  return selected;
}
function automaticFailure(selected: DriverState, summary?: QualificationFailureSummary): CampaignFailureObservation {
  return { jobSha256: "a".repeat(64), outcomeSha256: "b".repeat(64), restartLanes: [], outcome: {
    formatVersion: 1, outcome: "qualification-failed", scope: "preflight", execution: campaignExecution(selected),
    failureSummary: summary ?? {
      failures: [{ id: 1, lane: "preflight", step: "macos", reason: "connection_timeout", class: "infra_transient",
        elapsedMs: 50, operation: "read_only", observations: { transportFailure: true } }],
      timings: { attemptMs: 100, cleanupMs: 0 }, containment: { proven: true, cleanupComplete: true, unresolvedMutation: false },
    },
  } };
}
function scheduledRetry(selected: DriverState, evidence = automaticFailure(selected), now = 1_000): { step: Decision; next: DriverState } {
  const step = nextStep(selected, snapshot({ campaign: { status: "failed", campaignFailure: evidence } }), config, "2026-10-25", now);
  if (step.operation !== "schedule-campaign-retry") throw new Error("expected retry scheduling: " + step.detail);
  return { step, next: { ...applyDecisionPatch(selected, step), phase: step.phase } };
}

describe("automatic same-candidate campaign retry state machine", () => {
  test("514 R1 a restored post-remedy GCM refusal stops diagnostic-required without another ordinal", () => {
    const selected = automaticCampaign(), failure = automaticFailure(selected);
    const campaignFailure: CampaignFailureObservation = { ...failure, outcome: { ...failure.outcome, scope: "campaign",
      receipt: { sha256: "b".repeat(64), cleanupDisposition: "restored" },
      failureSummary: { ...failure.outcome.failureSummary, failures: [{
        id: 1, lane: "rigReadiness", step: "pixel_push", reason: "gcm_disconnected", class: "infra_transient",
        elapsedMs: 32_000, operation: "read_only", observations: { gcmConnected: false, gcmRemedyApplied: true },
      }] } } };
    const step = nextStep(selected, snapshot({ campaign: { status: "failed", campaignFailure } }), config);
    expect(step.operation).toBe("stop");
    if (step.operation === "idle") throw new Error("expected diagnostic stop");
    expect(step.phase).toBe("diagnostic-required");
    expect(step.patch?.campaignAttempt).toBeUndefined();
    expect(step.patch?.retryNotBefore).toBeUndefined();
    expect(step.detail).toContain("rigReadiness:infra_transient:gcm_disconnected");
  });
  test("infra failures allocate 1 then 2, persist 60/120-second deadlines, then exhaust", () => {
    let selected = automaticCampaign();
    const identity = [selected.candidate, selected.candidateCommit, selected.candidateDigest, selected.previousStable, selected.macHost, selected.authorityPolicy];
    for (const ordinal of [1, 2]) {
      const { next, step } = scheduledRetry(selected);
      expect(campaignAttempt(next)).toBe(ordinal - 1);
      expect(next.retryNotBefore).toBe(1_000 + ordinal * 60_000);
      expect(step.detail).toContain(`delayMs=${ordinal * 60_000}`);
      expect([next.candidate, next.candidateCommit, next.candidateDigest, next.previousStable, next.macHost, next.authorityPolicy]).toEqual(identity);
      const repo = snapshot({ authority: { ...authority, policy: next.authorityPolicy! } });
      expect(nextStep(next, repo, config, undefined, next.retryNotBefore! - 1).operation).toBe("idle");
      expect(nextStep(next, repo, config, undefined, next.retryNotBefore!).operation).toBe("start-campaign");
      expect(nextStep({ ...selected, intent: JSON.parse(JSON.stringify(step)) }, snapshot(), config, undefined, 999_999)).toEqual(step);
      selected = { ...campaignRetryLaunchState(next), phase: "qualifying" };
    }
    const exhausted = nextStep(selected, snapshot({ campaign: { status: "failed", campaignFailure: automaticFailure(selected) } }), config);
    expect(exhausted.operation).toBe("stop");
    if (exhausted.operation !== "idle") expect(exhausted.phase).toBe("diagnostic-required");
    expect(exhausted.detail).toContain("attempt=2; retry exhausted");
    expect(exhausted.detail).toContain("preflight:infra_transient:connection_timeout");
  });
  test.each(["product", "harness", "unknown", "mixed", "dirty", "mutation", "collateral-only", "dangling"] as const)(
    "%s failures stop without scheduling or spending another ordinal", kind => {
      const selected = automaticCampaign(), failure = automaticFailure(selected);
      const summary = { ...failure.outcome.failureSummary, failures: [...failure.outcome.failureSummary.failures] };
      const harness = { id: 2, lane: "campaign", step: "execution", class: "harness", reason: "unclassified_failure",
        operation: "read_only", elapsedMs: 0, observations: {} } as const;
      if (kind === "product") summary.failures = [{ ...harness, lane: "androidPush", step: "private_verified", class: "product", reason: "assertion_failed" }];
      if (kind === "harness") summary.failures = [harness];
      if (kind === "unknown") summary.failures = [{ ...harness, class: "unrecognized" } as never];
      if (kind === "mixed") summary.failures = [...summary.failures, harness];
      if (kind === "dirty") summary.containment = { ...summary.containment, cleanupComplete: false };
      if (kind === "mutation") summary.containment = { ...summary.containment, unresolvedMutation: true };
      if (kind === "collateral-only" || kind === "dangling") {
        const collateral = { ...harness, class: "collateral", reason: "dependency_failed", originIds: [99] } as const;
        summary.failures = kind === "collateral-only" ? [collateral] : [...summary.failures, collateral];
      }
      const campaignFailure = { ...failure, outcome: { ...failure.outcome, scope: "campaign" as const, failureSummary: summary,
        receipt: { sha256: "b".repeat(64), cleanupDisposition: kind === "dirty" || kind === "mutation" ? "unresolved" as const : "restored" as const } } };
      const step = nextStep(selected, snapshot({ campaign: { status: "failed", campaignFailure } }), config);
      expect(step.operation).toBe("stop");
      if (kind === "product") expect(step.detail).toContain("androidPush:product:assertion_failed");
      if (kind === "harness" || kind === "mixed") expect(step.detail).toContain("campaign:harness:unclassified_failure");
      if (step.operation !== "idle") expect(step.patch?.campaignAttempt).toBeUndefined();
    },
  );
  test("missing evidence, bare exit 75/143 and unknown outcome fields never authorize retry", () => {
    const selected = automaticCampaign(), valid = automaticFailure(selected);
    for (const campaign of [
      { status: "absent" as const }, { status: "failed" as const, detail: "exit 75" }, { status: "failed" as const, detail: "exit 143" },
      { status: "failed" as const, campaignFailure: { ...valid, raw: "PRIVATE-DIAGNOSTIC-CANARY" } },
      { status: "failed" as const, campaignFailure: { ...valid, outcome: { ...valid.outcome, raw: "PRIVATE-DIAGNOSTIC-CANARY" } } },
    ]) expect(nextStep(selected, snapshot({ campaign }), config).operation).toBe("stop");
  });
  test.each(["candidate", "candidateCommit", "candidateDigest", "previousStable", "authorityPolicy", "macHost"] as const)(
    "persisted retry plan refuses changed %s", field => {
      const { next } = scheduledRetry(automaticCampaign());
      const changed = { ...next, [field]: field === "macHost" ? "other@fixture.invalid" : "changed" };
      expect(() => parseCampaignRetryPlan(changed.retryPlan, changed)).toThrow();
      expect(nextStep(changed, snapshot(), config, undefined, 1_000_000).operation).toBe("stop");
    },
  );
  test("pending retry refuses changed authority, publication and invalid reconciliation", () => {
    const { next } = scheduledRetry(automaticCampaign());
    expect(nextStep(next, snapshot({ authority: { ...authority, policy: "2".repeat(64) } }), config, undefined, 1_000_000).holdReason).toBe("policy-changed");
    for (const change of [{ tags: [`v${next.version}`] }, { campaignRetryInvalid: true }, { latestStable: `v${next.version}` }]) {
      expect(nextStep(next, snapshot(change), config, undefined, 1_000_000).operation).toBe("stop");
    }
  });
  test("legacy holds remain manual; new executions cannot acquire legacy authority", async () => {
    const { selected, hold } = heldCampaign();
    expect(nextStep(selected, snapshot(), config).operation).toBe("idle");
    const fresh = automaticCampaign();
    expect(nextStep(fresh, snapshot({ campaign: { status: "infrastructure-hold", availabilityHold: hold } }), config).operation).toBe("stop");
    expect(nextStep({ ...fresh, qualificationExecution: undefined }, snapshot({
      campaign: { status: "failed", campaignFailure: automaticFailure(fresh) },
    }), config).operation).toBe("stop");
    const runtime = new RetryDriver(driverConfig(), false);
    runtime.current.qualificationExecution = campaignExecution(runtime.current);
    await expect(runtime.authorizeDeviceCloudRetry(selected.candidate, 0)).rejects.toThrow("exact held candidate");
  });
  test("only a new candidate selection resets exhausted budget and clears every retry authority field", () => {
    const first = scheduledRetry(automaticCampaign()).next;
    const second = scheduledRetry({ ...campaignRetryLaunchState(first), phase: "qualifying" }).next;
    const failed = { ...campaignRetryLaunchState(second), phase: "diagnostic-required" as const, failedMain: second.candidateCommit };
    expect(nextStep(failed, snapshot({ main: failed.failedMain! }), config).operation).toBe("idle");
    const step = nextStep(failed, snapshot({ main: "d".repeat(40) }), config);
    expect(step.operation).toBe("rerequest");
    if (step.operation === "idle") throw new Error("missing rerequest");
    const next = applyDecisionPatch(failed, step);
    expect(next.campaignAttempt).toBe(0);
    expect(next.candidate).not.toBe(failed.candidate);
    for (const key of ["qualificationExecution", "retryPlan", "retryNotBefore", "infrastructureHold", "resumeDeviceCloud"]) expect(Object.hasOwn(next, key)).toBe(false);
  });
  test.each(["intent", "outbox"] as const)("%s crash replay allocates and announces only once", async point => {
    const fake = new FakeDriver();
    fake.state = automaticCampaign();
    fake.repo.campaign = { status: "failed", campaignFailure: automaticFailure(fake.state) };
    if (point === "intent") fake.failSave = 2;
    else fake.crashAfterComment = true;
    await expect(tick(fake, config)).rejects.toThrow("simulated");
    await tick(fake, config);
    expect(campaignAttempt(fake.state)).toBe(0);
    expect(fake.state.phase).toBe("retry-pending");
    expect(fake.performed).toEqual(["schedule-campaign-retry"]);
    expect(fake.commentWrites).toBe(1);
    expect(fake.state.intent).toBeUndefined();
    expect(fake.state.announcement).toBeUndefined();
    const body = [...fake.comments.values()][0]!;
    expect(body).toContain("preflight:infra_transient:connection_timeout");
    expect(body).not.toContain(fake.state.macHost!);
    expect(body).not.toContain(fake.state.candidateDigest!);
  });
  test("eventual success preserves existing promotion, smoke and record gates", async () => {
    const fake = new FakeDriver();
    const { next } = scheduledRetry(automaticCampaign());
    fake.state = { ...campaignRetryLaunchState(next), phase: "qualifying", authorityPolicy: authority.policy };
    fake.repo.campaign = { status: "passed" };
    expect((await tick(fake, config)).operation).toBe("finish-campaign");
    expect(fake.state.campaignAttempt).toBe(1);
    expect((await tick(fake, config)).operation).toBe("open-approve");
    expect((await tick(fake, config)).operation).toBe("start-approve-checks");
    expect((await tick(fake, config)).operation).toBe("finish-approve-checks");
    fake.repo.approve!.checksPassed = false;
    expect((await tick(fake, config)).holdReason).toBe("required-checks-missing");
    fake.repo.approve!.checksPassed = true;
    for (const operation of ["merge-approve", "tag-stable", "observe-stable", "verify-stable", "start-smoke", "finish-smoke", "open-record", "merge-record", "close"] as const) {
      expect((await tick(fake, config)).operation).toBe(operation);
    }
  });
  test("worker arguments bind execution and consume receipt retries before preflight", () => {
    const first = automaticCampaign();
    expect(campaignWorkerArguments(first, "/private/execution.json", true)).toEqual(["--execution-file", "/private/execution.json", "--preflight"]);
    const failure = automaticFailure(first);
    const receiptFailure = { ...failure, restartLanes: ["windows" as const], outcome: { ...failure.outcome, scope: "campaign" as const,
      receipt: { sha256: "b".repeat(64), cleanupDisposition: "restored" as const } } };
    const next = campaignRetryLaunchState(scheduledRetry(first, receiptFailure).next);
    expect(campaignWorkerArguments(next, "/private/execution.json")).toEqual(["--execution-file", "/private/execution.json", "--retry-receipt-sha256", "b".repeat(64)]);
    expect(() => campaignWorkerArguments(next, "/private/execution.json", true)).toThrow("before admission");
    const preflightRetry = campaignRetryLaunchState(scheduledRetry(first).next);
    expect(campaignWorkerArguments(preflightRetry, "/private/execution.json")).toEqual([
      "--execution-file", "/private/execution.json", "--retry-outcome-file", join("/private", "retry-preflight-outcome.json"),
      "--retry-outcome-sha256", preflightRetry.retryPlan!.outcomeSha256,
    ]);
    expect(campaignWorkerArguments({ ...heldCampaign().selected, resumeDeviceCloud: true }, "")).toEqual(["--resume-device-cloud"]);
  });
  test.each([1, 2])("receiptless retry %i cannot request standalone preflight", attempt => {
    let selected = automaticCampaign();
    for (let ordinal = 0; ordinal < attempt; ordinal++) {
      selected = { ...campaignRetryLaunchState(scheduledRetry(selected).next), phase: "qualifying" };
    }
    expect(() => campaignWorkerArguments(selected, "/private/execution.json", true)).toThrow("before admission");
  });
});

class AutomaticRuntime extends StudioDriver {
  current = automaticCampaign();
  active = false;
  activeAttempt: number | undefined;
  owner: string | undefined;
  published = false;
  changedPolicy = false;
  changedSource = false;
  changedDigest = false;
  receiptPath = "";
  approvalExists = false;
  override async pages<T>(path: string): Promise<T[]> {
    return (path.startsWith("tags?") ? [{ name: this.current.previousStable }] :
      this.approvalExists && path.includes("-approve") ? [{}] : []) as T[];
  }
  override async issues() { return [this.current.issue]; }
  override releaseHostLeasePath() { return join(this.config.stateDir, "lease", "lease.sqlite"); }
  override async campaignWorkerRunning(selected: DriverState) { return this.active || campaignAttempt(selected) === this.activeAttempt; }
  override async releaseHostOwner() { return this.owner; }
  override receipt() { return this.receiptPath; }
  override async readPr() { return pr({ merged: true, mergeCommit: this.changedSource ? "d".repeat(40) : this.current.candidateCommit }); }
  override async authority() { return { ...authority, policy: this.changedPolicy ? "2".repeat(64) : this.current.authorityPolicy! }; }
  override async candidateSupportsExecution() { return true; }
  override campaignRetryLanes(receipt: StableQualificationReceipt, selected: DriverState) {
    return assertCampaignRetryEligible(receipt, campaignExecution(selected), retryReceiptModules);
  }
  override campaignCleanupComplete(receipt: StableQualificationReceipt, selected: DriverState) {
    assertCampaignCleanupComplete(receipt, campaignExecution(selected), retryReceiptModules);
  }
  override async api<T>(path: string): Promise<T | undefined> {
    const current = this.current;
    return (path === "commits/main" ? { sha: current.candidateCommit }
      : path === "contents/UPSTREAM.lock.json?ref=main" ? { content: Buffer.from(JSON.stringify({ tag: requestVersion(current.issue) })).toString("base64") }
      : path === "releases/latest" ? { tag_name: current.previousStable }
      : path === `git/ref/tags/${current.candidate}` ? { ref: `refs/tags/${current.candidate}`, object: { sha: "a".repeat(40), type: "tag" } }
      : path === `git/tags/${"a".repeat(40)}` ? { tag: current.candidate, object: { type: "commit", sha: current.candidateCommit }, verification: { verified: true, reason: "valid" } }
      : path === `releases/tags/${current.candidate}` ? { draft: false, prerelease: true, assets: [
        { name: `omp-session-gateway-${current.version}-bun.tar`, digest: `sha256:${this.changedDigest ? "0".repeat(64) : current.candidateDigest}` },
      ] } : this.published ? { exists: true } : undefined) as T | undefined;
  }
}
async function completedAutomaticJob(root: string, withReceipt: boolean | "readiness" = false) {
  root = await realpath(root);
  const runtime = new AutomaticRuntime(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
  runtime.receiptPath = join(root, "stable-qualification.json");
  const selected = runtime.current;
  let evidence = automaticFailure(selected);
  let receipt: StableQualificationReceipt | undefined;
  if (withReceipt) {
    receipt = withReceipt === "readiness" ?
      createStableQualificationReceipt(selected.candidate, selected.candidateCommit!, selected.previousStable!) : receiptScopedCampaign(selected).receipt;
    receipt.status = "failed";
    receipt.execution = selected.qualificationExecution!;
    receipt.completedAt = "2026-10-25T00:01:00.000Z";
    const windowsFailure = { id: 1, lane: "windows", step: "transport_ready", class: "infra_transient", reason: "probe_deadline",
      elapsedMs: 50, operation: "read_only", observations: { controllerDeadline: true, readOnlyProbe: true } } as const;
    if (withReceipt === "readiness") {
      receipt.macHost = selected.macHost!;
      receipt.candidate = { tag: selected.candidate, sourceCommit: selected.candidateCommit!, archiveSha256: selected.candidateDigest! };
      receipt.predecessor = { tag: selected.previousStable!, sourceCommit: "c".repeat(40), archiveSha256: "d".repeat(64) };
      receipt.lanes.artifacts = { status: "passed", attempts: 1, evidence: {} };
      receipt.rigReadiness = { status: "failed", campaignAttempt: 0, observations: { baselineRestored: true }, timings: { macos: 50 },
        cleanupDisposition: "restored", epoch: "11111111-2222-4333-8444-555555555555", phase: "macos" };
      receipt.failureSummary = { ...evidence.outcome.failureSummary, failures: [{
        id: 1, lane: "rigReadiness", step: "macos", class: "infra_transient", reason: "connection_timeout",
        elapsedMs: 50, operation: "read_only", observations: { transportFailure: true },
      }] };
      receipt.lanes.cleanup = { status: "passed", attempts: 1, evidence: { restored: true } };
    } else {
      receipt.lanes.deviceCloud.status = "passed";
      delete receipt.lanes.deviceCloud.evidence!.availabilityHold;
      receipt.lanes.windows.status = "failed";
      receipt.lanes.windows.failure = [windowsFailure];
      receipt.failureSummary = { ...evidence.outcome.failureSummary, failures: [windowsFailure] };
    }
    evidence = { ...evidence, outcome: { ...evidence.outcome, scope: withReceipt === "readiness" ? "rigReadiness" : "campaign", failureSummary: receipt.failureSummary,
      receipt: { sha256: createHash("sha256").update(JSON.stringify(receipt) + "\n").digest("hex"), cleanupDisposition: "restored" } } };
    runtime.owner = `qualification:${selected.candidate}:${runtime.receiptPath}`;
    await writeFile(runtime.receiptPath, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    await expect(withReleaseHostLease(runtime.owner, async () => { throw new Error("retained fixture owner"); },
      join(root, "lease"))).rejects.toThrow("retained fixture owner");
  }
  const directory = runtime.jobDirectory("campaign", selected);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "spec.json"), JSON.stringify({ kind: "campaign", state: selected, root: join(import.meta.dir, "..") }) + "\n", { mode: 0o600 });
  await writeFile(join(directory, "result.json"), '{"status":"failed"}\n', { mode: 0o600 });
  await writeFile(join(directory, "exit"), "75\n", { mode: 0o600 });
  await writeFile(join(directory, "out.log"), "fixed stdout fixture\n", { mode: 0o600 });
  await writeFile(join(directory, "err.log"), "fixed stderr fixture\n", { mode: 0o600 });
  await writeFile(join(directory, "qualification-out.log"), "fixed qualification stdout fixture\n", { mode: 0o600 });
  await writeFile(join(directory, "qualification-err.log"), "fixed qualification stderr fixture\n", { mode: 0o600 });
  await writeQualificationOutcomeFile(join(directory, "failure-outcome.json"), evidence.outcome);
  if (receipt !== undefined) await writeFile(join(directory, "failed-qualification.json"), await readFile(runtime.receiptPath), { mode: 0o600 });
  const observed = await runtime.completedCampaignFailure(selected);
  return { runtime, directory, receipt, ...scheduledRetry(selected, observed) };
}

describe("council R1 retry authority counterexamples", () => {
  test("allocation retains the failed attempt until a retry job is launched", () => {
    const selected = automaticCampaign(), { next } = scheduledRetry(selected);
    expect(next.campaignAttempt ?? 0).toBe(0);
    expect(next.qualificationExecution).toEqual(selected.qualificationExecution);
    expect(next.retryPlan?.nextAttempt).toBe(1);
  });
  test("pending diagnostics bind failedMain to the executed candidate, not newer main", () => {
    const selected = automaticCampaign(), { next } = scheduledRetry(selected);
    const step = nextStep(next, snapshot({ main: "d".repeat(40), campaignRetryInvalid: true }), config);
    expect(step.operation).toBe("stop");
    if (step.operation !== "idle") expect(step.patch?.failedMain).toBe(selected.candidateCommit);
  });
  test("a schedule revalidation race stops instead of refreshing the backoff forever", async () => {
    class Invalidated extends FakeDriver {
      override async perform(): Promise<Partial<DriverState>> { throw new StaleIntentError("campaign retry evidence is missing or changed"); }
    }
    const fake = new Invalidated();
    fake.state = automaticCampaign();
    fake.repo.campaign = { status: "failed", campaignFailure: automaticFailure(fake.state) };
    expect((await tick(fake, config)).operation).toBe("stop");
    expect(fake.state.phase).toBe("diagnostic-required");
    expect(fake.state.campaignAttempt ?? 0).toBe(0);
    expect(fake.state.intent).toBeUndefined();
  });
  test("receipt retry authority requires a nonempty exact restart set", () => {
    const selected = automaticCampaign(), evidence = automaticFailure(selected);
    const campaignFailure = { ...evidence, outcome: { ...evidence.outcome, scope: "campaign" as const,
      receipt: { sha256: "b".repeat(64), cleanupDisposition: "restored" as const } } };
    expect(nextStep(selected, snapshot({ campaign: { status: "failed", campaignFailure } }), config).operation).toBe("stop");
  });
  test("preflight evidence cannot simultaneously claim a receipt", () => {
    const selected = automaticCampaign(), evidence = automaticFailure(selected);
    const campaignFailure = { ...evidence, outcome: { ...evidence.outcome,
      receipt: { sha256: "b".repeat(64), cleanupDisposition: "restored" as const } } };
    expect(nextStep(selected, snapshot({ campaign: { status: "failed", campaignFailure } }), config).operation).toBe("stop");
  });
  test("generic failed observations cannot borrow a typed infrastructure outcome", () => {
    const selected = automaticCampaign();
    const campaign: JobObservation = { status: "failed", detail: "campaign harness:unclassified_failure",
      campaignFailure: automaticFailure(selected) };
    expect(nextStep(selected, snapshot({ campaign }), config).operation).toBe("stop");
  });
  test.each([
    { protectedChanges: ["scripts/release-driver.ts"] }, { sourceReviewed: false, unreviewedCommit: "d".repeat(40) },
    { sourceFresh: false }, { releaseClassAllowed: false },
  ])("pending retry applies every routine source-authority guard: %j", change => {
    const { next } = scheduledRetry(automaticCampaign());
    const currentAuthority = { ...authority, policy: next.authorityPolicy!, ...change,
      protectedChanges: [...(change.protectedChanges ?? authority.protectedChanges)] };
    const step = nextStep(next, snapshot({ authority: currentAuthority }), config, undefined, 1_000_000);
    expect(step.holdReason).toBe(routineSourceHold(currentAuthority, next.authorityPolicy));
    if ("unreviewedCommit" in change && step.operation !== "idle") expect(step.patch?.holdCommit).toBe(change.unreviewedCommit);
  });
});

async function automaticWorkerFixture(root: string, exitCode: number, selected = automaticCampaign(), kind: "campaign" | "smoke" = "campaign") {
  process.exitCode = 0; // Each production worker starts in its own process.
  root = await realpath(root);
  const checkout = join(root, "checkout"), bin = join(root, "bin");
  await mkdir(checkout); await mkdir(bin);
  await writeFile(join(bin, "security"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "retry-worker-fixture", scripts: { "qualify:stable": "bun fixture.ts", "smoke:release": "bun fixture.ts" } }));
  const install = Bun.spawn([process.execPath, "install", "--lockfile-only"], { cwd: checkout, stdout: "ignore", stderr: "pipe" });
  const installError = await new Response(install.stderr).text();
  expect(await install.exited, installError).toBe(0);
  class Worker extends AutomaticRuntime {
    override async authenticate() {}
    override async checkout() { return checkout; }
    override async git() { return this.current.candidateCommit!; }
    override async push() {}
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const runtime = new Worker(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
  process.env.PATH = previousPath;
  runtime.current = selected;
  runtime.receiptPath = join(root, "stable-qualification.json");
  const directory = runtime.jobDirectory(kind, selected);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const original = JSON.stringify(automaticFailure(selected).outcome, null, 4) + "\n\n";
  await writeFile(join(checkout, "fixture.ts"), `import { writeFile } from "node:fs/promises";
await writeFile(process.env.OMP_STABLE_OUTCOME_FILE!, ${JSON.stringify(original)}, { mode: 0o600 });
process.exitCode = ${exitCode};\n`);
  await writeFile(join(directory, "spec.json"), JSON.stringify({ kind, state: selected, root: join(import.meta.dir, "..") }));
  await writeFile(join(directory, "out.log"), "", { mode: 0o600 });
  await writeFile(join(directory, "err.log"), "", { mode: 0o600 });
  return { runtime, directory, original, checkout, bin };
}

describe.skipIf(process.platform === "win32")("private smoke worker output", () => {
  test.each([[0, false], [0, true], [1, false], [1, true]] as const)(
    "smoke worker retains child bytes for exit=%i bounded=%s",
    async (exitCode, bounded) => {
      const root = await mkdtemp(join(tmpdir(), "smoke-output-")), previousExit = process.exitCode;
      try {
        const selected = automaticCampaign();
        selected.stableCommit = selected.candidateCommit;
        selected.stableDigest = "a".repeat(64);
        const { runtime, directory, checkout, bin } = await automaticWorkerFixture(root, exitCode, selected, "smoke");
        const home = join(root, "home"), installation = join(home, ".local/state/omp-session-gateway/installation");
        const bunDirectory = join(home, ".local/lib/omp-session-gateway/bun/v1.4.0");
        await mkdir(installation, { recursive: true }); await mkdir(bunDirectory, { recursive: true });
        await writeFile(join(installation, "current.json"), JSON.stringify({ versionDirectory: "0.0.0-aaaaaaaaaaaa" }));
        await writeFile(join(bunDirectory, "bun"), "#!/bin/sh\nprintf '%s\\n' '{\"fixture\":true}'\n", { mode: 0o700 });
        const out = exitCode === 0 ? Buffer.from(JSON.stringify({ padding: "x".repeat(bounded ? 300_000 : 2), smoke: true }) + "\r\n ")
          : Buffer.concat([Buffer.alloc(bounded ? 300_000 : 2, 0xff), Buffer.from(" PRIVATE-SMOKE-STDOUT-CANARY \r\n\0 ")]);
        const err = Buffer.concat([Buffer.alloc(bounded ? 300_000 : 2, 0xfe), Buffer.from(" Error: PRIVATE-SMOKE-ERROR-CANARY \r\n\0 ")]);
        await writeFile(join(checkout, "fixture.ts"), `
if (process.env.OMP_RELEASE_SMOKE_LOG_DIR !== ${JSON.stringify(join(directory, "smoke-logs"))}) throw new Error("smoke log destination was not bound");
await Bun.write(Bun.stdout, Buffer.from(${JSON.stringify(out.toString("base64"))}, "base64"));
await Bun.write(Bun.stderr, Buffer.from(${JSON.stringify(err.toString("base64"))}, "base64"));
process.exitCode = ${exitCode};
`);
        const child = Bun.spawn([process.execPath, "run", "smoke:release", "--", "--tag", `v${selected.version}`,
          "--archive-sha256", selected.stableDigest, "--force-reinstall", "--rebuild-omp"], {
          cwd: checkout, env: { ...process.env, OMP_RELEASE_SMOKE_LOG_DIR: join(directory, "smoke-logs") },
          stdout: "pipe", stderr: "pipe", stdin: "ignore",
        });
        const [expectedOut, expectedErr, expectedExit] = await Promise.all([
          new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(), child.exited,
        ]);
        expect(expectedExit).toBe(exitCode);
        // Bun caches homedir(): HOME must be bound before the worker process starts,
        // not changed in the test process after importing the runtime.
        const worker = Bun.spawn([process.execPath, "--eval", `
import { StudioDriver, driverConfig } from ${JSON.stringify(join(import.meta.dir, "release-driver-runtime.ts"))};
class Worker extends StudioDriver {
  override async authenticate() {}
  override async checkout() { return ${JSON.stringify(checkout)}; }
  override async git() { return ${JSON.stringify(selected.stableCommit)}; }
}
await new Worker(driverConfig(), false).worker(${JSON.stringify(join(directory, "spec.json"))});
`], {
          cwd: checkout, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, OMP_RELEASE_STATE_DIR: runtime.config.stateDir },
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        const [workerOut, workerErr, workerExit] = await Promise.all([
          new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited,
        ]);
        expect(workerExit, workerErr).toBe(exitCode);
        expect(workerOut + workerErr).not.toContain("CANARY");
        for (const [name, bytes] of [["smoke-out.log", expectedOut], ["smoke-err.log", expectedErr]] as const) {
          expect(await readFile(join(directory, name))).toEqual(Buffer.from(bytes).subarray(-262_144));
          expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
        }
        const terminal = await readFile(join(directory, "result.json"), "utf8");
        expect(JSON.parse(terminal).status).toBe(exitCode === 0 ? "passed" : "failed");
        expect(terminal).not.toContain("CANARY");
        if (exitCode === 0) {
          expect(await Bun.file(join(directory, "smoke-failure.json")).exists()).toBe(false);
          expect(await Bun.file(join(directory, "smoke.json")).json()).toEqual(JSON.parse(out.toString()));
          expect(await Bun.file(join(directory, "status.json")).json()).toEqual({ fixture: true });
        }
        else {
          expect(await readFile(join(directory, "smoke-failure.json"), "utf8")).toContain("release smoke failed");
          expect((await lstat(join(directory, "smoke-failure.json"))).mode & 0o777).toBe(0o600);
          expect(JSON.parse(await readFile(join(directory, "diagnostic.json"), "utf8"))).toEqual({ class: "harness", reason: "unclassified_failure" });
        }
      } finally {
        process.exitCode = previousExit ?? 0;
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  test("smoke failure before spawning retains empty logs and the original cause chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "smoke-unstarted-")), previousExit = process.exitCode;
    try {
      const { runtime, directory } = await automaticWorkerFixture(root, 1, automaticCampaign(), "smoke");
      runtime.authenticate = async () => { throw new Error("ORIGINAL-AUTH-ERROR", { cause: new Error("ORIGINAL-AUTH-CAUSE") }); };
      await runtime.worker(join(directory, "spec.json"));
      for (const name of ["smoke-out.log", "smoke-err.log"]) expect(await readFile(join(directory, name))).toEqual(Buffer.alloc(0));
      const diagnostic = await readFile(join(directory, "smoke-failure.json"), "utf8");
      expect(diagnostic).toContain("ORIGINAL-AUTH-ERROR");
      expect(diagnostic).toContain("ORIGINAL-AUTH-CAUSE");
      expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(262_144);
      expect(await readFile(join(directory, "result.json"), "utf8")).not.toContain("ORIGINAL-AUTH");
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test.each(["smoke-out.log", "smoke-err.log", "smoke-failure.json"])("smoke never overwrites immutable %s", async name => {
    const root = await mkdtemp(join(tmpdir(), "smoke-immutable-")), previousExit = process.exitCode;
    try {
      const { runtime, directory } = await automaticWorkerFixture(root, 1, automaticCampaign(), "smoke");
      runtime.authenticate = async () => { throw new Error("fixture auth refusal"); };
      await writeFile(join(directory, name), "immutable prior bytes");
      await expect(runtime.worker(join(directory, "spec.json"))).rejects.toThrow();
      expect(await readFile(join(directory, name), "utf8")).toBe("immutable prior bytes");
      for (const terminal of ["exit", "result.json"]) expect(await Bun.file(join(directory, terminal)).exists()).toBe(false);
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test.each(["exit", "result.json"])("smoke persists private diagnostics before %s publication", async name => {
    const root = await mkdtemp(join(tmpdir(), "smoke-publication-")), previousExit = process.exitCode;
    try {
      const { runtime, directory } = await automaticWorkerFixture(root, 1, automaticCampaign(), "smoke");
      runtime.authenticate = async () => { throw new Error("fixture auth refusal"); };
      await mkdir(join(directory, name));
      await expect(runtime.worker(join(directory, "spec.json"))).rejects.toThrow();
      expect(await readFile(join(directory, "smoke-out.log"))).toEqual(Buffer.alloc(0));
      expect(await readFile(join(directory, "smoke-err.log"))).toEqual(Buffer.alloc(0));
      expect(await readFile(join(directory, "smoke-failure.json"), "utf8")).toContain("fixture auth refusal");
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
});

async function qualificationFixtureOutput(runtime: AutomaticRuntime, checkout: string, flags: string[]) {
  const child = Bun.spawn([process.execPath, "run", "qualify:stable", "--", "--tag", runtime.current.candidate, ...flags], {
    cwd: checkout, env: { ...process.env, OMP_STABLE_OUTCOME_FILE: join(checkout, "reference-outcome.json") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(), child.exited,
  ]);
  return { out: Buffer.from(out), err: Buffer.from(err), code };
}

describe.skipIf(process.platform === "win32")("council R1 retry runtime counterexamples", () => {
  test("receiptless retry worker consumes authority before its only admission command", async () => {
    const root = await mkdtemp(join(tmpdir(), "retry-admission-command-")), previousExit = process.exitCode;
    try {
      const { next } = await completedAutomaticJob(root);
      const selected = campaignRetryLaunchState(next);
      const { runtime, directory } = await automaticWorkerFixture(root, 1, selected);
      const invocations = join(root, "invocations.jsonl");
      await writeFile(join(root, "checkout", "fixture.ts"), `import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(invocations)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exitCode = 1;\n`);
      await runtime.worker(join(directory, "spec.json"));
      const calls = (await readFile(invocations, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(calls).toEqual([["--tag", selected.candidate, ...campaignWorkerArguments(selected, join(directory, "execution.json"))]]);
      expect(calls[0]).not.toContain("--preflight");
      expect(await readFile(join(directory, "retry-preflight-outcome.json"), "utf8")).toBe(
        await readFile(join(runtime.jobDirectory("campaign", next), "failure-outcome.json"), "utf8"));
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test.each(["exit", "harness-result", "readiness-scope"] as const)(
    "terminal evidence rejects disagreeing %s", async change => {
      const root = await mkdtemp(join(tmpdir(), "retry-terminal-counterexample-"));
      try {
        const { runtime, directory } = await completedAutomaticJob(root, true);
        if (change === "exit") await writeFile(join(directory, "exit"), "1\n");
        if (change === "harness-result") await writeFile(join(directory, "result.json"), JSON.stringify({ status: "failed", detail: "campaign harness:unclassified_failure" }));
        if (change === "readiness-scope") {
          const outcome = JSON.parse(await readFile(join(directory, "failure-outcome.json"), "utf8"));
          outcome.scope = "rigReadiness";
          await writeQualificationOutcomeFile(join(directory, "failure-outcome.json"), outcome);
        }
        expect(await runtime.job("campaign", runtime.current)).toEqual({ status: "failed", detail: "campaign harness:invalid_evidence" });
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
  test.each([1, 143])("worker preserves observed exit %i and withholds infrastructure authority", async exitCode => {
    const root = await mkdtemp(join(tmpdir(), "retry-worker-exit-")), previousExit = process.exitCode;
    try {
      const { runtime, directory } = await automaticWorkerFixture(root, exitCode);
      await runtime.worker(join(directory, "spec.json"));
      expect(await readFile(join(directory, "exit"), "utf8")).toBe(`${exitCode}\n`);
      expect(JSON.parse(await readFile(join(directory, "result.json"), "utf8"))).toEqual({ status: "failed", detail: "campaign harness:unclassified_failure" });
      expect((await runtime.job("campaign", runtime.current)).campaignFailure).toBeUndefined();
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test("worker snapshots original outcome bytes without reformatting", async () => {
    const root = await mkdtemp(join(tmpdir(), "retry-outcome-bytes-")), previousExit = process.exitCode;
    try {
      const { runtime, directory, original } = await automaticWorkerFixture(root, 75);
      await runtime.worker(join(directory, "spec.json"));
      expect(await readFile(join(directory, "failure-outcome.json"), "utf8")).toBe(original);
      expect(await readFile(join(directory, "diagnostic.json"), "utf8")).toBe(
        JSON.stringify({ failureSummary: JSON.parse(original).failureSummary }, null, 2) + "\n");
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test.each([false, true])("failed worker retains exact private child bytes with bounded=%s and unchanged diagnostics", async bounded => {
    const root = await mkdtemp(join(tmpdir(), "qualification-output-bytes-")), previousExit = process.exitCode;
    try {
      const { runtime, directory, checkout } = await automaticWorkerFixture(root, 1);
      const out = Buffer.concat([Buffer.alloc(bounded ? 300_000 : 2, 0xff), Buffer.from("  PRIVATE-QUALIFICATION-STDOUT-CANARY \r\n\0 ")]),
        err = Buffer.concat([Buffer.alloc(bounded ? 300_000 : 2, 0xfe), Buffer.from("  Error: PRIVATE-QUALIFICATION-ERROR-CANARY\nCaused by: raw child failure \r\n\0 ")]);
      const fixture = join(checkout, "fixture.ts");
      await writeFile(fixture, `await Bun.write(Bun.stdout, Buffer.from(${JSON.stringify(out.toString("base64"))}, "base64"));
await Bun.write(Bun.stderr, Buffer.from(${JSON.stringify(err.toString("base64"))}, "base64"));
${await readFile(fixture, "utf8")}`);
      const expected = await qualificationFixtureOutput(runtime, checkout, campaignWorkerArguments(runtime.current, join(directory, "execution.json"), true));
      expect(expected.code).toBe(1);
      expect(expected.out).toEqual(out);
      expect(expected.err.includes(err)).toBe(true);
      await runtime.worker(join(directory, "spec.json"));
      for (const [name, bytes] of [["qualification-out.log", expected.out], ["qualification-err.log", expected.err]] as const) {
        expect(await readFile(join(directory, name))).toEqual(bytes.subarray(-262_144));
        expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
      }
      expect(await readFile(join(directory, "diagnostic.json"), "utf8")).toBe('{\n  "class": "harness",\n  "reason": "unclassified_failure"\n}\n');
      expect(await readFile(join(directory, "result.json"), "utf8")).not.toContain("CANARY");
      expect((await runtime.job("campaign", runtime.current)).campaignFailure).toBeUndefined();
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test.each([false, true])("successful campaign retains preflight and campaign bytes for retry=%s", async retry => {
    const root = await mkdtemp(join(tmpdir(), "qualification-output-passed-")), previousExit = process.exitCode;
    try {
      const selected = retry ? campaignRetryLaunchState((await completedAutomaticJob(root)).next) : automaticCampaign();
      const { runtime, directory, checkout } = await automaticWorkerFixture(root, 0, selected);
      const receipt = receiptScopedCampaign(selected).receipt;
      receipt.status = "passed"; receipt.execution = campaignExecution(selected);
      receipt.lanes.deviceCloud.status = "passed";
      delete receipt.lanes.deviceCloud.evidence!.availabilityHold;
      await writeFile(join(checkout, "fixture.ts"), `import { writeFile } from "node:fs/promises";
const phase = process.argv.includes("--preflight") ? "preflight" : "campaign";
await Bun.write(Bun.stdout, "  " + phase + " stdout \\r\\n\\0 ");
await Bun.write(Bun.stderr, "  " + phase + " stderr \\r\\n\\0 ");
if (phase === "campaign") await writeFile(${JSON.stringify(runtime.receiptPath)}, ${JSON.stringify(JSON.stringify(receipt))}, { mode: 0o600 });\n`);
      const flags = [
        ...(!retry ? [campaignWorkerArguments(selected, join(directory, "execution.json"), true)] : []),
        campaignWorkerArguments(selected, join(directory, "execution.json")),
      ];
      const expected = [];
      for (const args of flags) expected.push(await qualificationFixtureOutput(runtime, checkout, args));
      await rm(runtime.receiptPath);
      await runtime.worker(join(directory, "spec.json"));
      expect(await readFile(join(directory, "qualification-out.log"))).toEqual(Buffer.concat(expected.map(output => output.out)));
      expect(await readFile(join(directory, "qualification-err.log"))).toEqual(Buffer.concat(expected.map(output => output.err)));
      expect(JSON.parse(await readFile(join(directory, "result.json"), "utf8"))).toEqual({ status: "passed" });
      expect(await Bun.file(join(directory, "diagnostic.json")).exists()).toBe(false);
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test("campaign failure before spawning qualification retains empty private logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "qualification-output-unstarted-")), previousExit = process.exitCode;
    try {
      const { runtime, directory } = await automaticWorkerFixture(root, 1);
      runtime.authenticate = async () => { throw new Error("PRIVATE-AUTHENTICATION-ERROR-CANARY"); };
      await runtime.worker(join(directory, "spec.json"));
      for (const name of ["qualification-out.log", "qualification-err.log"]) {
        expect(await readFile(join(directory, name))).toEqual(Buffer.alloc(0));
        expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
      }
      expect(await readFile(join(directory, "diagnostic.json"), "utf8")).toBe('{\n  "class": "harness",\n  "reason": "unclassified_failure"\n}\n');
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test.each(["exit", "result.json"])("worker commits qualification logs before %s publication", async publication => {
    const root = await mkdtemp(join(tmpdir(), "retry-result-publication-")), previousExit = process.exitCode;
    try {
      const { runtime, directory } = await automaticWorkerFixture(root, 75);
      await mkdir(join(directory, publication));
      await expect(runtime.worker(join(directory, "spec.json"))).rejects.toThrow();
      expect(await readFile(join(directory, "qualification-out.log"))).toEqual(Buffer.alloc(0));
      expect((await readFile(join(directory, "qualification-err.log"), "utf8")).length).toBeGreaterThan(0);
      if (publication === "result.json") expect(await readFile(join(directory, "exit"), "utf8")).toBe("75\n");
      else expect(await Bun.file(join(directory, "result.json")).exists()).toBe(false);
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test.each(["qualification-out.log", "qualification-err.log"])("worker never replaces immutable %s bytes", async name => {
    const root = await mkdtemp(join(tmpdir(), "qualification-output-immutable-")), previousExit = process.exitCode;
    try {
      const { runtime, directory } = await automaticWorkerFixture(root, 75);
      await writeFile(join(directory, name), "existing private evidence", { mode: 0o600 });
      await expect(runtime.worker(join(directory, "spec.json"))).rejects.toThrow();
      expect(await readFile(join(directory, name), "utf8")).toBe("existing private evidence");
      expect(await Bun.file(join(directory, "exit")).exists()).toBe(false);
      expect(await Bun.file(join(directory, "result.json")).exists()).toBe(false);
    } finally { process.exitCode = previousExit ?? 0; await rm(root, { recursive: true, force: true }); }
  });
  test.each(["out.log", "err.log", "qualification-out.log", "qualification-err.log"])("retry authority includes original %s bytes", async name => {
    const root = await mkdtemp(join(tmpdir(), "retry-log-digest-"));
    try {
      const { runtime, next, step, directory } = await completedAutomaticJob(root);
      await writeFile(join(directory, name), "changed diagnostic bytes\n");
      const changed = await runtime.completedCampaignFailure(runtime.current);
      expect(changed.jobSha256).not.toBe(next.retryPlan!.jobSha256);
      expect(changed.outcomeSha256).toBe(next.retryPlan!.outcomeSha256);
      await expect(runtime.perform(step, next)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("qualifying snapshot invalidates changed receipt before scheduling", async () => {
    const root = await mkdtemp(join(tmpdir(), "retry-qualifying-invalid-"));
    try {
      const { runtime } = await completedAutomaticJob(root, true);
      await writeFile(runtime.receiptPath, (await readFile(runtime.receiptPath, "utf8")) + " ");
      const repo = await runtime.snapshot(runtime.current);
      expect(repo.campaignRetryInvalid).toBe(true);
      expect(nextStep(runtime.current, repo, config).operation).toBe("stop");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("pending diagnostics retain the failed job needed for lease retirement", async () => {
    const root = await mkdtemp(join(tmpdir(), "retry-retirement-binding-"));
    try {
      const { runtime, next } = await completedAutomaticJob(root, true);
      expect(await runtime.failedCampaignCleanup({ ...next, phase: "diagnostic-required" })).toBe(next.retryPlan!.outcome.receipt!.sha256);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("snapshot preserves the exact unreviewed source commit on a routine hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "retry-authority-source-"));
    try {
      const { runtime, next } = await completedAutomaticJob(root);
      runtime.authority = async () => { throw new RoutineHoldError("out-of-class", "d".repeat(40)); };
      const step = nextStep(next, await runtime.snapshot(next), config);
      expect(step.holdReason).toBe("out-of-class");
      if (step.operation !== "idle") expect(step.patch?.holdCommit).toBe("d".repeat(40));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("same-owner live OS lock blocks scheduling without rewriting its owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "retry-live-owner-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const { runtime, next, step } = await completedAutomaticJob(root, true);
      child = Bun.spawn([process.execPath, "--eval", `
import { withReleaseHostLease } from ${JSON.stringify(join(import.meta.dir, "release-host-lease.ts"))};
await withReleaseHostLease(${JSON.stringify(runtime.owner)}, async () => {
  console.log("held"); await Bun.stdin.text(); throw new Error("retain owner");
}, ${JSON.stringify(join(root, "lease"))});`], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("held");
      await expect(runtime.perform(step, next)).rejects.toThrow();
      expect(runtime.owner).toBe(`qualification:${runtime.current.candidate}:${runtime.receiptPath}`);
    } finally { child?.kill(); await child?.exited; await rm(root, { recursive: true, force: true }); }
  });
  test.each(["started", "result", "tmux"] as const)("launch and observation reject a changed specification before reconciling %s", async fence => {
    const root = await mkdtemp(join(tmpdir(), "retry-spec-fence-")), previousPath = process.env.PATH;
    try {
      const bin = join(root, "bin"); await mkdir(bin);
      await writeFile(join(bin, "tmux"), `#!/bin/sh\nexit ${fence === "tmux" ? 0 : 1}\n`, { mode: 0o700 });
      process.env.PATH = `${bin}:${previousPath}`;
      const { runtime, directory } = await completedAutomaticJob(root);
      process.env.PATH = previousPath;
      const spec = JSON.parse(await readFile(join(directory, "spec.json"), "utf8"));
      spec.state.candidateDigest = "0".repeat(64);
      await writeFile(join(directory, "spec.json"), JSON.stringify(spec));
      if (fence !== "result") await rm(join(directory, "result.json"));
      if (fence === "started") await writeFile(join(directory, "started"), "");
      await expect(runtime.launch("campaign", runtime.current)).rejects.toThrow("specification");
      expect(await runtime.job("campaign", runtime.current)).toEqual({ status: "failed", detail: "campaign harness:invalid_evidence" });
    } finally { process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); }
  });
  test("terminal result without exit or live worker is diagnostic, not eternally running", async () => {
    const root = await mkdtemp(join(tmpdir(), "retry-orphan-terminal-"));
    try {
      const { runtime, directory } = await completedAutomaticJob(root);
      await rm(join(directory, "exit"));
      expect(await runtime.job("campaign", runtime.current)).toEqual({ status: "failed", detail: "campaign harness:invalid_evidence" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// Private outcome persistence is the POSIX Studio channel; pure state-machine tests stay portable.
describe.skipIf(process.platform === "win32")("automatic retry runtime revalidation", () => {
  test("restored readiness can retry or retire without inventing passes for unstarted expensive lanes", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-readiness-retirement-"));
    try {
      const { runtime, next, step, receipt } = await completedAutomaticJob(root, "readiness");
      expect(next.retryPlan!.outcome.scope).toBe("rigReadiness");
      expect(next.retryPlan!.restartLanes).toContain("debian");
      expect(receipt!.lanes.debian.status).toBe("pending");
      expect(await runtime.failedCampaignCleanup(runtime.current)).toBe(next.retryPlan!.outcome.receipt!.sha256);
      await runtime.perform(step, next);
      expect(receipt!.lanes.debian.attempts).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("shared authorization consumes before effects and leaves passed lane proofs byte-for-byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-automatic-consumption-"));
    try {
      const { next, receipt } = await completedAutomaticJob(root, true);
      const passed = Object.entries(receipt!.lanes).filter(([, lane]) => lane.status === "passed").map(([name, lane]) => [name, JSON.stringify(lane)] as const);
      const order: string[] = [];
      const launched = campaignRetryLaunchState(next);
      await withConsumedCampaignRetry(receipt!, launched.qualificationExecution!, async () => {
        expect(receipt!.execution).toEqual(launched.qualificationExecution);
        expect(receipt!.failureSummary).toBeUndefined();
        order.push("persist");
      }, async () => {
        expect(order).toEqual(["persist"]);
        expect(receipt!.lanes.windows.status).toBe("pending");
        order.push("run");
      });
      expect(order).toEqual(["persist", "run"]);
      for (const [name, bytes] of passed) expect(JSON.stringify(receipt!.lanes[name as keyof StableQualificationReceipt["lanes"]])).toBe(bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.each([false, true])("scheduling revalidates immutable evidence without changing lease or passed proof (receipt=%s)", async withReceipt => {
    const root = await mkdtemp(join(tmpdir(), "driver-automatic-proof-"));
    try {
      const { runtime, next, step, directory, receipt } = await completedAutomaticJob(root, withReceipt);
      const old = new Map(await Promise.all((await readdir(directory)).map(async name => [name, await readFile(join(directory, name), "utf8")] as const)));
      const owner = runtime.owner;
      await runtime.perform(step, next);
      await runtime.perform(JSON.parse(JSON.stringify(step)), next);
      expect(runtime.owner).toBe(owner);
      for (const [name, bytes] of old) expect(await readFile(join(directory, name), "utf8")).toBe(bytes);
      if (receipt !== undefined) {
        expect(await readFile(runtime.receiptPath, "utf8")).toBe(JSON.stringify(receipt) + "\n");
        expect(await runtime.failedCampaignCleanup(runtime.current)).toBe(next.retryPlan!.outcome.receipt!.sha256);
        expect(next.retryPlan?.restartLanes).toContain("windows");
        for (const name of ["debian", "macos", "android", "androidPush", "relay", "deviceCloud", "ompPublication"] as const) {
          expect(next.retryPlan?.restartLanes).not.toContain(name);
        }
      }
      expect(await Bun.file(join(runtime.jobDirectory("campaign", campaignRetryLaunchState(next)), "spec.json")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.each(["policy", "source", "digest", "host", "receipt", "snapshot", "spec", "result", "exit", "publication", "foreign-owner", "missing-owner", "live", "future-worker", "approval", "orphan-approval", "occupied"] as const)(
    "refuses %s without spending an ordinal or changing prior evidence", async change => {
      const root = await mkdtemp(join(tmpdir(), "driver-automatic-refusal-"));
      try {
        const { runtime, next, step, directory } = await completedAutomaticJob(root, true);
        if (change === "policy") runtime.changedPolicy = true;
        if (change === "source") runtime.changedSource = true;
        if (change === "digest") runtime.changedDigest = true;
        if (change === "host") next.macHost = "other@fixture.invalid";
        if (change === "receipt") await writeFile(runtime.receiptPath, (await readFile(runtime.receiptPath, "utf8")) + " ");
        if (change === "snapshot") await writeFile(join(directory, "failed-qualification.json"), "{}");
        if (change === "spec") await writeFile(join(directory, "spec.json"), "{}");
        if (change === "result") await writeFile(join(directory, "result.json"), '{"status":"passed"}');
        if (change === "exit") await rm(join(directory, "exit"));
        if (change === "publication") runtime.published = true;
        if (change === "foreign-owner") runtime.owner = "foreign-campaign";
        if (change === "missing-owner") runtime.owner = undefined;
        if (change === "live") runtime.active = true;
        if (change === "future-worker") {
          runtime.activeAttempt = 7;
          await mkdir(runtime.jobDirectory("campaign", { ...next, campaignAttempt: 7 }), { recursive: true });
        }
        if (change === "approval") next.approvePr = 999;
        if (change === "orphan-approval") runtime.approvalExists = true;
        if (change === "occupied") await mkdir(runtime.jobDirectory("campaign", campaignRetryLaunchState(next)), { recursive: true });
        await expect(runtime.perform(step, next)).rejects.toThrow();
        expect(campaignAttempt(next)).toBe(0);
        expect(await Bun.file(join(runtime.jobDirectory("campaign", { ...next, campaignAttempt: 1 }), "started")).exists()).toBe(false);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
  test("malformed, missing and mismatching worker outcomes are fixed diagnostics, never raw output", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-automatic-outcome-"));
    try {
      const { runtime, directory } = await completedAutomaticJob(root);
      await writeFile(join(directory, "failure-outcome.json"), '{"outcome":"PRIVATE-OUTCOME-CANARY"}', { mode: 0o600 });
      const observation = await runtime.job("campaign", runtime.current);
      expect(observation).toEqual({ status: "failed", detail: "campaign harness:invalid_evidence" });
      expect(JSON.stringify(observation)).not.toContain("PRIVATE-OUTCOME-CANARY");
      await rm(join(directory, "exit"));
      expect(await runtime.job("campaign", runtime.current)).toEqual({ status: "failed", detail: "campaign harness:invalid_evidence" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform === "win32")("spec-only automatic launch reuses ordinal; a start claim is a hard fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-automatic-launch-"));
    const previousPath = process.env.PATH;
    try {
      const bin = join(root, "bin"), attempted = join(root, "attempted"), launched = join(root, "launched");
      await mkdir(bin);
      await writeFile(join(bin, "tmux"), `#!/bin/sh\n[ "$1" != has-session ] || exit 1\n[ -f '${attempted}' ] || { touch '${attempted}'; exit 9; }\nprintf '%s\\n' "$*" >> '${launched}'\n`, { mode: 0o700 });
      process.env.PATH = `${bin}:${previousPath}`;
      const { runtime, next } = await completedAutomaticJob(root);
      process.env.PATH = previousPath;
      const start: Decision = { operation: "start-campaign", phase: "qualifying", detail: "campaign attempt=1; start" };
      await expect(runtime.perform(start, next)).rejects.toThrow("exited 9");
      const directory = runtime.jobDirectory("campaign", campaignRetryLaunchState(next));
      const bytes = await readFile(join(directory, "spec.json"), "utf8");
      expect((await runtime.perform(start, next)).campaignAttempt).toBe(1);
      await writeFile(join(directory, "started"), "", { mode: 0o600 });
      // Working evidence can advance after the claim. Replay must neither revalidate stale bytes nor spawn.
      await writeFile(runtime.receiptPath, "{}");
      await runtime.perform(start, next);
      expect((await readFile(launched, "utf8")).trim().split("\n")).toHaveLength(1);
      expect(await readFile(join(directory, "spec.json"), "utf8")).toBe(bytes);
      expect(campaignAttempt(next)).toBe(0);
      expect(await readdir(join(root, "jobs"))).toHaveLength(2);
    } finally { process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); }
  });
  test("candidate rollout marker is required and existing legacy specifications never upgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-automatic-rollout-"));
    try {
      class Rollout extends StudioDriver {
        marker = false;
        override async api<T>(): Promise<T | undefined> {
          return { content: Buffer.from(this.marker ? "export const QUALIFICATION_EXECUTION_FORMAT = 1;\n" : "legacy candidate\n").toString("base64") } as T;
        }
      }
      const runtime = new Rollout(driverConfig({ ...process.env, OMP_RELEASE_STATE_DIR: root }), false);
      const selected = automaticCampaign(); delete selected.qualificationExecution;
      expect((await runtime.campaignLaunchState(selected)).qualificationExecution).toBeUndefined();
      runtime.marker = true;
      expect((await runtime.campaignLaunchState(selected)).qualificationExecution).toEqual(campaignExecution(selected));
      const directory = runtime.jobDirectory("campaign", selected);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "spec.json"), JSON.stringify({ kind: "campaign", state: selected, root: join(import.meta.dir, "..") }));
      expect((await runtime.campaignLaunchState(selected)).qualificationExecution).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function cleanCloudProgress(epoch: string) {
  return {
    lane: "deviceCloud", epoch, binding: "9".repeat(64), phase: "restored", cleanupRequired: false,
    sessions: ["session-iphone-0001"], tunnels: ["testingbot"],
    resources: [{ vendor: "testingbot", target: "iphone", sessionId: "session-iphone-0001", ended: true, audited: true, recordRemoved: false }],
    results: { audit: { records: 1, recordsExposingLinks: 0, recordsWithMedia: 0, lingeringSignedArtifacts: 0 } },
  };
}

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
  receipt.lanes.deviceCloud.evidence!.progress = cleanCloudProgress(epoch);
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

test("lease self-clear accepts only settled candidate-bound cleanup with matching external epochs", () => {
  const selected = heldCampaign().selected;
  const { receipt } = receiptScopedCampaign(selected);
  receipt.completedAt = "2026-10-23T02:00:00.000Z";
  expect(() => assertFailedCampaignCleanup(selected, receipt, retryReceiptModules)).not.toThrow();
  for (const name of ["cleanup", "windowsCleanup", "androidPushCleanup", "deviceCloudCleanup", "debian"] as const) {
    for (const status of ["failed", "pending", "running"] as const) {
      const changed = structuredClone(receipt); changed.lanes[name].status = status;
      expect(() => assertFailedCampaignCleanup(selected, changed, retryReceiptModules)).toThrow();
    }
  }
  for (const name of ["windows", "androidPush", "deviceCloud"] as const) {
    const stale = structuredClone(receipt); stale.lanes[`${name}Cleanup`].evidence!.epoch = "stale";
    expect(() => assertFailedCampaignCleanup(selected, stale, retryReceiptModules)).toThrow("stale or incomplete");
    const dirty = structuredClone(receipt); dirty.lanes[name].evidence!.progress = { epoch: receipt.lanes[`${name}Cleanup`].evidence!.epoch, cleanupRequired: true };
    expect(() => assertFailedCampaignCleanup(selected, dirty, retryReceiptModules)).toThrow("stale or incomplete");
  }
  for (const changed of [{ ...receipt, status: "running" }, { ...receipt, macHost: "other@fixture.invalid" },
    { ...receipt, orchestratorCommit: "b".repeat(40) }]) {
    expect(() => assertFailedCampaignCleanup(selected, changed, retryReceiptModules)).toThrow();
  }
});

test("prealpha.3 exited-job receipt permits cleanup despite unfinished publication bookkeeping", () => {
  const selected = { ...heldCampaign().selected, candidate: "v0.8.0-prealpha.3", version: "0.8.0",
    candidateCommit: "272f2328cb5d05babbe8ec1931d7ba916053b09d",
    candidateDigest: "4257d21c3fcc8de59272619b3e88e668ddaee52fdc46c66ef4923fe00541426f", previousStable: "v0.7.7" };
  const { receipt } = receiptScopedCampaign(selected);
  delete receipt.lanes.deviceCloud.evidence!.availabilityHold;
  receipt.lanes.ompPublication.status = "running";
  expect(receipt.completedAt).toBeUndefined();
  const epochs = {
    windows: "d03dcdcc-b3e8-45ea-a1e3-d11d099c9ddd",
    androidPush: "3957660b-d8ea-4caf-930c-68b03b34a454",
    deviceCloud: "c8224e01-0505-4d4a-9a38-22d8a34eb7fe",
  };
  for (const name of ["windows", "androidPush", "deviceCloud"] as const) {
    receipt.lanes[name].evidence!.progress = name === "deviceCloud" ? cleanCloudProgress(epochs[name]) : { epoch: epochs[name], cleanupRequired: false };
    receipt.lanes[`${name}Cleanup`].evidence = { epoch: epochs[name] };
  }
  expect(() => assertFailedCampaignCleanup(selected, receipt, retryReceiptModules)).not.toThrow();
  for (const name of ["cleanup", "windowsCleanup", "androidPushCleanup", "deviceCloudCleanup"] as const) {
    const failed = structuredClone(receipt); failed.lanes[name].status = "failed";
    expect(() => assertFailedCampaignCleanup(selected, failed, retryReceiptModules)).toThrow("did not pass");
  }
});

test("round-three DB-R2 passed cleanup cannot settle unaudited or exposing vendor records", () => {
  const selected = heldCampaign().selected, { receipt } = receiptScopedCampaign(selected);
  const epoch = receipt.lanes.deviceCloudCleanup.evidence!.epoch as string;
  const progress = cleanCloudProgress(epoch);
  progress.sessions.push("session-ipad-0001");
  progress.resources.push({ ...progress.resources[0]!, target: "ipad", sessionId: "session-ipad-0001" });
  progress.results.audit.records = 2;
  receipt.lanes.deviceCloud.evidence!.progress = progress;
  expect(() => assertFailedCampaignCleanup(selected, receipt, retryReceiptModules)).not.toThrow();
  for (const index of [0, 1]) {
    const unsafe = structuredClone(receipt);
    const cloud = unsafe.lanes.deviceCloud.evidence!.progress as typeof progress;
    cloud.resources[index]!.audited = false;
    expect(() => assertFailedCampaignCleanup(selected, unsafe, retryReceiptModules)).toThrow();
  }
  for (const change of [{ recordsExposingLinks: 1 }, { recordsWithMedia: 1 }, { lingeringSignedArtifacts: 1 }, { records: 1 }]) {
    const unsafe = structuredClone(receipt);
    Object.assign((unsafe.lanes.deviceCloud.evidence!.progress as typeof progress).results.audit, change);
    expect(() => assertFailedCampaignCleanup(selected, unsafe, retryReceiptModules)).toThrow();
  }
  for (const field of ["resources", "results"]) {
    const unsafe = structuredClone(receipt);
    delete (unsafe.lanes.deviceCloud.evidence!.progress as Record<string, unknown>)[field];
    expect(() => assertFailedCampaignCleanup(selected, unsafe, retryReceiptModules)).toThrow();
  }
  const legacy = structuredClone(receipt);
  const legacyCloud = legacy.lanes.deviceCloud.evidence!.progress as Record<string, unknown>;
  delete legacyCloud.resources; delete legacyCloud.tunnels;
  expect(() => assertFailedCampaignCleanup(selected, legacy, retryReceiptModules)).toThrow("retained-record audit");
  const unallocated = structuredClone(receipt);
  unallocated.lanes.deviceCloud.evidence!.progress = { ...cleanCloudProgress(epoch), resources: [], sessions: [], tunnels: [], results: {} };
  expect(() => assertFailedCampaignCleanup(selected, unallocated, retryReceiptModules)).not.toThrow();
});

test("re-selection closes only its bot-owned orphan prepare and preserves request/job history across replay", async () => {
  const failed = { ...state("held"), holdReason: "stale-source" as const, preparePr: 401 };
  const repo = snapshot({ main: "d".repeat(40), prepare: pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-prepare" }) });
  class Retirement extends StudioDriver {
    comments = new Set<string>();
    writes: string[][] = [];
    override async snapshot() { return repo; }
    override async pages<T>() { return repo.tags.map(name => ({ name })) as T[]; }
    override async issues() { return repo.issues; }
    override async readPr() { return repo.prepare!; }
    override async authority() { return authority; }
    override async api<T>(): Promise<T | undefined> { return undefined; }
    override async recoverFailedCampaign() {}
    override async announce(_issue: number, _body: string, marker: string) { this.comments.add(marker); }
    override async gh<T>(args: string[]): Promise<T | undefined> { this.writes.push(args); repo.prepare!.state = "closed"; return undefined; }
  }
  const runtime = new Retirement(driverConfig(), false), step = nextStep(failed, repo, config);
  if (step.operation === "idle") throw new Error("no retry planned");
  await runtime.perform(step, failed);
  await runtime.perform(step, failed);
  expect(runtime.comments.size).toBe(1);
  expect(runtime.writes).toHaveLength(1);
  expect(runtime.writes[0]).toContain(`repos/${REPOSITORY}/pulls/401`);
  const changed = { ...repo.prepare! }; repo.prepare!.author = "foreign";
  await expect(runtime.perform(step, failed)).rejects.toThrow("identity changed");
  repo.prepare = changed;
  const fake = new FakeDriver(); fake.state = failed; fake.repo = repo;
  expect((await tick(fake, config)).operation).toBe("rerequest");
  expect(fake.state.retired).toHaveLength(1);
  expect(fake.state.issue.number).toBe(issue.number);
  expect(fake.state.candidate).toBe("v0.7.5-prealpha.2");
  expect((await tick(fake, config)).operation).toBe("open-prepare");
});

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
  const env = botEnvironment(cfg, { GH_TOKEN: "founder-value", GITHUB_TOKEN: "founder-value", GH_CONFIG_DIR: "/founder", GIT_AUTHOR_EMAIL: "founder@example.com", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "founder-helper", OMP_STABLE_PREVIOUS_TAG: "v0.0.1", OMP_RELEASE_SMOKE_LOG_DIR: "/foreign", PATH: "/bin" });
  expect(env.GH_CONFIG_DIR).toBe("/private/bot-gh");
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GIT_AUTHOR_EMAIL", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "OMP_STABLE_PREVIOUS_TAG", "OMP_RELEASE_SMOKE_LOG_DIR"]) expect(env[key]).toBeUndefined();
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

describe("round-one retry boundary regressions", () => {
  test("DB-R1 an unfiled label-only issue cannot inherit a recorded filing run, regardless of age", async () => {
    class Filing extends StudioDriver {
      laterCreated = "2026-10-22T21:22:00Z";
      override async pages<T>(): Promise<T[]> {
        return [400, 401].map(number => ({ number, title: issue.title, user: { login: issue.author }, html_url: issue.url,
          created_at: number === 400 ? "2026-10-22T21:21:24Z" : this.laterCreated,
          labels: [{ name: "release-minor" }] })) as T[];
      }
      override async api<T>(path: string): Promise<T | undefined> {
        return (path.startsWith("actions/workflows/") ? { workflow_runs: [{ id: 42, run_attempt: 1 }] }
          : { jobs: [filingJob("Request OMP v18.8.3 (minor)", 400)] }) as T;
      }
    }
    const runtime = new Filing(driverConfig(), true);
    expect((await runtime.issues()).map(item => item.number)).toEqual([400]);
    runtime.laterCreated = "2026-10-22T21:21:25Z";
    expect((await runtime.issues()).map(item => item.number)).toEqual([400]); // The recorded number, not age, chooses identity.
  });

  test("DB-R2 bot and maintainer cannot share a login, even with different case", () => {
    for (const founder of ["alphastorm-release", "ALPHASTORM-RELEASE"]) {
      expect(() => driverConfig({ OMP_RELEASE_BOT_LOGIN: "alphastorm-release", OMP_RELEASE_FOUNDER_LOGIN: founder })).toThrow("distinct");
    }
  });

  test.each(["tag", "latest"] as const)("DB-R3/GR-R1 observed stable %s vetoes retry before saving an intent", async observation => {
    const fake = new FakeDriver();
    fake.state = { ...state("diagnostic-required"), failedMain: state().selectedMain };
    fake.repo.main = "d".repeat(40);
    if (observation === "tag") fake.repo.tags.push("v0.7.5");
    else fake.repo.latestStable = "v0.7.5";
    const step = await tick(fake, config);
    expect(step.operation).toBe("idle");
    expect(step.detail).toContain("immutable release");
    expect(fake.saves).toBe(0);
    expect(fake.performed).toEqual([]);
  });

  test("AR-R1 closing an aged minor request passes its identity and never reselects fulfilled issue", async () => {
    const selected = { ...state("recorded"), issue: { ...issue, releaseClass: "minor" as const } };
    class Closing extends StudioDriver {
      seen: TrackingIssue | undefined;
      closed: string[] = [];
      override async issues(previous?: TrackingIssue) { this.seen = previous; return previous ? [previous] : []; }
      override async gh<T>(args: string[]): Promise<T | undefined> { this.closed.push(args[3]!); return undefined; }
    }
    const runtime = new Closing(driverConfig(), false);
    await runtime.perform({ operation: "close", phase: "closed", detail: "fulfilled" }, selected);
    expect(runtime.seen).toEqual(selected.issue);
    expect(runtime.closed).toEqual([`repos/${REPOSITORY}/issues/400`]);
    expect(nextStep({ ...selected, phase: "closed" }, snapshot({ issues: [selected.issue] }), config).operation).toBe("idle");
  });

  test("AR-R2 a stale selection with no prepare PR can reselect without inventing an orphan", () => {
    const step = nextStep({ ...state("held"), holdReason: "stale-source" }, snapshot({ main: "d".repeat(40) }), config);
    expect(step.operation).toBe("rerequest");
    if (step.operation !== "idle") expect(step.pr).toBeUndefined();
  });

  test("AR-R2 discovers and retires a deterministic prepare created before its state checkpoint", async () => {
    const selected = { ...state("held"), holdReason: "stale-source" as const };
    class Uncheckpointed extends StudioDriver {
      merged = false;
      closes = 0;
      override async issues() { return [issue]; }
      override async releaseHostOwner() { return undefined; }
      override async authority() { return authority; }
      override async readPr() { return pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-prepare", merged: this.merged }); }
      override async announce() {}
      override async gh<T>(): Promise<T | undefined> { this.closes++; return undefined; }
      override async pages<T>(path: string): Promise<T[]> {
        if (path.startsWith("tags?")) return [{ name: "v0.7.4" }] as T[];
        if (path.includes("head=carrythroughsystems:release-driver%2F400%2Fv0.7.5-prealpha.1-prepare")) return [{ number: 401 }] as T[];
        throw new Error("unexpected discovery " + path);
      }
      override async api<T>(path: string): Promise<T | undefined> {
        if (path === "commits/main") return { sha: "d".repeat(40) } as T;
        if (path.startsWith("contents/")) return { content: Buffer.from('{"tag":"v18.8.3"}').toString("base64") } as T;
        if (path === "releases/latest") return { tag_name: "v0.7.4" } as T;
        return undefined;
      }
    }
    const runtime = new Uncheckpointed(driverConfig(), false);
    const step = nextStep(selected, await runtime.snapshot(selected), config);
    expect(step.operation).toBe("rerequest");
    if (step.operation === "idle") throw new Error("missing retry");
    expect(step.patch?.retired?.[0]?.preparePr).toBe(401);
    await runtime.perform(step, selected);
    expect(runtime.closes).toBe(1);
    runtime.merged = true;
    expect(nextStep(selected, await runtime.snapshot(selected), config).operation).toBe("idle");
  });

  test("DB-R4 cleanup binding changes are included in installed/source control fingerprints", async () => {
    class Binding extends StudioDriver {
      override async git(args: string[]) {
        if (args[0] === "ls-tree") return `100644 blob ${args[2]}\tscripts/stable-lanes.ts`;
        throw new Error("unexpected control read");
      }
    }
    const runtime = new Binding(driverConfig(), true);
    const installed = await runtime.controls("installed", true), changed = await runtime.controls("changed", true);
    expect(installed.has("scripts/stable-lanes.ts")).toBe(true);
    expect(installed.get("scripts/stable-lanes.ts")).not.toBe(changed.get("scripts/stable-lanes.ts"));
  });

  test("DB-U2 runtime-validated numeric identity retries; an unproven legacy timestamp stays refused", () => {
    const predecessor: DriverState = { ...state("diagnostic-required"), version: "0.8.0", previousStable: "v0.7.7",
      candidate: "v0.8.0-prealpha.1", failedMain: "38715dac23f9c16905759c39c4e09123eb5b5dc4",
      issue: { ...issue, number: 448, title: "Upstream tracking: v18.12.5", request: "39869779940:1", releaseClass: "minor" } };
    const repo = snapshot({ main: "13f45261900c7fac56c812bdc7ea167901665b11", latestStable: "v0.7.7",
      upstreamTag: "v18.12.5", issues: [predecessor.issue], tags: [predecessor.candidate] });
    expect(nextStep(predecessor, repo, config).operation).toBe("rerequest");
    const legacy = { ...predecessor, issue: { ...predecessor.issue, request: "2026-10-22T21:21:25Z" } };
    expect(nextStep(legacy, { ...repo, issues: [legacy.issue] }, config).operation).toBe("idle");
  });

  class RacingRetry extends StudioDriver {
    selected = { ...state("held"), holdReason: "stale-source" as const, preparePr: 401 };
    repo = snapshot({ main: "d".repeat(40), prepare: pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-prepare" }) });
    afterRecovery: () => void = () => {};
    afterComment: () => void = () => {};
    afterClose: () => void = () => {};
    writes = 0;
    override async snapshot() { return structuredClone(this.repo); }
    override async pages<T>() { return this.repo.tags.map(name => ({ name })) as T[]; }
    override async issues() { return structuredClone(this.repo.issues); }
    override async readPr() { return structuredClone(this.repo.prepare!); }
    override async authority() { return authority; }
    override async api<T>(): Promise<T | undefined> { return undefined; }
    override async recoverFailedCampaign() { this.afterRecovery(); }
    override async announce() { this.writes++; this.afterComment(); }
    override async gh<T>(): Promise<T | undefined> { this.writes++; this.repo.prepare!.state = "closed"; this.afterClose(); return undefined; }
    step() {
      const step = nextStep(this.selected, this.repo, config);
      if (step.operation === "idle") throw new Error("no retry planned");
      return structuredClone(step);
    }
  }

  test.each(["afterRecovery", "afterComment", "afterClose"] as const)("round-three DB-R1 refreshes candidate ordinals %s", async point => {
    class TagsRace extends RacingRetry {
      freshTags = [...this.repo.tags];
      override async pages<T>() { return this.freshTags.map(name => ({ name })) as T[]; }
    }
    const runtime = new TagsRace(driverConfig(), false), fake = new FakeDriver();
    runtime[point] = () => { runtime.freshTags.push("v0.7.5-prealpha.2"); };
    fake.state = structuredClone(runtime.selected); fake.repo = runtime.repo;
    fake.perform = (step, selected) => runtime.perform(step, selected);
    expect((await tick(fake, config)).operation).toBe("idle");
    expect(fake.state.candidate).toBe("v0.7.5-prealpha.1");
    expect(fake.state.intent).toBeUndefined();
    expect(fake.state.retired).toBeUndefined();
    runtime[point] = () => {};
    runtime.repo.tags = [...runtime.freshTags];
    expect((await tick(fake, config)).operation).toBe("rerequest");
    expect(fake.state.candidate).toBe("v0.7.5-prealpha.3");
  });

  test.each(["head", "author"] as const)("GR-R2 moved orphan %s replans rather than wedging its saved intent", async field => {
    const runtime = new RacingRetry(driverConfig(), false), step = runtime.step();
    runtime.repo.prepare![field] = field === "head" ? "d".repeat(40) : "foreign";
    await expect(runtime.perform(step, runtime.selected)).rejects.toBeInstanceOf(StaleIntentError);
    expect(runtime.writes).toBe(0);
  });

  test.each(["issue closed", "prepare merged"] as const)("DB-R5/GR-R3 rereads %s after lease recovery", async change => {
    const runtime = new RacingRetry(driverConfig(), false), step = runtime.step();
    runtime.afterRecovery = () => {
      if (change === "issue closed") runtime.repo.issues = [];
      else runtime.repo.prepare!.merged = true;
    };
    await expect(runtime.perform(step, runtime.selected)).rejects.toBeInstanceOf(StaleIntentError);
    expect(runtime.writes).toBe(0);
  });

  test("DB-R5/GR-R3 late races preserve the failed selection and clear the obsolete intent", async () => {
    for (const point of ["afterRecovery", "afterComment", "afterClose"] as const) {
      const runtime = new RacingRetry(driverConfig(), false);
      runtime[point] = () => { runtime.repo.issues = []; };
      const fake = new FakeDriver();
      fake.state = structuredClone(runtime.selected);
      fake.repo = runtime.repo;
      fake.perform = (step, selected) => runtime.perform(step, selected);
      expect((await tick(fake, config)).operation).toBe("idle");
      expect(fake.state.candidate).toBe(runtime.selected.candidate);
      expect(fake.state.retired).toBeUndefined();
      expect(fake.state.intent).toBeUndefined();
    }
  });

  test("DB-R3/GR-R1 a newly observed stable publication drops an obsolete retry intent", async () => {
    class Published extends RacingRetry {
      override async api<T>(): Promise<T | undefined> { return { exists: true } as T; }
    }
    const runtime = new Published(driverConfig(), false), fake = new FakeDriver();
    fake.state = structuredClone(runtime.selected); fake.repo = runtime.repo;
    fake.perform = (step, selected) => runtime.perform(step, selected);
    expect((await tick(fake, config)).operation).toBe("idle");
    expect(fake.state.intent).toBeUndefined();
    expect(runtime.writes).toBe(0);
    fake.repo.tags.push(`v${fake.state.version}`);
    expect((await tick(fake, config)).detail).toContain("immutable release");
  });

  test("GR-U1 production cleanup gate rejects missing source progress despite passed cleanup", () => {
    const selected = heldCampaign().selected, { receipt } = receiptScopedCampaign(selected);
    receipt.completedAt = "2026-10-23T02:00:00.000Z";
    for (const name of ["windows", "androidPush", "deviceCloud"] as const) {
      const changed = structuredClone(receipt);
      delete changed.lanes[name].evidence!.progress;
      expect(() => assertFailedCampaignCleanup(selected, changed)).toThrow("stale or incomplete");
    }
  });
});

describe("round-two class closure", () => {
  test("GR-R1 JSON-persisted retry intents clear old selection fields after crash replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-retry-json-"));
    try {
      const storage = new StudioDriver(driverConfig({ OMP_RELEASE_STATE_DIR: root }), false);
      const initial = { ...state("held"), holdReason: "stale-source" as const, preparePr: 401, macHost: "old@fixture.invalid" };
      await storage.save(initial);
      const fake = new FakeDriver();
      fake.repo = snapshot({ main: "d".repeat(40), prepare: pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-prepare" }) });
      let crash = true;
      const port: DriverPort = {
        load: () => storage.load(), save: value => storage.save(value),
        snapshot: () => fake.snapshot(), announce: () => Promise.resolve(),
        perform: async (step, selected) => {
          if (crash) { crash = false; throw new Error("crash after saved intent"); }
          return fake.perform(step, selected);
        },
      };
      await expect(tick(port, config)).rejects.toThrow("crash after saved intent");
      expect((await tick(port, config)).operation).toBe("rerequest");
      const recovered = (await storage.load())!;
      expect(recovered.holdReason).toBeUndefined();
      expect(recovered.preparePr).toBeUndefined();
      expect(recovered.macHost).toBeUndefined();
      expect((await tick(port, config)).operation).toBe("open-prepare");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("GR-R1 every emitted state patch survives JSON and applies identically", () => {
    const phases: Record<DriverState["phase"], true> = {
      selected: true, "order-updated": true, "order-ready": true, "order-landed": true, held: true, "prepare-open": true,
      prepared: true, "candidate-tagged": true, "candidate-published": true, "candidate-verified": true, qualifying: true,
      qualified: true, "approve-open": true, "approve-checking": true, "approval-required": true, approved: true,
      "stable-tagged": true, "stable-published": true, "stable-verified": true, smoking: true, smoked: true,
      "record-open": true, recorded: true, closed: true, "diagnostic-required": true, "infrastructure-held": true, "retry-pending": true, stopped: true,
    };
    const subject = { ...state(), candidateCommit: evidence.candidateCommit, candidateDigest: evidence.candidateDigest,
      approvedHead: evidence.head, approvedTree: evidence.tree, failedMain: state().selectedMain };
    const base = snapshot({ prepare: pr(), approve: pr(), record: pr(), campaign: { status: "passed" },
      approveChecks: { status: "passed" }, smoke: { status: "passed" } });
    const repos = [
      base, { ...base, main: "d".repeat(40) }, { ...base, upstreamTag: "v18.8.2", order: order() },
      { ...base, upstreamTag: "v18.8.2", order: order({ behind: true }) },
      { ...base, upstreamTag: "v18.8.2", order: order({ draft: false }) },
      { ...base, prepare: pr({ behind: true }), record: pr({ behind: true }) },
      { ...base, campaign: { status: "failed" as const }, approveChecks: { status: "failed" as const }, smoke: { status: "failed" as const } },
      { ...base, approve: pr({ merged: true, mergedBy: config.bot, mergeCommit: "2".repeat(40), mergeTree: evidence.tree }) },
      { ...base, authority: { ...authority, sourceReviewed: false, unreviewedCommit: "c".repeat(40) } },
      ...(["authority-path-changed", "policy-changed", "out-of-class", "stale-source", "missing-evidence"] as const).map(authorityFailure => ({ ...base, authorityFailure })),
    ];
    const calls: [DriverState | undefined, RepositorySnapshot][] = [[undefined, base]];
    for (const phase of Object.keys(phases) as DriverState["phase"][]) for (const repo of repos) calls.push([{ ...subject, phase }, repo]);
    const held = heldCampaign();
    calls.push([{ ...held.selected, phase: "qualifying" }, { ...base, campaign: { status: "infrastructure-hold", availabilityHold: held.hold } }]);
    const automatic = automaticCampaign();
    calls.push([automatic, { ...base, campaign: { status: "failed", campaignFailure: automaticFailure(automatic) } }]);
    const unprepared = { ...base, main: "d".repeat(40) };
    delete unprepared.prepare;
    calls.push([{ ...state("held"), holdReason: "stale-source" }, unprepared]);
    const patchOperations = new Set<string>();
    for (const [selected, repo] of calls) {
      const step = nextStep(selected, repo, config);
      if (step.operation === "idle" || step.patch === undefined) continue;
      patchOperations.add(step.operation);
      const persisted = JSON.parse(JSON.stringify(step)) as Decision;
      expect(step.patch, step.operation).toStrictEqual(persisted.patch!);
      expect(step.clear, step.operation).toStrictEqual(persisted.clear);
      const previous = { ...subject, ...Object.fromEntries((step.clear ?? []).map(key => [key, "previous"])) } as DriverState;
      const applied = applyDecisionPatch(previous, step);
      expect(applied, step.operation).toStrictEqual(applyDecisionPatch(previous, persisted));
      for (const key of step.clear ?? []) {
        expect(Object.hasOwn(step.patch, key), key).toBe(false);
        expect(Object.hasOwn(applied, key), key).toBe(false);
      }
    }
    expect([...patchOperations].sort()).toEqual(["accept-approval", "hold", "hold-device-cloud", "open-prepare", "ready-order", "rerequest", "schedule-campaign-retry", "select", "start-approve-checks", "stop", "update-order", "update-release-pr"]);
  });

  test("DB-R1 an old relabeled issue cannot inherit a run recorded for a closed issue", async () => {
    class RecordedRequest extends StudioDriver {
      override async pages<T>(): Promise<T[]> {
        return [{ number: 400, title: issue.title, user: { login: issue.author }, html_url: issue.url,
          created_at: "2026-10-01T00:00:00Z", labels: [{ name: "release-minor" }] }] as T[];
      }
      override async api<T>(path: string): Promise<T | undefined> {
        return (path.startsWith("actions/workflows/") ? { workflow_runs: [{ id: 42, run_attempt: 1 }] }
          : { jobs: [{ name: "Request OMP v18.8.3 (minor)", conclusion: "success", completed_at: "2026-10-22T21:21:27Z",
            steps: [{ name: "Record tracking issue #401", status: "completed", conclusion: "success" }] }] }) as T;
      }
    }
    expect(await new RecordedRequest(driverConfig(), true).issues()).toEqual([]);
  });

  test("DB-R1 retained attempts require one successful exact-issue record; historical metadata is insufficient", async () => {
    const previous = { ...issue, releaseClass: "minor" as const };
    class RetainedEvidence extends StudioDriver {
      filing = filingJob("Request OMP v18.8.3 (minor)", issue.number);
      override async pages<T>(): Promise<T[]> {
        return [{ number: issue.number, title: issue.title, user: { login: issue.author }, created_at: "2026-10-01T00:00:00Z",
          html_url: issue.url, labels: [{ name: "release-minor" }] }] as T[];
      }
      override async api<T>(path: string): Promise<T | undefined> {
        return (path.startsWith("actions/workflows/") ? { workflow_runs: [] }
          : path.endsWith("/jobs?per_page=100") ? { jobs: [this.filing] }
          : { path: ".github/workflows/release-request.yml", status: "completed", conclusion: "success" }) as T;
      }
    }
    const runtime = new RetainedEvidence(driverConfig(), true);
    expect((await runtime.issues(previous))[0]?.request).toBe("42:1");
    const valid = filingJob("Request OMP v18.8.3 (minor)", issue.number);
    for (const steps of [
      [], [{ ...valid.steps[0]!, name: "Record tracking issue #401" }],
      [{ ...valid.steps[0]!, conclusion: "skipped" }], [{ ...valid.steps[0]!, status: "in_progress" }],
      [{ ...valid.steps[0]!, name: "Record tracking issue #0400" }], [...valid.steps, ...valid.steps],
    ]) {
      runtime.filing = { ...valid, steps };
      expect(await runtime.issues(previous)).toEqual([]);
    }
  });

  test.each(["recovery", "comment", "close"] as const)("DB-R2 stable publication appearing during %s vetoes selection", async point => {
    const selected = { ...state("held"), holdReason: "stale-source" as const, preparePr: 401 };
    const repo = snapshot({ main: "d".repeat(40), prepare: pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-prepare" }) });
    class PublicationRace extends StudioDriver {
      published = false;
      effects = 0;
      override async snapshot() { return structuredClone(repo); }
      override async pages<T>() { return repo.tags.map(name => ({ name })) as T[]; }
      override async issues() { return repo.issues; }
      override async readPr() { return repo.prepare!; }
      override async authority() { return authority; }
      override async api<T>(): Promise<T | undefined> { return this.published ? { exists: true } as T : undefined; }
      override async recoverFailedCampaign() { if (point === "recovery") this.published = true; }
      override async announce() { this.effects++; if (point === "comment") this.published = true; }
      override async gh<T>(): Promise<T | undefined> { this.effects++; if (point === "close") this.published = true; return undefined; }
    }
    const runtime = new PublicationRace(driverConfig(), false), fake = new FakeDriver();
    fake.state = selected; fake.repo = repo;
    fake.perform = (step, current) => runtime.perform(step, current);
    expect((await tick(fake, config)).operation).toBe("idle");
    expect(fake.state.candidate).toBe(selected.candidate);
    expect(runtime.effects).toBe({ recovery: 0, comment: 1, close: 2 }[point]);
    expect(fake.state.intent).toBeUndefined();
  });

  test("DB-R3 a newly visible orphan is pinned and retired before selection advances", async () => {
    const selected = { ...state("held"), holdReason: "stale-source" as const };
    const planned = snapshot({ main: "d".repeat(40) });
    const observed = { ...planned, prepare: pr({ headRef: "release-driver/400/v0.7.5-prealpha.1-prepare" }) };
    class NewlyVisible extends StudioDriver {
      closes = 0;
      override async snapshot() { return observed; }
      override async pages<T>() { return observed.tags.map(name => ({ name })) as T[]; }
      override async issues() { return observed.issues; }
      override async readPr() { return observed.prepare; }
      override async authority() { return authority; }
      override async api<T>(): Promise<T | undefined> { return undefined; }
      override async recoverFailedCampaign() {}
      override async announce() {}
      override async gh<T>(): Promise<T | undefined> { this.closes++; observed.prepare.state = "closed"; return undefined; }
    }
    const runtime = new NewlyVisible(driverConfig(), false), fake = new FakeDriver();
    const step = nextStep(selected, planned, config);
    if (step.operation === "idle") throw new Error("missing retry");
    fake.state = { ...selected, intent: step }; fake.repo = observed;
    fake.perform = (decision, current) => runtime.perform(decision, current);
    expect((await tick(fake, config)).operation).toBe("idle"); // Persist the newly observed subject on a fresh plan.
    expect(runtime.closes).toBe(0);
    expect((await tick(fake, config)).operation).toBe("rerequest");
    expect(fake.state.retired?.at(-1)?.preparePr).toBe(401);
    expect(runtime.closes).toBe(1);
  });
});
