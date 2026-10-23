import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { repositoryFiles } from "./repository-files.ts";
import { nextReleaseVersion, parseReleaseClass, REQUIRED_CHECKS, ROUTINE_BRANCH_PROTECTION, routineBranchProtectionMatches, ROUTINE_HOLD_REASONS, ROUTINE_EVIDENCE_STEPS, GENERATED_RELEASE_PATHS, generatedReleaseKind, generatedReleaseFilesMatch, routinePathClassification, routineProtectedPath, routineReleaseHold, assertStableReleaseQualification, releasePolicy, releaseVersion } from "./release-policy.ts";


describe("standing routine release authority", () => {
  const input = () => ({
    subject: { head: "head", tree: "tree", candidate: "candidate", candidateCommit: "commit", candidateDigest: "digest", policy: "policy" },
    authority: { policy: "policy", protectedChanges: [] as string[], sourceReviewed: true, sourceFresh: true, releaseClassAllowed: true },
    evidence: { head: "head", tree: "tree", candidate: "candidate", candidateCommit: "commit", candidateDigest: "digest", policy: "policy", steps: [...ROUTINE_EVIDENCE_STEPS] as string[] },
    pr: { author: "bot", base: "main", headRepository: "repo", headRef: "branch", head: "head", tree: "tree", state: "open" as const, draft: false, merged: true, checksPassed: true, behind: false, mergedBy: "bot", mergeTree: "tree", mergeCommit: "merge", mergeVerified: true, files: [] as { filename: string; previous_filename?: string }[] },
    bot: "bot", repository: "repo", branch: "branch", merged: true,
  });
  const mutations: Record<typeof ROUTINE_HOLD_REASONS[number], (x: ReturnType<typeof input>) => void> = {
    "authority-path-changed": x => { x.authority.protectedChanges = [".github/workflows/signed-release.yml"]; },
    "policy-changed": x => { x.authority.policy = "other"; },
    "out-of-class": x => { x.authority.sourceReviewed = false; },
    "stale-source": x => { x.authority.sourceFresh = false; },
    "missing-evidence": x => { x.evidence.steps = []; },
    "head-tree-changed": x => { x.pr.head = "other"; },
    "unexpected-merger": x => { x.pr.mergedBy = "founder"; },
    "pr-identity-changed": x => { x.pr.author = "other"; },
    "required-checks-missing": x => { x.pr.checksPassed = false; },
    "merge-tree-changed": x => { x.pr.mergeTree = "other"; },
    "merge-missing": x => { x.pr.mergeCommit = ""; },
    "merge-signature-missing": x => { x.pr.mergeVerified = false; },
    "generated-content-mismatch": x => { x.pr.files = [{ filename: "scripts/release-policy.ts" }]; },
  };
  test.each([...ROUTINE_HOLD_REASONS])("enumerates and refuses %s", reason => {
    const subject = input(); mutations[reason](subject);
    expect(routineReleaseHold(subject)).toBe(reason);
  });
  test("admits the reviewed requested class, never a missing subject or changed digest", () => {
    expect(routineReleaseHold(input())).toBeUndefined();
    const missing = input(); missing.evidence.candidateDigest = "wrong";
    expect(routineReleaseHold(missing)).toBe("missing-evidence");
    const wrongClass = input(); wrongClass.authority.releaseClassAllowed = false;
    expect(routineReleaseHold(wrongClass)).toBe("out-of-class");
  });
  test("patch is the default; minor means exactly the next minor with patch zero", () => {
    expect(parseReleaseClass()).toBe("patch");
    expect(nextReleaseVersion("v0.7.7")).toBe("0.7.8");
    expect(nextReleaseVersion("v0.7.7", "minor")).toBe("0.8.0");
    expect(nextReleaseVersion("v1.9.99", "minor")).toBe("1.10.0");
    for (const invalid of ["major", "", null, "MINOR"]) expect(() => parseReleaseClass(invalid)).toThrow("release class");
    for (const invalid of ["0.7.7", "v00.7.7", "v0.7.8-prealpha.1"]) expect(() => nextReleaseVersion(invalid)).toThrow("published stable");
  });
  test.each([".github/workflows/release-request.yml", ".github/workflows/signed-release.yml", ".github/CODEOWNERS", "scripts/release-policy.ts", "scripts/release-driver-runtime.ts", "scripts/release-host-lease.ts", "scripts/post-release-smoke.ts", "scripts/stable-qualification.ts", "scripts/release-generate.ts", "schemas/stable-release.schema.json", "STABLE_RELEASE.lock.json"])("protects authority, signer, publication and lease path %s", path => {
    expect(routineProtectedPath(path)).toBe(true);
  });
  test.each(["docs/RELEASE.md", "docs/TEST_PLAN.md", ".github/workflows/ci.yml", ".github/workflows/droplet-qualification.yml", "scripts/provision-linux-qual.sh", "scripts/device-cloud-runtime.ts", "scripts/release-driver.test.ts", "scripts/fixtures/digitalocean-delete-tag-removal.json", "scripts/check-repository.ts"])("admits reviewed routine path %s", path => {
    expect(routineProtectedPath(path)).toBe(false);
  });
  test("every script has a deliberate classification; new executable scripts fail closed", async () => {
    const root = join(import.meta.dir, "..");
    for (const file of await repositoryFiles(root)) {
      const path = file.slice(root.length + 1).replaceAll("\\", "/");
      if (!path.startsWith("scripts/")) continue;
      expect(routinePathClassification(path), path).not.toBeUndefined();
    }
    expect(routinePathClassification("scripts/unclassified-new-lane.ts")).toBeUndefined();
    expect(routineProtectedPath("scripts/unclassified-new-lane.ts")).toBe(true);
  });
  test("DB-R4 cleanup predicate binding belongs to the protected authority surface", () => {
    expect(routineProtectedPath("scripts/stable-lanes.ts")).toBe(true);
  });
  test("checks writer-readable protection facts against the installed administrator attestation", () => {
    const branch = { protected: true, protection: { enabled: true, required_status_checks: { contexts: [...REQUIRED_CHECKS], enforcement_level: "everyone" } } };
    expect(ROUTINE_BRANCH_PROTECTION.required_signatures).toBe(true);
    expect(ROUTINE_BRANCH_PROTECTION.required_status_checks.strict).toBe(true);
    expect(routineBranchProtectionMatches(branch)).toBe(true);
    expect(routineBranchProtectionMatches({ ...branch, protected: false })).toBe(false);
    branch.protection.required_status_checks.contexts.pop();
    expect(routineBranchProtectionMatches(branch)).toBe(false);
  });
  test("R3 protects lifecycle-capable mise configuration as well as its lock", () => {
    expect(routineProtectedPath("mise.lock")).toBe(true);
    expect(routineProtectedPath("mise.toml")).toBe(true);
    expect(routineProtectedPath("tools/fixtures/mise.toml")).toBe(true);
  });
  test("R1 exact generator output allowlists preserve rename and protected-path boundaries", () => {
    for (const kind of ["prepare", "approve", "record"] as const) {
      expect(generatedReleaseKind("release-driver/400/v0.7.5-prealpha.1-" + kind)).toBe(kind);
      expect(generatedReleaseFilesMatch(kind, GENERATED_RELEASE_PATHS[kind].map(filename => ({ filename })))).toBe(true);
      for (const filename of ["scripts/release-policy.ts", "apps/gateway/src/doctor.ts", "UPSTREAM.lock.json"]) {
        expect(generatedReleaseFilesMatch(kind, [{ filename }])).toBe(false);
        expect(generatedReleaseFilesMatch(kind, [{ filename: "docs/RELEASE_STATUS.md", previous_filename: filename }])).toBe(false);
      }
    }
    expect(generatedReleaseKind("release-driver/foreign-record")).toBeUndefined();
    expect(generatedReleaseFilesMatch(undefined, [])).toBe(false);
    expect(generatedReleaseFilesMatch("record", [{ filename: "README.md" }])).toBe(false);
    expect(generatedReleaseFilesMatch("record", [{ filename: "STABLE_RELEASE.lock.json" }])).toBe(false);
    expect(generatedReleaseFilesMatch("approve", [{ filename: "bun.lock" }])).toBe(false);
  });
  test("ordinary baseline pins and source fixes do not change the authority controls", () => {
    for (const path of ["apps/gateway/src/doctor.ts", "apps/gateway/test/diagnostics.test.ts", "UPSTREAM.lock.json", "scripts/windows-qualification-pins.json", "scripts/release-text.json"]) expect(routineProtectedPath(path)).toBe(false);
  });
});

