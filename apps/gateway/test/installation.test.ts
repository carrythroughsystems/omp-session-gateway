import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { GatewayConfig } from "../src/config.ts";
import {
  GATEWAY_VERSION,
  type InstalledRuntime,
  activateRuntime,
  activationHistory,
  activationState,
  currentInstalledRuntime,
  pruneSupersededRuntimes,
  resolveRollbackTarget,
  stageRuntimePayload,
} from "../src/installation.ts";
import { serviceDefinition } from "../src/service.ts";

/** Every Windows task definition names its installing account; any valid SID stands in for it here. */
const windowsUserSid = "S-1-5-21-1111111111-2222222222-3333333333-1001";

function config(root: string): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317", trustedDashboardOrigins: [] },
    fleet: { label: "127.0.0.1", targets: [] },
    speech: { browserRecognition: false },
    auth: { mode: "dev-localhost", allowedLogins: [] },
    omp: { discoveryDir: join(root, "omp", "run", "collab-hosts"), queryTimeoutMs: 1_500 },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 10 },
    paths: {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
      tokenPath: join(root, "config", "readiness-token"),
      configPath: join(root, "config", "config.json"),
    },
  };
}

async function sourceFixture(root: string): Promise<{ sourceRoot: string; cliSource: string }> {
  const sourceRoot = join(root, "source");
  const cliSource = join(sourceRoot, "cli.js");
  for (const directory of [
    "apps/web/dist",
    "licenses/runtime/example",
    "packages/collab-client/upstream",
  ]) {
    await mkdir(join(sourceRoot, directory), { recursive: true });
  }
  await Promise.all([
    writeFile(cliSource, "console.log('installed gateway');\n"),
    writeFile(join(sourceRoot, "apps/web/dist/index.html"), "<!doctype html>"),
    writeFile(join(sourceRoot, "apps/web/dist/manifest.webmanifest"), "{}"),
    writeFile(join(sourceRoot, "apps/web/dist/service-worker.js"), "// worker"),
    writeFile(join(sourceRoot, "licenses/runtime/example/LICENSE"), "synthetic runtime license"),
    writeFile(join(sourceRoot, "packages/collab-client/upstream/LICENSE"), "synthetic collab license"),
    writeFile(join(sourceRoot, "LICENSE"), "gateway license"),
    writeFile(join(sourceRoot, "NOTICE.md"), "gateway notice"),
    writeFile(join(sourceRoot, "THIRD_PARTY_NOTICES.md"), "third-party notice"),
    writeFile(join(sourceRoot, "UPSTREAM.lock.json"), "{}"),
    writeFile(join(sourceRoot, "bun.lock"), "{ workspaces: {} }\n"),
    writeFile(join(sourceRoot, "package.json"), "{}\n"),
    writeFile(join(sourceRoot, "release-info.json"), '{"bunLockSha256":"synthetic"}\n'),
    writeFile(join(sourceRoot, "SBOM.spdx.json"), '{"spdxVersion":"SPDX-2.3"}\n'),
  ]);
  return { sourceRoot, cliSource };
}

/**
 * Two distinct runtimes staged from one fixture. The payload digest names the directory, so the CLI
 * body has to change for a second version to exist at all.
 */
