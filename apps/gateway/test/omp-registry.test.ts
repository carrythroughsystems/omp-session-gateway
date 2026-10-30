/**
 * Contract: the gateway reads mainline OMP's own collaboration host registry. Upstream publishes
 * one discovery file plus one owner-only socket per live host, answers exactly one newline-framed
 * request per connection, and refuses a link whose generation no longer matches. These tests drive
 * a host double that speaks that protocol byte for byte, because every rule the gateway depends on
 * — which failures retire a session, which ones must not, and which refusal reaches the operator —
 * is a property of that wire rather than of the gateway's own code.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LABEL_CODEPOINTS, OMP_REGISTRY_VERSION, type OmpHostSnapshot } from "@omp-session-gateway/protocol";
import {
  OmpHostReader,
  OmpLaunchResolver,
  resolveOmpDiscoveryDirectory,
  startHostPoller,
  type OmpDiscoveryObservation,
} from "../src/omp-registry.ts";
import { SessionRegistry, type SessionActivityStopEvent } from "../src/registry.ts";
import { HANG_DEADLINE_MS } from "../../../scripts/test-support.ts";

setDefaultTimeout(3 * HANG_DEADLINE_MS);

const VIEW_URL = "https://collab.example/#wss://relay.example/r/room.viewkeyviewkeyviewkey";
const CONTROL_URL = "https://collab.example/#wss://relay.example/r/room.controlkeycontrolkeyctl";

interface HostDoubleOptions {
  readonly instanceId?: string;
  readonly generation?: number;
  readonly access?: "view" | "control";
  readonly inputRequired?: boolean;
  readonly busy?: boolean | null;
  readonly sessionName?: string | null;
  readonly cwd?: string;
  /** Fields a later upstream adds under registry v1, merged into the snapshot and discovery file. */
  readonly additiveSnapshot?: Record<string, unknown>;
  readonly additiveDiscovery?: Record<string, unknown>;
  /** Replaces the whole reply, so a test can return any upstream wire error verbatim. */
  readonly reply?: (request: Record<string, unknown>) => unknown | undefined;
}

