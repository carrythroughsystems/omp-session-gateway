import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { classifyWindowsCommandFailure, command, reconnectWindowsTransport, reconcileWindowsUpload, windowsUploadStep, windowsWinrmDiagnostic, windowsWinrmResult } from "./windows-qualification-runtime";
import { QualificationFailure } from "./qualification-failure";
import type { WindowsTransportProbe } from "./windows-stable-qualification";
import { assertWindowsAllocation, windowsFailure, windowsRemaining } from "./windows-stable-qualification";
import * as winrmRuntime from "./windows-qualification-runtime";

const transportResult = (condition = "connection_timeout") => ({
  exitCode: -1, stdout: "", diagnostic: "private text ignored",
  failure: { kind: "transport", stage: "connection", condition, httpStatus: null, disposition: "not_started" },
  teardown: { commandAttempted: false, commandStopped: false, shellAttempted: false, shellClosed: false },
});
test("structured read-only timeouts are transient; text, credentials, encoding and malformed JSON are harness", () => {
  let failure: unknown;
  try { windowsWinrmResult(transportResult(), true); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(QualificationFailure);
  expect((failure as QualificationFailure).evidence).toMatchObject({ class: "infra_transient", reason: "connection_timeout", operation: "read_only" });
  for (const value of [
    { ...transportResult(), failure: { ...transportResult().failure, kind: "helper", condition: "helper_failure" } },
    { ...transportResult(), failure: { ...transportResult().failure, condition: "authentication" } },
    { exitCode: 0, stdout: "not json" },
  ]) {
    try { windowsWinrmResult(value, true); } catch (error) { failure = error; }
    expect((failure as QualificationFailure).evidence.class).toBe("harness");
  }
  try { windowsWinrmResult(transportResult(), false); } catch (error) { failure = error; }
  expect((failure as QualificationFailure).evidence.class).toBe("harness");
});
test("raw 143 is not a controller deadline", async () => {
  const error = await command([process.execPath, "-e", "process.exit(143)"]).catch(error => error);
  expect(error.controllerDeadline).toBe(false);
  expect(error.exitCode).toBe(143);
  expect(classifyWindowsCommandFailure(error, true, true).evidence).toMatchObject({ class: "harness", reason: "helper_failed" });
});
// Windows terminates the process directly; POSIX signal handlers and SIGKILL escalation do not apply.
test.skipIf(process.platform === "win32")("a stubborn subprocess gets SIGKILL after grace and both pipes drain before rejection", async () => {
  const probes: WindowsTransportProbe[] = [];
  const error = await command([process.execPath, "-e",
    'process.on("SIGTERM", () => { process.stdout.write("synthetic-private-output"); }); setInterval(() => {}, 1000);'], {
    timeoutMs: 150, terminationGraceMs: 25, transportProbe: async probe => { probes.push(probe); },
  }).catch(error => error);
  expect(error.controllerDeadline).toBe(true); expect(error.signal).toBe(9);
  expect(probes.at(-1)).toMatchObject({ controllerDeadline: true });
  expect(probes.at(-1)!.exitedAt).toBeGreaterThanOrEqual(probes.at(-1)!.killAt!);
  expect(classifyWindowsCommandFailure(error, true, true).evidence.reason).toBe("probe_deadline");
  expect(classifyWindowsCommandFailure(error, true, false).evidence.class).toBe("harness");
  expect(classifyWindowsCommandFailure(error, false, false).evidence.reason).toBe("mutation_unconfirmed");
  expect(JSON.stringify(error)).not.toContain("synthetic-private");
});
test.each([401, 403, 429, 503])("493 R1 contradictory HTTP %s plus reset evidence is harness, never transient", status => {
  const value = transportResult("connection_reset");
  let failure: unknown;
  try { windowsWinrmResult({ ...value, failure: { ...value.failure, httpStatus: status } }, true); } catch (error) { failure = error; }
  expect((failure as QualificationFailure).evidence).toMatchObject({ class: "harness", reason: "helper_failed" });
});
test("external cancellation reaps the subprocess but cannot become a probe deadline", async () => {
  const controller = new AbortController();
  const stopped = command([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 5_000, execution: { signal: controller.signal, deadline: performance.now() + 5_000, nextFailureId: () => 1 },
  });
  setTimeout(() => controller.abort(), 30);
  const error = await stopped.catch(error => error);
  expect(error.controllerDeadline).toBe(false);
  expect(classifyWindowsCommandFailure(error, true, true).evidence.class).toBe("harness");
});
test.each(["abort", "execution-expiry", "command-expiry"] as const)("496 R2 %s during the initial checkpoint refuses helper spawn", async kind => {
  const controller = new AbortController();
  const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 };
  const spawn = spyOn(Bun, "spawn");
  try {
    const failure = await command([process.execPath, "-e", ""], {
      execution, timeoutMs: kind === "command-expiry" ? 10 : 60_000,
      transportProbe: async () => {
        if (kind === "abort") controller.abort();
        else if (kind === "execution-expiry") execution.deadline = performance.now() - 1;
        else await Bun.sleep(20);
      },
    }).catch(error => error);
    expect(spawn).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(QualificationFailure);
    expect(failure.evidence).toMatchObject({ reason: "deadline_exceeded", operation: "not_started" });
  } finally { spawn.mockRestore(); }
});
test("496 R2 command owns cancellation before awaiting its first checkpoint", async () => {
  const controller = new AbortController(), listen = spyOn(controller.signal, "addEventListener");
  try {
    await expect(command(["synthetic-must-not-spawn"], {
      execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 },
      transportProbe: async () => {
        expect(listen.mock.calls.some(call => call[0] === "abort")).toBe(true);
        controller.abort();
      },
    })).rejects.toThrow("deadline_exceeded");
  } finally { listen.mockRestore(); }
});
test.each(["provider Windows allocation", "certificate-pinned interactive RDP"])("496 R2 rejected late %s observations report controller expiry", async name => {
  let now = 0;
  const failure = await winrmRuntime.pollWindows(async () => { now = 100; throw new Error("synthetic late refusal"); }, 100, name, undefined,
    { now: () => now, sleep: async ms => { now += ms; } }).catch(error => error);
  expect(failure).toBeInstanceOf(QualificationFailure);
  expect(failure.evidence).toMatchObject({ reason: "deadline_exceeded", observations: { controllerDeadline: true, timeoutMs: 100, waitedMs: 100 } });
});
test("496 R2 a rejected in-budget observation preserves its original failure", async () => {
  const failure = new Error("synthetic in-budget refusal");
  await expect(winrmRuntime.pollWindows(async () => { throw failure; }, 100, "synthetic predicate", undefined,
    { now: () => 0, sleep: async () => {} })).rejects.toBe(failure);
});
test("496 R2 fractional monotonic expiry preserves valid integer observations", () => {
  let failure: unknown;
  try { windowsRemaining(0.25, 10.75, 11.125); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(QualificationFailure);
  expect((failure as QualificationFailure).evidence).toMatchObject({
    reason: "deadline_exceeded", elapsedMs: 10.875, observations: { controllerDeadline: true, timeoutMs: 10, waitedMs: 10 },
  });
});
test("496 R2 creation-cap refusals use the current execution allocator without consuming allowed capacity", () => {
  let next = 200;
  const execution = { signal: new AbortController().signal, deadline: performance.now() + 60_000, nextFailureId: () => ++next };
  for (const [index, count] of [-1, 4, 5, Number.NaN, 1.5].entries()) {
    let failure: unknown;
    try { winrmRuntime.windowsCreationAllowance(count, 4, execution); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(QualificationFailure);
    expect((failure as QualificationFailure).evidence).toMatchObject({ id: 201 + index, class: "harness", reason: "helper_failed", step: "preflight" });
  }
  expect(winrmRuntime.windowsCreationAllowance(3, 4, execution)).toBe(1);
  expect(next).toBe(205);
});
test("496 R2 cancellation during an upload claim cannot start its stream", async () => {
  const controller = new AbortController(), calls: string[] = [];
  await expect(winrmRuntime.windowsUploadOnce({
    allowFresh: true, state: async () => undefined, verify: async () => false,
    checkpoint: async state => { calls.push(state); controller.abort(); },
    upload: async () => { calls.push("stream"); },
  }, { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 })).rejects.toThrow("deadline_exceeded");
  expect(calls).toEqual(["started"]);
});
test("496 R2 upload reconciliation cannot remove a partial file after cancellation during inspection", async () => {
  const controller = new AbortController(), calls: string[] = [];
  const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 };
  await expect(reconcileWindowsUpload({
    stream: async () => windowsWinrmResult(transportResult(), false, execution, true),
    inspect: async () => { controller.abort(); return { exists: true, matches: false, writerEnded: true }; },
    remove: async () => { calls.push("remove"); },
  }, execution)).rejects.toThrow("deadline_exceeded");
  expect(calls).toEqual([]);
});
test.each(["live", "stale"] as const)("496 R2 cancellation between %s launch observations refuses the next POST", async kind => {
  const controller = new AbortController();
  const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 };
  let posts = 0;
  const fetcher = async () => {
    posts += 1; controller.abort();
    return new Response(JSON.stringify(kind === "live" ? { capability: "synthetic-never-real", mode: "view", generation: 1 } : { code: "generation_mismatch" }),
      { status: kind === "live" ? 200 : 409, headers: { "cache-control": "no-store" } });
  };
  await expect((kind === "live" ? winrmRuntime.verifyWindowsLaunchContracts : winrmRuntime.verifyWindowsStaleLaunch)(
    "https://synthetic.invalid", { instanceId: "synthetic-only", generation: 1 }, fetcher, execution)).rejects.toThrow("deadline_exceeded");
  expect(posts).toBe(1);
});
test("496 R2 RDP cancellation during stdin owns teardown before any further work", async () => {
  const controller = new AbortController(), calls: string[] = [];
  let settle!: (code: number) => void;
  const child = {
    stdin: { write: () => { calls.push("write"); controller.abort(); }, end: () => { calls.push("end"); } },
    exitCode: null as number | null,
    kill: () => { calls.push("kill"); child.exitCode = 143; settle(143); },
    exited: new Promise<number>(resolve => { settle = resolve; }).then(code => { calls.push("exit"); return code; }),
  };
  await expect(winrmRuntime.settleWindowsRdp(child, "synthetic-only", async () => { calls.push("observe"); },
    { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 })).rejects.toThrow("deadline_exceeded");
  expect(calls).toEqual(["write", "kill", "exit"]);
});
test.each(["abort", "allocation"] as const)("496 R2 firewall rule refetch %s cannot authorize another POST", async kind => {
  const controller = new AbortController();
  const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 };
  let now = 0, reads = 0; const ports: string[] = [];
  expect(typeof winrmRuntime.configureWindowsFirewallRules).toBe("function");
  await expect(winrmRuntime.configureWindowsFirewallRules({
    id: "synthetic-firewall", label: "omp-winqual-11111111-1111-4111-8111-111111111111", environment: {}, execution, allocationDeadline: 100, now: () => now,
    read: async () => {
      if (++reads === 2) { if (kind === "abort") controller.abort(); else now = 100; }
      return { id: "synthetic-firewall", description: "omp-winqual-11111111-1111-4111-8111-111111111111" };
    },
    post: async port => { ports.push(port); },
  })).rejects.toThrow("deadline_exceeded");
  expect(ports).toEqual(["3389"]);
});
test("reconnect accounts for command time in its 90-second budget", async () => {
  let now = 0; const budgets: number[] = []; const sleeps: number[] = [];
  const clock = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
  await expect(reconnectWindowsTransport(async budget => {
    budgets.push(budget); now += Math.min(60_000, budget);
    return windowsWinrmResult(transportResult(), true);
  }, clock)).rejects.toBeInstanceOf(QualificationFailure);
  expect(budgets).toEqual([90_000, 28_000]);
  expect(sleeps).toEqual([2_000]);
  expect(now).toBe(90_000);
});
test("493 R2 reconnect refuses success exactly at its deadline", async () => {
  let now = 0;
  await expect(reconnectWindowsTransport(async () => { now = 90_000; return {}; },
    { now: () => now, sleep: async ms => { now += ms; } })).rejects.toThrow("deadline_exceeded");
});
test.each(["provider Windows allocation", "certificate-pinned interactive RDP"])("493 R2 %s polling refuses late success", async name => {
  let now = 0;
  expect(typeof winrmRuntime.pollWindows).toBe("function");
  await expect(winrmRuntime.pollWindows(async () => { now = 100; return true; }, 100, name, undefined,
    { now: () => now, sleep: async ms => { now += ms; } })).rejects.toThrow("timed out");
});
test.each(["write", "end"] as const)("493 R2 FreeRDP %s failure still kills and awaits its child", async operation => {
  const calls: string[] = []; let settle!: (code: number) => void;
  const child = {
    stdin: { write: (_input: string) => { calls.push("write"); if (operation === "write") throw new Error("synthetic input failure"); },
      end: () => { calls.push("end"); if (operation === "end") throw new Error("synthetic input failure"); } },
    exitCode: null as number | null,
    kill: () => { calls.push("kill"); child.exitCode = 143; settle(143); },
    exited: new Promise<number>(resolve => { settle = resolve; }).then(code => { calls.push("exit"); return code; }),
  };
  expect(typeof winrmRuntime.settleWindowsRdp).toBe("function");
  await expect(winrmRuntime.settleWindowsRdp(child, "synthetic-only", async () => { calls.push("observe"); })).rejects.toThrow("synthetic input failure");
  expect(calls).toContain("kill"); expect(calls).toContain("exit"); expect(calls).not.toContain("observe");
});
test("493 R2 admitted transport requires durable stability observations, not a boolean marker", () => {
  expect(typeof winrmRuntime.windowsTransportStability).toBe("function");
  expect(winrmRuntime.windowsTransportStability(undefined)).toBeUndefined();
  expect(winrmRuntime.windowsTransportStability({ transportAdmitted: true })).toBeUndefined();
  expect(winrmRuntime.windowsTransportStability({ transportStabilitySamples: 3, transportStabilityDurationMs: 60_000 }))
    .toEqual({ transportStabilitySamples: 3, transportStabilityDurationMs: 60_000 });
  expect(winrmRuntime.windowsTransportStability({ transportStabilitySamples: 2, transportStabilityDurationMs: 60_000 })).toBeUndefined();
});
test("493 R2 allocation guard checks both clocks at the creation boundary", () => {
  const controller = new AbortController();
  const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 };
  expect(() => assertWindowsAllocation(execution, 100, 99)).not.toThrow();
  expect(() => assertWindowsAllocation(execution, 100, 100)).toThrow("deadline_exceeded");
  controller.abort();
  expect(() => assertWindowsAllocation(execution, 100, 99)).toThrow("deadline_exceeded");
  expect(() => assertWindowsAllocation(undefined, undefined, 99)).toThrow("helper_failed");
});
test("493 R2 firewall-only vault is not guest access", () => {
  expect(winrmRuntime.windowsGuestAccessAvailable({ firewall: "synthetic-firewall" })).toBe(false);
  expect(winrmRuntime.windowsGuestAccessAvailable({ instance: "synthetic-owned" })).toBe(false);
  expect(winrmRuntime.windowsGuestAccessAvailable({ instance: "synthetic-owned", password: "synthetic-only" })).toBe(true);
});
test("496 R1 delayed reconnect backoff cannot start an expired probe", async () => {
  let now = 0, attempts = 0;
  await expect(reconnectWindowsTransport(async () => { attempts += 1; return windowsWinrmResult(transportResult(), true); },
    { now: () => now, sleep: async () => { now = 90_001; } })).rejects.toThrow("deadline_exceeded");
  expect(attempts).toBe(1);
});
test.each(["allocation", "stability-probe", "stability-sleep"])("496 R1 %s expiry has typed controller origin, never last transient", async origin => {
  let now = 0;
  const clock = { now: () => now, sleep: async () => { now = 100; } };
  const operation = origin === "allocation"
    ? winrmRuntime.pollWindows(async () => { now = 100; return false; }, 100, "provider Windows allocation", undefined, clock)
    : winrmRuntime.waitForStableWindowsTransport(async () => {
      if (origin === "stability-probe") now = 100;
      return windowsWinrmResult(transportResult(), true);
    }, clock, 100);
  const failure = await operation.catch(error => error);
  expect(failure.evidence).toMatchObject({ class: "harness", reason: "deadline_exceeded",
    observations: { controllerDeadline: true, readOnlyProbe: true, timeoutMs: 100 } });
});
test("496 R1 expired creation authority cannot consume the private creation counter", async () => {
  const root = await mkdtemp(join(tmpdir(), "windows-counter-"));
  const path = join(root, "counter.json");
  try {
    await writeFile(path, "2", { mode: 0o600 });
    expect(typeof winrmRuntime.windowsCreationClaim).toBe("function");
    await expect(winrmRuntime.windowsCreationClaim(path, 2, undefined, Date.now() - 1)).rejects.toThrow("deadline_exceeded");
    expect(await readFile(path, "utf8")).toBe("2");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("reconnect uses exactly the four backoffs and refuses late success or untyped errors", async () => {
  let now = 0; const sleeps: number[] = [];
  const clock = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
  let attempts = 0;
  await expect(reconnectWindowsTransport(async () => { attempts += 1; return windowsWinrmResult(transportResult(), true); }, clock)).rejects.toBeInstanceOf(QualificationFailure);
  expect(attempts).toBe(5); expect(sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
  await expect(reconnectWindowsTransport(async () => { now += 90_001; return {}; }, clock)).rejects.toThrow("deadline_exceeded");
  attempts = 0;
  await expect(reconnectWindowsTransport(async () => { attempts += 1; throw new Error("ConnectTimeout HTTP 503"); }, clock)).rejects.toThrow("ConnectTimeout");
  expect(attempts).toBe(1);
});
test("interrupted upload reconciles matching bytes without replay; a locked writer blocks removal", async () => {
  const events: string[] = [];
  const run = (matches: boolean, writerEnded: boolean) => reconcileWindowsUpload({
    stream: async () => { events.push("stream"); return windowsWinrmResult(transportResult("connection_reset"), false, undefined, true); },
    inspect: async () => { events.push("inspect"); return { exists: true, matches, writerEnded }; },
    remove: async () => { events.push("remove"); },
  });
  await run(true, true); expect(events).toEqual(["stream", "inspect"]);
  events.length = 0;
  await expect(run(false, false)).rejects.toBeInstanceOf(QualificationFailure);
  expect(events).toEqual(["stream", "inspect"]);
  events.length = 0;
  await expect(run(false, true)).rejects.toBeInstanceOf(QualificationFailure);
  expect(events).toEqual(["stream", "inspect", "remove"]);
});
test("an encoding/helper failure cannot be disguised as successful upload reconciliation", async () => {
  let reads = 0;
  const failure = windowsFailure("helper_failed", "upload", "unknown");
  await expect(reconcileWindowsUpload({
    stream: async () => { throw failure; },
    inspect: async () => { reads += 1; return { exists: true, matches: true, writerEnded: true }; },
    remove: async () => {},
  })).rejects.toBe(failure);
  expect(reads).toBe(0);
});
test("R1 unowned upload termination stays terminal even when inspection could find matching bytes", async () => {
  let inspected = false;
  const failure = classifyWindowsCommandFailure(new winrmRuntime.WindowsCommandFailure(143, false, 0, 10, 100), false, false);
  await expect(reconcileWindowsUpload({
    stream: async () => { throw failure; },
    inspect: async () => { inspected = true; return { exists: true, matches: true, writerEnded: true }; },
    remove: async () => {},
  })).rejects.toBe(failure);
  expect(inspected).toBe(false);
});
test("R1 a started upload is single-shot across development re-entry", async () => {
  expect(typeof winrmRuntime.windowsUploadOnce).toBe("function");
  let state: "started" | "complete" | undefined; let streams = 0;
  const operations = {
    allowFresh: true,
    state: async () => state,
    checkpoint: async (next: "started" | "complete") => { state = next; },
    upload: async () => { streams += 1; throw windowsFailure("mutation_unconfirmed", "upload", "unknown"); },
    verify: async () => true,
  };
  await expect(winrmRuntime.windowsUploadOnce(operations)).rejects.toBeInstanceOf(QualificationFailure);
  await expect(winrmRuntime.windowsUploadOnce(operations)).rejects.toBeInstanceOf(QualificationFailure);
  expect(streams).toBe(1);
});
test.each(["cancel", "expire"] as const)("R1 reconnect rejects %s after a successful probe", async kind => {
  const controller = new AbortController();
  const execution = { signal: controller.signal, deadline: performance.now() + 5_000, nextFailureId: () => 1 };
  await expect(reconnectWindowsTransport(async () => {
    if (kind === "cancel") controller.abort(); else execution.deadline = performance.now() - 1;
    return { ready: true };
  }, { now: () => 0, sleep: async () => {} }, execution)).rejects.toThrow("deadline_exceeded");
});
test("R1 cancelled transient probe cannot start backoff and long backoff observes cancellation promptly", async () => {
  const controller = new AbortController(); let slept = 0;
  const execution = { signal: controller.signal, deadline: performance.now() + 5_000, nextFailureId: () => 1 };
  await expect(reconnectWindowsTransport(async () => {
    controller.abort(); return windowsWinrmResult(transportResult(), true);
  }, { now: () => 0, sleep: async ms => { slept += ms; } }, execution)).rejects.toThrow("deadline_exceeded");
  expect(slept).toBe(0);
});
test("R1 cancellation during backoff settles the owned sleep before refusing another probe", async () => {
  const controller = new AbortController(); let sleeps = 0; let probes = 0;
  await expect(reconnectWindowsTransport(async () => { probes += 1; return windowsWinrmResult(transportResult(), true); },
    { now: () => 0, sleep: async ms => { expect(ms).toBeLessThanOrEqual(100); sleeps += 1; controller.abort(); } },
    { signal: controller.signal, deadline: performance.now() + 5_000, nextFailureId: () => 1 })).rejects.toThrow("deadline_exceeded");
  expect(sleeps).toBe(1); expect(probes).toBe(1);
});
test("R1 cancellation after process exit but before checkpoint settlement cannot return success", async () => {
  const controller = new AbortController();
  await expect(command([process.execPath, "-e", "process.stdout.write('ok')"], {
    execution: { signal: controller.signal, deadline: performance.now() + 5_000, nextFailureId: () => 1 },
    transportProbe: async probe => { if (probe.exitedAt !== null) controller.abort(); },
  })).rejects.toThrow("deadline_exceeded");
});
test("R1 typed helper conversion retains bounded redacted diagnostics only in its in-memory cause", () => {
  let failure: unknown;
  try { windowsWinrmResult({ ...transportResult(), diagnostic: "LookupError",
    failure: { ...transportResult().failure, kind: "helper", condition: "helper_failure" },
    exception: { type: "LookupError", message: "unknown encoding: synthetic-codec; [REDACTED]", uploadStep: null,
      frames: [{ file: "protocol.py", line: 197, function: "open_shell" }] },
  }, true); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(QualificationFailure);
  expect((failure as Error).cause).toBeInstanceOf(Error);
  expect(((failure as Error).cause as Error).message).toContain("synthetic-codec");
  expect(JSON.stringify(failure)).not.toContain("synthetic-codec");
});
test("R2 a resumed legacy staging phase cannot turn an absent upload claim into fresh authority", async () => {
  let writes = 0;
  await expect(winrmRuntime.windowsUploadOnce({
    allowFresh: false, state: async () => undefined, checkpoint: async () => { writes += 1; },
    upload: async () => { writes += 1; }, verify: async () => true,
  })).rejects.toThrow("mutation_unconfirmed");
  expect(writes).toBe(0);
});
test("R2 exit zero without a real command/shell transcript is refused", () => {
  expect(() => windowsWinrmResult({ exitCode: 0, stdout: '{"ready":true}', failure: null,
    teardown: { commandAttempted: false, commandStopped: false, shellAttempted: false, shellClosed: false },
  }, true)).toThrow("helper_failed");
  expect(windowsWinrmResult({ exitCode: 0, stdout: '{"ready":true}', failure: null,
    teardown: { commandAttempted: true, commandStopped: false, shellAttempted: true, shellClosed: false },
  }, true)).toEqual({ ready: true });
});
test("R2 completed upload claims may verify on resume without fresh upload authority", async () => {
  let streamed = false;
  await winrmRuntime.windowsUploadOnce({
    allowFresh: false, state: async () => "complete", checkpoint: async () => {},
    upload: async () => { streamed = true; }, verify: async () => true,
  });
  expect(streamed).toBe(false);
});
test("R2 live launch predicate violations are product failures, but transport exceptions are harness", async () => {
  expect(typeof winrmRuntime.verifyWindowsLaunchContracts).toBe("function");
  const session = { instanceId: "synthetic-session", generation: 1 };
  const failure = await winrmRuntime.verifyWindowsLaunchContracts("https://synthetic.invalid", session,
    async () => new Response('{"mode":"wrong","generation":1,"capability":"synthetic-never-real"}', { status: 200, headers: { "cache-control": "no-store" } })).catch(error => error);
  expect(failure.evidence).toMatchObject({ class: "product", reason: "assertion_failed" });
  const transport = await winrmRuntime.verifyWindowsLaunchContracts("https://synthetic.invalid", session,
    async () => { throw new Error("synthetic transport error"); }).catch(error => error);
  expect(transport.evidence.class).toBe("harness");
});
test("R2 live View and Control preserve the shared launch contract and scrub capability values", async () => {
  const modes: string[] = [];
  await winrmRuntime.verifyWindowsLaunchContracts("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 2 },
    async (_url, options) => {
      const { mode, generation } = JSON.parse(String(options.body));
      modes.push(mode);
      return new Response(JSON.stringify({ mode, generation, capability: "synthetic-never-real" }), { status: 200, headers: { "cache-control": "no-store" } });
    });
  expect(modes).toEqual(["view", "control"]);
});

test("WinRM failures preserve legacy classification and actionable sanitized helper evidence", () => {
  const diagnostic = windowsWinrmDiagnostic({
    diagnostic: "LookupError",
    exception: {
      type: "LookupError", message: "unknown encoding: synthetic-codec; [REDACTED]", uploadStep: "stream",
      frames: [{ file: "protocol.py", line: 197, function: "open_shell" }],
    },
  });
  expect(diagnostic).toContain("LookupError");
  expect(diagnostic).toContain("unknown encoding: synthetic-codec");
  expect(diagnostic).toContain('"file":"protocol.py"');
  expect(diagnostic).toContain('"uploadStep":"stream"');
  expect(windowsWinrmDiagnostic({ diagnostic: "ConnectionError HTTP 400" })).toBe("ConnectionError HTTP 400");
});

test("each upload failure names its exact sub-step without replaying the operation", async () => {
  for (const step of ["existence/hash", "remove", "stream"] as const) {
    let attempts = 0;
    await expect(windowsUploadStep(step, async observed => {
      expect(observed).toBe(step);
      attempts += 1;
      throw new Error("WinRM transport not yet ready: LookupError");
    })).rejects.toThrow("helper_failed");
    expect(attempts).toBe(1);
  }
});

// The WinRM adapter is Python, so its standard-library suite (fake transport, no pywinrm or network)
// runs from here to join every `bun test` instead of depending on someone running it by hand.
test("the WinRM adapter's standard-library suite passes", async () => {
  const interpreter = process.platform === "win32" ? "python" : "python3";
  const child = Bun.spawn([interpreter, join(import.meta.dir, "windows-winrm.test.py")], { stdout: "pipe", stderr: "pipe" });
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, summary: stderr.trim().split(/\r?\n/u).at(-1) }).toEqual({ code: 0, summary: "OK" });
});
