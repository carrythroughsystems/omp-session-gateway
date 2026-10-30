import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudReleaseEvidence, generateRelease, RELEASE_TEXT, runReleaseGenerate, type ReleaseGenerateOptions } from "./release-generate.ts";
import type { DeviceCloudProgress } from "./device-cloud-qualification.ts";
import { historicalTrees, normalizeHistoricalTree } from "./fixtures/release-generate/historical.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = new URL("./fixtures/release-generate/", import.meta.url);
async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
}
const originals = historicalTrees();
const receipt = await fixture("v0.7.4.receipt.json");
const recordedCloudRetry = await fixture("v0.8.0-prealpha.5.cloud-retry.json");
const smoke = await fixture("v0.7.4.smoke.json");
const status = await fixture("v0.7.4.status.json");
// Preserve the recorded fixture; simulate its publication at the transferred repository.
const publication = JSON.parse(JSON.stringify(await fixture("v0.7.4.publication.json")).replaceAll("https://github.com/alphastorm/omp-session-gateway", "https://github.com/carrythroughsystems/omp-session-gateway"));
const releaseText = await readFile(new URL("v0.7.4.release-text.json", fixtures), "utf8");
const prepareOptions: ReleaseGenerateOptions = { command: "prepare", version: "0.7.4", date: "2026-10-03" };
const approveOptions: ReleaseGenerateOptions = { command: "approve", version: "v0.7.4", date: "2026-10-03", candidateTag: "v0.7.4-prealpha.1", receipt };
const recordOptions: ReleaseGenerateOptions = { command: "record", version: "v0.7.4", date: "2026-10-03", smoke, status, publication };
const prepareBefore: Record<string, string> = { ...normalizeHistoricalTree(originals["dcfa0b3^"]!, { emptyLedger: true }), [RELEASE_TEXT]: releaseText };
const prepared = generateRelease(prepareBefore, prepareOptions);
const approveBefore: Record<string, string> = { ...normalizeHistoricalTree(originals["39e3d57^"]!), [RELEASE_TEXT]: prepared[RELEASE_TEXT]! };
const approved = generateRelease(approveBefore, approveOptions);
// The parent has handwritten approval prose. Normalize those same surfaces to the generated
// approval form; all other parent bytes (including backlog tasks and dated history) stay intact.
const recordBefore: Record<string, string> = { ...normalizeHistoricalTree(originals["9c0d790^"]!), ...approved };
const recorded = generateRelease(recordBefore, recordOptions);
const cases = { prepare: { before: prepareBefore, options: prepareOptions, result: prepared }, approve: { before: approveBefore, options: approveOptions, result: approved }, record: { before: recordBefore, options: recordOptions, result: recorded } };
const goldens = await fixture("golden.json") as Record<string, Record<string, string>>;

