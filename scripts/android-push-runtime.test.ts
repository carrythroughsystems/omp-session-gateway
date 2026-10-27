import { expect, spyOn, test } from "bun:test";
import * as deviceOperations from "./android-device.ts";
import * as webApkOperations from "./android-webapk.ts";
import * as notificationOperations from "./android-notification.ts";
import { AndroidBrowserCleanupError, runAdb, unlockAndroidKeyguard, withAndroidChrome, type AndroidAdbSpawner } from "./android-device.ts";
import { createAndroidPushRuntime, holdAndroidNotificationDenial, observePushDeliveryRequest, qualificationPushAliasFor, pushBrowserCleanupFailure } from "./android-push-runtime.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import { checkProviderReads } from "./check-repository.ts";
import type { AndroidPushProgress, PushDeviceBaseline } from "./android-push-qualification.ts";
import { QualificationFailure, privateQualificationFailureDiagnostic, normalizeQualificationFailures, parseLaneFailures, qualificationRetryEligible } from "./qualification-failure.ts";
import { notificationTopicDigest } from "./android-notification.ts";
const identity = { origin: "https://synthetic.example.test", omp: { version: "18.3.0", bunVersion: "1.4.0", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), nativeTarballSha256: "c".repeat(64), nativeBinarySha256: "d".repeat(64) } };

test.each(["connected", "recovered", "disconnected"] as const)("GCM readiness uses one bounded Wi-Fi remedy when %s", async scenario => {
  let time = 0, reads = 0;
  const events: string[] = [];
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args, options) => {
    const command = args.join(" ");
    events.push(command);
    expect(options?.timeoutMs).toBeGreaterThan(0);
    expect(options?.timeoutMs).toBeLessThanOrEqual(10_000);
    if (command === "shell dumpsys activity service GcmService") {
      reads++;
      const connected = scenario === "connected" || scenario === "recovered" && reads > 1;
      return `DeviceID: SYNTHETIC-PRIVATE-GCM-DEVICE\nIs client connected: ${connected}\nReconnect Scheduler Alarm: in PT3H14M10.799S\nReceived SYNTHETIC-PRIVATE-GCM-MESSAGE`;
    }
    if (command === "shell svc wifi disable" || command === "shell svc wifi enable") return "";
    throw new Error("unexpected synthetic adb command");
  });
  try {
    const runtime = createAndroidPushRuntime(identity);
    runtime.now = () => time;
    runtime.pause = async milliseconds => { events.push(`pause ${milliseconds}`); time += milliseconds; };
    runtime.beforeEffect = async () => { events.push("checkpoint"); };
    if (scenario === "disconnected") {
      const error = await runtime.gcmReadiness().catch(error => error);
      expect(normalizeQualificationFailures(error)).toMatchObject([{
        lane: "rigReadiness", step: "pixel_push", reason: "gcm_disconnected", class: "infra_transient",
        elapsedMs: 32_000, observations: { gcmConnected: false, gcmRemedyApplied: true },
      }]);
      const diagnostic = JSON.stringify(privateQualificationFailureDiagnostic(error));
      expect(diagnostic).toContain("Is client connected: false");
      expect(diagnostic).toContain("Reconnect Scheduler Alarm: in PT3H14M10.799S");
      expect(diagnostic).not.toContain("SYNTHETIC-PRIVATE-GCM");
      expect(time).toBe(32_000);
    } else {
      expect(await runtime.gcmReadiness()).toMatchObject({
        observations: { gcmConnected: true, gcmRemedyApplied: scenario === "recovered" }, diagnostic: expect.any(Error),
      });
    }
    expect(events.filter(event => event.startsWith("shell svc"))).toEqual(scenario === "connected" ? [] :
      ["shell svc wifi disable", "shell svc wifi enable"]);
    if (scenario === "connected") expect(events).toEqual(["shell dumpsys activity service GcmService"]);
    else expect(events.slice(0, 6)).toEqual(["shell dumpsys activity service GcmService", "checkpoint",
      "shell svc wifi disable", "pause 2000", "checkpoint", "shell svc wifi enable"]);
  } finally { adb.mockRestore(); select.mockRestore(); }
});

