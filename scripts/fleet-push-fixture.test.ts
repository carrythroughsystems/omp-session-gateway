import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fleetPushFixture, fleetPushSource, FLEET_PUSH_BACKEND_PORT, FLEET_PUSH_HTTPS_PORT } from "./fleet-push-fixture.ts";
import type { FixtureExecutor } from "./push-qualification-fixture.ts";
import { fleetSourceBinding } from "../packages/protocol/src/fleet.ts";

const epoch = "a3a77f8e-956b-45d0-a684-a33e6b336dc0", commit = "c".repeat(40), origin = "https://synthetic.example.test";
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "fleet-push-test-")), root = join(home, `fleet-${epoch}`);
  const config = join(home, ".config/omp-session-gateway/config.json"), cli = join(home, "candidate/apps/gateway/src/cli.js");
  const original = JSON.stringify({ http: { port: 4317, publicOrigin: origin }, auth: { mode: "tailscale-serve", allowedLogins: ["synthetic@example.test"] } });
  await mkdir(dirname(config), { recursive: true }); await writeFile(config, original, { mode: 0o600 });
  await mkdir(join(home, "candidate")); await writeFile(join(home, "candidate/release-info.json"), JSON.stringify({ sourceCommit: commit }));
  let mapping: Record<string, unknown> = {}, running = true, source = false, fail = "";
  const effects: string[] = [];
  const execute: FixtureExecutor = async argv => {
    const command = argv.join(" "); effects.push(command);
    if (command.includes(fail) && fail !== "") throw new Error("synthetic interruption");
    if (argv[0] === "plutil") return { exitCode: 0, stdout: JSON.stringify([process.execPath, cli, "serve"]) };
    if (argv[0] === "lsof") return { exitCode: 1, stdout: "" };
    if (argv[0] === "launchctl") {
      if (argv[1] === "print") return { exitCode: running ? 0 : 1, stdout: "" };
      running = argv[1] === "bootstrap";
    }
    if (argv[0] === "tailscale") {
      if (argv[2] === "status") return { exitCode: 0, stdout: JSON.stringify(mapping) };
      mapping = argv.includes("off") ? {} : { TCP: { [FLEET_PUSH_HTTPS_PORT]: { HTTPS: true } }, Web: {
        [`synthetic.example.test:${FLEET_PUSH_HTTPS_PORT}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${FLEET_PUSH_BACKEND_PORT}` } } } } };
    }
    if (argv[0] === "sh") { source = true; await writeFile(join(root, "source.pid"), "12345"); }
    if (argv[0] === "kill") source = false;
    if (argv[0] === "ps" && argv.includes("-p")) return { exitCode: source ? 0 : 1, stdout: source ? `S sh ${join(root, "source.sh")}` : "" };
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
    expect(source.http.trustedDashboardOrigins).toEqual([origin]);
    expect(source.omp.discoveryDir).toBe(join(f.root, "home/.omp/run/collab-hosts"));
    expect(await readFile(join(f.root, "source.sh"), "utf8")).toContain("printf %s $$");
    expect(f.state()).toMatchObject({ running: true, source: true });
    await f.run("source-down"); expect(f.state().source).toBe(false);
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

test.each(["launchctl bootout", "tailscale serve --bg", "nohup sh"])("fleet fixture restores an interrupted %s mutation from persisted ownership", async failure => {
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
