import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decideClientDriftIssue, inspectClientDrift, type ClientDriftIssueAction } from "./client-drift.ts";
import type { PinReader } from "./upstream-pins.ts";

const API = "https://api.github.com/repos/can1357/oh-my-pi";
const LATEST = "https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/latest";
const ISSUES = "https://api.github.com/repos/example/gateway/issues?state=open&per_page=100&page=";
const OLD = "a".repeat(40);
const RELEASE = "b".repeat(40);
const HELPER_BASE = "c".repeat(40);
const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const APP = "packages/collab-web/src/app.tsx";
const HELPER = "packages/utils/src/marked.ts";
const baseFiles = {
  "packages/collab-web/package.json": sha('{"version":"16.3.6"}'),
  [APP]: sha("synthetic old app"),
  "packages/collab-web/src/removed.ts": sha("synthetic removed file"),
  "packages/collab-web/src/main.tsx": sha("synthetic excluded bootstrap"),
  [HELPER]: sha("synthetic old helper"),
  "packages/utils/src/bytes.ts": sha("synthetic unchanged helper"),
  "packages/coding-agent/src/collab/host.ts": sha("synthetic unrelated host"),
};
interface Entry { path: string; sha: string; type: string; mode: string }
interface Tree { sha: string; truncated: boolean; tree: Entry[] }
interface DriftFixture {
  embedded: {
    schemaVersion: number; repository: string; commit: string; tag: string; packageVersion: string; sourcePath: string;
    additionalSources: { sourcePath: string; vendoredPath: string; commit: string; blob: string }[];
    excludedEntrypoints: { sourcePath: string; vendored: boolean; reason: string }[];
    localPatches: { active: { id: string; files: string[] }[]; retired: { id: string; files: string[] }[] };
  };
  host: { tag: string; commit: string; packageVersion: string };
  routes: Map<string, unknown>;
  calls: string[];
  read: PinReader;
  oldTree: string;
  newTree: string;
}

