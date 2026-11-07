import { expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fleetPushFixture, fleetPushSource, fleetFixtureDiagnostic, FLEET_PUSH_BACKEND_PORT, FLEET_PUSH_HTTPS_PORT } from "./fleet-push-fixture.ts";
import { executeFixture, type FixtureExecutor } from "./push-qualification-fixture.ts";
import { fleetSourceBinding } from "../packages/protocol/src/fleet.ts";
import { loadGatewayConfig } from "../apps/gateway/src/config.ts";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

const epoch = "a3a77f8e-956b-45d0-a684-a33e6b336dc0", commit = "c".repeat(40), origin = "https://synthetic.example.test";
test("helper diagnostics retain guard exceptions and redact capability-bearing causes", () => {
  const exact = new Error("fleet grants or recipients remain enrolled");
  const secret = `https://synthetic.example.test/#synthetic-test.${"X".repeat(43)}`;
  const entries = fleetFixtureDiagnostic(new AggregateError([exact, new Error(secret)], "fleet restore failed"));
  expect(entries[1]?.message).toBe(exact.message);
  expect(entries[1]?.stack).toContain("fleet-push-fixture.test.ts");
  expect(JSON.stringify(entries)).not.toContain(secret);
  expect(entries[2]?.message).toContain("withheld");
});

async function fixture(options: { orphanChild?: boolean; listenerRemains?: boolean; bun?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "fleet-push-test-")), root = join(home, `fleet-${epoch}`);
  const config = join(home, ".config/omp-session-gateway/config.json"), cli = join(home, "candidate/apps/gateway/src/cli.js");
  const bun = options.bun ?? process.execPath;
  const original = JSON.stringify({ http: { port: 4317, publicOrigin: origin }, auth: { mode: "tailscale-serve", allowedLogins: ["synthetic@example.test"] } });
  await mkdir(dirname(config), { recursive: true }); await writeFile(config, original, { mode: 0o600 });
  await mkdir(join(home, "candidate")); await writeFile(join(home, "candidate/release-info.json"), JSON.stringify({ sourceCommit: commit }));
  let mapping: Record<string, unknown> = {}, running = true, source = false, child = false, spawned = false, fail = "";
  const effects: string[] = [];
  const execute: FixtureExecutor = async argv => {
    const command = argv.join(" "); effects.push(command);
    if (command.includes(fail) && fail !== "") throw new Error("synthetic interruption");
    if (argv[0] === "id") return { exitCode: 0, stdout: "501\n" };
    if (argv[0] === "plutil") return { exitCode: 0, stdout: JSON.stringify([bun, cli, "serve"]) };
    if (argv[0] === "lsof") return child || spawned && options.listenerRemains ?
      { exitCode: 0, stdout: "synthetic owned backend" } : { exitCode: 1, stdout: "" };
    if (argv[0] === "launchctl") {
      if (argv[1] === "print") return { exitCode: running ? 0 : 1, stdout: "" };
      running = argv[1] === "bootstrap";
    }
    if (argv[0] === "tailscale") {
      if (argv[2] === "status") return { exitCode: 0, stdout: JSON.stringify(mapping) };
      mapping = argv.includes("off") ? {} : { TCP: { [FLEET_PUSH_HTTPS_PORT]: { HTTPS: true } }, Web: {
        [`synthetic.example.test:${FLEET_PUSH_HTTPS_PORT}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${FLEET_PUSH_BACKEND_PORT}` } } } } };
    }
    if (argv[0] === "sh") {
      source = true; child = true; spawned = true;
      await writeFile(join(root, "source.pid"), "12345"); await writeFile(join(root, "source-child.pid"), "12346");
    }
    if (argv[0] === "kill") {
      if (argv.at(-1) === "12345") { source = false; if (!options.orphanChild) child = false; }
      if (argv.at(-1) === "12346") child = false;
    }
    if (argv[0] === "ps" && argv.includes("-p")) {
      const parent = argv[3] === "12345", active = parent ? source : child;
      return { exitCode: active ? 0 : 1, stdout: active ? parent ? `S sh ${join(root, "source.sh")}` : `S ${bun} ${cli} serve` : "" };
    }
    if (argv[0] === "ps" && argv.includes("-axo")) return { exitCode: 0, stdout: source ? `sh ${join(root, "source.sh")}` : "" };
    if (argv.includes("doctor")) await writeFile(argv.at(-1)!, "synthetic redacted support archive");
    return { exitCode: 0, stdout: "" };
  };
  return { home, root, config, original, effects, execute, setFail: (value: string) => { fail = value; }, state: () => ({ mapping, running, source }),
    run: (operation: Parameters<typeof fleetPushFixture>[0]) => fleetPushFixture(operation, root, epoch, origin, commit, execute, home),
    dispose: () => rm(home, { recursive: true, force: true }) };
}

