import { expect, test } from "bun:test";
import { join } from "node:path";
import { classifyWindowsCommandFailure, command, reconnectWindowsTransport, reconcileWindowsUpload, windowsUploadStep, windowsWinrmDiagnostic, windowsWinrmResult } from "./windows-qualification-runtime";
import { QualificationFailure } from "./qualification-failure";
import type { WindowsTransportProbe } from "./windows-stable-qualification";
import { windowsFailure } from "./windows-stable-qualification";

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
test("a stubborn subprocess gets SIGKILL after grace and both pipes drain before rejection", async () => {
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
    stream: async () => { events.push("stream"); throw windowsFailure("mutation_unconfirmed", "upload", "unknown"); },
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
