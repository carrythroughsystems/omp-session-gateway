import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main, pollUntilReady, readinessBudgetMs } from "../src/cli.ts";
import { defaultGatewayPaths, writePrivateTextFile, type GatewayConfig } from "../src/config.ts";
import { GATEWAY_VERSION } from "../src/installation.ts";
import { serviceDefinition } from "../src/service.ts";

/**
 * Every path the gateway writes to, redirected inside a throwaway root. Service managers key their
 * registry on identity no filesystem override can scope, so this isolates every file the CLI writes
 * and none of the OS state it reads back; see `loadedServiceIsOurs` in `service.ts`.
 */
function sandboxEnvironment(root: string): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: join(root, "home"),
    LOCALAPPDATA: join(root, "local-app-data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "run"),
    TMPDIR: join(root, "tmp"),
  };
}

test("rejects misspelled mutation options before side effects", async () => {
  await expect(main(["uninstall", "--no-stpo"])).rejects.toThrow("unknown option for uninstall");
  await expect(main(["install", "--origin", "https://gateway.example.ts.net", "--no-strat"])).rejects.toThrow(
    "unknown option for install",
  );
  await expect(main(["rotate-readiness-token", "--force"])).rejects.toThrow(
    "unknown option for rotate-readiness-token",
  );
});

test("rejects missing option values before mutation", async () => {
  await expect(main(["install", "--origin", "https://gateway.example.ts.net", "--allow"])).rejects.toThrow(
    "--allow requires a value",
  );
  await expect(main(["install", "--origin", "--allow", "user@example.com"])).rejects.toThrow(
    "--origin requires a value",
  );
});

test("exits promptly and closes staged resources when HTTP startup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-startup-"));
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  const port = occupied.port;
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "apps/gateway/src/cli.ts",
      "serve",
      "--dev-localhost",
      "--port",
      String(port),
      "--origin",
      `http://127.0.0.1:${port}`,
    ],
    {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: sandboxEnvironment(root),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  try {
    const result = await Promise.race([
      subprocess.exited.then(exitCode => ({ kind: "exit" as const, exitCode })),
      Bun.sleep(2_000).then(() => ({ kind: "timeout" as const })),
    ]);
    if (result.kind === "timeout") {
      subprocess.kill(9);
      throw new Error("gateway remained alive after HTTP startup failed");
    }
    expect(result.exitCode).not.toBe(0);
    expect(await new Response(subprocess.stderr).text()).toMatch(/address already in use|port \d+ in use/iu);
  } finally {
    occupied.stop(true);
    if (subprocess.exitCode === null) subprocess.kill(9);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("development serve flags still load authored fleet and speech from the default config path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-fleet-"));
  const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = portReservation.port!;
  portReservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const configDir = join(root, "config", "omp-session-gateway");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, "config.json");
  const authored = `${JSON.stringify({
    http: { trustedDashboardOrigins: ["http://127.0.0.1:4412"] },
    fleet: { label: "Dev studio", targets: [{ id: "dev-target", label: "Other dev host", origin: "http://127.0.0.1:4413" }] },
    speech: { browserRecognition: true },
  })}\n`;
  await writePrivateTextFile(configPath, authored);
  const subprocess = Bun.spawn([
    process.execPath, GATEWAY_CLI, "serve", "--dev-localhost", "--port", String(port), "--origin", origin,
  ], {
    cwd: REPOSITORY_ROOT, env: sandboxEnvironment(root), stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  try {
    let response: Response | undefined;
    const deadline = Date.now() + readinessBudgetMs();
    while (Date.now() < deadline) {
      if (subprocess.exitCode !== null) throw new Error(await new Response(subprocess.stderr).text());
      try {
        response = await fetch(`${origin}/api/v1/client-config`, { signal: AbortSignal.timeout(500) });
        break;
      } catch {
        await Bun.sleep(20);
      }
    }
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      version: 1,
      local: { id: "local", label: "Dev studio", origin },
      targets: [{ id: "dev-target", label: "Other dev host", origin: "http://127.0.0.1:4413" }],
      speech: { browserRecognition: true },
    });
    expect(await readFile(configPath, "utf8")).toBe(authored);
  } finally {
    subprocess.kill("SIGTERM");
    if (!(await Promise.race([subprocess.exited.then(() => true), Bun.sleep(2_000).then(() => false)]))) {
      subprocess.kill(9);
      await subprocess.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 75_000);

/**
 * The option table in `cli.ts` is the whole guard between a mistyped operator command and a
 * destructive side effect, and `validateCommandOptions` silently accepts *every* option for a
 * command it has no entry for. Restating the surface here turns that silent hole into a failure:
 * `usage advertises exactly the commands whose options are validated` fails when a command is added
 * to the CLI without being added below, and the refusal loop then covers it automatically.
 */
const COMMAND_SURFACE: Readonly<Record<string, readonly string[]>> = {
  serve: ["--dev-localhost", "--port", "--origin", "--readiness-instance"],
  install: ["--origin", "--allow", "--port", "--no-start"],
  uninstall: ["--no-stop"],
  rollback: ["--to"],
  status: [],
  doctor: ["--bundle", "--output"],
  "rotate-readiness-token": [],
  "serve-guidance": [],
  help: [],
  "--help": [],
};

const EVERY_OPTION: readonly string[] = [...new Set(Object.values(COMMAND_SURFACE).flat())];
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GATEWAY_CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface SandboxRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Sandbox-relative paths of everything the run wrote for the gateway; empty means no mutation. */
  readonly artifacts: readonly string[];
}

/**
 * Runs the CLI with every path it writes to redirected inside a throwaway root, so a refusal that
 * regressed into a side effect shows up as an artifact rather than as damage to the developer's
 * machine. `readdir` is filtered rather than compared wholesale because Bun itself populates
 * `$HOME/Library/Caches/bun` in the sandbox.
 */
