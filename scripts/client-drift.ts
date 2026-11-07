import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readProvider } from "./provider-read.ts";
import { readPublicSource, resolveUpstreamCommit, type PinReader } from "./upstream-pins.ts";

const UPSTREAM = "https://api.github.com/repos/can1357/oh-my-pi";
const REPOSITORY = "https://github.com/can1357/oh-my-pi";
const LATEST = "https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/latest";
const SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
export const CLIENT_DRIFT_LABEL = "client-drift";
// This repository's issues are public. Anonymous issue reads need no issues permission in inspection.
const readDriftSource: PinReader = url => url.startsWith(`${UPSTREAM}/`)
  ? readPublicSource(url) : readProvider(signal => fetch(url, { signal }));

interface Helper {
  readonly sourcePath: string;
  readonly vendoredPath: string;
  readonly commit: string;
  readonly blob: string;
}
interface Provenance {
  readonly tag: string;
  readonly commit: string;
  readonly sourcePath: string;
  readonly additionalSources: readonly Helper[];
  readonly excludedEntrypoints: readonly string[];
  readonly patches: readonly { readonly id: string; readonly files: readonly string[] }[];
}
export interface BlobChange {
  readonly path: string;
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
}
export interface ClientDriftSourceReport {
  readonly schemaVersion: 1;
  readonly release: { readonly tag: string; readonly commit: string; readonly tree: string };
  readonly embedded: { readonly tag: string; readonly commit: string };
  readonly hostPin: { readonly tag: string; readonly commit: string; readonly version: string };
  readonly changes: readonly BlobChange[];
  readonly changedHelpers: readonly (Helper & { readonly oldBlob: string; readonly newBlob: string | null })[];
  readonly patchOverlaps: readonly { readonly id: string; readonly files: readonly string[] }[];
  readonly refreshScope: readonly string[];
}
export type ClientDriftIssueAction = { readonly kind: "none" } | {
  readonly kind: "create" | "update";
  readonly title: string;
  readonly label: typeof CLIENT_DRIFT_LABEL;
  readonly body: string;
  readonly releaseCommit: string;
  readonly marker: string;
  readonly issueNumber: number | null;
};
export interface ClientDriftReport extends ClientDriftSourceReport {
  readonly issueAction: ClientDriftIssueAction;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`invalid ${label}`);
  return value;
}
function path(value: unknown): string {
  // Paths are data, including when rendered in Markdown or passed across the writer boundary.
  return text(value, /^[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)*$/u, "source path").split("/").map(part => {
    if (part === "." || part === "..") throw new Error("invalid source path component");
    return part;
  }).join("/");
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function tag(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("v") || !VERSION.test(value.slice(1))) throw new Error("invalid release tag");
  return value;
}
function provenance(value: unknown): Provenance {
  const source = record(value, "embedded provenance");
  if (source.schemaVersion !== 1 || source.repository !== REPOSITORY || source.sourcePath !== "packages/collab-web") {
    throw new Error("unexpected embedded provenance schema, repository or sourcePath");
  }
  const helpers = array(source.additionalSources, "additionalSources").map(value => {
    const helper = record(value, "helper provenance");
    return { sourcePath: path(helper.sourcePath), vendoredPath: path(helper.vendoredPath),
      commit: text(helper.commit, SHA, "helper commit"), blob: text(helper.blob, SHA, "helper blob") };
  });
  if (new Set(helpers.map(helper => helper.sourcePath)).size !== helpers.length
    || new Set(helpers.map(helper => helper.vendoredPath)).size !== helpers.length
    || helpers.some(helper => helper.sourcePath.startsWith(`${source.sourcePath}/`))) {
    throw new Error("duplicate or overlapping helper provenance");
  }
  const excluded = array(source.excludedEntrypoints, "excludedEntrypoints").map(value => {
    const entry = record(value, "excluded entrypoint");
    if (typeof entry.reason !== "string" || entry.reason.length === 0 || typeof entry.vendored !== "boolean") {
      throw new Error("excluded entrypoint must document its reason and vendored state");
    }
    return path(entry.sourcePath);
  });
  const patches = array(record(source.localPatches, "localPatches").active, "active patches").map(value => {
    const patch = record(value, "active patch");
    return { id: text(patch.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "patch id"), files: array(patch.files, "patch files").map(path) };
  });
  if (new Set(patches.map(patch => patch.id)).size !== patches.length) throw new Error("duplicate active patch id");
  return { tag: tag(source.tag), commit: text(source.commit, SHA, "embedded commit"), sourcePath: source.sourcePath,
    additionalSources: helpers, excludedEntrypoints: excluded, patches };
}
async function json(read: PinReader, url: string): Promise<unknown> {
  const response = await read(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

interface TreeEntry { readonly path: string; readonly sha: string; readonly type: "blob" | "tree" | "commit" }
/** Walk only relevant subtrees, never a possibly truncated repository-wide compare result. */
function sourceTrees(read: PinReader) {
  const cached = new Map<string, Promise<readonly TreeEntry[]>>();
  const roots = new Map<string, Promise<string>>();
  function root(commit: string): Promise<string> {
    let pending = roots.get(commit);
    if (pending === undefined) {
      pending = resolveUpstreamCommit(commit, read).then(resolved => resolved.tree);
      roots.set(commit, pending);
    }
    return pending;
  }
  function tree(sha: string, recursive = false): Promise<readonly TreeEntry[]> {
    const url = `${UPSTREAM}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`;
    let pending = cached.get(url);
    if (pending === undefined) {
      pending = json(read, url).then(value => {
        const result = record(value, "GitHub tree");
        if (result.sha !== sha || result.truncated !== false) throw new Error("truncated or mismatched GitHub tree");
        const entries = array(result.tree, "GitHub tree entries").map(value => {
          const entry = record(value, "GitHub tree entry");
          const name = path(entry.path);
          if ((!recursive && name.includes("/"))
            || !(entry.type === "tree" && entry.mode === "040000"
              || entry.type === "blob" && ["100644", "100755", "120000"].includes(String(entry.mode))
              || entry.type === "commit" && entry.mode === "160000")) throw new Error("unexpected GitHub tree entry shape");
          return { path: name, sha: text(entry.sha, SHA, "tree entry SHA"), type: entry.type as TreeEntry["type"] };
        });
        const byPath = new Map(entries.map(entry => [entry.path, entry]));
        if (byPath.size !== entries.length) throw new Error("duplicate GitHub tree path");
        if (recursive && entries.some(entry => entry.path.includes("/")
          && byPath.get(entry.path.slice(0, entry.path.lastIndexOf("/")))?.type !== "tree")) {
          throw new Error("incomplete GitHub tree hierarchy");
        }
        return entries;
      });
      cached.set(url, pending);
    }
    return pending;
  }
  async function entry(commit: string, sourcePath: string): Promise<TreeEntry | undefined> {
    let sha = await root(commit);
    const parts = sourcePath.split("/");
    for (let index = 0; index < parts.length; index++) {
      const found = (await tree(sha)).find(entry => entry.path === parts[index]);
      if (found === undefined) return undefined;
      if (index === parts.length - 1) return found;
      if (found.type !== "tree") throw new Error("non-tree source path ancestor");
      sha = found.sha;
    }
    throw new Error("empty source path");
  }
  return { entry, async packageBlobs(commit: string, sourcePath: string, required: boolean): Promise<Map<string, string>> {
    const found = await entry(commit, sourcePath);
    if (found === undefined && !required) return new Map();
    if (found?.type !== "tree") throw new Error("embedded sourcePath must identify a tree");
    const blobs = new Map<string, string>();
    for (const item of await tree(found.sha, true)) {
      if (item.type === "commit") throw new Error("relevant source tree contains a submodule, not blob sources");
      if (item.type === "blob") blobs.set(`${sourcePath}/${item.path}`, item.sha);
    }
    if (required && blobs.size === 0) throw new Error("empty embedded source tree");
    return blobs;
  } };
}

/** Pure issue decision: only dedicated, open implementation issues can be updated. */
export function decideClientDriftIssue(report: ClientDriftSourceReport, existing: readonly unknown[]): ClientDriftIssueAction {
  if (report.changes.length === 0) return { kind: "none" };
  const title = `Embedded client drift: ${report.embedded.tag} → ${report.release.tag}`;
  const marker = `<!-- embedded-client-drift:${report.release.commit} -->`;
  const matches = existing.map(value => record(value, "GitHub issue")).filter(issue => {
    if (!Number.isSafeInteger(issue.number) || Number(issue.number) <= 0 || typeof issue.title !== "string"
      || (issue.body !== null && typeof issue.body !== "string") || !["open", "closed"].includes(String(issue.state))
      || !Array.isArray(issue.labels)) throw new Error("unexpected GitHub issue shape");
    const labels = issue.labels.map(value => typeof value === "string" ? value : record(value, "issue label").name);
    if (labels.some(label => typeof label !== "string")) throw new Error("unexpected GitHub issue label");
    return issue.state === "open" && issue.pull_request === undefined && labels.includes(CLIENT_DRIFT_LABEL)
      && !labels.includes("release-request") && !labels.includes("release-minor")
      && /^Embedded client drift: v[0-9]+\.[0-9]+\.[0-9]+ → v[0-9]+\.[0-9]+\.[0-9]+$/u.test(issue.title)
      && (issue.title === title || (typeof issue.body === "string" && issue.body.includes(marker)));
  }).sort((a, b) => Number(a.number) - Number(b.number));
  const body = [
    marker,
    "Embedded browser-client implementation drift only; this is not a release request or release authority.",
    "Do not request, prepare, qualify or ship a release from this issue. No release or candidate state was changed.",
    "",
    `- Embedded source: ${report.embedded.tag} (${report.embedded.commit}).`,
    `- Observed npm latest release: ${report.release.tag} (${report.release.commit}).`,
    `- Independent engineering host pin: ${report.hostPin.tag} (${report.hostPin.commit}).`,
    "- Complete source trees compared by Git blob hash; documented excluded entrypoints omitted.",
    "",
    "## Smallest refresh scope",
    "",
    "| Upstream path | Embedded blob | Release blob |",
    "| --- | --- | --- |",
    ...report.changes.map(change => `| \`${change.path}\` | ${change.oldBlob ?? "absent"} | ${change.newBlob ?? "absent"} |`),
    "",
    "## Changed vendored helpers",
    "",
    ...(report.changedHelpers.length === 0 ? ["None."] : report.changedHelpers.map(helper =>
      `- \`${helper.sourcePath}\` → \`${helper.vendoredPath}\` (base ${helper.commit}).`)),
    "",
    "## Active local-patch overlap",
    "",
    ...(report.patchOverlaps.length === 0 ? ["None."] : report.patchOverlaps.map(patch =>
      `- \`${patch.id}\`: ${patch.files.map(file => `\`${file}\``).join(", ")}.`)),
    "",
    "Review the complete client-drift-report artifact and packages/collab-client/README.md before refreshing.",
    "Refresh only the listed relevant files; review overlapping patches and update provenance and proofs together.",
    "",
  ].join("\n");
  if (Buffer.byteLength(body) > 60_000) throw new Error("client drift issue body exceeds the safe issue/output bound");
  return { kind: matches.length === 0 ? "create" : "update", title, label: CLIENT_DRIFT_LABEL, body,
    releaseCommit: report.release.commit, marker, issueNumber: matches.length === 0 ? null : Number(matches[0]!.number) };
}

/** Reads only public source metadata and issues; it never changes pins, candidates, or release state. */
export async function inspectClientDrift(
  embeddedInput: unknown,
  hostInput: unknown,
  repository = "carrythroughsystems/omp-session-gateway",
  read: PinReader = readDriftSource,
): Promise<ClientDriftReport> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("invalid issue repository");
  const embedded = provenance(embeddedInput);
  const host = record(hostInput, "host pin");
  const hostPin = { tag: tag(host.tag), commit: text(host.commit, SHA, "host commit"), version: text(host.packageVersion, VERSION, "host version") };
  if (hostPin.tag !== `v${hostPin.version}`) throw new Error("host pin tag/version mismatch");
  const latest = record(await json(read, LATEST), "npm latest");
  if (latest.name !== "@oh-my-pi/pi-coding-agent") throw new Error("unexpected npm latest package");
  const releaseTag = `v${text(latest.version, VERSION, "npm latest stable version")}`;
  const release = { tag: releaseTag, ...await resolveUpstreamCommit(releaseTag, read) };
  if (latest.gitHead !== undefined && latest.gitHead !== release.commit) throw new Error("npm latest/tag commit provenance mismatch");
  const tagged = await resolveUpstreamCommit(embedded.tag, read);
  if (tagged.commit !== embedded.commit) throw new Error("embedded tag/commit provenance mismatch");
  const trees = sourceTrees(read);
  const oldBlobs = await trees.packageBlobs(embedded.commit, embedded.sourcePath, true);
  const newBlobs = await trees.packageBlobs(release.commit, embedded.sourcePath, false);
  for (const excluded of embedded.excludedEntrypoints) {
    oldBlobs.delete(`${embedded.sourcePath}/${excluded}`);
    newBlobs.delete(`${embedded.sourcePath}/${excluded}`);
  }
  const changes: BlobChange[] = [];
  for (const name of [...new Set([...oldBlobs.keys(), ...newBlobs.keys()])].sort()) {
    if (oldBlobs.get(name) !== newBlobs.get(name)) changes.push({ path: name, oldBlob: oldBlobs.get(name) ?? null, newBlob: newBlobs.get(name) ?? null });
  }
  const changedHelpers: ClientDriftSourceReport["changedHelpers"][number][] = [];
  for (const helper of embedded.additionalSources) {
    const oldEntry = await trees.entry(helper.commit, helper.sourcePath);
    if (oldEntry?.type !== "blob" || oldEntry.sha !== helper.blob) throw new Error(`helper blob provenance mismatch: ${helper.sourcePath}`);
    const newEntry = await trees.entry(release.commit, helper.sourcePath);
    if (newEntry !== undefined && newEntry.type !== "blob") throw new Error("helper sourcePath no longer identifies a blob");
    const newBlob = newEntry?.sha ?? null;
    if (helper.blob !== newBlob) {
      changes.push({ path: helper.sourcePath, oldBlob: helper.blob, newBlob });
      changedHelpers.push({ ...helper, oldBlob: helper.blob, newBlob });
    }
  }
  changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  changedHelpers.sort((a, b) => a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0);
  const scope = new Set(changes.map(change => change.path));
  const changedVendored = new Set(changedHelpers.map(helper => helper.vendoredPath));
  // The schema's files include their src/ prefix and are relative to upstream/, not src/.
  const patchOverlaps = embedded.patches.map(patch => ({ id: patch.id,
    files: patch.files.filter(file => scope.has(`${embedded.sourcePath}/${file}`) || changedVendored.has(file)).sort(),
  })).filter(patch => patch.files.length > 0).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const report: ClientDriftSourceReport = { schemaVersion: 1, release, embedded: { tag: embedded.tag, commit: embedded.commit },
    hostPin, changes, changedHelpers, patchOverlaps, refreshScope: changes.map(change => change.path) };
  const issues: unknown[] = [];
  if (changes.length > 0) {
    // All pages, not GitHub search's capped results; unrelated release requests never gate inspection.
    for (let page = 1; ; page++) {
      const batch = array(await json(read, `https://api.github.com/repos/${repository}/issues?state=open&per_page=100&page=${page}`), "GitHub issues");
      if (batch.length > 100) throw new Error("unexpected GitHub issues page size");
      issues.push(...batch);
      if (batch.length < 100) break;
    }
  }
  return { ...report, issueAction: decideClientDriftIssue(report, issues) };
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error("usage: bun scripts/client-drift.ts");
    const root = join(import.meta.dir, "..");
    const report = await inspectClientDrift(
      JSON.parse(await readFile(join(root, "packages/collab-client/upstream/UPSTREAM.json"), "utf8")),
      JSON.parse(await readFile(join(root, "UPSTREAM.lock.json"), "utf8")),
      process.env.GITHUB_REPOSITORY,
    );
    if (process.env.GITHUB_OUTPUT !== undefined) {
      await appendFile(process.env.GITHUB_OUTPUT, `issue_action=${JSON.stringify(report.issueAction)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    // Do not echo provider response bodies, credentials, or arbitrary malformed input.
    console.error(`client drift inspection failed: ${error instanceof Error ? error.message : "unknown source read failure"}`);
    process.exitCode = 1;
  }
}
