export const REQUIRED_CHECKS = [
  "implementation-checks", "windows-service-lifecycle", "browser-notifications",
  "portable-source (ubuntu-24.04)", "portable-source (macos-latest)",
  "portable-source (windows-latest)", "browser-core",
] as const;
/** Administrator observation at the one-time setup review; runtime never requests admin credentials. */
export const ROUTINE_BRANCH_PROTECTION = {
  required_status_checks: { strict: true, contexts: REQUIRED_CHECKS }, enforce_admins: true,
  required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true,
    require_code_owner_reviews: false, require_last_push_approval: false },
  required_signatures: true, required_linear_history: false, allow_force_pushes: false,
  allow_deletions: false, required_conversation_resolution: true, restrictions: null,
} as const;
/** Verify every protection fact visible to a repository writer; admin-only fields stay attested above. */
export function routineBranchProtectionMatches(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const branch = value as { protected?: unknown; protection?: { enabled?: unknown; required_status_checks?: { contexts?: unknown; enforcement_level?: unknown } } };
  const checks = branch.protection?.required_status_checks;
  const contexts = checks?.contexts;
  return branch.protected === true && branch.protection?.enabled === true && checks?.enforcement_level === "everyone"
    && Array.isArray(contexts) && contexts.length === REQUIRED_CHECKS.length
    && REQUIRED_CHECKS.every(name => contexts.includes(name));
}