async function runInSandbox(
  build: (root: string) => Promise<readonly string[]> | readonly string[],
): Promise<SandboxRun> {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-argv-"));
  try {
    const command = await build(root);
    const subprocess = Bun.spawn([...command], {
      cwd: REPOSITORY_ROOT,
      env: sandboxEnvironment(root),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // A real deadline, not a guessed settling delay: every assertion here is about a CLI that
      // must refuse and exit, so the only thing this races is a hang. The passing path never waits,
      // because `exited` wins as soon as the process is gone.
      const exited = await Promise.race([subprocess.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
      if (!exited) subprocess.kill(9);
      const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      const exitCode = await subprocess.exited;
      if (!exited) throw new Error(`the gateway CLI never exited: ${stderr}`);
      const entries = await readdir(root, { recursive: true });
      return {
        exitCode,
        stdout,
        stderr,
        artifacts: entries.filter(entry => entry.includes("omp-session-gateway")).sort(),
      };
    } finally {
      if (subprocess.exitCode === null) subprocess.kill(9);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli(argv: readonly string[]): Promise<SandboxRun> {
  return runInSandbox(() => [process.execPath, "apps/gateway/src/cli.ts", ...argv]);
}

/**
 * Stands in for the installed `omp-gatewayd` entry point: same import of `main`, same
 * message-only failure reporting as the `import.meta.main` block in `cli.ts`. The file's *name* is
 * the subject under test, so it is written per run rather than reused.
 */
const DAEMON_ENTRY = `import { main } from ${JSON.stringify(GATEWAY_CLI)};
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

describe("command dispatch", () => {
  test("refuses an unrecognised verb rather than dispatching a neighbour", async () => {
    // `omp-gateway ""` is what an unset shell variable expands to, and `-h` is what an operator
    // types before reading the usage text; neither may resolve to a command.
    for (const verb of ["bogus", "uninstal", "roll-back", "Serve", "install-service", "-h", "--hlep", ""]) {
      await expect(main([verb])).rejects.toThrow(`unknown command: ${verb}`);
    }
  });

  test("reports the unknown verb, not its options, when both are wrong", async () => {
    // `validateCommandOptions` returns early for commands it does not know. A mistyped verb must
    // therefore surface as a verb problem, or the operator retypes the option and stays stuck.
    await expect(main(["uninstal", "--no-stop"])).rejects.toThrow("unknown command: uninstal");
    await expect(main(["rollbak", "--to=0.1.0-0123456789ab"])).rejects.toThrow("unknown command: rollbak");
    await expect(main(["insatll", "--origin=https://gateway.example.ts.net"])).rejects.toThrow(
      "unknown command: insatll",
    );
  });

  test("exits non-zero on an unknown verb without creating gateway state", async () => {
    const run = await runCli(["uninstal"]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("unknown command: uninstal");
    expect(run.artifacts).toEqual([]);
  }, 10_000);
});

describe("per-command option table", () => {
  test("every command refuses another command's options and an invented one", async () => {
    for (const [command, own] of Object.entries(COMMAND_SURFACE)) {
      for (const option of [...EVERY_OPTION, "--not-an-option"]) {
        if (own.includes(option)) continue;
        await expect(main([command, `${option}=value`])).rejects.toThrow(`unknown option for ${command}: ${option}`);
      }
    }
  });

  test("each command's own options reach its handler instead of being refused as unknown", async () => {
    // Without this control the loop above would still pass if the table refused everything. Each
    // shape below carries all of a command's own options and is refused for a *later*, in-process
    // reason, which proves the option names themselves were accepted.
    // `doctor` has no such shape: `runDoctorChecks` spawns `tailscale` and reaches the network
    // before its options are read, so its accepted-option side stays uncovered *here*. It is
    // covered offline in `doctor JSON contract` below, where a config-less sandbox makes
    // `runDoctorChecks` return before it probes anything.
    await expect(
      main([
        "serve",
        "--dev-localhost",
        "--port=4317",
        "--origin=http://127.0.0.1:4317",
        "--readiness-instance=short",
      ]),
    ).rejects.toThrow("--readiness-instance must be a 256-bit base64url value");
    await expect(main(["install", "--allow=user@example.com", "--port=4317", "--no-start"])).rejects.toThrow(
      "install requires --origin",
    );
    await expect(main(["uninstall", "--no-stop=yes"])).rejects.toThrow("--no-stop does not accept a value");
    await expect(main(["rollback", "--to"])).rejects.toThrow("--to requires a value");
  });

  test("usage advertises exactly the commands whose options are validated", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    // `omp-gatewayd` is the daemon binary, not a verb, so it must not match.
    const advertised = [...stdout.matchAll(/^\s+omp-gateway ([a-z-]+)/gmu)].flatMap(match => match[1] ?? []);
    expect(advertised.length).toBeGreaterThan(0);
    expect([...new Set(advertised)].sort()).toEqual(
      Object.keys(COMMAND_SURFACE)
        .filter(command => command !== "help" && command !== "--help")
        .sort(),
    );
  }, 10_000);
});

describe("option arity and values", () => {
  test("refuses every value-taking option when its value is absent", async () => {
    // `--output` is missing from this list because `runDoctor` only reads it inside the `--bundle`
    // branch, after `runDoctorChecks` has run. That refusal is covered in `doctor JSON contract`
    // below, where a config-less sandbox makes those checks return without touching the network.
    const missing: readonly (readonly [string[], string])[] = [
      [["serve", "--port"], "--port requires a value"],
      [["serve", "--origin"], "--origin requires a value"],
      [["serve", "--readiness-instance"], "--readiness-instance requires a value"],
      [["install", "--origin"], "--origin requires a value"],
      [["install", "--origin=https://gateway.example.ts.net", "--allow"], "--allow requires a value"],
      [["install", "--origin=https://gateway.example.ts.net", "--port"], "--port requires a value"],
      [["rollback", "--to"], "--to requires a value"],
    ];
    for (const [argv, message] of missing) {
      await expect(main(argv)).rejects.toThrow(message);
    }
  });

  test("never swallows the next option as the previous option's value", async () => {
    await expect(main(["serve", "--port", "--origin=http://127.0.0.1:4317"])).rejects.toThrow(
      "--port requires a value",
    );
    await expect(main(["serve", "--origin", "--dev-localhost"])).rejects.toThrow("--origin requires a value");
    // A later value for the same option does not rescue the bare one: the sentinel wins over arity.
    await expect(main(["rollback", "--to", "--to=0.1.0-0123456789ab"])).rejects.toThrow("--to requires a value");
  });

  test("refuses an unknown option before complaining that a known one lacks a value", async () => {
    // Ordering matters for the destructive verbs: the table is checked before any handler runs, so
    // `uninstall --force` must never reach `uninstallUserService`.
    await expect(main(["uninstall", "--force"])).rejects.toThrow("unknown option for uninstall: --force");
    await expect(main(["serve", "--allow"])).rejects.toThrow("unknown option for serve: --allow");
  });

  test("refuses a repeated single-valued option instead of silently picking one", async () => {
    const repeated: readonly (readonly [string[], string])[] = [
      [["serve", "--port=4317", "--port=4318"], "--port may be supplied once"],
      [["serve", "--origin=http://127.0.0.1:4317", "--origin=http://127.0.0.1:4318"], "--origin may be supplied once"],
      [["serve", "--dev-localhost", "--dev-localhost"], "--dev-localhost may be supplied once"],
      [["serve", "--readiness-instance=a", "--readiness-instance=b"], "--readiness-instance may be supplied once"],
      [
        ["install", "--origin=https://gateway.example.ts.net", "--origin=https://other.example.ts.net"],
        "--origin may be supplied once",
      ],
      [["uninstall", "--no-stop", "--no-stop"], "--no-stop may be supplied once"],
      [["rollback", "--to=0.1.0-0123456789ab", "--to=0.1.0-ba9876543210"], "--to may be supplied once"],
    ];
    for (const [argv, message] of repeated) {
      await expect(main(argv)).rejects.toThrow(message);
    }
    // `--allow` is the one option that accumulates: repeating it must not be an arity error. The
    // refusal here is the absent `--origin`, which is only reached once both values are accepted.
    await expect(main(["install", "--allow=user@example.com", "--allow=other@example.com"])).rejects.toThrow(
      "install requires --origin",
    );
  });

  test("refuses a bare positional argument after the command", async () => {
    await expect(main(["serve", "port"])).rejects.toThrow("unexpected argument: port");
    await expect(main(["install", "--origin", "https://gateway.example.ts.net", "extra"])).rejects.toThrow(
      "unexpected argument: extra",
    );
  });
});

describe("numeric options", () => {
  test("refuses a --port that is not a bare decimal integer", async () => {
    for (const value of ["abc", "-1", "1.5", "4317.0", " 4317", "4317 ", "+4317", "4_317", "1e3", "0x10ed", "٤٣١٧"]) {
      await expect(main(["serve", `--port=${value}`])).rejects.toThrow("--port must be an integer");
    }
    // A negative supplied as its own token is the shape an operator actually types, and it exercises
    // the parser branch that treats a non-`--` token as the value.
    await expect(main(["serve", "--port", "-1"])).rejects.toThrow("--port must be an integer");
  });

  test("distinguishes an empty value from an absent one", async () => {
    await expect(main(["serve", "--port="])).rejects.toThrow("--port must be an integer");
    await expect(main(["serve", "--port"])).rejects.toThrow("--port requires a value");
  });

  test("refuses an out-of-range --port before writing config or token material", async () => {
    // 0 and 65536 straddle `validatePort`; both are integers, so only the range check can catch them.
    for (const port of ["0", "65536"]) {
      const run = await runCli(["serve", "--dev-localhost", `--port=${port}`]);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("http.port must be an integer from 1 to 65535");
      expect(run.artifacts).toEqual([]);
    }
  }, 20_000);
});

describe("usage and daemon invocation", () => {
  test("--help and a bare invocation print the same usage, exit zero, and write nothing", async () => {
    const [help, bare] = await Promise.all([runCli(["--help"]), runCli([])]);
    expect(help.exitCode).toBe(0);
    expect(bare.exitCode).toBe(0);
    expect(help.stdout).toStartWith(`OMP Session Gateway ${GATEWAY_VERSION}`);
    expect(help.stdout).toContain("Usage:");
    expect(bare.stdout).toBe(help.stdout);
    expect(help.artifacts).toEqual([]);
    expect(bare.artifacts).toEqual([]);
  }, 15_000);

  test("a bare invocation means serve only under the daemon binary name", async () => {
    // The substitution keys off `basename(process.argv[1])`, so the only way to exercise it is to
    // enter `main` through a file with that name. Nothing binds: the sandbox has no config file, so
    // the `tailscale-serve` defaults are refused before any listener or file is created.
    const daemon = await runInSandbox(async root => {
      await writeFile(join(root, "omp-gatewayd"), DAEMON_ENTRY);
      return [process.execPath, join(root, "omp-gatewayd")];
    });
    expect(daemon.exitCode).toBe(1);
    expect(daemon.stderr).toContain("tailscale-serve mode requires an exact HTTPS public origin");
    expect(daemon.artifacts).toEqual([]);

    const other = await runInSandbox(async root => {
      await writeFile(join(root, "omp-gateway"), DAEMON_ENTRY);
      return [process.execPath, join(root, "omp-gateway")];
    });
    expect(other.exitCode).toBe(0);
    expect(other.stdout).toContain("Usage:");
    expect(other.artifacts).toEqual([]);
  }, 15_000);
});

describe("destructive verbs", () => {
  test("uninstall refuses a malformed --no-stop before stopping the service", async () => {
    await expect(main(["uninstall", "--no-stop=yes"])).rejects.toThrow("--no-stop does not accept a value");
    await expect(main(["uninstall", "--no-stop=false"])).rejects.toThrow("--no-stop does not accept a value");
    await expect(main(["uninstall", "--no-stop", "--no-stop"])).rejects.toThrow("--no-stop may be supplied once");
    await expect(main(["uninstall", "--to=0.1.0-0123456789ab"])).rejects.toThrow("unknown option for uninstall: --to");
    await expect(main(["uninstall", "yes"])).rejects.toThrow("unexpected argument: yes");
  });

  test("rollback refuses a malformed --to before reading any service state", async () => {
    // `runRollback` reads `--to` first and only then loads the config and the live service status,
    // so these refusals are the ones reachable without an installed gateway. The refusals that do
    // need one — an unmanaged active service, a missing installation, and an unresolvable target —
    // are left uncovered rather than faked, because `userServiceStatus` reads the real OS service
    // even when every path is redirected into a sandbox.
    await expect(main(["rollback", "--to"])).rejects.toThrow("--to requires a value");
    await expect(main(["rollback", "--to=", "--to=0.1.0-0123456789ab"])).rejects.toThrow(
      "--to may be supplied once",
    );
    await expect(main(["rollback", "--no-start"])).rejects.toThrow("unknown option for rollback: --no-start");
    await expect(main(["rollback", "--bundle=1"])).rejects.toThrow("unknown option for rollback: --bundle");
    await expect(main(["rollback", "0.1.0-0123456789ab"])).rejects.toThrow(
      "unexpected argument: 0.1.0-0123456789ab",
    );
  });
});

/**
 * Gateway-owned paths inside a sandbox root, relative to it, matched as plain string prefixes: the
 * darwin runtime directory carries a uid suffix (`tmp/omp-session-gateway-<uid>`). Deliberately narrow
 * rather than a whole-tree comparison, because Bun populates `home/Library/Caches` in every sandbox
 * whether or not the CLI writes anything. The diagnostics bundle is listed because its default
 * destination is relative to the working directory, which these runs point at the sandbox root.
 */
const GATEWAY_OWNED_PREFIXES: readonly string[] = [
  "config",
  "state",
  "run",
  "tmp/omp-session-gateway",
  "home/Library/LaunchAgents",
  "omp-gateway-diagnostics.tar",
];

/**
 * Content-addressed inventory of everything the gateway owns in a sandbox. Compared before and
 * after a run, it turns "this verb refused" into "this verb refused and changed nothing" — the
 * property that separates a guard from a guard that fires too late.
 */
async function gatewayState(root: string): Promise<readonly string[]> {
  const entries = (await readdir(root, { recursive: true }))
    .map(entry => entry.replaceAll("\\", "/"))
    .filter(entry => GATEWAY_OWNED_PREFIXES.some(prefix => entry.startsWith(prefix)))
    .sort();
  const rows: string[] = [];
  for (const entry of entries) {
    const info = await lstat(join(root, entry));
    if (!info.isFile()) {
      rows.push(`${entry}${info.isDirectory() ? "/" : " (non-file)"}`);
      continue;
    }
    const digest = createHash("sha256").update(await readFile(join(root, entry))).digest("hex").slice(0, 16);
    rows.push(`${entry} ${(info.mode & 0o777).toString(8)} ${digest}`);
  }
  return rows;
}

interface SandboxSeed {
  /** Written to `config.json`; omitted leaves the sandbox with no config file at all. */
  readonly config?: Record<string, unknown>;
  readonly token?: string;
  /** Permissions for the token file. Anything group- or world-readable must be refused. */
  readonly tokenMode?: number;
  /** Version directories to create under the installation versions root. */
  readonly versions?: readonly string[];
  /** The version `current.json` names as active; omitted writes no pointer. */
  readonly pointer?: string;
  /** `history.json` activations, oldest first; omitted writes no history. */
  readonly history?: readonly string[];
  /** The version whose CLI the LaunchAgent plist executes; omitted installs no definition. */
  readonly definitionVersion?: string;
}

async function writePrivateFile(path: string, content: string, mode: number): Promise<void> {
  await writeFile(path, content);
  await chmod(path, mode);
}

async function seedSandbox(root: string, seed: SandboxSeed): Promise<void> {
  // Mirrors `defaultGatewayPaths()` under `sandboxEnvironment`. The runtime directory is present
  // for the `Pick<GatewayConfig, "paths">` shape and is read by nothing asserted here.
  const configDir = join(root, "config", "omp-session-gateway");
  const paths: GatewayConfig["paths"] = {
    configDir,
    stateDir: join(root, "state", "omp-session-gateway"),
    runtimeDir: join(root, "tmp", "omp-session-gateway"),
    tokenPath: join(configDir, "readiness-token"),
    configPath: join(configDir, "config.json"),
  };
  // Mirroring is the hazard. If `defaultGatewayPaths()` ever derives a different layout from this
  // same environment, every seeded run would write one place and assert another, and the suite would
  // stay green while measuring nothing. Deriving it for real and comparing is what makes the mirror
  // falsifiable. It also catches the sharper failure: a derivation that stops honouring the
  // environment escapes the sandbox entirely, which on 2026-08-21 let a sibling suite's mutation
  // experiment overwrite a live operator config.
  const ambient = defaultGatewayPaths();
  const saved = { ...process.env };
  let sandboxDerived: GatewayConfig["paths"];
  try {
    Object.assign(process.env, sandboxEnvironment(root));
    sandboxDerived = defaultGatewayPaths();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  expect(sandboxDerived.configPath).toBe(paths.configPath);
  expect(sandboxDerived.stateDir).toBe(paths.stateDir);
  expect(sandboxDerived.tokenPath).toBe(paths.tokenPath);
  // And the ambient derivation must land somewhere else entirely, or the sandbox is not one.
  expect(ambient.configPath.startsWith(root)).toBe(false);
  const installation = join(paths.stateDir, "installation");
  const versions = join(installation, "versions");
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  if (seed.config !== undefined) await writePrivateFile(paths.configPath, `${JSON.stringify(seed.config)}\n`, 0o600);
  if (seed.token !== undefined) await writePrivateFile(paths.tokenPath, `${seed.token}\n`, seed.tokenMode ?? 0o600);
  for (const version of seed.versions ?? []) await mkdir(join(versions, version), { recursive: true, mode: 0o700 });
  if (seed.pointer !== undefined || seed.history !== undefined) {
    await mkdir(installation, { recursive: true, mode: 0o700 });
  }
  if (seed.pointer !== undefined) {
    const pointer = `${JSON.stringify({ versionDirectory: seed.pointer })}\n`;
    await writePrivateFile(join(installation, "current.json"), pointer, 0o600);
  }
  if (seed.history !== undefined) {
    const history = `${JSON.stringify({ activations: seed.history })}\n`;
    await writePrivateFile(join(installation, "history.json"), history, 0o600);
  }
  if (seed.definitionVersion !== undefined) {
    const definitionPath = join(root, "home", "Library", "LaunchAgents", "omp-session-gateway.plist");
    await mkdir(dirname(definitionPath), { recursive: true });
    // Rendered by the production renderer, so the version marker `activationState` reads cannot
    // drift from the one `installUserService` would have written.
    const installedCli = join(versions, seed.definitionVersion, "apps", "gateway", "src", "cli.ts");
    await writeFile(definitionPath, serviceDefinition({ paths }, "darwin", installedCli).content);
  }
}

interface SeededRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** Gateway-owned sandbox state as seeded, and as the run left it. */
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/**
 * Runs the CLI against a pre-seeded installation. The working directory is the sandbox root rather
 * than the repository, so a relative write the CLI performs — the diagnostics bundle's default
 * destination is one — lands where `gatewayState` can see it instead of in the checkout.
 */
async function runSeeded(seed: SandboxSeed, argv: readonly string[], deadlineMs = 15_000): Promise<SeededRun> {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-state-"));
  try {
    await seedSandbox(root, seed);
    const before = await gatewayState(root);
    const started = Date.now();
    const subprocess = Bun.spawn([process.execPath, GATEWAY_CLI, ...argv], {
      cwd: root,
      env: sandboxEnvironment(root),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // A real deadline, not a guessed settling delay: the subject is a spawned process, so there
      // is no clock to fake, and the only thing this races is a hang. The passing path never waits,
      // because `exited` wins as soon as the process is gone.
      const exited = await Promise.race([
        subprocess.exited.then(() => true),
        Bun.sleep(deadlineMs).then(() => false),
      ]);
      if (!exited) subprocess.kill(9);
      const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      const exitCode = await subprocess.exited;
      const durationMs = Date.now() - started;
      if (!exited) throw new Error(`the gateway CLI never exited within ${deadlineMs}ms: ${stderr}`);
      return { exitCode, stdout, stderr, durationMs, before, after: await gatewayState(root) };
    } finally {
      if (subprocess.exitCode === null) subprocess.kill(9);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const DARWIN = process.platform === "darwin";
const POSIX = process.platform !== "win32";

/** Version directory names, shaped the way `stageRuntimePayload` names them. */
const ACTIVE_VERSION = "0.1.0-1111aaaa2222";
const PRIOR_VERSION = "0.1.0-3333bbbb4444";
const ABSENT_VERSION = "0.1.0-5555cccc6666";

/** Synthetic, and shaped like a readiness token so the private-file guards accept it. */
const SEEDED_TOKEN = "synthetic-readiness-token-DO-NOT-SHIP-00000";

const TAILSCALE_SERVE_CONFIG: Record<string, unknown> = {
  http: { publicOrigin: "https://gateway.example.ts.net" },
  auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"] },
};

/**
 * `dev-localhost` is the one mode whose public origin is not free-standing: `parseConfigObject`
 * requires it to equal the loopback origin of the configured port, so the two move together.
 */
function devLocalhostConfig(port: number): Record<string, unknown> {
  return {
    http: { hostname: "127.0.0.1", port, publicOrigin: `http://127.0.0.1:${port}` },
    auth: { mode: "dev-localhost", allowedLogins: [] },
  };
}

/** The `instance-v1` proof a live daemon returns: HMAC over challenge, NUL, instance. */
function readinessProof(token: string, challenge: string, instance = ""): string {
  return createHmac("sha256", token).update(challenge).update("\0").update(instance).digest("base64url");
}

/**
 * `runRollback` is the destructive verb, and everything it does past its guards drives the real
 * service manager. The guards are the part an operator actually meets, and they have to name the
 * *first* thing that is wrong without touching a byte on the way out.
 *
 * The seeded fixture reaches them without a service manager because darwin's `installed` is the
 * presence of `$HOME/Library/LaunchAgents/omp-session-gateway.plist` and nothing more, while
 * `active` compares the loaded job's program path against this sandbox's state directory and is
 * therefore false even on a machine whose real gateway is running. Linux additionally needs
 * `systemctl --user is-enabled` to agree and Windows needs `schtasks /Query`, so the
 * installed-service half below is darwin-only rather than faked.
 *
 * Left uncovered: `refusing rollback while an unmanaged gateway service is active`. That needs
 * `active` true, which means the OS holding a loaded job whose program lives under the sandbox
 * root — a real service manager mutation on the machine running the suite.
 */
describe("rollback refusals against a seeded installation", () => {
  test("refuses without an installed service even when the target would resolve", async () => {
    // A fixture that would roll back cleanly if a service were installed: two versions, a pointer,
    // and a recorded predecessor. The refusal must still be about the missing service, or the
    // operator is sent to fix the wrong thing.
    for (const argv of [["rollback"], ["rollback", `--to=${PRIOR_VERSION}`]]) {
      const run = await runSeeded(
        {
          config: TAILSCALE_SERVE_CONFIG,
          token: SEEDED_TOKEN,
          versions: [PRIOR_VERSION, ACTIVE_VERSION],
          pointer: ACTIVE_VERSION,
          history: [PRIOR_VERSION, ACTIVE_VERSION],
        },
        argv,
      );
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("refusing rollback without an installed gateway service");
      expect(run.after).toEqual(run.before);
    }
  }, 30_000);

  const REFUSALS: readonly {
    readonly name: string;
    readonly seed: SandboxSeed;
    readonly argv: readonly string[];
    readonly message: string;
    /** A refusal a wrong guard order would have reported instead of `message`. */
    readonly outranked?: string;
  }[] = [
    {
      name: "nothing was ever activated",
      seed: { versions: [PRIOR_VERSION, ACTIVE_VERSION] },
      argv: ["rollback"],
      message: "refusing rollback without an active installed runtime",
    },
    {
      name: "a missing pointer outranks a malformed --to",
      seed: { versions: [PRIOR_VERSION, ACTIVE_VERSION] },
      argv: ["rollback", "--to=../../etc"],
      message: "refusing rollback without an active installed runtime",
      outranked: "malformed version directory",
    },
    {
      name: "a sole installed version outranks a malformed --to",
      seed: { versions: [ACTIVE_VERSION], pointer: ACTIVE_VERSION },
      argv: ["rollback", "--to=../../etc"],
      message: `refusing rollback: ${ACTIVE_VERSION} is the only installed version`,
      outranked: "malformed version directory",
    },
    {
      name: "a --to that is not a version directory name",
      seed: { versions: [PRIOR_VERSION, ACTIVE_VERSION], pointer: ACTIVE_VERSION },
      argv: ["rollback", "--to=0.1.0"],
      message: "refusing rollback to a malformed version directory: 0.1.0",
    },
    {
      name: "a well-formed --to that is not installed",
      seed: { versions: [PRIOR_VERSION, ACTIVE_VERSION], pointer: ACTIVE_VERSION },
      argv: ["rollback", "--to=0.1.0-000000000000"],
      message: "refusing rollback to a version that is not installed: 0.1.0-000000000000",
    },
    {
      name: "a --to naming the version already active",
      seed: { versions: [PRIOR_VERSION, ACTIVE_VERSION], pointer: ACTIVE_VERSION },
      argv: ["rollback", `--to=${ACTIVE_VERSION}`],
      message: `refusing rollback to the active version: ${ACTIVE_VERSION}`,
    },
    {
      name: "no activation is recorded for the version the pointer names",
      seed: { versions: [PRIOR_VERSION, ACTIVE_VERSION], pointer: ACTIVE_VERSION },
      argv: ["rollback"],
      message: `no activation of the active version ${ACTIVE_VERSION} is recorded`,
    },
    {
      name: "the recorded predecessor is no longer installed",
      seed: {
        versions: [PRIOR_VERSION, ACTIVE_VERSION],
        pointer: ACTIVE_VERSION,
        history: [ABSENT_VERSION, ACTIVE_VERSION],
      },
      argv: ["rollback"],
      message: `recorded predecessor ${ABSENT_VERSION} is no longer installed`,
    },
  ];

  for (const refusal of REFUSALS) {
    test.skipIf(!DARWIN)(`refuses and mutates nothing when ${refusal.name}`, async () => {
      const run = await runSeeded(
        { ...refusal.seed, config: TAILSCALE_SERVE_CONFIG, token: SEEDED_TOKEN, definitionVersion: ACTIVE_VERSION },
        refusal.argv,
      );
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(refusal.message);
      if (refusal.outranked !== undefined) expect(run.stderr).not.toContain(refusal.outranked);
      // Nothing may move before the target is known: not the pointer, not the service definition,
      // and not the runtime directory `loadReadinessToken` would create one line later.
      expect(run.after).toEqual(run.before);
    }, 30_000);
  }
});

/**
 * `status` is consumed by the qualification lanes and by CI, so its stdout is a contract: one JSON
 * object, the documented keys, and every word meant for a human on stderr.
 *
 * These status fixtures never mutate the OS service manager. The install-pruning fixtures below
 * exercise readiness and compensation using a child-local service adapter and real HTTP proofs;
 * full launchd/systemd/Task Scheduler lifecycle remains the qualification lanes' responsibility.
 */
describe("status JSON contract", () => {
  test.skipIf(!DARWIN)("reports a proven readiness flag, both versions, and divergence on stderr", async () => {
    // A stand-in for the daemon's readiness endpoint, on an ephemeral port the seeded config then
    // names, so nothing here depends on a fixed port or reaches the developer's own gateway.
    const daemon = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: request =>
        Response.json({
          status: "ready",
          proof: readinessProof(SEEDED_TOKEN, request.headers.get("X-OMP-Readiness-Challenge") ?? ""),
        }),
    });
    try {
      const run = await runSeeded(
        {
          config: devLocalhostConfig(daemon.port ?? 0),
          token: SEEDED_TOKEN,
          versions: [PRIOR_VERSION, ACTIVE_VERSION],
          // The one reachable divergence: the definition names a newer version than the pointer.
          pointer: PRIOR_VERSION,
          history: [PRIOR_VERSION],
          definitionVersion: ACTIVE_VERSION,
        },
        ["status"],
      );
      const lines = run.stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        service: "omp-session-gateway",
        installed: true,
        active: false,
        ready: true,
        authMode: "dev-localhost",
        activeVersion: PRIOR_VERSION,
        serviceVersion: ACTIVE_VERSION,
        diverged: true,
      });
      // The guidance is advice for a human and must stay out of the document CI parses.
      expect(run.stderr).toContain("DIVERGED");
      expect(run.stdout).not.toContain("DIVERGED");
      expect(run.exitCode).toBe(1);
    } finally {
      daemon.stop(true);
    }
  }, 30_000);

  /**
   * Only a valid proof may set `ready`. Each listener below is a shape a loopback port squatter or a
   * half-dead daemon actually produces, and the contrast with the case above is what makes the flag
   * mean anything: a `status` that hardcoded `ready: true` would pass one of these tests, not both.
   */
  const NOT_READY: Readonly<Record<string, () => Response>> = {
    "a daemon that reports itself degraded": () =>
      Response.json({ status: "degraded", proof: readinessProof(SEEDED_TOKEN, "") }),
    "a ready claim signed with the wrong token": () =>
      Response.json({ status: "ready", proof: readinessProof("W".repeat(43), "") }),
    "a ready claim carrying no proof at all": () => Response.json({ status: "ready" }),
    // What a daemon killed mid-response leaves on the wire: a plausible prefix and then nothing.
    "a body that stops mid-document": () =>
      new Response(
        new ReadableStream({
          start: controller => {
            controller.enqueue(new TextEncoder().encode('{"status":"ready","proof":"'));
            controller.close();
          },
        }),
      ),
    "a listener that answers nothing at all": () => new Response(new ReadableStream({ start: () => undefined })),
  };

  for (const [description, answer] of Object.entries(NOT_READY)) {
    test.skipIf(!POSIX)(`withholds ready, and still terminates, for ${description}`, async () => {
      const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
      try {
        const run = await runSeeded({ config: devLocalhostConfig(daemon.port ?? 0), token: SEEDED_TOKEN }, ["status"]);
        // Also the absent-installation shape: no pointer and no definition read as nulls rather
        // than as a divergence, which is what `uninstall` leaves behind.
        expect(JSON.parse(run.stdout.trimEnd())).toEqual({
          service: "omp-session-gateway",
          installed: false,
          active: false,
          ready: false,
          authMode: "dev-localhost",
          activeVersion: null,
          serviceVersion: null,
          diverged: false,
        });
        expect(run.exitCode).toBe(1);
        // `gatewayReady` bounds each probe at 1.5s. Without that bound the last listener above
        // holds the connection open forever and `status` never returns for the lane that called it.
        expect(run.durationMs).toBeLessThan(10_000);
      } finally {
        daemon.stop(true);
      }
    }, 30_000);
  }

  test.skipIf(!POSIX)("reports nothing at all when the readiness token is not private", async () => {
    const run = await runSeeded({ config: TAILSCALE_SERVE_CONFIG, token: SEEDED_TOKEN, tokenMode: 0o644 }, ["status"]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("unsafe private file permissions");
    // CI parses stdout. A half-written document would be worse than none.
    expect(run.stdout).toBe("");
  }, 30_000);
});

/**
 * `doctor`'s exit code is what the qualification lanes branch on. A sandbox with no config file is
 * the one shape that reaches the exit-code rule without a network: `runDoctorChecks` fails the
 * `config` check and returns before it probes the daemon, the relay, or `tailscale`.
 *
 * Left uncovered: the zero side of the rule. Every remaining check needs a live daemon, a real
 * service manager, and a connected tailnet at once, so "any check false implies non-zero" is
 * observable here while "all checks true implies zero" is not.
 */
describe("doctor JSON contract", () => {
  test("emits one parseable report and exits non-zero when a check is false", async () => {
    const run = await runSeeded({}, ["doctor"]);
    expect(run.exitCode).toBe(1);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0] ?? "") as { service: string; checks: Record<string, unknown> };
    expect(report.service).toBe("omp-session-gateway");
    expect(report.checks.discoveryReadable).toBe(false);
    expect(report.checks.sessionHealth).toBe(false);
    expect(report.checks.compatibility).toBe(false);
    expect(Object.values(report.checks).every(value => typeof value === "boolean")).toBe(true);
    expect(report.checks.config).toBe(false);
    // A report is a read: no bundle unless one was asked for, and no state either way.
    expect(run.after).toEqual(run.before);
  }, 30_000);

  test("refuses a malformed --bundle or --output without emitting a report", async () => {
    const refusals: readonly (readonly [readonly string[], string])[] = [
      [["doctor", "--bundle=yes"], "--bundle does not accept a value"],
      [["doctor", "--bundle", "--bundle"], "--bundle may be supplied once"],
      [["doctor", "--bundle", "--output"], "--output requires a value"],
      [["doctor", "--bundle", "--output=first.tar", "--output=second.tar"], "--output may be supplied once"],
    ];
    for (const [argv, message] of refusals) {
      const run = await runSeeded({}, argv);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(message);
      // The refusal lands after the checks have run, so silence on stdout is the assertion that
      // no half-report reached a lane that would have parsed it.
      expect(run.stdout).toBe("");
      expect(run.after).toEqual(run.before);
    }
  }, 60_000);
});