// Build complete GitHub-shaped trees, independently of the implementation's traversal.
function addTrees(routes: Map<string, unknown>, commit: string, files: Record<string, string>): string {
  function directory(prefix: string): { sha: string; entries: Entry[]; all: Entry[] } {
    const names = new Set(Object.keys(files).filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split("/")[0]!));
    const entries: Entry[] = [];
    const all: Entry[] = [];
    for (const name of [...names].sort()) {
      const blob = files[prefix + name];
      if (blob !== undefined) {
        const entry = { path: name, sha: blob, type: "blob", mode: "100644" };
        entries.push(entry); all.push(entry);
      } else {
        const child = directory(`${prefix}${name}/`);
        const entry = { path: name, sha: child.sha, type: "tree", mode: "040000" };
        entries.push(entry); all.push(entry, ...child.all.map(item => ({ ...item, path: `${name}/${item.path}` })));
      }
    }
    const id = sha(JSON.stringify(entries));
    routes.set(`${API}/git/trees/${id}`, { sha: id, truncated: false, tree: entries });
    routes.set(`${API}/git/trees/${id}?recursive=1`, { sha: id, truncated: false, tree: all });
    return { sha: id, entries, all };
  }
  const root = directory("").sha;
  routes.set(`${API}/commits/${commit}`, { sha: commit, commit: { tree: { sha: root } } });
  return root;
}
function issue(number: number, overrides: Record<string, unknown> = {}) {
  return { number, title: "Upstream tracking: v18.18.0", body: "synthetic release request", state: "open",
    labels: [{ name: "release-request" }], ...overrides };
}
function fixture(options: { changes?: Record<string, string | null>; equal?: boolean; helperBase?: boolean; issues?: unknown[][]; version?: string } = {}): DriftFixture {
  const version = options.version ?? "18.18.0";
  const commit = options.equal ? RELEASE : OLD;
  const tag = options.equal ? `v${version}` : "v18.17.0";
  const routes = new Map<string, unknown>();
  const nextFiles: Record<string, string> = { ...baseFiles };
  for (const [name, blob] of Object.entries(options.changes ?? (options.equal ? {} : { [APP]: sha("synthetic new app") }))) {
    if (blob === null) delete nextFiles[name]; else nextFiles[name] = blob;
  }
  const oldTree = addTrees(routes, commit, baseFiles);
  const newTree = addTrees(routes, RELEASE, nextFiles);
  routes.set(`${API}/commits/${tag}`, { sha: commit, commit: { tree: { sha: oldTree } } });
  routes.set(`${API}/commits/v${version}`, { sha: RELEASE, commit: { tree: { sha: newTree } } });
  routes.set(LATEST, { name: "@oh-my-pi/pi-coding-agent", version, gitHead: RELEASE });
  const helperCommit = options.helperBase ? HELPER_BASE : commit;
  const helperBlob = options.helperBase ? sha("synthetic independently pinned helper") : baseFiles[HELPER];
  if (options.helperBase) addTrees(routes, HELPER_BASE, { ...baseFiles, [HELPER]: helperBlob });
  const embedded = { schemaVersion: 1, repository: "https://github.com/can1357/oh-my-pi", commit, tag,
    packageVersion: "16.3.6", sourcePath: "packages/collab-web",
    additionalSources: [
      { sourcePath: HELPER, vendoredPath: "src/vendor/pi-utils/marked.ts", commit: helperCommit, blob: helperBlob },
      { sourcePath: "packages/utils/src/bytes.ts", vendoredPath: "src/vendor/pi-utils/bytes.ts", commit, blob: baseFiles["packages/utils/src/bytes.ts"] },
    ],
    excludedEntrypoints: [{ sourcePath: "src/main.tsx", vendored: false, reason: "synthetic excluded bootstrap" }],
    localPatches: { active: [
      { id: "synthetic-app-patch", files: ["src/app.tsx", "src/local-only.ts"] },
      { id: "synthetic-helper-patch", files: ["src/vendor/pi-utils/marked.ts"] },
    ], retired: [{ id: "synthetic-retired-patch", files: ["src/app.tsx"] }] },
  };
  const host = { tag: `v${version}`, commit: RELEASE, packageVersion: version };
  for (const [index, page] of (options.issues ?? [[]]).entries()) routes.set(ISSUES + (index + 1), page);
  const calls: string[] = [];
  const read: PinReader = async url => {
    calls.push(url);
    const result = routes.get(url);
    if (result instanceof Response) return result.clone();
    return result === undefined ? new Response(null, { status: 404 }) : Response.json(result);
  };
  return { embedded, host, routes, calls, read, oldTree, newTree };
}
const inspect = (f: DriftFixture) => inspectClientDrift(f.embedded, f.host, "example/gateway", f.read);

test("host current/client stale is reported even when the collab-web package version is unchanged", async () => {
  const f = fixture();
  const snapshot = JSON.stringify({ embedded: f.embedded, host: f.host });
  const report = await inspect(f);
  expect(report.release).toEqual({ tag: "v18.18.0", commit: RELEASE, tree: f.newTree });
  expect(report.embedded).toEqual({ tag: "v18.17.0", commit: OLD });
  expect(report.hostPin).toEqual({ tag: "v18.18.0", commit: RELEASE, version: "18.18.0" });
  expect(report.changes).toEqual([{ path: APP, oldBlob: baseFiles[APP], newBlob: sha("synthetic new app") }]);
  expect(report.refreshScope).toEqual([APP]);
  expect(report.patchOverlaps).toEqual([{ id: "synthetic-app-patch", files: ["src/app.tsx"] }]);
  expect(report.issueAction.kind).toBe("create");
  expect(JSON.stringify({ embedded: f.embedded, host: f.host })).toBe(snapshot);
  expect(f.calls.some(url => url.includes("raw.githubusercontent.com") || url.includes("/compare/") || url.includes("/contents/"))).toBe(false);
});

