import { describe, expect, test } from "bun:test";
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
const target: TernInspection = { blocks: ["42"], panes: [{ paneId: "42", sessionBasename: "2026-10-24T00-00-00-000Z_session-one.jsonl" }] };
interface FixtureOptions {
  start?: TernCreateResult;
  preflight?: boolean;
  hosts?: AdoptionObservation["hosts"];
  baseline?: AdoptionObservation["hosts"];
  inspection?: TernInspection;
  authorization?: "ok" | "missing";
  failWrite?: number;
  contents?: string;
  heldPreflight?: boolean;
  heldSpawn?: boolean;
  heldAdoption?: boolean;
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
  let contents = options.contents;
  const writes: string[] = [];
  const completed = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const spawnGate = Promise.withResolvers<void>();
  const commitGate = Promise.withResolvers<void>();
  const probeGate = Promise.withResolvers<void>();
  let commitHeld = false, inspecting = false, collisions = 0;
  const listeners = new Set<(batch: AdoptionObservation) => void>();
  const batch = (hosts: AdoptionObservation["hosts"]): AdoptionObservation => ({ round: polls, startedAt: monotonic,
    directoryHealthy: options.preflight !== false, knownInstanceIds: hosts.map(host => host.instanceId), hosts });
  const held = async (signal: AbortSignal): Promise<void> => {
    const done = Promise.withResolvers<void>();
    if (signal.aborted) return;
    signal.addEventListener("abort", () => done.resolve(), { once: true });
    entered.resolve();
    return done.promise;
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
  const service = await SessionCreationService.open({ config, ledger, uuid: () => uuidCall++ === 0 ? revision : operationId,
    clock: { now: () => now, monotonic: () => monotonic,
      sleep: async ms => { const elapsed = options.lateMetadata ? ms : Math.max(ms, 110001); monotonic += elapsed; now += elapsed; } },
    runtimeAvailable: async () => true,
    registry: { authorizeLaunch: () => options.authorization === "missing" ? { status: "missing" } : { status: "ok", session: {} as never } },
    poller: {
      subscribeObservations(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async refreshForAdoption({ signal }): Promise<AdoptionRefresh> {
        polls++; monotonic++;
        if ((polls === 1 && options.heldPreflight) || (polls > 1 && options.heldAdoption)) {
          await held(signal); return { status: "aborted" };
        }
        if (polls > 1 && options.refreshUnavailable) return { status: "timed_out" };
        const observation = batch(polls === 1 ? options.baseline ?? [] : options.hosts ?? [{ ...host, startedAt: now, createdAt: now }]);
        for (const listener of listeners) listener(observation);
        return { status: "ok", observation };
      },
    },
    cli: {
      async inspect() {
        if (inspecting) { collisions++; return undefined; }
        inspecting = true;
        try {
          if (options.heldAcceptedCommit && commitHeld) await probeGate.promise;
          inspections++;
          if (creates === 0) return options.baselineInspection ?? empty; // availability probes and preflight
          if (options.lateMetadata && inspections >= 3 && inspections <= 5) {
            return parseTernInspection(new TextEncoder().encode(
              '{"sessions":[{"tabs":[{"blocks":[{"id":42}]}]}],"panes":[{"pane":42,"omp_session_file":null}]}',
            ));
          }
          return options.inspection ?? target;
        } finally { inspecting = false; }
      },
      async createTab(_copy, _profile, signal) {
        creates++;
        expect(JSON.parse(contents!).operations[0].status.state).toBe("launching");
        if (options.beforeSpawn) { entered.resolve(); await spawnGate.promise; }
        const spawnedAt = { monotonicMs: monotonic, wallTimeMs: now };
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
  return { service, writes, finish, entered: entered.promise, get creates() { return creates; }, get contents() { return contents; },
    completed: completed.promise, releaseSpawn: spawnGate.resolve, releaseCommit: commitGate.resolve, releaseProbe: probeGate.resolve,
    get collisions() { return collisions; },
    observe(hosts: AdoptionObservation["hosts"]) {
      polls++; monotonic++;
      for (const listener of listeners) listener(batch(hosts));
    },
    get subscriptions() { return listeners.size; }, get inspections() { return inspections; },
    advance(ms: number) { now += ms; monotonic += ms; } };
}

describe("durable session creation transitions", () => {
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
    const options = f.service.options();
    // Let a newly started availability probe reach its CLI await before releasing the disk checkpoint.
    await Promise.resolve();
    f.releaseCommit();
    await admitted;
    await f.completed;
    f.releaseProbe();
    await options;
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
    await Promise.resolve();
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
  for (const [option, state] of [["heldSpawn", "outcome_unknown"], ["heldAdoption", "started_unavailable"]] as const) {
    test(`shutdown durably classifies ${option} and removes its subscription`, async () => {
      const f = await fixture({ [option]: true }); await f.service.accept("owner", request, () => true); await f.entered;
      await f.service.stop(); expect(f.service.status("owner", operationId)).toMatchObject({ state, error: "interrupted" });
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