const VERSION = "0.2.1";
const qualifiedManifest = () => ({
  $schema: "./schemas/stable-release.schema.json",
  schemaVersion: 1,
  version: VERSION,
  releaseTag: "v0.2.1",
  previousTag: "v0.2.0",
  status: "qualified",
  candidateTag: "v0.2.1-prealpha.21",
  candidateSourceCommit: "b".repeat(40),
  candidateArchiveSha256: "c".repeat(64),
  runtimeByteComparison: "passed",
  evidence: {
    debian: "passed",
    macos: "passed",
    android: "passed",
    ompPublication: "passed",
    provenance: "passed",
    secretSinks: "passed",
  },
  approvedAt: "2026-08-22T00:00:00.000Z",
});

describe("release tag policy", () => {
  test("publishes only the bare version as stable and latest", () => {
    expect(releasePolicy("v0.2.1", VERSION)).toEqual({
      channel: "stable",
      prerelease: false,
      latest: true,
    });
  });

  test("keeps every engineering, alpha, and beta shape out of Latest", () => {
    const expected = [
      ["v0.2.1-prealpha.1", "pre-alpha"],
      ["v0.2.1-prealpha.23", "pre-alpha"],
      ["v0.2.1-alpha", "alpha"],
      ["v0.2.1-alpha.2", "alpha"],
      ["v0.2.1-beta", "beta"],
      ["v0.2.1-beta.7", "beta"],
      ["provenance-test-v0.2.1.12", "pre-alpha"],
    ] as const;
    for (const [tag, channel] of expected) {
      expect(releasePolicy(tag, VERSION)).toEqual({ channel, prerelease: true, latest: false });
    }
  });

  test("rejects unknown, ambiguous, zero-indexed, and cross-version tags", () => {
    for (const tag of [
      "",
      "v0.2.1-rc.1",
      "v0.2.1-prealpha.0",
      "v0.2.1-prealpha.01",
      "v0.2.1-alpha.0",
      "v0.2.1-beta.0",
      "v0.2.1-stable",
      "v0.2.2",
      "V0.2.1",
      "v0.2.1 ",
    ]) {
      expect(() => releasePolicy(tag, VERSION)).toThrow(/^tag must be /);
    }
  });

  test("rejects a package version whose dots could widen tag matching", () => {
    for (const version of ["0.1", "0.1.0-beta", "0x1x0", "", " 0.1.0"]) {
      expect(() => releasePolicy("v0.1.0", version)).toThrow(/^package version must be numeric major\.minor\.patch/);
    }
  });

  test("a tag installs as its bare package version, whatever its channel", () => {
    // The Windows lane once expected v0.6.0-prealpha.1 to install as "0.6.0-prealpha.1".
    for (const tag of ["v0.2.1", "v0.2.1-prealpha.1", "v0.2.1-alpha", "v0.2.1-beta.7", "provenance-test-v0.2.1.12"]) {
      expect(releaseVersion(tag)).toBe(VERSION);
    }
    for (const tag of ["", "0.2.1", "v0.2", "v0.2.1-rc.1", "v0.2.1-prealpha.0", "V0.2.1"]) {
      expect(() => releaseVersion(tag)).toThrow();
    }
  });

  test("refuses stable publication until every commit-bound qualification field passes", () => {
    const pending = qualifiedManifest();
    pending.status = "pending";
    expect(() => assertStableReleaseQualification(pending, "v0.2.1", VERSION)).toThrow(
      "stable release qualification is pending",
    );
    const incomplete = qualifiedManifest();
    incomplete.evidence.android = "pending";
    expect(() => assertStableReleaseQualification(incomplete, "v0.2.1", VERSION)).toThrow(
      "stable release evidence is incomplete",
    );
    const missingPredecessor = qualifiedManifest();
    Reflect.deleteProperty(missingPredecessor, "previousTag");
    expect(() => assertStableReleaseQualification(missingPredecessor, "v0.2.1", VERSION)).toThrow(
      "unexpected fields",
    );
  });

  test("a complete historical approval cannot authorize a different release", () => {
    expect(() => assertStableReleaseQualification(qualifiedManifest(), "v0.3.0", "0.3.0")).toThrow();
    const wrongCandidate = qualifiedManifest();
    wrongCandidate.candidateTag = "v0.3.0-prealpha.1";
    expect(() => assertStableReleaseQualification(wrongCandidate, "v0.2.1", VERSION)).toThrow();
  });

  test("from 0.6.0 stable approval also requires passed Windows and background Push evidence", () => {
    const campaign = () => {
      const manifest = {
        ...qualifiedManifest(),
        version: "0.6.0",
        releaseTag: "v0.6.0",
        previousTag: "v0.5.3",
        candidateTag: "v0.6.0-prealpha.1",
      };
      return { ...manifest, evidence: { ...manifest.evidence, windows: "passed", androidPush: "passed" } };
    };
    expect(() => assertStableReleaseQualification(campaign(), "v0.6.0", "0.6.0")).not.toThrow();
    const sixLanes = { ...campaign(), evidence: qualifiedManifest().evidence };
    expect(() => assertStableReleaseQualification(sixLanes, "v0.6.0", "0.6.0")).toThrow("unexpected fields");
    const pendingPush = campaign();
    pendingPush.evidence.androidPush = "pending";
    expect(() => assertStableReleaseQualification(pendingPush, "v0.6.0", "0.6.0")).toThrow(
      "stable release evidence is incomplete",
    );
    // An earlier release keeps the six lanes it was actually qualified with.
    const earlier = { ...qualifiedManifest(), evidence: campaign().evidence };
    expect(() => assertStableReleaseQualification(earlier, "v0.2.1", VERSION)).toThrow("unexpected fields");
  });

  test("from 0.6.2 stable approval also requires passed real-device cloud evidence", () => {
    const campaign = () => {
      const manifest = {
        ...qualifiedManifest(),
        version: "0.6.2",
        releaseTag: "v0.6.2",
        previousTag: "v0.6.1",
        candidateTag: "v0.6.2-prealpha.1",
      };
      return { ...manifest, evidence: { ...manifest.evidence, windows: "passed", androidPush: "passed", deviceCloud: "passed" } };
    };
    expect(() => assertStableReleaseQualification(campaign(), "v0.6.2", "0.6.2")).not.toThrow();
    const withoutCloud = campaign();
    Reflect.deleteProperty(withoutCloud.evidence, "deviceCloud");
    expect(() => assertStableReleaseQualification(withoutCloud, "v0.6.2", "0.6.2")).toThrow("unexpected fields");
    const pendingCloud = campaign();
    pendingCloud.evidence.deviceCloud = "pending";
    expect(() => assertStableReleaseQualification(pendingCloud, "v0.6.2", "0.6.2")).toThrow(
      "stable release evidence is incomplete",
    );
    // v0.6.1 was qualified before the lane existed and keeps the eight lanes it actually passed.
    const v061 = { ...campaign(), version: "0.6.1", releaseTag: "v0.6.1", previousTag: "v0.6.0", candidateTag: "v0.6.1-prealpha.1" };
    expect(() => assertStableReleaseQualification(v061, "v0.6.1", "0.6.1")).toThrow("unexpected fields");
  });

  test("CLI emits stable GitHub environment values only with a qualified manifest", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "stable-release-policy-"));
    try {
      const manifestPath = join(temporaryRoot, "qualification.json");
      await writeFile(manifestPath, JSON.stringify(qualifiedManifest()));
      const subprocess = Bun.spawn(
        [process.execPath, "scripts/release-policy.ts", "v0.2.1", VERSION, manifestPath],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = await new Response(subprocess.stdout).text();
      expect(await subprocess.exited).toBe(0);
      expect(output).toBe("OMP_RELEASE_CHANNEL=stable\nRELEASE_IS_PRERELEASE=false\nRELEASE_IS_LATEST=true\n");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
