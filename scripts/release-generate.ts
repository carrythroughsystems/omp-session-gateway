import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertStableReleaseQualification, releaseVersion } from "./release-policy.ts";
import { externalCleanupCurrent, validateStableQualificationReceipt } from "./stable-qualification.ts";
import { historicalPredecessor } from "./post-release-smoke.ts";
import { SAMSUNG_MODEL_CODES } from "./device-cloud-qualification.ts";

const REPO = "https://github.com/carrythroughsystems/omp-session-gateway";
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
export const RELEASE_TEXT = "scripts/release-text.json";
const PACKAGES = ["package.json", "apps/gateway/package.json", "apps/web/package.json", "packages/collab-client/package.json", "packages/protocol/package.json"];
const CONSTANTS = { "apps/gateway/src/diagnostics.ts": "PRODUCT_VERSION", "scripts/build-release.ts": "PRODUCT_VERSION", "apps/gateway/src/installation.ts": "GATEWAY_VERSION" };
const CLAIMS = ["docs/COMPATIBILITY.md", "docs/UPGRADE_ROLLBACK.md", "site/llms.txt", "site/status/index.html", "README.md"];
const CAMPAIGNS = ["docs/ANDROID.md", "docs/ATTENTION_SPEC.md", "docs/LIFECYCLE_BRANCH_RESUME.md"];
const LANES = ["artifacts", "debian", "macos", "ompPublication", "android", "androidPush", "androidPushCleanup", "deviceCloud", "deviceCloudCleanup", "relay", "cleanup", "windows", "windowsCleanup"] as const;
const EVIDENCE = ["debian", "macos", "windows", "android", "androidPush", "deviceCloud", "ompPublication", "provenance", "secretSinks"];
export type ReleaseTree = Readonly<Record<string, string>>;
type ObjectValue = Record<string, unknown>;
type Options = { version: string; date: string } & (
  | { command: "prepare"; candidateTag?: string }
  | { command: "approve"; receipt: unknown; candidateTag: string }
  | { command: "record"; smoke: unknown; status: unknown; publication: unknown }
);
export type ReleaseGenerateOptions = Options;
interface Lane { name: string; attempts: number; startedAt: string; completedAt: string; summary: string; measurements: unknown }
interface Qualification {
  lock: ObjectValue;
  baseline: string;
  commit: string;
  bun: string;
  startedAt: string;
  completedAt: string;
  orchestratorCommit: string;
  lanes: Lane[];
  matrix: Record<string, string>;
}
interface ReleaseText {
  schemaVersion: 1;
  highlights: string;
  combinations: string;
  stableRollback: string;
  changesToTest: string;
  plannedBoundary: string;
  candidateRollback: string;
  version?: string;
  candidateTag?: string;
  summary?: string;
  qualification?: Qualification;
  publication?: ObjectValue;
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as ObjectValue;
}
function text(value: unknown, label: string, pattern = /^[A-Za-z0-9][A-Za-z0-9 ._,()+:/-]*$/u): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is missing or invalid`);
  return value;
}
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} is missing or invalid`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  const result = text(value, label, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} is invalid`);
  return result;
}
function requireTrue(value: unknown, label: string): void {
  if (value !== true) throw new Error(`${label} must be true`);
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match`);
}
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function escapePattern(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function markdown(value: string): string { return value.replaceAll("|", "\\|").replaceAll("\n", " "); }
export function releaseMarker(name: string, content: string): string {
  return `<!-- release-generate:${name}:start -->\n${content.trim()}\n<!-- release-generate:${name}:end -->`;
}
function markerContent(source: string, name: string): string {
  const start = `<!-- release-generate:${name}:start -->\n`;
  const end = `\n<!-- release-generate:${name}:end -->`;
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error(`missing or duplicate release marker: ${name}`);
  const begin = source.indexOf(start) + start.length;
  const finish = source.indexOf(end);
  if (finish < begin) throw new Error(`misordered release marker: ${name}`);
  return source.slice(begin, finish);
}
function replaceMarker(source: string, name: string, content: string): string {
  const old = markerContent(source, name);
  return source.replace(releaseMarker(name, old), releaseMarker(name, content));
}
function replaceOne(source: string, pattern: RegExp, replacement: string): string {
  if ([...source.matchAll(new RegExp(pattern.source, "gu"))].length !== 1) throw new Error(`expected exactly one release anchor: ${pattern.source}`);
  return source.replace(pattern, () => replacement);
}
function readText(value: unknown): ReleaseText {
  const record = object(value, RELEASE_TEXT);
  equal(record.schemaVersion, 1, "release text schema");
  for (const key of ["highlights", "combinations", "stableRollback", "changesToTest", "plannedBoundary", "candidateRollback"]) {
    if (typeof record[key] !== "string" || record[key].trim() === "") throw new Error(`missing release text: ${key}`);
  }
  return record as unknown as ReleaseText;
}
/** Unknown string fields never flow from a private campaign receipt into a public document. */
function measurements(value: unknown): unknown {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: ObjectValue = {};
  for (const [key, child] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key) || /(?:secret|password|token|serial|credential|address|instanceId|firewallId|dropletId|nodeId)/iu.test(key)) continue;
    const safe = measurements(child);
    if (safe !== undefined && (typeof safe !== "object" || Object.keys(safe as object).length)) out[key] = safe;
  }
  return out;
}

