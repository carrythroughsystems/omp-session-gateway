import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  parseSessionCreationRequest, parseSessionCreationStatus, parseSessionCreationUuid,
  type SessionCreationOptions, type SessionCreationRequest, type SessionCreationReceipt,
  type SessionCreationStatus, type SessionCreationUnavailableReason,
} from "@omp-session-gateway/protocol";
import { readPrivateTextFile, writePrivateTextFile, type GatewayConfig, type TernProfile, type TernWorkingCopy } from "./config.ts";
import type { AdoptionObservation, HostPoller } from "./omp-registry.ts";
import type { SessionRegistry } from "./registry.ts";
import { TernCli, validateTernRuntime, parseTernJson, matchingTernBasename, sessionBasenameMatches, type TernCliBoundary } from "./tern-cli.ts";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_LEDGER_BYTES = 512 * 1024;
const terminal = (state: SessionCreationStatus["state"]): boolean => !["accepted", "launching", "awaiting_omp"].includes(state);
export class SessionCreationProblem extends Error {
  constructor(readonly status: number, readonly code: string) { super("Session creation is unavailable."); }
}
interface Operation {
  readonly owner: string;
  readonly request: SessionCreationRequest;
  readonly status: SessionCreationStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly blockId?: string;
}
export interface CreationLedger {
  read(): Promise<string | undefined>;
  write(content: string): Promise<void>;
}
export interface CreationClock {
  now(): number;
  monotonic(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
const clock: CreationClock = {
  now: Date.now, monotonic: () => performance.now(),
  sleep: (ms, signal) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
    return promise;
  },
};
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid ledger");
  const record = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))) throw new Error("invalid ledger");
  return record;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("invalid ledger");
  return value;
}
function ownerKey(value: string): string {
  const owner = value.normalize("NFC").trim().toLowerCase();
  if (!owner || owner.length > 320 || /[\0\r\n,]/u.test(owner)) throw new Error("invalid owner");
  return owner;
}
export function validateCreationLedger(text: string): readonly Operation[] {
  if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) throw new Error("invalid ledger");
  // Shared bounded tokenizer validates syntax/duplicate keys before numeric fields are decoded.
  parseTernJson(new TextEncoder().encode(text));
  const document = exact(JSON.parse(text), ["version", "operations"]);
  if (document.version !== 1 || !Array.isArray(document.operations) || document.operations.length > 64) throw new Error("invalid ledger");
  const ids = new Set<string>();
  const clients = new Set<string>();
  return document.operations.map(value => {
    const record = exact(value, ["owner", "request", "status", "createdAt", "expiresAt"], ["blockId"]);
    if (typeof record.owner !== "string" || ownerKey(record.owner) !== record.owner) throw new Error("invalid ledger");
    const request = parseSessionCreationRequest(record.request);
    const status = parseSessionCreationStatus(record.status);
    const createdAt = date(record.createdAt), expiresAt = date(record.expiresAt);
    if (Date.parse(expiresAt) !== Date.parse(createdAt) + RETENTION_MS || Date.parse(status.updatedAt) < Date.parse(createdAt)) throw new Error("invalid ledger");
    const requiresBlock = ["awaiting_omp", "ready", "started_unavailable"].includes(status.state);
    if (requiresBlock !== Object.hasOwn(record, "blockId") || (requiresBlock &&
        (typeof record.blockId !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(record.blockId) || BigInt(record.blockId) >> 56n !== 0n))) throw new Error("invalid ledger");
    const client = record.owner + "\0" + request.clientOperationId;
    if (ids.has(status.operationId) || clients.has(client)) throw new Error("invalid ledger");
    ids.add(status.operationId); clients.add(client);
    return { owner: record.owner, request, status, createdAt, expiresAt,
      ...(requiresBlock ? { blockId: record.blockId as string } : {}) };
  });
}
function interrupted(operation: Operation, updatedAt: string): Operation {
  const state = operation.status.state;
  if (terminal(state)) return operation;
  const next = state === "accepted" ? "failed" : state === "launching" ? "outcome_unknown" : "started_unavailable";
  return { ...operation, status: { operationId: operation.status.operationId, updatedAt, state: next, error: "interrupted" } };
}
export interface SessionCreationDependencies {
  readonly config: GatewayConfig;
  readonly poller: Pick<HostPoller, "refreshForAdoption" | "subscribeObservations">;
  readonly registry: Pick<SessionRegistry, "authorizeLaunch">;
  readonly cli?: TernCliBoundary;
  readonly ledger?: CreationLedger;
  readonly clock?: CreationClock;
  readonly uuid?: () => string;
  readonly runtimeAvailable?: () => Promise<boolean>;
}

