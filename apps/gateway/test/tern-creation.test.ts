import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GatewayConfig } from "../src/config.ts";
import type { AdoptionObservation, AdoptionRefresh } from "../src/omp-registry.ts";
import { SessionCreationService, SessionCreationProblem, validateCreationLedger, type CreationLedger } from "../src/tern-creation.ts";
import { parseTernInspection, type TernCreateResult, type TernInspection } from "../src/tern-cli.ts";
import type { SessionCreationRequest } from "@omp-session-gateway/protocol";
const revision = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";
const initialTime = Date.parse("2026-10-24T00:00:00.000Z");
const secret = "CREATION_EXECUTION_PRIVATE_CANARY";
const profile = { id: "omp", label: secret, argv: ["/synthetic/omp", secret], env: { HOME: "/synthetic", PATH: "/bin", SECRET: secret } };
const config: GatewayConfig = {
  http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "http://127.0.0.1:4317", trustedDashboardOrigins: [] },
  fleet: { label: "local", targets: [] }, speech: { browserRecognition: false }, auth: { mode: "dev-localhost", allowedLogins: [] },
  registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 10 }, omp: { discoveryDir: "/synthetic/discovery", queryTimeoutMs: 250 },
  paths: { configDir: "/synthetic", stateDir: "/synthetic", runtimeDir: "/synthetic", tokenPath: "/synthetic/token", configPath: "/synthetic/config" },
  tern: { executable: "/synthetic/tern", projects: [{ id: "project", label: secret,
    workingCopies: [{ id: "main", label: secret, path: "/synthetic/working-copy" }] }], profiles: [profile] },
};
const request: SessionCreationRequest = { clientOperationId: clientId, revision, projectId: "project", workingCopyId: "main", profileId: "omp" };
const host = { instanceId: "created-instance", generation: 1, sessionId: "session-one", pid: 42,
  startedAt: initialTime, createdAt: initialTime, canControl: true };