test("helper-only drift uses each helper's own provenance commit and names its vendored path", async () => {
  const f = fixture({ changes: {}, helperBase: true });
  const report = await inspect(f);
  expect(report.changes).toEqual([{ path: HELPER, oldBlob: sha("synthetic independently pinned helper"), newBlob: baseFiles[HELPER] }]);
  expect(report.changedHelpers).toEqual([{ ...f.embedded.additionalSources[0]!, oldBlob: sha("synthetic independently pinned helper"), newBlob: baseFiles[HELPER] }]);
  expect(report.patchOverlaps).toEqual([{ id: "synthetic-helper-patch", files: ["src/vendor/pi-utils/marked.ts"] }]);
  expect(report.refreshScope).toEqual([HELPER]);
  expect(report.issueAction.kind).toBe("create");
  expect(f.calls).toContain(`${API}/commits/${HELPER_BASE}`);
});

test("complete trees report additions and deletions with null absent blobs and deterministic ordering", async () => {
  const added = "packages/collab-web/src/added.ts";
  const removed = "packages/collab-web/src/removed.ts";
  const f = fixture({ changes: { [added]: sha("synthetic addition"), [removed]: null, [HELPER]: null } });
  const report = await inspect(f);
  expect(report.changes).toEqual([
    { path: added, oldBlob: null, newBlob: sha("synthetic addition") },
    { path: removed, oldBlob: baseFiles[removed], newBlob: null },
    { path: HELPER, oldBlob: baseFiles[HELPER], newBlob: null },
  ]);
  expect(report.changedHelpers[0]?.newBlob).toBeNull();
  expect(report.refreshScope).toEqual(report.changes.map(change => change.path));
  expect(await inspect(f)).toEqual(report);
});

test("no relevant change, excluded-only and unrelated host changes produce no issue or issue read", async () => {
  const f = fixture({ changes: {
    "packages/collab-web/src/main.tsx": sha("synthetic new excluded bootstrap"),
    "packages/coding-agent/src/collab/host.ts": sha("synthetic new unrelated host"),
  } });
  const report = await inspect(f);
  expect(report.changes).toEqual([]);
  expect(report.changedHelpers).toEqual([]);
  expect(report.refreshScope).toEqual([]);
  expect(report.issueAction).toEqual({ kind: "none" });
  expect(f.calls.some(url => url.startsWith(ISSUES))).toBe(false);
  expect(decideClientDriftIssue(report, [issue(88, { title: "Embedded client drift: v18.17.0 → v18.18.0", labels: [{ name: "client-drift" }] })]))
    .toEqual({ kind: "none" });
});

test("equal embedded and release tags still validate complete source and helper provenance", async () => {
  const f = fixture({ equal: true });
  expect((await inspect(f)).issueAction).toEqual({ kind: "none" });
  expect(f.calls.some(url => url.includes("?recursive=1"))).toBe(true);
  f.embedded.additionalSources[0]!.blob = "d".repeat(40);
  await expect(inspect(f)).rejects.toThrow("helper blob provenance mismatch");
});

test("an open release request neither suppresses nor merges with the dedicated implementation issue", async () => {
  const f = fixture({ issues: [[issue(41), issue(42, { labels: [{ name: "release-request" }, { name: "client-drift" }] })]] });
  const report = await inspect(f);
  expect(report.issueAction.kind).toBe("create");
  if (report.issueAction.kind === "none") throw new Error("expected issue action");
  expect(report.issueAction.title).toBe("Embedded client drift: v18.17.0 → v18.18.0");
  expect(report.issueAction.label).toBe("client-drift");
  expect(report.issueAction.issueNumber).toBeNull();
  expect(report.issueAction.body).toContain("not a release request or release authority");
});

test("repeated drift updates an open issue by release commit or exact title plus dedicated label", async () => {
  const report = await inspect(fixture());
  const action = report.issueAction;
  if (action.kind === "none") throw new Error("expected issue action");
  const existing = issue(77, { title: action.title, body: action.body, labels: [{ name: action.label }] });
  expect(decideClientDriftIssue(report, [existing])).toEqual({ ...action, kind: "update", issueNumber: 77 });
  expect(decideClientDriftIssue(report, [{ ...existing, body: "synthetic pre-marker body" }]).kind).toBe("update");
  expect(decideClientDriftIssue({ ...report, embedded: { ...report.embedded, tag: "v18.16.0" } }, [existing]))
    .toMatchObject({ kind: "update", issueNumber: 77, title: "Embedded client drift: v18.16.0 → v18.18.0" });
  for (const unrelated of [
    { ...existing, state: "closed" }, { ...existing, labels: [] }, { ...existing, pull_request: {} },
    { ...existing, labels: [{ name: "client-drift" }, { name: "release-minor" }] },
    { ...existing, title: "Upstream tracking: v18.18.0" },
  ]) expect(decideClientDriftIssue(report, [unrelated]).kind).toBe("create");
});