describe("cloud vendor release attribution", () => {
  interface CloudEvidence {
    passed: boolean; vendor: string; tunnelVersion: string;
    targets: Record<"iphone" | "ipad" | "android", Record<string, string | number | boolean>>;
    audit: Record<string, number>;
  }
  const legacy = (receipt as { lanes: { deviceCloud: { evidence: { result: CloudEvidence } } } }).lanes.deviceCloud.evidence.result;
  function mixed(): CloudEvidence {
    const result = structuredClone(legacy);
    result.vendor = "mixed";
    result.tunnelVersion = "per-target";
    for (const name of ["iphone", "ipad", "android"] as const) Object.assign(result.targets[name], {
      vendor: name === "iphone" ? "TestingBot" : "BrowserStack", tunnelVersion: name === "iphone" ? "4.9" : "8.9",
    });
    Object.assign(result.targets.ipad, { device: "iPad (10th generation)", os: "27.0", browserVersion: "27.0" });
    Object.assign(result.audit, { testingbotRecords: 1, browserstackRecords: 2, lingeringSignedArtifacts: 0 });
    return result;
  }
  test("keeps legacy wording and attributes each mixed target, not a global vendor guess", () => {
    expect(cloudReleaseEvidence(legacy).summary).toBe("TestingBot real devices, tunnel 4.9: iPhone 17 Pro Max (26.6, safari 26.6); iPad (9th generation) (26.6, safari 26.6); Galaxy S25 (15.0.0, chrome 149.0.7827.159). Home Screen alerts do not qualify lock-screen presentation.");
    const projected = cloudReleaseEvidence(mixed());
    expect(projected.devices.iphone).toContain("TestingBot, tunnel 4.9:");
    expect(projected.devices.ipad).toContain("BrowserStack, tunnel 8.9: iPad (10th generation)");
    expect(projected.devices.android).toContain("BrowserStack, tunnel 8.9: Galaxy S25");
    expect(projected.summary).toContain("only on the TestingBot iPhone");
  });
  test.each(["iphone vendor", "Android OEM", "Android hardware", "browser", "aggregate vendor", "audit counts"] as const)("refuses inconsistent %s", kind => {
    const invalid = mixed();
    if (kind === "iphone vendor") invalid.targets.iphone.vendor = "BrowserStack";
    if (kind === "Android OEM") invalid.targets.android.device = "Google Pixel 10 Pro";
    if (kind === "Android hardware") invalid.targets.android.model = "SM-S921B";
    if (kind === "browser") invalid.targets.ipad.browser = "chrome";
    if (kind === "aggregate vendor") invalid.vendor = "TestingBot";
    if (kind === "audit counts") invalid.audit.browserstackRecords = 0;
    expect(() => cloudReleaseEvidence(invalid)).toThrow();
  });

  function retry() {
    return structuredClone(recordedCloudRetry) as {
      result: CloudEvidence & { journeys: NonNullable<DeviceCloudProgress["journeys"]> };
      progress: DeviceCloudProgress;
    };
  }
  test("recorded .5 iPhone retry projects three final targets from four audited allocations", () => {
    const evidence = retry();
    expect(evidence.result.audit).toMatchObject({ records: 4, testingbotRecords: 3, browserstackRecords: 1 });
    expect(evidence.result.journeys.iphone).toEqual([
      { attempt: 1, outcome: "journey-failed", stage: "home-screen" }, { attempt: 2, outcome: "passed" },
    ]);
    const projected = cloudReleaseEvidence(evidence.result, evidence.progress);
    expect(Object.keys(projected.devices)).toEqual(["iphone", "ipad", "android"]);
    expect(projected.devices.iphone).toContain("TestingBot, tunnel 4.9: iPhone 17 Pro");
    expect(projected.devices.ipad).toContain("BrowserStack, tunnel 8.9: iPad (10th generation)");
  });
  test("approval passes recorded retry progress to the cloud projection", () => {
    const evidence = retry();
    const candidate = structuredClone(receipt) as { lanes: {
      deviceCloud: { evidence: unknown }; deviceCloudCleanup: { evidence: { epoch: string } };
    } };
    candidate.lanes.deviceCloud.evidence = evidence;
    candidate.lanes.deviceCloudCleanup.evidence.epoch = evidence.progress.epoch;
    expect(generateRelease(approveBefore, { ...approveOptions, receipt: candidate })["docs/COMPATIBILITY.md"])
      .toContain("TestingBot, tunnel 4.9: iPhone 17 Pro");
  });
  test("audit vendor totals follow allocations when a retry changes vendor", () => {
    const evidence = retry(), resources = evidence.progress.resources!;
    const failed = resources.shift()!;
    resources[0]!.attempt = 1;
    failed.target = "ipad";
    resources[1]!.attempt = 2;
    resources.splice(1, 0, failed);
    evidence.progress.sessions = resources.filter(r => r.vendor === "testingbot").map(r => r.sessionId!);
    evidence.progress.journeys = {
      iphone: [{ attempt: 1, outcome: "passed" }],
      ipad: [{ attempt: 1, outcome: "journey-failed", stage: "collaboration" }, { attempt: 2, outcome: "passed" }],
      android: [{ attempt: 1, outcome: "passed" }],
    };
    evidence.result.journeys = structuredClone(evidence.progress.journeys);
    expect(cloudReleaseEvidence(evidence.result, evidence.progress).devices.ipad).toContain("BrowserStack");
  });
  test.each([
    "missing progress", "unaudited retry", "unaudited final", "unended", "missing allocation",
    "duplicate allocation", "nonpassing final", "missing journey", "third attempt", "journey mismatch",
    "wrong final vendor", "audit total", "audit vendor", "retained links", "retained media", "lingering",
  ])("retry projection refuses %s", kind => {
    const evidence = retry();
    if (kind === "missing progress") {
      expect(() => cloudReleaseEvidence(evidence.result)).toThrow();
      return;
    }
    const resources = evidence.progress.resources!;
    if (kind === "unaudited retry") resources[0]!.audited = false;
    if (kind === "unaudited final") resources[1]!.audited = false;
    if (kind === "unended") resources[1]!.ended = false;
    if (kind === "missing allocation") resources.splice(1, 1);
    if (kind === "duplicate allocation") resources.push(structuredClone(resources[1]!));
    if (kind === "nonpassing final") evidence.progress.journeys!.iphone![1]!.outcome = "failed";
    if (kind === "missing journey") delete evidence.progress.journeys!.android;
    if (kind === "third attempt") evidence.progress.journeys!.iphone!.push({ attempt: 2, outcome: "passed" });
    if (kind === "journey mismatch") evidence.result.journeys.iphone![0]!.stage = "collaboration";
    if (kind === "wrong final vendor") evidence.result.targets.ipad.vendor = "TestingBot";
    if (kind === "audit total") evidence.result.audit.records = 3;
    if (kind === "audit vendor") evidence.result.audit.testingbotRecords = 2;
    if (kind === "retained links") evidence.result.audit.recordsExposingLinks = 1;
    if (kind === "retained media") evidence.result.audit.recordsWithMedia = 1;
    if (kind === "lingering") evidence.result.audit.lingeringSignedArtifacts = 1;
    expect(() => cloudReleaseEvidence(evidence.result, evidence.progress)).toThrow();
  });
});