interface HostDouble {
  readonly instanceId: string;
  readonly entryId: string;
  readonly token: string;
  readonly endpoint: string;
  readonly requests: Record<string, unknown>[];
  stop(): Promise<void>;
  unpublish(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

describe("fresh adoption observation ordering", () => {
  function controlled() {
    const rounds: { resolve: (value: OmpDiscoveryObservation) => void; promise: Promise<OmpDiscoveryObservation> }[] = [];
    const next = Promise.withResolvers<void>();
    let active = 0;
    const reader = new OmpHostReader({ directory: "/unused-synthetic-discovery" });
    reader.observe = async () => {
      expect(active++).toBe(0);
      const round = Promise.withResolvers<OmpDiscoveryObservation>();
      rounds.push(round);
      if (rounds.length === 2) next.resolve();
      try { return await round.promise; } finally { active--; }
    };
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const poller = startHostPoller({ reader, registry, intervalMs: 60000 });
    cleanups.push(async () => { poller.stop(); });
    return { rounds, registry, poller, next: next.promise };
  }
  const observation: OmpDiscoveryObservation = { hosts: [], retained: new Set(["retained-instance"]), directoryHealthy: true };
  test("ordinary poll joins the old round while fresh callers share exactly one following round", async () => {
    const f = controlled();
    const ordinary = f.poller.poll();
    const a = f.poller.refreshForAdoption({ signal: new AbortController().signal, timeoutMs: 5000 });
    const b = f.poller.refreshForAdoption({ signal: new AbortController().signal, timeoutMs: 5000 });
    const published: number[] = [];
    let reconciled = 0;
    const reconcile = f.registry.reconcile.bind(f.registry);
    f.registry.reconcile = input => { reconciled++; return reconcile(input); };
    const unsubscribe = f.poller.subscribeObservations(batch => {
      expect(reconciled).toBe(batch.round);
      published.push(batch.round);
      expect(batch.knownInstanceIds).toEqual(["retained-instance"]);
      expect(JSON.stringify(batch)).not.toMatch(/token|endpoint|cwd|capability/u);
    });
    f.rounds[0]!.resolve(observation);
    await ordinary;
    await f.next;
    expect(f.rounds).toHaveLength(2);
    f.rounds[1]!.resolve(observation);
    const results = await Promise.all([a, b]);
    expect(results).toEqual([
      { status: "ok", observation: expect.objectContaining({ round: 2 }) },
      { status: "ok", observation: expect.objectContaining({ round: 2 }) },
    ]);
    expect(published).toEqual([1, 2]);
    unsubscribe();
  });
  test("cancelling sole queued demand prevents an unnecessary following observation", async () => {
    const f = controlled();
    const signal = new AbortController();
    const fresh = f.poller.refreshForAdoption({ signal: signal.signal, timeoutMs: 5000 });
    signal.abort();
    expect(await fresh).toEqual({ status: "aborted" });
    const ordinary = f.poller.poll();
    f.rounds[0]!.resolve(observation); await ordinary;
    expect(f.rounds).toHaveLength(1);
  });
  test("stopping resolves waiters and suppresses reconciliation/publication from an older read", async () => {
    const f = controlled();
    let publications = 0;
    f.poller.subscribeObservations(() => { publications++; });
    const fresh = f.poller.refreshForAdoption({ signal: new AbortController().signal, timeoutMs: 5000 });
    const ordinary = f.poller.poll();
    f.poller.stop();
    expect(await fresh).toEqual({ status: "stopped" });
    f.rounds[0]!.resolve(observation); await ordinary;
    expect(publications).toBe(0); expect(f.registry.snapshot().revision).toBe(0);
    expect(await f.poller.refreshForAdoption({ signal: new AbortController().signal, timeoutMs: 5000 })).toEqual({ status: "stopped" });
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function discoveryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-collab-hosts-"));
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/** A published OMP host: the discovery file, the socket, and upstream's request handling. */
async function hostDouble(directory: string, options: HostDoubleOptions = {}): Promise<HostDouble> {
  const instanceId = options.instanceId ?? "aaaa1111bbbb2222";
  const entryId = `e${instanceId.slice(1)}`;
  const token = "a".repeat(64);
  const generation = options.generation ?? 1;
  const access = options.access ?? "control";
  // Short base path: a Unix socket path is bounded well below a temp-dir-nested name.
  const endpointDir = await mkdtemp(join(tmpdir(), "omp-sock-"));
  const endpoint = join(endpointDir, `${entryId}.sock`);
  const requests: Record<string, unknown>[] = [];
  const snapshot = {
    instanceId,
    generation,
    pid: 4242,
    sessionId: "session-alpha",
    sessionName: options.sessionName === undefined ? "Alpha session" : options.sessionName,
    cwd: options.cwd ?? "/Users/you/projects/gateway",
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    startedAt: Date.parse("2026-09-14T00:00:00.000Z"),
    participants: 1,
    relayConnected: true,
    inputRequired: options.inputRequired ?? false,
    ...(options.busy === undefined ? {} : { busy: options.busy }),
    access,
    ...options.additiveSnapshot,
  };
  const server = Bun.listen<undefined>({
    unix: endpoint,
    socket: {
      data(socket, chunk) {
        const line = new TextDecoder().decode(chunk).split("\n")[0] ?? "";
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(line) as Record<string, unknown>;
        } catch {
          socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "malformed_request" })}\n`);
          return;
        }
        requests.push(request);
        const override = options.reply?.(request);
        if (override !== undefined) {
          socket.end(`${JSON.stringify(override)}\n`);
          return;
        }
        if (request.token !== token) {
          socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "authentication_failed" })}\n`);
          return;
        }
        if (request.op === "snapshot") {
          socket.end(`${JSON.stringify({ ok: true, v: OMP_REGISTRY_VERSION, snapshot })}\n`);
          return;
        }
        if (request.op === "link") {
          if (request.generation !== generation) {
            socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "stale_generation" })}\n`);
            return;
          }
          if (request.access === "control" && access !== "control") {
            socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "access_unavailable" })}\n`);
            return;
          }
          const url = request.access === "view" ? VIEW_URL : CONTROL_URL;
          socket.end(`${JSON.stringify({ ok: true, v: OMP_REGISTRY_VERSION, url })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "invalid_operation" })}\n`);
      },
    },
  });
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  const metaPath = join(directory, `${entryId}.json`);
  await writeFile(
    metaPath,
    JSON.stringify({
      version: OMP_REGISTRY_VERSION,
      instanceId,
      pid: 4242,
      endpoint,
      createdAt: Date.now(),
      token,
      ...options.additiveDiscovery,
    }),
    { mode: 0o600 },
  );
  const stop = async (): Promise<void> => {
    server.stop(true);
    await rm(endpointDir, { recursive: true, force: true });
  };
  cleanups.push(stop);
  return {
    instanceId,
    entryId,
    token,
    endpoint,
    requests,
    stop,
    unpublish: async () => {
      await rm(metaPath, { force: true });
    },
  };
}

function reader(directory: string): OmpHostReader {
  return new OmpHostReader({ directory, timeoutMs: HANG_DEADLINE_MS });
}

/** Iterates a real directory in a chosen order, so a budget case cannot pass on a lucky name order. */
async function orderedDirectory(path: string, rank: (name: string) => number) {
  const names = (await readdir(path)).sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
  let index = 0;
  return {
    read: async () => (index < names.length ? { name: names[index++]! } : null),
    close: async () => undefined,
  };
}