/** Legacy homogeneous receipts retain their bytes; new receipts attribute every target explicitly. */
export function cloudReleaseEvidence(value: unknown): { summary: string; devices: Record<"iphone" | "ipad" | "android", string> } {
  const cloud = object(value, "cloud result");
  requireTrue(cloud.passed, "cloud result");
  const targets = object(cloud.targets, "cloud targets");
  const names = ["iphone", "ipad", "android"] as const;
  const attributed = names.some(name => object(targets[name], `cloud ${name}`).vendor !== undefined);
  const devices = {} as Record<typeof names[number], string>;
  let browserStackTargets = 0;
  for (const name of names) {
    const target = object(targets[name], `cloud ${name}`);
    const vendor = attributed ? target.vendor : cloud.vendor;
    const tunnel = attributed ? target.tunnelVersion : cloud.tunnelVersion;
    if (vendor !== "TestingBot" && vendor !== "BrowserStack") throw new Error("invalid per-target cloud vendor");
    if (name === "iphone" && vendor !== "TestingBot") throw new Error("BrowserStack iPhone evidence is forbidden");
    if (vendor === "BrowserStack") browserStackTargets += 1;
    const model = text(target.device, "device");
    const os = text(target.os, "OS", /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/u);
    const browser = text(target.browser, "browser", /^(?:safari|chrome)$/u);
    const version = text(target.browserVersion, "browser version", /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/u);
    if (browser !== (name === "android" ? "chrome" : "safari")) throw new Error("cloud target browser does not match");
    if (name === "android" && (!model.startsWith("Galaxy ") || typeof target.model !== "string" || !SAMSUNG_MODEL_CODES[model]?.includes(target.model))) throw new Error("cloud Android evidence must attest its exact Samsung hardware");
    if (name === "iphone" && !model.startsWith("iPhone ")) throw new Error("cloud iPhone evidence names another family");
    if (name === "ipad" && !model.startsWith("iPad ")) throw new Error("cloud iPad evidence names another family");
    for (const field of ["appAssetMatched", "viewReadOnly", "controlWritable", "promptAccepted", "returnedToDirectory"]) requireTrue(target[field], `cloud ${name} ${field}`);
    equal(target.sinkFindings, 0, `cloud ${name} sink findings`);
    equal(target.sinksDetectable, 7, `cloud ${name} detectable sinks`);
    if (name === "iphone") for (const field of ["homeScreenApp", "alertsEnabled", "tapOpenedControl", "tapUrlScrubbed", "alertsDisabled"]) requireTrue(target[field], `cloud iPhone ${field}`);
    const description = `${model} (${os}, ${browser} ${version})`;
    const tunnelVersion = text(tunnel, "per-target tunnel version", /^[0-9]+(?:\.[0-9]+){1,3}$/u);
    devices[name] = attributed ? `${vendor}, tunnel ${tunnelVersion}: ${description}` : description;
  }
  const audit = object(cloud.audit, "cloud audit");
  equal(audit.records, 3, "cloud audited records");
  equal(audit.recordsExposingLinks, 0, "cloud retained link exposure");
  equal(audit.recordsWithMedia, 0, "cloud retained media");
  if (attributed) {
    equal(cloud.vendor, browserStackTargets === 0 ? "TestingBot" : "mixed", "aggregate cloud vendor");
    equal(cloud.tunnelVersion, browserStackTargets === 0 ? object(targets.iphone, "cloud iphone").tunnelVersion : "per-target", "aggregate cloud tunnel");
    equal(audit.browserstackRecords, browserStackTargets, "BrowserStack audited records");
    equal(audit.testingbotRecords, 3 - browserStackTargets, "TestingBot audited records");
  } else equal(cloud.vendor, "TestingBot", "legacy cloud vendor");
  return {
    devices,
    summary: attributed
      ? `${devices.iphone}; ${devices.ipad}; ${devices.android}. Home Screen alerts were proven only on the TestingBot iPhone and do not qualify lock-screen presentation.`
      : `${text(cloud.vendor, "cloud vendor")} real devices, tunnel ${text(cloud.tunnelVersion, "tunnel version")}: ${devices.iphone}; ${devices.ipad}; ${devices.android}. Home Screen alerts do not qualify lock-screen presentation.`,
  };
}