test("the visible historical archive preserves every replaced v0.7.4 operator fact and link", async () => {
  const changes = await fixture("v0.7.4.prose-changes.json") as { before: string }[];
  const ledger = (await readFile(join(root, "docs/RELEASE_STATUS.md"), "utf8")).replace(/\s+/gu, " ");
  for (const change of changes) if (change.before !== "") expect(ledger).toContain(change.before.replace(/\s+/gu, " "));
});

for (const [name, scenario] of Object.entries(cases)) {
  test(`${name}: real v0.7.4 parent produces every full-file golden byte hash`, () => {
    // Keep the historical golden bytes; only newly generated repository links move owners.
    const actual = Object.fromEntries(Object.entries(scenario.result).map(([path, bytes]) => [path, createHash("sha256").update(bytes.replaceAll("https://github.com/carrythroughsystems/omp-session-gateway", "https://github.com/alphastorm/omp-session-gateway")).digest("hex")]));
    expect(actual).toEqual(goldens[name]!);
    expect(generateRelease(scenario.before, scenario.options)).toEqual(scenario.result);
  });
}

test("new release generation uses the transferred repository", () => {
  expect(approved["docs/RELEASE_STATUS.md"]).toContain("https://github.com/carrythroughsystems/omp-session-gateway/releases/tag/v0.7.4-prealpha.1");
  expect(recorded["docs/RELEASE_STATUS.md"]).toContain(publication.releaseUrl);
  const oldPublication = { ...publication, runUrl: publication.runUrl.replace("carrythroughsystems", "alphastorm") };
  expect(() => generateRelease(recordBefore, { ...recordOptions, publication: oldPublication })).toThrow("release run URL");
});