describe("OMP discovery directory", () => {
  test("keeps current and legacy hosts visible and launchable in one directory", async () => {
    const directory = await discoveryDirectory();
    const working = await hostDouble(directory, { busy: true });
    const idle = await hostDouble(directory, { instanceId: "bbbb2222cccc3333", busy: false });
    const legacy = await hostDouble(directory, { instanceId: "cccc3333dddd4444" });
    const unknown = await hostDouble(directory, { instanceId: "dddd4444eeee5555", busy: null });
    const subject = reader(directory);
    const observation = await subject.observe();
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.reconcile({ observed: observation.hosts.map(host => host.session), retained: observation.retained });
    expect(registry.snapshot().sessions.map(session => session.instanceId).sort()).toEqual(
      [working, idle, legacy, unknown].map(host => host.instanceId).sort(),
    );
    expect(Object.fromEntries(registry.snapshot().sessions.map(session => [session.instanceId, session.busy]))).toEqual({
      [working.instanceId]: true, [idle.instanceId]: false, [legacy.instanceId]: undefined, [unknown.instanceId]: undefined,
    });
    const resolver = new OmpLaunchResolver({ registry, reader: subject });
    for (const mode of ["view", "control"] as const) {
      expect((await resolver.resolve({ instanceId: working.instanceId, generation: 1, mode })).status).toBe("ok");
    }
    expect(working.requests.map(request => request.op)).toEqual(["snapshot", "link", "link"]);
  });

  test("an unreadable poll breaks activity continuity while the host remains published", async () => {
    const directory = await discoveryDirectory();
    let state: "working" | "gap" | "idle" = "working";
    let snapshot: OmpHostSnapshot | undefined;
    const host = await hostDouble(directory, {
      busy: true,
      reply: () => {
        if (state === "gap") return { ok: false, v: 1, error: "snapshot_unavailable" };
        if (state === "idle") return { ok: true, v: 1, snapshot: { ...snapshot, busy: false } };
        return undefined;
      },
    });
    const subject = reader(directory);
    let now = 0;
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10, clock: {
      monotonicNowMs: () => now,
      wallNowIso: () => new Date(now).toISOString(),
    } });
    const stops: SessionActivityStopEvent[] = [];
    registry.subscribeActivityStops(event => stops.push(event));
    const poll = async (): Promise<void> => {
      const observation = await subject.observe();
      snapshot ??= observation.hosts[0]?.snapshot;
      registry.reconcile({ observed: observation.hosts.map(entry => entry.session), retained: observation.retained });
    };
    await poll();
    expect(registry.snapshot().sessions[0]?.busy).toBe(true);
    state = "gap";
    now = 1_000;
    await poll();
    expect(registry.snapshot().sessions[0]).toMatchObject({ instanceId: host.instanceId, lastSeenAt: new Date(0).toISOString() });
    expect(Object.hasOwn(registry.snapshot().sessions[0]!, "busy")).toBe(false);
    state = "idle";
    await poll();
    expect(registry.snapshot().sessions[0]?.busy).toBe(false);
    expect(stops).toEqual([]);
    state = "working";
    await poll();
    state = "idle";
    await poll();
    expect(stops.map(event => [event.session.instanceId, event.session.busy])).toEqual([[host.instanceId, false]]);
  });

  test("retired admitted hosts release capacity even when discovery remains overfull", async () => {
    const directory = await discoveryDirectory();
    const first = await hostDouble(directory);
    const second = await hostDouble(directory, { instanceId: "bbbb2222cccc3333" });
    const subject = new OmpHostReader({ directory, maxEntries: 2, timeoutMs: HANG_DEADLINE_MS });
    expect((await subject.observe()).hosts).toHaveLength(2);
    await first.unpublish();
    await second.unpublish();
    for (let index = 0; index < 6; index++) {
      await hostDouble(directory, { instanceId: "cccc3333dddd444" + index });
    }
    await subject.observe();
    const replacement = await subject.observe();
    expect(replacement.hosts).toHaveLength(2);
    expect(subject.entryFor(first.instanceId)).toBeUndefined();
    expect(subject.entryFor(second.instanceId)).toBeUndefined();
  });

  test("bounds admitted hosts and queries before the registry sees a directory", async () => {
    const directory = await discoveryDirectory();
    const hosts = [];
    for (let index = 0; index < 6; index++) {
      hosts.push(await hostDouble(directory, { instanceId: "aaaa1111bbbb222" + index }));
    }
    const subject = new OmpHostReader({ directory, maxEntries: 2, timeoutMs: HANG_DEADLINE_MS });
    const observation = await subject.observe();
    expect(observation.hosts).toHaveLength(2);
    expect(hosts.reduce((count, host) => count + host.requests.length, 0)).toBe(2);
    expect(await subject.listEntries()).toHaveLength(2);
  });

  test("publications proven dead stop consuming the discovery budget", async () => {
    const directory = await discoveryDirectory();
    // A killed OMP leaves its discovery file behind; only an OMP list operation ever prunes it.
    for (let index = 0; index < 5; index++) {
      const crashed = await hostDouble(directory, { instanceId: "dddd4444eeee555" + index });
      await crashed.stop();
    }
    const live = await hostDouble(directory, { instanceId: "ffff6666aaaa7777" });
    const subject = new OmpHostReader({ directory,
    maxEntries: 2, timeoutMs: HANG_DEADLINE_MS, openDirectory: path => orderedDirectory(path, name => (name.startsWith(live.entryId) ? 1 : 0)), });
    let admitted: string[] = [];
    for (let round = 0; round < 4 && admitted.length === 0; round++) {
      admitted = (await subject.observe()).hosts.map(host => host.session.instanceId);
    }
    expect(admitted).toEqual([live.instanceId]);
    // Once every stale file is known dead, a later round queries only the live host.
    const before = live.requests.length;
    expect((await subject.observe()).hosts.map(host => host.session.instanceId)).toEqual([live.instanceId]);
    expect(live.requests.length).toBe(before + 1);
  });

  test("a remembered dead publication is read again once its file is replaced", async () => {
    const directory = await discoveryDirectory();
    const crashed = await hostDouble(directory, { instanceId: "dddd4444eeee5550" });
    await crashed.stop();
    const subject = new OmpHostReader({ directory, maxEntries: 1, timeoutMs: HANG_DEADLINE_MS });
    expect((await subject.observe()).hosts).toEqual([]);
    // Upstream never reuses a publication name, so memory keys on the file itself, not the name.
    const live = await hostDouble(directory, { instanceId: "ffff6666aaaa7777" });
    await rename(join(directory, `${live.entryId}.json`), join(directory, `${crashed.entryId}.json`));
    expect((await subject.observe()).hosts.map(host => host.session.instanceId)).toEqual([live.instanceId]);
  });

  test("a new session appears even after dead-publication memory is full", async () => {
    const directory = await discoveryDirectory();
    const hourAgo = new Date(Date.now() - 3_600_000);
    // With maxEntries 1 the reader remembers at most ten dead publications; the eleventh is not.
    for (let index = 0; index < 11; index++) {
      const crashed = await hostDouble(directory, { instanceId: `dddd4444eeee55${String(index).padStart(2, "0")}` });
      await crashed.stop();
      await utimes(join(directory, `${crashed.entryId}.json`), hourAgo, hourAgo);
    }
    const live = await hostDouble(directory, { instanceId: "ffff6666aaaa7777" });
    const subject = new OmpHostReader({ directory,
    maxEntries: 1, timeoutMs: HANG_DEADLINE_MS, openDirectory: path => orderedDirectory(path, name => (name.startsWith(live.entryId) ? 1 : 0)), });
    const seen = new Set<string>();
    for (let round = 0; round < 15; round++) {
      for (const host of (await subject.observe()).hosts) seen.add(host.session.instanceId);
    }
    expect([...seen]).toEqual([live.instanceId]);
  });

  test("residue that is not a publication cannot keep a new session out of the scan", async () => {
    const directory = await discoveryDirectory();
    // A kill between listen and rename leaves a temporary file and a socket, but never a `.json`.
    await writeFile(join(directory, "eeee5555ffff6666.json.tmp"), "{", { mode: 0o600 });
    await writeFile(join(directory, "eeee5555ffff6666.sock"), "", { mode: 0o600 });
    const live = await hostDouble(directory, { instanceId: "ffff6666aaaa7777" });
    const subject = new OmpHostReader({ directory,
    maxEntries: 1, timeoutMs: HANG_DEADLINE_MS, openDirectory: path => orderedDirectory(path, name => (name.startsWith(live.entryId) ? 1 : 0)), });
    expect((await subject.observe()).hosts.map(host => host.session.instanceId)).toEqual([live.instanceId]);
  });

  test.skipIf(process.platform === "win32")("refuses non-private directories, symlinked files, and non-private publications", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    const subject = reader(directory);
    const file = join(directory, host.entryId + ".json");
    await chmod(directory, 0o755);
    expect(await subject.directoryUsable()).toBe(false);
    expect((await subject.observe()).hosts).toEqual([]);
    await chmod(directory, 0o700);
    await chmod(file, 0o644);
    expect(await subject.listEntries()).toEqual([]);
    await chmod(file, 0o600);
    const contents = await readFile(file);
    const target = join(await discoveryDirectory(), "publication");
    await writeFile(target, contents, { mode: 0o600 });
    await rm(file);
    await symlink(target, file);
    expect(await subject.listEntries()).toEqual([]);
    expect(host.requests).toEqual([]);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
  });

  test("ignores oversized and non-regular files without disturbing valid discovery", async () => {
    const directory = await discoveryDirectory();
    const valid = await hostDouble(directory);
    await writeFile(join(directory, "oversized-entry.json"), " ".repeat(64 * 1024 + 1), { mode: 0o600 });
    await mkdir(join(directory, "directory-entry.json"), { mode: 0o700 });
    const fifo = join(directory, "fifo-entry.json");
    if (process.platform !== "win32") {
      const create = Bun.spawn(["mkfifo", "-m", "600", fifo], { stdout: "pipe", stderr: "pipe" });
      expect(await create.exited).toBe(0);
    }
    const observation = await reader(directory).observe();
    expect(observation.hosts.map(host => host.session.instanceId)).toEqual([valid.instanceId]);
    if (process.platform !== "win32") expect((await lstat(fifo)).isFIFO()).toBe(true);
  });

  test("resolves the same directory OMP publishes into, including a renamed config directory", () => {
    const home = join(tmpdir(), "fixture-home");
    expect(resolveOmpDiscoveryDirectory({}, home)).toBe(join(home, ".omp", "run", "collab-hosts"));
    expect(resolveOmpDiscoveryDirectory({ PI_CONFIG_DIR: ".omp-alt" }, home)).toBe(
      join(home, ".omp-alt", "run", "collab-hosts"),
    );
  });

  test("treats an absent directory as healthy and empty", async () => {
    const missing = join(await discoveryDirectory(), "never-created");
    const subject = reader(missing);
    expect(await subject.directoryUsable()).toBe(true);
    expect(await subject.listEntries()).toEqual([]);
  });

  test("refuses a discovery directory that is a symlink", async () => {
    const base = await discoveryDirectory();
    const real = join(base, "real");
    const link = join(base, "link");
    await mkdir(real);
    await symlink(real, link, "dir");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await reader(link).directoryUsable()).toBe(false);
  });

  test("ignores in-flight and foreign artifacts instead of treating them as hosts", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    await writeFile(join(directory, "partial.json.tmp"), "{");
    await writeFile(join(directory, "garbage.json"), "not json");
    await writeFile(
      join(directory, "future.json"),
      JSON.stringify({ version: 99, instanceId: "cccc3333dddd4444", pid: 1, endpoint: "/dev/null", createdAt: 1, token: "b".repeat(64) }),
    );
    const entries = await reader(directory).listEntries();
    expect(entries.map(entry => entry.instanceId)).toEqual([host.instanceId]);
  });
});