test.each(["missing", "duplicate", "alarm", "late", "cancelled"] as const)("GCM readiness preserves the %s boundary", async scenario => {
  let time = 0, reads = 0;
  const commands: string[] = [], controller = new AbortController();
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args) => {
    const command = args.join(" ");
    commands.push(command);
    if (command !== "shell dumpsys activity service GcmService") return "";
    reads++;
    if (scenario === "missing") return "DeviceID: SYNTHETIC-PRIVATE-GCM-DEVICE";
    if (scenario === "duplicate") return "Is client connected: true\nIs client connected: false";
    if (scenario === "late" && reads > 1) time += 30_000;
    return `Is client connected: ${scenario === "late" && reads > 1}\nReconnect Scheduler Alarm: SYNTHETIC-PRIVATE-GCM-ALARM`;
  });
  try {
    const runtime = createAndroidPushRuntime(identity, { execution: {
      signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1,
    } });
    runtime.now = () => time;
    runtime.beforeEffect = async () => {};
    runtime.pause = async milliseconds => {
      time += milliseconds;
      if (scenario === "cancelled") controller.abort(new Error("synthetic GCM cancellation"));
    };
    const error = await runtime.gcmReadiness().catch(error => error);
    expect(normalizeQualificationFailures(error)[0]?.reason).toBe(scenario === "cancelled" || scenario === "late" ? "deadline_exceeded" :
      scenario === "missing" || scenario === "duplicate" ? "invalid_evidence" : "gcm_disconnected");
    expect(normalizeQualificationFailures(error)[0]?.observations).toMatchObject({
      gcmConnected: false, gcmRemedyApplied: !["missing", "duplicate"].includes(scenario),
    });
    expect(JSON.stringify(privateQualificationFailureDiagnostic(error))).not.toContain("SYNTHETIC-PRIVATE-GCM");
    if (scenario === "missing" || scenario === "duplicate") expect(commands).toHaveLength(1);
    if (scenario === "cancelled") expect(commands).not.toContain("shell svc wifi enable");
    if (scenario === "late") expect(time).toBe(32_000);
  } finally { adb.mockRestore(); select.mockRestore(); }
});

test.each([
  "Is client connected: false\nIs client connected: malformed",
  "Is client connected: true\nIs client connected = false",
  "Is client connected: true\nIS CLIENT CONNECTED: true",
  "Is client connected: true trailing-private-value",
  "Is\tclient connected: true",
])("514 R1 GCM rejects every malformed or duplicate connection line: %s", async dump => {
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  const adb = spyOn(deviceOperations, "runAdb").mockResolvedValue(dump);
  try {
    const runtime = createAndroidPushRuntime(identity);
    let effects = 0;
    runtime.beforeEffect = async () => { effects++; };
    const error = await runtime.gcmReadiness().catch(error => error);
    expect(normalizeQualificationFailures(error)).toMatchObject([{ reason: "invalid_evidence",
      observations: { gcmConnected: false, gcmRemedyApplied: false } }]);
    expect(effects).toBe(0); expect(adb).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(privateQualificationFailureDiagnostic(error))).not.toContain("trailing-private-value");
  } finally { adb.mockRestore(); select.mockRestore(); }
});

test.each(["initial-cap", "read-cap", "read-cap-error", "late-first", "late-after-false", "in-window"] as const)(
  "514 R1 GCM separates command caps from the reconnect window (%s)", async scenario => {
    let time = 0, reads = 0;
    const caps: number[] = [];
    const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
    const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args, options) => {
      if (args[1] !== "dumpsys") return "";
      caps.push(options!.timeoutMs!); reads++;
      let connected = false;
      if (scenario === "initial-cap") { time += 10_000; connected = true; }
      if (reads > 1 && scenario.startsWith("read-cap")) {
        time += 10_000; connected = true;
        if (scenario === "read-cap-error") throw new Error("synthetic per-read timeout");
      }
      if (scenario === "late-first" && reads === 2 || scenario === "late-after-false" && reads === 3) {
        time = 32_000; connected = true;
      }
      if (scenario === "in-window" && reads === 2) { time += 9_999; connected = true; }
      return `Is client connected: ${connected}\nReconnect Scheduler Alarm: ${connected ? "OFF" : "in PT30S"}`;
    });
    try {
      const runtime = createAndroidPushRuntime(identity);
      runtime.now = () => time; runtime.pause = async ms => { time += ms; }; runtime.beforeEffect = async () => {};
      if (scenario === "in-window") {
        expect(await runtime.gcmReadiness()).toMatchObject({ observations: { gcmConnected: true, gcmRemedyApplied: true } });
      } else {
        const error = await runtime.gcmReadiness().catch(error => error);
        expect(normalizeQualificationFailures(error)).toMatchObject([{
          reason: scenario === "late-after-false" ? "gcm_disconnected" : "deadline_exceeded",
          observations: { gcmConnected: false, gcmRemedyApplied: scenario !== "initial-cap" },
        }]);
        const diagnostic = JSON.stringify(privateQualificationFailureDiagnostic(error));
        expect(diagnostic).not.toContain("Is client connected: true");
        expect(diagnostic).toContain(`Is client connected: ${scenario === "initial-cap" ? "unavailable" : "false"}`);
        if (scenario === "read-cap-error") expect(diagnostic).toContain("synthetic per-read timeout");
      }
      expect(caps.every(cap => cap > 0 && cap <= 10_000)).toBe(true);
      if (scenario.startsWith("read-cap")) expect(time).toBe(12_000);
    } finally { adb.mockRestore(); select.mockRestore(); }
  });