/**
 * The install-time readiness budget. Issue #90 was not a broken check: `install` created the Windows
 * Scheduled Task, the daemon ran for ~18 s and was still making progress, and a fixed 15 s deadline
 * rolled it back. The budget is therefore a platform policy with measured inputs, and both halves
 * need defending — Windows has to be long enough for a cold start, every other platform must not
 * have quietly gained 45 s of patience, and neither may become unbounded.
 *
 * `readinessBudgetMs` takes the platform as an argument and `pollUntilReady` takes its clock, so
 * both properties are asserted directly rather than by reassigning `process.platform` or by waiting
 * a real minute.
 */
describe("managed-service readiness budget", () => {
  /** Mean cold `Get-Acl` spawn on the 2-vCPU Server 2025 host in `docs/WINDOWS_QUALIFICATION.md`. */
  const WINDOWS_ACL_SPAWN_MS = 1_854;

  /** Spawns `runServe` reaches before `startHttpServer` binds; itemised at `READINESS_BUDGET_MS`. */
  const WINDOWS_STARTUP_SPAWNS = 10;

  /** The cadence `pollUntilReady` polls at, which is what fixes where the deadline falls. */
  const POLL_INTERVAL_MS = 100;

  /**
   * A probe that starts proving readiness once `readyAtMs` of virtual time has passed, paired with
   * the clock that measures it. Time moves only when the loop sleeps, so elapsed time and attempt
   * count are both exact and a 60 s budget costs no wall-clock time. `Infinity` is a dead service.
   */
  function probeReadyAt(readyAtMs: number) {
    let elapsed = 0;
    const attempts: number[] = [];
    return {
      attempts,
      clock: {
        now: () => elapsed,
        sleep: async (ms: number) => {
          elapsed += ms;
        },
      },
      probe: async () => {
        attempts.push(elapsed);
        return elapsed >= readyAtMs;
      },
    };
  }

  test("keeps 15 s everywhere except Windows, which gets 60 s", () => {
    expect(readinessBudgetMs("linux")).toBe(15_000);
    expect(readinessBudgetMs("darwin")).toBe(15_000);
    expect(readinessBudgetMs("freebsd")).toBe(15_000);
    expect(readinessBudgetMs("win32")).toBe(60_000);
  });

  test("polls to the last instant inside the budget and never past it", async () => {
    const budget = readinessBudgetMs("win32");
    const inside = probeReadyAt(budget - POLL_INTERVAL_MS);
    expect(await pollUntilReady(budget, inside.probe, inside.clock)).toBe(true);
    expect(inside.attempts.at(-1)).toBe(budget - POLL_INTERVAL_MS);

    // One millisecond later is unreachable: the final poll lands on the instant above, so readiness
    // appearing after it is never observed and the deadline holds.
    const outside = probeReadyAt(budget - POLL_INTERVAL_MS + 1);
    expect(await pollUntilReady(budget, outside.probe, outside.clock)).toBe(false);
  });

  test("gives up at the finite deadline when the service never answers", async () => {
    for (const platform of ["win32", "linux"] as const) {
      const budget = readinessBudgetMs(platform);
      const dead = probeReadyAt(Number.POSITIVE_INFINITY);
      expect(await pollUntilReady(budget, dead.probe, dead.clock)).toBe(false);
      // One probe per interval across the budget and none at or beyond it: the longer Windows wait
      // is a longer wait, not a retry loop that could outlive a service that will never bind.
      expect(dead.attempts).toHaveLength(budget / POLL_INTERVAL_MS);
      expect(dead.attempts.at(-1)).toBe(budget - POLL_INTERVAL_MS);
    }
  });

  test("admits the slow Windows start that #90 rolled back, and only on Windows", async () => {
    // The observed host: ~18 s of ACL spawns while alive and progressing, before it could bind.
    const coldStartMs = WINDOWS_STARTUP_SPAWNS * WINDOWS_ACL_SPAWN_MS;
    const onWindows = probeReadyAt(coldStartMs);
    expect(await pollUntilReady(readinessBudgetMs("win32"), onWindows.probe, onWindows.clock)).toBe(true);

    // The same start under the budget the other platforms kept: still refused, which is what makes
    // this a Windows-scoped change rather than a global loosening.
    const elsewhere = probeReadyAt(coldStartMs);
    expect(await pollUntilReady(readinessBudgetMs("linux"), elsewhere.probe, elsewhere.clock)).toBe(false);
  });

  test("returns on the first attempt without spending any of the budget", async () => {
    const immediate = probeReadyAt(0);
    expect(await pollUntilReady(readinessBudgetMs("win32"), immediate.probe, immediate.clock)).toBe(true);
    expect(immediate.attempts).toEqual([0]);
  });
});