describe("OMP host queries", () => {
  test("a snapshot that cannot project to browser metadata cannot poison a valid peer or bind a launch", async () => {
    const directory = await discoveryDirectory();
    const valid = await hostDouble(directory);
    const subject = reader(directory);
    const initial = await subject.observe();
    const snapshot = initial.hosts[0]!.snapshot;
    const hostile = await hostDouble(directory, {
      instanceId: "bbbb2222cccc3333",
      reply: () => ({ ok: true, v: 1, snapshot: {
        ...snapshot,
        instanceId: "bbbb2222cccc3333",
        model: { provider: "p".repeat(MAX_LABEL_CODEPOINTS), id: "m" },
      } }),
    });
    const observation = await subject.observe();
    expect(observation.hosts.map(host => host.session.instanceId)).toEqual([valid.instanceId]);
    expect(subject.entryFor(hostile.instanceId)).toBeUndefined();
    expect(subject.entryFor(valid.instanceId)?.endpoint).toBe(valid.endpoint);
  });

  test.skipIf(process.platform === "win32")("unsafe endpoints cannot be queried and a failed replacement never retargets a card", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    const subject = reader(directory);
    await subject.observe();
    const original = subject.entryFor(host.instanceId)!;
    await chmod(host.endpoint, 0o666);
    expect((await subject.snapshot(original)).status).toBe("unavailable");
    expect(host.requests).toHaveLength(1);
    await chmod(host.endpoint, 0o600);
    const replacement = await hostDouble(await discoveryDirectory(), {
      instanceId: host.instanceId,
      reply: () => ({ ok: false, v: 1, error: "snapshot_unavailable" }),
    });
    const path = join(directory, host.entryId + ".json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...raw, endpoint: replacement.endpoint }));
    const observation = await subject.observe();
    expect(observation.hosts).toEqual([]);
    expect(observation.retained.has(host.instanceId)).toBe(true);
    expect(subject.entryFor(host.instanceId)?.endpoint).toBe(original.endpoint);
    await chmod(path, 0o000);
    expect((await subject.observe()).retained.has(host.instanceId)).toBe(true);
    expect(subject.entryFor(host.instanceId)?.endpoint).toBe(original.endpoint);
    await chmod(path, 0o600);
  });

  test("rejects mismatched and malformed snapshot identities without rebinding a valid host", async () => {
    const directory = await discoveryDirectory();
    const valid = await hostDouble(directory);
    const subject = reader(directory);
    const first = await subject.observe();
    const snapshot = first.hosts[0]!.snapshot;
    const hostile = await hostDouble(directory, {
      instanceId: "bbbb2222cccc3333",
      reply: () => ({ ok: true, v: 1, snapshot }),
    });
    const observation = await subject.observe();
    expect(observation.hosts.map(host => host.session.instanceId)).toEqual([valid.instanceId]);
    expect(subject.entryFor(valid.instanceId)?.endpoint).toBe(valid.endpoint);
    expect(subject.entryFor(hostile.instanceId)).toBeUndefined();
    const hostileEntry = (await subject.listEntries()).find(entry => entry.instanceId === hostile.instanceId)!;
    expect((await subject.snapshot(hostileEntry)).status).toBe("unavailable");

    const wrongPid = await hostDouble(directory, {
      instanceId: "cccc3333dddd4444",
      reply: () => ({ ok: true, v: 1, snapshot: { ...snapshot, instanceId: "cccc3333dddd4444", pid: 9999 } }),
    });
    const malformed = await hostDouble(directory, {
      instanceId: "dddd4444eeee5555",
      reply: () => ({ ok: true, v: 1, snapshot: { ...snapshot, instanceId: "invalid identity" } }),
    });
    const final = await subject.observe();
    expect(final.hosts.map(host => host.session.instanceId)).toEqual([valid.instanceId]);
    expect(subject.entryFor(wrongPid.instanceId)).toBeUndefined();
    expect(subject.entryFor(malformed.instanceId)).toBeUndefined();
  });

  test("ambiguous publications cannot replace a previously validated capability endpoint", async () => {
    const directory = await discoveryDirectory();
    const valid = await hostDouble(directory);
    const subject = reader(directory);
    await subject.observe();
    const competing = await hostDouble(directory, { instanceId: "bbbb2222cccc3333" });
    const path = join(directory, competing.entryId + ".json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...raw, instanceId: valid.instanceId }));
    const observation = await subject.observe();
    expect(observation.hosts).toEqual([]);
    expect(observation.retained.has(valid.instanceId)).toBe(true);
    expect(subject.entryFor(valid.instanceId)?.endpoint).toBe(valid.endpoint);
    expect(subject.entryFor(competing.instanceId)).toBeUndefined();
    expect(competing.requests).toEqual([]);
  });

  test("projects a snapshot onto browser-safe metadata", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory, { cwd: "/Users/you/projects/gateway" });
    const observation = await reader(directory).observe();
    expect(observation.directoryHealthy).toBe(true);
    expect(observation.hosts).toHaveLength(1);
    const [observed] = observation.hosts;
    expect(observed?.session).toMatchObject({
      instanceId: host.instanceId,
      generation: 1,
      title: "Alpha session",
      // The card names the project, not the operator's whole filesystem layout.
      cwdLabel: "gateway",
      model: "anthropic/claude-sonnet-4-5",
      startedAt: "2026-09-14T00:00:00.000Z",
      canControl: true,
      inputRequired: false,
    });
    expect(host.requests[0]).toEqual({ v: 1, token: host.token, op: "snapshot" });
  });

  test("a host stays visible when upstream adds fields under registry v1", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory, {
      additiveSnapshot: { futureField: "FIELD_CANARY", model: { provider: "anthropic", id: "claude-sonnet-4-5", tier: "FIELD_CANARY" } },
      additiveDiscovery: { futureHint: "FIELD_CANARY" },
    });
    const subject = reader(directory);
    const observation = await subject.observe();
    expect(observation.hosts.map(observed => observed.session.instanceId)).toEqual([host.instanceId]);
    expect(JSON.stringify(observation.hosts.map(observed => [observed.snapshot, observed.session]))).not.toContain(
      "FIELD_CANARY",
    );
    expect(subject.entryFor(host.instanceId)).not.toHaveProperty("futureHint");
  });

  test("asks each host on its own connection, never reusing one", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    const subject = reader(directory);
    await subject.observe();
    await subject.observe();
    expect(host.requests).toHaveLength(2);
  });

  test("reports a refused socket as gone and a hung socket as merely unavailable", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    const subject = reader(directory);
    const [entry] = await subject.listEntries();
    if (entry === undefined) throw new Error("expected one published entry");

    const silent = await hostDouble(await discoveryDirectory(), { instanceId: "eeee5555ffff6666" });
    await silent.stop();
    const deadSocket = await subject.snapshot({ ...entry, endpoint: silent.endpoint });
    expect(deadSocket.status).toBe("gone");

    await host.stop();
    const absent = await subject.snapshot(entry);
    expect(absent.status).toBe("gone");
  });

  test("keeps a host that answers a wire error, because only the socket proves death", async () => {
    const directory = await discoveryDirectory();
    await hostDouble(directory, {
      reply: request =>
        request.op === "snapshot" ? { ok: false, v: OMP_REGISTRY_VERSION, error: "snapshot_unavailable" } : undefined,
    });
    const observation = await reader(directory).observe();
    expect(observation.hosts).toHaveLength(0);
    expect([...observation.retained]).toEqual(["aaaa1111bbbb2222"]);
  });
});

