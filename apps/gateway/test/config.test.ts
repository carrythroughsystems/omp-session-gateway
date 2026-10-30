import { afterEach, describe, expect, test as bunTest, vi } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  type ConfigOverrides,
  type GatewayConfig,
  FLEET_CONFIG_SINCE_VERSION,
  assertReadinessTokenPrivate,
  captureGatewayConfigFile,
  defaultGatewayPaths,
  ensureRuntimeDirectories,
  loadGatewayConfig,
  loadOrCreateReadinessToken,
  loadReadinessToken,
  readinessTokenMatches,
  publicOriginHttpsPort,
  projectPreFleetConfig,
  projectPreTernConfig,
  parseTernConfig,
  readPrivateTextFile,
  removeLegacyPublisherToken,
  restoreGatewayConfigFile,
  rotateReadinessToken,
  stopWindowsAclHelper,
  writeGatewayConfigFile,
  writePrivateTextFile,
} from "../src/config.ts";
import { HANG_DEADLINE_MS } from "../../../scripts/test-support.ts";

const roots: string[] = [];
// A cold helper gets two attempts of 45 s plus stderr teardown; warm replies keep their 10 s
// product deadline. Bun must not delete a fixture while that bounded request is still in flight.
const WINDOWS_CONFIG_TEST_TIMEOUT_MS = 2 * HANG_DEADLINE_MS;

function test(name: string, body: () => void | Promise<void>, timeout?: number): void {
  // Apply to every sibling, including explicit 20/30 s cases and isolated --test-name-pattern runs.
  // Keep native Bun defaults and each authored timeout unchanged on non-Windows hosts.
  bunTest(name, body, process.platform === "win32" ? WINDOWS_CONFIG_TEST_TIMEOUT_MS : timeout);
}

describe("opt-in Tern configuration", () => {
  const profile = { id: "local", label: " OMP ", argv: ["/synthetic/omp", "--flag"],
    env: { HOME: "/synthetic/home", PATH: "/synthetic/bin:/usr/bin:/bin" } };
  const tern = { executable: "/synthetic/tern", projects: [{ id: "project", label: " Project ",
    workingCopies: [{ id: "main", label: "Main", path: "/synthetic/work" }] }], profiles: [profile] };
  test("preserves absence and authored empty sections without manufacturing execution defaults", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writePrivateTextFile(path, JSON.stringify({ auth: { mode: "dev-localhost" } }));
    expect((await loadGatewayConfig({ configPath: path })).tern).toBeUndefined();
    await writePrivateTextFile(path, JSON.stringify({ auth: { mode: "dev-localhost" }, tern: {} }));
    expect((await loadGatewayConfig({ configPath: path })).tern).toEqual({});
    expect(parseTernConfig(tern).profiles?.[0]?.label).toBe("OMP");
  });
  test("rejects unknown/null execution fields, aliases, duplicate IDs, env and size overflows without echo", () => {
    const secret = "TERN_CONFIG_SECRET_CANARY";
    for (const value of [null, { ...tern, [secret]: true }, { ...tern, executable: "relative" },
      { ...tern, executable: "/bad\0path" }, { ...tern, projects: [] }, { ...tern, profiles: [profile, profile] },
      { ...tern, profiles: [{ ...profile, env: { PATH: "/bin" } }] },
      { ...tern, profiles: [{ ...profile, env: { HOME: "/home", PATH: `/bin${delimiter}` } }] },
      { ...tern, profiles: [{ ...profile, env: { HOME: "/home", PATH: "relative" } }] },
      { ...tern, profiles: [{ ...profile, env: { ...profile.env, lowercase: secret } }] },
      { ...tern, profiles: [{ ...profile, argv: ["/omp", "x".repeat(1025)] }] },
      { ...tern, profiles: [{ ...profile, argv: Array.from({ length: 33 }, () => "/omp") }] },
      { ...tern, profiles: [{ ...profile, argv: Array.from({ length: 10 }, () => "x".repeat(1000)).map((x, i) => i === 0 ? "/omp" : x) }] },
      { ...tern, profiles: [{ ...profile, env: { ...profile.env, LONG: "x".repeat(1025) } }] },
      { ...tern, profiles: [{ ...profile, env: { ...profile.env, ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`E${i}`, "x"])) } }] },
      { ...tern, profiles: [{ ...profile, env: { ...profile.env, ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`E${i}`, "x".repeat(1000)])) } }] },
      { ...tern, projects: Array.from({ length: 17 }, (_, i) => ({ ...tern.projects[0], id: `p${i}` })) },
      { ...tern, profiles: Array.from({ length: 9 }, (_, i) => ({ ...profile, id: `p${i}` })) },
      { ...tern, projects: [{ ...tern.projects[0], workingCopies: Array.from({ length: 9 }, (_, i) => ({ id: `w${i}`, label: "W", path: "/work" })) }] },
      { ...tern, projects: [{ ...tern.projects[0], workingCopies: [{ id: "main", label: "Main", path: null }] }] },
    ]) {
      expect(() => parseTernConfig(value)).toThrow("invalid tern configuration");
      try { parseTernConfig(value); } catch (error) { expect(String(error)).not.toContain(secret); }
    }
  });
  test("rollback removes only Tern and composes with legacy fleet/speech projection", () => {
    const document = { tern, fleet: {}, speech: {}, omp: { discoveryDir: "/synthetic/discovery" }, http: { trustedDashboardOrigins: [] } };
    const current = projectPreTernConfig(document);
    expect(current.removedKeys).toEqual(["tern"]);
    expect(current.document).toEqual({ fleet: {}, speech: {}, omp: document.omp, http: document.http });
    expect(projectPreFleetConfig(current.document).document).toEqual({ omp: document.omp, http: {} });
    expect(document.tern).toBe(tern);
  });
  test("directory-synced publication retains private file mode and refuses unsafe publication", async () => {
    const root = await privateRoot();
    const path = join(root, "ledger.json");
    await writePrivateTextFile(path, "first", { syncDirectory: true });
    expect(await readPrivateTextFile(path, 100)).toBe("first");
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(writePrivateTextFile(path, "second", { exclusive: true, syncDirectory: true })).rejects.toThrow();
    expect(await readPrivateTextFile(path, 100)).toBe("first");
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

function configForRoot(root: string): GatewayConfig {
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

function windowsPowerShellEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toLowerCase() !== "psmodulepath") environment[key] = value;
  }
  return { ...environment, ...overrides };
}

async function secureWindowsFixture(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  // The same write `apply` makes: a fresh descriptor through `SetAccessControl`, never `Set-Acl`,
  // whose retry for a token without SeSecurityPrivilege fails once the file's DACL is protected.
  const script =
    "$Path=$env:OMP_GATEWAY_ACL_PATH; " +
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
    "$security=[System.Security.AccessControl.FileSecurity]::new(); " +
    "$security.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;SY)(A;;FA;;;'+$sid+')',[System.Security.AccessControl.AccessControlSections]::Access); " +
    "$security.SetOwner([System.Security.Principal.SecurityIdentifier]::new($sid)); " +
    "[System.IO.File]::SetAccessControl($Path,$security)";
  const subprocess = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: windowsPowerShellEnvironment({ OMP_GATEWAY_ACL_PATH: path }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(subprocess.stderr).text();
  if ((await subprocess.exited) !== 0) throw new Error(`failed to secure test fixture: ${stderr.trim()}`);
}

async function makeFixtureUnsafe(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    return;
  }
  const subprocess = Bun.spawn(["icacls.exe", path, "/grant", "*S-1-1-0:F"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(subprocess.stderr).text();
  if ((await subprocess.exited) !== 0) throw new Error(`failed to loosen test fixture ACL: ${stderr.trim()}`);
}

type ConfigPatch = {
  readonly http?: Record<string, unknown>;
  readonly auth?: Record<string, unknown>;
  readonly registry?: Record<string, unknown>;
};

async function configFixture(text: string): Promise<string> {
  const path = join(await privateRoot(), "config.json");
  await writeFile(path, text, { mode: 0o600 });
  await secureWindowsFixture(path);
  return path;
}

async function loadDocument(document: unknown, overrides: ConfigOverrides = {}): Promise<GatewayConfig> {
  return loadGatewayConfig({ ...overrides, configPath: await configFixture(JSON.stringify(document)) });
}

function serveDocument(patch: ConfigPatch = {}): Record<string, unknown> {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net", ...patch.http },
    auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"], ...patch.auth },
  };
}

function devDocument(patch: ConfigPatch = {}): Record<string, unknown> {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317", ...patch.http },
    auth: { mode: "dev-localhost", allowedLogins: [], ...patch.auth },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 10, ...patch.registry },
  };
}

const FAKE_CURRENT_SID = "S-1-5-21-2000000000-2000000001-2000000002-1001";
const FULL_CONTROL_MASK = 2_032_127;

type FakeAclOutcome = "private" | "foreign-principal" | "missing";

const fakeAcl = {
  spawns: 0,
  requests: [] as string[],
  outcomes: new Map<string, FakeAclOutcome>(),
  desynchronise: false,
  stderr: "",
  exitBeforeReply: false,
  /** Dies on the next request only, so a retry meets a working helper. */
  exitBeforeReplyOnce: false,
  /** Delays each process's first reply, as PowerShell's cold start does. */
  firstReplyDelayMs: 0,
  dropReplies: false,
  kills: 0,
  /** Called as each request reaches the helper, so a test can act at that moment. */
  onRequest: undefined as (() => void) | undefined,
};

function answerFakeAclRequest(line: string): string {
  const request = JSON.parse(line) as { readonly i: number; readonly op: string; readonly p: string; readonly dir: number };
  fakeAcl.requests.push(`${request.op} ${request.p}`);
  const identifier = fakeAcl.desynchronise ? request.i + 1 : request.i;
  const outcome = fakeAcl.outcomes.get(request.p) ?? "private";
  if (outcome === "missing") {
    return JSON.stringify({ i: identifier, ok: false, e: `Cannot find path '${request.p}' because it does not exist.` });
  }
  if (request.op === "apply") return JSON.stringify({ i: identifier, ok: true });
  const flags = request.dir === 1 ? 3 : 0;
  const rules = [
    { Sid: "S-1-5-18", Type: "AccessAllowed", Mask: FULL_CONTROL_MASK, Flags: flags },
    { Sid: FAKE_CURRENT_SID, Type: "AccessAllowed", Mask: FULL_CONTROL_MASK, Flags: flags },
  ];
  // Mirrors `icacls /grant *S-1-1-0:F`, which is how the real fixtures above are loosened.
  if (outcome === "foreign-principal") {
    rules.push({ Sid: "S-1-1-0", Type: "AccessAllowed", Mask: FULL_CONTROL_MASK, Flags: flags });
  }
  return JSON.stringify({
    i: identifier,
    ok: true,
    acl: { Protected: true, Current: FAKE_CURRENT_SID, Owner: FAKE_CURRENT_SID, Rules: rules },
  });
}