const empty: TernInspection = { blocks: [], panes: [] };
const basename = "2026-10-24T00-00-00-000Z_session-one.jsonl";
const target: TernInspection = { blocks: ["42"], panes: [{ paneId: "42", sessionBasename: basename }] };
interface FixtureOptions {
  start?: TernCreateResult;
  preflight?: boolean;
  preflightFailure?: "runtime" | "refresh" | "inspect";
  hosts?: AdoptionObservation["hosts"];
  baseline?: AdoptionObservation["hosts"];
  inspection?: TernInspection;
  inspectionJson?: string;
  authorization?: "ok" | "missing";
  failWrite?: number;
  contents?: string;
  heldPreflight?: boolean;
  heldSpawn?: boolean;
  heldAdoption?: number;
  stoppedAdoption?: number;
  publishAfterMs?: number;
  heartbeatSeconds?: number;
  earlyObservation?: boolean;
  lateMetadata?: boolean;
  oldObservation?: boolean;
  refreshUnavailable?: boolean;
  baselineInspection?: TernInspection;
  beforeSpawn?: boolean;
  heldAcceptedCommit?: boolean;
}
async function fixture(options: FixtureOptions = {}) {
  let now = initialTime, monotonic = 1, uuidCall = 0, polls = 0, inspections = 0, creates = 0;
  let runtimeChecks = 0, metadataReported = false;
  let spawnMonotonicMs: number | undefined;
  let contents = options.contents;
  const adoptionRefreshes: number[] = [];
  const writes: string[] = [];
  const completed = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const preflightGate = Promise.withResolvers<void>();
  const spawnGate = Promise.withResolvers<void>();
  const commitGate = Promise.withResolvers<void>();
  const probeGate = Promise.withResolvers<void>();
  const probeEntered = Promise.withResolvers<void>();
  let commitHeld = false, inspecting = false, collisions = 0;
  const listeners = new Set<(batch: AdoptionObservation) => void>();
  const batch = (hosts: AdoptionObservation["hosts"]): AdoptionObservation => ({ round: polls, startedAt: monotonic,
    directoryHealthy: options.preflight !== false, knownInstanceIds: hosts.map(host => host.instanceId), hosts });
  const held = async (signal: AbortSignal, release?: Promise<void>): Promise<void> => {
    const done = Promise.withResolvers<void>();
    if (signal.aborted) return;
    const abort = () => done.resolve();
    signal.addEventListener("abort", abort, { once: true });
    entered.resolve();
    try { await (release ? Promise.race([done.promise, release]) : done.promise); }
    finally { signal.removeEventListener("abort", abort); }
  };
  const ledger: CreationLedger = {
    read: async () => contents,
    write: async text => {
      writes.push(text);
      if (writes.length === options.failWrite) { completed.resolve(); throw new Error(secret); }
      const state = JSON.parse(text).operations.at(-1)?.status.state;
      if (state === "accepted" && options.heldAcceptedCommit) {
        commitHeld = true; entered.resolve();
        await commitGate.promise;
        commitHeld = false;
      }
      contents = text;
      if (["ready", "failed", "started_unavailable", "outcome_unknown"].includes(state)) completed.resolve();
    },
  };
  const fixtureConfig = options.heartbeatSeconds === undefined ? config :
    { ...config, registry: { ...config.registry, heartbeatSeconds: options.heartbeatSeconds } };
  const service = await SessionCreationService.open({ config: fixtureConfig, ledger, uuid: () => uuidCall++ === 0 ? revision : operationId,
    clock: { now: () => now, monotonic: () => monotonic, sleep: async ms => { monotonic += ms; now += ms; } },
    runtimeAvailable: async () => ++runtimeChecks === 1 || options.preflightFailure !== "runtime",
    registry: { authorizeLaunch: () => options.authorization === "missing" ? { status: "missing" } : { status: "ok", session: {} as never } },
    poller: {
      subscribeObservations(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async refreshForAdoption({ signal }): Promise<AdoptionRefresh> {
        const elapsed = spawnMonotonicMs === undefined ? undefined : monotonic - spawnMonotonicMs;
        if (elapsed !== undefined) adoptionRefreshes.push(elapsed);
        polls++; monotonic++;
        if (polls === 1 && options.heldPreflight) await held(signal, preflightGate.promise);
        if (signal.aborted) return { status: "aborted" };
        if (polls === 1 && options.preflightFailure === "refresh") return { status: "timed_out" };
        if (adoptionRefreshes.length === options.heldAdoption) {
          await held(signal); return { status: "aborted" };
        }
        if (adoptionRefreshes.length === options.stoppedAdoption) return { status: "stopped" };
        if (polls > 1 && options.refreshUnavailable) return { status: "timed_out" };
        const published = options.publishAfterMs === undefined ||
          (metadataReported && elapsed !== undefined && elapsed >= options.publishAfterMs);
        const observation = batch(polls === 1 ? options.baseline ?? [] :
          options.hosts ?? (published ? [{ ...host, startedAt: now, createdAt: now }] : []));
        for (const listener of listeners) listener(observation);
        return { status: "ok", observation };
      },
    },
    cli: {
      async inspect(_profile, _signal, createdBlockId) {
        if (inspecting) { collisions++; return undefined; }
        inspecting = true;
        try {
          if (options.heldAcceptedCommit && commitHeld) {
            probeEntered.resolve();
            await probeGate.promise;
          }
          inspections++;
          if (creates === 0) {
            if (inspections > 1 && options.preflightFailure === "inspect") return undefined;
            return options.baselineInspection ?? empty; // availability probes and preflight
          }
          if (options.lateMetadata && inspections >= 3 && inspections <= 5) {
            return parseTernInspection(new TextEncoder().encode(
              '{"sessions":[{"tabs":[{"blocks":[{"id":42}]}]}],"panes":[{"pane":42,"omp_session_file":null}]}',
            ));
          }
          const inspection = options.inspectionJson === undefined ? options.inspection ?? target
            : parseTernInspection(new TextEncoder().encode(options.inspectionJson), createdBlockId);
          metadataReported ||= inspection.panes.some(pane => pane.paneId === "42" && pane.sessionBasename === basename);
          return inspection;
        } finally { inspecting = false; }
      },
      async createTab(_copy, _profile, signal) {
        creates++;
        expect(JSON.parse(contents!).operations[0].status.state).toBe("launching");
        if (options.beforeSpawn) { entered.resolve(); await spawnGate.promise; }
        const spawnedAt = { monotonicMs: monotonic, wallTimeMs: now };
        spawnMonotonicMs = spawnedAt.monotonicMs;
        if (options.earlyObservation) {
          polls++; monotonic++;
          for (const listener of listeners) listener({ ...batch(options.hosts ?? [{ ...host, startedAt: now, createdAt: now }]),
            ...(options.oldObservation ? { startedAt: monotonic - 2 } : {}) });
        }
        if (options.heldSpawn) await held(signal);
        return options.start ?? { kind: "started", blockId: "42", spawnedAt };
      },
    },
  });
  const finish = async () => { await completed.promise; await service.stop(); };
  return { service, writes, finish, adoptionRefreshes, entered: entered.promise, get creates() { return creates; }, get contents() { return contents; },
    completed: completed.promise, releasePreflight: preflightGate.resolve, releaseSpawn: spawnGate.resolve,
    releaseCommit: commitGate.resolve, releaseProbe: probeGate.resolve,
    probeEntered: probeEntered.promise,
    get collisions() { return collisions; }, get discoveryRounds() { return polls; }, get elapsedMs() { return monotonic - 1; },
    observe(hosts: AdoptionObservation["hosts"]) {
      polls++; monotonic++;
      for (const listener of listeners) listener(batch(hosts));
    },
    get subscriptions() { return listeners.size; }, get inspections() { return inspections; },
    advance(ms: number) { now += ms; monotonic += ms; } };
}

describe.skipIf(process.platform === "win32")("configured window subprocess lifecycle", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  async function windowFixture(mode: "success" | "missing-baseline" | "nonzero-spawn" | "closed-adoption", window?: string) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "tern-window-")));
    roots.push(root);
    const executable = join(root, "tern");
    await writeFile(executable, `#!${process.execPath}
import * as fs from "node:fs/promises";
const args = process.argv.slice(2), home = process.env.HOME;
await fs.appendFile(home + "/calls", JSON.stringify(args) + "\\n");
const selector = args.indexOf("--window");
if (process.env.SELECTED === "true" ? selector < 0 || args[selector + 1] !== process.env.WINDOW : selector >= 0) process.exit(2);
const calls = (await fs.readFile(home + "/calls", "utf8")).trim().split("\\n").map(line => JSON.parse(line));
const created = calls.some(call => call[0] === "new");
if (args[0] === "inspect") {
  if (process.env.MODE === "missing-baseline" && calls.length > 1 || process.env.MODE === "closed-adoption" && created) process.exit(1);
  console.log(created ? '{"sessions":[{"tabs":[{"blocks":[{"id":42}]}]}],"panes":[{"pane":42,"omp_session_file":"/synthetic/2026-11-06T00-00-00-000Z_session-one.jsonl"}]}' : '{"sessions":[],"panes":[]}');
} else {
  console.log('{"block":42}');
  if (process.env.MODE === "nonzero-spawn") process.exit(1);
}
`);
    await chmod(executable, 0o700);
    const selected = window !== undefined;
    const runtimeProfile = { ...profile, argv: [process.execPath], env: {
      HOME: root, PATH: dirname(process.execPath), MODE: mode, SELECTED: String(selected), WINDOW: window ?? "",
    } };
    const runtimeConfig = { ...config, paths: { ...config.paths, stateDir: root }, tern: {
      executable, ...(window === undefined ? {} : { window }),
      projects: [{ id: "project", label: "Project", workingCopies: [{ id: "main", label: "Main", path: root }] }],
      profiles: [runtimeProfile],
    } };
    let offset = 0, polls = 0, uuidCall = 0;
    const completed = Promise.withResolvers<void>();
    const service = await SessionCreationService.open({
      config: runtimeConfig, uuid: () => uuidCall++ === 0 ? revision : operationId,
      clock: { now: () => Date.now() + offset, monotonic: () => performance.now() + offset,
        sleep: async () => { offset += 110001; } },
      ledger: { read: async () => undefined, write: async text => {
        const state = JSON.parse(text).operations[0].status.state;
        if (["ready", "failed", "started_unavailable", "outcome_unknown"].includes(state)) completed.resolve();
      } },
      registry: { authorizeLaunch: () => ({ status: "ok", session: {} as never }) },
      poller: {
        subscribeObservations: () => () => {},
        refreshForAdoption: async () => ({ status: "ok", observation: {
          round: ++polls, startedAt: performance.now() + offset, directoryHealthy: true,
          knownInstanceIds: [], hosts: polls === 1 ? [] : [{ ...host, startedAt: Date.now(), createdAt: Date.now() }],
        } }),
      },
    });
    expect(await service.options()).toMatchObject({ available: true });
    return { service, root, async finish() { await completed.promise; await service.stop(); },
      async calls(): Promise<string[][]> { return (await readFile(join(root, "calls"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); } };
  }
  for (const window of [undefined, "", "2"]) {
    test(`binds availability, baseline, spawn and adoption to ${JSON.stringify(window) ?? "the unchanged default"}`, async () => {
      const f = await windowFixture("success", window);
      try {
        await f.service.accept("owner", request, () => true);
        await f.finish();
        expect(f.service.status("owner", operationId)).toMatchObject({ state: "ready" });
        const selector = window === undefined ? [] : ["--window", window];
        expect(await f.calls()).toEqual([
          ["inspect", "--json", ...selector],
          ["inspect", "--json", ...selector],
          ["new", "tab", ...selector, "--json", "--keep-open", "--cwd", f.root, "--", await realpath(process.execPath)],
          ["inspect", "--json", ...selector],
        ]);
      } finally { await f.service.stop(); }
    });
  }
  for (const [mode, state, error, creates] of [
    ["missing-baseline", "failed", "preflight_failed", 0],
    ["nonzero-spawn", "outcome_unknown", "launch_outcome_unknown", 1],
    ["closed-adoption", "started_unavailable", "adoption_timeout", 1],
  ] as const) {
    test(`${mode} keeps ${state}/${error} without fallback or respawn`, async () => {
      const f = await windowFixture(mode, "2");
      try {
        await f.service.accept("owner", request, () => true);
        await f.finish();
        expect(f.service.status("owner", operationId)).toMatchObject({ state, error });
        expect((await f.calls()).filter(call => call[0] === "new")).toHaveLength(creates);
        expect((await f.calls()).every(call => call[call.indexOf("--window") + 1] === "2")).toBe(true);
        expect((await f.service.accept("owner", request, () => { throw new Error("replay cannot spawn"); })).status).toBe(200);
        expect((await f.calls()).filter(call => call[0] === "new")).toHaveLength(creates);
      } finally { await f.service.stop(); }
    });
  }
});

