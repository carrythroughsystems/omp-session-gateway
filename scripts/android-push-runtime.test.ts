import { expect, spyOn, test } from "bun:test";
import { runInNewContext } from "node:vm";
import * as deviceOperations from "./android-device.ts";
import * as webApkOperations from "./android-webapk.ts";
import * as notificationOperations from "./android-notification.ts";
import { AndroidBrowserCleanupError, AndroidDevtoolsConnectionError, runAdb, unlockAndroidKeyguard, withAndroidChrome, type AndroidAdbSpawner } from "./android-device.ts";
import { createAndroidPushRuntime, holdAndroidNotificationDenial, holdPushWorkerObserver, observePushDeliveryRequest, qualificationPushAliasFor, pushBrowserCleanupFailure, pushLaunchRequestKind } from "./android-push-runtime.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import { checkProviderReads } from "./check-repository.ts";
import type { AndroidPushProgress, PushDeviceBaseline } from "./android-push-qualification.ts";
import { QualificationFailure, privateQualificationFailureDiagnostic, normalizeQualificationFailures, parseLaneFailures, qualificationRetryEligible } from "./qualification-failure.ts";
import { notificationTopicDigest } from "./android-notification.ts";
import { PUSH_FIXTURE_ASK_BODY } from "./fixtures/push-qualification-extension.ts";
import { commandPushFixture } from "./push-qualification-fixture.ts";
const identity = { origin: "https://synthetic.example.test", omp: { version: "18.3.0", bunVersion: "1.4.0", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), nativeTarballSha256: "c".repeat(64), nativeBinarySha256: "d".repeat(64) } };
const WIFI_CONNECTIVITY = "Current Networks:\n  NetworkAgentInfo{ ni{WIFI CONNECTED} lastValidated }";
const VPN_CONNECTIVITY = `${WIFI_CONNECTIVITY}\n  NetworkAgentInfo{ ni{VPN CONNECTED} SYNTHETIC-PRIVATE-TRANSPORT-NETWORK }`;
const DISCONNECT_VPN = "shell am broadcast -a com.tailscale.ipn.DISCONNECT_VPN -n com.tailscale.ipn/.IPNReceiver";
const CONNECT_VPN = "shell am broadcast -a com.tailscale.ipn.CONNECT_VPN -n com.tailscale.ipn/.IPNReceiver";

test.each(["connected", "settling", "cellular", "vpn-absent", "remedy", "stalled", "vpn-stalled", "no-wifi"] as const)(
  "567 VPN recovery uses one bounded reconnect for the Wi-Fi push socket (%s)", async scenario => {
    const initialWindow = 15_000, recoveryWindow = 45_000, pollPause = 500, reconnectPause = 3_000;
    // Instant reads: 15 s / 500 ms = 30 initial polls; 45 s / 500 ms = 90 recovery polls.
    const initialPolls = initialWindow / pollPause, recoveryPolls = recoveryWindow / pollPause, settlingPolls = 4;
    let time = 0, reads = 0, restored = false, healthySamples = 0, healthy = false;
    const events: string[] = [];
    const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
    const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args, options) => {
      const command = args.join(" "); events.push(command);
      expect(options?.timeoutMs).toBe(10_000);
      if (command === "shell dumpsys activity service GcmService") {
        reads++;
        const connected = ["connected", "cellular", "vpn-absent", "vpn-stalled"].includes(scenario) ||
          scenario === "settling" && reads >= settlingPolls || scenario === "remedy" && restored;
        const network = scenario === "cellular" && !restored ? "VPN(17) [MOBILE(0)]" :
          scenario === "vpn-absent" || scenario === "vpn-stalled" ? "WiFi(1)" : "VPN(17) [WiFi(1)]";
        healthy = connected && network.includes("WiFi(");
        if (healthy) healthySamples++;
        return `DeviceID: SYNTHETIC-PRIVATE-TRANSPORT-DEVICE\nIs client connected: ${connected}\n` +
          `In-use by client: GcmNetwork{123 ${network} SYNTHETIC-PRIVATE-TRANSPORT-NETWORK}\n` +
          "Received SYNTHETIC-PRIVATE-TRANSPORT-MESSAGE";
      }
      if (command === CONNECT_VPN) restored = true;
      if (command === "shell dumpsys connectivity") {
        expect(healthy).toBe(true); healthy = false;
        return scenario === "vpn-stalled" || scenario === "vpn-absent" && !restored ? WIFI_CONNECTIVITY : VPN_CONNECTIVITY;
      }
      return "";
    });
    try {
      const runtime = createAndroidPushRuntime(identity);
      runtime.now = () => time;
      runtime.pause = async milliseconds => { events.push(`pause ${milliseconds}`); time += milliseconds; };
      runtime.beforeEffect = async () => { events.push("checkpoint"); };
      const result = await runtime.pushTransport!({ wifi: scenario !== "no-wifi", mobile: true });
      const stalled = scenario === "stalled" || scenario === "vpn-stalled";
      expect(result).toBe(!stalled);
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC-PRIVATE-TRANSPORT");
      expect(events.filter(event => event === "shell dumpsys connectivity")).toHaveLength(healthySamples);
      expect(events.some(event => event.startsWith("shell svc") || event.includes("airplane-mode"))).toBe(false);
      const remedy = ["cellular", "vpn-absent", "remedy", "stalled", "vpn-stalled"].includes(scenario);
      if (remedy) {
        expect(events.slice(events.indexOf("checkpoint"), events.indexOf("checkpoint") + 6)).toEqual([
          "checkpoint", DISCONNECT_VPN, "pause 3000", "checkpoint", CONNECT_VPN,
          "shell dumpsys activity service GcmService",
        ]);
        expect(events.filter(event => event === DISCONNECT_VPN)).toHaveLength(1);
        expect(events.filter(event => event === CONNECT_VPN)).toHaveLength(1);
        expect(time).toBe(initialWindow + reconnectPause + (stalled ? recoveryWindow : 0));
        expect(reads).toBe(initialPolls + (stalled ? recoveryPolls : 1));
      } else {
        expect(events.some(event => event === "checkpoint" || event.includes("broadcast"))).toBe(false);
        expect(reads).toBe(scenario === "no-wifi" ? 0 : scenario === "settling" ? settlingPolls : 1);
        expect(time).toBe(scenario === "settling" ? (settlingPolls - 1) * pollPause : 0);
        if (scenario === "no-wifi") expect(select).not.toHaveBeenCalled();
      }
    } finally { adb.mockRestore(); select.mockRestore(); }
  });

test("567 VPN recovery accepts a socket directly on Wi-Fi when the VPN is present", async () => {
  const events: string[] = [];
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args) => {
    events.push(args.join(" "));
    if (args.join(" ") === "shell dumpsys connectivity") return VPN_CONNECTIVITY;
    return "Is client connected: true\nIn-use by client: GcmNetwork{409 WiFi(1)}";
  });
  try {
    const runtime = createAndroidPushRuntime(identity);
    runtime.now = () => 0;
    runtime.pause = async () => { events.push("pause"); };
    runtime.beforeEffect = async () => { events.push("checkpoint"); };
    expect(await runtime.pushTransport!({ wifi: true, mobile: true })).toBe(true);
    expect(events).toEqual(["shell dumpsys activity service GcmService", "shell dumpsys connectivity"]);
  } finally { adb.mockRestore(); select.mockRestore(); }
});

