import { expect, test } from "bun:test";
import { join } from "node:path";
import { classifyWindowsCommandFailure, command, reconnectWindowsTransport, reconcileWindowsUpload, windowsUploadStep, windowsWinrmDiagnostic, windowsWinrmResult } from "./windows-qualification-runtime";
import { QualificationFailure } from "./qualification-failure";
import type { WindowsTransportProbe } from "./windows-stable-qualification";
import { windowsFailure } from "./windows-stable-qualification";
import * as winrmRuntime from "./windows-qualification-runtime";

test.each(["GET", "POST"])("council491 canceled provider %s is not infrastructure retry authority", async method => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let sends = 0;
  globalThis.fetch = (async (_url, options) => {
    sends += 1;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ accepted: true })), 150);
      options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal!.reason); }, { once: true });
    });
  }) as typeof fetch;
  try {
    const result = winrmRuntime.request("https://synthetic.invalid", {}, method, undefined,
      { signal: controller.signal, deadline: performance.now() + 5_000, nextFailureId: () => 31 }).catch(error => error);
    setTimeout(() => controller.abort(new Error("synthetic cancellation")), 20);
    const error = await result;
    expect(error).toBeInstanceOf(QualificationFailure);
    if (!(error instanceof QualificationFailure)) throw new Error("expected typed provider cancellation");
    expect(error.evidence).toMatchObject({ id: 31, class: "harness", operation: method === "GET" ? "read_only" : "unknown" });
    expect(sends).toBe(1);
  } finally { globalThis.fetch = original; }
});

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