/** Executable authority, not directory membership, determines the separately installed trust root. */
export const ROUTINE_AUTHORITY_PATHS: Readonly<Record<string, string>> = {
  ".github/CODEOWNERS": "Assigns control-path review ownership.",
  ".github/workflows/release-request.yml": "Creates and classifies release requests.",
  ".github/workflows/signed-release.yml": "Signs, attests and publishes immutable release assets.",
  ".github/workflows/pages.yml": "Publishes public release claims.",
  "scripts/release-policy.ts": "Defines release authorization and protected-path classification.",
  "scripts/release-driver.ts": "Selects requests and authorizes release transitions.",
  "scripts/release-driver-runtime.ts": "Binds reviews, signs tags and merges/publishes release subjects.",
  "scripts/com.omp.gateway-release-driver.plist": "Installs driver identity, signing inputs and execution policy.",
  "scripts/release-host-lease.ts": "Excludes competing campaigns and authorizes owner recovery.",
  "scripts/android-pixel-lease.ts": "Excludes competing standalone physical-device owners.",
  "scripts/release-generate.ts": "Generates preparation, approval and publication records.",
  "scripts/release-state.ts": "Classifies candidate and published release state.",
  "scripts/release-tag-state.ts": "Validates immutable signed tag identity.",
  "scripts/release-runtime-compare.ts": "Authorizes promotion by comparing candidate runtime bytes.",
  "scripts/release-download.ts": "Stages the release assets used for provenance verification.",
  "scripts/post-release-smoke.ts": "Verifies signatures and produces published-byte smoke evidence.",
  "scripts/stable-qualification.ts": "Defines campaign receipt, admission and settlement gates; not an individual lane.",
  "scripts/stable-lanes.ts": "Binds the cleanup predicates that authorize release-host custody retirement.",
  "scripts/qualification-failure.ts": "Defines closed failure classification and infrastructure retry eligibility.",
  "scripts/qualification-outcome.ts": "Binds machine failure evidence to exact campaign and authority inputs.",
  "scripts/build-release.ts": "Constructs the signed release archive and release identity.",
  "scripts/evidence-schema.ts": "Defines accepted release evidence shapes.",
  "scripts/provider-read.ts": "Bounds authoritative provider reads, including immutable release state.",
  "STABLE_RELEASE.lock.json": "Authoritative generated qualification/promotion record.",
};
/** Reviewed implementation/qualification fixes do not require reinstalling the driver. */
export const ROUTINE_IMPLEMENTATION_PATHS: Readonly<Record<string, string>> = {
  ".github/workflows/ci.yml": "Runs implementation checks, with no release signing/publication.",
  ".github/workflows/compatibility.yml": "Exercises compatibility checks.",
  ".github/workflows/browser-flake-budget.yml": "Audits sanitized browser CI flakes without release authority.",
  ".github/workflows/droplet-qualification.yml": "Runs and cleans the Debian qualification host.",
  ".github/workflows/capacity-qualification.yml": "Exercises capacity qualification.",
  ".github/workflows/platform-qualification.yml": "Exercises platform qualification.",
  ".github/workflows/upstream-canary.yml": "Exercises upstream compatibility.",
  ".github/dependabot.yml": "Proposes dependency updates; manifests still require authority review.",
  ".github/pull_request_template.md": "Guides pull request authors without granting authority.",
  ".github/ISSUE_TEMPLATE/config.yml": "Configures issue intake only.",
  ".github/ISSUE_TEMPLATE/bug_report.yml": "Collects bug reports.",
  ".github/ISSUE_TEMPLATE/feature_request.yml": "Collects feature requests.",
  "scripts/acceptance-target.ts": "Selects bounded qualification test targets.",
  "scripts/android-acceptance.ts": "Exercises Android acceptance journeys.",
  "scripts/android-collab-smoke.ts": "Exercises Android collaboration.",
  "scripts/android-device.ts": "Runs bounded Android device commands.",
  "scripts/android-leak-probe.ts": "Probes synthetic capability leakage.",
  "scripts/android-leak-sweep.ts": "Sweeps device artifacts for synthetic leaks.",
  "scripts/android-notification.ts": "Exercises device notifications.",
  "scripts/android-push-qualification.ts": "Executes physical Push qualification.",
  "scripts/android-push-runtime.ts": "Implements physical Push lane operations.",
  "scripts/android-recovery.ts": "Restores Android test state.",
  "scripts/android-stages.ts": "Sequences Android test stages.",
  "scripts/android-webapk.ts": "Exercises installed Android shells.",
  "scripts/browser-journey.ts": "Exercises synthetic collaboration journeys.",
  "scripts/browser-flake-reporter.ts": "Retains closed browser test-attempt evidence only.",
  "scripts/browser-flake-budget.ts": "Audits browser CI flake budgets without authorizing releases.",
  "scripts/browserstack.ts": "Runs BrowserStack lane operations and cleanup.",
  "scripts/browserstack-pins.json": "Pins BrowserStack qualification targets.",
  "scripts/build-web.ts": "Builds web implementation assets, not publication authority.",
  "scripts/capability-leak-rules.ts": "Checks synthetic capability sinks.",
  "scripts/check-capability-leaks.ts": "Runs capability leak checks.",
  "scripts/check-evidence.ts": "Checks committed qualification documentation.",
  "scripts/check-identifier-leaks.ts": "Runs identifier leak checks.",
  "scripts/check-repository.ts": "Checks repository implementation conventions.",
  "scripts/device-cloud-attestation.ts": "Audits device-cloud lane results, not release signing attestations.",
  "scripts/device-cloud-availability.ts": "Classifies bounded device availability observations.",
  "scripts/device-cloud-common.ts": "Shares device-cloud lane plumbing.",
  "scripts/device-cloud-development.ts": "Runs nonqualifying device-cloud development journeys.",
  "scripts/device-cloud-outcome.ts": "Serializes device-cloud lane outcomes.",
  "scripts/device-cloud-qualification.ts": "Executes device-cloud qualification journeys.",
  "scripts/device-cloud-record-json.ts": "Parses cloud-vendor artifact records.",
  "scripts/device-cloud-runtime.ts": "Implements cloud-device operations and cleanup.",
  "scripts/device-cloud-webdriver.ts": "Implements the device-cloud WebDriver transport.",
  "scripts/endurance-metrics.ts": "Summarizes endurance measurements.",
  "scripts/gateway-endurance.ts": "Exercises gateway endurance.",
  "scripts/identifier-leak-rules.ts": "Checks synthetic identifier sinks.",
  "scripts/metadata-safety.ts": "Filters synthetic qualification metadata.",
  "scripts/omp-fixture.json": "Pins the synthetic OMP qualification fixture.",
  "scripts/omp-fixture.ts": "Runs the synthetic OMP fixture.",
  "scripts/omp-lifecycle-development.ts": "Exercises development-only OMP lifecycle.",
  "scripts/omp-lifecycle-qualification.ts": "Executes the OMP lifecycle lane.",
  "scripts/provision-linux-qual.sh": "Provisions and tears down Linux qualification hosts.",
  "scripts/push-qualification-fixture.ts": "Runs synthetic Push scenarios.",
  "scripts/qualify-macos-host.sh": "Executes retained-Mac qualification and cleanup.",
  "scripts/qualify-macos-omp.sh": "Exercises stock OMP on the retained Mac.",
  "scripts/qualification-logs.ts": "Collects bounded privacy-safe qualification events; never grants release retry authority.",
  "scripts/qualify-rollback.sh": "Exercises the rollback lane.",
  "scripts/relay-soak.ts": "Exercises relay lifetime and reconnection.",
  "scripts/release-text.json": "Holds generated human release copy, never authorization.",
  "scripts/repository-files.ts": "Enumerates repository files for checks.",
  "scripts/restoration.ts": "Reports device restoration state for qualification lanes.",
  "scripts/synthetic-hosts.ts": "Supplies synthetic test hosts.",
  "scripts/test-browser.ts": "Runs browser implementation checks.",
  "scripts/test-portable.ts": "Runs portable implementation checks.",
  "scripts/test-visual.ts": "Runs synthetic visual checks.",
  "scripts/testingbot.ts": "Runs TestingBot lane operations and cleanup.",
  "scripts/upstream-canary.ts": "Exercises stock upstream compatibility.",
  "scripts/upstream-pins.ts": "Generates order-scoped upstream baseline pins.",
  "scripts/vendor-nerd-symbols.ts": "Regenerates the vendored symbol-font subset from a pinned upstream archive.",
  "scripts/vultr-target.ts": "Selects qualification cloud targets.",
  "scripts/windows-qualification-guest.ps1": "Executes Windows guest qualification.",
  "scripts/windows-qualification-pins.json": "Pins order-scoped Windows qualification tools.",
  "scripts/windows-qualification-runtime.ts": "Implements Windows lane operations and cleanup.",
  "scripts/windows-stable-qualification.ts": "Executes the Windows qualification lane.",
  "scripts/windows-winrm.py": "Transports Windows qualification commands.",
  "scripts/media/capture-readme-media.ts": "Captures authored demonstration media.",
  "scripts/media/readme-media-contract.ts": "Defines demonstration media checks.",
  "scripts/media/readme-media-compositor.ts": "Composes authored demonstration media.",
  "scripts/media/check-readme-media.ts": "Checks demonstration media.",
};
export function routinePathClassification(path: string): { authority: boolean; reason: string } | undefined {
  if (ROUTINE_AUTHORITY_PATHS[path]) return { authority: true, reason: ROUTINE_AUTHORITY_PATHS[path]! };
  if (path.startsWith("schemas/")) return { authority: true, reason: "Defines release/runtime input schemas." };
  if (/(^|\/)(?:tsconfig[^/]*\.json|bunfig\.toml|mise\.toml|[^/]*lock[^/]*|AGENTS\.md|CLAUDE\.md)$/u.test(path)
    && !["UPSTREAM.lock.json", "bun.lock"].includes(path)) return { authority: true, reason: "Controls installed tooling, dependencies or agent authority." };
  if (ROUTINE_IMPLEMENTATION_PATHS[path]) return { authority: false, reason: ROUTINE_IMPLEMENTATION_PATHS[path]! };
  if (path.startsWith("scripts/fixtures/")) return { authority: false, reason: "Synthetic test inputs; not executable release authority." };
  if (path.startsWith("scripts/") && /\.test\.(?:ts|py)$/u.test(path)) return { authority: false, reason: "Tests implementation behavior without granting release authority." };
  if (path.startsWith("scripts/") || path.startsWith(".github/")) return undefined;
  return { authority: false, reason: "Reviewed implementation or documentation; manifests have a separate normalized fingerprint." };
}
export function routineProtectedPath(path: string): boolean {
  return routinePathClassification(path)?.authority ?? true;
}
export const GENERATED_RELEASE_PATHS = {
  prepare: ["package.json", "apps/gateway/package.json", "apps/web/package.json", "packages/collab-client/package.json", "packages/protocol/package.json",
    "apps/gateway/src/diagnostics.ts", "scripts/build-release.ts", "apps/gateway/src/installation.ts", "bun.lock", "CHANGELOG.md",
    "scripts/release-text.json", "docs/RELEASE_STATUS.md", "docs/ANDROID.md", "docs/ATTENTION_SPEC.md", "docs/LIFECYCLE_BRANCH_RESUME.md", "docs/BACKLOG.md"],
  approve: ["STABLE_RELEASE.lock.json", "docs/RELEASE_STATUS.md", "docs/UPGRADE_ROLLBACK.md", "README.md", "docs/COMPATIBILITY.md", "site/llms.txt", "site/status/index.html", "scripts/release-text.json"],
  record: ["docs/RELEASE_STATUS.md", "docs/ANDROID.md", "docs/ATTENTION_SPEC.md", "docs/LIFECYCLE_BRANCH_RESUME.md", "docs/BACKLOG.md", "docs/COMPATIBILITY.md", "site/llms.txt", "site/status/index.html", "scripts/release-text.json"],
} as const;
export type GeneratedReleaseKind = keyof typeof GENERATED_RELEASE_PATHS;
export function generatedReleaseKind(headRef: string): GeneratedReleaseKind | undefined {
  return /^release-driver\/[1-9][0-9]*\/v[0-9]+\.[0-9]+\.[0-9]+-prealpha\.[1-9][0-9]*-(prepare|approve|record)$/u.exec(headRef)?.[1] as GeneratedReleaseKind | undefined;
}
/** A version-bearing control is permitted only with the runtime's normalized control equality check. */
export function generatedReleaseFilesMatch(kind: GeneratedReleaseKind | undefined, files: readonly { filename: string; previous_filename?: string }[]): boolean {
  if (kind === undefined) return false;
  const paths: readonly string[] = GENERATED_RELEASE_PATHS[kind];
  return files.every(file => [file.filename, ...(file.previous_filename === undefined ? [] : [file.previous_filename])]
    .every(path => paths.includes(path) && (!routineProtectedPath(path) || (kind === "prepare" && path === "scripts/build-release.ts")
      || (kind === "approve" && path === "STABLE_RELEASE.lock.json"))));
}