test.each([
  ["duplicate connection", "Is client connected: true\nIs client connected: false", "In-use by client: GcmNetwork{1 VPN(17) [WiFi(1)]}"],
  ["connection suffix", "Is client connected: true\nIs client connected_legacy: true", "In-use by client: GcmNetwork{1 VPN(17) [WiFi(1)]}"],
  ["connection spelling", "IS CLIENT CONNECTED: true", "In-use by client: GcmNetwork{1 VPN(17) [WiFi(1)]}"],
  ["missing network", "Is client connected: true", ""],
  ["duplicate network", "Is client connected: true", "In-use by client: GcmNetwork{1 VPN(17) [WiFi(1)]}\nIn-use by client: GcmNetwork{2 MOBILE(0)}"],
  ["network spelling", "Is client connected: true", "IN-USE BY CLIENT: GcmNetwork{1 VPN(17) [WiFi(1)]}"],
  ["network suffix", "Is client connected: true", "In-use by client: GcmNetwork{1 VPN(17) [WiFi(1)]}\nIn-use by client_legacy: GcmNetwork{2 MOBILE(0)}"],
  ["network trailing data", "Is client connected: true", "In-use by client: GcmNetwork{1 VPN(17) [WiFi(1)]} private-trailer"],
])("567 VPN recovery rejects ambiguous or unsupported GCM flags (%s)", async (_label, connection, network) => {
  let time = 0, effects = 0;
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args) =>
    args.join(" ") === "shell dumpsys connectivity" ? VPN_CONNECTIVITY :
      `DeviceID: SYNTHETIC-PRIVATE-TRANSPORT-DEVICE\n${connection}\n${network}`);
  try {
    const runtime = createAndroidPushRuntime(identity);
    runtime.now = () => time; runtime.pause = async milliseconds => { time += milliseconds; };
    runtime.beforeEffect = async () => { effects++; };
    expect(await runtime.pushTransport!({ wifi: true, mobile: false })).toBe(false);
    expect(time).toBe(63_000); expect(effects).toBe(2);
  } finally { adb.mockRestore(); select.mockRestore(); }
});

test.each([["initial", "gcm"], ["initial", "vpn"], ["reconnect", "gcm"], ["reconnect", "vpn"]] as const)(
  "567 VPN recovery accepts a healthy sample completing after its %s window (%s)", async (stage, lateRead) => {
    const initialWindow = 15_000, recoveryWindow = 45_000, reconnectPause = 3_000, pollPause = 500, readDuration = 800;
    const deadline = stage === "initial" ? initialWindow : initialWindow + reconnectPause + recoveryWindow;
    const lateStart = deadline - pollPause, starts: number[] = [];
    let time = 0, restored = false, effects = 0;
    const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
    const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args, options) => {
      if (args.join(" ") === CONNECT_VPN) restored = true;
      if (args[1] !== "dumpsys") return "";
      expect(options?.timeoutMs).toBe(10_000);
      const vpn = args.join(" ") === "shell dumpsys connectivity";
      // GCM starts the sample; its follow-up VPN read may finish beyond the window.
      if (!vpn) { starts.push(time); expect(time).toBeLessThan(restored ? deadline : initialWindow); }
      const connected = time >= lateStart;
      if (connected && vpn === (lateRead === "vpn")) time += readDuration;
      return vpn ? VPN_CONNECTIVITY :
        `Is client connected: ${connected}\nIn-use by client: GcmNetwork{1 VPN(17) [WiFi(1)]}`;
    });
    try {
      const runtime = createAndroidPushRuntime(identity);
      runtime.now = () => time; runtime.pause = async milliseconds => { time += milliseconds; };
      runtime.beforeEffect = async () => { effects++; };
      expect(await runtime.pushTransport!({ wifi: true, mobile: false })).toBe(true);
      expect(time).toBe(lateStart + readDuration);
      expect(effects).toBe(stage === "initial" ? 0 : 2);
      expect(starts.at(-1)).toBe(lateStart);
      expect(starts).toHaveLength(initialWindow / pollPause + (stage === "reconnect" ? recoveryWindow / pollPause : 0));
    } finally { adb.mockRestore(); select.mockRestore(); }
  });

test.each(["reconnected", "stalled"] as const)(
  "567 VPN recovery never clips a slow read near the poll deadline (%s)", async scenario => {
    const initialWindow = 15_000, recoveryWindow = 45_000, readDuration = 800, pollPause = 500;
    // Each failed poll takes 800 ms + 500 ms; its last read may finish after the window.
    const initialPolls = Math.ceil(initialWindow / (readDuration + pollPause));
    const recoveryPolls = Math.ceil(recoveryWindow / (readDuration + pollPause));
    let time = 0, restored = false, deadline = initialWindow;
    const starts: { at: number; deadline: number }[] = [], caps: number[] = [];
    const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
    const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args, options) => {
      if (args.join(" ") === CONNECT_VPN) { restored = true; deadline = time + recoveryWindow; }
      if (args[1] !== "dumpsys") return "";
      const vpn = args.join(" ") === "shell dumpsys connectivity";
      if (!vpn) { starts.push({ at: time, deadline }); expect(time).toBeLessThan(deadline); }
      caps.push(options!.timeoutMs!);
      time += readDuration;
      if (options!.timeoutMs! < readDuration) throw new deviceOperations.AndroidAdbError(143);
      return vpn ? VPN_CONNECTIVITY :
        `Is client connected: ${restored && scenario === "reconnected"}\nIn-use by client: GcmNetwork{1 VPN(17) [WiFi(1)]}`;
    });
    try {
      const runtime = createAndroidPushRuntime(identity);
      runtime.now = () => time; runtime.pause = async milliseconds => { time += milliseconds; };
      runtime.beforeEffect = async () => {};
      expect(await runtime.pushTransport!({ wifi: true, mobile: true })).toBe(scenario === "reconnected");
      expect(caps.every(cap => cap === 10_000)).toBe(true);
      expect(starts).toHaveLength(initialPolls + (scenario === "stalled" ? recoveryPolls : 1));
      expect(starts.some(start => start.deadline - start.at < readDuration)).toBe(true);
      expect(restored).toBe(true);
    } finally { adb.mockRestore(); select.mockRestore(); }
  });

test.each(["read", "mutation", "checkpoint", "cancelled", "expired", "typed"] as const)(
  "567 push transport preserves %s errors without retaining GCM identifiers", async stage => {
    let time = 0, reads = 0;
    const controller = new AbortController(), raw = new deviceOperations.AndroidAdbError(23);
    const typed = new QualificationFailure({ id: 40, lane: "androidPushCleanup", step: "containment",
      reason: "invalid_evidence", class: "harness", elapsedMs: 0, operation: "unknown", observations: {} });
    const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 41 };
    const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
    const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args) => {
      if (args.join(" ") === "shell dumpsys connectivity") return VPN_CONNECTIVITY;
      if (args[1] === "dumpsys") {
        if (++reads > 1 && stage === "read") throw raw;
        if (stage === "cancelled") controller.abort(new Error("synthetic transport cancellation"));
        if (stage === "expired") execution.deadline = 0;
        return "DeviceID: SYNTHETIC-PRIVATE-TRANSPORT-DEVICE\nIs client connected: false\n" +
          "In-use by client: GcmNetwork{123 VPN(17) [WiFi(1)] SYNTHETIC-PRIVATE-TRANSPORT-NETWORK}\n" +
          "Received SYNTHETIC-PRIVATE-TRANSPORT-MESSAGE";
      }
      if (stage === "mutation") throw raw;
      return "";
    });
    try {
      const runtime = createAndroidPushRuntime(identity, { execution });
      runtime.now = () => time; runtime.pause = async milliseconds => { time += milliseconds; };
      runtime.beforeEffect = async () => {
        if (stage === "checkpoint") throw raw;
        if (stage === "typed") throw typed;
      };
      const error = await runtime.pushTransport!({ wifi: true, mobile: false }).catch(error => error);
      if (stage === "cancelled" || stage === "expired") {
        expect(normalizeQualificationFailures(error)).toMatchObject([{ lane: "androidPush", reason: "deadline_exceeded" }]);
      } else expect(error).toBe(stage === "typed" ? typed : raw);
      expect(JSON.stringify(privateQualificationFailureDiagnostic(error))).not.toContain("SYNTHETIC-PRIVATE-TRANSPORT");
      expect(normalizeQualificationFailures(error).some(failure => failure.lane === "rigReadiness")).toBe(false);
    } finally { adb.mockRestore(); select.mockRestore(); }
  });