test("approved and published site blocks render public copy and working evidence links", () => {
  for (const result of [approved, recorded]) {
    const llms = result["site/llms.txt"]!;
    const page = result["site/status/index.html"]!;
    expect(llms).toContain("[release ledger](https://github.com/carrythroughsystems/omp-session-gateway/blob/main/docs/RELEASE_STATUS.md)");
    expect(llms).not.toContain("](RELEASE_STATUS.md)");
    expect(llms).toContain(">= 18.1.20");
    expect(llms).toContain("Community project; not affiliated with or endorsed by the Oh My Pi maintainers.");
    expect(result["docs/COMPATIBILITY.md"]).toContain("[release ledger](RELEASE_STATUS.md)");
    expect(page).toContain('<a href="https://github.com/carrythroughsystems/omp-session-gateway/releases/tag/v0.7.4">Release v0.7.4</a>');
    expect(page).toContain('<a href="https://github.com/carrythroughsystems/omp-session-gateway/blob/main/docs/RELEASE_STATUS.md">release ledger</a>');
    expect(page).toContain('<a href="https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/37142569203">https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/37142569203</a>');
    expect(page).toContain("<tr><td>relay</td><td>1</td><td>1,800 seconds,");
    expect(page).toContain("A clean stable-channel build is compared with the qualified candidate before merging; the campaign receipt alone does not prove that comparison.");
    for (const [path, bytes] of Object.entries(result)) if (path.startsWith("site/")) expect(bytes).not.toContain("approval driver");
    expect(result["docs/RELEASE_STATUS.md"]).toContain("**Runtime equivalence gate:** the approval driver must compare a clean stable-channel build with the qualified candidate before merging.");
  }
});

test("status evidence escapes HTML before rendering links without linking anchors twice", () => {
  const data = JSON.parse(recordBefore[RELEASE_TEXT]!);
  data.qualification.lanes.find((lane: { name: string }) => lane.name === "debian").summary =
    'Run <candidate> & "receipt" (https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/123?check=1&view=2).';
  const result = generateRelease({ ...recordBefore, [RELEASE_TEXT]: JSON.stringify(data) }, recordOptions);
  expect(result["site/status/index.html"]).toContain('<td>Run &lt;candidate&gt; &amp; &quot;receipt&quot; (<a href="https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/123?check=1&amp;view=2">https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/123?check=1&amp;view=2</a>).</td>');
  expect(result["site/status/index.html"]).not.toContain('<a href="<a');
});