/**
 * Stands in for `powershell.exe` speaking the ACL helper's newline-delimited JSON protocol, so the
 * Windows-only contract can be exercised on every platform. Spawns of anything else pass through.
 * Returns the restore function; call it in a `finally` so a failure cannot leak the fake platform.
 */
function installFakePowerShell(): () => void {
  const realSpawn = Bun.spawn;
  const realPlatform = process.platform;
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, "platform", { value, writable: true, configurable: true, enumerable: true });
  };
  const fakeSpawn = (command: readonly string[], options?: unknown): unknown => {
    if (command[0] !== "powershell.exe") {
      return (realSpawn as unknown as (used: readonly string[], rest?: unknown) => unknown)(command, options);
    }
    fakeAcl.spawns += 1;
    const encoder = new TextEncoder();
    const pending: Uint8Array[] = [];
    let waiting: ((result: { value?: Uint8Array; done: boolean }) => void) | undefined;
    let stdin = "";
    // Death belongs to this process, not to the harness: a helper that dies stays dead, and the
    // next spawn is a live one. A one-shot flag consumed globally would instead leave the reader
    // waiting on a process nobody marked dead.
    let dead = false;
    let replied = false;
    const delayedReplies = new Set<ReturnType<typeof setTimeout>>();
    const deliver = (reply: Uint8Array): void => {
      if (dead) return;
      const resolve = waiting;
      waiting = undefined;
      if (resolve === undefined) pending.push(reply);
      else resolve({ value: reply, done: false });
    };
    return {
      stdin: {
        write: (chunk: string): number => {
          stdin += chunk;
          return chunk.length;
        },
        flush: (): number => {
          for (;;) {
            const newline = stdin.indexOf("\n");
            if (newline < 0) return 0;
            const line = stdin.slice(0, newline);
            stdin = stdin.slice(newline + 1);
            // A helper that died during start-up consumes the request and answers nothing; its
            // stdout closes instead, which the reader below reports as EOF. `once` models the
            // realistic transient: this process is gone, the next one works.
            if (fakeAcl.exitBeforeReply || fakeAcl.exitBeforeReplyOnce) {
              fakeAcl.exitBeforeReplyOnce = false;
              dead = true;
              const closed = waiting;
              waiting = undefined;
              closed?.({ done: true });
              continue;
            }
            const reply = encoder.encode(`${answerFakeAclRequest(line)}\n`);
            fakeAcl.onRequest?.();
            const delay = replied ? 0 : fakeAcl.firstReplyDelayMs;
            replied = true;
            if (fakeAcl.dropReplies) continue;
            if (delay > 0) {
              const timer = setTimeout(() => {
                delayedReplies.delete(timer);
                deliver(reply);
              }, delay);
              delayedReplies.add(timer);
            }
            else deliver(reply);
          }
        },
      },
      stdout: {
        getReader: () => ({
          read: async (): Promise<{ value?: Uint8Array; done: boolean }> => {
            const next = pending.shift();
            if (next !== undefined) return { value: next, done: false };
            // A helper that dies without answering closes its stdout, which the reader sees as EOF.
            if (dead || fakeAcl.exitBeforeReply) return { done: true };
            const gate = Promise.withResolvers<{ value?: Uint8Array; done: boolean }>();
            waiting = gate.resolve;
            return await gate.promise;
          },
        }),
      },
      // The real helper writes start-up and parse failures only to stderr, so the fake has to offer
      // the same channel or a test can never observe that they reach the caller.
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          if (fakeAcl.stderr.length > 0) controller.enqueue(new TextEncoder().encode(fakeAcl.stderr));
          controller.close();
        },
      }),
      ref: (): undefined => undefined,
      unref: (): undefined => undefined,
      kill: (): void => {
        fakeAcl.kills += 1;
        dead = true;
        for (const timer of delayedReplies) clearTimeout(timer);
        delayedReplies.clear();
        pending.length = 0;
        const closed = waiting;
        waiting = undefined;
        closed?.({ done: true });
      },
    };
  };
  Bun.spawn = fakeSpawn as unknown as typeof Bun.spawn;
  setPlatform("win32");
  // On Windows the preceding tests spawn a real `powershell.exe` helper and `config.ts` caches it.
  // Swapping `Bun.spawn` does not reach that live process, so every request below would be answered
  // by the real helper and none of the fake's outcomes would be observable. Evict it explicitly.
  stopWindowsAclHelper();
  return () => {
    Bun.spawn = realSpawn;
    setPlatform(realPlatform);
    // Symmetrically, never leave the fake cached for a real Windows test that follows.
    stopWindowsAclHelper();
    fakeAcl.outcomes.clear();
    fakeAcl.desynchronise = false;
    fakeAcl.stderr = "";
    fakeAcl.exitBeforeReply = false;
    fakeAcl.exitBeforeReplyOnce = false;
    fakeAcl.firstReplyDelayMs = 0;
    fakeAcl.dropReplies = false;
    fakeAcl.onRequest = undefined;
  };
}

/**
 * Pins the desynchronisation guard: an out-of-order reply is fatal and makes `config.ts` drop the
 * helper. `installFakePowerShell` has already evicted any cached process, so the helper this
 * discards is always the fake — which is what makes the following spawn count exact on every
 * platform, including a real Windows host.
 */
async function dropCachedAclHelper(config: GatewayConfig): Promise<void> {
  fakeAcl.desynchronise = true;
  try {
    await expect(loadOrCreateReadinessToken(config)).rejects.toThrow("answered out of order");
  } finally {
    fakeAcl.desynchronise = false;
  }
}

describe("secure config", () => {
  test("loads strict production config and normalizes exact allowlist logins", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: [" User@Example.COM "] },
        registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 25 },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    const loaded = await loadGatewayConfig({ configPath: path });
    expect(loaded.auth.allowedLogins).toEqual(["user@example.com"]);
    expect(loaded.http.hostname).toBe("127.0.0.1");
  });

  test("rejects an HTTP public origin in production mode", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    await expect(loadGatewayConfig({ configPath: path })).rejects.toThrow("HTTPS");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    await expect(
      loadGatewayConfig({ configPath: path, publicOrigin: "http://gateway.example.ts.net" }),
    ).rejects.toThrow("HTTPS");
  });

  test("requires an exact configured loopback origin in development mode", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "::1", port: 4318, publicOrigin: "http://[::1]:4318" },
        auth: { mode: "dev-localhost", allowedLogins: [] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    const loaded = await loadGatewayConfig({ configPath: path });
    expect(loaded.http.publicOrigin).toBe("http://[::1]:4318");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "dev-localhost", allowedLogins: [] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    await expect(loadGatewayConfig({ configPath: path })).rejects.toThrow("loopback HTTP origin");
  });

  test("synthesizes a matching local origin for development mode and port overrides", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: ["allowed@example.com"] },
      }),
      { mode: 0o600 },
    );
    await secureWindowsFixture(path);
    const loaded = await loadGatewayConfig({ configPath: path, mode: "dev-localhost", port: 4319 });
    expect(loaded.http.port).toBe(4319);
    expect(loaded.http.publicOrigin).toBe("http://127.0.0.1:4319");
    expect(loaded.auth.mode).toBe("dev-localhost");
  });

  test("derives the configured external HTTPS port", () => {
    expect(publicOriginHttpsPort("https://gateway.example.ts.net")).toBe(443);
    expect(publicOriginHttpsPort("https://gateway.example.ts.net:8443")).toBe(8443);
  });

  test("restores existing and absent config snapshots", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(path, "original\n", { mode: 0o600 });
    await secureWindowsFixture(path);
    const existing = await captureGatewayConfigFile(path);
    await writeFile(path, "replacement\n", { mode: 0o600 });
    await restoreGatewayConfigFile(existing);
    expect(await readFile(path, "utf8")).toBe("original\n");
    await rm(path);
    const absent = await captureGatewayConfigFile(path);
    await writeFile(path, "created\n", { mode: 0o600 });
    await restoreGatewayConfigFile(absent);
    expect(await Bun.file(path).exists()).toBe(false);
  }, 20_000);

  test("rejects permissive and symlinked config files", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    await writeFile(path, "{}", { mode: 0o644 });
    await makeFixtureUnsafe(path);
    await expect(loadGatewayConfig({ configPath: path, mode: "dev-localhost" })).rejects.toThrow("unsafe");
    await rm(path);
    const target = join(root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, path);
    await expect(loadGatewayConfig({ configPath: path, mode: "dev-localhost" })).rejects.toThrow("unsafe");
  });

  test("creates and rotates a private 256-bit readiness token without printing it", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const first = await loadOrCreateReadinessToken(config);
    const file = await lstat(config.paths.tokenPath);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(file.isFile()).toBeTrue();
    if (process.platform !== "win32") expect(file.mode & 0o077).toBe(0);
    expect(await loadOrCreateReadinessToken(config)).toBe(first);
    const second = await rotateReadinessToken(config);
    expect(await loadOrCreateReadinessToken(config)).toBe(second);
    expect(second).not.toBe(first);
    expect(readinessTokenMatches(second, second)).toBeTrue();
    expect(readinessTokenMatches(second, `${second}x`)).toBeFalse();
    expect(readinessTokenMatches(second, first)).toBeFalse();
  }, 20_000);

  test("rotation remediates an unsafe token leaf without following it", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    await mkdir(config.paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(config.paths.tokenPath, `${"A".repeat(43)}\n`, { mode: 0o644 });
    await makeFixtureUnsafe(config.paths.tokenPath);
    await expect(loadOrCreateReadinessToken(config)).rejects.toThrow("unsafe");
    const rotated = await rotateReadinessToken(config);
    expect(await loadOrCreateReadinessToken(config)).toBe(rotated);
    const file = await lstat(config.paths.tokenPath);
    expect(file.isFile()).toBeTrue();
    if (process.platform !== "win32") expect(file.mode & 0o077).toBe(0);
  }, 20_000);

  test("rotation replaces a token symlink without modifying its target", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const config = configForRoot(root);
    await mkdir(config.paths.configDir, { recursive: true, mode: 0o700 });
    const target = join(root, "external-token");
    const original = `${"A".repeat(43)}\n`;
    await writeFile(target, original, { mode: 0o600 });
    await symlink(target, config.paths.tokenPath);
    const rotated = await rotateReadinessToken(config);
    expect(await loadOrCreateReadinessToken(config)).toBe(rotated);
    expect(await Bun.file(target).text()).toBe(original);
    expect((await lstat(config.paths.tokenPath)).isSymbolicLink()).toBeFalse();
  });

  test("rejects oversized private config and readiness-token files before parsing", async () => {
    const root = await privateRoot();
    const configPath = join(root, "oversized-config.json");
    await writeFile(configPath, " ".repeat(64 * 1_024 + 1), { mode: 0o600 });
    await secureWindowsFixture(configPath);
    await expect(loadGatewayConfig({ configPath, mode: "dev-localhost" })).rejects.toThrow("size limit");

    const config = configForRoot(root);
    await loadOrCreateReadinessToken(config);
    await writeFile(config.paths.tokenPath, "A".repeat(46), { mode: 0o600 });
    await secureWindowsFixture(config.paths.tokenPath);
    await expect(loadOrCreateReadinessToken(config)).rejects.toThrow("invalid encoding or length");
  }, 20_000);
});