test.each(["read", "disable", "pause", "enable", "reconnect-read", "checkpoint", "cancel", "expiry", "containment"] as const)(
  "514 R1 GCM retains typed facts and private context when %s fails", async stage => {
    const controller = new AbortController(), raw = new Error(`synthetic private GCM ${stage} failure`);
    let time = 0, reads = 0, checkpoints = 0, id = 10;
    const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => ++id };
    const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
    const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args) => {
      if (args[1] === "dumpsys") {
        reads++;
        if (stage === "cancel") { controller.abort(new Error("synthetic GCM cancellation cause")); throw raw; }
        if (stage === "expiry") { execution.deadline = 0; throw raw; }
        if (stage === "read" || stage === "reconnect-read" && reads > 1) throw raw;
        return "Is client connected: false\nReconnect Scheduler Alarm: OFF";
      }
      if (stage === "disable" && args[3] === "disable" || stage === "enable" && args[3] === "enable") throw raw;
      return "";
    });
    try {
      const runtime = createAndroidPushRuntime(identity, { execution });
      runtime.now = () => time;
      runtime.pause = async ms => { time += ms; if (stage === "pause") throw raw; };
      runtime.beforeEffect = async () => {
        checkpoints++;
        if (stage === "checkpoint") throw raw;
        if (stage === "containment") throw Object.assign(new AggregateError([
          new QualificationFailure({ id: 1, lane: "androidPushCleanup", step: "containment", reason: "invalid_evidence",
            class: "harness", elapsedMs: 0, operation: "unknown", observations: { persistenceFailed: true } }, { cause: raw }),
        ], "synthetic containment failure"), { pixelUnrestored: true });
      };
      const error = await runtime.gcmReadiness().catch(error => error);
      const remedy = ["disable", "pause", "enable", "reconnect-read"].includes(stage);
      expect(normalizeQualificationFailures(error)).toMatchObject([{
        reason: stage === "cancel" || stage === "expiry" ? "deadline_exceeded" : "invalid_evidence",
        observations: { gcmConnected: false, gcmRemedyApplied: remedy },
      }]);
      const text = JSON.stringify(privateQualificationFailureDiagnostic(error));
      expect(text).toContain(raw.message); expect(text).toContain("GcmService censored sample:");
      if (stage === "cancel") expect(text).toContain("synthetic GCM cancellation cause");
      if (stage === "enable" || stage === "disable") expect(normalizeQualificationFailures(error)[0]?.operation).toBe("unknown");
      if (stage === "enable") expect(checkpoints).toBe(2);
      if (stage === "containment") expect(error).toMatchObject({ pixelUnrestored: true });
    } finally { adb.mockRestore(); select.mockRestore(); }
  });

test("514 U1 the real AndroidAdbError constructor withholds identifier-bearing stdout and stderr before the private chain", async () => {
  const host = ["synthetic-private", "synthetic-net", "ts", "net"].join(".");
  const home = "/" + ["Users", "syntheticoperator"].join("/");
  const body = `${host}\n${home}\nDeviceID: SYNTHETIC-ADB-PRIVATE\n` + "private-output ".repeat(10_000);
  const stream = () => new ReadableStream<Uint8Array>({ start(value) {
    value.enqueue(new TextEncoder().encode(body)); value.close();
  } });
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
    stdout: stream(), stderr: stream(), exited: Promise.resolve(23), kill() {},
  })) as unknown as typeof Bun.spawn);
  try {
    const error = await createAndroidPushRuntime(identity).gcmReadiness().catch(error => error);
    const entries = privateQualificationFailureDiagnostic(error), text = JSON.stringify(entries);
    expect(normalizeQualificationFailures(error)).toMatchObject([{ reason: "invalid_evidence",
      observations: { gcmConnected: false, gcmRemedyApplied: false } }]);
    expect(entries.map(entry => entry.message)).toContain("adb exited 23; output withheld");
    for (const value of [host, home, "SYNTHETIC-ADB-PRIVATE", "private-output"]) expect(text).not.toContain(value);
    expect(entries.every(entry => Buffer.byteLength(entry.message) <= 4096 && Buffer.byteLength(entry.stack) <= 16_384)).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThan(262_144);
  } finally { spawn.mockRestore(); select.mockRestore(); }
});

test.each([false, true])("514 R1 pre-browser notification cleanup opens no browser (inconsistent ownership=%s)", async owned => {
  const chrome = spyOn(deviceOperations, "withAndroidChrome").mockRejectedValue(new Error("unexpected browser effect"));
  const adb = spyOn(deviceOperations, "runAdb").mockRejectedValue(new Error("unexpected adb effect"));
  const open = spyOn(webApkOperations, "openWebApk").mockRejectedValue(new Error("unexpected navigation"));
  try {
    const runtime = createAndroidPushRuntime(identity);
    const cleanup = runtime.cleanup("notifications", { epoch: "synthetic", browser: null,
      notificationTopicDigest: owned ? notificationTopicDigest("omp-attention-synthetic") : null,
      secondaryNotificationTopicDigest: null } as AndroidPushProgress);
    if (owned) await expect(cleanup).rejects.toThrow("notification ownership has no captured browser baseline");
    else await cleanup;
    expect(chrome).not.toHaveBeenCalled(); expect(adb).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  } finally { open.mockRestore(); adb.mockRestore(); chrome.mockRestore(); }
});