test("issue pagination finds an older drift issue beyond the first hundred unrelated requests", async () => {
  const report = await inspect(fixture());
  if (report.issueAction.kind === "none") throw new Error("expected issue action");
  const f = fixture({ issues: [Array.from({ length: 100 }, (_, i) => issue(i + 1)), [
    issue(201, { title: report.issueAction.title, body: report.issueAction.body, labels: [{ name: "client-drift" }] }),
  ]] });
  expect((await inspect(f)).issueAction).toMatchObject({ kind: "update", issueNumber: 201 });
  expect(f.calls).toContain(ISSUES + 2);
});

test("a newly published stable after a frozen candidate is drift, without touching release state", async () => {
  const frozen = Object.freeze({ candidate: "v0.9.2-prealpha.1", upstream: "v18.18.0", source: OLD });
  const snapshot = JSON.stringify(frozen);
  const f = fixture({ version: "18.19.0" });
  f.host = { tag: "v18.18.0", commit: OLD, packageVersion: "18.18.0" };
  f.embedded.tag = "v18.18.0";
  f.routes.set(`${API}/commits/v18.18.0`, { sha: OLD, commit: { tree: { sha: f.oldTree } } });
  const report = await inspect(f);
  expect(report.release.tag).toBe("v18.19.0");
  expect(report.issueAction).toMatchObject({ kind: "create", title: "Embedded client drift: v18.18.0 → v18.19.0" });
  expect(JSON.stringify(frozen)).toBe(snapshot);
  expect(f.calls.every(url => url.startsWith(API + "/commits/") || url.startsWith(API + "/git/trees/") || url === LATEST || url.startsWith(ISSUES))).toBe(true);
});

test.each(["release", "embedded", "source", "helper", "issues"])("failed %s fetch fails visibly instead of stale success", async stage => {
  const f = fixture({ helperBase: stage === "helper" });
  const url = stage === "release" ? `${API}/commits/v18.18.0`
    : stage === "embedded" ? `${API}/commits/v18.17.0`
    : stage === "issues" ? ISSUES + 1
    : stage === "helper" ? `${API}/commits/${HELPER_BASE}` : `${API}/git/trees/${f.newTree}`;
  f.routes.set(url, new Response(null, { status: stage === "release" ? 404 : 503 }));
  await expect(inspect(f)).rejects.toThrow(stage === "release" ? "answered 404" : "answered 503");
});

test.each(["truncated", "missing-truncated", "wrong-sha", "duplicate", "invalid-sha", "invalid-mode", "invalid-path", "missing-parent", "not-array"])(
  "refuses %s tree results, never trusting a partial source comparison", async failure => {
    const f = fixture();
    const [url, stored] = [...f.routes.entries()].find(([url, value]) => url.includes("?recursive=1")
      && (value as Tree).tree.some(entry => entry.path === "src/app.tsx"))!;
    const tree = structuredClone(stored) as Tree;
    if (failure === "truncated") tree.truncated = true;
    if (failure === "missing-truncated") Reflect.deleteProperty(tree, "truncated");
    if (failure === "wrong-sha") tree.sha = "e".repeat(40);
    if (failure === "duplicate") tree.tree.push(tree.tree[0]!);
    if (failure === "invalid-sha") tree.tree[0]!.sha = "invalid";
    if (failure === "invalid-mode") tree.tree[0]!.mode = "160000";
    if (failure === "invalid-path") tree.tree[0]!.path = "../unexpected.ts";
    if (failure === "missing-parent") tree.tree = tree.tree.filter(entry => entry.path !== "src");
    if (failure === "not-array") Reflect.set(tree, "tree", {});
    f.routes.set(url, tree);
    await expect(inspect(f)).rejects.toThrow();
  },
);