async function stageTwo(
  gatewayConfig: GatewayConfig,
  source: { sourceRoot: string; cliSource: string },
): Promise<{ first: InstalledRuntime; second: InstalledRuntime }> {
  const first = await stageRuntimePayload(gatewayConfig, source);
  await writeFile(source.cliSource, "console.log('replacement gateway');\n");
  const second = await stageRuntimePayload(gatewayConfig, source);
  return { first, second };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

test("pruning preserves the distinct rollback horizon and a divergent service across 35 staged versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pruning-history-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const runtimes: InstalledRuntime[] = [];
    for (let index = 0; index < 34; index += 1) {
      await writeFile(source.cliSource, `console.log(${index});\n`);
      runtimes.push(await stageRuntimePayload(gatewayConfig, source));
    }
    const [old, active, predecessor, older] = runtimes;
    const divergent = runtimes.at(-1);
    if (!old || !active || !predecessor || !older || !divergent) throw new Error("missing fixture runtime");
    const versions = dirname(active.directory);
    const preHistory = join(versions, "0.1.0-prealpha.1-000000000000");
    await mkdir(preHistory);
    await writeFile(join(preHistory, "old-bun-path"), "synthetic-retired-bun");
    for (const runtime of [old, older, active, predecessor, active]) await activateRuntime(gatewayConfig, runtime);
    const definitionPath = join(root, "service.plist");
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", divergent.cliPath).content);
    const beforeHistory = await activationHistory(gatewayConfig);
    const beforePointer = await readFile(join(gatewayConfig.paths.stateDir, "installation", "current.json"), "utf8");

    expect(await pruneSupersededRuntimes(gatewayConfig, definitionPath)).toEqual({ retained: 4, removed: 31, failed: 0 });
    expect((await readdir(versions)).sort()).toEqual(
      [active, predecessor, older, divergent].map(runtime => basename(runtime.directory)).sort(),
    );
    expect((await resolveRollbackTarget(gatewayConfig)).runtime.directory).toBe(predecessor.directory);
    await expect(resolveRollbackTarget(gatewayConfig, basename(old.directory))).rejects.toThrow("is not installed");
    expect(await activationHistory(gatewayConfig)).toEqual(beforeHistory);
    expect(await readFile(join(gatewayConfig.paths.stateDir, "installation", "current.json"), "utf8")).toBe(beforePointer);
    // Plain rollback still oscillates between the two actually activated versions, without pruning.
    await activateRuntime(gatewayConfig, (await resolveRollbackTarget(gatewayConfig)).runtime);
    expect((await resolveRollbackTarget(gatewayConfig)).runtime.directory).toBe(active.directory);
    expect((await lstat(older.directory)).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("pruning completes private markers but never touches foreign names or symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pruning-marker-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    await activateRuntime(gatewayConfig, first);
    await activateRuntime(gatewayConfig, second);
    const versions = dirname(first.directory);
    const definitionPath = join(root, "service.plist");
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", second.cliPath).content);
    const marker = ".prune-00000000-0000-4000-8000-000000000000";
    await mkdir(join(versions, marker));
    await writeFile(join(versions, marker, "partial-payload"), "interrupted removal");
    const outside = join(root, "unrelated");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "untouched outside payload");
    for (const name of ["operator-notes", ".prune-not-a-private-marker"]) await mkdir(join(versions, name));
    for (const name of ["0.0.1-000000000000", ".prune-00000000-0000-4000-8000-000000000001"]) {
      await symlink(outside, join(versions, name));
    }
    await writeFile(join(versions, "0.0.2-000000000000"), "not a directory");
    const linkedVictim = join(versions, "0.0.3-000000000000");
    await mkdir(linkedVictim);
    await symlink(outside, join(linkedVictim, "linked-payload"));
    const before = await readdir(versions);
    expect(await pruneSupersededRuntimes(gatewayConfig, definitionPath)).toEqual({ retained: 2, removed: 1, failed: 1 });
    expect((await readdir(versions)).sort()).toEqual(before.filter(name => name !== marker).sort());
    expect((await lstat(join(versions, "0.0.1-000000000000"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(linkedVictim, "linked-payload"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("untouched outside payload");
    expect(await readFile(join(versions, "0.0.2-000000000000"), "utf8")).toBe("not a directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("pruning refuses symlinked state, installation, and versions roots", async () => {
  for (const component of ["state", "installation", "versions"]) {
    const root = await mkdtemp(join(tmpdir(), "gateway-pruning-root-"));
    try {
      const gatewayConfig = config(root);
      const source = await sourceFixture(root);
      const { first, second } = await stageTwo(gatewayConfig, source);
      await activateRuntime(gatewayConfig, second);
      const definitionPath = join(root, "service.plist");
      await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", second.cliPath).content);
      const path = component === "state" ? gatewayConfig.paths.stateDir : component === "installation"
        ? dirname(dirname(first.directory)) : dirname(first.directory);
      const moved = join(root, "outside-installation");
      await rename(path, moved);
      await symlink(moved, path);
      const before = (await readdir(moved, { recursive: true })).sort();
      expect(await pruneSupersededRuntimes(gatewayConfig, definitionPath)).toEqual({ retained: 0, removed: 0, failed: 1 });
      expect((await readdir(moved, { recursive: true })).sort()).toEqual(before);
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("pruning refuses uncommitted history and over-deep victims without removing their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pruning-bounds-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    await activateRuntime(gatewayConfig, second);
    const definitionPath = join(root, "service.plist");
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", second.cliPath).content);
    const historyPath = join(gatewayConfig.paths.stateDir, "installation", "history.json");
    const history = await readFile(historyPath, "utf8");
    await writeFile(historyPath, JSON.stringify({ activations: [basename(first.directory)] }));
    expect(await pruneSupersededRuntimes(gatewayConfig, definitionPath)).toEqual({ retained: 0, removed: 0, failed: 1 });
    expect((await lstat(first.directory)).isDirectory()).toBe(true);
    await writeFile(historyPath, history);
    await writeFile(definitionPath, "unrecognized service definition");
    expect(await pruneSupersededRuntimes(gatewayConfig, definitionPath)).toEqual({ retained: 0, removed: 0, failed: 1 });
    expect((await lstat(first.directory)).isDirectory()).toBe(true);
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", second.cliPath).content);
    let deep = first.directory;
    for (let depth = 0; depth < 33; depth += 1) deep = join(deep, "nested");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "keep"), "deep payload");
    expect(await pruneSupersededRuntimes(gatewayConfig, definitionPath)).toEqual({ retained: 1, removed: 0, failed: 1 });
    expect(await readFile(join(deep, "keep"), "utf8")).toBe("deep payload");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning bounds oversized payload traversal before renaming or removing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pruning-entry-bound-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    await activateRuntime(gatewayConfig, second);
    const definitionPath = join(root, "service.plist");
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", second.cliPath).content);
    for (let index = 0; index < 4_097; index += 1) {
      await writeFile(join(first.directory, `entry-${index}`), "synthetic payload");
    }
    const before = (await readdir(first.directory)).sort();
    expect(await pruneSupersededRuntimes(gatewayConfig, definitionPath)).toEqual({ retained: 1, removed: 0, failed: 1 });
    expect((await readdir(first.directory)).sort()).toEqual(before);
    expect(await currentInstalledRuntime(gatewayConfig)).toEqual(second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning finishes an interrupted marker at the traversal bound however many runtimes are staged", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pruning-marker-bound-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    for (const runtime of [first, second]) await activateRuntime(gatewayConfig, runtime);
    const definitionPath = join(root, "service.plist");
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", second.cliPath).content);
    // An interrupted removal whose own tree fits the bound must not depend on how many siblings
    // the versions root has gained since.
    const marker = join(dirname(second.directory), `.prune-${randomUUID()}`);
    await mkdir(marker);
    for (let index = 0; index < 4_094; index += 1) {
      await writeFile(join(marker, `entry-${index}`), "synthetic payload");
    }
    expect(await pruneSupersededRuntimes(gatewayConfig, definitionPath)).toEqual({ retained: 2, removed: 1, failed: 0 });
    expect(await readdir(dirname(second.directory))).not.toContain(basename(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes its own service runtime when the state path needs escaping", async () => {
  // Every service serializer escapes something: plist and task XML escape &<>", systemd uses JSON.
  const special = process.platform === "win32" ? "&" : `&<>"`;
  const root = await mkdtemp(join(tmpdir(), `gateway-escaped-${special}-`));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    for (const runtime of [first, second]) await activateRuntime(gatewayConfig, runtime);
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const definitionPath = join(root, `service-${platform}`);
      await writeFile(
        definitionPath,
        serviceDefinition(gatewayConfig, platform, second.cliPath, undefined, undefined, windowsUserSid).content,
      );
      const state = await activationState(gatewayConfig, definitionPath);
      expect({ platform, serviceVersion: state.serviceVersion, diverged: state.diverged }).toEqual({
        platform,
        serviceVersion: basename(second.directory),
        diverged: false,
      });
    }
    expect(await pruneSupersededRuntimes(gatewayConfig, join(root, "service-darwin"))).toEqual({
      retained: 2,
      removed: 0,
      failed: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages immutable content-addressed runtimes and atomically advances the current pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-installation-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const first = await stageRuntimePayload(gatewayConfig, source);
    expect(first.previous).toBeUndefined();
    expect(basename(first.directory)).toMatch(new RegExp(`^${GATEWAY_VERSION.replaceAll(".", "\\.")}-[0-9a-f]{12}$`, "u"));
    expect(first.readinessProtocol).toBe("instance-v1");
    expect(first.qualificationLogProtocol).toBe("structured-v1");
    expect((await lstat(first.cliPath)).isFile()).toBe(true);
    expect(await readdir(first.directory)).not.toContain("patches");
    expect((await lstat(join(first.directory, "bun.lock"))).isFile()).toBe(true);
    expect((await lstat(join(first.directory, "SBOM.spdx.json"))).isFile()).toBe(true);
    expect((await lstat(join(first.directory, "release-info.json"))).isFile()).toBe(true);
    expect(await currentInstalledRuntime(gatewayConfig)).toBeUndefined();

    await activateRuntime(gatewayConfig, first);
    expect(await currentInstalledRuntime(gatewayConfig)).toEqual({
      directory: first.directory,
      cliPath: first.cliPath,
      readinessProtocol: "instance-v1",
      qualificationLogProtocol: "structured-v1",
    });

    const duplicate = await stageRuntimePayload(gatewayConfig, source);
    expect(duplicate.directory).toBe(first.directory);
    expect(duplicate.previous?.directory).toBe(first.directory);

    await writeFile(source.cliSource, "console.log('replacement gateway');\n");
    const second = await stageRuntimePayload(gatewayConfig, source);
    expect(second.directory).not.toBe(first.directory);
    expect(second.previous?.directory).toBe(first.directory);
    await activateRuntime(gatewayConfig, second);
    expect((await currentInstalledRuntime(gatewayConfig))?.directory).toBe(second.directory);
    expect((await lstat(first.cliPath)).isFile()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a content-verified runtime installed by an older gateway version", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-installation-upgrade-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    const manifest = JSON.parse(await readFile(join(staged.directory, "installation.json"), "utf8")) as {
      sha256: string;
    };
    const priorDirectory = join(dirname(staged.directory), `0.0.9-${manifest.sha256.slice(0, 12)}`);
    await rename(staged.directory, priorDirectory);
    await writeFile(
      join(priorDirectory, "installation.json"),
      `${JSON.stringify({ version: "0.0.9", sha256: manifest.sha256 })}\n`,
    );
    const priorRuntime = {
      directory: priorDirectory,
      cliPath: join(priorDirectory, "apps", "gateway", "src", "cli.js"),
      readinessProtocol: "legacy" as const,
    };

    await activateRuntime(gatewayConfig, priorRuntime);
    expect(await currentInstalledRuntime(gatewayConfig)).toEqual(priorRuntime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback selects the activation recorded before the active one", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-select-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    await activateRuntime(gatewayConfig, first);
    await activateRuntime(gatewayConfig, second);
    // An idempotent re-install must not displace the predecessor with a duplicate entry.
    await activateRuntime(gatewayConfig, second);
    expect(await activationHistory(gatewayConfig)).toEqual([basename(first.directory), basename(second.directory)]);

    const automatic = await resolveRollbackTarget(gatewayConfig);
    expect(automatic.runtime.directory).toBe(first.directory);
    expect(automatic.from).toBe(basename(second.directory));
    expect(automatic.selection).toBe("recorded-predecessor");

    const explicit = await resolveRollbackTarget(gatewayConfig, basename(first.directory));
    expect(explicit.runtime).toEqual(automatic.runtime);
    expect(explicit.selection).toBe("requested");

    // "Previous" is the recorded order, so a second rollback returns to where the first started.
    await activateRuntime(gatewayConfig, automatic.runtime);
    expect((await resolveRollbackTarget(gatewayConfig)).runtime.directory).toBe(second.directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback refuses rather than guesses when the target is unusable", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-refuse-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);

    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow(/without an active installed runtime/u);

    await activateRuntime(gatewayConfig, first);
    await rm(second.directory, { recursive: true });
    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow(/only installed version/u);

    const restaged = await stageRuntimePayload(gatewayConfig, source);
    expect(restaged.directory).toBe(second.directory);
    await activateRuntime(gatewayConfig, restaged);

    await expect(resolveRollbackTarget(gatewayConfig, "0.1.0-000000000000")).rejects.toThrow(/is not installed/u);
    await expect(resolveRollbackTarget(gatewayConfig, basename(second.directory))).rejects.toThrow(
      /to the active version/u,
    );
    await expect(resolveRollbackTarget(gatewayConfig, "../../etc")).rejects.toThrow(/malformed version directory/u);

    // An install predating the activation history has no recorded predecessor. Falling back to
    // directory mtime would answer here; refusing and naming `--to` is the whole point.
    await rm(join(gatewayConfig.paths.stateDir, "installation", "history.json"));
    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow(/--to <version-directory>/u);
    expect((await resolveRollbackTarget(gatewayConfig, basename(first.directory))).runtime.directory).toBe(
      first.directory,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback leaves configuration and the publisher token untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-preserve-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    await mkdir(gatewayConfig.paths.configDir, { recursive: true, mode: 0o700 });
    // Synthetic and distinctive so a leak into the new installation metadata fails the assertion.
    const syntheticToken = "omp-synthetic-readiness-token-DO-NOT-SHIP-8f21c4";
    await writeFile(gatewayConfig.paths.configPath, '{"http":{"port":4317}}\n', { mode: 0o600 });
    await writeFile(gatewayConfig.paths.tokenPath, `${syntheticToken}\n`, { mode: 0o600 });
    const configDigest = await sha256(gatewayConfig.paths.configPath);
    const tokenDigest = await sha256(gatewayConfig.paths.tokenPath);
    const tokenMode = (await lstat(gatewayConfig.paths.tokenPath)).mode & 0o777;

    const { first, second } = await stageTwo(gatewayConfig, source);
    await activateRuntime(gatewayConfig, first);
    await activateRuntime(gatewayConfig, second);
    const target = await resolveRollbackTarget(gatewayConfig);
    await activateRuntime(gatewayConfig, target.runtime);
    expect((await currentInstalledRuntime(gatewayConfig))?.directory).toBe(first.directory);

    expect(await sha256(gatewayConfig.paths.configPath)).toBe(configDigest);
    expect(await sha256(gatewayConfig.paths.tokenPath)).toBe(tokenDigest);
    expect((await lstat(gatewayConfig.paths.tokenPath)).mode & 0o777).toBe(tokenMode);

    const installationRoot = join(gatewayConfig.paths.stateDir, "installation");
    for (const name of ["current.json", "history.json"]) {
      expect(await readFile(join(installationRoot, name), "utf8")).not.toContain(syntheticToken);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service-definition divergence from current.json is detected and repaired from the pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-diverge-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    const definitionPath = join(root, "service", "omp-session-gateway.plist");
    await mkdir(dirname(definitionPath), { recursive: true });

    await activateRuntime(gatewayConfig, second);
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", second.cliPath).content);
    expect(await activationState(gatewayConfig, definitionPath)).toEqual({
      pointerVersion: basename(second.directory),
      serviceVersion: basename(second.directory),
      serviceDefinitionPresent: true,
      diverged: false,
    });

    // The one reachable divergence: a crash between the definition write and the pointer write
    // leaves the definition naming the newer version while the pointer still names the proven one.
    await activateRuntime(gatewayConfig, first);
    expect(await activationState(gatewayConfig, definitionPath)).toEqual({
      pointerVersion: basename(first.directory),
      serviceVersion: basename(second.directory),
      serviceDefinitionPresent: true,
      diverged: true,
    });

    // Repair rewrites the definition from the runtime the pointer names, never the reverse.
    // `install` and `rollback` do this through `installUserService`, which drives the real service
    // manager; the rendered content it would write is identical to what is written here.
    expect((await currentInstalledRuntime(gatewayConfig))?.cliPath).toBe(first.cliPath);
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", first.cliPath).content);
    expect((await activationState(gatewayConfig, definitionPath)).diverged).toBe(false);

    // A definition naming a program outside this install's versions root is nobody's version.
    await writeFile(definitionPath, serviceDefinition(gatewayConfig, "darwin", join(root, "elsewhere", "cli.js")).content);
    expect(await activationState(gatewayConfig, definitionPath)).toEqual({
      pointerVersion: basename(first.directory),
      serviceVersion: undefined,
      serviceDefinitionPresent: true,
      diverged: true,
    });

    // Uninstall removes the definition and preserves the pointer; that is not divergence.
    await rm(definitionPath);
    expect(await activationState(gatewayConfig, definitionPath)).toEqual({
      pointerVersion: basename(first.directory),
      serviceVersion: undefined,
      serviceDefinitionPresent: false,
      diverged: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("divergence detection reads every platform's service-definition encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-encoding-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, staged);
    const definitionPath = join(root, "service", "definition");
    await mkdir(dirname(definitionPath), { recursive: true });

    // systemd quotes ExecStart argv with JSON string syntax; launchd XML-escapes plist strings.
    for (const platform of ["linux", "darwin"] as const) {
      await writeFile(definitionPath, serviceDefinition(gatewayConfig, platform, staged.cliPath).content);
      expect((await activationState(gatewayConfig, definitionPath)).serviceVersion).toBe(basename(staged.directory));
    }

    // Windows task XML is written as UTF-16LE with a BOM, exactly as `installUserService` encodes it.
    const taskXml = serviceDefinition(gatewayConfig, "win32", staged.cliPath, undefined, undefined, windowsUserSid).content;
    await writeFile(
      definitionPath,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml, "utf16le")]),
    );
    expect((await activationState(gatewayConfig, definitionPath)).serviceVersion).toBe(basename(staged.directory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an installed runtime whose payload no longer matches its manifest digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-payload-digest-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, staged);
    const asset = join(staged.directory, "apps", "web", "dist", "index.html");
    const original = await readFile(asset, "utf8");

    await writeFile(asset, `${original}<!-- injected -->`);
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow(
      "installed runtime payload failed its content hash",
    );
    // Restoring the exact bytes has to restore the runtime, or the detector is the act of writing
    // rather than the content, and the digest would be measuring nothing.
    await writeFile(asset, original);
    expect((await currentInstalledRuntime(gatewayConfig))?.directory).toBe(staged.directory);

    await rm(asset);
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow(
      "installed runtime payload failed its content hash",
    );
    await writeFile(asset, original);

    // An addition is as much a mismatch as a truncation: the digest covers the whole tree, so a
    // smuggled file cannot ride along inside an otherwise intact payload.
    await writeFile(join(staged.directory, "apps", "web", "dist", "smuggled.js"), "smuggled code");
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow(
      "installed runtime payload failed its content hash",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a payload entry that is not a regular file", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "gateway-payload-entry-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, staged);
    // A link inside the payload is content the digest cannot address: it names bytes that live
    // outside the tree and can change after the hash was computed.
    await symlink(join(staged.directory, "LICENSE"), join(staged.directory, "LICENSE.link"));
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow(
      "installed payload contains unsupported entry: LICENSE.link",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an installed gateway CLI that is a symlink out of the payload", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-link-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, staged);
    const elsewhere = join(root, "outside-cli.js");
    await writeFile(elsewhere, "console.log('elsewhere');\n");
    await rm(staged.cliPath);
    await symlink(elsewhere, staged.cliPath);
    // The CLI is checked as a path before the payload is hashed, so the program the service would
    // execute is refused by its own guard rather than incidentally by the digest.
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow("unsafe installed gateway CLI");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a runtime manifest that is unsafe, mismatched, or names an unknown readiness protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-manifest-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, staged);
    const manifestPath = join(staged.directory, "installation.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string; sha256: string };

    // The directory name is the version and the digest prefix, so a manifest that disagrees with it
    // is not this directory's manifest, whatever it claims.
    for (const document of [
      { ...manifest, sha256: "0".repeat(64) },
      { ...manifest, version: "0.1" },
      { version: manifest.version },
      { ...manifest, sha256: manifest.sha256.toUpperCase() },
    ]) {
      await writeFile(manifestPath, `${JSON.stringify(document)}\n`);
      await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow("invalid installed runtime manifest");
    }

    // An unrecognized protocol is not a legacy runtime: reading it as one would have a newer install
    // negotiate readiness the way an older gateway did.
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, readinessProtocol: "instance-v2" })}\n`);
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow(
      "invalid installed runtime readiness protocol",
    );

    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, qualificationLogProtocol: "structured-v2" })}\n`);
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow("invalid installed runtime qualification log protocol");
    const { qualificationLogProtocol: _protocol, ...legacy } = manifest as typeof manifest & { qualificationLogProtocol?: string };
    await writeFile(manifestPath, `${JSON.stringify(legacy)}\n`);
    expect((await currentInstalledRuntime(gatewayConfig))?.qualificationLogProtocol).toBeUndefined();

    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, padding: "x".repeat(1_024) })}\n`);
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow("unsafe installed runtime manifest");

    if (process.platform === "win32") return;
    await writeFile(join(root, "outside.json"), `${JSON.stringify(manifest)}\n`);
    await rm(manifestPath);
    await symlink(join(root, "outside.json"), manifestPath);
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow("unsafe installed runtime manifest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a current.json that is unsafe, malformed, or names a version that is gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pointer-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, staged);
    const pointerPath = join(gatewayConfig.paths.stateDir, "installation", "current.json");

    for (const document of [
      {},
      { versionDirectory: "../../etc" },
      { versionDirectory: "0.1.0-ZZZZZZZZZZZZ" },
      { versionDirectory: "0.1.0" },
      { versionDirectory: 42 },
    ]) {
      await writeFile(pointerPath, `${JSON.stringify(document)}\n`);
      await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow("invalid installed runtime pointer");
    }
    await writeFile(
      pointerPath,
      `${JSON.stringify({ versionDirectory: basename(staged.directory), padding: "x".repeat(1_024) })}\n`,
    );
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow("unsafe installed runtime pointer");

    // The partial upgrade an operator actually hits: the pointer survived, the payload did not.
    // Reporting "nothing is installed" here would invite a fresh install over a half-removed one, so
    // the missing directory is named instead.
    await writeFile(pointerPath, `${JSON.stringify({ versionDirectory: basename(staged.directory) })}\n`);
    await rm(staged.directory, { recursive: true });
    await expect(currentInstalledRuntime(gatewayConfig)).rejects.toThrow(staged.directory);
    // `status` still reports what the pointer claims: divergence detection is deliberately read-only
    // and does not validate payloads, so it stays answerable on a broken install.
    expect(await activationState(gatewayConfig, join(root, "service", "definition"))).toEqual({
      pointerVersion: basename(staged.directory),
      serviceVersion: undefined,
      serviceDefinitionPresent: false,
      diverged: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a corrupt activation history without bricking activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-history-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    await activateRuntime(gatewayConfig, first);
    await activateRuntime(gatewayConfig, second);
    const historyPath = join(gatewayConfig.paths.stateDir, "installation", "history.json");

    for (const document of [
      { activations: "0.1.0-000000000000" },
      { activations: ["0.1.0-000000000000", "nonsense"] },
      { activations: [basename(first.directory), 42] },
      { activations: Array.from({ length: 65 }, (_, index) => `0.0.1-${index.toString(16).padStart(12, "0")}`) },
      {},
    ]) {
      await writeFile(historyPath, `${JSON.stringify(document)}\n`);
      await expect(activationHistory(gatewayConfig)).rejects.toThrow("invalid installed runtime activation history");
    }
    // 4096 bytes is the retained-history ceiling; anything larger is not a history this wrote.
    await writeFile(
      historyPath,
      `${JSON.stringify({ activations: [basename(second.directory)], padding: "x".repeat(4_096) })}\n`,
    );
    await expect(activationHistory(gatewayConfig)).rejects.toThrow("unsafe installed runtime activation history");

    // History is advisory metadata, not authority. An unreadable one must not block an install; it
    // costs automatic predecessor selection once, and rollback then refuses instead of guessing.
    await writeFile(historyPath, "not json\n");
    await activateRuntime(gatewayConfig, first);
    expect(await activationHistory(gatewayConfig)).toEqual([basename(first.directory)]);
    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow(
      `no activation is recorded before ${basename(first.directory)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds the retained activation history and evicts its oldest entry first", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-history-window-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, staged);
    const historyPath = join(gatewayConfig.paths.stateDir, "installation", "history.json");
    const filler = Array.from({ length: 64 }, (_, index) => `0.0.1-${index.toString(16).padStart(12, "0")}`);

    await writeFile(historyPath, `${JSON.stringify({ activations: filler })}\n`);
    expect((await activationHistory(gatewayConfig)).length).toBe(64);
    await activateRuntime(gatewayConfig, staged);
    const history = await activationHistory(gatewayConfig);
    // The window keeps the recent end: dropping the newest would make rollback target an activation
    // older than the one it just moved away from.
    expect(history.length).toBe(64);
    expect(history[0]).toBe(filler[1]);
    expect(history[63]).toBe(basename(staged.directory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to activate a runtime outside the versions root or with a foreign CLI path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-activate-trust-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    const versions = dirname(first.directory);

    for (const runtime of [
      { ...first, directory: join(root, "elsewhere", basename(first.directory)) },
      { ...first, directory: join(versions, "staging-copy") },
      { ...first, directory: join(versions, "0.1.0-nothex000000") },
    ]) {
      await expect(activateRuntime(gatewayConfig, runtime)).rejects.toThrow(
        "refusing to activate an untrusted runtime path",
      );
    }

    // The pointer names a directory, but the service executes a path. Both have to belong to the
    // runtime being activated, or the service would run one version's CLI against another's payload.
    await expect(activateRuntime(gatewayConfig, { ...second, cliPath: first.cliPath })).rejects.toThrow(
      "refusing to activate an untrusted gateway CLI path",
    );
    await expect(
      activateRuntime(gatewayConfig, { ...second, cliPath: join(second.directory, "cli.js") }),
    ).rejects.toThrow("refusing to activate an untrusted gateway CLI path");

    // No refusal may have advanced the pointer partway.
    expect(await currentInstalledRuntime(gatewayConfig)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a version directory that is a symlink or not a directory", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "gateway-version-shape-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    const versions = dirname(staged.directory);

    // The content behind the link is genuine, which is the point: a version directory is trusted for
    // being a directory in the versions root, not for what it happens to resolve to today.
    const alias = join(versions, "0.1.0-aaaaaaaaaaaa");
    await symlink(staged.directory, alias);
    await expect(
      activateRuntime(gatewayConfig, { ...staged, directory: alias, cliPath: join(alias, "apps", "gateway", "src", "cli.js") }),
    ).rejects.toThrow("unsafe installed runtime directory");

    const impostor = join(versions, "0.1.0-bbbbbbbbbbbb");
    await writeFile(impostor, "not a runtime\n");
    await expect(
      activateRuntime(gatewayConfig, { ...staged, directory: impostor, cliPath: join(impostor, "cli.js") }),
    ).rejects.toThrow("unsafe installed runtime directory");
    expect(await currentInstalledRuntime(gatewayConfig)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages without the optional release metadata, and a failed staging leaves nothing behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-staging-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const optional = ["package.json", "release-info.json", "SBOM.spdx.json"];
    for (const name of optional) await rm(join(source.sourceRoot, name));

    const staged = await stageRuntimePayload(gatewayConfig, source);
    for (const name of optional) expect(await Bun.file(join(staged.directory, name)).exists()).toBe(false);
    await activateRuntime(gatewayConfig, staged);
    expect((await currentInstalledRuntime(gatewayConfig))?.directory).toBe(staged.directory);

    // A required file is not optional, and the abandoned staging directory must not survive the
    // failure: a half-copied tree in the versions root is indistinguishable from a runtime by name.
    await rm(join(source.sourceRoot, "bun.lock"));
    await expect(stageRuntimePayload(gatewayConfig, source)).rejects.toThrow("bun.lock");
    expect(await readdir(dirname(staged.directory))).toEqual([basename(staged.directory)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prefers a prepared collab-web licence over promoting the upstream copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-licenses-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    // Without a prepared licence the upstream copy is promoted into its place, and the upstream tree
    // it was taken from is not shipped at all — not even as the empty skeleton the promotion leaves.
    expect(await readFile(join(staged.directory, "licenses", "collab-web", "LICENSE"), "utf8")).toBe(
      "synthetic collab license",
    );
    expect(await readdir(staged.directory)).not.toContain("packages");

    await mkdir(join(source.sourceRoot, "licenses", "collab-web"), { recursive: true });
    await writeFile(join(source.sourceRoot, "licenses", "collab-web", "LICENSE"), "prepared collab license");
    const prepared = await stageRuntimePayload(gatewayConfig, source);
    expect(prepared.directory).not.toBe(staged.directory);
    expect(await readFile(join(prepared.directory, "licenses", "collab-web", "LICENSE"), "utf8")).toBe(
      "prepared collab license",
    );
    expect(await readdir(prepared.directory)).not.toContain("packages");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiles a TypeScript CLI source into the executable it installs", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-build-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const cliSource = join(source.sourceRoot, "cli.ts");
    await writeFile(cliSource, "const greeting: string = 'installed gateway';\nconsole.log(greeting);\n");

    const staged = await stageRuntimePayload(gatewayConfig, { sourceRoot: source.sourceRoot, cliSource });
    expect(basename(staged.cliPath)).toBe("cli.js");
    // The installed payload has to be runnable JavaScript: a copied TypeScript entrypoint would only
    // fail once the service manager tried to launch it.
    expect(await readFile(staged.cliPath, "utf8")).not.toContain(": string");
    if (process.platform !== "win32") expect((await lstat(staged.cliPath)).mode & 0o777).toBe(0o700);
    const run = Bun.spawn([process.execPath, staged.cliPath], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([run.exited, new Response(run.stdout).text()]);
    expect({ code, stdout: stdout.trim() }).toEqual({ code: 0, stdout: "installed gateway" });

    await activateRuntime(gatewayConfig, staged);
    expect((await currentInstalledRuntime(gatewayConfig))?.cliPath).toBe(staged.cliPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("refuses an unsafe service definition and reads one at exactly the size limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-definition-shape-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const staged = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, staged);
    const definitionPath = join(root, "service", "definition");
    await mkdir(dirname(definitionPath), { recursive: true });
    const rendered = serviceDefinition(gatewayConfig, "darwin", staged.cliPath).content;
    const padding = 16_384 - Buffer.byteLength(rendered);
    expect(padding).toBeGreaterThan(0);

    await writeFile(definitionPath, `${rendered}${" ".repeat(padding)}`);
    expect((await activationState(gatewayConfig, definitionPath)).serviceVersion).toBe(basename(staged.directory));
    await writeFile(definitionPath, `${rendered}${" ".repeat(padding + 1)}`);
    await expect(activationState(gatewayConfig, definitionPath)).rejects.toThrow("unsafe gateway service definition");

    if (process.platform === "win32") return;
    await writeFile(join(root, "elsewhere.plist"), rendered);
    await rm(definitionPath);
    await symlink(join(root, "elsewhere.plist"), definitionPath);
    await expect(activationState(gatewayConfig, definitionPath)).rejects.toThrow("unsafe gateway service definition");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback refuses when the recorded predecessor is no longer installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-missing-"));
  try {
    const gatewayConfig = config(root);
    const source = await sourceFixture(root);
    const { first, second } = await stageTwo(gatewayConfig, source);
    await writeFile(source.cliSource, "console.log('third gateway');\n");
    const third = await stageRuntimePayload(gatewayConfig, source);
    await activateRuntime(gatewayConfig, first);
    await activateRuntime(gatewayConfig, second);
    await rm(first.directory, { recursive: true });

    // Two versions are still installed, so this is not the "no predecessor is retained" refusal. The
    // recorded predecessor is simply gone, and a version that was never active is not a substitute.
    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow(
      `recorded predecessor ${basename(first.directory)} is no longer installed`,
    );
    const requested = await resolveRollbackTarget(gatewayConfig, basename(third.directory));
    expect(requested.selection).toBe("requested");
    expect(requested.runtime.directory).toBe(third.directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback refuses on a pointer whose versions root holds no candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-rollback-empty-"));
  try {
    const gatewayConfig = config(root);
    const installation = join(gatewayConfig.paths.stateDir, "installation");
    await mkdir(installation, { recursive: true, mode: 0o700 });
    await writeFile(
      join(installation, "current.json"),
      `${JSON.stringify({ versionDirectory: "0.1.0-000000000000" })}\n`,
    );
    // A wiped versions root reads as nothing installed rather than failing on its absence.
    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow("is the only installed version");

    // Entries that are not content-addressed version directories are not rollback candidates.
    const versions = join(installation, "versions");
    await mkdir(join(versions, "not-a-version"), { recursive: true, mode: 0o700 });
    await writeFile(join(versions, "0.1.0-000000000001"), "a file, not a version directory\n");
    await expect(resolveRollbackTarget(gatewayConfig)).rejects.toThrow("is the only installed version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