test("509 round2 runtime privacy conversion preserves ordinary notification errors", async () => {
  const raw = new Error("synthetic notification identity changed");
  const session: SessionMetadata = { instanceId: "synthetic", generation: 1, canView: true, canControl: true, inputRequired: true,
    startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", cwdLabel: "omp-push-synthetic",
    ask: { requestId: "synthetic-request", since: "2026-01-01T00:00:00.000Z" } };
  let reads = 0;
  const spies = [
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ revision: 1, sessions: [session] }),
      { preconnect: globalThis.fetch.preconnect })),
    spyOn(webApkOperations, "requireWebApk").mockResolvedValue("org.chromium.webapk.synthetic"),
    spyOn(notificationOperations, "readAndroidNotificationRecords").mockImplementation(async () => ++reads === 1 ? [] : [{
      key: "synthetic", tag: "omp-attention-synthetic", postedAt: 1, seen: true, visibleSince: 1,
      title: "OMP session needs attention", body: "", text: "",
    }]),
    spyOn(notificationOperations, "trackUnchangedNotificationPost").mockImplementation(() => { throw raw; }),
  ];
  try {
    const runtime = createAndroidPushRuntime(identity);
    runtime.dndOff = async () => true;
    await runtime.beginNotificationPhase("synthetic", "private_verified");
    const error = await runtime.observe(session, "attention", "private").catch(error => error);
    expect(normalizeQualificationFailures(error)).toMatchObject([{ reason: "privacy_failed" }]);
    expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(raw.message);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test.each(["before", "during"] as const)("509 council browser deadline elapsed %s capture retains deadline and original cause", async when => {
  let id = 0;
  const execution = { signal: new AbortController().signal, deadline: when === "before" ? 0 : performance.now() + 60_000, nextFailureId: () => ++id };
  const wake = spyOn(deviceOperations, "wakeAndroidDisplay").mockImplementation(async () => {
    execution.deadline = 0;
    throw new Error("synthetic elapsed browser execution");
  });
  const select = spyOn(deviceOperations, "requireSingleDevice").mockImplementation(async command => {
    if (when === "before") await command!("devices");
    return "synthetic";
  });
  try {
    const runtime = createAndroidPushRuntime(identity, { execution });
    runtime.beforeEffect = async () => {};
    const error = await runtime.browser().catch(error => error);
    expect(normalizeQualificationFailures(error)).toContainEqual(expect.objectContaining({ reason: "deadline_exceeded", class: "harness" }));
    if (when === "during") {
      expect(normalizeQualificationFailures(error)).toContainEqual(expect.objectContaining({ reason: "browser_baseline_failed" }));
      expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain("synthetic elapsed browser execution");
    }
  } finally { select.mockRestore(); wake.mockRestore(); }
});

test.each(["browser_wake", "browser_webapk", "browser_forward", "browser_target", "browser_attach",
  "browser_context", "browser_navigation", "browser_notification_state"] as const)(
  "browser baseline identifies the bounded %s failure without leaking its CDP message", async step => {
    const failure = new Error("SYNTHETIC-PRIVATE-CDP-TARGET");
    const spies = [
      spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic"),
      spyOn(deviceOperations, "wakeAndroidDisplay").mockImplementation(async () => {
        if (step === "browser_wake") throw failure;
        return "Awake";
      }),
      spyOn(webApkOperations, "requireWebApk").mockResolvedValue("org.chromium.webapk.synthetic"),
      spyOn(webApkOperations, "openWebApk").mockImplementation(async () => { if (step === "browser_webapk") throw failure; }),
    ];
    const driver = {
      browserSend: async () => {
        if (step === "browser_target") throw failure;
        return { targetInfos: [{ type: "page", targetId: "synthetic", url: identity.origin + "/" }] };
      },
      attachTab: async () => { if (step === "browser_attach") throw failure; },
      navigate: async () => { if (step === "browser_navigation") throw failure; },
      evaluate: async (expression: string) => {
        if (step === "browser_context" || step === "browser_notification_state" && expression.includes("#notify")) throw failure;
        if (expression.includes("document.readyState")) return "complete";
        if (expression.includes("#notify")) return true;
        if (expression.includes("getSubscription")) return { subscribed: true, permission: "granted", detail: "session" };
        return { href: identity.origin + "/", secure: true };
      },
    };
    // The test supplies only the browser methods used by the baseline path.
    const chrome = spyOn(deviceOperations, "withAndroidChrome").mockImplementation((async (run: (driver: unknown) => Promise<unknown>) => {
      if (step === "browser_forward") throw failure;
      return run(driver);
    }) as typeof withAndroidChrome);
    try {
      let diagnostic: unknown;
      const runtime = createAndroidPushRuntime(identity, { browserFailure: async (substep, error, elapsedMs) => {
        diagnostic = { substep, error, elapsedMs };
      } });
      runtime.beforeEffect = async () => {};
      let error: unknown;
      try { await runtime.browser(); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ evidence: { lane: "androidPush", step, reason: "browser_baseline_failed", class: "harness" } });
      expect(JSON.stringify(normalizeQualificationFailures(error))).not.toContain(failure.message);
      expect(diagnostic).toMatchObject({ substep: step, error: failure, elapsedMs: expect.any(Number) });
    } finally { chrome.mockRestore(); for (const spy of spies) spy.mockRestore(); }
  });

