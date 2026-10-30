import { expect, test, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

/**
 * Imports every server-side source module once.
 *
 * Two purposes, both real. First, Bun's coverage only instruments what a test actually loads, so a
 * module no test imports is absent from the lcov entirely rather than reported at 0%. That makes the
 * headline percentage flatter itself by omission, and — worse — hides the existence of untested
 * files. Importing them all turns silence into an honest row. It does mean import-time lines count as
 * covered, which flatters the number slightly in the other direction; that trade is deliberate,
 * because a visible low number beats an invisible file.
 *
 * Second, and independently useful: this is a smoke test that every module is import-safe. A module
 * that throws, blocks, binds a port, or writes to disk merely by being loaded is a real defect —
 * `cli.ts` is only safe to import because its entry point sits behind `import.meta.main` — and
 * without this nothing would catch a top-level side effect until a service failed to start.
 *
 * Scope is server-side deliberately. `apps/web/src` touches `document` and service-worker globals at
 * import time and is exercised by the Playwright suite instead, and
 * `packages/collab-client/upstream` is pinned upstream source that this repository does not own.
 */

const ROOTS: readonly string[] = ["apps/gateway/src", "packages/protocol/src"];

/**
 * A floor, not an exact count, so adding a module does not fail this test — but deleting the glob's
 * ability to find anything does. An empty sweep would pass every assertion below while proving
 * nothing, which is the failure mode worth guarding.
 */
const MINIMUM_MODULES = 18;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function sourceModules(): readonly string[] {
  const glob = new Bun.Glob("**/*.ts");
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of glob.scanSync({ cwd: join(repoRoot, root), onlyFiles: true })) {
      if (file.endsWith(".d.ts")) continue;
      found.push(`${root}/${file.replaceAll("\\", "/")}`);
    }
  }
  return found.sort();
}

test("every server-side module is import-safe", async () => {
  const modules = sourceModules();
  expect(modules.length).toBeGreaterThanOrEqual(MINIMUM_MODULES);

  const failures: string[] = [];
  for (const module of modules) {
    try {
      // Dynamic by necessity: the specifier is discovered by glob at run time, which is the whole
      // point. A static import list would be the thing that goes stale and stops covering new
      // modules, and enumerating it by hand is exactly the omission this test exists to prevent.
      // A file URL rather than a bare path: on Windows `C:\...` is not a valid module specifier.
      const loaded = await import(pathToFileURL(join(repoRoot, module)).href);
      // A module that resolves to nothing usable is as broken as one that throws.
      expect(typeof loaded).toBe("object");
    } catch (error) {
      failures.push(`${module}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  expect(failures).toEqual([]);
}, 2 * HANG_DEADLINE_MS);

test("the sweep covers the modules the gateway actually ships", async () => {
  const modules = sourceModules();
  // Named rather than counted: these are the files whose absence from coverage would matter most,
  // and naming them means a rename cannot quietly drop one out of the sweep.
  for (const required of [
    "apps/gateway/src/auth.ts",
    "apps/gateway/src/tailnet.ts",
    "apps/gateway/src/http.ts",
    "apps/gateway/src/registry.ts",
    "apps/gateway/src/omp-registry.ts",
    "apps/gateway/src/config.ts",
    "apps/gateway/src/doctor.ts",
    "apps/gateway/src/service.ts",
    "apps/gateway/src/installation.ts",
    "apps/gateway/src/cli.ts",
    "packages/protocol/src/validation.ts",
  ]) {
    expect(modules).toContain(required);
  }
});