export type ReleaseClass = "patch" | "minor";
export function parseReleaseClass(value: unknown = "patch"): ReleaseClass {
  if (value !== "patch" && value !== "minor") throw new Error("release class must be patch or minor");
  return value;
}
/** Selection, preparation and promotion must agree on the same requested transition. */
export function nextReleaseVersion(previousTag: string, releaseClass: ReleaseClass = "patch"): string {
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(previousTag)) throw new Error("expected exact published stable tag");
  const [major, minor, patch] = releaseVersion(previousTag).split(".").map(BigInt);
  return parseReleaseClass(releaseClass) === "minor" ? `${major}.${minor! + 1n}.0` : `${major}.${minor}.${patch! + 1n}`;
}

export const ROUTINE_HOLD_REASONS = ["authority-path-changed", "policy-changed", "out-of-class", "stale-source",
  "missing-evidence", "head-tree-changed", "unexpected-merger", "pr-identity-changed", "required-checks-missing",
  "merge-tree-changed", "merge-missing", "merge-signature-missing", "generated-content-mismatch"] as const;
export type RoutineHoldReason = typeof ROUTINE_HOLD_REASONS[number];
export class RoutineHoldError extends Error {
  constructor(readonly reason: RoutineHoldReason, readonly sourceCommit?: string) {
    super(reason + (sourceCommit === undefined ? "" : " at source commit " + sourceCommit)); this.name = "RoutineHoldError";
  }
}
export const ROUTINE_EVIDENCE_STEPS = ["qualification", "stable-build", "runtime-comparison", "release-policy", "smoke-plan", "local-checks"] as const;
export interface RoutineEvidence {
  head: string; tree: string; candidate: string; candidateCommit: string; candidateDigest: string;
  policy: string; steps: readonly string[];
}
export interface RoutineAuthority {
  policy: string;
  protectedChanges: string[];
  sourceReviewed: boolean;
  unreviewedCommit?: string;
  sourceFresh: boolean;
  releaseClassAllowed: boolean;
}
export interface RoutineSubject {
  head?: string | undefined; tree?: string | undefined; candidate: string;
  candidateCommit?: string | undefined; candidateDigest?: string | undefined; policy?: string | undefined;
}
export interface RoutinePromotion {
  author: string; base: string; headRepository: string; headRef: string; head: string; tree: string;
  files: readonly { filename: string; previous_filename?: string }[];
  state: "open" | "closed"; draft: boolean; merged: boolean; checksPassed: boolean; behind: boolean;
  mergedBy?: string | undefined; mergeTree?: string | undefined; mergeCommit?: string | undefined; mergeVerified?: boolean | undefined;
}
export function routineSourceHold(authority: RoutineAuthority | undefined, expectedPolicy?: string): RoutineHoldReason | undefined {
  if (!authority) return "missing-evidence";
  if (authority.protectedChanges.length) return "authority-path-changed";
  if (expectedPolicy !== undefined && authority.policy !== expectedPolicy) return "policy-changed";
  if (!authority.releaseClassAllowed || !authority.sourceReviewed) return "out-of-class";
  if (!authority.sourceFresh) return "stale-source";
  return undefined;
}
/** The same predicate guards merge planning, replay, and stable signing. Missing data never grants authority. */
export function routineReleaseHold(input: {
  subject: RoutineSubject; authority?: RoutineAuthority | undefined; evidence?: RoutineEvidence | undefined;
  pr?: RoutinePromotion | undefined; bot: string; repository: string; branch: string; merged?: boolean;
}): RoutineHoldReason | undefined {
  const { subject, authority, evidence, pr } = input;
  const sourceHold = routineSourceHold(authority, subject.policy);
  if (sourceHold !== undefined) return sourceHold;
  if (!subject.policy) return "policy-changed";
  if (!pr || pr.author !== input.bot || pr.base !== "main" || pr.headRepository !== input.repository || pr.headRef !== input.branch || pr.draft || (pr.state === "closed" && !pr.merged)) return "pr-identity-changed";
  if (pr.head !== subject.head || pr.tree !== subject.tree) return "head-tree-changed";
  if (!generatedReleaseFilesMatch("approve", pr.files)) return "generated-content-mismatch";
  if (!evidence || !subject.candidateCommit || !subject.candidateDigest || evidence.head !== subject.head || evidence.tree !== subject.tree
    || evidence.candidate !== subject.candidate || evidence.candidateCommit !== subject.candidateCommit
    || evidence.candidateDigest !== subject.candidateDigest || evidence.policy !== subject.policy
    || ROUTINE_EVIDENCE_STEPS.some(step => !evidence.steps.includes(step))) return "missing-evidence";
  if (!pr.checksPassed || (!pr.merged && pr.behind)) return "required-checks-missing";
  if (pr.merged) {
    if (pr.mergedBy !== input.bot) return "unexpected-merger";
    if (pr.mergeTree !== subject.tree) return "merge-tree-changed";
    if (!pr.mergeCommit) return "merge-missing";
    if (pr.mergeVerified !== true) return "merge-signature-missing";
  } else if (input.merged) return "merge-missing";
  return undefined;
}