describe("auth mode admission", () => {
  test("serve mode accepts an external origin whose port is not the listener port", async () => {
    const loaded = await loadDocument(serveDocument({ http: { publicOrigin: "https://gateway.example.ts.net:8443" } }));
    expect(loaded.http.publicOrigin).toBe("https://gateway.example.ts.net:8443");
    expect(loaded.http.port).toBe(4317);
    expect(publicOriginHttpsPort(loaded.http.publicOrigin)).toBe(8443);
  });

  test("serve mode refuses an origin carrying a path, a trailing slash, or a redundant default port", async () => {
    for (const publicOrigin of [
      "https://gateway.example.ts.net/gw",
      "https://gateway.example.ts.net/",
      "https://gateway.example.ts.net:443",
    ]) {
      await expect(loadDocument(serveDocument({ http: { publicOrigin } }))).rejects.toThrow(
        "http.publicOrigin must be an exact HTTP(S) origin",
      );
    }
  }, 20_000);

  test("an inexact public origin override is refused after the file itself parses", async () => {
    await expect(loadDocument(serveDocument(), { publicOrigin: "https://gateway.example.ts.net/gw" })).rejects.toThrow(
      "http.publicOrigin must be an exact URL origin",
    );
  });

  test("serve mode refuses an empty allowlist from the file and from a mode override", async () => {
    await expect(loadDocument(serveDocument({ auth: { allowedLogins: [] } }))).rejects.toThrow(
      "tailscale-serve mode requires at least one allowed login",
    );
    await expect(
      loadDocument(devDocument(), { mode: "tailscale-serve", publicOrigin: "https://gateway.example.ts.net" }),
    ).rejects.toThrow("tailscale-serve mode requires at least one allowed login");
    const promoted = await loadDocument(devDocument({ auth: { allowedLogins: ["user@example.com"] } }), {
      mode: "tailscale-serve",
      publicOrigin: "https://gateway.example.ts.net",
    });
    expect(promoted.auth.mode).toBe("tailscale-serve");
    expect(promoted.http.publicOrigin).toBe("https://gateway.example.ts.net");
  }, 20_000);

  test("dev mode refuses an origin whose port or host disagrees with the listener", async () => {
    await expect(loadDocument(devDocument({ http: { publicOrigin: "http://127.0.0.1:4318" } }))).rejects.toThrow(
      "dev-localhost mode requires the configured loopback HTTP origin",
    );
    await expect(
      loadDocument(devDocument({ http: { hostname: "::1", publicOrigin: "http://127.0.0.1:4317" } })),
    ).rejects.toThrow("dev-localhost mode requires the configured loopback HTTP origin");
    const loaded = await loadDocument(devDocument({ http: { port: 4319, publicOrigin: "http://127.0.0.1:4319" } }));
    expect(loaded.http.publicOrigin).toBe("http://127.0.0.1:4319");
    expect(loaded.http.port).toBe(4319);
  }, 20_000);

  test("a dev-mode port override moves the public origin, and an explicit origin must agree with it", async () => {
    const configPath = await configFixture(JSON.stringify(devDocument()));
    const moved = await loadGatewayConfig({ configPath, port: 4321 });
    expect(moved.http.port).toBe(4321);
    expect(moved.http.publicOrigin).toBe("http://127.0.0.1:4321");
    await expect(
      loadGatewayConfig({ configPath, port: 4321, publicOrigin: "http://127.0.0.1:4317" }),
    ).rejects.toThrow("dev-localhost mode requires the configured loopback HTTP origin");
  });

  test("an override port stays inside the port range", async () => {
    const configPath = await configFixture(JSON.stringify(devDocument()));
    expect((await loadGatewayConfig({ configPath, port: 65_535 })).http.port).toBe(65_535);
    for (const port of [0, 65_536]) {
      await expect(loadGatewayConfig({ configPath, port })).rejects.toThrow(
        "http.port must be an integer from 1 to 65535",
      );
    }
  });

  test("refuses an unrecognized auth mode instead of falling back to a default", async () => {
    await expect(loadDocument(devDocument({ auth: { mode: "dev" } }))).rejects.toThrow("invalid auth.mode");
  });

  test("an absent config file yields dev defaults but never a serve-mode gateway", async () => {
    const configPath = join(await privateRoot(), "absent.json");
    const loaded = await loadGatewayConfig({ configPath, mode: "dev-localhost" });
    expect(loaded.http.publicOrigin).toBe("http://127.0.0.1:4317");
    expect(loaded.auth.allowedLogins).toEqual([]);
    expect(loaded.omp).toEqual({
      discoveryDir: join(homedir(), process.env.PI_CONFIG_DIR ?? ".omp", "run", "collab-hosts"),
      queryTimeoutMs: 1_500,
    });
    expect(await Bun.file(configPath).exists()).toBe(false);
    await expect(loadGatewayConfig({ configPath })).rejects.toThrow(
      "tailscale-serve mode requires an exact HTTPS public origin",
    );
  });

  test("a malformed config file fails the load instead of falling back to defaults", async () => {
    const configPath = await configFixture("{ not json");
    await expect(loadGatewayConfig({ configPath, mode: "dev-localhost" })).rejects.toThrow(SyntaxError);
  });
});

describe("config key admission", () => {
  test("rejects an unknown key in every section with a section-specific message", async () => {
    await expect(loadDocument({ ...devDocument(), htp: {} })).rejects.toThrow("unknown config key: htp");
    await expect(loadDocument(devDocument({ http: { portt: 4317 } }))).rejects.toThrow(
      "unknown http config key: portt",
    );
    await expect(loadDocument(devDocument({ auth: { trustIdentityWithoutTailnetDevices: true } }))).rejects.toThrow(
      "unknown auth config key: trustIdentityWithoutTailnetDevices",
    );
    await expect(loadDocument(devDocument({ registry: { heartbeatSecond: 10 } }))).rejects.toThrow(
      "unknown registry config key: heartbeatSecond",
    );
  }, 20_000);

  test("rejects a document or a section that is not an object", async () => {
    await expect(loadDocument([])).rejects.toThrow("config must be an object");
    await expect(loadGatewayConfig({ configPath: await configFixture("null"), mode: "dev-localhost" })).rejects.toThrow(
      "config must be an object",
    );
    await expect(loadDocument({ http: [] })).rejects.toThrow("config sections must be objects");
    await expect(loadDocument({ registry: 3 })).rejects.toThrow("config sections must be objects");
  }, 20_000);

  test("accepts the tailnet trust assertion only as a boolean and records it only when asserted", async () => {
    const asserted = await loadDocument(devDocument({ auth: { trustIdentityWithoutTailnetDevice: true } }));
    expect(asserted.auth.trustIdentityWithoutTailnetDevice).toBe(true);
    const declined = await loadDocument(devDocument({ auth: { trustIdentityWithoutTailnetDevice: false } }));
    expect("trustIdentityWithoutTailnetDevice" in declined.auth).toBe(false);
    const absent = await loadDocument(devDocument());
    expect("trustIdentityWithoutTailnetDevice" in absent.auth).toBe(false);
    await expect(loadDocument(devDocument({ auth: { trustIdentityWithoutTailnetDevice: "true" } }))).rejects.toThrow(
      "auth.trustIdentityWithoutTailnetDevice must be a boolean",
    );
  }, 20_000);

  test("requires a loopback listener hostname", async () => {
    for (const hostname of ["0.0.0.0", "localhost", "10.0.0.1"]) {
      await expect(loadDocument(devDocument({ http: { hostname } }))).rejects.toThrow("http.hostname must be loopback");
    }
    expect((await loadDocument(devDocument())).http.hostname).toBe("127.0.0.1");
    const sixed = await loadDocument(devDocument({ http: { hostname: "::1", publicOrigin: "http://[::1]:4317" } }));
    expect(sixed.http.hostname).toBe("::1");
    expect(sixed.http.publicOrigin).toBe("http://[::1]:4317");
  }, 20_000);
});