test.each([false, true])("567 VPN recovery cleanup checks only a non-Airplane Wi-Fi baseline (mobile=%s)", async mobile => {
  const restore = spyOn(deviceOperations, "restoreAndroidRadios").mockResolvedValue(undefined);
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  const adb = spyOn(deviceOperations, "runAdb").mockResolvedValue(VPN_CONNECTIVITY);
  try {
    for (const [wifi, airplane] of [[true, false], [false, false], [true, true]] as const) {
      const baseline: PushDeviceBaseline = { wifi, mobile, airplane, forcedDoze: false, batteryOverride: false,
        awake: true, locked: false, webApkTask: false, chromeNotificationsAllowed: true, webApkNotificationsAllowed: true };
      const runtime = createAndroidPushRuntime(identity), events: string[] = [];
      expect(runtime.pushTransport).toBeFunction();
      runtime.pushTransport = async target => {
        events.push("transport"); expect(target).toEqual({ wifi, mobile }); return false;
      };
      restore.mockImplementation(async () => { events.push("radios"); });
      adb.mockImplementation(async (_serial, args, options) => {
        events.push("vpn"); expect(args).toEqual(["shell", "dumpsys", "connectivity"]);
        expect(options?.timeoutMs).toBeGreaterThan(0); expect(options?.timeoutMs).toBeLessThanOrEqual(10_000);
        return VPN_CONNECTIVITY;
      });
      runtime.device = async () => { events.push("baseline"); return baseline; };
      await runtime.cleanup("network", { epoch: "synthetic", device: baseline } as AndroidPushProgress);
      expect(events).toEqual(wifi && !airplane ? ["radios", "transport", "vpn", "baseline"] : ["radios", "baseline"]);
    }
  } finally { adb.mockRestore(); select.mockRestore(); restore.mockRestore(); }
});

test.each([true, false])("567 VPN recovery cleanup requires the VPN to be back (present=%s)", async present => {
  const restore = spyOn(deviceOperations, "restoreAndroidRadios").mockResolvedValue(undefined);
  const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
  const adb = spyOn(deviceOperations, "runAdb").mockResolvedValue(present ? VPN_CONNECTIVITY : WIFI_CONNECTIVITY);
  try {
    const runtime = createAndroidPushRuntime(identity), events: string[] = [];
    const baseline = { wifi: true, mobile: true, airplane: false } as PushDeviceBaseline;
    runtime.pushTransport = async () => { events.push("transport"); return present; };
    runtime.device = async () => { events.push("baseline"); return baseline; };
    const cleanup = runtime.cleanup("network", { device: baseline } as AndroidPushProgress);
    if (present) await cleanup;
    else await expect(cleanup).rejects.toThrow("Tailscale VPN was not restored after push transport recovery");
    expect(adb).toHaveBeenCalledTimes(1);
    expect(events).toEqual(present ? ["transport", "baseline"] : ["transport"]);
  } finally { adb.mockRestore(); select.mockRestore(); restore.mockRestore(); }
});

test.each(["adb", "execution"] as const)("567 network cleanup retains push transport %s failures", async stage => {
  const restore = spyOn(deviceOperations, "restoreAndroidRadios").mockResolvedValue(undefined);
  try {
    const runtime = createAndroidPushRuntime(identity);
    const error = stage === "adb" ? new deviceOperations.AndroidAdbError(23) :
      new QualificationFailure({ id: 1, lane: "androidPush", step: "network_verified", reason: "deadline_exceeded",
        class: "harness", elapsedMs: 0, operation: "unknown", observations: { controllerDeadline: true } });
    runtime.pushTransport = async () => { throw error; };
    runtime.device = async () => { throw new Error("baseline read after failed transport"); };
    const baseline = { wifi: true, mobile: true, airplane: false } as PushDeviceBaseline;
    await expect(runtime.cleanup("network", { device: baseline } as AndroidPushProgress)).rejects.toBe(error);
  } finally { restore.mockRestore(); }
});

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

test.each(["checkpoint-bound", "execution-deadline", "cancelled", "rejected"] as const)(
  "510 post-disable checkpoint %s cannot pin Wi-Fi or skip radio restoration", async stage => {
    const commands: string[] = [], controller = new AbortController(), checkpointBounds: number[] = [];
    const baseline: PushDeviceBaseline = { wifi: true, mobile: false, airplane: false, forcedDoze: false, batteryOverride: false,
      awake: true, locked: false, webApkTask: false, chromeNotificationsAllowed: true, webApkNotificationsAllowed: true };
    let checkpoints = 0, wifi = true, restored = false, id = 0;
    let cancellation: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
    const raw = new Error(`synthetic post-disable checkpoint ${stage}`);
    const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
    const adb = spyOn(deviceOperations, "runAdb").mockImplementation(async (_serial, args) => {
      const command = args.join(" "); commands.push(command);
      if (command === "shell dumpsys activity service GcmService") return "Is client connected: false\nReconnect Scheduler Alarm: OFF";
      if (command === "shell dumpsys connectivity") return VPN_CONNECTIVITY;
      if (command === "shell svc wifi disable") wifi = false;
      if (command === "shell svc wifi enable") wifi = true;
      return "";
    });
    const setTimer = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const [run, delay, ...rest] = args;
      if (checkpoints === 2 && !restored && delay !== undefined && delay <= 30_000) {
        checkpointBounds.push(delay);
        return setTimer(run, stage === "checkpoint-bound" ? 20 : delay, ...rest);
      }
      return setTimer(run, delay, ...rest);
    }) as typeof setTimeout);
    try {
      const runtime = createAndroidPushRuntime(identity, { execution: {
        signal: controller.signal, deadline: performance.now() + (stage === "execution-deadline" ? 150 : 60_000),
        nextFailureId: () => ++id,
      } });
      runtime.pause = async () => {};
      runtime.beforeEffect = async () => {
        checkpoints++;
        if (checkpoints !== 2) return;
        expect(wifi).toBe(false);
        if (stage === "rejected") throw raw;
        if (stage === "cancelled") cancellation = setTimer(() => controller.abort(raw), 20);
        await new Promise<void>(() => {});
      };
      // Isolate gcmReadiness's checkpoint/cleanup interplay; pushTransport has its own tests.
      runtime.pushTransport = async () => true;
      runtime.device = async () => ({ ...baseline, wifi });
      const started = performance.now();
      const error = await Promise.race([
        runtime.gcmReadiness().finally(async () => {
          expect(wifi).toBe(false);
          runtime.beginCleanup!();
          await runtime.cleanup("network", { epoch: "synthetic", device: baseline } as AndroidPushProgress);
          restored = true;
        }).catch(error => error),
        // hang-deadline: behavior-under-test -- mocked ADB/checkpoints must restore Wi-Fi promptly.
        new Promise<"pending">(resolve => { watchdog = setTimer(() => resolve("pending"), 1_000); }),
      ]);
      expect(error).not.toBe("pending");
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(restored).toBe(true); expect(wifi).toBe(true);
      expect(commands.filter(command => command.startsWith("shell svc wifi"))).toEqual([
        "shell svc wifi disable", "shell svc wifi enable",
      ]);
      expect(normalizeQualificationFailures(error)).toMatchObject([{
        operation: "unknown", observations: { gcmConnected: false, gcmRemedyApplied: true },
      }]);
      const messages = privateQualificationFailureDiagnostic(error).map(entry => entry.message);
      expect(messages).toContain(stage === "cancelled" || stage === "rejected" ? raw.message :
        "Push checkpoint persistence exceeded its bound");
      if (stage === "checkpoint-bound") expect(checkpointBounds).toContain(30_000);
      if (stage === "execution-deadline") {
        expect(checkpointBounds).toHaveLength(1);
        expect(checkpointBounds[0]).toBeGreaterThan(0);
        expect(checkpointBounds[0]).toBeLessThanOrEqual(150);
      }
    } finally { clearTimeout(watchdog); clearTimeout(cancellation); timer.mockRestore(); adb.mockRestore(); select.mockRestore(); }
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