test("v0.7.4 package/lock/constants exactly reproduce the manual prepare commit", () => {
  for (const path of Object.keys(prepared).filter(path => path.endsWith("package.json") || path.endsWith(".ts") || path === "bun.lock")) {
    expect(prepared[path], path).toBe(originals.dcfa0b3![path]);
  }
});
test("v0.7.3 second sample reproduces every version surface byte-for-byte", () => {
  const before = { ...prepareBefore };
  const paths = Object.keys(prepared).filter(path => path.endsWith("package.json") || path.endsWith(".ts") || path === "bun.lock");
  for (const path of paths) before[path] = originals["7a5f988^"]![path]!;
  const stable = JSON.parse(before["STABLE_RELEASE.lock.json"]!);
  stable.releaseTag = "v0.7.2";
  before["STABLE_RELEASE.lock.json"] = JSON.stringify(stable);
  before["CHANGELOG.md"] = "# Changelog\n\n## [Unreleased]\n\n- Qualification tooling.\n\n## [v0.7.2] — 2026-10-01\n";
  const result = generateRelease(before, { command: "prepare", version: "0.7.3", date: "2026-10-02" });
  for (const path of paths) expect(result[path], path).toBe(originals["7a5f988"]![path]);
});
test("approve reproduces the committed stable lock, not synthetic digests or approval times", () => {
  expect(approved["STABLE_RELEASE.lock.json"]).toBe(originals["39e3d57"]!["STABLE_RELEASE.lock.json"]);
});
test("record removes exactly the completed backlog tasks, preserving other work", () => {
  expect(recorded["docs/BACKLOG.md"]!.replace(/<!-- release-generate:release-task:start -->\n\n<!-- release-generate:release-task:end -->\n/u, "")).toBe(originals["9c0d790"]!["docs/BACKLOG.md"]!);
});
test("fresh attempts preserve the existing cut and incorporate new Unreleased fixes", () => {
  const tree = { ...prepareBefore, ...prepared };
  tree["CHANGELOG.md"] = tree["CHANGELOG.md"]!.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- A subsequent fix.\n");
  const options: ReleaseGenerateOptions = { command: "prepare", version: "0.7.4", date: "2026-10-04", candidateTag: "v0.7.4-prealpha.2" };
  const result = generateRelease(tree, options);
  expect(result["CHANGELOG.md"]!.match(/## \[v0.7.4\]/gu)).toHaveLength(1);
  expect(result["CHANGELOG.md"]).toContain("- A subsequent fix.");
  expect(result["CHANGELOG.md"]).toContain("bun scripts/upstream-pins.ts");
  expect(result["docs/RELEASE_STATUS.md"]).toContain("`v0.7.4-prealpha.2`");
  const repeated = generateRelease({ ...tree, ...result }, options);
  expect(repeated).toEqual(result);
});

test("2026-10-22 prepare recounts 27 to 28 entries when only the prepared count drifted from release-text", () => {
  const before = Object.fromEntries(Object.entries(prepareBefore).map(([path, bytes]) =>
    [path, bytes.replaceAll("0.7.4", "0.7.8").replaceAll("0.7.3", "0.7.7")]));
  const bullets = Array.from({ length: 27 }, (_, index) => `- Prepared change ${index + 1}.`);
  before["CHANGELOG.md"] = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n${bullets.join("\n")}\n\n## [v0.7.7] — 2026-10-21\n\n- Previous immutable release.\n`;
  const options: ReleaseGenerateOptions = {
    command: "prepare", version: "0.7.8", date: "2026-10-22", candidateTag: "v0.7.8-prealpha.4",
  };
  const initial = generateRelease(before, options);
  const tree = { ...before, ...initial };
  const metadata = JSON.parse(tree[RELEASE_TEXT]!);
  expect(metadata.summary).toContain("27 changelog entries");
  tree["CHANGELOG.md"] = tree["CHANGELOG.md"]!
    .replace("27 changelog entries", "28 changelog entries")
    .replace("- Prepared change 27.", "- Prepared change 27.\n- Subsequent repair.");
  const nextOptions = { ...options, candidateTag: "v0.7.8-prealpha.5" };
  const result = generateRelease(tree, nextOptions);
  const next = JSON.parse(result[RELEASE_TEXT]!);
  expect(next.summary).toContain("28 changelog entries");
  expect(next.candidateTag).toBe("v0.7.8-prealpha.5");
  expect(result["CHANGELOG.md"]).toContain(next.summary);
  for (const bullet of [...bullets, "- Subsequent repair."]) expect(result["CHANGELOG.md"]).toContain(bullet);
  expect(result["CHANGELOG.md"]).toContain("- Previous immutable release.");
  expect(result["CHANGELOG.md"]!.match(/## \[v0.7.8\]/gu)).toHaveLength(1);
  expect(result["STABLE_RELEASE.lock.json"]).toBeUndefined();
  expect(result["UPSTREAM.lock.json"]).toBeUndefined();
  expect(generateRelease({ ...tree, ...result }, nextOptions)).toEqual(result);
  for (const field of ["qualification", "publication"]) {
    expect(() => generateRelease({
      ...tree, [RELEASE_TEXT]: JSON.stringify({ ...metadata, [field]: {} }),
    }, nextOptions)).toThrow("prepared changelog");
  }
  expect(() => generateRelease({
    ...tree, "CHANGELOG.md": tree["CHANGELOG.md"]!.replace("Historical receipts do not qualify", "Historical receipts qualify"),
  }, nextOptions)).toThrow("prepared changelog");
});

test("minor preparation folds the unpublished patch cut and recounts all entries together", () => {
  const tree = Object.fromEntries(Object.entries({ ...prepareBefore, ...prepared }).map(([path, bytes]) =>
    [path, bytes.replaceAll("0.7.4", "0.7.8").replaceAll("0.7.3", "0.7.7")]));
  tree["CHANGELOG.md"] = tree["CHANGELOG.md"]!.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Added\n\n- Minor fleet configuration.\n");
  const options = { command: "prepare" as const, version: "0.8.0", date: "2026-10-22", releaseClass: "minor" as const };
  const result = generateRelease(tree, options);
  expect(result["CHANGELOG.md"]).not.toContain("## [v0.7.8]");
  expect(result["CHANGELOG.md"]).toContain("## [v0.8.0]");
  expect(result["CHANGELOG.md"]).toContain("- Minor fleet configuration.");
  expect(result["CHANGELOG.md"]).toContain("bun scripts/upstream-pins.ts");
  const metadata = JSON.parse(result[RELEASE_TEXT]!);
  expect(metadata.version).toBe("0.8.0");
  expect(metadata.candidateTag).toBe("v0.8.0-prealpha.1");
  expect(result["CHANGELOG.md"]).toContain(metadata.summary);
  expect(generateRelease({ ...tree, ...result }, options)).toEqual(result);
  expect(result["STABLE_RELEASE.lock.json"]).toBeUndefined();
  expect(result["UPSTREAM.lock.json"]).toBeUndefined();
});

test("minor retarget refuses edited summaries, qualified cuts, wrong classes and version skips", () => {
  const tree = { ...prepareBefore, ...prepared };
  const options = { command: "prepare" as const, version: "0.8.0", date: "2026-10-22", releaseClass: "minor" as const };
  const metadata = JSON.parse(tree[RELEASE_TEXT]!);
  expect(() => generateRelease({ ...tree, [RELEASE_TEXT]: JSON.stringify({ ...metadata, summary: "hand-edited summary" }) }, options)).toThrow("prepared changelog");
  expect(() => generateRelease({ ...tree, [RELEASE_TEXT]: JSON.stringify({ ...metadata, qualification: {} }) }, options)).toThrow("package and published stable");
  expect(() => generateRelease(tree, { ...options, releaseClass: "patch" })).toThrow("requested release class");
  for (const version of ["0.8.1", "0.9.0", "1.0.0"]) expect(() => generateRelease(tree, { ...options, version })).toThrow("requested release class");
  expect(() => generateRelease(tree, { ...options, version: "0.7.4" })).toThrow("requested release class");
});

describe("historical predecessor receipt", () => {
  // Adapt a complete fixture without changing the original recorded receipt or golden bytes.
  const tree = Object.fromEntries(Object.entries(approveBefore).map(([path, bytes]) => [path, bytes.replaceAll("0.7.4", "0.7.6").replaceAll("0.7.3", "0.7.5")]));
  const historical = JSON.parse(JSON.stringify(receipt).replaceAll("v0.7.4", "v0.7.6").replaceAll("v0.7.3", "v0.7.5"));
  historical.predecessor.archiveSha256 = "171dec1a9902c934c99060b250f209cf627ce194d07da1412b35ad419c3ec57c";
  const proof = historical.lanes.artifacts.evidence.predecessor;
  proof.archiveSha256 = historical.predecessor.archiveSha256;
  proof.githubAttestations = "historical-cosign";
  proof.historicalSignature = {
    archiveSha256: historical.predecessor.archiveSha256,
    signerRepository: "alphastorm/omp-session-gateway",
    certificateIdentity: "https://github.com/alphastorm/omp-session-gateway/.github/workflows/signed-release.yml@refs/tags/v0.7.5",
    certificateOidcIssuer: "https://token.actions.githubusercontent.com",
  };
  const options: ReleaseGenerateOptions = { ...approveOptions, version: "v0.7.6", candidateTag: "v0.7.6-prealpha.1", receipt: historical };

  test("approval truthfully projects the pinned predecessor's Cosign-only proof", () => {
    const generated = generateRelease(tree, options);
    expect(generated["docs/RELEASE_STATUS.md"]).toContain("v0.7.5 verified by digest-pinned historical Cosign bundles 3/3 (no GitHub build attestations)");
  });

  test.each(["signerRepository", "certificateIdentity", "certificateOidcIssuer", "archiveSha256"])("approval rejects a substituted historical %s", key => {
    const invalid = structuredClone(historical);
    invalid.lanes.artifacts.evidence.predecessor.historicalSignature[key] = "substituted";
    expect(() => generateRelease(tree, { ...options, receipt: invalid })).toThrow("historical predecessor");
  });

  test("approval keeps candidate attestation checks strict", () => {
    const invalid = structuredClone(historical);
    invalid.lanes.artifacts.evidence.githubAttestations = "historical-cosign";
    expect(() => generateRelease(tree, { ...options, receipt: invalid })).toThrow("GitHub attestations");
  });

  test("approval rejects a tampered predecessor digest or missing historical identity", () => {
    const invalid = structuredClone(historical);
    invalid.predecessor.archiveSha256 = invalid.lanes.artifacts.evidence.predecessor.archiveSha256 = "0".repeat(64);
    expect(() => generateRelease(tree, { ...options, receipt: invalid })).toThrow("historical predecessor archive digest");
    const missing = structuredClone(historical);
    delete missing.lanes.artifacts.evidence.predecessor.historicalSignature;
    expect(() => generateRelease(tree, { ...options, receipt: missing })).toThrow("historical predecessor");
  });

  test("approval refuses Cosign-only evidence for a non-allowlisted predecessor", () => {
    const invalid = structuredClone(receipt) as typeof historical;
    invalid.lanes.artifacts.evidence.predecessor.githubAttestations = "historical-cosign";
    invalid.lanes.artifacts.evidence.predecessor.historicalSignature = proof.historicalSignature;
    expect(() => generateRelease(approveBefore, { ...approveOptions, receipt: invalid })).toThrow("historical predecessor");
  });
});

describe("fail closed without producing partial edits", () => {
  test("missing/duplicate markers and date", () => {
    const broken = { ...approveBefore, "docs/COMPATIBILITY.md": approveBefore["docs/COMPATIBILITY.md"]!.replace("release-generate:platforms:start", "missing") };
    expect(() => generateRelease(broken, approveOptions)).toThrow("marker");
    expect(() => generateRelease(prepareBefore, { ...prepareOptions, date: "2026-02-30" })).toThrow("date");
    expect(() => generateRelease(prepareBefore, { ...prepareOptions, date: "" })).toThrow("date");
  });
  test("missing/failed lanes, wrong digest, wrong candidate, stale cleanup and mismatched upstream", () => {
    for (const [path, value] of [
      ["lanes.windows", undefined], ["lanes.relay.status", "failed"],
      ["candidate.archiveSha256", "0".repeat(64)], ["tag", "v0.7.4-prealpha.2"],
      ["lanes.windowsCleanup.evidence.epoch", "other-attempt"],
      ["lanes.windows.evidence.result.omp.version", "18.4.12"],
    ] as const) {
      const invalid = structuredClone(receipt) as Record<string, unknown>;
      const keys = path.split(".");
      let target = invalid;
      for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
      if (value === undefined) delete target[keys.at(-1)!];
      else target[keys.at(-1)!] = value;
      expect(() => generateRelease(approveBefore, { ...approveOptions, receipt: invalid })).toThrow();
    }
  });
  test("smoke failures, status divergence and publication/source mismatches", () => {
    const invalidSmoke = structuredClone(smoke) as { android: { samePageRecovery: boolean } };
    invalidSmoke.android.samePageRecovery = false;
    expect(() => generateRelease(recordBefore, { ...recordOptions, smoke: invalidSmoke })).toThrow("samePageRecovery");
    expect(() => generateRelease(recordBefore, { ...recordOptions, status: { ...status as object, diverged: true } })).toThrow("divergence");
    expect(() => generateRelease(recordBefore, { ...recordOptions, publication: { ...publication as object, sourceCommit: "a".repeat(40) } })).toThrow("sourceCommit");
  });
  test("private identities and arbitrary strings never reach the published projection", () => {
    const privateReceipt = structuredClone(receipt) as { lanes: { macos: { evidence: Record<string, unknown> }; windows: { evidence: { result: Record<string, unknown> } } } };
    privateReceipt.lanes.macos.evidence.privatePath = "/Users/alice/secret";
    privateReceipt.lanes.windows.evidence.result.privateNote = "token-do-not-publish";
    const bytes = JSON.stringify(generateRelease(approveBefore, { ...approveOptions, receipt: privateReceipt }));
    expect(bytes).not.toContain("/Users/alice/secret");
    expect(bytes).not.toContain("token-do-not-publish");
    expect(bytes).not.toContain("tailfb479a");
  });
});

async function materialize(tree: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-release-generate-"));
  for (const [path, bytes] of Object.entries(tree)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), bytes);
  }
  return directory;
}

// The release workflow's shell runs on Linux runners; Windows bash cannot execute the extracted script.
test.skipIf(process.platform === "win32")("workflow data extraction renders exactly the old v0.7.4 stable, candidate and provenance notes", async () => {
  const old = originals.dcfa0b3![".github/workflows/signed-release.yml"]!;
  const changed = await readFile(join(root, ".github/workflows/signed-release.yml"), "utf8");
  const directory = await materialize({ [RELEASE_TEXT]: releaseText });
  try {
    const render = async (workflow: string, channel: string, tag: string) => {
      const start = workflow.indexOf('          if [[ "$GITHUB_REF_NAME" == provenance-test-* ]]; then');
      const end = workflow.indexOf("\n          fi\n", start) + "\n          fi".length;
      const script = workflow.slice(start, end).replace(/^          /gmu, "");
      const process = Bun.spawn(["bash", "-euo", "pipefail", "-c", script + '\ncat "$notes"'], {
        cwd: directory, env: { ...globalThis.process.env, notes: join(directory, "notes.md"), GITHUB_REF_NAME: tag, OMP_RELEASE_CHANNEL: channel, PACKAGE_VERSION: "0.7.4", QUALIFIED_PREVIOUS_TAG: "v0.7.3", GITHUB_SHA: "dcfa0b32503ca83e71e15d2872eff920831b14ac", GITHUB_REPOSITORY: "carrythroughsystems/omp-session-gateway", upstream_commit: "d0cc52397dc2a68d39cba49b0009b9e50ffd643e", upstream_tag: "v18.5.1" }, stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(process.stdout).text();
      expect(await process.exited, await new Response(process.stderr).text()).toBe(0);
      return output;
    };
    for (const [channel, tag] of [["stable", "v0.7.4"], ["pre-alpha", "v0.7.4-prealpha.1"], ["pre-alpha", "provenance-test-v0.7.4.1"]]) {
      expect(await render(changed, channel!, tag!)).toBe(await render(old, channel!, tag!));
    }
    for (const phrase of ["v0.7.3", "v18.5.1", "Pixel 10 Pro"]) expect(changed).not.toContain(phrase);
    expect(changed).toContain("jq -e '[.highlights");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI writes only the computed files; missing inputs exit 1 without writes", async () => {
  const directory = await materialize(prepareBefore);
  try {
    const changed = await runReleaseGenerate(["prepare", "0.7.4", "--date", "2026-10-03"], directory);
    for (const path of changed) expect(await readFile(join(directory, path), "utf8")).toBe(prepared[path]!);
    const child = Bun.spawn([process.execPath, join(root, "scripts/release-generate.ts"), "record", "v0.7.4", "--date", "2026-10-03"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("missing required --smoke");
    await expect(runReleaseGenerate(["prepare", "0.8.0", "--release-class", "major", "--date", "2026-10-22"], directory)).rejects.toThrow("release class");
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe(prepared["package.json"]!);
    await runReleaseGenerate(["prepare", "0.8.0", "--release-class", "minor", "--date", "2026-10-22"], directory);
    expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).version).toBe("0.8.0");
    expect(JSON.parse(await readFile(join(directory, RELEASE_TEXT), "utf8")).candidateTag).toBe("v0.8.0-prealpha.1");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