test("509 council diagnostic retention failures stay private beside typed cleanup failures", async () => {
  const original = new Error("CDP Runtime.evaluate: synthetic context failure"), retention = new Error("private diagnostic disk failure");
  const typed = pushBrowserCleanupFailure(new AndroidBrowserCleanupError([original], 1), (() => { let id = 0; return () => ++id; })());
  const wake = spyOn(deviceOperations, "wakeAndroidDisplay").mockRejectedValue(typed);
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  try {
    const runtime = createAndroidPushRuntime(identity, { browserFailure: async () => { throw retention; } });
    runtime.beforeEffect = async () => {};
    const error = await runtime.browser().catch(error => error);
    expect(normalizeQualificationFailures(error)).toEqual(normalizeQualificationFailures(typed));
    expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(retention.message);
    expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(original.message);
  } finally { select.mockRestore(); wake.mockRestore(); }
});

test("509 council abort during diagnostic retention keeps the original browser root and raw cause", async () => {
  const original = new Error("CDP Runtime.evaluate: synthetic execution context vanished"), controller = new AbortController();
  let id = 0;
  const wake = spyOn(deviceOperations, "wakeAndroidDisplay").mockRejectedValue(original);
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  try {
    const runtime = createAndroidPushRuntime(identity, {
      execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => ++id },
      browserFailure: async () => { controller.abort(new Error("synthetic controller cancellation")); },
    });
    runtime.beforeEffect = async () => {};
    const error = await runtime.browser().catch(error => error);
    expect(normalizeQualificationFailures(error).map(item => item.reason)).toEqual(["browser_baseline_failed", "deadline_exceeded"]);
    expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(original.message);
  } finally { select.mockRestore(); wake.mockRestore(); }
});