function qualification(receiptValue: unknown, candidateTag: string, tag: string, previousTag: string, upstream: ObjectValue): Qualification {
  const raw = object(receiptValue, "receipt");
  const orchestrator = text(raw.orchestratorCommit, "orchestrator commit", SHA);
  const receipt = validateStableQualificationReceipt(receiptValue, candidateTag, orchestrator, previousTag);
  equal(receipt.status, "passed", "receipt status");
  const candidate = object(receipt.candidate, "candidate");
  equal(candidate.tag, candidateTag, "candidate tag");
  if (!new RegExp(`^${escapePattern(tag)}-prealpha\\.[1-9][0-9]*$`, "u").test(candidateTag)) throw new Error("candidate tag does not match release");
  const predecessor = object(receipt.predecessor, "predecessor");
  equal(predecessor.tag, previousTag, "predecessor tag");
  text(predecessor.sourceCommit, "predecessor source", SHA);
  text(predecessor.archiveSha256, "predecessor archive", DIGEST);
  const source = text(candidate.sourceCommit, "candidate source", SHA);
  const archive = text(candidate.archiveSha256, "candidate archive", DIGEST);
  const startedAt = timestamp(receipt.startedAt, "receipt start");
  const completedAt = timestamp(receipt.completedAt, "receipt completion");
  if (startedAt > completedAt) throw new Error("receipt timestamps are reversed");
  for (const name of LANES) {
    const lane = receipt.lanes[name];
    equal(lane.status, "passed", `${name} status`);
    if (lane.attempts < 1) throw new Error(`${name} has no attempt`);
    timestamp(lane.startedAt, `${name} start`);
    timestamp(lane.completedAt, `${name} completion`);
    object(lane.evidence, `${name} evidence`);
  }
  for (const name of ["androidPush", "deviceCloud", "windows"] as const) {
    if (!externalCleanupCurrent(receipt, name)) throw new Error(`${name} cleanup belongs to another attempt`);
  }
  const e = (name: typeof LANES[number]) => object(receipt.lanes[name].evidence, name);
  const artifacts = e("artifacts");
  equal(artifacts.sourceCommit, source, "artifact source");
  equal(artifacts.archiveSha256, archive, "artifact archive");
  const verifiedPrevious = object(artifacts.predecessor, "verified predecessor");
  for (const proof of [artifacts, verifiedPrevious]) {
    requireTrue(proof.signedTag, "signed tag");
    equal(proof.checksums, "passed", "checksums");
    equal(proof.sigstoreBundles, "3/3", "Sigstore bundles");
  }
  for (const key of ["tag", "sourceCommit", "archiveSha256"]) equal(verifiedPrevious[key], predecessor[key], `verified predecessor ${key}`);
  equal(artifacts.githubAttestations, "3/3", "GitHub attestations");
  const historical = verifiedPrevious.githubAttestations === "historical-cosign";
  if (historical) {
    const expected = historicalPredecessor("carrythroughsystems/omp-session-gateway", previousTag, String(predecessor.archiveSha256));
    if (expected === undefined) throw new Error("historical predecessor is not in the finite allowlist");
    const identity = object(verifiedPrevious.historicalSignature, "historical predecessor signature");
    for (const [key, value] of Object.entries(expected)) equal(identity[key], value, `historical predecessor ${key}`);
  } else {
    equal(verifiedPrevious.githubAttestations, "3/3", "GitHub attestations");
  }
  const mac = e("macos"), android = e("android");
  const windows = object(e("windows").result, "Windows result");
  const windowsOmp = object(windows.omp, "Windows OMP");
  const windowsCandidate = object(windows.candidate, "Windows candidate");
  for (const key of ["tag", "sourceCommit", "archiveSha256"]) equal(windowsCandidate[key], candidate[key], `Windows ${key}`);
  const baseline = text(upstream.tag, "upstream tag", /^v\d+\.\d+\.\d+$/u);
  const commit = text(upstream.commit, "upstream commit", SHA);
  const bun = text(upstream.bunVersion, "Bun", VERSION);
  equal(windowsOmp.version, releaseVersion(baseline), "qualified OMP version");
  equal(windowsOmp.sourceCommit, commit, "qualified OMP commit");
  equal(windows.bunVersion, bun, "qualified Bun");
  equal(mac.archiveSha256, archive, "Mac archive");
  const push = object(e("androidPush").result, "Push result");
  requireTrue(push.passed, "Push result");
  equal(push.ompVersion, releaseVersion(baseline), "Push OMP");
  const platform = object(push.platform, "Push platform");
  const cloud = object(e("deviceCloud").result, "cloud result");
  const cloudEvidence = cloudReleaseEvidence(cloud);
  const device = (name: "iphone" | "ipad" | "android") => cloudEvidence.devices[name];
  const observations = object(windows.observations, "Windows observations");
  const relay = e("relay");
  if (number(relay.durationSeconds, "relay duration") < 1_800) throw new Error("relay duration is below the qualified boundary");
  equal(relay.finalPhase, "live", "relay final phase");
  for (const key of ["gatewayProcesses", "gatewayListeners", "liveOmpHosts"]) equal(e("cleanup")[key], 0, `cleanup ${key}`);
  for (const name of ["androidPushCleanup", "deviceCloudCleanup"] as const) requireTrue(e(name).restored, `${name} restored`);
  for (const key of ["instancesRemaining", "firewallsRemaining"]) equal(e("windowsCleanup")[key], 0, `Windows cleanup ${key}`);
  requireTrue(e("windowsCleanup").tailnetDeleted, "Windows tailnet cleanup");
  requireTrue(e("windowsCleanup").vaultRemoved, "Windows vault cleanup");
  const model = text(android.model, "Android model");
  const androidOs = text(android.androidRelease, "Android OS");
  const browser = text(android.androidPackageVersion, "Android browser");
  const runId = number(e("debian").runId, "Debian run");
  equal(e("debian").conclusion, "success", "Debian run conclusion");
  const summaries: Record<typeof LANES[number], string> = {
    artifacts: historical
      ? `Signed tag, checksums, GitHub attestations 3/3 and Sigstore bundles 3/3; ${previousTag} verified by digest-pinned historical Cosign bundles 3/3 (no GitHub build attestations).`
      : `Signed tag, checksums, GitHub attestations 3/3 and Sigstore bundles 3/3; ${previousTag} verified the same way.`,
    debian: `Run ${runId} succeeded (${REPO}/actions/runs/${runId}); OS/kernel versions and migration counts are not exported.`,
    macos: `${text(mac.hardware, "Mac model")}, ${text(mac.os, "Mac OS")}; doctor ${text(mac.doctor, "doctor")}, rollback ${text(mac.rollbackInvariants, "rollback")}; native addon ${text(mac.nativeAddonSha256, "native addon", DIGEST)}.`,
    ompPublication: `Stock OMP ${baseline}; generation ${number(e("ompPublication").generation, "generation")}; publication, View/Control, new-generation/fork/resume and revocation.`,
    android: `${model}, Android ${androidOs} build ${text(android.buildId, "Android build")}, Chrome ${browser}; same-page unlock ${number(android.unlockMs, "unlock")} ms, Airplane ${number(android.airplaneRecoveredMs, "Airplane")} ms, Doze ${number(android.dozeRecoveredMs, "Doze")} ms; ${text(android.forbiddenSinkSweep, "sink sweep", /^[0-9/ a-z;]+$/u)}.`,
    androidPush: `Android ${text(platform.android, "Push Android")}, Chrome ${text(platform.browser, "Push browser")}, installed WebAPK; force-stop ${text(object(object(push.phases, "Push phases").force_stop_verified, "force stop").variant, "force stop variant")}, Doze ${text(object(object(push.phases, "Push phases").doze_verified, "Doze").variant, "Doze variant")}; outcomes are observed variants, not delivery guarantees.`,
    androidPushCleanup: "Device, browser and fixture restored.",
    deviceCloud: cloudEvidence.summary,
    deviceCloudCleanup: "Restored.",
    relay: `${number(relay.durationSeconds, "relay duration")} seconds, ${timestamp(relay.startedAt, "relay start")}–${timestamp(relay.completedAt, "relay completion")}; ${number(relay.transitions, "relay transitions")} transitions, final phase live. Eight-hour endurance is not claimed.`,
    cleanup: "Zero gateway processes, listeners and live OMP hosts.",
    windows: `Windows x86-64 build ${number(observations.windowsBuild, "Windows build")}; ${number(observations.cpus, "CPUs")} CPUs, ${number(observations.memoryMiB, "memory")} MiB; Administrator upgrade/rollback from ${previousTag} and fresh standard-account lifecycle; interactive logon, not unattended boot.`,
    windowsCleanup: "Zero instances and firewalls; tailnet node deleted and access vault removed.",
  };
  const lock = {
    $schema: "./schemas/stable-release.schema.json", schemaVersion: 1, version: releaseVersion(tag), releaseTag: tag, previousTag,
    status: "qualified", candidateTag, candidateSourceCommit: source, candidateArchiveSha256: archive,
    runtimeByteComparison: "passed", evidence: Object.fromEntries(EVIDENCE.map(key => [key, "passed"])), approvedAt: completedAt,
  };
  // This is the promotion lock, not proof of a build run: the driver MUST compare runtime bytes
  // after generating it, before offering the approve PR for merge (same as the manual procedure).
  assertStableReleaseQualification(lock, tag, releaseVersion(tag));
  return {
    lock, baseline, commit, bun, startedAt, completedAt, orchestratorCommit: orchestrator,
    lanes: LANES.map(name => ({ name, attempts: receipt.lanes[name].attempts, startedAt: receipt.lanes[name].startedAt!, completedAt: receipt.lanes[name].completedAt!, summary: summaries[name], measurements: measurements(e(name).result ?? e(name)) })),
    matrix: {
      "Linux host": summaries.debian, "macOS host": summaries.macos, "Windows host": summaries.windows,
      "Chrome and Chromium": `${model}, Android ${androidOs}, Chrome ${browser}; ${device("android")}`,
      "Edge and other Chromium-based browsers": "None", Firefox: "None",
      "Safari and WebKit": `${device("iphone")}; ${device("ipad")}`, Android: `${model}, Android ${androidOs}, Chrome ${browser}; ${device("android")}`,
      "iPhone and iPad": `${device("iphone")}; ${device("ipad")}`,
    },
  };
}