describe("durable session creation transitions", () => {
  test("overlaps preflight inspect with discovery without spawning early", async () => {
    const f = await fixture({ heldPreflight: true });
    try {
      await f.service.accept("owner", request, () => true);
      await f.entered;
      expect({ inspections: f.inspections, creates: f.creates }).toEqual({ inspections: 2, creates: 0 });
      f.releasePreflight();
      await f.finish();
      expect(f.service.status("owner", operationId)).toMatchObject({ state: "ready" });
    } finally { await f.service.stop(); }
  });
  for (const failure of ["runtime", "refresh", "inspect"] as const) {
    test(`preflight ${failure} failure cannot spawn`, async () => {
      const f = await fixture({ preflightFailure: failure });
      await f.service.accept("owner", request, () => true);
      await f.finish();
      expect(f.service.status("owner", operationId)).toMatchObject({ state: "failed", error: "preflight_failed" });
      expect(f.creates).toBe(0);
      expect(f.discoveryRounds).toBe(failure === "runtime" ? 0 : 1);
    });
  }
  test("adopts a late Control host without a heartbeat", async () => {
    const f = await fixture({ publishAfterMs: 6_000 });
    await f.service.accept("owner", request, () => true);
    await f.finish();
    expect({ status: f.service.status("owner", operationId), rounds: f.discoveryRounds }).toMatchObject({
      status: { state: "ready", session: { instanceId: host.instanceId, generation: host.generation } },
      rounds: 5,
    });
  });
  test("backs off to the configured heartbeat and budgets eight follow-ups over the full deadline", async () => {
    const f = await fixture({ hosts: [], heartbeatSeconds: 5 });
    await f.service.accept("owner", request, () => true);
    await f.finish();
    expect(f.service.status("owner", operationId)).toMatchObject({ state: "started_unavailable", error: "adoption_timeout" });
    expect(f.adoptionRefreshes.map(ms => Math.floor(ms / 1_000))).toEqual([0, 1, 3, 7, 12, 17, 22, 27, 32]);
    expect(f.elapsedMs).toBe(110_000);
  });
  for (const [reason, options, count] of [
    ["session-file metadata is absent", { inspection: { blocks: target.blocks, panes: [{ paneId: "42" }] } }, 1],
    ["the immediate refresh is stopped", { stoppedAdoption: 1 }, 1],
    ["a follow-up refresh is stopped", { stoppedAdoption: 2 }, 2],
  ] as const) {
    test(`limits forced discovery when ${reason}`, async () => {
      const f = await fixture({ hosts: [], ...options });
      await f.service.accept("owner", request, () => true);
      await f.finish();
      expect(f.service.status("owner", operationId)).toMatchObject({ state: "started_unavailable", error: "adoption_timeout" });
      expect(f.adoptionRefreshes).toHaveLength(count);
      expect(f.elapsedMs).toBe(110_000);
    });
  }
  test("rejects an observation from a pre-spawn CLI hold when the following fresh refresh times out", async () => {
    const f = await fixture({ beforeSpawn: true, refreshUnavailable: true });
    await f.service.accept("owner", request, () => true);
    await f.entered;
    f.observe([host]);
    f.advance(1);
    f.releaseSpawn();
    await f.finish();
    expect(f.service.status("owner", operationId)).toMatchObject({ state: "started_unavailable", error: "adoption_timeout" });
  });
  test("options during the accepted disk checkpoint cannot collide with operation execution", async () => {
    const f = await fixture({ heldAcceptedCommit: true });
    const admitted = f.service.accept("owner", request, () => true);
    await f.entered;
    f.advance(5001);
    const inspections = f.inspections;
    // The reservation must let options finish without starting a competing CLI probe.
    expect(await f.service.options()).toMatchObject({ available: true });
    expect(f.inspections).toBe(inspections);
    f.releaseCommit();
    await admitted;
    await f.completed;
    await f.finish();
    expect(f.service.status("owner", operationId)).toMatchObject({ state: "ready" });
    expect(f.collisions).toBe(0);
    expect(f.creates).toBe(1);
  });
  test("execution waits for a probe already in flight before its reservation", async () => {
    const f = await fixture({ heldAcceptedCommit: true });
    let options: Promise<unknown> | undefined;
    const admitted = f.service.accept("owner", request, () => {
      f.advance(5001);
      options = f.service.options();
      return true;
    });
    await f.entered;
    await f.probeEntered;
    f.releaseCommit();
    await admitted;
    expect(f.service.status("owner", operationId)?.state).toBe("accepted");
    expect(f.collisions).toBe(0);
    expect(f.creates).toBe(0);
    f.releaseProbe();
    await options;
    await f.finish();
    expect(f.service.status("owner", operationId)?.state).toBe("ready");
    expect(f.collisions).toBe(0);
  });
  for (const olderField of ["startedAt", "createdAt"] as const) {
    test(`rejects ${olderField} before actual spawn even when the observation round is fresh`, async () => {
      const f = await fixture({ beforeSpawn: true,
        hosts: [{ ...host, startedAt: initialTime + 2, createdAt: initialTime + 2, [olderField]: initialTime + 1 }] });
      await f.service.accept("owner", request, () => true);
      await f.entered;
      f.advance(2);
      f.releaseSpawn();
      await f.finish();
      expect(f.service.status("owner", operationId)).toMatchObject({ state: "started_unavailable", error: "adoption_timeout" });
    });
  }
  test("persists accepted then launching then awaiting then ready; carries no execution secrets", async () => {
    const f = await fixture({ earlyObservation: true, refreshUnavailable: true });
    expect(await f.service.accept(" Owner@EXAMPLE.COM ", request, () => true)).toEqual({ status: 202, receipt: { operationId, state: "accepted" } });
    await f.finish();
    expect(f.writes.map(text => JSON.parse(text).operations[0].status.state)).toEqual(["accepted", "launching", "awaiting_omp", "ready"]);
    expect(f.service.status("owner@example.com", operationId)).toMatchObject({ state: "ready", session: { instanceId: host.instanceId, generation: 1 } });
    expect(f.service.status("other@example.com", operationId)).toBeUndefined();
    expect(f.creates).toBe(1); expect(f.subscriptions).toBe(0);
    expect(f.writes.join()).not.toContain(secret);
    expect(f.writes.join()).not.toContain("/synthetic");
    expect(f.writes.join()).not.toContain("session-one.jsonl");
    expect(f.writes.join()).not.toContain("capability");
    expect(f.writes.join()).not.toContain("spawnedAt");
  });
  test("coalesces concurrent identity-scoped duplicates without charging admission or respawning", async () => {
    const f = await fixture(); let charges = 0;
    const admit = () => { charges++; return true; };
    const results = await Promise.all([f.service.accept("owner", request, admit), f.service.accept("owner", request, admit)]);
    expect(results.map(result => result.status)).toEqual([202, 200]); expect(charges).toBe(1);
    await f.finish();
    expect((await f.service.accept("owner", request, admit)).receipt.state).toBe("ready");
    expect(charges).toBe(1); expect(f.creates).toBe(1);
    await expect(f.service.accept("owner", { ...request, revision: operationId }, admit)).rejects.toMatchObject({ status: 409, code: "operation_conflict" });
    await expect(f.service.accept("other", { ...request, revision: operationId }, admit)).rejects.toMatchObject({ code: "revision_mismatch" });
  });
  test("enforces one active operation globally and charges only genuinely admitted operations", async () => {
    const f = await fixture({ heldPreflight: true });
    await f.service.accept("owner", request, () => true); await f.entered;
    await expect(f.service.accept("other", request, () => { throw new Error("must not charge busy"); })).rejects.toMatchObject({ code: "creation_busy", status: 429 });
    await f.service.stop(); expect(f.creates).toBe(0);
    expect(f.service.status("owner", operationId)).toMatchObject({ state: "failed", error: "interrupted" });
    const denied = await fixture();
    await expect(denied.service.accept("owner", request, () => false)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(denied.writes).toHaveLength(0); expect(denied.creates).toBe(0); await denied.service.stop();
  });
  for (const [options, state, error] of [
    [{ preflight: false }, "failed", "preflight_failed"],
    [{ start: { kind: "not_started" } }, "failed", "spawn_failed"],
    [{ start: { kind: "unknown" } }, "outcome_unknown", "launch_outcome_unknown"],
    [{ baselineInspection: target }, "outcome_unknown", "launch_outcome_unknown"],
    [{ earlyObservation: true, oldObservation: true, refreshUnavailable: true }, "started_unavailable", "adoption_timeout"],
    [{ hosts: [host, { ...host, instanceId: "another-instance" }] }, "started_unavailable", "correlation_ambiguous"],
    [{ hosts: [{ ...host, canControl: false }] }, "started_unavailable", "control_unavailable"],
    [{ hosts: [] }, "started_unavailable", "adoption_timeout"],
    [{ inspection: empty }, "started_unavailable", "adoption_timeout"],
    [{ authorization: "missing" }, "started_unavailable", "adoption_timeout"],
    [{ baseline: [host] }, "started_unavailable", "adoption_timeout"],
    [{ baseline: [{ ...host, instanceId: "old-instance" }] }, "started_unavailable", "adoption_timeout"],
    [{ hosts: [{ ...host, startedAt: initialTime - 1 }] }, "started_unavailable", "adoption_timeout"],
    [{ hosts: [{ ...host, createdAt: initialTime - 1 }] }, "started_unavailable", "adoption_timeout"],
    [{ hosts: [{ ...host, sessionId: "session" }] }, "started_unavailable", "adoption_timeout"],
  ] as const) {
    test(`classifies ${JSON.stringify(options)} as ${state}/${error}`, async () => {
      const f = await fixture(options); await f.service.accept("owner", request, () => true); await f.finish();
      expect(f.service.status("owner", operationId)).toMatchObject({ state, error }); expect(f.subscriptions).toBe(0);
    });
  }
  test("deduplicates repeated identical bindings rather than declaring ambiguity", async () => {
    const f = await fixture({ hosts: [host, host] }); await f.service.accept("owner", request, () => true); await f.finish();
    expect(f.service.status("owner", operationId)?.state).toBe("ready");
  });
  test("keeps inspecting null session-file metadata until it appears after the immediate discovery poll", async () => {
    const f = await fixture({ lateMetadata: true }); await f.service.accept("owner", request, () => true); await f.finish();
    expect(f.service.status("owner", operationId)?.state).toBe("ready");
    expect(f.inspections).toBe(6);
    expect(f.writes.map(text => JSON.parse(text).operations[0].status.state)).toEqual(["accepted", "launching", "awaiting_omp", "ready"]);
  });
  for (const [stage, options, state] of [
    ["held spawn", { heldSpawn: true }, "outcome_unknown"],
    ["immediate refresh", { heldAdoption: 1 }, "started_unavailable"],
    ["follow-up refresh", { heldAdoption: 2, hosts: [] }, "started_unavailable"],
  ] as const) {
    test(`shutdown aborts ${stage}, durably classifies it and removes its subscription`, async () => {
      const f = await fixture(options);
      await f.service.accept("owner", request, () => true);
      try {
        expect(await Promise.race([f.entered.then(() => "held"), f.completed.then(() => "completed")])).toBe("held");
      } finally { await f.service.stop(); }
      expect(f.service.status("owner", operationId)).toMatchObject({ state, error: "interrupted" });
      expect(f.creates).toBe(1); expect(f.subscriptions).toBe(0);
    });
  }
  for (const checkpoint of [1, 2, 3, 4]) {
    test(`disk failure at checkpoint ${checkpoint} disables acknowledgements/status and prevents further effects`, async () => {
      const f = await fixture({ failWrite: checkpoint });
      if (checkpoint === 1) await expect(f.service.accept("owner", request, () => true)).rejects.toMatchObject({ code: "ledger_unavailable" });
      else await f.service.accept("owner", request, () => true);
      await f.finish();
      expect(() => f.service.status("owner", operationId)).toThrow(SessionCreationProblem);
      expect(await f.service.options()).toMatchObject({ available: false, reason: "ledger_unavailable" });
      expect(f.creates).toBe(checkpoint <= 2 ? 0 : 1); expect(f.writes).toHaveLength(checkpoint);
    });
  }
});

describe("created command exit", () => {
  function document(blocks: readonly { id: number; exited?: unknown }[], withSession = false): string {
    return JSON.stringify({ sessions: [{ tabs: [{ blocks }] }], panes: withSession
      ? [{ pane: 42, omp_session_file: "/synthetic/session-one.jsonl", exited: 1 }] : [] });
  }
  const exitedStatus = { operationId, state: "started_unavailable", error: "command_exited",
    updatedAt: new Date(initialTime).toISOString() } as const;

  for (const exited of [127, 1, 0]) {
    test(`reports exit ${exited} on the first inspection without waiting for the deadline`, async () => {
      const f = await fixture({ inspectionJson: document([{ id: 42, exited }]), hosts: [] });
      await f.service.accept("owner", request, () => true);
      await f.finish();
      expect(f.service.status("owner", operationId)).toEqual(exitedStatus);
    });
  }
  test("prefers the block exit over an adoptable host and durably retains the result on restart", async () => {
    const f = await fixture({ inspectionJson: document([{ id: 42, exited: 0 }], true) });
    await f.service.accept("owner", request, () => true);
    await f.finish();
    expect(f.service.status("owner", operationId)).toEqual(exitedStatus);
    expect(validateCreationLedger(f.contents!)[0]?.status).toEqual(exitedStatus);
    const restarted = await fixture({ contents: f.contents! });
    expect(restarted.service.status("owner", operationId)).toEqual(exitedStatus);
    expect(restarted.creates).toBe(0);
    await restarted.service.stop();
  });
  test("still adopts with absent, running or unrecognized exit metadata despite another block or pane's exit", async () => {
    for (const exited of [undefined, null, "1", { status: 1 }]) {
      const f = await fixture({ inspectionJson: document([{ id: 42, exited }, { id: 43, exited: 1 }], true) });
      await f.service.accept("owner", request, () => true);
      await f.finish();
      expect(f.service.status("owner", operationId)).toMatchObject({ state: "ready" });
    }
  });
});

describe("private ledger startup and retention", () => {
  const record = (state: "accepted" | "launching" | "awaiting_omp" | "ready") => ({ owner: "owner", request,
    createdAt: new Date(initialTime).toISOString(), expiresAt: new Date(initialTime + 86400000).toISOString(),
    status: { operationId, state, updatedAt: new Date(initialTime).toISOString(),
      ...(state === "ready" ? { session: { instanceId: host.instanceId, generation: 1 } } : {}) },
    ...(["awaiting_omp", "ready"].includes(state) ? { blockId: "42" } : {}) });
  for (const [state, expected] of [["accepted", "failed"], ["launching", "outcome_unknown"], ["awaiting_omp", "started_unavailable"], ["ready", "ready"]] as const) {
    test(`restart classifies durable ${state} without resuming any execution`, async () => {
      const f = await fixture({ contents: JSON.stringify({ version: 1, operations: [record(state)] }) });
      expect(f.service.status("owner", operationId)).toMatchObject({ state: expected, ...(state === "ready" ? {} : { error: "interrupted" }) });
      expect(f.creates).toBe(0); expect(f.inspections).toBe(0);
      expect((await f.service.accept("owner", request, () => { throw new Error("must not charge replay"); })).status).toBe(200);
      await f.service.stop();
    });
  }
  test("corrupt/unsupported/duplicate-key ledgers disable without overwrite", async () => {
    for (const contents of ['{', '{"version":1,"version":1,"operations":[]}', '{"version":2,"operations":[]}',
      JSON.stringify({ version: 1, operations: [{ ...record("accepted"), secret }] }),
      JSON.stringify({ version: 1, operations: [{ ...record("awaiting_omp"), blockId: "72057594037927936" }] })]) {
      const f = await fixture({ contents });
      expect(await f.service.options()).toMatchObject({ reason: "ledger_unavailable" });
      expect(f.writes).toHaveLength(0); expect(f.creates).toBe(0); await f.service.stop();
    }
  });
  test("never evicts unexpired records to admit work; prunes expired records before admission", async () => {
    const operations = Array.from({ length: 64 }, (_, i) => ({ ...record("ready"),
      request: { ...request, clientOperationId: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}` },
      status: { ...record("ready").status, operationId: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}` } }));
    const f = await fixture({ contents: JSON.stringify({ version: 1, operations }) });
    await expect(f.service.accept("owner", request, () => true)).rejects.toMatchObject({ code: "creation_capacity" });
    expect(f.writes).toHaveLength(0);
    f.advance(86400001);
    expect(f.service.status("owner", operations[0]!.status.operationId)).toBeUndefined();
    await f.service.accept("owner", request, () => true); await f.finish();
    expect(validateCreationLedger(f.contents!)).toHaveLength(1);
  });
});
