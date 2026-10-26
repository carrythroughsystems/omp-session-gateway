import { expect, spyOn, test } from "bun:test";
import * as deviceOperations from "./android-device.ts";
import * as webApkOperations from "./android-webapk.ts";
import { AndroidBrowserCleanupError, runAdb, unlockAndroidKeyguard, withAndroidChrome, type AndroidAdbSpawner } from "./android-device.ts";
import { createAndroidPushRuntime, holdAndroidNotificationDenial, observePushDeliveryRequest, qualificationPushAliasFor, pushBrowserCleanupFailure } from "./android-push-runtime.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import { checkProviderReads } from "./check-repository.ts";
import type { AndroidPushProgress, PushDeviceBaseline } from "./android-push-qualification.ts";
import { normalizeQualificationFailures, parseLaneFailures, qualificationRetryEligible } from "./qualification-failure.ts";
import { notificationTopicDigest } from "./android-notification.ts";
const identity = { origin: "https://synthetic.example.test", omp: { version: "18.3.0", bunVersion: "1.4.0", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), nativeTarballSha256: "c".repeat(64), nativeBinarySha256: "d".repeat(64) } };

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