export class SessionCreationService {
  readonly #dependencies: SessionCreationDependencies;
  readonly #clock: CreationClock;
  readonly #uuid: () => string;
  readonly #cli: TernCliBoundary;
  readonly #ledger: CreationLedger;
  readonly #revision: string;
  #operations: readonly Operation[] = [];
  #healthy = true;
  #stopped = false;
  #chain: Promise<unknown> = Promise.resolve();
  #execution: Promise<void> | undefined;
  #abort = new AbortController();
  #availability: { at: number; reason?: SessionCreationUnavailableReason } | undefined;
  #probing: Promise<SessionCreationUnavailableReason | undefined> | undefined;
  private constructor(dependencies: SessionCreationDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? clock;
    this.#uuid = dependencies.uuid ?? randomUUID;
    this.#revision = parseSessionCreationUuid(this.#uuid());
    this.#cli = dependencies.cli ?? new TernCli(dependencies.config.tern?.executable ?? "");
    const path = join(dependencies.config.paths.stateDir, "session-creations.json");
    this.#ledger = dependencies.ledger ?? {
      read: () => readPrivateTextFile(path, MAX_LEDGER_BYTES),
      write: content => writePrivateTextFile(path, content, { syncDirectory: true }),
    };
  }
  static async open(dependencies: SessionCreationDependencies): Promise<SessionCreationService> {
    const service = new SessionCreationService(dependencies);
    try {
      const text = await service.#ledger.read();
      if (text !== undefined) {
        const loaded = validateCreationLedger(text);
        if (loaded.filter(operation => !terminal(operation.status.state)).length > 1) throw new Error("invalid ledger");
        const now = new Date(service.#clock.now()).toISOString();
        const recovered = loaded.map(operation => interrupted(operation, now))
          .filter(operation => Date.parse(operation.expiresAt) > service.#clock.now());
        if (JSON.stringify(recovered) !== JSON.stringify(loaded)) await service.#commit(recovered);
        else service.#operations = loaded;
      }
    } catch { service.#healthy = false; }
    return service;
  }
  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(action);
    this.#chain = result.catch(() => {});
    return result;
  }
  async #commit(operations: readonly Operation[]): Promise<void> {
    if (!this.#healthy) throw new SessionCreationProblem(503, "ledger_unavailable");
    try {
      const content = JSON.stringify({ version: 1, operations }) + "\n";
      validateCreationLedger(content);
      await this.#ledger.write(content);
      this.#operations = operations;
    } catch {
      this.#healthy = false;
      this.#abort.abort();
      throw new SessionCreationProblem(503, "ledger_unavailable");
    }
  }
  async #probe(): Promise<SessionCreationUnavailableReason | undefined> {
    if (!this.#healthy) return "ledger_unavailable";
    const config = this.#dependencies.config.tern;
    if (!config) return "not_configured";
    if (!config.executable || !config.projects?.length || !config.profiles?.length) return "configuration_unavailable";
    if (this.#stopped) return "tern_unavailable";
    if (this.#execution || (this.#availability && this.#clock.monotonic() - this.#availability.at < 5000)) {
      return this.#availability?.reason;
    }
    this.#probing ??= (async () => {
      const runtime = await (this.#dependencies.runtimeAvailable?.() ?? validateTernRuntime(config));
      const reason = !runtime ? "configuration_unavailable" :
        await this.#cli.inspect(config.profiles![0]!, this.#abort.signal) ? undefined : "tern_unavailable";
      this.#availability = { at: this.#clock.monotonic(), ...(reason ? { reason } : {}) };
      return reason;
    })().catch(() => "tern_unavailable" as const).finally(() => { this.#probing = undefined; });
    return this.#probing;
  }
  async options(): Promise<SessionCreationOptions> {
    const reason = await this.#probe();
    if (reason) return { version: 1, revision: this.#revision, available: false, reason, projects: [], profiles: [] };
    return { version: 1, revision: this.#revision, available: true,
      projects: this.#dependencies.config.tern!.projects!.map(project => ({ id: project.id, label: project.label,
        workingCopies: project.workingCopies.map(copy => ({ id: copy.id, label: copy.label })) })),
      profiles: this.#dependencies.config.tern!.profiles!.map(profile => ({ id: profile.id, label: profile.label })) };
  }
  accept(identityKey: string, raw: SessionCreationRequest, admitNew: () => boolean): Promise<{ status: 200 | 202; receipt: SessionCreationReceipt }> {
    const request = parseSessionCreationRequest(raw);
    const owner = ownerKey(identityKey);
    return this.#serialize(async () => {
      if (!this.#healthy) throw new SessionCreationProblem(503, "ledger_unavailable");
      const retained = this.#operations.filter(operation => !terminal(operation.status.state) || Date.parse(operation.expiresAt) > this.#clock.now());
      const existing = retained.find(operation => operation.owner === owner && operation.request.clientOperationId === request.clientOperationId);
      if (existing) {
        if (JSON.stringify(existing.request) !== JSON.stringify(request)) throw new SessionCreationProblem(409, "operation_conflict");
        return { status: 200, receipt: { operationId: existing.status.operationId, state: existing.status.state } };
      }
      if (request.revision !== this.#revision) throw new SessionCreationProblem(409, "revision_mismatch");
      if (this.#stopped) throw new SessionCreationProblem(503, "tern_unavailable");
      if (retained.some(operation => !terminal(operation.status.state))) throw new SessionCreationProblem(429, "creation_busy");
      const unavailable = await this.#probe();
      if (unavailable) throw new SessionCreationProblem(503, unavailable === "ledger_unavailable" ? unavailable : "tern_unavailable");
      const config = this.#dependencies.config.tern;
      const project = config?.projects?.find(project => project.id === request.projectId);
      const copy = project?.workingCopies.find(copy => copy.id === request.workingCopyId);
      const profile = config?.profiles?.find(profile => profile.id === request.profileId);
      if (!copy || !profile) throw new SessionCreationProblem(400, "bad_request");
      if (retained.length >= 64) throw new SessionCreationProblem(503, "creation_capacity");
      if (!admitNew()) throw new SessionCreationProblem(429, "rate_limited");
      const acceptedAt = this.#clock.monotonic();
      const createdAt = new Date(this.#clock.now()).toISOString();
      const operationId = parseSessionCreationUuid(this.#uuid());
      const operation: Operation = { owner, request, createdAt, expiresAt: new Date(Date.parse(createdAt) + RETENTION_MS).toISOString(),
        status: { operationId, state: "accepted", updatedAt: createdAt } };
      await this.#commit([...retained, operation]);
      this.#execution = this.#execute(operationId, copy, profile, acceptedAt)
        .catch(async () => {
          if (!this.#healthy || this.#stopped) return;
          const state = this.#operations.find(operation => operation.status.operationId === operationId)!.status.state;
          if (state === "accepted") await this.#transition(operationId, { state: "failed", error: "preflight_failed" });
          else if (state === "launching") await this.#transition(operationId, { state: "outcome_unknown", error: "launch_outcome_unknown" });
          else if (state === "awaiting_omp") await this.#transition(operationId, { state: "started_unavailable", error: "adoption_timeout" });
        }).catch(() => { /* Failed durable finalization disables creation; never expose uncommitted state. */ })
        .finally(() => { this.#execution = undefined; });
      return { status: 202, receipt: { operationId, state: "accepted" } };
    });
  }
  status(identityKey: string, operationId: string): SessionCreationStatus | undefined {
    if (!this.#healthy) throw new SessionCreationProblem(503, "ledger_unavailable");
    const owner = ownerKey(identityKey);
    return this.#operations.find(operation => operation.owner === owner && operation.status.operationId === operationId &&
      Date.parse(operation.expiresAt) > this.#clock.now())?.status;
  }
  #transition(operationId: string, state: Omit<SessionCreationStatus, "operationId" | "updatedAt"> & {
    readonly error?: string; readonly session?: { readonly instanceId: string; readonly generation: number };
  }, blockId?: string): Promise<void> {
    return this.#serialize(async () => {
      const current = this.#operations.find(operation => operation.status.operationId === operationId)!;
      if (terminal(current.status.state)) return;
      const status = parseSessionCreationStatus({ ...state, operationId, updatedAt: new Date(this.#clock.now()).toISOString() });
      await this.#commit(this.#operations.map(operation => operation === current ?
        { ...current, status, ...(blockId === undefined ? {} : { blockId }) } : operation));
    });
  }
  async #execute(operationId: string, copy: TernWorkingCopy, profile: TernProfile, acceptedAt: number): Promise<void> {
    const deadlineAbort = new AbortController();
    const timer = setTimeout(() => deadlineAbort.abort(), Math.max(0, acceptedAt + 110_000 - this.#clock.monotonic()));
    const signal = AbortSignal.any([this.#abort.signal, deadlineAbort.signal]);
    try {
      await this.#runOperation(operationId, copy, profile, acceptedAt, signal);
      if (deadlineAbort.signal.aborted && !this.#abort.signal.aborted) {
        const state = this.#operations.find(operation => operation.status.operationId === operationId)!.status.state;
        if (state === "accepted") await this.#transition(operationId, { state: "failed", error: "preflight_failed" });
        else if (state === "launching") await this.#transition(operationId, { state: "outcome_unknown", error: "launch_outcome_unknown" });
        else if (state === "awaiting_omp") await this.#transition(operationId, { state: "started_unavailable", error: "adoption_timeout" });
      }
    } finally { clearTimeout(timer); }
  }
  async #runOperation(operationId: string, copy: TernWorkingCopy, profile: TernProfile, acceptedAt: number, signal: AbortSignal): Promise<void> {
    const deadline = acceptedAt + 110_000;
    const preflightDeadline = Math.min(deadline, this.#clock.monotonic() + 10_000);
    if (signal.aborted) return;
    const preflightAbort = new AbortController();
    const preflightTimer = setTimeout(() => preflightAbort.abort(), Math.max(0, preflightDeadline - this.#clock.monotonic()));
    const preflightSignal = AbortSignal.any([signal, preflightAbort.signal]);
    let baseline;
    let inspection;
    let runtime;
    try {
      runtime = await (this.#dependencies.runtimeAvailable?.() ?? validateTernRuntime(this.#dependencies.config.tern!));
      baseline = await this.#dependencies.poller.refreshForAdoption({ signal: preflightSignal, timeoutMs: Math.min(5000, preflightDeadline - this.#clock.monotonic()) });
      inspection = runtime ? await this.#cli.inspect(profile, preflightSignal) : undefined;
    } finally { clearTimeout(preflightTimer); }
    if (signal.aborted) return;
    if (!runtime || baseline.status !== "ok" || !baseline.observation.directoryHealthy || !inspection || preflightSignal.aborted || this.#clock.monotonic() >= preflightDeadline) {
      await this.#transition(operationId, { state: "failed", error: "preflight_failed" }); return;
    }
    const instances = new Set(baseline.observation.knownInstanceIds);
    const sessions = new Set(baseline.observation.hosts.map(host => host.sessionId));
    const blocks = new Set(inspection.blocks);
    await this.#transition(operationId, { state: "launching" });
    if (signal.aborted) return;
    const launching = this.#operations.find(operation => operation.status.operationId === operationId)!;
    const launchingAt = Date.parse(launching.status.updatedAt);
    const spawnedAt = this.#clock.monotonic();
    let latest: AdoptionObservation | undefined;
    const unsubscribe = this.#dependencies.poller.subscribeObservations(observation => {
      if (observation.startedAt >= spawnedAt && observation.round > baseline.observation.round) latest = observation;
    });
    try {
      const result = await this.#cli.createTab(copy, profile, signal);
      if (signal.aborted) return;
      if (result.kind === "not_started") { await this.#transition(operationId, { state: "failed", error: "spawn_failed" }); return; }
      if (result.kind === "unknown" || blocks.has(result.blockId)) {
        await this.#transition(operationId, { state: "outcome_unknown", error: "launch_outcome_unknown" }); return;
      }
      await this.#transition(operationId, { state: "awaiting_omp" }, result.blockId);
      let viewOnly = false;
      while (!signal.aborted && this.#clock.monotonic() < deadline) {
        const refresh = await this.#dependencies.poller.refreshForAdoption({ signal, timeoutMs: Math.min(5000, deadline - this.#clock.monotonic()) });
        if (refresh.status === "ok" && refresh.observation.startedAt >= spawnedAt && refresh.observation.round > baseline.observation.round) latest = refresh.observation;
        const current = await this.#cli.inspect(profile, signal);
        if (signal.aborted) return;
        const file = current && matchingTernBasename(current, result.blockId);
        if (file && latest?.directoryHealthy) {
          const eligible = latest.hosts.filter(host => !instances.has(host.instanceId) && !sessions.has(host.sessionId) &&
            host.startedAt >= launchingAt && host.createdAt >= launchingAt && sessionBasenameMatches(file, host.sessionId));
          const bindings = new Map(eligible.map(host => [`${host.instanceId}\0${host.generation}`, host]));
          if (bindings.size > 1) { await this.#transition(operationId, { state: "started_unavailable", error: "correlation_ambiguous" }); return; }
          const host = bindings.values().next().value;
          viewOnly = host !== undefined && !host.canControl;
          if (host?.canControl && this.#dependencies.registry.authorizeLaunch(host.instanceId, host.generation, "control").status === "ok") {
            await this.#transition(operationId, { state: "ready", session: { instanceId: host.instanceId, generation: host.generation } }); return;
          }
        }
        await this.#clock.sleep(Math.min(1000, Math.max(0, deadline - this.#clock.monotonic())), signal);
      }
      if (!signal.aborted) await this.#transition(operationId, { state: "started_unavailable", error: viewOnly ? "control_unavailable" : "adoption_timeout" });
    } finally { unsubscribe(); latest = undefined; instances.clear(); sessions.clear(); blocks.clear(); }
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    await this.#probing;
    await this.#execution;
    await this.#serialize(async () => {
      if (!this.#healthy) return;
      const updatedAt = new Date(this.#clock.now()).toISOString();
      const operations = this.#operations.map(operation => interrupted(operation, updatedAt));
      if (operations.some((operation, index) => operation !== this.#operations[index])) await this.#commit(operations);
    });
  }
}

/** Doctor is read-only: validates the ledger without becoming a second ledger writer. */
export async function probeTernAvailability(config: GatewayConfig): Promise<boolean> {
  try {
    if (!config.tern || !await validateTernRuntime(config.tern)) return false;
    const ledger = await readPrivateTextFile(join(config.paths.stateDir, "session-creations.json"), MAX_LEDGER_BYTES);
    if (ledger !== undefined) validateCreationLedger(ledger);
    return !!await new TernCli(config.tern.executable!).inspect(config.tern.profiles![0]!, AbortSignal.timeout(5000));
  } catch { return false; }
}