function phase(q: Qualification, published: boolean): string {
  const tag = String(q.lock.releaseTag);
  return published ? `Stable ${tag} is published as immutable GitHub Latest.` : `${tag} is qualified for stable promotion; publication is pending.`;
}
function claim(q: Qualification, published: boolean): string {
  return `${phase(q, published)} [Release ${q.lock.releaseTag}](${REPO}/releases/tag/${q.lock.releaseTag}). Signed candidate ${q.lock.candidateTag}; source ${q.lock.candidateSourceCommit}; archive SHA-256 ${q.lock.candidateArchiveSha256}. Published ${q.lock.previousTag} remains the predecessor. Stock OMP ${q.baseline} (${q.commit}), Bun ${q.bun}. All thirteen lanes passed; attempt counts and measured evidence are in the [release ledger](RELEASE_STATUS.md). ${published ? "The separate published-byte smoke passed; it does not expand the candidate matrix." : "Stable publication and published-byte smoke are pending."}`;
}
function laneTable(q: Qualification): string {
  return `| Lane | Attempts | Evidence |\n|---|---|---|\n${q.lanes.map(lane => `| ${lane.name} | ${lane.attempts} | ${markdown(lane.summary)} |`).join("\n")}`;
}
function ledger(q: Qualification, date: string, summary: string): string {
  return `## Mainline ${q.lock.releaseTag} — qualified; stable publication pending\n\n${releaseMarker("publication", `**Updated:** ${date}. ${phase(q, false)} Published ${q.lock.previousTag} remains GitHub Latest.`)}\n\n**Candidate:** [${q.lock.candidateTag}](${REPO}/releases/tag/${q.lock.candidateTag}).<br>\n**Source:** \`${q.lock.candidateSourceCommit}\`.<br>\n**Archive SHA-256:** \`${q.lock.candidateArchiveSha256}\`.<br>\n**Predecessor:** published \`${q.lock.previousTag}\`.\n\n${summary}\n\n### Candidate evidence\n\nSchema 3 campaign ${q.startedAt}–${q.completedAt}; orchestrator \`${q.orchestratorCommit}\`.\n\n${laneTable(q)}\n\n<details>\n<summary>Public measured results (booleans and numbers; private identities omitted)</summary>\n\n\`\`\`json\n${json(Object.fromEntries(q.lanes.map(lane => [lane.name, { startedAt: lane.startedAt, completedAt: lane.completedAt, measurements: lane.measurements }]))).trim()}\n\`\`\`\n\n</details>\n\n**Runtime equivalence gate:** the approval driver must compare a clean stable-channel build with the qualified candidate before merging. The receipt does not prove that later build comparison. Only release-info.json, SBOM.spdx.json, STABLE_RELEASE.lock.json and schemas/stable-release.schema.json may differ.\n\n${releaseMarker("smoke", "Published-byte smoke is pending stable publication.")}`;
}
function campaign(tag: string, previous: string, published: boolean): string {
  return published
    ? `The ${tag} campaign qualified these scenarios only for its recorded candidate and devices. Each later candidate must pass them again on its exact signed bytes; historical evidence does not transfer. See the [release ledger](RELEASE_STATUS.md).`
    : `The ${previous} qualification stays bound to its recorded candidate and devices. The ${tag} campaign must pass these scenarios again on its exact signed bytes before its matrix is qualified. See the [release ledger](RELEASE_STATUS.md).`;
}