export type ReleaseChannel = "pre-alpha" | "alpha" | "beta" | "stable";

export interface ReleasePolicy {
  readonly channel: ReleaseChannel;
  readonly prerelease: boolean;
  readonly latest: boolean;
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const POSITIVE_INTEGER = "[1-9][0-9]*";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const QUALIFICATION_KEYS = [
  "$schema",
  "approvedAt",
  "candidateArchiveSha256",
  "candidateSourceCommit",
  "candidateTag",
  "evidence",
  "previousTag",
  "releaseTag",
  "runtimeByteComparison",
  "schemaVersion",
  "status",
  "version",
] as const;
const EVIDENCE_KEYS = ["android", "debian", "macos", "ompPublication", "provenance", "secretSinks"] as const;
/** From 0.6.0 every stable campaign also qualifies a Windows host and Pixel background Web Push (ADR-031). */
const CAMPAIGN_EVIDENCE_KEYS = ["android", "androidPush", "debian", "macos", "ompPublication", "provenance", "secretSinks", "windows"] as const;
/** From 0.6.2 it also qualifies iPhone, iPad, and Android browsers on real cloud devices (ADR-032). */
const DEVICE_CLOUD_EVIDENCE_KEYS = [
  "android", "androidPush", "debian", "deviceCloud", "macos", "ompPublication", "provenance", "secretSinks", "windows",
] as const;

function requiredEvidence(version: string): readonly string[] {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (major > 0 || minor > 6 || (minor === 6 && patch >= 2)) return DEVICE_CLOUD_EVIDENCE_KEYS;
  return minor === 6 ? CAMPAIGN_EVIDENCE_KEYS : EVIDENCE_KEYS;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(label + " has unexpected fields");
  }
}

