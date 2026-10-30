import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { watch } from "node:fs";
import { TernCli, matchingTernBasename, parseTernInspection, parseTernJson, sessionBasenameMatches, validateTernRuntime } from "../src/tern-cli.ts";
import type { TernProfile } from "../src/config.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const spawnTime = { monotonicMs: expect.any(Number), wallTimeMs: expect.any(Number) };
const inspect = (id = "317827580031", extra = ""): string => `{"sessions":[{"tabs":[{"blocks":[{"id":${id},"command":"SYNTHETIC_COMMAND_SECRET"}]}]}],"panes":[{"pane":${id},"omp_session_file":"/SYNTHETIC_PATH_SECRET/2026-10-24T00-00-00-000Z_session-one.jsonl"}]${extra}}`;
// Verbatim receipt observed from Tern 0.9.5 on the execution host.
const realReceipt = `{
  "session": 4,
  "tab": 515396075521,
  "block": 515396075522
}
`;
async function fake(mode = "success", receipt = realReceipt) {
  const root = await mkdtemp(join(tmpdir(), "tern-boundary-")); roots.push(root);
  const executable = join(root, "tern");
  await writeFile(executable, `#!${process.execPath}\nimport * as fs from 'node:fs/promises';
await fs.writeFile(process.env.HOME + '/pid', String(process.pid));
await fs.writeFile(process.env.HOME + '/received', JSON.stringify({argv:process.argv.slice(2),env:process.env}));
const mode = process.env.MODE;
if(mode === 'timeout') await Bun.sleep(30000);
else if(mode === 'nonzero') process.exit(4);
else if(mode === 'overflow') process.stdout.write('x'.repeat(1100000));
else if(mode === 'malformed') console.log('{');
else if(mode === 'duplicate') console.log('{"block":1,"block":2}');
else if(mode === 'remote') console.log('{"block":72057594037927936}');
else if(process.argv[2] === 'inspect') console.log(${JSON.stringify(inspect())});
else process.stdout.write(${JSON.stringify(receipt)});\n`);
  await chmod(executable, 0o700);
  const profile: TernProfile = { id: "omp", label: "Synthetic profile", argv: [process.execPath, "$(SYNTHETIC_ARG_SECRET)", "literal;argument"],
    env: { HOME: root, PATH: dirname(process.execPath), MODE: mode } };
  return { root, executable, profile, copy: { id: "main", label: "Main", path: await realpath(root) } };
}

describe("lossless bounded Tern metadata", () => {
  test("preserves unsafe-number neighbors and projects only basenames, with exact one-to-one equality", () => {
    const parsed = parseTernInspection(bytes(inspect("9007199254740993")));
    expect(parsed.blocks).toEqual(["9007199254740993"]);
    expect(parsed.panes[0]!.paneId).toBe("9007199254740993");
    expect(matchingTernBasename(parsed, "9007199254740993")).toBe("2026-10-24T00-00-00-000Z_session-one.jsonl");
    expect(matchingTernBasename(parsed, "9007199254740992")).toBeUndefined();
    expect(matchingTernBasename({ ...parsed, blocks: [...parsed.blocks, ...parsed.blocks] }, parsed.blocks[0]!)).toBeUndefined();
    expect(matchingTernBasename({ ...parsed, panes: [...parsed.panes, ...parsed.panes] }, parsed.blocks[0]!)).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("SYNTHETIC_");
    const remote = parseTernInspection(bytes(inspect("72057594037927936")));
    expect(matchingTernBasename(remote, "72057594037927936")).toBeUndefined();
  });
  test("rejects malformed UTF-8, duplicate decoded keys, unsupported numbers, nesting and collection bounds", () => {
    for (const text of ['{"x":1,"\\u0078":2}', '{"x":01}', '{"x":NaN}', '{} trailing', '[1,]',
      '['.repeat(34) + '0' + ']'.repeat(34), JSON.stringify({ text: "x".repeat(8193) }),
      '[' + Array(50001).fill('0').join(',') + ']']) expect(() => parseTernJson(bytes(text))).toThrow();
    expect(() => parseTernJson(new Uint8Array([0xff]))).toThrow();
    for (const id of ["-1", "1.0", "1e3", "18446744073709551616"])
      expect(() => parseTernInspection(bytes(inspect(id)))).toThrow();
    for (const object of [
      { sessions: Array.from({ length: 65 }, () => ({ tabs: [] })), panes: [] },
      { sessions: [{ tabs: Array.from({ length: 257 }, () => ({ blocks: [] })) }], panes: [] },
      { sessions: [{ tabs: [{ blocks: Array.from({ length: 4097 }, () => ({ id: 1 })) }] }], panes: [] },
      { sessions: [], panes: Array.from({ length: 4097 }, () => ({ pane: 1 })) },
    ]) expect(() => parseTernInspection(bytes(JSON.stringify(object)))).toThrow();
    expect(() => parseTernInspection(bytes(inspect().replace('/SYNTHETIC_PATH_SECRET/', 'relative/')))).toThrow();
  });
  test("matches only maximal complete session-id tokens in a JSONL basename", () => {
    expect(sessionBasenameMatches("2026-10-24T00-00-00-000Z_session-one.jsonl", "session-one")).toBe(true);
    for (const id of ["session", "one", "session-on", "session-one-extra", "session_one", ""]) {
      expect(sessionBasenameMatches("2026-10-24T00-00-00-000Z_session-one.jsonl", id)).toBe(false);
    }
    expect(sessionBasenameMatches("session-one.txt", "session-one")).toBe(false);
  });
});

