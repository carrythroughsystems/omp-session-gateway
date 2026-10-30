import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

/**
 * Named mutations over the security predicates, each of which must fail a named test.
 *
 * Coverage says a line executed. It does not say any assertion would notice if that line stopped
 * doing its job, and for this repository's authorization boundary that is the only property worth
 * having. Bun's own coverage cannot supply it either way: its lcov carries no `BRDA` records at all,
 * so there is no branch signal to read, and `FNF`/`FNH` arrive as bare totals with no `FN:`/`FNDA:`
 * attribution. This measures discrimination instead of execution — weaken one specific guard in a
 * copy of the tree, run the test that claims to defend it, and require that test to fail.
 *
 * Deliberately not tree-wide mutation testing, which would be a large persistent control generating
 * mostly noise about code whose failure costs nothing. Every entry below is a guard whose removal
 * costs a remote authentication bypass or a leaked capability, and the list is meant to stay short
 * enough that someone reads it.
 *
 * The vacuity guard matters more than the mutations. If a `find` string stops matching — a refactor,
 * a rename, a reformat — the mutation silently becomes a no-op and the check passes while proving
 * nothing, which is worse than not having it. A pattern that no longer applies is a failure here, not
 * a skip.
 */

interface Mutation {
  /** What protection is being removed, in terms an operator would care about. */
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  /** The suite that claims to defend it. */
  readonly target: string;
  /** The specific case that must fail. A suite failing *somewhere* is not evidence about this guard. */
  readonly mustFail: string;
}

const MUTATIONS: readonly Mutation[] = [
  {
    name: "trusted dashboard creation bypasses exact JSON admission",
    file: "apps/gateway/src/auth.ts",
    find: 'if (request.headers.get("Content-Type") !== "application/json") return undefined;',
    replace: 'if (false && request.headers.get("Content-Type") !== "application/json") return undefined;',
    target: "apps/gateway/test/http.test.ts",
    mustFail: "exposes only exact creation routes with authenticated header-minimal preflight and no credential grant",
  },
  {
    name: "untrusted dashboard origins admitted to browser-direct metadata",
    file: "apps/gateway/src/http-policy.ts",
    find: 'if (origin === null || !config.http.trustedDashboardOrigins.includes(origin)) return undefined;',
    replace: 'if (origin === null) return undefined;',
    target: "apps/gateway/test/http.test.ts",
    mustFail: "refuses untrusted, null, malformed and multiple dashboard origins",
  },
  {
    name: "preflight bypasses the normal identity path",
    file: "apps/gateway/src/http.ts",
    find: "const authorization = authorizeHttpRequest(request, peer, config, serveOwnsIdentityHeaders);",
    replace: 'const authorization = request.method === "OPTIONS" ? { allowed: true as const, identityKey: "preflight-bypass" } : authorizeHttpRequest(request, peer, config, serveOwnsIdentityHeaders);',
    target: "apps/gateway/test/http.test.ts",
    mustFail: "preflight cannot bypass identity trust, loopback, allowlist or second-hop checks",
  },
  {
    name: "a trusted dashboard is accepted as the local push mutation context",
    file: "apps/gateway/src/auth.ts",
    find: 'if (request.headers.get("Origin") !== expectedOrigin) return false;',
    replace: 'if (false && request.headers.get("Origin") !== expectedOrigin) return false;',
    target: "apps/gateway/test/http.test.ts",
    mustFail: "trusted-dashboard origins never authorize local push mutations",
  },
  {
    name: "identity headers believed on a host with no Tailscale tunnel device (#98)",
    file: "apps/gateway/src/auth.ts",
    find: 'if (!serveOwnsIdentityHeaders) return { allowed: false, reason: "identity_untrustworthy" };',
    replace: 'if (false && !serveOwnsIdentityHeaders) return { allowed: false, reason: "identity_untrustworthy" };',
    target: "apps/gateway/test/http.test.ts",
    mustFail: "refuses an allowlisted identity when no tailnet interface vouches for Serve",
  },
  {
    name: "shared CGNAT space accepted as proof of a tunnel device (#98)",
    file: "apps/gateway/src/tailnet.ts",
    find: "if (tunnel && entry.netmask === IPV4_HOST_ROUTE_NETMASK && TAILNET_IPV4.test(entry.address)) return true;",
    replace: "if (TAILNET_IPV4.test(entry.address)) return true;",
    target: "apps/gateway/test/tailnet.test.ts",
    mustFail: "an ordinary interface on shared CGNAT space does not vouch for a TUN device",
  },
  {
    name: "non-loopback peers admitted",
    file: "apps/gateway/src/auth.ts",
    find: 'if (peer === undefined || !isLoopbackAddress(peer.address)) return { allowed: false, reason: "unauthorized" };',
    replace: 'if (peer === undefined) return { allowed: false, reason: "unauthorized" };',
    target: "apps/gateway/test/http.test.ts",
    mustFail: "fails closed for missing, disallowed, forged remote, and tagged-style identities",
  },
  {
    name: "identity allowlist not consulted",
    file: "apps/gateway/src/auth.ts",
    find: "if (login === undefined || !config.auth.allowedLogins.includes(login)) {",
    replace: "if (login === undefined) {",
    target: "apps/gateway/test/http.test.ts",
    mustFail: "fails closed for missing, disallowed, forged remote, and tagged-style identities",
  },
  {
    name: "an admitted event stream never re-authorized",
    file: "apps/gateway/src/http.ts",
    find: "if (!stillAuthorized()) {",
    replace: "if (false) {",
    target: "apps/gateway/test/http.test.ts",
    mustFail: "an admitted stream stops when the topology stops justifying it",
  },
  {
    name: "a superseded generation still authorizes a launch",
    file: "apps/gateway/src/registry.ts",
    find: 'if (record.metadata.generation !== generation) return { status: "generation_mismatch" };',
    replace: 'if (false) return { status: "generation_mismatch" };',
    target: "apps/gateway/test/registry.test.ts",
    mustFail: "revokes an old generation before replacement becomes observable",
  },
  {
    name: "doctor claims sound loopback trust unconditionally (#98)",
    file: "apps/gateway/src/doctor.ts",
    find: "checks.loopbackTrustSound = tunDevicePresent();",
    replace: "checks.loopbackTrustSound = true;",
    target: "apps/gateway/test/doctor.test.ts",
    mustFail: "withholds trust without a tunnel device and compatibility without a reachable OMP",
  },
  {
    name: "identity believed through a tunnel or reverse proxy in front of the listener (#158, #74)",
    file: "apps/gateway/src/auth.ts",
    find: "  if (secondHopEvidence(request, config.http.publicOrigin) !== undefined) {",
    replace: "  if (false && secondHopEvidence(request, config.http.publicOrigin) !== undefined) {",
    target: "apps/gateway/test/http.test.ts",
    mustFail: "refuses an allowlisted identity carrying evidence of a second HTTP hop",
  },
  // Deliberately absent: withholding `listenerLoopbackOnly` on unsound trust. That check is
  // unobservable without a live daemon on the fixture's port, because the value is
  // `checks.daemon && hostname is loopback` and is false either way in an isolated root. Adding the
  // mutation anyway would give a permanently red harness that proves nothing, which is exactly the
  // vacuity this file exists to prevent.
];

