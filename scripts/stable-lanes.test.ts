import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { remoteCommandLine, type RemoteExecutor } from "./stable-qualification.ts";
import { gatewayStreamsDiscarded, PUSH_FIXTURE_FILES, remoteHome, retainedMacCloudFixture, retainedMacLogs, stageRemoteFile } from "./stable-lanes.ts";
import type { ExternalLaneContext, RetainedMacLaneContext } from "./stable-qualification.ts";

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));

/** Runs the exact line ssh would hand the retained Mac's shell, locally, so quoting is proved end to end. */
function shellWith(env: Record<string, string> = { PATH: "/usr/bin:/bin" }): RemoteExecutor {
  return async (argv, options = {}) => {
    const child = Bun.spawn(["/bin/sh", "-c", remoteCommandLine(argv)], {
      env,
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
}
const localShell = shellWith();

test("council491 log ownership is not returned before remote preparation succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "qualification-log-owner-"));
  let calls = 0;
  const mac: RemoteExecutor = async () => ++calls === 1 ?
    { exitCode: 0, stdout: "/fixture-home", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
  try { await expect(retainedMacLogs(mac, "11111111-2222-4333-8444-555555555555", root)).rejects.toThrow(); }
  finally { await rm(root, { recursive: true, force: true }); }
});

async function relativeImports(file: string): Promise<string[]> {
  const source = await readFile(join(SCRIPTS, file), "utf8");
  return [...source.matchAll(/^import [^;]*? from "\.\/([^"]+)";/gmu)].map(match => {
    const target = match[1] ?? "";
    const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
    return `${directory}${target}`;
  });
}

describe("retained-Mac Push fixture staging", () => {
  test("device-cloud fixture construction stages nothing before lease ownership", async () => {
    let leased = false;
    const calls: string[] = [];
    const executions: unknown[] = [];
    const execution = { signal: new AbortController().signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 };
    const context: ExternalLaneContext & RetainedMacLaneContext = {
      identity: {
        tag: "v0.7.7-prealpha.1", previousTag: "v0.7.6", orchestratorCommit: "a".repeat(40), receiptRoot: "/fixture",
        candidate: { tag: "v0.7.7-prealpha.1", sourceCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archivePath: "/candidate.tar" },
        predecessor: { tag: "v0.7.6", sourceCommit: "c".repeat(40), archiveSha256: "d".repeat(64), archivePath: "/predecessor.tar" },
        omp: { bunVersion: "1.4.0", sourceCommit: "e".repeat(40), sourceTree: "f".repeat(40), version: "18.12.3", nativeTarballSha256: "0".repeat(64), nativeBinarySha256: "1".repeat(64) },
      },
      progress: undefined, checkpoint: async () => {}, origin: "https://fixture.invalid", sessionLabel: "fixture",
      execution,
      pixel: async (_owner, action) => { leased = true; try { return await action(); } finally { leased = false; } },
      mac: async (argv, options) => {
        expect(leased).toBe(true);
        calls.push(argv.join(" "));
        executions.push(options?.execution);
        return { exitCode: 0, stdout: argv.includes('printf %s "$HOME"') ? "/Users/ompqual" : "", stderr: "" };
      },
    };
    const prepare = retainedMacCloudFixture(context);
    expect(calls).toEqual([]);
    const fixture = await context.pixel("deviceCloud", prepare);
    expect(fixture.base).toBe("/Users/ompqual/qual-tools/device-cloud/fixtures");
    expect(calls).toHaveLength(1 + PUSH_FIXTURE_FILES.length);
    expect(executions.every(value => value === execution)).toBe(true);
    const cleanup = { ...execution, signal: new AbortController().signal };
    const restored = await context.pixel("deviceCloud-cleanup", () => prepare(cleanup));
    await context.pixel("deviceCloud-cleanup", () => restored.execute(["fixture", "stop"]));
    expect(executions.at(-1)).toBe(cleanup);
    expect(restored.base).toBe(fixture.base);
  });

  test("stages exactly the Push fixture's import closure", async () => {
    // The fixture runs on the retained Mac from these staged copies alone, so a new relative import
    // that is not staged would break the campaign there and nowhere else.
    const closure = new Set<string>();
    const pending = ["push-qualification-fixture.ts"];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (closure.has(file)) continue;
      closure.add(file);
      if (file.endsWith(".ts")) pending.push(...await relativeImports(file));
    }
    expect([...closure].sort()).toEqual([...PUSH_FIXTURE_FILES].sort());
  });

  test.skipIf(process.platform === "win32")("writes the exact bytes to a path the remote shell never interprets", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-lanes-stage-"));
    try {
      const path = join(root, "nested $(touch pwned) dir", "file'; rm -rf ~ #.ts");
      const bytes = new TextEncoder().encode("export const staged = 'exact';\n");
      await stageRemoteFile(localShell, path, bytes);
      expect(new Uint8Array(await readFile(path))).toEqual(bytes);
      expect(await Bun.file(join(root, "pwned")).exists()).toBe(false);
      expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts only a plain absolute home directory", async () => {
    const reporting = (home: string): RemoteExecutor => async () => ({ exitCode: 0, stdout: home, stderr: "" });
    expect(await remoteHome(reporting("/Users/ompqual"))).toBe("/Users/ompqual");
    for (const home of ["", "Users/ompqual", "/Users/ompqual 1", "/Users/../root", "/Users/ompqual\n/etc"]) {
      await expect(remoteHome(reporting(home))).rejects.toThrow("home directory");
    }
  });
});

describe.skipIf(process.platform !== "darwin")("retained-Mac gateway log observation", () => {
  const plist = (streams: Record<string, string>) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>omp-session-gateway</string>${Object.entries(streams).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join("")}</dict></plist>\n`;

  test.each([
    ["both streams discarded", { StandardOutPath: "/dev/null", StandardErrorPath: "/dev/null" }, true],
    ["stderr kept in a file", { StandardOutPath: "/dev/null", StandardErrorPath: "/tmp/gateway.log" }, false],
    ["no stdout key at all", { StandardErrorPath: "/dev/null" }, "throws"],
  ] as const)("%s", async (_name, streams, expected) => {
    const home = await mkdtemp(join(tmpdir(), "stable-lanes-plist-"));
    try {
      await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
      await writeFile(join(home, "Library", "LaunchAgents", "omp-session-gateway.plist"), plist(streams));
      // The same shell line ssh would run, with this fixture as the remote home.
      const mac = shellWith({ HOME: home, PATH: "/usr/bin:/bin" });
      if (expected === "throws") await expect(gatewayStreamsDiscarded(mac)).rejects.toThrow("service definition");
      else expect(await gatewayStreamsDiscarded(mac)).toBe(expected);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