describe("fleet and speech configuration", () => {
  const target = { id: "remote", label: "Remote host", origin: "https://remote.example.ts.net" };

  test("derives the local label and leaves old documents byte-identical", async () => {
    for (const [document, label] of [
      [serveDocument({ http: { publicOrigin: "https://studio.example.ts.net" } }), "studio"],
      [devDocument(), "127.0.0.1"],
      [devDocument({ http: { hostname: "::1", publicOrigin: "http://[::1]:4317" } }), "[::1]"],
    ] as const) {
      const text = `${JSON.stringify(document)}  \n`;
      const configPath = await configFixture(text);
      const loaded = await loadGatewayConfig({ configPath });
      expect(loaded.http.trustedDashboardOrigins).toEqual([]);
      expect(loaded.fleet).toEqual({ label, targets: [] });
      expect(loaded.speech).toEqual({ browserRecognition: false });
      expect(await readFile(configPath, "utf8")).toBe(text);
    }
    const overridden = await loadDocument(serveDocument(), { publicOrigin: "https://new-label.example.ts.net" });
    expect(overridden.fleet.label).toBe("new-label");
  });

  test("normalizes bounded display labels and enables only explicitly authored speech", async () => {
    const loaded = await loadDocument({
      ...serveDocument(),
      http: { publicOrigin: "https://studio.example.ts.net", trustedDashboardOrigins: [target.origin] },
      fleet: { label: "  Stu\u202edio e\u0301\u0001  ", targets: [{ ...target, label: " Re\u0301mote\u202e " }] },
      speech: { browserRecognition: true },
    });
    expect(loaded.fleet.label).toBe("Studio é");
    expect(loaded.fleet.targets).toEqual([{ ...target, label: "Rémote" }]);
    expect(loaded.http.trustedDashboardOrigins).toEqual([target.origin]);
    expect(loaded.speech.browserRecognition).toBe(true);
  });

  test("admits HTTPS everywhere and loopback HTTP only in development, including after overrides", async () => {
    const localTarget = { ...target, origin: "http://[::1]:4412" };
    const document = {
      ...devDocument(),
      http: { publicOrigin: "http://127.0.0.1:4317", trustedDashboardOrigins: ["http://127.0.0.1:4412"] },
      fleet: { targets: [localTarget] },
    };
    expect((await loadDocument(document)).fleet.targets).toEqual([localTarget]);
    const production = {
      ...serveDocument(),
      fleet: { targets: [localTarget] },
    };
    await expect(loadDocument(production)).rejects.toThrow("fleet.targets[0].origin must be a canonical https origin");
    await expect(loadDocument(serveDocument({ http: { trustedDashboardOrigins: [localTarget.origin] } }))).rejects.toThrow(
      "http.trustedDashboardOrigins[0] must be a canonical https origin",
    );
    await expect(loadDocument({
      ...document,
      auth: { mode: "dev-localhost", allowedLogins: ["user@example.com"] },
    }, { mode: "tailscale-serve", publicOrigin: "https://studio.example.ts.net" })).rejects.toThrow(
      "must be a canonical https origin",
    );
  });

  test("rejects noncanonical, unbounded and non-loopback fleet origins with a field path", async () => {
    for (const invalid of [
      "null", "https://REMOTE.example/", "https://remote.example:443", "https://remote.example/path",
      "https://user:pass@remote.example", "https://remote.example?x=1", "https://remote.example#x",
      "http://localhost:4412", "http://192.168.1.5:4412", "ftp://remote.example", "https://" + "a".repeat(250), 1, null,
    ]) {
      await expect(loadDocument({
        ...devDocument(),
        fleet: { targets: [target, { ...target, id: "other", origin: invalid }] },
      })).rejects.toThrow("fleet.targets[1].origin must be a canonical https or loopback http origin");
      await expect(loadDocument(devDocument({ http: { trustedDashboardOrigins: [invalid] } }))).rejects.toThrow(
        "http.trustedDashboardOrigins[0] must be a canonical https or loopback http origin",
      );
    }
  });

  test("rejects source collisions, duplicate origins and count overflows", async () => {
    const sources = Array.from({ length: 7 }, (_, index) => ({
      id: `host-${index}`, label: `Host ${index}`, origin: `https://host-${index}.example.ts.net`,
    }));
    expect((await loadDocument({ ...serveDocument(), fleet: { targets: sources } })).fleet.targets).toEqual(sources);
    const dashboards = [...sources.map(source => source.origin), "https://eighth.example.ts.net"];
    expect((await loadDocument(serveDocument({ http: { trustedDashboardOrigins: dashboards } }))).http.trustedDashboardOrigins).toEqual(dashboards);
    for (const [targets, message] of [
      [[{ ...target, id: "local" }], ".id must be unique"],
      [[target, { ...target, origin: "https://other.example" }], ".id must be unique"],
      [[target, { ...target, id: "other" }], ".origin must be unique"],
      [[{ ...target, origin: "https://gateway.example.ts.net" }], ".origin must be unique"],
      [[...sources, { ...target, id: "eighth" }], "at most 7"],
    ] as const) {
      await expect(loadDocument({ ...serveDocument(), fleet: { targets } })).rejects.toThrow(message);
    }
    for (const [trustedDashboardOrigins, message] of [
      [[target.origin, target.origin], "duplicates"],
      [["https://gateway.example.ts.net"], "must not equal http.publicOrigin"],
      [[...dashboards, "https://ninth.example"], "at most 8"],
    ] as const) {
      await expect(loadDocument(serveDocument({ http: { trustedDashboardOrigins } }))).rejects.toThrow(message);
    }
    await expect(loadDocument({ ...serveDocument(), fleet: { targets: [target] } }, {
      publicOrigin: target.origin,
    })).rejects.toThrow("must not equal http.publicOrigin");
  });

  test("rejects unknown keys, missing target fields, nulls, wrong types and label/id bounds", async () => {
    for (const document of [
      { ...devDocument(), fleet: null },
      { ...devDocument(), speech: null },
      { ...devDocument(), http: null },
      { ...devDocument(), fleet: { label: null } },
      { ...devDocument(), fleet: { targets: null } },
      { ...devDocument(), speech: { browserRecognition: null } },
      devDocument({ http: { trustedDashboardOrigins: null } }),
      { ...devDocument(), fleet: { targets: [null] } },
      { ...devDocument(), fleet: { targets: [{ id: "remote", label: "Remote" }] } },
      { ...devDocument(), fleet: { targets: [target.origin] } },
      { ...devDocument(), fleet: { targets: {} } },
      devDocument({ http: { trustedDashboardOrigins: target.origin } }),
      { ...devDocument(), speech: { browserRecognition: "true" } },
    ]) await expect(loadDocument(document)).rejects.toThrow();
    await expect(loadDocument({ ...devDocument(), fleet: { unknown: true } })).rejects.toThrow("unknown fleet config key: unknown");
    await expect(loadDocument({ ...devDocument(), speech: { unknown: true } })).rejects.toThrow("unknown speech config key: unknown");
    await expect(loadDocument({ ...devDocument(), fleet: { targets: [{ ...target, extra: true }] } })).rejects.toThrow(
      "unknown fleet.targets[0] config key: extra",
    );
    for (const id of ["", "Remote", "-remote", "a".repeat(33), null]) {
      await expect(loadDocument({ ...devDocument(), fleet: { targets: [{ ...target, id }] } })).rejects.toThrow(".id must match");
    }
    for (const label of ["", " \u202e\u0001 ", "a".repeat(65), null, 1]) {
      await expect(loadDocument({ ...devDocument(), fleet: { label } })).rejects.toThrow("fleet.label");
      await expect(loadDocument({ ...devDocument(), fleet: { targets: [{ ...target, label }] } })).rejects.toThrow(".label");
    }
    expect((await loadDocument({ ...devDocument(), fleet: { label: "\u{1F3A4}".repeat(64) } })).fleet.label).toBe("\u{1F3A4}".repeat(64));
  });

  test("projects only authored fleet keys without mutating or materializing defaults", () => {
    expect(FLEET_CONFIG_SINCE_VERSION).toBe("0.8.0");
    const document = {
      ...serveDocument({ http: { trustedDashboardOrigins: [] } }),
      fleet: {},
      speech: { browserRecognition: false },
      omp: { queryTimeoutMs: 2_000 },
    };
    const original = JSON.stringify(document);
    const projection = projectPreFleetConfig(document);
    expect(projection.removedKeys).toEqual(["http.trustedDashboardOrigins", "fleet", "speech"]);
    expect(projection.document).toEqual({ ...serveDocument(), omp: document.omp });
    expect(JSON.stringify(document)).toBe(original);
    expect(projectPreFleetConfig(serveDocument())).toEqual({ document: serveDocument(), removedKeys: [] });
  });
});

describe("registry bounds admission", () => {
  test("refuses a heartbeat outside its bounds or of the wrong shape", async () => {
    for (const heartbeatSeconds of [1, 61, 10.5, "10", true]) {
      await expect(loadDocument(devDocument({ registry: { heartbeatSeconds } }))).rejects.toThrow(
        "registry.heartbeatSeconds must be an integer from 2 to 60",
      );
    }
  }, 20_000);

  test("refuses a TTL outside its bounds or of the wrong shape", async () => {
    for (const ttlSeconds of [4, 301, 35.5, "35", true]) {
      await expect(loadDocument(devDocument({ registry: { ttlSeconds } }))).rejects.toThrow(
        "registry.ttlSeconds must be an integer from 5 to 300",
      );
    }
  }, 20_000);

  test("accepts both ends of the heartbeat and TTL ranges", async () => {
    const minimal = (await loadDocument(devDocument({ registry: { heartbeatSeconds: 2, ttlSeconds: 5 } }))).registry;
    expect([minimal.heartbeatSeconds, minimal.ttlSeconds]).toEqual([2, 5]);
    const maximal = (await loadDocument(devDocument({ registry: { heartbeatSeconds: 60, ttlSeconds: 300 } }))).registry;
    expect([maximal.heartbeatSeconds, maximal.ttlSeconds]).toEqual([60, 300]);
  }, 20_000);

  test("requires the TTL to exceed two heartbeat intervals at the exact boundary", async () => {
    await expect(loadDocument(devDocument({ registry: { heartbeatSeconds: 10, ttlSeconds: 20 } }))).rejects.toThrow(
      "registry.ttlSeconds must exceed two heartbeat intervals",
    );
    const short = await loadDocument(devDocument({ registry: { heartbeatSeconds: 10, ttlSeconds: 21 } }));
    expect(short.registry.ttlSeconds).toBe(21);
    await expect(loadDocument(devDocument({ registry: { heartbeatSeconds: 60, ttlSeconds: 120 } }))).rejects.toThrow(
      "registry.ttlSeconds must exceed two heartbeat intervals",
    );
    const long = await loadDocument(devDocument({ registry: { heartbeatSeconds: 60, ttlSeconds: 121 } }));
    expect(long.registry.ttlSeconds).toBe(121);
    // A TTL below its own floor is a range failure, not a heartbeat-relation failure: the operator is
    // told which number is wrong rather than being pointed at the pair.
    await expect(loadDocument(devDocument({ registry: { heartbeatSeconds: 2, ttlSeconds: 4 } }))).rejects.toThrow(
      "registry.ttlSeconds must be an integer from 5 to 300",
    );
  }, 20_000);

  test("bounds the session ceiling and ignores the fork-era publisher ceiling", async () => {
    const wide = (await loadDocument(devDocument({ registry: { maxSessions: 1 } }))).registry;
    expect(wide.maxSessions).toBe(1);
    await expect(loadDocument(devDocument({ registry: { maxSessions: 1_001 } }))).rejects.toThrow(
      "registry.maxSessions must be an integer from 1 to 1000",
    );
    // A config written by a fork-era gateway still carries `maxPublishers`. Installing over one has
    // to keep working, and the value has to stop meaning anything, so it loads and is not surfaced.
    const legacy = await loadDocument(devDocument({ registry: { maxSessions: 7 } }));
    expect(legacy.registry).toEqual({ heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 7 });
  }, 20_000);
});