/** Stable tags are authorized only by a commit-bound, fully passed qualification manifest. */
export function assertStableReleaseQualification(value: unknown, tag: string, version: string): void {
  const qualification = record(value, "stable release qualification");
  exactKeys(qualification, QUALIFICATION_KEYS, "stable release qualification");
  if (qualification.$schema !== "./schemas/stable-release.schema.json" || qualification.schemaVersion !== 1) {
    throw new Error("stable release qualification schema is unsupported");
  }
  if (qualification.version !== version || qualification.releaseTag !== tag) {
    throw new Error("stable release qualification does not match the requested tag");
  }
  if (qualification.status !== "qualified") {
    throw new Error("stable release qualification is pending");
  }
  const candidatePattern = new RegExp(
    "^v" + version.replaceAll(".", "\\.") + "-prealpha\\." + POSITIVE_INTEGER + "$",
    "u",
  );
  if (
    typeof qualification.candidateTag !== "string" ||
    !candidatePattern.test(qualification.candidateTag) ||
    typeof qualification.candidateSourceCommit !== "string" ||
    !COMMIT_PATTERN.test(qualification.candidateSourceCommit) ||
    typeof qualification.candidateArchiveSha256 !== "string" ||
    !SHA256_PATTERN.test(qualification.candidateArchiveSha256) ||
    typeof qualification.previousTag !== "string" ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(qualification.previousTag) ||
    qualification.previousTag === tag ||
    qualification.runtimeByteComparison !== "passed"
  ) {
    throw new Error("stable release candidate evidence is incomplete");
  }
  const evidence = record(qualification.evidence, "stable release evidence");
  const required = requiredEvidence(version);
  exactKeys(evidence, required, "stable release evidence");
  if (required.some(key => evidence[key] !== "passed")) {
    throw new Error("stable release evidence is incomplete");
  }
  if (typeof qualification.approvedAt !== "string" || !Number.isFinite(Date.parse(qualification.approvedAt))) {
    throw new Error("stable release qualification has no approval timestamp");
  }
}