/**
 * Run the real install/rollback CLI and filesystem in a child, replacing only the OS service
 * manager and release-input seams. Readiness still crosses a real authenticated HTTP endpoint;
 * no launchctl/systemctl/schtasks mutation or module mock escapes this disposable process.
 */
async function runPruningInstall(
  mode: "ready" | "not-ready" | "revert-failure" | "no-start" | "prune-failure",
): Promise<SandboxRun> {
  return runInSandbox(async root => {
    const entry = join(root, "install-fixture.ts");
    const modulePath = (name: string) => JSON.stringify(fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)));
    await writeFile(entry, String.raw`
import { mock } from "bun:test";
import { createHmac } from "node:crypto";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as installation from ${modulePath("installation")};
import * as service from ${modulePath("service")};
import { writeGatewayConfigFile } from ${modulePath("config")};
import { StaticAssetStore } from ${modulePath("static")};
const mode = ${JSON.stringify(mode)};
const sourceRoot = join(${JSON.stringify(root)}, "source");
const cliSource = join(sourceRoot, "cli.js");
for (const directory of ["apps/web/dist", "licenses/collab-web"]) {
  await mkdir(join(sourceRoot, directory), { recursive: true });
}
for (const path of ["LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "UPSTREAM.lock.json", "bun.lock",
  "licenses/collab-web/LICENSE", "apps/web/dist/index.html"]) {
  await writeFile(join(sourceRoot, path), "synthetic fixture");
}
let instance = "a".repeat(43);
let rejectReadiness = false;
const token = "synthetic-readiness-token-DO-NOT-SHIP-00000";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const challenge = request.headers.get("X-OMP-Readiness-Challenge") ?? "";
  if (!active || rejectReadiness) return new Response("unready", { status: 503 });
  const proof = createHmac("sha256", token).update(challenge).update("\0").update(instance).digest("base64url");
  return Response.json({ status: "ready", instance, proof });
}});
const config = await writeGatewayConfigFile({ publicOrigin: "https://gateway.example.ts.net",
  allowedLogins: ["user@example.com"], port: server.port });
await writeFile(config.paths.tokenPath, token + "\n", { mode: 0o600 });
const runtimes = [];
const stage = installation.stageRuntimePayload;
for (let index = 0; index < 35; index += 1) {
  await writeFile(cliSource, "console.log(" + index + ");\n");
  runtimes.push(await stage(config, { sourceRoot, cliSource }));
}
for (const index of [0, 1, 2, 1]) await installation.activateRuntime(config, runtimes[index]);
const versions = dirname(runtimes[0].directory);
const names = runtimes.map(runtime => basename(runtime.directory));
const render = service.serviceDefinition;
let active = mode !== "no-start";
let attempts = 0;
const before = (await readdir(versions)).sort();
const definition = render(config, process.platform, runtimes[1].cliPath);
await mkdir(dirname(definition.path), { recursive: true });
await writeFile(definition.path, definition.content);
let elapsed = 0;
Date.now = () => elapsed;
const sleep = Bun.sleep;
Bun.sleep = async ms => { elapsed += Number(ms); await sleep(0); };
mock.module(${modulePath("service")}, () => ({
  ...service,
  assertServiceInstallPreflight: async () => {},
  userServiceStatus: async () => ({ installed: true, active }),
  installUserService: async (cfg, start, cli, nextInstance) => {
    attempts += 1;
    active = start;
    instance = nextInstance;
    rejectReadiness = (mode === "not-ready" && attempts === 1) || mode === "revert-failure";
    const next = render(cfg, process.platform, cli, nextInstance);
    await writeFile(next.path, next.content);
    if (mode === "prune-failure") await chmod(versions, 0o500);
    return next;
  },
}));
mock.module(${modulePath("installation")}, () => ({
  ...installation,
  stageRuntimePayload: cfg => stage(cfg, { sourceRoot, cliSource }),
}));
StaticAssetStore.load = async () => ({});
try {
  const { main } = await import(${JSON.stringify(GATEWAY_CLI)});
  let failure = "";
  try {
    await main(["install", "--origin=https://gateway.example.ts.net", "--allow=user@example.com",
      ...(mode === "no-start" ? ["--no-start"] : [])]);
  } catch (error) { failure = error.message; }
  const after = (await readdir(versions)).sort();
  const current = basename((await installation.currentInstalledRuntime(config)).directory);
  const predecessor = basename((await installation.resolveRollbackTarget(config)).runtime.directory);
  let prunedTarget = "";
  try { await main(["rollback", "--to=" + names[0]]); } catch (error) { prunedTarget = error.message; }
  const afterRollback = (await readdir(versions)).sort();
  console.log(JSON.stringify({ before, after, afterRollback, current, predecessor, names, failure, prunedTarget }));
} finally {
  await chmod(versions, 0o700);
  server.stop(true);
}
`);
    return [process.execPath, entry];
  });
}