describe("allowlist admission", () => {
  test("folds case, trims, and collapses duplicates while preserving first-seen order", async () => {
    const loaded = await loadDocument(
      serveDocument({
        auth: {
          allowedLogins: [" User@Example.COM ", "user@example.com", "OTHER@Example.com", "USER@EXAMPLE.COM "],
        },
      }),
    );
    expect(loaded.auth.allowedLogins).toEqual(["user@example.com", "other@example.com"]);
  });

  test("collapses logins that differ only by Unicode composition", async () => {
    const loaded = await loadDocument(
      serveDocument({ auth: { allowedLogins: ["u\u0301ser@example.com", "\u00faser@example.com"] } }),
    );
    expect(loaded.auth.allowedLogins).toEqual(["\u00faser@example.com"]);
  });

  test("refuses an entry that cannot name exactly one login", async () => {
    for (const login of [
      "*",
      "*@example.com",
      "",
      "   ",
      "first@example.com,second@example.com",
      "first\nsecond@example.com",
      `${"a".repeat(309)}@example.com`,
    ]) {
      await expect(loadDocument(serveDocument({ auth: { allowedLogins: [login] } }))).rejects.toThrow(
        "invalid Tailscale login allowlist entry",
      );
    }
    const longest = await loadDocument(serveDocument({ auth: { allowedLogins: [`${"a".repeat(308)}@example.com`] } }));
    expect(longest.auth.allowedLogins[0]?.length).toBe(320);
  }, 30_000);

  test("refuses an allowlist that is not an array of strings", async () => {
    await expect(loadDocument(serveDocument({ auth: { allowedLogins: "user@example.com" } }))).rejects.toThrow(
      "auth.allowedLogins must be an array of login strings",
    );
    await expect(loadDocument(serveDocument({ auth: { allowedLogins: ["user@example.com", 42] } }))).rejects.toThrow(
      "auth.allowedLogins must be an array of login strings",
    );
  });
});

describe("private file admission", () => {
  test("refuses a config file that any other account could read", async () => {
    if (process.platform === "win32") return;
    const configPath = await configFixture(JSON.stringify(devDocument()));
    expect((await loadGatewayConfig({ configPath })).http.port).toBe(4317);
    for (const mode of [0o640, 0o604, 0o666]) {
      await chmod(configPath, mode);
      await expect(loadGatewayConfig({ configPath })).rejects.toThrow(
        `unsafe private file permissions: ${configPath}`,
      );
    }
    await chmod(configPath, 0o600);
    expect((await loadGatewayConfig({ configPath })).http.port).toBe(4317);
  });

  test("refuses a readable readiness token and never mints one on a plain load", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const config = configForRoot(root);
    await expect(loadReadinessToken(config)).rejects.toThrow("ENOENT");
    expect(await Bun.file(config.paths.tokenPath).exists()).toBe(false);
    const token = await loadOrCreateReadinessToken(config);
    await assertReadinessTokenPrivate(config);
    await chmod(config.paths.tokenPath, 0o640);
    await expect(assertReadinessTokenPrivate(config)).rejects.toThrow(
      `unsafe private file permissions: ${config.paths.tokenPath}`,
    );
    await chmod(config.paths.tokenPath, 0o600);
    expect(await loadReadinessToken(config)).toBe(token);
    const target = join(root, "external-token");
    await writeFile(target, `${"A".repeat(43)}\n`, { mode: 0o600 });
    await rm(config.paths.tokenPath);
    await symlink(target, config.paths.tokenPath);
    await expect(loadReadinessToken(config)).rejects.toThrow(`unsafe private file: ${config.paths.tokenPath}`);
  }, 20_000);

  test("refuses to use a token directory that any other account could enter", async () => {
    if (process.platform === "win32") return;
    const config = configForRoot(await privateRoot());
    const token = await loadOrCreateReadinessToken(config);
    for (const mode of [0o750, 0o701, 0o777]) {
      await chmod(config.paths.configDir, mode);
      await expect(loadReadinessToken(config)).rejects.toThrow(
        `unsafe private directory: ${config.paths.configDir}`,
      );
    }
    await chmod(config.paths.configDir, 0o700);
    expect(await loadReadinessToken(config)).toBe(token);
  }, 20_000);

  test("accepts a config file at exactly the size limit", async () => {
    const document = JSON.stringify(devDocument());
    const padded = `${document}${" ".repeat(64 * 1_024 - Buffer.byteLength(document))}`;
    expect(Buffer.byteLength(padded)).toBe(64 * 1_024);
    const configPath = await configFixture(padded);
    expect((await loadGatewayConfig({ configPath })).http.port).toBe(4317);
  }, 20_000);
});

describe("public origin admission", () => {
  test("refuses an origin that is not a string or cannot be parsed", async () => {
    await expect(loadDocument(devDocument({ http: { publicOrigin: 42 } }))).rejects.toThrow(
      "http.publicOrigin must be a URL origin",
    );
    await expect(loadDocument(devDocument({ http: { publicOrigin: "127.0.0.1:4317" } }))).rejects.toThrow(TypeError);
  });

  test("refuses a scheme the gateway cannot serve", async () => {
    for (const publicOrigin of ["ftp://gateway.example.ts.net", "wss://gateway.example.ts.net", "file:///etc"]) {
      await expect(loadDocument(serveDocument({ http: { publicOrigin } }))).rejects.toThrow(
        "http.publicOrigin must be an exact HTTP(S) origin",
      );
    }
  }, 20_000);

  test("refuses an origin that URL normalization would rewrite", async () => {
    // The stored origin is compared byte-for-byte against a request `Origin`, so anything the parser
    // would silently canonicalize has to be refused at load rather than accepted in a rewritten form
    // the operator never wrote.
    for (const publicOrigin of [
      "https://operator:hunter2@gateway.example.ts.net",
      "HTTPS://GATEWAY.EXAMPLE.TS.NET",
      "https://gateway.example.ts.net?probe=1",
      "https://gateway.example.ts.net#fragment",
    ]) {
      await expect(loadDocument(serveDocument({ http: { publicOrigin } }))).rejects.toThrow(
        "http.publicOrigin must be an exact HTTP(S) origin",
      );
    }
  }, 20_000);

  test("refuses a listener port from the file that is not an integer in range", async () => {
    for (const port of ["4317", 4317.5, true, 1e10, 0]) {
      await expect(loadDocument(devDocument({ http: { port } }))).rejects.toThrow(
        "http.port must be an integer from 1 to 65535",
      );
    }
  }, 20_000);
});

describe("readiness token admission", () => {
  async function tokenFixture(content: string): Promise<GatewayConfig> {
    const config = configForRoot(await privateRoot());
    await mkdir(config.paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(config.paths.tokenPath, content, { mode: 0o600 });
    await secureWindowsFixture(config.paths.tokenPath);
    return config;
  }

  test("accepts exactly 43 base64url characters, with or without a line ending", async () => {
    const token = `-_azAZ09${"x".repeat(35)}`;
    const config = await tokenFixture("");
    for (const content of [token, `${token}\n`, `${token}\r\n`]) {
      await writeFile(config.paths.tokenPath, content);
      expect(await loadReadinessToken(config)).toBe(token);
    }
  }, 20_000);

  test("refuses a token of the wrong length or alphabet instead of minting a replacement", async () => {
    const malformed = [
      "A".repeat(42),
      `${"A".repeat(42)}\n`,
      `${"A".repeat(44)}\n`,
      `${"A".repeat(42)}+\n`,
      `${"A".repeat(42)}=\n`,
      // A valid token padded out to a larger file: the read is bounded by the token's own size, so
      // trailing content is a malformed token file rather than something to be trimmed away.
      `${"A".repeat(43)}${" ".repeat(64)}`,
    ];
    // Windows runs a representative pair rather than all six. Each case costs three `powershell.exe`
    // spawns — one to set the fixture's ACL and one per privacy inspection — and on `windows-2025`
    // that spawn cost is both high and wildly variable, which is what exhausted this test's budget
    // at 30 s. Widening the budget is the wrong answer, as `docs/BACKLOG.md` says of the deferred
    // native-`icacls` item; the contract here is "malformed is refused rather than minted over", and
    // a wrong length plus a wrong alphabet establishes it. The full set still runs on POSIX.
    const cases = process.platform === "win32" ? [malformed[0] ?? "", malformed[3] ?? ""] : malformed;
    for (const content of cases) {
      const config = await tokenFixture(content);
      await expect(loadReadinessToken(config)).rejects.toThrow("readiness token has invalid encoding or length");
      // A corrupt token must fail loudly. Minting over it would revoke every publisher's capability
      // while reporting success, and the operator would have no way to tell that from a clean start.
      await expect(loadOrCreateReadinessToken(config)).rejects.toThrow(
        "readiness token has invalid encoding or length",
      );
      expect(await readFile(config.paths.tokenPath, "utf8")).toBe(content);
    }
  }, 60_000);

  test("rotation refuses a token path that is not a file and leaves its contents alone", async () => {
    const config = configForRoot(await privateRoot());
    await mkdir(config.paths.tokenPath, { recursive: true, mode: 0o700 });
    await writeFile(join(config.paths.tokenPath, "occupant"), "not a token\n", { mode: 0o600 });
    await expect(rotateReadinessToken(config)).rejects.toThrow("refusing to replace a non-file readiness token path");
    expect(await readdir(config.paths.tokenPath)).toEqual(["occupant"]);
  }, 20_000);
});

describe("private directory admission", () => {
  test("refuses a symlinked configuration directory instead of writing the token through it", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const config = configForRoot(root);
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, config.paths.configDir);
    await expect(ensureRuntimeDirectories(config)).rejects.toThrow(
      `unsafe private directory: ${config.paths.configDir}`,
    );
    await expect(loadOrCreateReadinessToken(config)).rejects.toThrow(
      `unsafe private directory: ${config.paths.configDir}`,
    );
    // The refusal has to happen before anything is written: a token minted through the link would
    // live outside the tree whose privacy every other assertion here measures.
    expect(await readdir(outside)).toEqual([]);
  }, 20_000);

  test("refuses a runtime directory any other account could enter", async () => {
    if (process.platform === "win32") return;
    const config = configForRoot(await privateRoot());
    await ensureRuntimeDirectories(config);
    for (const mode of [0o755, 0o701, 0o770]) {
      await chmod(config.paths.runtimeDir, mode);
      await expect(ensureRuntimeDirectories(config)).rejects.toThrow(
        `unsafe private directory: ${config.paths.runtimeDir}`,
      );
    }
    await chmod(config.paths.runtimeDir, 0o700);
    await ensureRuntimeDirectories(config);
  }, 20_000);
});