/** Exact tag-to-publication policy. Unknown shapes fail before a release build starts. */
export function releasePolicy(tag: string, version: string): ReleasePolicy {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`package version must be numeric major.minor.patch, not ${JSON.stringify(version)}`);
  }

  const base = `v${version}`;
  if (tag === base) return { channel: "stable", prerelease: false, latest: true };
  if (new RegExp(`^${base.replaceAll(".", "\\.")}-prealpha\\.${POSITIVE_INTEGER}$`, "u").test(tag)) {
    return { channel: "pre-alpha", prerelease: true, latest: false };
  }
  if (new RegExp(`^${base.replaceAll(".", "\\.")}-alpha(?:\\.${POSITIVE_INTEGER})?$`, "u").test(tag)) {
    return { channel: "alpha", prerelease: true, latest: false };
  }
  if (new RegExp(`^${base.replaceAll(".", "\\.")}-beta(?:\\.${POSITIVE_INTEGER})?$`, "u").test(tag)) {
    return { channel: "beta", prerelease: true, latest: false };
  }
  if (new RegExp(`^provenance-test-${base.replaceAll(".", "\\.")}\\.${POSITIVE_INTEGER}$`, "u").test(tag)) {
    return { channel: "pre-alpha", prerelease: true, latest: false };
  }

  throw new Error(
    `tag must be ${base}, ${base}-prealpha.<n>, ${base}-alpha[.<n>], ${base}-beta[.<n>], or provenance-test-${base}.<n> (n >= 1)`,
  );
}

/** The package version a release tag builds: `v0.6.0-prealpha.1` installs as `0.6.0`. */
export function releaseVersion(tag: string): string {
  const version = /^(?:provenance-test-)?v([0-9]+[.][0-9]+[.][0-9]+)/u.exec(tag)?.[1];
  if (version === undefined) throw new Error("release tag does not contain a numeric version");
  releasePolicy(tag, version);
  return version;
}

if (import.meta.main) {
  const [tag, version, qualificationPath] = Bun.argv.slice(2);
  if (tag === undefined || version === undefined || qualificationPath === undefined) {
    console.error("usage: bun scripts/release-policy.ts <tag> <package-version> <qualification-manifest>");
    process.exit(2);
  }
  try {
    const policy = releasePolicy(tag, version);
    if (policy.channel === "stable") {
      assertStableReleaseQualification(await Bun.file(qualificationPath).json(), tag, version);
    }
    console.log("OMP_RELEASE_CHANNEL=" + policy.channel);
    console.log("RELEASE_IS_PRERELEASE=" + String(policy.prerelease));
    console.log("RELEASE_IS_LATEST=" + String(policy.latest));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