describe("OMP query transport", () => {
  test.each(["reply", "timeout"] as const)("closes a peer that holds its side open after %s", async outcome => {
    const directory = await discoveryDirectory();
    const endpoint = join(directory, "held.sock");
    const closed = Promise.withResolvers<void>();
    const server = Bun.listen<undefined>({
      unix: endpoint,
      socket: {
        data(socket) {
          if (outcome === "reply") {
            socket.write(
              `${JSON.stringify({ ok: false, v: OMP_REGISTRY_VERSION, error: "snapshot_unavailable" })}\n`,
            );
            socket.flush();
          }
        },
        close() {
          closed.resolve();
        },
      },
    });
    cleanups.push(async () => server.stop(true));
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
    // hang-deadline: behavior-under-test -- a peer holding its side open must time out and close.
    const subject = new OmpHostReader({ directory, timeoutMs: outcome === "timeout" ? 50 : HANG_DEADLINE_MS });
    const result = await subject.snapshot({
      entryId: "eeee1111bbbb2222",
      version: OMP_REGISTRY_VERSION,
      instanceId: "aaaa1111bbbb2222",
      pid: 4242,
      endpoint,
      createdAt: Date.now(),
      token: "a".repeat(64),
    });
    expect(result).toEqual({
      status: "unavailable",
      detail: outcome === "reply" ? "snapshot_unavailable" : "ETIMEDOUT",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(
        await Promise.race([
          closed.promise.then(() => true),
          new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(false), HANG_DEADLINE_MS);
          }),
        ]),
      ).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  test("late open cannot send credentials and an immediate answer closes before connect resolves", async () => {
    const directory = await discoveryDirectory();
    await hostDouble(directory);
    const [entry] = await reader(directory).listEntries();
    if (entry === undefined) throw new Error("expected a private discovery entry");
    // Isolate the process-wide Bun callback replacement from every other test file.
    const child = Bun.spawn([process.execPath, "--eval", String.raw`import { OmpHostReader } from ${JSON.stringify(new URL("../src/omp-registry.ts", import.meta.url).href)};
      const entry = ${JSON.stringify(entry)};
      const directory = ${JSON.stringify(directory)};
      let unhandled = 0;
      process.on("unhandledRejection", () => { unhandled++; });
      let callbacks;
      let lateWrites = 0, lateClosed = 0;
      const late = { write() { lateWrites++; }, flush() {}, end() { lateClosed++; } };
      const connecting = Promise.withResolvers();
      const invoked = Promise.withResolvers();
      Bun.connect = options => { callbacks = options.socket; invoked.resolve(); return connecting.promise; };
      let returnedBeforeOpen = false;
      // hang-deadline: behavior-under-test -- mocked connect opens only after the query times out.
      const pending = new OmpHostReader({ directory, timeoutMs: 10 }).snapshot(entry).then(result => {
        returnedBeforeOpen = true;
        return result;
      });
      await invoked.promise;
      await Bun.sleep(40);
      const returned = returnedBeforeOpen;
      callbacks.open(late);
      connecting.resolve(late);
      const lateResult = await pending;
      let immediateWrites = 0, immediateClosed = 0;
      const immediate = { write() { immediateWrites++; }, flush() {}, end() { immediateClosed++; } };
      Bun.connect = options => {
        options.socket.open(immediate);
        options.socket.data(immediate, new TextEncoder().encode(JSON.stringify({ ok: false, v: 1, error: "snapshot_unavailable" }) + "\n"));
        return Promise.resolve(immediate);
      };
      const immediateResult = await new OmpHostReader({ directory, timeoutMs: 100 }).snapshot(entry);
      console.log(JSON.stringify({ returnedBeforeOpen: returned, lateWrites, lateClosed, lateStatus: lateResult.status,
        lateDetail: lateResult.detail, immediateWrites, immediateClosed, immediateDetail: immediateResult.detail, unhandled }));`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), HANG_DEADLINE_MS);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({
        returnedBeforeOpen: true,
        lateWrites: 0,
        lateClosed: 1,
        lateStatus: "unavailable",
        lateDetail: "ETIMEDOUT",
        immediateWrites: 1,
        immediateClosed: 1,
        immediateDetail: "snapshot_unavailable",
        unhandled: 0,
      });
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  });
});

describe("launch brokering", () => {
  async function brokered(options: HostDoubleOptions = {}): Promise<{
    registry: SessionRegistry;
    resolver: OmpLaunchResolver;
    host: HostDouble;
  }> {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory, options);
    const subject = reader(directory);
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const observation = await subject.observe();
    registry.reconcile({
      observed: observation.hosts.map(entry => entry.session),
      retained: observation.retained,
    });
    return { registry, resolver: new OmpLaunchResolver({ registry, reader: subject }), host };
  }

  test.each(["generation", "access", "removal", "attention", "expiry"] as const)(
    "withholds an in-flight link after %s authorization changes",
    async change => {
      const directory = await discoveryDirectory();
      const host = await hostDouble(directory, { inputRequired: true });
      const observation = await reader(directory).observe();
      const current = observation.hosts[0];
      if (current === undefined) throw new Error("expected an observed host");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<string>();
      const subject = new OmpHostReader({
        directory,
        request: async (_endpoint, payload) => {
          if (JSON.parse(payload).op === "snapshot") {
            return JSON.stringify({ ok: true, v: OMP_REGISTRY_VERSION, snapshot: current.snapshot });
          }
          entered.resolve();
          return release.promise;
        },
      });
      let now = 0;
      const registry = new SessionRegistry({
        ttlSeconds: 35,
        maxSessions: 10,
        clock: { monotonicNowMs: () => now, wallNowIso: () => "2026-09-14T00:00:00.000Z" },
      });
      const reconcile = (session = current.session): void => {
        registry.reconcile({ observed: [session], retained: new Set() });
      };
      reconcile();
      const requestId = registry.snapshot().sessions[0]?.ask?.requestId;
      if (requestId === undefined) throw new Error("expected an attention request");
      const resolver = new OmpLaunchResolver({ registry, reader: subject });
      const pending = resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "control", requestId });
      await entered.promise;
      let status: Awaited<typeof pending>["status"];
      switch (change) {
        case "generation":
          reconcile({ ...current.session, generation: 2 });
          status = "generation_mismatch";
          break;
        case "access":
          reconcile({ ...current.session, canControl: false });
          status = "mode_unavailable";
          break;
        case "removal":
          registry.reconcile({ observed: [], retained: new Set() });
          status = "missing";
          break;
        case "attention":
          reconcile({ ...current.session, inputRequired: false });
          reconcile();
          status = "request_mismatch";
          break;
        case "expiry":
          now = 35_000;
          status = "missing";
          break;
      }
      release.resolve(JSON.stringify({ ok: true, v: OMP_REGISTRY_VERSION, url: CONTROL_URL }));
      expect(await pending).toEqual({ status });
    },
  );

  test("fetches one capability from the owning host for an explicit launch", async () => {
    const { resolver, host } = await brokered();
    const view = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "view" });
    if (view.status !== "ok") throw new Error(`expected a view capability, got ${view.status}`);
    expect(view.capability.reveal()).toBe(VIEW_URL);
    const control = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "control" });
    if (control.status !== "ok") throw new Error(`expected a control capability, got ${control.status}`);
    expect(control.capability.reveal()).toBe(CONTROL_URL);
    expect(host.requests.filter(request => request.op === "link")).toHaveLength(2);
  });

  test("a stale card is refused rather than handed a newer session's capability", async () => {
    const { resolver, host } = await brokered();
    const stale = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "view" });
    expect(stale.status).toBe("ok");
    const ahead = await resolver.resolve({ instanceId: host.instanceId, generation: 2, mode: "view" });
    expect(ahead.status).toBe("generation_mismatch");
    expect(host.requests.some(request => request.generation === 2)).toBe(false);
  });

  test("control is refused for a view-only session at both the directory and the host", async () => {
    const { resolver, host, registry } = await brokered({ access: "view" });
    expect(registry.snapshot().sessions[0]?.canControl).toBe(false);
    const refused = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "control" });
    expect(refused.status).toBe("mode_unavailable");
  });

  test("a host refusal for the requested access reaches the operator as mode_unavailable", async () => {
    const { resolver, host } = await brokered({
      reply: request =>
        request.op === "link" ? { ok: false, v: OMP_REGISTRY_VERSION, error: "access_unavailable" } : undefined,
    });
    const refused = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "control" });
    expect(refused.status).toBe("mode_unavailable");
  });

  test("answering a dismissed attention request is refused", async () => {
    const { resolver, host, registry } = await brokered({ inputRequired: true });
    const requestId = registry.snapshot().sessions[0]?.ask?.requestId;
    if (requestId === undefined) throw new Error("expected an attention request");
    const current = await resolver.resolve({
      instanceId: host.instanceId,
      generation: 1,
      mode: "control",
      requestId,
    });
    expect(current.status).toBe("ok");
    const stale = await resolver.resolve({
      instanceId: host.instanceId,
      generation: 1,
      mode: "control",
      requestId: "a".repeat(20),
    });
    expect(stale.status).toBe("request_mismatch");
  });

  test("a rediscovered endpoint cannot resolve another instance's capability", async () => {
    const directory = await discoveryDirectory();
    let reply: unknown;
    const host = await hostDouble(directory, {
      reply: request => request.op === "snapshot" ? reply : undefined,
    });
    const observation = await reader(directory).observe();
    const current = observation.hosts[0];
    if (current === undefined) throw new Error("expected an observed host");
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    registry.reconcile({ observed: [current.session], retained: new Set() });
    reply = {
      ok: true,
      v: OMP_REGISTRY_VERSION,
      snapshot: { ...current.snapshot, instanceId: "ffff7777aaaa8888" },
    };
    const resolver = new OmpLaunchResolver({ registry, reader: reader(directory) });
    const resolved = await resolver.resolve({ instanceId: host.instanceId, generation: 1, mode: "view" });
    expect(resolved).toEqual({ status: "missing" });
    expect(host.requests.some(request => request.op === "link")).toBe(false);
  });

  test("an unknown session is refused without querying a capability", async () => {
    const { resolver, host } = await brokered();
    const resolved = await resolver.resolve({ instanceId: "ffff7777aaaa8888", generation: 1, mode: "view" });
    expect(resolved).toEqual({ status: "missing" });
    expect(host.requests.some(request => request.op === "link")).toBe(false);
  });
});