test.each([0, 1, 2, 8])("readiness reads eligible subscription count %s through the authenticated config path", async subscriptionCount => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    version: 2, applicationServerKey: "V".repeat(87), subscriptionCount,
  }));
  try {
    expect(await createAndroidPushRuntime(identity).subscriptionCount()).toBe(subscriptionCount);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${identity.origin}/api/v1/push/config`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
  } finally { fetch.mockRestore(); }
});

test.each(["instance", "generation", "request", "alias"] as const)("495 round2 re-arm refuses a changed %s at its transport boundary", async variant => {
  const expected: SessionMetadata = { instanceId: "fixture-instance-0001", generation: 1, canView: true, canControl: true, inputRequired: false,
    startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
  const current = { ...expected, ...(variant === "instance" ? { instanceId: "fixture-instance-0002" } :
    variant === "generation" ? { generation: 2 } : variant === "alias" ? { qualificationPushAlias: 2 } :
    { inputRequired: true, ask: { requestId: "synthetic-request-0001", since: expected.startedAt } }), cwdLabel: "omp-push-synthetic" };
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ revision: 1, sessions: [current] }));
  let commands = 0;
  try {
    const runtime = createAndroidPushRuntime(identity, { execute: async () => { commands++; return { exitCode: 0, stdout: "" }; } });
    runtime.beforeEffect = async () => {};
    await expect(runtime.fixture("ask", "synthetic", "primary", expected)).rejects.toThrow();
    expect(commands).toBe(0);
  } finally { fetch.mockRestore(); }
});

test.each(["network-cleanup", "triage-v2"] as const)("495 round2 runtime preserves %s evidence", async variant => {
  const spies = [
    spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic"),
    spyOn(deviceOperations, "wakeAndroidDisplay").mockResolvedValue("Awake"),
    spyOn(deviceOperations, "restoreAndroidRadios").mockResolvedValue(undefined),
    spyOn(webApkOperations, "requireWebApk").mockResolvedValue("org.chromium.webapk.synthetic"),
    spyOn(webApkOperations, "openWebApk").mockResolvedValue(undefined),
    spyOn(Bun, "sleep").mockResolvedValue(undefined),
  ];
  let cleared: unknown;
  const driver = {
    browserSend: async () => ({ targetInfos: [{ type: "page", targetId: "synthetic", url: identity.origin + "/" }] }),
    attachTab: async () => {}, navigate: async () => {},
    evaluate: async (expression: string) => {
      if (expression.includes("omp.sessions.held-asks")) {
        const record = { sourceId: "local", sourceOrigin: identity.origin, instanceId: "fixture-owned",
          requestId: "synthetic-request", heldAt: "2026-01-01T00:00:00.000Z" };
        cleared = await new Function("localStorage", `return ${expression}`)({
          getItem: (key: string) => key === "omp.sessions.held-asks.v2" ? JSON.stringify([record]) : null,
        });
        throw new Error("synthetic stop");
      }
      if (expression.includes("getNotifications")) return undefined;
      return expression.includes("document.readyState") ? "complete" : { href: identity.origin + "/", secure: true };
    },
  };
  const chrome = spyOn(deviceOperations, "withAndroidChrome").mockImplementation((async (run: (driver: unknown) => Promise<unknown>) => {
    if (variant === "network-cleanup") throw new AndroidBrowserCleanupError([], 1);
    return run(driver);
  }) as typeof withAndroidChrome);
  try {
    const runtime = createAndroidPushRuntime(identity);
    runtime.beforeEffect = async () => {};
    if (variant === "network-cleanup") await expect(runtime.network("wifi")).rejects.toMatchObject({ pixelUnrestored: true });
    else {
      await expect(runtime.cleanup("notifications", { epoch: "synthetic", notificationTopicDigest: notificationTopicDigest("omp-attention-fixture-owned"),
        secondaryNotificationTopicDigest: null } as AndroidPushProgress)).rejects.toThrow("synthetic stop");
      expect(cleared).toBe(false);
    }
  } finally { chrome.mockRestore(); for (const spy of spies) spy.mockRestore(); }
});

test("only the exact owned DevTools probe is classified as a non-provider fetch", () => {
  expect(checkProviderReads("scripts/android-device.ts", 'fetch("http://127.0.0.1:" + port + "/json/version", {signal})')).toEqual([]);
  expect(checkProviderReads("scripts/android-device.ts", 'fetch("https://unreviewed.example.test", {signal})')).toHaveLength(1);
  expect(checkProviderReads("scripts/android-push-runtime.ts", 'fetch(`${identity.origin}/api/v1/push/config`, {signal})')).toEqual([]);
  expect(checkProviderReads("scripts/android-push-runtime.ts", 'fetch(`${identity.origin}/api/v1/push/other`, {signal})')).toHaveLength(1);
});

test.each(["fresh", "late", "ambiguous", "missing"] as const)("worker metadata refuses %s attribution without waking a page", async variant => {
  const session: SessionMetadata = { instanceId: "volatile-instance", generation: 1, canView: true, canControl: true, inputRequired: true,
    startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", ask: { requestId: "fresh-request", since: "2026-01-01T00:00:00.000Z" } };
  const calls: string[] = [];
  const result = await observePushDeliveryRequest({
    async browserSend(method) {
      calls.push(method);
      if (method === "Target.getTargets") return { targetInfos: Array.from({ length: variant === "missing" ? 0 : variant === "ambiguous" ? 2 : 1 },
        () => ({ type: "service_worker", targetId: "volatile-worker", url: `${identity.origin}/service-worker.js` })) };
      if (method === "Target.attachToTarget") return { sessionId: "volatile-session" };
      return {};
    },
    async sessionSend(_session, method, parameters) {
      calls.push(method);
      const evaluate = new Function("self", `return ${parameters!.expression}`);
      const value = await evaluate({ registration: { getNotifications: async () => [{ data: {
        type: "attention", instanceId: session.instanceId, requestId: variant === "late" ? "old-request" : session.ask!.requestId,
      } }] } });
      return { result: { value } };
    },
  }, identity.origin, session);
  expect(result).toBe(variant === "fresh");
  expect(calls).not.toContain("Page.navigate");
  expect(calls).not.toContain("Target.createTarget");
});

test("cancelled runtime pauses stop, cleanup obtains a fresh independent context", async () => {
  const controller = new AbortController();
  const runtime = createAndroidPushRuntime(identity, { execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 } });
  const pause = runtime.pause(60_000); controller.abort();
  await expect(pause).rejects.toThrow();
  runtime.beginCleanup?.();
  await runtime.pause(1);
});

test("ADB cancellation reaps and drains its owned subprocess before returning", async () => {
  const controller = new AbortController();
  const exited = Promise.withResolvers<number>();
  let stdout!: ReadableStreamDefaultController<Uint8Array>, stderr!: ReadableStreamDefaultController<Uint8Array>;
  let killed = false, finished = false;
  const spawn: AndroidAdbSpawner = () => ({
    stdout: new ReadableStream({ start(value) { stdout = value; } }), stderr: new ReadableStream({ start(value) { stderr = value; } }),
    exited: exited.promise, kill() { killed = true; },
  });
  let failure: unknown;
  const command = runAdb(undefined, ["devices"], { signal: controller.signal, spawn }).catch(error => { failure = error; }).finally(() => { finished = true; });
  controller.abort();
  await Promise.resolve();
  expect(killed).toBe(true); expect(finished).toBe(false);
  stdout.close(); stderr.close(); exited.resolve(143);
  await command;
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("output withheld");
  expect(finished).toBe(true);
});

test("already-cancelled browser work cannot select a device or open Chrome", async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  await expect(withAndroidChrome(async () => { called = true; }, { execution: { signal: controller.signal, deadline: performance.now() + 1_000 } })).rejects.toThrow();
  expect(called).toBe(false);
});

test("R2 device discovery uses the runtime cancellation context", async () => {
  const controller = new AbortController(), exited = Promise.withResolvers<number>();
  let killed = false;
  const stream = new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new TextEncoder().encode("List of devices attached\nsynthetic device\n")); value.close(); } });
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
    stdout: stream, stderr: new ReadableStream({ start(value) { value.close(); } }), exited: exited.promise, kill() { killed = true; },
  })) as unknown as typeof Bun.spawn);
  try {
    const runtime = createAndroidPushRuntime(identity, { execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 } });
    const pending = runtime.preflight({ origin: identity.origin }).catch(() => {});
    expect(spawn).toHaveBeenCalledTimes(1);
    controller.abort(); await Bun.sleep(10);
    const cancelled = killed;
    exited.resolve(143); await pending;
    expect(cancelled).toBe(true);
  } finally { spawn.mockRestore(); }
});

test("R2 nested keyguard shell refuses a cancelled execution before spawning", async () => {
  const controller = new AbortController(); controller.abort();
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
    stdout: new ReadableStream({ start(value) { value.close(); } }), stderr: new ReadableStream({ start(value) { value.close(); } }),
    exited: Promise.resolve(0), stdin: { write() {}, end() {} }, kill() {},
  })) as unknown as typeof Bun.spawn);
  try {
    await expect(unlockAndroidKeyguard("synthetic", async () => new TextEncoder().encode("1234"), undefined,
      { signal: controller.signal, deadline: performance.now() + 1_000 })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});

test("R2 permission override connection receives its bounded execution context", async () => {
  const execution = { signal: new AbortController().signal, deadline: performance.now() + 1_000 };
  let received: unknown;
  const release = await holdAndroidNotificationDenial(identity.origin, async (run, context) => {
    received = context; await run({ browserSend: async () => ({}) });
  }, execution);
  try { expect(received).toBe(execution); } finally { await release(); }
});

test("R2 raw log proof resolves the retained Mac home and uses its configured executor", async () => {
  const { gatewayRawLogsDiscarded } = await import("./android-push-runtime.ts");
  const calls: readonly string[][] = [];
  const execute = async (argv: readonly string[]) => {
    (calls as string[][]).push([...argv]);
    return { exitCode: 0, stdout: argv[0] === "plutil" ? "/dev/null\n" : "/synthetic/retained-user\n", stderr: "" };
  };
  expect(await gatewayRawLogsDiscarded(execute)).toBe(true);
  const reads = calls.filter(argv => argv[0] === "plutil");
  expect(reads).toHaveLength(2);
  expect(reads.every(argv => argv.at(-1) === "/synthetic/retained-user/Library/LaunchAgents/omp-session-gateway.plist")).toBe(true);
});

test("R2 fresh request attestation accepts the delivering secondary snapshot and rejects wrong generations", async () => {
  const { matchesPushDeliverySnapshot } = await import("./android-push-runtime.ts");
  const session = { instanceId: "secondary", generation: 2, ask: { requestId: "fresh" } } as SessionMetadata;
  expect(matchesPushDeliverySnapshot(session, [{ ...session, instanceId: "primary" }, session])).toBe(true);
  expect(matchesPushDeliverySnapshot(session, [{ ...session, generation: 1 }])).toBe(false);
});

test("R2 numeric alias lookup refuses foreign, stale and ambiguous fixture snapshots", () => {
  const session = { instanceId: "secondary", generation: 2, inputRequired: true, canControl: true, ask: { requestId: "fresh" } } as SessionMetadata;
  const current = { ...session, qualificationPushAlias: 12 };
  expect(qualificationPushAliasFor(session, [undefined, current])).toBe(12);
  for (const changed of [{ ...current, instanceId: "foreign" }, { ...current, generation: 1 },
    { ...current, ask: { ...current.ask!, requestId: "old" } }, { ...current, canControl: false }]) {
    expect(qualificationPushAliasFor(session, [changed])).toBeUndefined();
  }
  expect(qualificationPushAliasFor(session, [current, current])).toBeUndefined();
  expect(qualificationPushAliasFor(session, [session])).toBeUndefined();
});

test("R3 rejecting ADB streams cannot finish cancellation before the child exits", async () => {
  const controller = new AbortController(), exited = Promise.withResolvers<number>();
  let stdout!: ReadableStreamDefaultController<Uint8Array>, done = false;
  const command = runAdb(undefined, ["devices"], { signal: controller.signal, spawn: () => ({
    stdout: new ReadableStream({ start(value) { stdout = value; } }), stderr: new ReadableStream({ start(value) { value.close(); } }),
    exited: exited.promise, kill() {},
  }) }).catch(() => {}).finally(() => { done = true; });
  controller.abort(); stdout.error(new Error("synthetic stream failure"));
  await Bun.sleep(10);
  const prematurelyDone = done;
  exited.resolve(143); await command;
  expect(prematurelyDone).toBe(false);
});

test("495 R2 task restoration cannot reopen a CDP connection after browser containment", async () => {
  const calls: string[][] = [];
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new TextEncoder().encode(text)); value.close(); } });
  const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
    calls.push(argv);
    const text = argv.includes("devices") ? "List of devices attached\nsynthetic device\n" :
      argv.includes("packages") ? "package:org.chromium.webapk.synthetic\n" : argv.includes("dumpsys") ? 'Authority: "synthetic.example.test": -1' : "";
    return { stdout: stream(text), stderr: stream(""), exited: Promise.resolve(0), kill() {} };
  }) as typeof Bun.spawn);
  try {
    const runtime = createAndroidPushRuntime(identity);
    const device: PushDeviceBaseline = { wifi: true, mobile: true, airplane: false, forcedDoze: false, batteryOverride: false,
      awake: false, locked: true, webApkTask: true, chromeNotificationsAllowed: true, webApkNotificationsAllowed: true };
    runtime.beforeEffect = async () => {};
    runtime.device = async () => device;
    runtime.lock = async () => {};
    runtime.openPwa = async () => { throw new Error("CDP reopened after browser restoration"); };
    await runtime.cleanup("task", { device } as AndroidPushProgress);
    expect(calls.some(argv => argv.includes("monkey"))).toBe(true);
    expect(calls.some(argv => argv.includes("forward"))).toBe(false);
  } finally { spawn.mockRestore(); }
});

test("495 R2 browser cleanup has a harness root and causally bound containment collateral", () => {
  let id = 0;
  const error = pushBrowserCleanupFailure(new AndroidBrowserCleanupError([], 1), () => ++id);
  const failures = parseLaneFailures(normalizeQualificationFailures(error));
  expect(failures).toHaveLength(2);
  expect(failures[0]).toMatchObject({ id: 1, lane: "androidPushCleanup", step: "browser", class: "harness",
    reason: "containment_unproven", observations: { remainingResources: 1, cleanupVerified: false } });
  expect(failures[1]).toMatchObject({ class: "collateral", step: "containment", originIds: [1] });
  expect(qualificationRetryEligible({ failures, timings: { attemptMs: 0, cleanupMs: 0 },
    containment: { proven: false, cleanupComplete: false, unresolvedMutation: true } }, true)).toBe(false);
  expect(error).toMatchObject({ pixelUnrestored: true });
});

for (const scenario of ["abort-attach", "deadline-open", "abort-create", "close-refused", "forward-cancel", "constructor-throws",
  "495-forward-remove", "495-acquisition-remove", "495-abort-create-unacknowledged", "495-create-timeout"] as const) test(`R2 CDP cleanup retains ownership through ${scenario}`, async () => {
  const controller = new AbortController(), calls: string[] = [];
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new TextEncoder().encode(text)); value.close(); } });
  const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
    if (argv.includes("forward")) calls.push(argv.includes("--remove") ? "forward.remove" : "forward.acquire");
    if (scenario === "forward-cancel" && argv.includes("forward") && !argv.includes("--remove")) controller.abort();
    return {
    stdout: stream(argv.includes("devices") ? "List of devices attached\nsynthetic device\n" : argv.includes("package") ? "versionName=153.0.0.0" : ""),
    stderr: stream(""), exited: Promise.resolve(argv.includes("--remove") && ["495-forward-remove", "495-acquisition-remove"].includes(scenario) ? 1 : 0), kill() {},
  }; }) as typeof Bun.spawn);
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    "Android-Package": "com.android.chrome", Browser: "Chrome/153.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1:9238/devtools/browser/synthetic",
  })));
  const realSocket = globalThis.WebSocket;
  class Socket {
    onmessage?: (event: { data: string }) => void; onopen?: () => void; onerror?: () => void;
    constructor() {
      if (scenario === "constructor-throws" || scenario === "495-acquisition-remove") throw new Error("synthetic socket construction failure");
      if (scenario !== "deadline-open") queueMicrotask(() => this.onopen?.());
    }
    close() { calls.push("socket.close"); }
    send(frame: string) {
      const message = JSON.parse(frame); calls.push(message.method);
      if (message.method === "Target.attachToTarget" && scenario === "abort-attach") { controller.abort(); return; }
      if (message.method === "Target.createTarget" && scenario === "abort-create") {
        controller.abort();
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: { targetId: "late-owned-tab" } }) }), 10);
        return;
      }
      if (message.method === "Target.createTarget" && ["495-abort-create-unacknowledged", "495-create-timeout"].includes(scenario)) {
        if (scenario === "495-abort-create-unacknowledged") {
          controller.abort();
          nativeTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: { targetId: "after-grace-tab" } }) }), 15);
        }
        return;
      }
      const result = message.method === "Browser.getVersion" ? { product: "Chrome/153.0.0.0" } :
        message.method === "Target.createTarget" ? { targetId: "owned-tab" } :
        message.method === "Target.closeTarget" ? { success: scenario !== "close-refused" || calls.filter(call => call === "Target.closeTarget").length > 1 } : {};
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }));
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const nativeTimeout = globalThis.setTimeout;
  const timers = scenario.includes("495-") ? spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, milliseconds?: number, ...args: unknown[]) =>
    nativeTimeout(callback, milliseconds !== undefined && milliseconds >= 10_000 ? 5 : milliseconds, ...args)) as typeof setTimeout) : undefined;
  const started = performance.now();
  try {
    const result = withAndroidChrome(async driver => { await driver.openTab(); await driver.closeTab(); throw new Error("synthetic completion"); }, { port: 9238, launchBrowser: false,
      execution: { signal: controller.signal, deadline: started + 100 } });
    if (scenario.startsWith("495-")) await expect(result).rejects.toMatchObject({ pixelUnrestored: true, remainingResources: 1 });
    else await expect(result).rejects.toThrow();
    if (scenario === "abort-attach" || scenario === "abort-create") expect(calls).toContain("Target.closeTarget");
    if (scenario === "close-refused") expect(calls.filter(call => call === "Target.closeTarget")).toHaveLength(2);
    expect(calls).toContain("forward.remove");
    if (scenario === "495-abort-create-unacknowledged") await Bun.sleep(20);
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally { timers?.mockRestore(); globalThis.WebSocket = realSocket; fetchMock.mockRestore(); spawn.mockRestore(); }
}, 12_000);