test("truncated nonrecursive parent trees and relevant submodules also fail", async () => {
  const f = fixture();
  const url = `${API}/git/trees/${f.oldTree}`;
  f.routes.set(url, { ...(f.routes.get(url) as Tree), truncated: true });
  await expect(inspect(f)).rejects.toThrow("truncated");
  const g = fixture();
  const [recursiveUrl, stored] = [...g.routes.entries()].find(([url, value]) => url.includes("?recursive=1")
    && (value as Tree).tree.some(entry => entry.path === "src/app.tsx"))!;
  const tree = structuredClone(stored) as Tree;
  tree.tree.push({ path: "synthetic-submodule", sha: "e".repeat(40), type: "commit", mode: "160000" });
  g.routes.set(recursiveUrl, tree);
  await expect(inspect(g)).rejects.toThrow("submodule");
});

test("provenance mismatches and unexpected npm, issue or metadata shapes fail closed", async () => {
  for (const alter of [
    (f: DriftFixture) => { f.embedded.commit = "e".repeat(40); },
    (f: DriftFixture) => { f.embedded.schemaVersion = 2; },
    (f: DriftFixture) => { f.embedded.additionalSources[0]!.blob = "e".repeat(40); },
    (f: DriftFixture) => { f.routes.set(LATEST, { name: "unexpected", version: "18.18.0" }); },
    (f: DriftFixture) => { f.routes.set(LATEST, { name: "@oh-my-pi/pi-coding-agent", version: "18.18.0-rc.1" }); },
    (f: DriftFixture) => { f.routes.set(LATEST, { name: "@oh-my-pi/pi-coding-agent", version: "18.18.0", gitHead: OLD }); },
    (f: DriftFixture) => { f.routes.set(ISSUES + 1, {}); },
    (f: DriftFixture) => { f.routes.set(ISSUES + 1, [{ number: "not-numeric" }]); },
  ]) {
    const f = fixture(); alter(f);
    await expect(inspect(f)).rejects.toThrow();
  }
  const f = fixture();
  f.routes.set(LATEST, new Response("not json", { headers: { "content-type": "application/json" } }));
  await expect(inspect(f)).rejects.toThrow();
});

interface Step { id?: string; name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string | string[]; permissions: Record<string, string>; outputs?: Record<string, string>; steps?: Step[]; concurrency?: unknown }
const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/upstream-canary.yml", import.meta.url)).text()) as {
  on: { schedule: { cron: string }[]; workflow_dispatch: unknown; workflow_call: { outputs: Record<string, unknown> } };
  jobs: Record<string, Job>;
};
function writerScript(): string {
  const run = workflow.jobs["report-client-drift"]!.steps![0]!.run!;
  const script = /node <<'NODE'\n([\s\S]*?)\nNODE/u.exec(run)?.[1];
  if (script === undefined) throw new Error("missing inline data-only writer");
  return script;
}
function applyAction(action: ClientDriftIssueAction, pages: unknown[][] = [[]]) {
  const calls: string[][] = [];
  const requireMock = (name: string) => {
    if (name !== "node:child_process") throw new Error("writer attempted to load repository or filesystem code");
    return { execFileSync: (executable: string, args: string[]) => {
      if (executable !== "gh") throw new Error("unexpected executable");
      calls.push(args);
      return args[0] === "api" ? JSON.stringify(pages) : "";
    } };
  };
  const run = () => new Function("require", "process", "console", writerScript())(requireMock,
    { env: { ISSUE_ACTION: JSON.stringify(action), GITHUB_REPOSITORY: "example/gateway" } }, { log: () => {} });
  return { calls, run };
}