test.each(
  ["Is client connected", "is CLIENT connected", " Is\tclient\tconnected", "Isclientconnected",
    "Is  client  connected", "Is\u00a0client\u00a0connected"].flatMap(label =>
    ["_legacy", "Legacy", "1", "-legacy"].flatMap(suffix => ["true", "false"].flatMap(value => {
      const malformed = `${label}${suffix}: ${value}`;
      return [malformed, `Is client connected: true\n${malformed}`, `${malformed}\nIs client connected: false`];
    }))),
)("514 R2 GCM never ignores a malformed label prefix: %s", async dump => {
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
    const messages = privateQualificationFailureDiagnostic(error).map(entry => entry.message);
    expect(messages).toContain("GcmService censored sample: Is client connected: unavailable; Reconnect Scheduler Alarm: unavailable");
    expect(messages).not.toContain(dump);
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

test("fleet coverage polls retain the open page's last-known directory without navigation", async () => {
  let navigations = 0;
  const coverage = { selected: true, state: "stale", covered: false };
  const driver = {
    browserSend: async () => ({ targetInfos: [{ type: "page", targetId: "page", url: identity.origin + "/" }] }),
    attachTab: async () => {}, navigate: async () => { navigations++; }, send: async () => ({}),
    evaluate: async (expression: string) => expression === "document.readyState" ? "complete" :
      expression.includes("href: location.href") ? { href: identity.origin + "/", secure: true } :
      expression.includes("notification-hosts-summary") ? coverage : true,
  };
  const spies = [
    spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic"),
    spyOn(deviceOperations, "wakeAndroidDisplay").mockResolvedValue("Awake"),
    spyOn(webApkOperations, "requireWebApk").mockResolvedValue("org.chromium.webapk.synthetic"),
    spyOn(webApkOperations, "openWebApk").mockResolvedValue(undefined),
    spyOn(deviceOperations, "withAndroidChrome").mockImplementation((async (run: (driver: unknown) => Promise<unknown>) => run(driver)) as typeof withAndroidChrome),
  ];
  try {
    const runtime = createAndroidPushRuntime(identity);
    runtime.beforeEffect = async () => {}; runtime.dndOff = async () => true;
    expect(await runtime.fleet.coverage()).toEqual(coverage);
    expect(await runtime.fleet.coverage()).toEqual(coverage);
    expect(navigations).toBe(0);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test("fleet replacement observation never hides forbidden content in a mismatched request", async () => {
  const session: SessionMetadata = { instanceId: "synthetic", generation: 1, canView: true, canControl: true, inputRequired: true,
    startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", cwdLabel: "omp-push-synthetic",
    ask: { requestId: "synthetic-request", since: "2026-01-01T00:00:00.000Z" } };
  let reads = 0;
  const driver = {
    browserSend: async (method: string) => method === "Target.getTargets" ? { targetInfos: [
      { type: "page", targetId: "page", url: identity.origin + "/" },
      { type: "service_worker", targetId: "worker", url: identity.origin + "/service-worker.js" },
    ] } : method === "Target.attachToTarget" ? { sessionId: "worker" } : {},
    sessionSend: async () => ({ result: { value: false } }),
    attachTab: async () => {}, navigate: async () => {}, send: async () => ({}),
    evaluate: async (expression: string) => expression === "document.readyState" ? "complete" :
      expression.includes("href: location.href") ? { href: identity.origin + "/", secure: true } : true,
  };
  const spies = [
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ revision: 1, sessions: [session] }), { preconnect: globalThis.fetch.preconnect })),
    spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic"),
    spyOn(deviceOperations, "wakeAndroidDisplay").mockResolvedValue("Awake"),
    spyOn(webApkOperations, "requireWebApk").mockResolvedValue("org.chromium.webapk.synthetic"),
    spyOn(webApkOperations, "openWebApk").mockResolvedValue(undefined),
    spyOn(notificationOperations, "readAndroidNotificationRecords").mockImplementation(async () => ++reads === 1 ? [] : [{
      key: "synthetic", tag: "omp-attention-synthetic", postedAt: 1, seen: true, visibleSince: 1,
      title: "OMP session needs attention", body: PUSH_FIXTURE_ASK_BODY, text: PUSH_FIXTURE_ASK_BODY,
    }]),
    spyOn(deviceOperations, "withAndroidChrome").mockImplementation((async (run: (driver: unknown) => Promise<unknown>) => run(driver)) as typeof withAndroidChrome),
  ];
  try {
    const runtime = createAndroidPushRuntime(identity);
    runtime.beforeEffect = async () => {}; runtime.dndOff = async () => true;
    await runtime.fleet.select(true);
    await runtime.beginNotificationPhase("synthetic", "fleet_private_verified");
    expect(await runtime.observe(session, "attention", "private")).toMatchObject({ count: 0, forbiddenFound: true });
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test.each([[0, 0, true], [1, 1, false], [0, 1, false]] as const)(
  "fleet tag clear requires zero OS and worker notifications (os=%s worker=%s)", async (osCount, workerCount, cleared) => {
    const session = { instanceId: "synthetic", generation: 1, canView: true, canControl: true, inputRequired: false,
      startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", cwdLabel: "omp-push-synthetic" };
    let reads = 0, workerReads = 0;
    const driver = {
      browserSend: async (method: string) => method === "Target.getTargets" ? { targetInfos: [
        { type: "page", targetId: "page", url: identity.origin + "/" },
        { type: "service_worker", targetId: "worker", url: identity.origin + "/service-worker.js" },
      ] } : method === "Target.attachToTarget" ? { sessionId: "worker" } : {},
      sessionSend: async (_session: string, _method: string, params: { expression: string }) => {
        expect(params.expression).toContain('getNotifications({tag:"omp-attention-synthetic"})');
        expect(params.expression).not.toContain("requestId");
        workerReads++;
        return { result: { value: workerCount === 0 } };
      },
      attachTab: async () => {}, navigate: async () => {}, send: async () => ({}),
      evaluate: async (expression: string) => expression === "document.readyState" ? "complete" :
        expression.includes("href: location.href") ? { href: identity.origin + "/", secure: true } : true,
    };
    const spies = [
      spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ revision: 1, sessions: [session] }), { preconnect: globalThis.fetch.preconnect })),
      spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic"),
      spyOn(deviceOperations, "wakeAndroidDisplay").mockResolvedValue("Awake"),
      spyOn(webApkOperations, "requireWebApk").mockResolvedValue("org.chromium.webapk.synthetic"),
      spyOn(webApkOperations, "openWebApk").mockResolvedValue(undefined),
      spyOn(notificationOperations, "readAndroidNotificationRecords").mockImplementation(async () => ++reads === 1 || osCount === 0 ? [] : [{
        key: "synthetic", tag: "omp-attention-synthetic", postedAt: 1, seen: true, visibleSince: 1,
        title: "OMP session needs attention", body: "", text: "",
      }]),
      spyOn(deviceOperations, "withAndroidChrome").mockImplementation((async (run: (driver: unknown) => Promise<unknown>) => run(driver)) as typeof withAndroidChrome),
    ];
    try {
      const runtime = createAndroidPushRuntime(identity);
      runtime.beforeEffect = async () => {};
      await runtime.fleet.select(true);
      await runtime.beginNotificationPhase("synthetic", "fleet_private_verified");
      expect(await runtime.notificationCleared(session)).toBe(cleared);
      expect(workerReads).toBe(osCount === 0 ? 1 : 0);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

test.each(["idle", "blocked", "unavailable"] as const)("resumed fleet deselection accepts hidden Hosts with alerts %s", async state => {
  let toggleActions = 0, controlReads = 0;
  const driver = {
    browserSend: async () => ({ targetInfos: [{ type: "page", targetId: "page", url: identity.origin + "/" }] }),
    attachTab: async () => {}, navigate: async () => {},
    send: async () => { toggleActions++; return {}; },
    evaluate: async (expression: string) => {
      if (expression === "document.readyState") return "complete";
      if (expression.includes("href: location.href")) return { href: identity.origin + "/", secure: true };
      if (expression.includes(".notification-hosts")) {
        return Function("document", `return ${expression}`)({
          querySelector: (selector: string) => selector === ".notification-hosts" ? { hidden: true } : { dataset: { state } },
        });
      }
      if (expression.includes("input[role")) { controlReads++; throw new Error("hidden fleet controls were awaited"); }
      return true;
    },
  };
  const spies = [
    spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic"),
    spyOn(deviceOperations, "wakeAndroidDisplay").mockResolvedValue("Awake"),
    spyOn(webApkOperations, "requireWebApk").mockResolvedValue("org.chromium.webapk.synthetic"),
    spyOn(webApkOperations, "openWebApk").mockResolvedValue(undefined),
    spyOn(deviceOperations, "withAndroidChrome").mockImplementation((async (run: (driver: unknown) => Promise<unknown>) => run(driver)) as typeof withAndroidChrome),
  ];
  try {
    const runtime = createAndroidPushRuntime(identity); runtime.beforeEffect = async () => {};
    await runtime.fleet.select(false);
    expect(toggleActions).toBe(0); expect(controlReads).toBe(0);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test.each(["stable", "rotated"] as const)("fleet audit requires stable live Control material before scanning (%s)", async scenario => {
  const remote = { instanceId: "synthetic-remote", generation: 2, canView: true, canControl: true, inputRequired: false,
    startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", cwdLabel: "omp-push-remote" };
  let scans = 0, launches = 0, controls = 0, hostAudits = 0;
  const tapped = `https://synthetic.example.test/#synthetic-tapped.${"A".repeat(43)}`;
  const capabilities = [`https://synthetic.example.test/#synthetic-control.${"B".repeat(43)}`,
    `https://synthetic.example.test/#synthetic-control.${(scenario === "rotated" ? "C" : "B").repeat(43)}`];
  const storage = { get length() { scans++; return scenario === "rotated" ? 1 : 0; }, key: () => "synthetic-seed", getItem: () => tapped };
  const driver = {
    browserSend: async () => ({ targetInfos: [{ type: "page", targetId: "page", url: identity.origin + "/client/" }] }),
    attachTab: async () => {}, navigate: async () => {},
    evaluate: async (expression: string) => {
      if (expression === "document.readyState") return "complete";
      if (expression.includes("href: location.href")) return { href: identity.origin + "/client/", secure: true };
      if (expression.includes("fleet sink launch refused")) {
        expect(expression).toContain('mode:"control"');
        expect(expression).not.toContain('mode:"view"');
        expect(expression).toContain('"/api/v1/sessions/" + "synthetic-remote"');
        expect(expression).toContain("generation:2");
        return runInNewContext(expression, {
          fetch: async (_url: string, init: { body: string }) => {
            expect(JSON.parse(init.body)).toEqual({ generation: 2, mode: "control" });
            return Response.json({ capability: capabilities[launches++] });
          },
          localStorage: storage, sessionStorage: storage, document: { cookie: "", referrer: "", documentElement: { outerHTML: "" } },
          caches: { keys: async () => [] }, indexedDB: { databases: async () => [] },
          location: { href: identity.origin + "/client/", hash: "", search: "" }, history: { state: null },
          performance: { getEntriesByType: () => [] },
          navigator: { serviceWorker: { getRegistration: async () => ({ getNotifications: async () => [] }) } },
        });
      }
      return true;
    },
  };
  const spies = [
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ revision: 1, sessions: [remote] })),
    spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic"),
    spyOn(deviceOperations, "wakeAndroidDisplay").mockResolvedValue("Awake"),
    spyOn(webApkOperations, "requireWebApk").mockResolvedValue("org.chromium.webapk.synthetic"),
    spyOn(webApkOperations, "openWebApk").mockResolvedValue(undefined),
    spyOn(deviceOperations, "withAndroidChrome").mockImplementation((async (run: (driver: unknown) => Promise<unknown>) => run(driver)) as typeof withAndroidChrome),
  ];
  try {
    const runtime = createAndroidPushRuntime(identity); runtime.beforeEffect = async () => {};
    runtime.sinks = async () => { controls++; return { clean: true, detectable: true, sinks: 10, findings: 0 }; };
    runtime.fleet.host = async operation => { hostAudits++; expect(operation).toBe("audit"); };
    const result = await runtime.fleet.audit("synthetic").catch(error => error);
    expect(launches).toBe(2);
    if (scenario === "rotated") {
      expect(result).toBeInstanceOf(QualificationFailure);
      expect(result.evidence).toMatchObject({ lane: "androidPush", reason: "invalid_evidence", operation: "read_only" });
      expect(result.cause.message).toBe("fleet Control material changed for an unchanged session");
      expect(scans).toBe(0); expect(controls).toBe(0); expect(hostAudits).toBe(0);
      const evidence = JSON.stringify(privateQualificationFailureDiagnostic(result));
      for (const material of [tapped, ...capabilities]) expect(evidence).not.toContain(material);
    } else {
      expect(result).toMatchObject({ clean: true, detectable: true, findings: 0 });
      expect(scans).toBeGreaterThan(0); expect(controls).toBe(1); expect(hostAudits).toBe(1);
    }
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

test.each(["abort", "deadline"] as const)("502 runtime pause %s preserves typed delivery timeout evidence", async scenario => {
  const controller = new AbortController(), raw = new Error("synthetic runtime pause cancellation");
  let id = 40;
  const runtime = createAndroidPushRuntime(identity, { execution: { signal: controller.signal,
    deadline: performance.now() + (scenario === "deadline" ? 10 : 60_000), nextFailureId: () => ++id } });
  const pending = runtime.pause(60_000);
  if (scenario === "abort") controller.abort(raw);
  const error = await pending.catch(error => error);
  expect(error).toBeInstanceOf(QualificationFailure);
  expect(normalizeQualificationFailures(error)).toMatchObject([{
    id: 41, lane: "androidPush", step: "baseline_captured", class: "harness", reason: "delivery_timeout", operation: "read_only",
  }]);
  if (scenario === "abort") expect(error.cause).toBe(raw);
  else expect(error.cause).toBeInstanceOf(Error);
});

test("502 round2 pause re-arms a timer that fires before the fractional execution deadline", async () => {
  let time = 100, settled = false;
  const timers: { callback: () => void; delay: number }[] = [];
  const clock = spyOn(performance, "now").mockImplementation(() => time);
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    timers.push({ callback, delay }); return timers.length;
  }) as unknown as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  try {
    const runtime = createAndroidPushRuntime(identity, { execution: {
      signal: new AbortController().signal, deadline: 100.75, nextFailureId: () => 1,
    } });
    const pending = runtime.pause(10).catch(error => error);
    void pending.then(() => { settled = true; });
    time = 100.5; timers[0]!.callback();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    expect(timers).toHaveLength(2);
    expect(timers[1]!.delay).toBe(1);
    time = 101; timers[1]!.callback();
    expect(normalizeQualificationFailures(await pending)).toMatchObject([{ reason: "delivery_timeout", operation: "read_only" }]);
  } finally { clear.mockRestore(); timeout.mockRestore(); clock.mockRestore(); }
});

test.each(["remedy-abort", "remedy-deadline", "reconnect-abort", "reconnect-deadline"] as const)(
  "502 round2 GCM real pause preserves controller attribution during %s", async scenario => {
    const controller = new AbortController(), raw = new Error("synthetic GCM pause cancellation");
    let id = 0;
    const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => ++id };
    const select = spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic");
    const adb = spyOn(deviceOperations, "runAdb").mockResolvedValue("Is client connected: false\nReconnect Scheduler Alarm: OFF");
    try {
      const runtime = createAndroidPushRuntime(identity, { execution }), pause = runtime.pause;
      runtime.beforeEffect = async () => {};
      runtime.pause = milliseconds => {
        if (scenario.startsWith("reconnect") && milliseconds === 2_000) return Promise.resolve();
        if (scenario.endsWith("deadline")) execution.deadline = performance.now() + 2;
        const pending = pause(milliseconds);
        if (scenario.endsWith("abort")) controller.abort(raw);
        return pending;
      };
      const error = await runtime.gcmReadiness().catch(error => error);
      expect(normalizeQualificationFailures(error)).toMatchObject([{
        reason: "deadline_exceeded", operation: "unknown",
        observations: { controllerDeadline: true, gcmConnected: false, gcmRemedyApplied: true },
      }]);
      if (scenario.endsWith("abort")) expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(raw.message);
    } finally { adb.mockRestore(); select.mockRestore(); }
  });

test.each(["cellular", "browser"] as const)("502 review local %s timeout keeps its existing fallback attribution", async scenario => {
  let time = 0;
  const spies = [
    spyOn(performance, "now").mockImplementation(() => time),
    spyOn(Bun, "sleep").mockImplementation(async milliseconds => { time += typeof milliseconds === "number" ? milliseconds : 0; }),
    spyOn(deviceOperations, "requireSingleDevice").mockResolvedValue("synthetic"),
    spyOn(deviceOperations, "wakeAndroidDisplay").mockResolvedValue("Awake"),
    spyOn(deviceOperations, "restoreAndroidRadios").mockResolvedValue(undefined),
    spyOn(deviceOperations, "runAdb").mockResolvedValue("NetworkAgentInfo Transports: CELLULAR VALIDATED"),
    spyOn(webApkOperations, "requireWebApk").mockResolvedValue("org.chromium.webapk.synthetic"),
    spyOn(webApkOperations, "openWebApk").mockResolvedValue(undefined),
  ];
  const driver = {
    browserSend: async () => ({ targetInfos: scenario === "browser" ? [] : [{ type: "page", targetId: "synthetic", url: identity.origin + "/" }] }),
    attachTab: async () => {}, navigate: async () => {},
    evaluate: async (expression: string) => expression.includes("fetch(") ? false : expression === "document.readyState" ? "complete" :
      { href: identity.origin + "/", secure: true },
  };
  const chrome = spyOn(deviceOperations, "withAndroidChrome").mockImplementation(
    (async (run: (driver: unknown) => Promise<unknown>) => run(driver)) as typeof withAndroidChrome);
  try {
    const runtime = createAndroidPushRuntime(identity);
    runtime.beforeEffect = async () => {};
    if (scenario === "cellular") {
      expect(await runtime.network("cellular")).toBe(false);
      expect(time).toBeGreaterThanOrEqual(45_000);
    } else {
      const error = await runtime.browser().catch(error => error);
      expect(normalizeQualificationFailures(error)).toMatchObject([{
        lane: "androidPush", step: "browser_target", reason: "browser_baseline_failed",
      }]);
      expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain("Android Push WebAPK target unavailable");
    }
  } finally { chrome.mockRestore(); for (const spy of spies) spy.mockRestore(); }
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

test("fleet host commands use the retained executor and exact candidate identity", async () => {
  const calls: string[][] = [], epoch = "a3a77f8e-956b-45d0-a684-a33e6b336dc0";
  const runtime = createAndroidPushRuntime({ ...identity, candidate: { tag: "v0.9.1", sourceCommit: "c".repeat(40),
    archiveSha256: "d".repeat(64), archivePath: "/synthetic/candidate.tar" } }, {
    fixtureBase: "/synthetic/fixtures", fixtureScripts: "/synthetic/scripts", fixtureBun: "/synthetic/bun",
    execute: async argv => { calls.push([...argv]); return { exitCode: 0, stdout: "" }; },
  });
  let checkpoints = 0;
  runtime.beforeEffect = async () => { checkpoints++; };
  await runtime.fleet.host("source-down", epoch);
  expect(checkpoints).toBe(1);
  expect(calls).toEqual([["/synthetic/bun", "/synthetic/scripts/fleet-push-fixture.ts", "source-down",
    `/synthetic/fixtures/fleet-${epoch}`, epoch, identity.origin, "c".repeat(40)]]);
});

test("fixture transport keeps guest script paths POSIX independently of the runner", async () => {
  const calls: string[][] = [];
  await commandPushFixture({ root: "/synthetic/fixture", epoch: "synthetic", bun: "/synthetic/bun",
    binary: "/synthetic/omp", scripts: "/synthetic/scripts" }, "ask",
  async argv => { calls.push([...argv]); return { exitCode: 0, stdout: "" }; }, true);
  expect(calls).toEqual([["/synthetic/bun", "/synthetic/scripts/push-qualification-fixture.ts", "ask",
    "/synthetic/fixture", "synthetic", "/synthetic/omp", "/synthetic/scripts", "guard-session"]]);
});

test.each(["primary", "secondary", "remote"] as const)("retained %s fixture roots and remote environment remain POSIX", async role => {
  const calls: string[][] = [], epoch = "a3a77f8e-956b-45d0-a684-a33e6b336dc0";
  const runtime = createAndroidPushRuntime(identity, { fixtureBase: "/synthetic/fixtures", fixtureScripts: "/synthetic/scripts",
    fixtureBun: "/synthetic/bun", fixtureBinary: "/synthetic/omp",
    execute: async argv => { calls.push([...argv]); return { exitCode: 0, stdout: "" }; },
  });
  runtime.beforeEffect = async () => {};
  await runtime.fixture("answer", epoch, role);
  const fleet = `/synthetic/fixtures/fleet-${epoch}`;
  const root = role === "remote" ? `${fleet}/omp-push-remote` : `/synthetic/fixtures/${role === "primary" ? "omp-push" : "omp-push-b"}-${epoch}`;
  expect(calls).toEqual([[
    ...(role === "remote" ? ["env", `HOME=${fleet}/home`, `XDG_CONFIG_HOME=${fleet}/home/.config`, `XDG_STATE_HOME=${fleet}/home/.local/state`] : []),
    "/synthetic/bun", "/synthetic/scripts/push-qualification-fixture.ts", "answer", root, epoch, "/synthetic/omp", "/synthetic/scripts",
  ]]);
});

test("cross-origin tap counts its launch, not its CORS admission, and still detects duplicate launches", () => {
  const url = "https://synthetic.example.test:10443/api/v1/sessions/synthetic/launch";
  const observe = (methods: unknown[]) => methods.map(method => pushLaunchRequestKind(url, method));
  expect(observe(["OPTIONS", "POST"])).toEqual(["preflight", "launch"]);
  expect(observe(["OPTIONS", "POST", "POST"]).filter(kind => kind === "launch")).toHaveLength(2);
  // No broader method/source filter can hide a malformed or wrong-host launch attempt.
  for (const method of ["GET", "PUT", undefined]) expect(pushLaunchRequestKind(url, method)).toBe("launch");
  expect(pushLaunchRequestKind("https://foreign.example.test/api/v1/sessions/other/launch", "POST")).toBe("launch");
  expect(pushLaunchRequestKind("https://synthetic.example.test/api/v1/sessions", "GET")).toBeUndefined();
});

test("fleet cleanup before persisted ownership never touches enrollment or a worker", async () => {
  const commands: string[][] = [];
  const runtime = createAndroidPushRuntime(identity, { fixtureBase: "/synthetic/fixtures",
    execute: async argv => { commands.push([...argv]); return { exitCode: 1, stdout: "" }; } });
  const calls: string[] = [];
  runtime.fleet.host = async operation => { calls.push(operation); };
  runtime.fleet.select = async () => { throw new Error("unowned enrollment touched"); };
  const progress = { epoch: "a3a77f8e-956b-45d0-a684-a33e6b336dc0", fleetPrepared: true } as AndroidPushProgress;
  await runtime.cleanup("fleet", progress);
  expect(calls).toEqual(["restore"]);
  expect(commands).toEqual([["test", "-f", `/synthetic/fixtures/fleet-${progress.epoch}/owner.json`]]);
  expect(progress.fleetPrepared).toBe(false);
});

test("fleet unpatch failure and retry retain host ownership until worker restoration is proven", async () => {
  const events: string[] = [], progress = { epoch: "a3a77f8e-956b-45d0-a684-a33e6b336dc0", fleetPrepared: true } as AndroidPushProgress;
  let owner = true, restored = false;
  const driver = {
    browserSend: async (method: string) => {
      if (method === "Target.detachFromTarget") events.push("observer-close");
      return method === "Target.getTargets" ? { targetInfos: [{ type: "service_worker", targetId: "worker", url: identity.origin + "/service-worker.js" }] } :
        method === "Target.attachToTarget" ? { sessionId: "worker" } : {};
    },
    sessionSend: async (_session: string, _method: string, params: { expression: string }) => {
      if (params.expression.includes("delete self.__ompQualificationBadge")) {
        events.push("unpatch");
        return { result: { value: restored } };
      }
      return { result: { value: true } };
    },
  };
  const chrome = spyOn(deviceOperations, "withAndroidChrome").mockImplementation(
    (async (run: (driver: unknown) => Promise<unknown>) => run(driver)) as typeof withAndroidChrome);
  try {
    const runtime = createAndroidPushRuntime(identity, { execute: async () => ({ exitCode: owner ? 0 : 1, stdout: "" }) });
    runtime.beforeEffect = async () => {};
    runtime.fixture = async () => {};
    runtime.fleet.select = async () => {};
    runtime.fleet.host = async operation => { if (operation === "restore") { events.push("host-restore"); owner = false; } };
    await runtime.fleet.armBadgeObserver();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(runtime.cleanup("fleet", progress)).rejects.toThrow("restoration failed");
      expect(owner).toBe(true); expect(progress.fleetPrepared).toBe(true);
      expect(events).not.toContain("host-restore");
    }
    expect(events.slice(0, 2)).toEqual(["unpatch", "observer-close"]);
    restored = true;
    await runtime.cleanup("fleet", progress);
    expect(owner).toBe(false); expect(progress.fleetPrepared).toBe(false);
    expect(events.indexOf("host-restore")).toBeGreaterThan(events.lastIndexOf("unpatch"));
  } finally { chrome.mockRestore(); }
});

test.each(["recovered", "exhausted", "product", "cleanup"] as const)("unheld worker connection %s remains bounded and cold", async scenario => {
  let calls = 0;
  const retained: unknown[] = [];
  const transport = new AndroidDevtoolsConnectionError("endpoint_timeout", "synthetic endpoint timeout",
    { cause: new Error("exact lower transport error") });
  const product = new Error("fleet worker observation failed");
  const driver = {
    browserSend: async (method: string) => method === "Target.getTargets" ?
      { targetInfos: [{ type: "service_worker", targetId: "synthetic", url: `${identity.origin}/service-worker.js` }] } :
      method === "Target.attachToTarget" ? { sessionId: "synthetic-worker" } : {},
    sessionSend: async () => ({ result: { value: { count: 2, complete: true } } }),
  };
  const chrome = spyOn(deviceOperations, "withAndroidChrome").mockImplementation(
    (async (run: (driver: unknown) => Promise<unknown>, options: { launchBrowser?: boolean }) => {
      calls++; expect(options.launchBrowser).toBe(false);
      if (scenario === "cleanup") throw new AndroidBrowserCleanupError([transport], 1);
      if (scenario === "product") throw product;
      if (scenario === "exhausted" || scenario === "recovered" && calls === 1) throw transport;
      return run(driver);
    }) as typeof withAndroidChrome);
  try {
    const runtime = createAndroidPushRuntime(identity, { browserFailure: async (_step, error) => { retained.push(error); } });
    runtime.beforeEffect = async () => {};
    if (scenario === "recovered") expect(await runtime.fleet.observeBadge()).toEqual({ count: 2, complete: true });
    else {
      const failure = await runtime.fleet.observeBadge().catch(error => error);
      if (scenario === "product") expect(failure).toBe(product);
      else if (scenario === "exhausted") {
        expect(failure).toBeInstanceOf(QualificationFailure);
        expect(failure.evidence).toMatchObject({ lane: "androidPush", reason: "invalid_evidence",
          observations: { transportFailure: true, attempts: 2 } });
        expect(failure.cause.errors[0]).toBe(transport);
      } else expect(failure.pixelUnrestored).toBe(true);
    }
    expect(calls).toBe(["recovered", "exhausted"].includes(scenario) ? 2 : 1);
    expect(retained.length).toBe(["recovered", "exhausted"].includes(scenario) ? 1 : 0);
  } finally { chrome.mockRestore(); }
});

test("fleet host restore retains the helper exception privately and types containment", async () => {
  const message = "fleet grants or recipients remain enrolled", stack = `Error: ${message}\n    at fleetPushFixture (synthetic.ts:200:17)`;
  const runtime = createAndroidPushRuntime({ ...identity, candidate: { tag: "v0.9.1", sourceCommit: "c".repeat(40),
    archiveSha256: "d".repeat(64), archivePath: "/synthetic/candidate.tar" } }, {
    execute: async () => ({ exitCode: 1, stdout: JSON.stringify({ completed: false, diagnostic: [{ message, stack }] }) }),
  });
  runtime.beforeEffect = async () => {};
  const failure = await runtime.fleet.host("restore", "synthetic").catch(error => error);
  expect(failure.evidence).toMatchObject({ lane: "androidPushCleanup", step: "fleet", reason: "containment_unproven",
    operation: "unknown", observations: { exitCode: 1, cleanupVerified: false } });
  expect(failure.cause.errors[0].message).toBe(message);
  expect(failure.cause.errors[0].stack).toBe(stack);
  expect(JSON.stringify(failure)).not.toContain(message);
});

test.each(["none", "enrollment", "owner", "host", "connection", "mutation"] as const)("fleet badge observer releases on %s failure", async failure => {
  const fail = failure !== "none";
  const calls: string[] = [], platformCalls: unknown[][] = [];
  const set = (...args: unknown[]) => { platformCalls.push(args); return Promise.resolve(); };
  const clear = () => { platformCalls.push(["clear"]); return Promise.resolve(); };
  const navigator = (fail ? Object.create({ setAppBadge: set, clearAppBadge: clear }) :
    { setAppBadge: set, clearAppBadge: clear }) as { setAppBadge: typeof set; clearAppBadge: typeof clear };
  const context = { navigator, self: {} as Record<string, unknown> };
  let admissions = 0, detached = 0, closed = 0, broken = false;
  const transport = new AndroidDevtoolsConnectionError("websocket_closed", "synthetic observer disconnected");
  const driver = {
    browserSend: async (method: string) => { if (method === "Target.detachFromTarget") detached++; return method === "Target.getTargets" ?
      { targetInfos: [{ type: "service_worker", targetId: "synthetic", url: `${identity.origin}/service-worker.js` }] } :
      method === "Target.attachToTarget" ? { sessionId: "synthetic-worker" } : {}; },
    sessionSend: async (_session: string, _method: string, parameters: { expression: string }) => {
      if (broken) throw transport;
      return { result: { value: await runInNewContext(parameters.expression, context) } };
    },
  };
  const chrome = spyOn(deviceOperations, "withAndroidChrome").mockImplementation(
    (async (run: (driver: unknown) => Promise<unknown>, options: { port: number; launchBrowser: boolean }) => {
      admissions++; expect(options.port).toBe(9237); expect(options.launchBrowser).toBe(false);
      try { return await run(driver); } finally { closed++; }
    }) as typeof withAndroidChrome);
  try {
    const runtime = createAndroidPushRuntime(identity, { execute: async () => {
      if (failure === "owner") throw new Error("synthetic owner read failure");
      return { exitCode: 0, stdout: "" };
    } });
    runtime.beforeEffect = async () => {};
    runtime.fleet.host = async operation => { calls.push(operation); if (failure === "host" && operation === "restore") throw new Error("synthetic host restore failure"); };
    runtime.fleet.select = async () => { if (failure === "enrollment") throw new Error("synthetic enrollment restoration failure"); };
    runtime.fixture = async operation => { calls.push(`remote-${operation}`); };
    await runtime.fleet.armBadgeObserver();
    await context.navigator.setAppBadge(2);
    expect(await runtime.fleet.observeBadge()).toEqual({ count: 2, complete: true,
      call: { method: "setAppBadge", arguments: 1, argument: 2 } });
    await context.navigator.setAppBadge();
    expect(await runtime.fleet.observeBadge()).toEqual({ count: 0, complete: false,
      call: { method: "setAppBadge", arguments: 0, argument: "undefined" } });
    await context.navigator.setAppBadge(undefined);
    expect(await runtime.fleet.observeBadge()).toEqual({ count: 0, complete: false,
      call: { method: "setAppBadge", arguments: 1, argument: "undefined" } });
    await context.navigator.clearAppBadge();
    expect(await runtime.fleet.observeBadge()).toEqual({ count: 0, complete: true,
      call: { method: "clearAppBadge", arguments: 0 } });
    expect(platformCalls).toEqual([[2], [], [undefined], ["clear"]]);
    await runtime.fleet.armBadgeObserver();
    expect(admissions).toBe(1); expect(detached).toBe(0); expect(closed).toBe(0);
    if (failure === "connection" || failure === "mutation") {
      broken = true;
      const lost = await (failure === "mutation" ? runtime.fleet.armBadgeObserver() : runtime.fleet.observeBadge()).catch(error => error);
      expect(lost.evidence).toMatchObject({ lane: "androidPush", reason: "invalid_evidence", observations: { transportFailure: true, attempts: 1 } });
      expect(admissions).toBe(1);
    }
    const progress = { epoch: "a3a77f8e-956b-45d0-a684-a33e6b336dc0", fleetPrepared: true } as AndroidPushProgress;
    if (fail) await expect(runtime.cleanup("fleet", progress)).rejects.toThrow();
    else await runtime.cleanup("fleet", progress);
    expect(calls).toEqual(failure === "owner" ? [] : ["connection", "mutation"].includes(failure) ?
      ["coordinator-up", "remote-stop"] : ["coordinator-up", "remote-stop", "restore"]);
    if (!["owner", "connection", "mutation"].includes(failure)) {
      expect(context.navigator.setAppBadge).toBe(set);
      expect(context.navigator.clearAppBadge).toBe(clear);
      expect(Object.hasOwn(context.navigator, "setAppBadge")).toBe(!fail);
      expect(Object.hasOwn(context.navigator, "clearAppBadge")).toBe(!fail);
      expect(context.self.__ompQualificationBadge).toBeUndefined();
    }
    expect(detached).toBe(1); expect(closed).toBe(1); expect(admissions).toBe(1);
    expect(progress.fleetPrepared).toBe(fail);
  } finally { chrome.mockRestore(); }
});

test("held worker admission cancellation releases the connection without creating a page", async () => {
  const controller = new AbortController(), cancelled = new Error("synthetic observer cancellation"), methods: string[] = [];
  let closes = 0;
  const connect = (async (run: (driver: unknown) => Promise<unknown>) => {
    try { return await run({
      browserSend: async (method: string) => {
        methods.push(method);
        return method === "Target.getTargets" ? { targetInfos: [{ type: "service_worker", targetId: "synthetic", url: identity.origin + "/service-worker.js" }] } :
          method === "Target.attachToTarget" ? { sessionId: "synthetic" } : {};
      },
    }); } finally { closes++; }
  }) as typeof withAndroidChrome;
  const observer = await holdPushWorkerObserver(identity.origin, { signal: controller.signal, deadline: performance.now() + 60_000 }, connect);
  controller.abort(cancelled);
  await expect(observer.close()).rejects.toBe(cancelled);
  expect(methods).toEqual(["Target.getTargets", "Target.attachToTarget", "Target.detachFromTarget"]);
  expect(closes).toBe(1);
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