describe("private text files", () => {
  test("atomically creates an owner-only backup and refuses to replace an existing path", async () => {
    const root = await privateRoot();
    const path = join(root, "config.pre-rollback.json");
    await writePrivateTextFile(path, "authored bytes\n", { exclusive: true });
    expect(await readFile(path, "utf8")).toBe("authored bytes\n");
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(writePrivateTextFile(path, "replacement\n", { exclusive: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("authored bytes\n");
    expect(await readdir(root)).toEqual(["config.pre-rollback.json"]);
  });

  test("refuses a size limit that cannot bound a read", async () => {
    const path = join(await privateRoot(), "push-state.json");
    await writeFile(path, "x", { mode: 0o600 });
    await secureWindowsFixture(path);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(readPrivateTextFile(path, limit)).rejects.toThrow("invalid private file size limit");
    }
    expect(await readPrivateTextFile(path, 1)).toBe("x");
  }, 20_000);

  test("reads at the size limit, refuses past it, and reports an absent file as absent", async () => {
    const root = await privateRoot();
    const path = join(root, "push-state.json");
    await writeFile(path, "0123456789", { mode: 0o600 });
    await secureWindowsFixture(path);
    expect(await readPrivateTextFile(path, 10)).toBe("0123456789");
    await expect(readPrivateTextFile(path, 9)).rejects.toThrow(`private file exceeds size limit: ${path}`);
    expect(await readPrivateTextFile(join(root, "absent.json"), 10)).toBeUndefined();
  }, 20_000);

  test("refuses a private read of a permissive file or through a symlink", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const path = join(root, "push-state.json");
    await writeFile(path, "{}", { mode: 0o600 });
    expect(await readPrivateTextFile(path, 64)).toBe("{}");
    await chmod(path, 0o644);
    await expect(readPrivateTextFile(path, 64)).rejects.toThrow(`unsafe private file permissions: ${path}`);
    await chmod(path, 0o600);
    const link = join(root, "link.json");
    await symlink(path, link);
    await expect(readPrivateTextFile(link, 64)).rejects.toThrow(`unsafe private file: ${link}`);
  });

  test("replaces content, tightens the mode, and leaves no temporary file behind", async () => {
    const root = await privateRoot();
    const path = join(root, "push-state.json");
    await writeFile(path, "world-readable original\n", { mode: 0o644 });
    if (process.platform !== "win32") await chmod(path, 0o644);
    await writePrivateTextFile(path, "replacement\n");
    expect(await readFile(path, "utf8")).toBe("replacement\n");
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o600);
    // The write lands through a uniquely named temporary; a leftover sibling would be a second copy
    // of the same private content with nobody responsible for removing it.
    expect(await readdir(root)).toEqual(["push-state.json"]);
  }, 20_000);

  test("replaces a symlinked destination instead of writing through it", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const target = join(root, "outside.json");
    const path = join(root, "push-state.json");
    await writeFile(target, "untouched\n", { mode: 0o600 });
    await symlink(target, path);
    await writePrivateTextFile(path, "replacement\n");
    expect(await readFile(target, "utf8")).toBe("untouched\n");
    expect((await lstat(path)).isSymbolicLink()).toBeFalse();
    expect(await readFile(path, "utf8")).toBe("replacement\n");
  });
});