describe("install runtime pruning", () => {
  test("successful ready install retains only three distinct activations and preserves rollback", async () => {
    const run = await runPruningInstall("ready");
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    const state = JSON.parse(run.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(state.failure).toBe("");
    expect(state.after).toEqual([state.names[34], state.names[1], state.names[2]].sort());
    expect(state.current).toBe(state.names[34]);
    expect(state.predecessor).toBe(state.names[1]);
    expect(state.prunedTarget).toContain("version that is not installed");
    expect(run.stdout).toContain("retained 3, removed 32, failed 0");
  });

  test("failed readiness and successful revert prune no staged runtimes", async () => {
    const run = await runPruningInstall("not-ready");
    expect(run.exitCode).toBe(0);
    const state = JSON.parse(run.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(state.failure).toBe("service installed but the loopback readiness proof did not become valid");
    expect(state.after).toEqual(state.before);
    expect(state.current).toBe(state.names[1]);
    expect(state.predecessor).toBe(state.names[2]);
  });

  test("no-start install leaves every staged runtime available", async () => {
    const run = await runPruningInstall("no-start");
    expect(run.exitCode).toBe(0);
    const state = JSON.parse(run.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(state.failure).toBe("");
    expect(state.after).toEqual(state.before);
    expect(state.afterRollback).toEqual(state.before);
    expect(state.current).toBe(state.names[34]);
  });

  test("failed readiness and incomplete revert leave every runtime available", async () => {
    const run = await runPruningInstall("revert-failure");
    expect(run.exitCode).toBe(0);
    const state = JSON.parse(run.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(state.failure).toBe("gateway install failed and rollback was incomplete");
    expect(state.after).toEqual(state.before);
    expect(state.current).toBe(state.names[1]);
  });

  test.skipIf(!POSIX)("pruning failure does not fail or revert a ready install", async () => {
    const run = await runPruningInstall("prune-failure");
    expect(run.exitCode).toBe(0);
    const state = JSON.parse(run.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(state.failure).toBe("");
    expect(state.after).toEqual(state.before);
    expect(state.current).toBe(state.names[34]);
    expect(state.predecessor).toBe(state.names[1]);
    expect(run.stdout).toContain("retained 3, removed 0, failed 32");
  });
});

async function runFleetRollback(
  version: string,
  mode: "success" | "existing-backup" | "failed-start" = "success",
  authored: "all" | "defaults" | "none" = "all",
): Promise<SandboxRun> {
  return runInSandbox(async root => {
    const entry = join(root, "rollback-fixture.ts");
    const modulePath = (name: string) => JSON.stringify(fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)));
    await writeFile(entry, String.raw`
import { mock } from "bun:test";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as installation from ${modulePath("installation")};
import * as service from ${modulePath("service")};
import { loadGatewayConfig, loadOrCreateReadinessToken, writeGatewayConfigFile, writePrivateTextFile } from ${modulePath("config")};
const root = ${JSON.stringify(root)};
const mode = ${JSON.stringify(mode)};
const authored = ${JSON.stringify(authored)};
let config = await writeGatewayConfigFile({
  publicOrigin: "https://studio.example.ts.net", allowedLogins: ["user@example.com"],
});
const document = JSON.parse(await readFile(config.paths.configPath, "utf8"));
if (authored !== "none") {
  document.http.trustedDashboardOrigins = authored === "all" ? ["https://dashboard.example.ts.net"] : [];
  document.fleet = authored === "all" ? {
    label: " Authored studio ", targets: [{ id: "remote", label: "Remote", origin: "https://remote.example.ts.net" }],
  } : {};
  document.speech = { browserRecognition: authored === "all" };
}
const before = JSON.stringify(document) + " \n";
await writePrivateTextFile(config.paths.configPath, before);
config = await loadGatewayConfig();
await loadOrCreateReadinessToken(config);
const backupPath = join(config.paths.configDir, "config.pre-rollback.json");
if (mode === "existing-backup") await writePrivateTextFile(backupPath, "earlier backup\n");
const runtime = {
  directory: join(root, ${JSON.stringify(version + "-000000000001")}),
  cliPath: join(root, "retained-cli.js"), readinessProtocol: "instance-v1",
};
const authoritative = {
  directory: join(root, "0.8.0-000000000002"),
  cliPath: join(root, "current-cli.js"), readinessProtocol: "instance-v1",
};
const installed = [];
let activated = false;
mock.module(${modulePath("service")}, () => ({
  ...service,
  userServiceStatus: async () => ({ installed: true, active: false }),
  installUserService: async (cfg, start, cli) => {
    installed.push({ cli, document: JSON.parse(await readFile(cfg.paths.configPath, "utf8")) });
    if (mode === "failed-start" && installed.length === 1) throw new Error("synthetic service failure");
    return { identifier: "omp-session-gateway" };
  },
}));
mock.module(${modulePath("installation")}, () => ({
  ...installation,
  resolveRollbackTarget: async () => ({ from: "current", runtime, selection: "explicit" }),
  currentInstalledRuntime: async () => authoritative,
  activateRuntime: async () => { activated = true; },
}));
const { main } = await import(${JSON.stringify(GATEWAY_CLI)});
let failure = "";
try { await main(["rollback"]); } catch (error) { failure = error.message; }
let backup = null;
let backupMode = null;
try {
  backup = await readFile(backupPath, "utf8");
  backupMode = (await lstat(backupPath)).mode & 0o777;
} catch (error) { if (error.code !== "ENOENT") throw error; }
console.log(JSON.stringify({
  before, after: await readFile(config.paths.configPath, "utf8"), backup, backupMode, installed, activated, failure,
}));
`);
    return [process.execPath, entry];
  });
}

describe("rollback fleet configuration projection", () => {
  test("backs up full authored bytes before older runtime activation and explains restoration", async () => {
    const run = await runFleetRollback("0.7.8");
    expect(run.exitCode).toBe(0);
    const state = JSON.parse(run.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(state.failure).toBe("");
    expect(state.backup).toBe(state.before);
    if (POSIX) expect(state.backupMode).toBe(0o600);
    const projected = JSON.parse(state.after);
    expect(projected.http.trustedDashboardOrigins).toBeUndefined();
    expect(projected.fleet).toBeUndefined();
    expect(projected.speech).toBeUndefined();
    expect(projected.auth).toEqual(JSON.parse(state.before).auth);
    expect(state.installed).toHaveLength(1);
    expect(state.installed[0].document).toEqual(projected);
    expect(state.activated).toBe(true);
    expect(run.stdout).toContain("removed http.trustedDashboardOrigins, fleet, speech");
    expect(run.stdout).toContain("To restore: first install 0.8.0 or newer");
    expect(run.stdout).toContain("restart the gateway, and reload the PWA");
    expect(run.stdout).not.toContain("Configuration and readiness token were preserved.");
  });

  test("treats authored empty/default fields as incompatible, but leaves legacy files byte-identical", async () => {
    const defaults = await runFleetRollback("0.8.0-beta.1", "success", "defaults");
    const projected = JSON.parse(defaults.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(projected.failure).toBe("");
    expect(projected.backup).toBe(projected.before);
    expect(JSON.parse(projected.after).fleet).toBeUndefined();
    const legacy = await runFleetRollback("0.7.8", "success", "none");
    const unchanged = JSON.parse(legacy.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(unchanged.failure).toBe("");
    expect(unchanged.after).toBe(unchanged.before);
    expect(unchanged.backup).toBeNull();
  });

  test("keeps authored fields for runtimes at or newer than the fleet boundary", async () => {
    for (const version of ["0.8.0", "0.9.0"]) {
      const run = await runFleetRollback(version);
      const state = JSON.parse(run.stdout.trimEnd().split("\n").at(-1) ?? "");
      expect(state.failure).toBe("");
      expect(state.after).toBe(state.before);
      expect(state.backup).toBeNull();
      expect(state.installed[0].document).toEqual(JSON.parse(state.before));
      expect(run.stdout).toContain("Configuration and readiness token were preserved.");
    }
  });

  test("refuses an existing backup before configuration or service mutation", async () => {
    const run = await runFleetRollback("0.7.8", "existing-backup");
    const state = JSON.parse(run.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(state.failure).toContain("already exists; restore or move that backup first");
    expect(state.after).toBe(state.before);
    expect(state.backup).toBe("earlier backup\n");
    expect(state.installed).toEqual([]);
    expect(state.activated).toBe(false);
  });

  test("restores authored bytes before repairing the current service after a failed rollback", async () => {
    const run = await runFleetRollback("0.7.8", "failed-start");
    const state = JSON.parse(run.stdout.trimEnd().split("\n").at(-1) ?? "");
    expect(state.failure).toBe("synthetic service failure");
    expect(state.after).toBe(state.before);
    expect(state.backup).toBe(state.before);
    expect(state.installed).toHaveLength(2);
    expect(state.installed[0].document.fleet).toBeUndefined();
    expect(state.installed[1].document).toEqual(JSON.parse(state.before));
    expect(state.activated).toBe(false);
    expect(run.stdout).toContain("Rollback failed; restored the authored configuration.");
  });
});