describe("directory polling", () => {
  for (const code of ["EACCES", "EMFILE", "EIO"]) {
    test("directory " + code + " retains a valid card and endpoint until TTL, while absence removes", async () => {
      const directory = await discoveryDirectory();
      await hostDouble(directory);
      // Import the reader only after installing isolated filesystem fault injection.
      const script = [
        'import { mock } from "bun:test";',
        'import * as fs from "node:fs/promises";',
        'const original = { ...fs }; let fault;',
        'mock.module("node:fs/promises", () => ({ ...original,',
        '  readdir: (...args) => fault ? Promise.reject(Object.assign(new Error(), { code: fault })) : original.readdir(...args),',
        '  opendir: (...args) => fault ? Promise.reject(Object.assign(new Error(), { code: fault })) : original.opendir(...args),',
        '}));',
        'const { OmpHostReader, startHostPoller } = await import(' + JSON.stringify(new URL("../src/omp-registry.ts", import.meta.url).href) + ');',
        'const { SessionRegistry } = await import(' + JSON.stringify(new URL("../src/registry.ts", import.meta.url).href) + ');',
        'const reader = new OmpHostReader({ directory: ' + JSON.stringify(directory) + ', timeoutMs: ' + HANG_DEADLINE_MS + ' });',
        'let now = 0;',
        'const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 2, clock: { monotonicNowMs: () => now, wallNowIso: () => new Date(now).toISOString() } });',
        'const poller = startHostPoller({ reader, registry, intervalMs: 3600000 });',
        'await poller.poll(); const originalEntry = reader.entryFor("aaaa1111bbbb2222"); const initial = registry.size;',
        'fault = ' + JSON.stringify(code) + '; now = 34000; await poller.poll();',
        'const retained = registry.size; const healthy = poller.discoveryHealthy; const endpointUnchanged = reader.entryFor("aaaa1111bbbb2222") === originalEntry;',
        'now = 35001; const expired = registry.sweepExpired();',
        'fault = undefined; await poller.poll(); const recovered = registry.size;',
        'fault = "ENOENT"; await poller.poll(); const absent = registry.size; const absentHealthy = poller.discoveryHealthy;',
        'poller.stop(); console.log(JSON.stringify({ initial, retained, healthy, endpointUnchanged, expired, recovered, absent, absentHealthy }));',
      ].join("\n");
      const subprocess = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({ initial: 1, retained: 1, healthy: false, endpointUnchanged: true, expired: 1, recovered: 1, absent: 0, absentHealthy: true });
    });
  }

  test("a stopped host leaves the directory on the next poll", async () => {
    const directory = await discoveryDirectory();
    const host = await hostDouble(directory);
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const poller = startHostPoller({ reader: reader(directory), registry, intervalMs: 3_600_000 });
    cleanups.push(async () => poller.stop());

    await poller.poll();
    expect(registry.size).toBe(1);
    expect(poller.discoveryHealthy).toBe(true);

    await host.unpublish();
    await host.stop();
    await poller.poll();
    expect(registry.size).toBe(0);
  });

  test("a host that stops answering keeps its card until the TTL retires it", async () => {
    const directory = await discoveryDirectory();
    let unavailable = false;
    await hostDouble(directory, {
      reply: request => unavailable && request.op === "snapshot"
        ? { ok: false, v: OMP_REGISTRY_VERSION, error: "snapshot_unavailable" }
        : undefined,
    });
    let now = 0;
    const registry = new SessionRegistry({
      ttlSeconds: 35,
      maxSessions: 10,
      clock: { monotonicNowMs: () => now, wallNowIso: () => new Date(now).toISOString() },
    });
    const poller = startHostPoller({ reader: reader(directory), registry, intervalMs: 3_600_000 });
    cleanups.push(async () => poller.stop());
    await poller.poll();
    expect(registry.size).toBe(1);
    unavailable = true;
    now = 34_000;
    await poller.poll();
    expect(registry.size).toBe(1);
    expect(registry.sweepExpired()).toBe(0);
    now = 35_001;
    expect(registry.sweepExpired()).toBe(1);
    expect(registry.size).toBe(0);
  });

  test("polls never overlap", async () => {
    const directory = await discoveryDirectory();
    await hostDouble(directory);
    const registry = new SessionRegistry({ ttlSeconds: 35, maxSessions: 10 });
    const poller = startHostPoller({ reader: reader(directory), registry, intervalMs: 3_600_000 });
    cleanups.push(async () => poller.stop());
    await Promise.all([poller.poll(), poller.poll(), poller.poll()]);
    expect(registry.size).toBe(1);
  });
});