test("fleet source has a distinct HTTPS origin and origin-bound notification identity", async () => {
  const source = fleetPushSource(origin);
  expect(source.origin).toBe(`https://synthetic.example.test:${FLEET_PUSH_HTTPS_PORT}`);
  expect(source.binding).toHaveLength(22);
  expect(source.binding).toBe(await fleetSourceBinding(source.id, source.origin));
  expect(fleetPushSource("https://other.example.test").binding).not.toBe(source.binding);
  for (const value of ["http://synthetic.example.test", `${origin}/`, `${origin}:8443`]) expect(() => fleetPushSource(value)).toThrow();
});

test("fleet fixture uses the candidate bytes and restores exact config and Serve ownership", async () => {
  const f = await fixture();
  try {
    await f.run("prepare");
    const home = JSON.parse(await readFile(f.config, "utf8"));
    const source = JSON.parse(await readFile(join(f.root, "home/.config/omp-session-gateway/config.json"), "utf8"));
    expect(home.notifications.sources).toEqual(["push-qualification"]);
    expect(source.notifications.coordinators).toEqual([{ id: "qualification-home", origin }]);
    expect((await loadGatewayConfig({ configPath: f.config })).notifications?.sources).toEqual(["push-qualification"]);
    expect((await loadGatewayConfig({ configPath: join(f.root, "home/.config/omp-session-gateway/config.json") })).notifications?.coordinators)
      .toEqual([{ id: "qualification-home", origin }]);
    expect(source.http.trustedDashboardOrigins).toEqual([origin]);
    expect(source.omp.discoveryDir).toBe(join(f.root, "home/.omp/run/collab-hosts"));
    expect(await readFile(join(f.root, "source.sh"), "utf8")).toContain("printf %s $$");
    const script = await readFile(join(f.root, "source.sh"), "utf8");
    expect(script.indexOf("trap stop TERM INT EXIT")).toBeLessThan(script.indexOf("env -u XDG_RUNTIME_DIR"));
    expect(script).toContain("source.pid.tmp");
    expect(script).toContain("source-child.pid.tmp");
    expect(script).not.toContain('ps -ww -p "$child"');
    expect(script).toContain('kill -TERM "$child"');
    expect(f.effects.some(command => command.includes("nohup python3") && command.includes("os.setsid()") &&
      command.includes('os.execv("/bin/sh"'))).toBe(true);
    expect(f.state()).toMatchObject({ running: true, source: true });
    expect(f.effects.some(command => command.includes("launchctl bootstrap gui/501 "))).toBe(true);
    await f.run("source-down"); expect(f.state().source).toBe(false);
    await expect(readFile(join(f.root, "source.pid"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(f.root, "source-child.pid"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.run("source-down"); // A proven stop leaves no PID file, not an invalid liveness state.
    await f.run("source-up"); expect(f.state().source).toBe(true);
    await f.run("coordinator-down"); expect(f.state().running).toBe(false);
    await f.run("coordinator-up"); expect(f.state().running).toBe(true);
    await f.run("restore");
    expect(await readFile(f.config, "utf8")).toBe(f.original);
    expect(f.state()).toEqual({ mapping: {}, running: true, source: false });
    await expect(readFile(join(f.root, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.effects.some(command => command.includes("serve reset"))).toBe(false);
  } finally { await f.dispose(); }
});

test("fleet audit proves its scanner and examines both host state and diagnostic exports", async () => {
  const f = await fixture();
  try {
    await f.run("prepare"); await f.run("audit");
    expect(f.effects.filter(command => command.includes("doctor --bundle --output"))).toHaveLength(2);
    await expect(readFile(join(f.root, "audit-control.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(f.root, "source-diagnostics.tar"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.run("restore");
  } finally { await f.dispose(); }
});

test.each(["home", "source", "diagnostics"])("fleet audit refuses a synthetic capability in %s persistence", async sink => {
  const f = await fixture(), marker = `https://synthetic.example.test/#synthetic-test.${"X".repeat(43)}`;
  try {
    await f.run("prepare");
    if (sink !== "diagnostics") {
      const path = join(sink === "home" ? f.home : join(f.root, "home"), ".local/state/omp-session-gateway/push-state.json");
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ synthetic: marker }));
    }
    const execute: FixtureExecutor = async argv => {
      const result = await f.execute(argv);
      if (sink === "diagnostics" && argv.includes("doctor")) await writeFile(argv.at(-1)!, marker);
      return result;
    };
    await expect(fleetPushFixture("audit", f.root, epoch, origin, commit, execute, f.home)).rejects.toThrow(/leak/u);
    await expect(readFile(join(f.root, "audit-control.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.run("restore");
  } finally { await f.dispose(); }
});

test("fleet restoration refuses an unsettled dispatch without its PID owner", async () => {
  const f = await fixture();
  try {
    await f.run("prepare"); await rm(join(f.root, "source.pid"));
    await expect(f.run("restore")).rejects.toThrow("no settled PID owner");
    expect(f.state().source).toBe(true);
    expect(await readFile(join(f.root, "owner.json"), "utf8")).toContain(epoch);
  } finally { await f.dispose(); }
});

test("fleet preparation never adopts an existing unowned directory", async () => {
  const f = await fixture();
  try {
    await mkdir(f.root); await writeFile(join(f.root, "foreign"), "untouched");
    await expect(f.run("prepare")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(f.run("restore")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(await readFile(f.config, "utf8")).toBe(f.original);
    expect(f.state()).toEqual({ mapping: {}, running: true, source: false });
  } finally { await f.dispose(); }
});

test.each([false, true])("pre-owner fleet recovery removes only its pending owner file (foreign=%s)", async foreign => {
  const f = await fixture();
  try {
    await mkdir(f.root); await writeFile(join(f.root, "owner.json.tmp"), '{"interrupted":');
    if (foreign) await writeFile(join(f.root, "foreign"), "untouched");
    if (foreign) {
      await expect(f.run("restore")).rejects.toMatchObject({ code: "ENOTEMPTY" });
      expect(await readFile(join(f.root, "foreign"), "utf8")).toBe("untouched");
    } else {
      await f.run("restore");
      await expect(readFile(join(f.root, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(join(f.root, "owner.json.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.config, "utf8")).toBe(f.original);
    expect(f.effects).toEqual([]);
  } finally { await f.dispose(); }
});

test("fleet fixture requires a canonical native path with the exact epoch basename", async () => {
  const f = await fixture();
  try {
    for (const root of [join(f.home, `other-fleet-${epoch}`), join(f.root, "child"), `${f.root}/../fleet-${epoch}`]) {
      await expect(fleetPushFixture("prepare", root, epoch, origin, commit, f.execute, f.home)).rejects.toThrow("invalid fleet fixture identity");
    }
    expect(f.effects).toEqual([]);
    await f.run("prepare"); await f.run("restore");
  } finally { await f.dispose(); }
});

test("fleet service mutations require the executor's verified numeric account identity", async () => {
  const f = await fixture();
  const execute: FixtureExecutor = argv => argv[0] === "id" ? Promise.resolve({ exitCode: 0, stdout: "unverified-account" }) : f.execute(argv);
  try {
    await expect(fleetPushFixture("prepare", f.root, epoch, origin, commit, execute, f.home)).rejects.toThrow("fleet service account identity unavailable");
    expect(f.effects.some(command => command.includes("launchctl bootout") || command.includes("tailscale serve --bg"))).toBe(false);
    expect(await readFile(f.config, "utf8")).toBe(f.original);
    expect(JSON.parse(await readFile(join(f.root, "owner.json"), "utf8")).epoch).toBe(epoch);
  } finally { await f.dispose(); }
});

test.each(["ledger", "target", "candidate", "serve", "listener", "probe-error"])("fleet preparation refuses existing or unverifiable %s ownership before mutation", async scenario => {
  const f = await fixture();
  try {
    if (scenario === "ledger") {
      const path = join(f.home, ".local/state/omp-session-gateway/fleet-notifications.json");
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, "{}");
    }
    if (scenario === "target") await writeFile(f.config, JSON.stringify({ ...JSON.parse(f.original), fleet: { targets: [{}] } }));
    if (scenario === "candidate") await writeFile(join(f.home, "candidate/release-info.json"), JSON.stringify({ sourceCommit: "a".repeat(40) }));
    if (scenario === "serve") await f.execute(["tailscale", "serve", "--bg", "--https=10443"]);
    const execute: FixtureExecutor = argv => argv[0] === "lsof" && ["listener", "probe-error"].includes(scenario) ?
      Promise.resolve({ exitCode: scenario === "listener" ? 0 : 127, stdout: "" }) : f.execute(argv);
    await expect(fleetPushFixture("prepare", f.root, epoch, origin, commit, execute, f.home)).rejects.toThrow();
    expect(f.effects.some(command => command.includes("launchctl bootout"))).toBe(false);
    expect(f.state()).toMatchObject({ running: true, source: false });
    await expect(readFile(join(f.root, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.dispose(); }
});

test.each(["launchctl bootout", "tailscale serve --bg", "nohup python3"])("fleet fixture restores an interrupted %s mutation from persisted ownership", async failure => {
  const f = await fixture();
  try {
    f.setFail(failure); await expect(f.run("prepare")).rejects.toThrow("synthetic interruption");
    expect(JSON.parse(await readFile(join(f.root, "owner.json"), "utf8")).epoch).toBe(epoch);
    f.setFail(""); await f.run("restore");
    expect(await readFile(f.config, "utf8")).toBe(f.original);
    expect(f.state()).toEqual({ mapping: {}, running: true, source: false });
  } finally { await f.dispose(); }
});

test.each(["config", "ledger", "process"])("fleet restoration refuses changed %s ownership", async scenario => {
  const f = await fixture();
  try {
    await f.run("prepare");
    if (scenario === "config") await writeFile(f.config, `${f.original}\n`);
    if (scenario === "ledger") {
      const path = join(f.home, ".local/state/omp-session-gateway/fleet-notifications.json");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ version: 1, grants: [{ secret: "SYNTHETIC-NOT-A-CREDENTIAL" }], recipients: [] }));
    }
    const execute: FixtureExecutor = argv => scenario === "process" && argv[0] === "ps" && argv.includes("-p") ?
      Promise.resolve({ exitCode: 0, stdout: "S unrelated-process" }) : f.execute(argv);
    await expect(fleetPushFixture("restore", f.root, epoch, origin, commit, execute, f.home)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(f.root, "owner.json"), "utf8")).epoch).toBe(epoch);
  } finally { await f.dispose(); }
});

test.each([false, true])("fleet stop waits for proven exit after transient command loss (persistent=%s)", async persistent => {
  const f = await fixture();
  let signalled = false, observations = 0, now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sleep = spyOn(Bun, "sleep").mockImplementation((async () => { now += 15_000; }) as typeof Bun.sleep);
  const execute: FixtureExecutor = async argv => {
    if (argv[0] === "kill") signalled = true;
    if (signalled && argv[0] === "ps" && argv[3] === "12345" && (++observations === 1 || persistent)) {
      return { exitCode: 0, stdout: "?E (sh)" };
    }
    return f.execute(argv);
  };
  try {
    await f.run("prepare");
    const result = fleetPushFixture("restore", f.root, epoch, origin, commit, execute, f.home);
    if (persistent) {
      const error = await result.catch(error => error);
      expect(error.message).toBe("fleet source did not stop");
      expect(error.cause.message).toBe("fleet source process ownership changed");
      expect(JSON.parse(await readFile(join(f.root, "owner.json"), "utf8")).epoch).toBe(epoch);
    } else {
      await result;
      expect(observations).toBe(2);
      expect(await readFile(f.config, "utf8")).toBe(f.original);
    }
    expect(f.effects.filter(command => command.startsWith("kill "))).toHaveLength(1);
  } finally { clock.mockRestore(); sleep.mockRestore(); await f.dispose(); }
});

test("fleet stop proves and terminates a recorded orphan child after its supervisor exits", async () => {
  const f = await fixture({ orphanChild: true });
  try {
    await f.run("prepare"); await f.run("source-down");
    expect(f.effects.filter(command => command.startsWith("kill "))).toEqual(["kill -TERM 12345", "kill -TERM 12346"]);
    expect(f.effects.filter(command => command.startsWith("lsof ")).length).toBeGreaterThan(2);
    await expect(readFile(join(f.root, "source.pid"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.run("restore");
    await expect(readFile(join(f.root, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.dispose(); }
});

test.each(["foreign-child", "backend"] as const)("fleet restoration retains ownership when %s exit is unproven", async scenario => {
  const f = await fixture({ orphanChild: true, listenerRemains: scenario === "backend" });
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sleep = spyOn(Bun, "sleep").mockImplementation((async () => { now += 15_000; }) as typeof Bun.sleep);
  const execute: FixtureExecutor = argv => scenario === "foreign-child" && argv[0] === "ps" && argv[3] === "12346" ?
    Promise.resolve({ exitCode: 0, stdout: "S unrelated-child" }) : f.execute(argv);
  try {
    await f.run("prepare");
    await expect(fleetPushFixture("restore", f.root, epoch, origin, commit, execute, f.home)).rejects.toThrow("fleet source did not stop");
    expect(f.effects.filter(command => command.startsWith("kill "))).toEqual(
      scenario === "foreign-child" ? ["kill -TERM 12345"] : ["kill -TERM 12345", "kill -TERM 12346"]);
    expect(JSON.parse(await readFile(join(f.root, "owner.json"), "utf8")).epoch).toBe(epoch);
    expect(await readFile(join(f.root, "source.pid"), "utf8")).toBe("12345");
  } finally { clock.mockRestore(); sleep.mockRestore(); await f.dispose(); }
});

test.each(["durable", "file-sync-fails"] as const)(
  "fleet ownership is fsynced and renamed before coordinator mutations (%s)", async scenario => {
    const f = await fixture(), events: string[] = [], actualOpen = fs.open, actualRename = fs.rename;
    const opened = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await actualOpen(path, flags, mode), sync = handle.sync.bind(handle);
      if (path === join(f.root, "owner.json.tmp") || path === f.root) {
        const kind = path === f.root ? "directory" : "file";
        handle.sync = async () => {
          events.push(`${kind}-sync`);
          if (scenario === `${kind}-sync-fails`) throw new Error("synthetic owner fsync failure");
          await sync();
        };
      }
      return handle;
    });
    const renamed = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === join(f.root, "owner.json")) events.push("owner-rename");
      await actualRename(from, to);
    });
    const execute: FixtureExecutor = async argv => {
      if (argv[0] === "launchctl" && argv[1] === "bootout" || argv[0] === "tailscale" && argv[2] !== "status") {
        expect(events).toEqual(process.platform === "win32" ? ["file-sync", "owner-rename"] : ["file-sync", "owner-rename", "directory-sync"]);
        expect(JSON.parse(await readFile(join(f.root, "owner.json"), "utf8")).config).toBe(f.original);
      }
      return f.execute(argv);
    };
    try {
      const result = fleetPushFixture("prepare", f.root, epoch, origin, commit, execute, f.home);
      if (scenario === "durable") {
        await result; await expect(readFile(join(f.root, "owner.json.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
        await f.run("restore");
      } else {
        await expect(result).rejects.toThrow("synthetic owner fsync failure");
        expect(f.effects.some(command => command.includes("launchctl bootout") || command.includes("tailscale serve --bg"))).toBe(false);
        expect(await readFile(f.config, "utf8")).toBe(f.original);
        await f.run("restore");
        await expect(readFile(join(f.root, "owner.json.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { renamed.mockRestore(); opened.mockRestore(); await f.dispose(); }
  });

test.skipIf(process.platform === "win32")("fleet physical POSIX host refuses mutation after directory fsync failure", async () => {
  const f = await fixture(), actualOpen = fs.open;
  const opened = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await actualOpen(path, flags, mode);
    if (path === f.root) handle.sync = async () => { throw new Error("synthetic directory fsync failure"); };
    return handle;
  });
  try {
    await expect(f.run("prepare")).rejects.toThrow("synthetic directory fsync failure");
    expect(f.effects.some(command => command.includes("launchctl bootout") || command.includes("tailscale serve --bg"))).toBe(false);
    expect(await readFile(f.config, "utf8")).toBe(f.original);
    expect(JSON.parse(await readFile(join(f.root, "owner.json"), "utf8")).epoch).toBe(epoch);
  } finally { opened.mockRestore(); await f.dispose(); }
});

test.skipIf(process.platform === "win32").each(["term", "normal"] as const)("fleet supervisor signals only its unreaped child (%s)", async scenario => {
  const stubRoot = await mkdtemp(join(tmpdir(), "fleet-preexec-test-")), stub = join(stubRoot, "slow-bun.sh"), fifo = join(stubRoot, "preexec.fifo");
  const kills = join(stubRoot, "signals");
  const f = await fixture({ bun: stub });
  let supervisor: ReturnType<typeof Bun.spawn> | undefined, child: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (scenario === "term") expect((await executeFixture(["mkfifo", "-m", "600", fifo])).exitCode).toBe(0);
    await writeFile(stub, scenario === "term" ? `#!/bin/sh\nexec 3< '${fifo.replaceAll("'", "'\\''")}'\n` : "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(stub, 0o700);
    await f.run("prepare");
    const scriptPath = join(f.root, "source.sh"), script = await readFile(scriptPath, "utf8");
    // Observe the generated supervisor's own signal calls, forwarding them unchanged.
    await writeFile(scriptPath, script.replace("#!/bin/sh\n", `#!/bin/sh\nkill() { printf '%s\\n' "$*" >> '${kills.replaceAll("'", "'\\''")}'; command kill "$@"; }\n`));
    await rm(join(f.root, "source.pid")); await rm(join(f.root, "source-child.pid"));
    supervisor = Bun.spawn(["/bin/sh", join(f.root, "source.sh")], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const spawnedBy = supervisor.pid, dispatchDeadline = Date.now() + HANG_DEADLINE_MS;
    for (;;) {
      const text = await readFile(join(f.root, "source-child.pid"), "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      if (/^[1-9]\d*$/u.test(text)) { child = Number(text); break; }
      if (Date.now() >= dispatchDeadline) throw new Error("synthetic pre-exec child did not dispatch");
      await Bun.sleep(10);
    }
    expect(await readFile(join(f.root, "source.pid"), "utf8")).toBe(String(spawnedBy));
    if (scenario === "term") {
      const before = await executeFixture(["ps", "-ww", "-p", String(child), "-o", "command="]);
      expect(before.exitCode).toBe(0);
      expect(before.stdout.trim()).not.toBe(`${stub} ${join(f.home, "candidate/apps/gateway/src/cli.js")} serve`);
    }
    const stopped = performance.now();
    if (scenario === "term") supervisor.kill("SIGTERM");
    // hang-deadline: behavior-under-test -- the fixture's TERM/child-restoration bound is 30 s.
    const stopBound = 30_000;
    await Promise.race([supervisor.exited, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("fleet supervisor did not reap its pre-exec child")), stopBound);
    })]);
    clearTimeout(timer); timer = undefined;
    expect(performance.now() - stopped).toBeLessThan(stopBound);
    const after = await executeFixture(["ps", "-ww", "-p", String(child), "-o", "stat=,command="]);
    expect(after.exitCode).toBe(1); expect(after.stdout.trim()).toBe("");
    if (scenario === "term") expect((await readFile(kills, "utf8")).trim()).toBe(`-TERM ${child}`);
    else await expect(readFile(kills)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    clearTimeout(timer);
    if (supervisor !== undefined && supervisor.exitCode === null) {
      if (child !== undefined) {
        const owned = await executeFixture(["ps", "-ww", "-p", String(child), "-o", "command="]);
        if (owned.stdout.includes(stub)) { try { process.kill(child, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      }
      supervisor.kill("SIGKILL"); await supervisor.exited;
    }
    await f.dispose(); await rm(stubRoot, { recursive: true, force: true });
  }
}, HANG_DEADLINE_MS);