describe("config snapshot restore", () => {
  test("captures an unsafe or oversized config as an error rather than as an absent snapshot", async () => {
    // A snapshot that reads "no config existed" is a licence to delete on restore, so a config the
    // capture could not safely read must stop the operation instead of becoming that snapshot.
    const root = await privateRoot();
    const oversized = join(root, "oversized.json");
    await writeFile(oversized, " ".repeat(64 * 1_024 + 1), { mode: 0o600 });
    await secureWindowsFixture(oversized);
    await expect(captureGatewayConfigFile(oversized)).rejects.toThrow("config file exceeds size limit");
    if (process.platform === "win32") return;
    const permissive = join(root, "permissive.json");
    await writeFile(permissive, "{}\n", { mode: 0o644 });
    await chmod(permissive, 0o644);
    await expect(captureGatewayConfigFile(permissive)).rejects.toThrow(
      `unsafe private file permissions: ${permissive}`,
    );
  }, 20_000);

  test("restoring an absent snapshot over a symlink refuses instead of removing its target", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const path = join(root, "config.json");
    const target = join(root, "outside.json");
    await writeFile(target, "another account's file\n", { mode: 0o600 });
    await symlink(target, path);
    await expect(restoreGatewayConfigFile({ path, content: undefined })).rejects.toThrow(
      "refusing to remove an unsafe config path",
    );
    expect(await readFile(target, "utf8")).toBe("another account's file\n");
    expect((await lstat(path)).isSymbolicLink()).toBeTrue();
  });

  test("restoring an absent snapshot succeeds when the config is already gone", async () => {
    // The revert path of a failed install runs this against a config that may never have existed;
    // turning that into an ENOENT would report a failed rollback of a rollback.
    const path = join(await privateRoot(), "config.json");
    await restoreGatewayConfigFile({ path, content: undefined });
    expect(await Bun.file(path).exists()).toBe(false);
    await restoreGatewayConfigFile({ path, content: undefined });
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("refuses to restore a config into a directory another account could enter", async () => {
    if (process.platform === "win32") return;
    const directory = join(await privateRoot(), "config");
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    const path = join(directory, "config.json");
    await expect(restoreGatewayConfigFile({ path, content: "{}\n" })).rejects.toThrow(
      `unsafe private directory: ${directory}`,
    );
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

describe("legacy publisher credential removal", () => {
  test("removes the retired file without changing the readiness token", async () => {
    const config = configForRoot(await privateRoot());
    const readinessToken = await loadOrCreateReadinessToken(config);
    const legacyPath = join(config.paths.configDir, "publisher-token");
    await writeFile(legacyPath, "L".repeat(43), { mode: 0o600 });

    expect(await removeLegacyPublisherToken(config)).toBe(true);
    expect(await Bun.file(legacyPath).exists()).toBe(false);
    expect(await loadReadinessToken(config)).toBe(readinessToken);
  }, 20_000);

  test("leaves an absent credential absent without creating private directories", async () => {
    const config = configForRoot(await privateRoot());
    expect(await removeLegacyPublisherToken(config)).toBe(false);
    await expect(lstat(config.paths.configDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to remove a directory or follow a symlink in place of the legacy file", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const legacyPath = join(config.paths.configDir, "publisher-token");
    await mkdir(legacyPath, { recursive: true, mode: 0o700 });
    expect(await removeLegacyPublisherToken(config)).toBe(false);
    expect((await lstat(legacyPath)).isDirectory()).toBe(true);

    if (process.platform === "win32") return;
    await rm(legacyPath, { recursive: true });
    const target = join(root, "external-token");
    await writeFile(target, "untouched", { mode: 0o600 });
    await symlink(target, legacyPath);
    expect(await removeLegacyPublisherToken(config)).toBe(false);
    expect((await lstat(legacyPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
});

describe("private path derivation", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  test("derives every private path from the XDG overrides", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_STATE_HOME = join(root, "state");
    const paths = defaultGatewayPaths();
    expect(paths.configDir).toBe(join(root, "config", "omp-session-gateway"));
    expect(paths.stateDir).toBe(join(root, "state", "omp-session-gateway"));
    expect(paths.configPath).toBe(join(paths.configDir, "config.json"));
    expect(paths.tokenPath).toBe(join(paths.configDir, "readiness-token"));
  });

  test("falls back to the per-user home locations when no XDG override is set", () => {
    if (process.platform === "win32") return;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_STATE_HOME;
    const paths = defaultGatewayPaths();
    expect(paths.configDir).toBe(join(homedir(), ".config", "omp-session-gateway"));
    expect(paths.stateDir).toBe(join(homedir(), ".local", "state", "omp-session-gateway"));
  });

  test("keeps the runtime directory scoped to this account on every platform", async () => {
    const root = await privateRoot();
    process.env.XDG_RUNTIME_DIR = join(root, "run");
    if (process.platform === "darwin") {
      process.env.TMPDIR = join(root, "tmp");
      // macOS has no XDG runtime directory. Honouring the Linux variable here would put runtime state
      // where a foreign `XDG_RUNTIME_DIR` says rather than in this account's own temporary tree.
      expect(defaultGatewayPaths().runtimeDir).toBe(join(root, "tmp", `omp-session-gateway-${process.getuid?.()}`));
    } else if (process.platform === "linux") {
      expect(defaultGatewayPaths().runtimeDir).toBe(join(root, "run", "omp-session-gateway"));
    } else {
      const paths = defaultGatewayPaths();
      expect(paths.runtimeDir).toBe(paths.stateDir);
    }
  });
});

describe("production config authoring", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  /**
   * The only group here that writes through the real path derivation rather than an injected path.
   * The sandbox is therefore asserted rather than assumed: if `defaultGatewayPaths` ever stops
   * reading the environment, these tests have to fail on this assertion instead of writing into the
   * operator's own configuration directory.
   */
  async function isolatedHome(): Promise<GatewayConfig["paths"]> {
    const root = await privateRoot();
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_STATE_HOME = join(root, "state");
    process.env.LOCALAPPDATA = join(root, "local");
    const paths = defaultGatewayPaths();
    expect(paths.configPath.startsWith(root)).toBe(true);
    expect(paths.stateDir.startsWith(root)).toBe(true);
    return paths;
  }

  test("round-trips a private serve-mode config without persisting the derived OMP section", async () => {
    const paths = await isolatedHome();
    const written = await writeGatewayConfigFile({
      publicOrigin: "https://gateway.example.ts.net",
      allowedLogins: [" User@Example.COM ", "user@example.com", "Other@example.com"],
    });
    expect(written.http).toEqual({
      hostname: "127.0.0.1",
      port: 4317,
      publicOrigin: "https://gateway.example.ts.net",
      trustedDashboardOrigins: [],
    });
    expect(written.auth.mode).toBe("tailscale-serve");
    expect(written.auth.allowedLogins).toEqual(["user@example.com", "other@example.com"]);
    expect(written.paths.configPath).toBe(paths.configPath);
    expect(written.omp).toEqual({
      discoveryDir: join(homedir(), process.env.PI_CONFIG_DIR ?? ".omp", "run", "collab-hosts"),
      queryTimeoutMs: 1_500,
    });
    if (process.platform !== "win32") {
      expect((await lstat(paths.configPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(paths.configDir)).mode & 0o077).toBe(0);
      expect((await lstat(paths.stateDir)).mode & 0o077).toBe(0);
    }
    // A fresh config keeps environment-derived OMP defaults implicit.
    expect(JSON.parse(await readFile(paths.configPath, "utf8")).omp).toBeUndefined();
    expect(await loadGatewayConfig({ configPath: paths.configPath })).toEqual(written);
  }, 20_000);

  test("preserves supported prior settings unless an install option overrides them", async () => {
    const paths = await isolatedHome();
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    const priorDocument = {
      http: { hostname: "::1", port: 5432, publicOrigin: "https://old-gateway.example.ts.net" },
      auth: {
        mode: "tailscale-serve",
        allowedLogins: ["prior@example.com"],
        trustIdentityWithoutTailnetDevice: true,
      },
      registry: { heartbeatSeconds: 7, ttlSeconds: 23, maxSessions: 83 },
      omp: { discoveryDir: join(paths.stateDir, "custom-hosts"), queryTimeoutMs: 2_345 },
    };
    const priorText = JSON.stringify(priorDocument) + "\n";
    await writePrivateTextFile(paths.configPath, priorText);

    const unchanged = await writeGatewayConfigFile({
      publicOrigin: priorDocument.http.publicOrigin,
      allowedLogins: priorDocument.auth.allowedLogins,
    });
    expect(unchanged.http.port).toBe(5432);
    expect(unchanged.auth.trustIdentityWithoutTailnetDevice).toBe(true);
    expect(unchanged.registry).toEqual(priorDocument.registry);
    expect(await readFile(paths.configPath, "utf8")).toBe(priorText);

    const preserved = await writeGatewayConfigFile({
      publicOrigin: "https://new-gateway.example.ts.net",
      allowedLogins: [" New@Example.COM "],
    });
    expect(preserved.http).toEqual({
      hostname: "::1",
      port: 5432,
      publicOrigin: "https://new-gateway.example.ts.net",
      trustedDashboardOrigins: [],
    });
    expect(preserved.auth).toEqual({
      mode: "tailscale-serve",
      allowedLogins: ["new@example.com"],
      trustIdentityWithoutTailnetDevice: true,
    });
    expect(preserved.registry).toEqual(priorDocument.registry);
    expect((await loadGatewayConfig({ configPath: paths.configPath })).omp).toEqual(priorDocument.omp);
    if (process.platform !== "win32") expect((await lstat(paths.configPath)).mode & 0o777).toBe(0o600);

    const overridden = await writeGatewayConfigFile({
      publicOrigin: "https://new-gateway.example.ts.net",
      allowedLogins: ["new@example.com"],
      port: 6432,
    });
    expect(overridden.http.port).toBe(6432);
    expect(overridden.auth.trustIdentityWithoutTailnetDevice).toBe(true);
    expect(overridden.registry).toEqual(priorDocument.registry);
    expect((await loadGatewayConfig({ configPath: paths.configPath })).omp).toEqual(priorDocument.omp);
  }, 20_000);

  test("preserves authored fleet, speech and tern sections verbatim on reinstall and leaves unchanged bytes alone", async () => {
    const paths = await isolatedHome();
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    const document = {
      ...serveDocument({ http: { trustedDashboardOrigins: ["https://dashboard.example.ts.net"] } }),
      fleet: {
        label: "  Studio e\u0301  ",
        targets: [{ id: "remote", label: " Remote\u202e ", origin: "https://remote.example.ts.net" }],
      },
      speech: { browserRecognition: true },
      tern: { executable: "/synthetic/tern", projects: [{ id: "project", label: " Project\u202e ",
        workingCopies: [{ id: "main", label: " Main ", path: "/synthetic/work" }] }],
        profiles: [{ id: "omp", label: " OMP ", argv: ["/synthetic/omp"], env: { HOME: "/synthetic", PATH: "/bin" } }] },
    };
    const text = `${JSON.stringify(document)} \n`;
    await writePrivateTextFile(paths.configPath, text);
    const options = { publicOrigin: "https://gateway.example.ts.net", allowedLogins: ["user@example.com"] };
    await writeGatewayConfigFile(options);
    expect(await readFile(paths.configPath, "utf8")).toBe(text);
    await writeGatewayConfigFile({ ...options, port: 4411 });
    const rewritten = JSON.parse(await readFile(paths.configPath, "utf8"));
    expect(rewritten.http.trustedDashboardOrigins).toEqual(["https://dashboard.example.ts.net"]);
    expect(rewritten.fleet).toEqual(document.fleet);
    expect(rewritten.speech).toEqual(document.speech);
    expect(rewritten.tern).toEqual(document.tern);
    const loaded = await loadGatewayConfig();
    expect(loaded.fleet.label).toBe("Studio é");
    expect(loaded.fleet.targets[0]?.label).toBe("Remote");
    for (const authored of [{ fleet: {}, speech: {}, tern: {} }, { fleet: { targets: [] }, speech: { browserRecognition: false }, tern: document.tern }]) {
      await writePrivateTextFile(paths.configPath, JSON.stringify({ ...serveDocument(), ...authored }));
      await writeGatewayConfigFile({ ...options, port: 4412 });
      const preserved = JSON.parse(await readFile(paths.configPath, "utf8"));
      expect(preserved.fleet).toEqual(authored.fleet);
      expect(preserved.speech).toEqual(authored.speech);
      expect(preserved.tern).toEqual(authored.tern);
      expect(preserved.http.trustedDashboardOrigins).toBeUndefined();
    }
  }, 20_000);

  test("preserves partial OMP overrides without freezing derived discovery defaults", async () => {
    const paths = await isolatedHome();
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writePrivateTextFile(paths.configPath, JSON.stringify({
      ...serveDocument(),
      omp: { queryTimeoutMs: 2_345 },
    }));
    await writeGatewayConfigFile({
      publicOrigin: "https://new-gateway.example.ts.net",
      allowedLogins: ["user@example.com"],
    });
    const previous = process.env.PI_CONFIG_DIR;
    try {
      process.env.PI_CONFIG_DIR = ".omp-renamed";
      const reloaded = await loadGatewayConfig({ configPath: paths.configPath });
      expect(reloaded.omp).toEqual({
        discoveryDir: join(homedir(), ".omp-renamed", "run", "collab-hosts"),
        queryTimeoutMs: 2_345,
      });
    } finally {
      if (previous === undefined) delete process.env.PI_CONFIG_DIR;
      else process.env.PI_CONFIG_DIR = previous;
    }
  }, 20_000);

  test("refuses malformed or unsafe prior config without replacing it", async () => {
    const paths = await isolatedHome();
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    const options = {
      publicOrigin: "https://gateway.example.ts.net",
      allowedLogins: ["user@example.com"],
    } as const;
    const malformed = "{not valid JSON\n";
    await writePrivateTextFile(paths.configPath, malformed);
    await expect(writeGatewayConfigFile(options)).rejects.toThrow();
    expect(await readFile(paths.configPath, "utf8")).toBe(malformed);

    if (process.platform === "win32") return;
    const unsafe = JSON.stringify(serveDocument()) + "\n";
    await writePrivateTextFile(paths.configPath, unsafe);
    await chmod(paths.configPath, 0o644);
    await expect(writeGatewayConfigFile(options)).rejects.toThrow(
      "unsafe private file permissions: " + paths.configPath,
    );
    expect(await readFile(paths.configPath, "utf8")).toBe(unsafe);
    expect((await lstat(paths.configPath)).mode & 0o777).toBe(0o644);
  }, 20_000);

  test("refuses an origin or an allowlist it must not persist, and writes nothing when it refuses", async () => {
    const paths = await isolatedHome();
    for (const publicOrigin of [
      "http://gateway.example.ts.net",
      "https://gateway.example.ts.net/gw",
      "https://gateway.example.ts.net/",
    ]) {
      await expect(writeGatewayConfigFile({ publicOrigin, allowedLogins: ["user@example.com"] })).rejects.toThrow(
        "production public origin must be an exact HTTPS origin",
      );
    }
    await expect(
      writeGatewayConfigFile({ publicOrigin: "https://gateway.example.ts.net", allowedLogins: [] }),
    ).rejects.toThrow("at least one allowed Tailscale login is required");
    await expect(
      writeGatewayConfigFile({ publicOrigin: "https://gateway.example.ts.net", allowedLogins: ["*"] }),
    ).rejects.toThrow("invalid Tailscale login allowlist entry");
    // Every refusal above precedes the write, so a rejected `install` leaves no config the daemon
    // would later refuse to load.
    expect(await Bun.file(paths.configPath).exists()).toBe(false);
  }, 20_000);

  test("writes a development config whose HTTP origin serve mode would refuse", async () => {
    const paths = await isolatedHome();
    const written = await writeGatewayConfigFile({
      publicOrigin: "http://127.0.0.1:4319",
      allowedLogins: [],
      port: 4319,
      mode: "dev-localhost",
    });
    expect(written.auth.mode).toBe("dev-localhost");
    expect(written.http.publicOrigin).toBe("http://127.0.0.1:4319");
    expect(written.auth.allowedLogins).toEqual([]);
    await expect(
      writeGatewayConfigFile({
        publicOrigin: "http://127.0.0.1:4319",
        allowedLogins: ["user@example.com"],
        port: 4319,
      }),
    ).rejects.toThrow("production public origin must be an exact HTTPS origin");
    // The refused serve-mode write must not have replaced the config that is there.
    expect((await loadGatewayConfig({ configPath: paths.configPath })).auth.mode).toBe("dev-localhost");
  }, 20_000);
});

describe("Windows private-path ACL enforcement", () => {
  test("secures every private path of a run from a single PowerShell process", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      await dropCachedAclHelper(config);
      const spawnsBefore = fakeAcl.spawns;
      fakeAcl.requests.length = 0;
      await loadOrCreateReadinessToken(config);
      await loadOrCreateReadinessToken(config);
      await rotateReadinessToken(config);
      // Each call applies and inspects the config and state directories and touches the token once:
      // fifteen ACL operations that used to cost fifteen `powershell.exe` starts.
      expect(fakeAcl.requests).toHaveLength(15);
      expect(fakeAcl.spawns - spawnsBefore).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects an ACL that admits a foreign principal and blames the offending path", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      await loadOrCreateReadinessToken(config);
      fakeAcl.outcomes.set(config.paths.stateDir, "foreign-principal");
      fakeAcl.requests.length = 0;
      const failure = await loadOrCreateReadinessToken(config).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("unsafe private Windows ACL");
      expect((failure as Error).message).toContain(config.paths.stateDir);
      expect((failure as Error).message).not.toContain(config.paths.configDir);
      // The safe directory ahead of it was verified, and the run stopped at the unsafe one.
      expect(fakeAcl.requests).toEqual([
        `apply ${config.paths.configDir}`,
        `inspect ${config.paths.configDir}`,
        `apply ${config.paths.stateDir}`,
        `inspect ${config.paths.stateDir}`,
      ]);
    } finally {
      restore();
    }
  });

  test("rejects a directory the ACL helper cannot resolve, naming the one that failed", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      fakeAcl.outcomes.set(config.paths.stateDir, "missing");
      await expect(loadOrCreateReadinessToken(config)).rejects.toThrow(
        `failed to secure private Windows path ${config.paths.stateDir}`,
      );
      fakeAcl.outcomes.set(config.paths.configDir, "missing");
      await expect(loadOrCreateReadinessToken(config)).rejects.toThrow(
        `failed to secure private Windows path ${config.paths.configDir}`,
      );
    } finally {
      restore();
    }
  });

  test("treats an unreadable token ACL as fatal instead of a missing token", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      await loadOrCreateReadinessToken(config);
      const stored = await readFile(config.paths.tokenPath, "utf8");
      fakeAcl.outcomes.set(config.paths.tokenPath, "missing");
      await expect(loadOrCreateReadinessToken(config)).rejects.toThrow(
        `failed to inspect private Windows ACL for ${config.paths.tokenPath}`,
      );
      // A helper failure must never be mistaken for ENOENT and remediated by minting a new token.
      expect(await readFile(config.paths.tokenPath, "utf8")).toBe(stored);
    } finally {
      restore();
    }
  });

  test("surfaces the helper's own stderr when it dies before replying", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      // The realistic failure of this design is a helper that never gets as far as its reply loop:
      // a bad script, a missing powershell.exe, a blocked execution policy. That cause reaches only
      // stderr, so discarding it would reduce every such case to "exited before replying" and leave
      // the operator with nothing to act on.
      // A helper cached by an earlier assertion would answer from its own queue and never reach the
      // start-up path this test is about.
      await dropCachedAclHelper(config);
      fakeAcl.stderr = "ParserError: unexpected token in expression";
      fakeAcl.exitBeforeReply = true;
      await expect(loadOrCreateReadinessToken(config)).rejects.toThrow("ParserError: unexpected token in expression");
    } finally {
      restore();
    }
  });

  test("starts a fresh helper when the cached one dies before replying", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      // A Windows runner produced exactly this: one `powershell.exe` never answered its first
      // request and failed the whole check, while the very next request — served by a freshly
      // started helper — succeeded in under three seconds. Treating a dead cached process as fatal
      // is what turned a transient into a failure, so the request must earn a new helper instead.
      await dropCachedAclHelper(config);
      const spawnsBefore = fakeAcl.spawns;
      fakeAcl.exitBeforeReplyOnce = true;
      await expect(loadOrCreateReadinessToken(config)).resolves.toBeDefined();
      // Two starts: the one that died and the one that answered. Without the retry the first
      // rejection reaches the caller and nothing spawns again.
      expect(fakeAcl.spawns - spawnsBefore).toBe(2);
    } finally {
      restore();
    }
  });

  test("waits out a fresh helper's slow first reply instead of replacing it", async () => {
    const root = await privateRoot();
    const config = configForRoot(root);
    const restore = installFakePowerShell();
    try {
      // PowerShell's cold start sits inside a fresh helper's first reply. At the first logon after
      // install it outlasted a 10 s deadline twice in a row: each replacement began just as cold, and
      // the gateway never listened. Fake timers stand in for the 11 s start; file I/O stays real.
      await dropCachedAclHelper(config);
      const spawnsBefore = fakeAcl.spawns;
      vi.useFakeTimers();
      fakeAcl.firstReplyDelayMs = 11_000;
      const requested = Promise.withResolvers<void>();
      fakeAcl.onRequest = requested.resolve;
      const outcome = loadOrCreateReadinessToken(config).then(() => "resolved", () => "rejected");
      await requested.promise;
      // One loop turn lets the request reach its reply race and schedule the deadline.
      await new Promise<void>(resolve => setImmediate(resolve));
      vi.advanceTimersByTime(11_000);
      expect(await outcome).toBe("resolved");
      expect(fakeAcl.spawns - spawnsBefore).toBe(1);
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  test("keeps the config fixture alive through a cold reply beyond the portable test budget", async () => {
    const root = await privateRoot();
    const path = join(root, "config.json");
    const restore = installFakePowerShell();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      vi.useFakeTimers();
      fakeAcl.firstReplyDelayMs = 36_000;
      const requested = Promise.withResolvers<void>();
      fakeAcl.onRequest = requested.resolve;
      const write = writePrivateTextFile(path, JSON.stringify(devDocument()));
      const withinBudget = Promise.race([
        write.then(() => "written"),
        new Promise<string>(resolve => {
          timer = setTimeout(() => resolve("test timed out before its ACL request"), WINDOWS_CONFIG_TEST_TIMEOUT_MS);
        }),
      ]);
      await requested.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      vi.advanceTimersByTime(36_000);
      // Settle the real I/O before teardown, even when the budget assertion below fails.
      await write;
      expect(await withinBudget).toBe("written");
      expect(WINDOWS_CONFIG_TEST_TIMEOUT_MS).toBeGreaterThan(2 * 45_000 + 2 * 250);
      expect((await loadGatewayConfig({ configPath: path })).auth.mode).toBe("dev-localhost");
    } finally {
      clearTimeout(timer);
      vi.useRealTimers();
      restore();
    }
  });

  test("bounds lost warm and cold replies, discards both helpers, and recovers on the next request", async () => {
    const path = join(await privateRoot(), "config.json");
    const restore = installFakePowerShell();
    try {
      await writePrivateTextFile(path, "original");
      const spawnsBefore = fakeAcl.spawns;
      const killsBefore = fakeAcl.kills;
      vi.useFakeTimers();
      fakeAcl.dropReplies = true;
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      fakeAcl.onRequest = () => {
        fakeAcl.onRequest = second.resolve;
        first.resolve();
      };
      let settled = false;
      const outcome = writePrivateTextFile(path, "replacement").then(
        () => { settled = true; return undefined; },
        (error: unknown) => { settled = true; return error; },
      );
      await first.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      vi.advanceTimersByTime(9_999);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      vi.advanceTimersByTime(1);
      await second.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(fakeAcl.kills - killsBefore).toBe(1);
      vi.advanceTimersByTime(44_999);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      vi.advanceTimersByTime(1);
      const failure = await outcome;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("did not reply in time");
      expect((failure as Error).message).toContain(path);
      expect(fakeAcl.kills - killsBefore).toBe(2);
      expect(fakeAcl.spawns - spawnsBefore).toBe(1);
      fakeAcl.dropReplies = false;
      await writePrivateTextFile(path, "recovered");
      expect(await readPrivateTextFile(path, 100)).toBe("recovered");
      expect(fakeAcl.spawns - spawnsBefore).toBe(2);
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  // A real daemon process, not the test runner: while it clears away a failed helper, nothing else
  // holds its event loop, so the retry must hold it. At Windows logon the first helper missed its reply
  // deadline and was killed, and the gateway exited 0 while draining that helper's stderr, before it
  // ever started the second helper. The stand-in reproduces that wait: a helper that has died without
  // replying, with a stderr that has not reached EOF and holds nothing open. Like `serve`, the driver
  // does not await at top level, which would keep Bun alive on its own.
  test("a daemon stays alive through a failed helper to start the next one", async () => {
    const root = await privateRoot();
    const driver = join(root, "driver.ts");
    await writeFile(driver, [
      "const realSpawn = Bun.spawn;",
      "Bun.spawn = ((command, options) => command[0] !== \"powershell.exe\" ? realSpawn(command, options) : {",
      "  stdin: { write: chunk => chunk.length, flush: () => 0 },",
      "  stdout: { getReader: () => ({ read: async () => ({ done: true }) }) },",
      "  stderr: new ReadableStream(),",
      "  ref() {}, unref() {}, kill() {},",
      "});",
      "Object.defineProperty(process, \"platform\", { value: \"win32\" });",
      `import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)}).then(({ writePrivateTextFile }) =>`,
      `  writePrivateTextFile(${JSON.stringify(join(root, "target"))}, "x")).then(() => console.log("resolved"), () => console.log("rejected"));`,
    ].join("\n"));
    const child = Bun.spawn([process.execPath, driver], { stdout: "pipe", stderr: "ignore" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    // Both helpers die, so the request fails; the daemon can only report that if it outlived the first.
    expect(stdout.trim()).toBe("rejected");
  });
});