/** Computes every edit before the caller writes anything. No clock, Git, network or host effects. */
export function generateRelease(tree: ReleaseTree, options: ReleaseGenerateOptions): Record<string, string> {
  const get = (path: string) => { const value = tree[path]; if (value === undefined) throw new Error(`missing input: ${path}`); return value; };
  const out: Record<string, string> = {};
  const change = (path: string, name: string, value: string) => { out[path] = replaceMarker(out[path] ?? get(path), name, value); };
  if (!/^\d{4}-\d\d-\d\d$/u.test(options.date) || new Date(`${options.date}T00:00:00Z`).toISOString().slice(0, 10) !== options.date) throw new Error("--date must be an explicit calendar date YYYY-MM-DD");
  const version = options.command === "prepare" ? options.version : releaseVersion(options.version);
  if (!VERSION.test(version) || (options.command !== "prepare" && options.version !== `v${version}`)) throw new Error("prepare takes X.Y.Z; approve/record take vX.Y.Z");
  const tag = `v${version}`;
  const upstream = object(JSON.parse(get("UPSTREAM.lock.json")), "upstream lock");
  const stable = object(JSON.parse(get("STABLE_RELEASE.lock.json")), "stable lock");
  const data = readText(JSON.parse(get(RELEASE_TEXT)));
  const packageVersion = object(JSON.parse(get("package.json")), "package").version;
  const baseline = text(upstream.tag, "baseline", /^v\d+\.\d+\.\d+$/u);
  if (options.command === "prepare") {
    const alreadyPrepared = packageVersion === version;
    const candidateTag = options.candidateTag ?? `${tag}-prealpha.1`;
    if (!new RegExp(`^${escapePattern(tag)}-prealpha\\.[1-9][0-9]*$`, "u").test(candidateTag)) throw new Error("candidate tag does not match prepared version");
    const previous = text(stable.releaseTag, "published stable", /^v\d+\.\d+\.\d+$/u);
    if (!alreadyPrepared && packageVersion !== releaseVersion(previous)) throw new Error("package and published stable versions disagree");
    const oldParts = releaseVersion(previous).split(".").map(Number), parts = version.split(".").map(Number);
    const firstDifference = parts.findIndex((part, i) => part !== oldParts[i]);
    if (firstDifference < 0 || parts[firstDifference]! < oldParts[firstDifference]!) throw new Error("prepared version must advance published stable");
    for (const path of PACKAGES) {
      equal(object(JSON.parse(get(path)), path).version, packageVersion, `${path} version`);
      out[path] = replaceOne(get(path), /"version": "[^"]+"/u, `"version": "${version}"`);
    }
    for (const [path, symbol] of Object.entries(CONSTANTS)) out[path] = replaceOne(get(path), new RegExp(`export const ${symbol} = "${escapePattern(String(packageVersion))}";`, "u"), `export const ${symbol} = "${version}";`);
    let lockfile = get("bun.lock");
    for (const path of PACKAGES.slice(1)) {
      const workspace = path.replace("/package.json", "");
      const pattern = new RegExp(`("${escapePattern(workspace)}": \\{\\n      "name": "[^"]+",\\n      "version": ")${escapePattern(String(packageVersion))}("),`, "u");
      const match = lockfile.match(pattern);
      if (!match) throw new Error(`missing workspace version: ${workspace}`);
      lockfile = replaceOne(lockfile, pattern, `${match[1]}${version}${match[2]},`);
    }
    out["bun.lock"] = lockfile;
    const changelog = get("CHANGELOG.md");
    let pending = changelog.match(/\n## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/u)?.[1];
    if (pending === undefined) throw new Error("missing unreleased cut");
    let changelogBase = changelog;
    if (alreadyPrepared) {
      equal(data.version, version, "prepared release text");
      if (!data.summary) throw new Error("prepared release has no summary");
      const section = new RegExp(`\\n## \\[${escapePattern(tag)}\\] — [^\\n]+\\n\\n([\\s\\S]*?)(?=\\n## \\[|$)`, "u");
      const old = changelog.match(section);
      if (!old || !old[1]!.startsWith(data.summary)) throw new Error("prepared changelog section is missing or edited");
      pending = [pending.trim(), old[1]!.slice(data.summary.length).trim()].filter(Boolean).join("\n\n");
      changelogBase = changelog.replace(section, "");
    } else if (changelog.includes(`## [${tag}]`)) throw new Error("duplicate release cut");
    const bullets = pending.match(/^- .*(?:\n {2}.*)*/gmu) ?? [];
    const summary = `This release uses stock OMP ${baseline} as its engineering baseline. ${bullets.length ? `The ${bullets.length} changelog ${bullets.length === 1 ? "entry below records" : "entries below record"} the changes since ${previous}.` : `It renews signed-artifact qualification since ${previous}; no changelog changes were recorded.`} Historical receipts do not qualify these bytes.`;
    out["CHANGELOG.md"] = replaceOne(changelogBase, /\n## \[Unreleased\]\n[\s\S]*?(?=\n## \[|$)/u, `\n## [Unreleased]\n\n## [${tag}] — ${options.date}\n\n${summary}\n${pending.trim() ? `\n${pending.trim()}\n` : ""}`);
    const highlights = bullets.length ? bullets.map(b => b.replace(/\n\s+/gu, " ")).join("\n") : "- Renew signed-artifact qualification; no changelog changes were recorded.";
    const next: ReleaseText = {
      schemaVersion: 1, version, candidateTag, summary,
      highlights: `- ${summary}\n${highlights}`,
      combinations: data.combinations,
      stableRollback: `The selected predecessor is ${previous}. Gateway rollback does not switch or restart the separately running OMP process. This release uses stock OMP ${baseline}. rollback --to selects only retained runtimes. Preserve configuration and readiness-token state; see docs/UPGRADE_ROLLBACK.md for predecessor compatibility and stopped-service recovery.`,
      changesToTest: `${highlights}\n- Qualify stock OMP ${baseline} on every host lane. Requalify all thirteen lanes, including session-lifecycle and Push-triage scenarios, on these exact signed bytes; historical receipts and canaries do not transfer.`,
      plannedBoundary: data.plannedBoundary,
      candidateRollback: `The selected predecessor is ${previous}; pruning keeps it installed as the recorded rollback target. Gateway rollback does not switch or restart OMP. Historical fork-era recovery is documented separately in docs/UPGRADE_ROLLBACK.md.`,
    };
    out[RELEASE_TEXT] = json(next);
    const oldLedger = markerContent(get("docs/RELEASE_STATUS.md"), "current");
    // Move the previous generated release into immutable history without leaving duplicate markers.
    const historical = oldLedger.replace(/^<!-- release-generate:[^\n]+ -->\n?/gmu, "");
    const prep = `## ${tag} preparation — not yet qualified or published\n\n**Prepared:** ${options.date}. ${summary}\n\n${next.plannedBoundary}\n\nPublished ${previous} remains the predecessor and current stable. The planned candidate tag is \`${candidateTag}\`; no qualification or publication is claimed. The stable lock stays unchanged until approval.`;
    out["docs/RELEASE_STATUS.md"] = get("docs/RELEASE_STATUS.md").replace(releaseMarker("current", oldLedger), `${releaseMarker("current", prep)}${!alreadyPrepared && historical.trim() ? `\n\n${historical.trim()}` : ""}`);
    for (const path of CAMPAIGNS) change(path, "campaign", campaign(tag, previous, false));
    change("docs/BACKLOG.md", "release-task", `- Qualify and publish ${tag} with stock OMP ${baseline}; published ${previous} stays current stable.\n- Requalify attention and lifecycle scenarios on the exact signed candidate; historical evidence does not transfer.`);
    return out;
  }
  equal(packageVersion, version, "prepared package");
  equal(data.version, version, "release text version");
  if (options.command === "approve") {
    const previous = text(stable.releaseTag, "published stable", /^v\d+\.\d+\.\d+$/u);
    if (previous === tag) throw new Error("release is already approved; use the persisted approval commit");
    const q = qualification(options.receipt, options.candidateTag, tag, previous, upstream);
    if (!data.summary) throw new Error("release text has no preparation summary");
    data.qualification = q;
    out["STABLE_RELEASE.lock.json"] = json(q.lock);
    change("docs/RELEASE_STATUS.md", "current", ledger(q, options.date, data.summary));
    const rollback = markerContent(get("docs/UPGRADE_ROLLBACK.md"), "predecessor");
    const current = `## ${tag} predecessor compatibility\n\nThe selected predecessor is published ${previous}. Gateway rollback does not change the separately running OMP process. This release uses stock OMP ${q.baseline}; retained-runtime selection does not restore the predecessor's OMP baseline. After a ${tag} install, \`rollback --to\` selects only runtimes pruning retained. ${q.lanes.find(l => l.name === "macos")!.summary} Windows history-selected restoration passed. Preserve configuration and readiness state. Earlier predecessors retain the compatibility limits below; their receipts do not qualify this candidate.`;
    out["docs/UPGRADE_ROLLBACK.md"] = get("docs/UPGRADE_ROLLBACK.md").replace(releaseMarker("predecessor", rollback), `${releaseMarker("predecessor", current)}\n\n${rollback}`);
    // The README table must fit a phone: show the abbreviated commit and link the exact one.
    const upstreamRepository = text(upstream.repository, "upstream repository", /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    out["README.md"] = replaceOne(get("README.md"), /\| Exact qualified OMP \|[^\n]+/u, `| Exact qualified OMP | \`${q.baseline}\` ([\`${q.commit.slice(0, 10)}\`](${upstreamRepository}/commit/${q.commit})); Bun \`${q.bun}\` |`);
    let matrix = markerContent(get("docs/COMPATIBILITY.md"), "platforms");
    for (const [surface, detail] of Object.entries(q.matrix)) {
      const pattern = new RegExp(`^\\| ${escapePattern(surface)} \\|([^\\n]+)\\|$`, "mu");
      const row = matrix.match(pattern)?.[0];
      if (!row) throw new Error(`missing platform row: ${surface}`);
      const cells = row.split("|"); cells[cells.length - 2] = ` ${markdown(detail)} `;
      matrix = matrix.replace(row, cells.join("|"));
    }
    change("docs/COMPATIBILITY.md", "platforms", matrix);
    change("docs/COMPATIBILITY.md", "qualification", `| Surface | Current contract | Qualification |\n|---|---|---|\n| Exact qualified source | ${q.baseline}, ${q.commit}; Bun ${q.bun} | Stock OMP; mainline >=18.1.20 required |\n${q.lanes.map(l => `| ${l.name} | Signed candidate ${q.lock.candidateTag} | ${markdown(l.summary)} |`).join("\n")}`);
    data.combinations = `| role | combination |\n|---|---|\n${Object.entries(q.matrix).filter(([, detail]) => detail !== "None").map(([surface, detail]) => `| ${surface} | ${markdown(detail)} |`).join("\n")}`;
  } else {
    if (!data.qualification) throw new Error("release text has no approved qualification");
    const q = data.qualification;
    assertStableReleaseQualification(stable, tag, version);
    equal(JSON.stringify(stable), JSON.stringify(q.lock), "approved lock");
    const publication = object(options.publication, "publication"), smoke = object(options.smoke, "smoke"), status = object(options.status, "status");
    equal(publication.tag, tag, "published tag"); equal(smoke.tag, tag, "smoke tag");
    for (const [key, pattern] of [["sourceCommit", SHA], ["archiveSha256", DIGEST]] as const) {
      text(publication[key], `published ${key}`, pattern); equal(smoke[key], publication[key], `smoke ${key}`);
    }
    equal(publication.releaseUrl, `${REPO}/releases/tag/${tag}`, "published release URL");
    text(publication.runUrl, "release run URL", /^https:\/\/github\.com\/carrythroughsystems\/omp-session-gateway\/actions\/runs\/[0-9]+$/u);
    timestamp(publication.publishedAt, "publication timestamp");
    for (const [section, keys] of Object.entries({ gateway: ["installed", "configPreserved", "readinessTokenPreserved"], tailscaleServe: ["unrelatedMappingsPreserved"], android: ["viewReadOnly", "controlWritable", "capabilitySinksClean", "samePageRecovery", "installedWebApk"], leaveInstalled: ["gateway", "mainlineOmp", "webApk"] })) {
      const value = object(smoke[section], `smoke ${section}`);
      for (const key of keys) requireTrue(value[key], `${section}.${key}`);
    }
    number(object(smoke.gateway, "gateway").doctorChecks, "doctor checks");
    const omp = object(smoke.omp, "smoke OMP"); equal(omp.version, releaseVersion(q.baseline), "smoke OMP version");
    text(omp.binarySha256, "smoke OMP binary", DIGEST);
    text(smoke.appAsset, "smoke app asset", /^\/assets\/app\.[a-z0-9]+\.js$/u);
    equal(status.service, "omp-session-gateway", "status service");
    for (const key of ["installed", "active", "ready"]) requireTrue(status[key], `status ${key}`);
    equal(status.diverged, false, "status divergence");
    const active = text(status.activeVersion, "active runtime", new RegExp(`^${escapePattern(version)}-[0-9a-f]{12}$`, "u"));
    equal(status.serviceVersion, active, "service runtime");
    data.publication = Object.fromEntries(["tag", "sourceCommit", "archiveSha256", "runUrl", "releaseUrl", "publishedAt"].map(key => [key, publication[key]]));
    change("docs/RELEASE_STATUS.md", "publication", `**Updated:** ${options.date}. [${tag}](${publication.releaseUrl}) was published at **${publication.publishedAt}** and is GitHub Latest. [Signed release workflow](${publication.runUrl}).\n\n**Stable source:** \`${publication.sourceCommit}\`.<br>\n**Stable archive SHA-256:** \`${publication.archiveSha256}\`.`);
    change("docs/RELEASE_STATUS.md", "smoke", `### Published-byte Studio/Pixel verification\n\nRecorded ${options.date}. Published-byte smoke passed against the stable source and digest above. Stock OMP ${omp.version}, binary SHA-256 \`${omp.binarySha256}\`; app asset \`${smoke.appAsset}\`.\n\n\`\`\`json\n${json({ gateway: measurements(smoke.gateway), tailscaleServe: measurements(smoke.tailscaleServe), android: measurements(smoke.android), leaveInstalled: measurements(smoke.leaveInstalled), status: { installed: true, active: true, ready: true, diverged: false, activeVersion: active, serviceVersion: active } }).trim()}\n\`\`\`\n\nThis smoke does not expand the candidate matrix or qualify bare-metal Mac, Windows, cloud browsers or background Push beyond their candidate lanes.`);
    out["docs/RELEASE_STATUS.md"] = replaceOne(out["docs/RELEASE_STATUS.md"]!, new RegExp(`## Mainline ${escapePattern(tag)} — qualified; stable publication pending`, "u"), `## Mainline ${tag} — published stable`);
    for (const path of CAMPAIGNS) change(path, "campaign", campaign(tag, String(q.lock.previousTag), true));
    change("docs/BACKLOG.md", "release-task", "");
  }
  const q = data.qualification!;
  const published = options.command === "record";
  change("docs/COMPATIBILITY.md", "release", claim(q, published));
  change("site/llms.txt", "summary", `# OMP Session Gateway\n\n> Native integration with stock Oh My Pi (OMP) >=18.1.20. No OMP fork, custom build, gateway-specific OMP plugin or publisher credential. ${phase(q, published)} The separate gateway discovers collaboration-enabled sessions and opens OMP's encrypted View/Control client. Setup requires collab.autoStart, Bun ${q.bun}, gateway installation and TUN-mode Tailscale Serve with Funnel disabled. Community project; not affiliated with or endorsed by OMP.`);
  change("site/llms.txt", "boundary", `${claim(q, published)}\n\n${q.lanes.map(l => `- ${l.name} (${l.attempts} attempt${l.attempts === 1 ? "" : "s"}): ${l.summary}`).join("\n")}\n\nThe Mac guest does not qualify physical firmware, FileVault, Secure Boot or startup before login. Cloud devices qualify the browser, not phone-owned Tailscale identity; iPhone Home Screen alerts do not qualify lock-screen presentation. Gateway rollback does not switch OMP. Other hosts and browser builds remain outside this exact matrix. Portal Tunnel and self-hosted/proxied relays are unsupported.`);
  const description = `${phase(q, published)} Stock OMP ${q.baseline}; exact candidate host/client evidence in the release ledger.`;
  change("site/status/index.html", "description", `<meta name="description" content="${html(description)}">`);
  change("site/status/index.html", "og-description", `<meta property="og:description" content="${html(description)}">`);
  change("site/status/index.html", "status", `<h1>${published ? "Stable" : "Qualified"} ${tag}</h1>\n<p class="lede">${html(claim(q, published).replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1"))}</p>\n<table>\n<tr><th>Lane</th><th>Attempts</th><th>Exact evidence</th></tr>\n${q.lanes.map(l => `<tr><td>${l.name}</td><td>${l.attempts}</td><td>${html(l.summary)}</td></tr>`).join("\n")}\n</table>`);
  change("site/status/index.html", "verified", `<p class="verified">${html(`${q.lock.candidateTag}: ${q.startedAt}–${q.completedAt}. All thirteen lanes passed. ${published ? "Publication and separate published-byte smoke passed." : "Publication and published-byte smoke are pending."} The approval driver must pass runtime comparison before merging; the campaign receipt alone does not prove that later comparison.`)}</p>`);
  out[RELEASE_TEXT] = json(data);
  return out;
}

export function releaseInputPaths(command: Options["command"]): string[] {
  const common = ["package.json", "UPSTREAM.lock.json", "STABLE_RELEASE.lock.json", RELEASE_TEXT, "docs/RELEASE_STATUS.md"];
  if (command === "prepare") return [...new Set([...common, ...PACKAGES, ...Object.keys(CONSTANTS), "bun.lock", "CHANGELOG.md", ...CAMPAIGNS, "docs/BACKLOG.md"])];
  return [...common, ...CLAIMS, ...(command === "record" ? [...CAMPAIGNS, "docs/BACKLOG.md"] : [])];
}

/** CLI errors (including usage/markers/receipt identity) exit 1; success exits 0. */
export async function runReleaseGenerate(argv: readonly string[], root = process.cwd()): Promise<string[]> {
  const [command, version, ...rest] = argv;
  if (command !== "prepare" && command !== "approve" && command !== "record") throw new Error("usage: release-generate.ts prepare|approve|record VERSION --date YYYY-MM-DD [inputs]");
  const allowed = command === "prepare" ? ["--date", "--candidate-tag"] : command === "approve" ? ["--date", "--receipt", "--candidate-tag"] : ["--date", "--smoke", "--status", "--publication"];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!, value = rest[i + 1];
    if (!allowed.includes(flag) || flags[flag] !== undefined || !value || value.startsWith("--")) throw new Error(`invalid or duplicate argument: ${flag}`);
    flags[flag] = value;
  }
  for (const flag of allowed) if (!(command === "prepare" && flag === "--candidate-tag") && !flags[flag]) throw new Error(`missing required ${flag}`);
  if (!version) throw new Error("missing release version");
  const input = async (flag: string) => JSON.parse(await readFile(resolve(root, flags[flag]!), "utf8")) as unknown;
  const base = { version, date: flags["--date"]! };
  const options: Options = command === "prepare" ? { ...base, command, ...(flags["--candidate-tag"] ? { candidateTag: flags["--candidate-tag"] } : {}) } : command === "approve"
    ? { ...base, command, receipt: await input("--receipt"), candidateTag: flags["--candidate-tag"]! }
    : { ...base, command, smoke: await input("--smoke"), status: await input("--status"), publication: await input("--publication") };
  const tree = Object.fromEntries(await Promise.all(releaseInputPaths(command).map(async path => [path, await readFile(resolve(root, path), "utf8")])));
  const edits = generateRelease(tree, options);
  const paths = Object.keys(edits).filter(path => edits[path] !== tree[path]).sort();
  for (const path of paths) await writeFile(resolve(root, path), edits[path]!);
  return paths;
}
if (import.meta.main) {
  try { console.log(json({ changed: await runReleaseGenerate(process.argv.slice(2)) }).trim()); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