/**
 * Only genuinely regenerable or irrelevant trees are skipped. `docs` and `site` are copied because
 * target suites read them, and omitting a tree a suite reads made the baseline fail for a reason
 * that had nothing to do with any mutation.
 */
const SKIPPED_TREES: Record<string, true> = {
  node_modules: true,
  ".git": true,
  dist: true,
  coverage: true,
  "playwright-report": true,
};

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const selfPath = relative(repoRoot, fileURLToPath(import.meta.url)).replaceAll("\\", "/");
/**
 * Creating the `node_modules` directory symlink the copied tree needs requires elevation on Windows,
 * so this harness does not run there. Stated rather than silently skipped: Windows is not an
 * advertised host, and the Linux and macOS lanes both run these mutations on every pull request, so
 * no guard here goes unexercised. If Windows is ever advertised, this needs a junction instead.
 */
const RUNNABLE = process.platform !== "win32";
let tree = "";

beforeAll(async () => {
  if (!RUNNABLE) return;
  tree = await mkdtemp(join(tmpdir(), "gateway-mutation-"));
  // Copied rather than mutated in place: a harness that edits the working tree can leave a weakened
  // guard behind if it dies between mutation and restore. `node_modules` is symlinked rather than
  // copied because Bun resolves the workspace packages through per-package link directories, and
  // those relative links must keep resolving inside the copy.
  await cp(repoRoot, tree, {
    recursive: true,
    verbatimSymlinks: true,
    filter: source => {
      const rel = relative(repoRoot, source).replaceAll("\\", "/");
      if (rel === "") return true;
      return SKIPPED_TREES[rel.split("/")[0] ?? ""] !== true || rel.includes("/node_modules");
    },
  });
  await symlink(join(repoRoot, "node_modules"), join(tree, "node_modules"), "dir");
});

afterAll(async () => {
  if (!RUNNABLE) return;
  await rm(tree, { recursive: true, force: true });
});

async function runTarget(target: string): Promise<{ readonly code: number; readonly output: string }> {
  const subprocess = Bun.spawn([process.execPath, "test", target], { cwd: tree, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

test.skipIf(!RUNNABLE)("every mutated suite passes before it is mutated", async () => {
  // Without this, a mutation could "fail" for an unrelated reason — a broken copy, a missing
  // workspace link — and the harness would report protection it never demonstrated.
  const targets = [...new Set(MUTATIONS.map(mutation => mutation.target))];
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    expect(target).not.toBe(selfPath);
    const baseline = await runTarget(target);
    expect({ target, code: baseline.code }).toEqual({ target, code: 0 });
  }
}, 6 * HANG_DEADLINE_MS);

for (const mutation of MUTATIONS) {
  test.skipIf(!RUNNABLE)(`removing a guard is caught: ${mutation.name}`, async () => {
    const path = join(tree, mutation.file);
    const original = await readFile(path, "utf8");
  
    // A pattern that no longer matches is a failure, not a skip: a silently inapplicable mutation
    // leaves the suite green while the guard it names is unprotected.
    expect(original.includes(mutation.find)).toBe(true);
    const mutated = original.replaceAll(mutation.find, mutation.replace);
    expect(mutated).not.toBe(original);
  
    try {
      await writeFile(path, mutated);
      const result = await runTarget(mutation.target);
      expect(result.code).not.toBe(0);
      // The named case must be the one that fails, tying the mutation to the assertion that claims
      // to defend it rather than to collateral damage elsewhere in the suite.
      expect(result.output).toContain(mutation.mustFail);
    } finally {
      await writeFile(path, original);
    }
  }, 2 * HANG_DEADLINE_MS);
}