test("workflow preserves daily schedule, canary outputs and failure reporter while separating privileges", () => {
  expect(workflow.on.schedule).toEqual([{ cron: "23 8 * * *" }]);
  expect(workflow.on.workflow_dispatch).toBeDefined();
  expect(workflow.on.workflow_call.outputs.passed).toEqual({
    description: "Linux and Windows passed for the exact requested OMP version", value: "${{ jobs.result.outputs.passed }}",
  });
  for (const name of ["canary", "canary-windows"]) {
    expect(workflow.jobs[name]!.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs[name]!.outputs?.omp_version).toBe("${{ steps.summary.outputs.omp_version }}");
  }
  expect(workflow.jobs.result!.needs).toEqual(["canary", "canary-windows"]);
  expect(workflow.jobs["report-failure"]!.needs).toEqual(["canary", "canary-windows"]);
  expect(workflow.jobs["report-failure"]!.permissions).toEqual({ issues: "write" });
  expect(workflow.jobs["report-failure"]!.if).toContain("github.event_name == 'schedule'");
  const inspection = workflow.jobs["inspect-client-drift"]!;
  const writer = workflow.jobs["report-client-drift"]!;
  expect(inspection.permissions).toEqual({ contents: "read", issues: "read" });
  // A release request's reusable call must never run, and so never fail on, drift inspection.
  expect(inspection.if).toBe("${{ github.workflow == 'Upstream OMP canary' }}");
  expect(inspection.steps!.find(step => step.id === "inspect")!.run).toContain("bun scripts/client-drift.ts");
  expect(inspection.steps!.some(step => step.uses?.startsWith("actions/upload-artifact@"))).toBe(true);
  expect(writer.permissions).toEqual({ issues: "write" });
  expect(writer.needs).toBe("inspect-client-drift");
  expect(writer.if).toContain("github.ref == 'refs/heads/main'");
  expect(writer.if).toContain("github.workflow == 'Upstream OMP canary'");
  expect(writer.concurrency).toEqual({ group: "embedded-client-drift-writer", "cancel-in-progress": false });
  expect(writer.steps).toHaveLength(1);
  expect(writer.steps![0]!.uses).toBeUndefined();
  expect(writer.steps![0]!.env!.ISSUE_ACTION).toBe("${{ needs.inspect-client-drift.outputs.issue_action }}");
  expect(writerScript()).not.toMatch(/checkout|import\(|eval\(|release-driver|release-request\.yml/u);
  for (const step of inspection.steps!) if (step.uses !== undefined) expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
});

test("shipped writer applies decided create/update/none actions and never merges release requests", async () => {
  const report = await inspect(fixture());
  if (report.issueAction.kind === "none") throw new Error("expected issue action");
  const create = applyAction(report.issueAction, [[issue(19)]]);
  create.run();
  expect(create.calls.filter(args => args[0] === "issue").map(args => args.slice(0, 2))).toEqual([["issue", "create"]]);
  const existing = issue(77, { title: report.issueAction.title, body: report.issueAction.body, labels: [{ name: "client-drift" }] });
  const action = decideClientDriftIssue(report, [existing]);
  const update = applyAction(action, [[issue(19), existing]]);
  update.run();
  expect(update.calls.filter(args => args[0] === "issue").map(args => args.slice(0, 3))).toEqual([["issue", "edit", "77"]]);
  const none = applyAction({ kind: "none" }, [[existing]]);
  none.run();
  expect(none.calls).toEqual([]);
  expect([...create.calls, ...update.calls].flat()).not.toContain("release-request");
});

test("serialized writer refuses stale create plans without duplicating or reopening issues", async () => {
  const report = await inspect(fixture());
  if (report.issueAction.kind === "none") throw new Error("expected issue action");
  const existing = issue(77, { title: report.issueAction.title, body: report.issueAction.body, labels: [{ name: "client-drift" }] });
  const staleCreate = applyAction(report.issueAction, [[existing]]);
  expect(staleCreate.run).toThrow("plan became stale");
  expect(staleCreate.calls).toHaveLength(1);
  const staleUpdate = applyAction(decideClientDriftIssue(report, [existing]), [[{ ...existing, state: "closed" }]]);
  expect(staleUpdate.run).toThrow("plan became stale");
  expect(staleUpdate.calls).toHaveLength(1);
  const invalid = applyAction({ ...report.issueAction, label: "release-request" } as unknown as ClientDriftIssueAction);
  expect(invalid.run).toThrow("Invalid inspected");
  expect(invalid.calls).toEqual([]);
});