// The fake Tern executable is a shebang script, which Windows cannot execute directly; Tern session
// creation is exercised on POSIX hosts only (docs/OPERATIONS.md), so the subprocess boundary is too.
describe.skipIf(process.platform === "win32")("bounded Tern subprocess", () => {
  test("requires canonical directory working copies while preserving literal POSIX backslashes", async () => {
    const fixture = await fake(), root = fixture.copy.path;
    const copy = { ...fixture.copy, path: join(root, "work\\copy") };
    await mkdir(copy.path);
    const config = { executable: fixture.executable,
      projects: [{ id: "main", label: "Main", workingCopies: [copy] }], profiles: [fixture.profile] };
    expect(await validateTernRuntime(config)).toBe(true);
    const alias = join(root, "alias");
    await symlink(copy.path, alias);
    for (const path of [alias, `${alias}/..`, `${copy.path}/..`, `${copy.path}/`, fixture.executable]) {
      expect(await validateTernRuntime({ ...config,
        projects: [{ ...config.projects[0]!, workingCopies: [{ ...copy, path }] }] })).toBe(false);
    }
  });
  test("canonicalizes executable and profile symlink-parent paths and refuses trailing file slashes", async () => {
    const fixture = await fake(), root = fixture.copy.path, commands = join(root, "commands");
    await mkdir(join(commands, "nested"), { recursive: true });
    await rename(fixture.executable, join(commands, "tern"));
    const link = join(root, "link");
    await symlink(join(commands, "nested"), link);
    const path = `${link}/../tern`, executable = join(commands, "tern");
    const profile = { ...fixture.profile, argv: [path, ...fixture.profile.argv.slice(1)] };
    expect(await validateTernRuntime({ executable: path,
      projects: [{ id: "main", label: "Main", workingCopies: [fixture.copy] }], profiles: [profile] })).toBe(true);
    const cli = new TernCli(path);
    expect(await cli.inspect(profile, new AbortController().signal)).toEqual(parseTernInspection(bytes(inspect())));
    expect(await cli.createTab(fixture.copy, profile, new AbortController().signal))
      .toEqual({ kind: "started", blockId: "515396075522", spawnedAt: spawnTime });
    const received = JSON.parse(await readFile(join(fixture.root, "received"), "utf8"));
    expect(received.argv[7]).toBe(executable);
    const invalid = `${path}/`, invalidProfile = { ...profile, argv: [invalid] };
    expect(await validateTernRuntime({ executable: invalid,
      projects: [{ id: "main", label: "Main", workingCopies: [fixture.copy] }], profiles: [invalidProfile] })).toBe(false);
    expect(await new TernCli(invalid).inspect(profile, new AbortController().signal)).toBeUndefined();
    expect(await cli.createTab(fixture.copy, invalidProfile, new AbortController().signal)).toEqual({ kind: "not_started" });
  });
  test("uses literal argv, keep-open, canonical executable and only the configured environment", async () => {
    const fixture = await fake();
    const cli = new TernCli(fixture.executable);
    const before = { monotonicMs: performance.now(), wallTimeMs: Date.now() };
    const result = await cli.createTab(fixture.copy, fixture.profile, new AbortController().signal);
    expect(result).toEqual({ kind: "started", blockId: "515396075522", spawnedAt: spawnTime });
    if (result.kind !== "started") throw new Error("expected confirmed start");
    expect(result.spawnedAt.monotonicMs).toBeGreaterThanOrEqual(before.monotonicMs);
    expect(result.spawnedAt.monotonicMs).toBeLessThanOrEqual(performance.now());
    expect(result.spawnedAt.wallTimeMs).toBeGreaterThanOrEqual(before.wallTimeMs);
    expect(result.spawnedAt.wallTimeMs).toBeLessThanOrEqual(Date.now());
    const received = JSON.parse(await readFile(join(fixture.root, "received"), "utf8"));
    expect(received.argv).toEqual(["new", "tab", "--json", "--keep-open", "--cwd", fixture.copy.path, "--",
      await realpath(process.execPath), "$(SYNTHETIC_ARG_SECRET)", "literal;argument"]);
    expect(received.env.HOME).toBe(fixture.root);
    expect(received.env.MODE).toBe("success");
    expect(received.env.USER).toBeUndefined();
    expect(await cli.inspect(fixture.profile, new AbortController().signal)).toEqual(parseTernInspection(bytes(inspect())));
    expect(await validateTernRuntime({ executable: fixture.executable,
      projects: [{ id: "main", label: "Main", workingCopies: [fixture.copy] }], profiles: [fixture.profile] })).toBe(true);
  });
  test("accepts the verbatim pretty-printed three-key Tern 0.9.5 receipt", async () => {
    const fixture = await fake();
    expect(await new TernCli(fixture.executable).createTab(fixture.copy, fixture.profile, new AbortController().signal))
      .toEqual({ kind: "started", blockId: "515396075522", spawnedAt: spawnTime });
  });
  test("discards bounded additive receipt metadata while preserving a lossless local block", async () => {
    for (const receipt of [
      '{"block":9007199254740993}',
      '{"session":18446744073709551615,"tab":9007199254740995,"block":9007199254740993,"extra":{"nested":["TERN_RECEIPT_PRIVATE_CANARY",1e30]}}',
    ]) {
      const fixture = await fake("success", receipt);
      const result = await new TernCli(fixture.executable).createTab(fixture.copy, fixture.profile, new AbortController().signal);
      expect(result).toEqual({ kind: "started", blockId: "9007199254740993", spawnedAt: spawnTime });
      expect(JSON.stringify(result)).not.toContain("TERN_RECEIPT_PRIVATE_CANARY");
    }
  });
  test("requires block and validates optional session/tab unsigned integer lexemes without weakening unknown outcomes", async () => {
    const invalid = ['{"session":4,"tab":515396075521}', '{"block":1,"extra":"x","extra":"y"}'];
    for (const key of ["session", "tab", "block"]) {
      for (const value of ['null', '"4"', '-1', '1.0', '1e3', '18446744073709551616']) {
        invalid.push(`{"${key}":${value}${key === "block" ? "" : ',"block":515396075522'}}`);
      }
    }
    for (const receipt of invalid) {
      const fixture = await fake("success", receipt);
      expect(await new TernCli(fixture.executable).createTab(fixture.copy, fixture.profile, new AbortController().signal))
        .toEqual({ kind: "unknown" });
    }
  });
  test("classifies malformed, oversized, duplicate, nonzero and remote results as uncertain, never retrying", async () => {
    for (const mode of ["malformed", "overflow", "duplicate", "nonzero", "remote"]) {
      const fixture = await fake(mode);
      const cli = new TernCli(fixture.executable);
      expect(await cli.createTab(fixture.copy, fixture.profile, new AbortController().signal)).toEqual({ kind: "unknown" });
      expect(await cli.inspect(fixture.profile, new AbortController().signal)).toBeUndefined();
    }
    const fixture = await fake();
    expect(await new TernCli(join(fixture.root, "absent")).createTab(fixture.copy, fixture.profile, new AbortController().signal))
      .toEqual({ kind: "not_started" });
  });
  test("timeout and cancellation kill and reap children and release the exclusive CLI slot", async () => {
    // This integration exercises real OS children and their timeout/reaping; fake timers cannot drive the child.
    const fixture = await fake("timeout");
    const cli = new TernCli(fixture.executable, { inspect: 100, create: 100 });
    expect(await cli.createTab(fixture.copy, fixture.profile, new AbortController().signal)).toEqual({ kind: "unknown" });
    const pid = Number(await readFile(join(fixture.root, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    const controller = new AbortController();
    await rm(join(fixture.root, "pid"));
    const ready = Promise.withResolvers<void>();
    const watcher = watch(fixture.root, (_event, name) => {
      if (name === "pid") { watcher.close(); ready.resolve(); }
    });
    const pending = cli.createTab(fixture.copy, fixture.profile, controller.signal);
    await ready.promise;
    expect(await cli.inspect(fixture.profile, new AbortController().signal)).toBeUndefined();
    controller.abort();
    expect(await pending).toEqual({ kind: "unknown" });
    expect(await cli.createTab(fixture.copy, { ...fixture.profile, env: { ...fixture.profile.env, MODE: "success" } }, new AbortController().signal))
      .toEqual({ kind: "started", blockId: "515396075522", spawnedAt: spawnTime });
  });
});
