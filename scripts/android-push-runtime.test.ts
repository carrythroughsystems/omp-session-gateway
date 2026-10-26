import { expect, spyOn, test } from "bun:test";
import { runAdb, unlockAndroidKeyguard, withAndroidChrome, type AndroidAdbSpawner } from "./android-device.ts";
import { createAndroidPushRuntime, holdAndroidNotificationDenial, observePushDeliveryRequest, qualificationPushAliasFor } from "./android-push-runtime.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import { checkProviderReads } from "./check-repository.ts";
const identity = { origin: "https://synthetic.example.test", omp: { version: "18.3.0", bunVersion: "1.4.0", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), nativeTarballSha256: "c".repeat(64), nativeBinarySha256: "d".repeat(64) } };

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
  })) as typeof Bun.spawn);
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
  })) as typeof Bun.spawn);
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

for (const scenario of ["abort-attach", "deadline-open", "abort-create", "close-refused", "forward-cancel", "constructor-throws"] as const) test(`R2 CDP cleanup retains ownership through ${scenario}`, async () => {
  const controller = new AbortController(), calls: string[] = [];
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new TextEncoder().encode(text)); value.close(); } });
  const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
    if (argv.includes("forward")) calls.push(argv.includes("--remove") ? "forward.remove" : "forward.acquire");
    if (scenario === "forward-cancel" && argv.includes("forward") && !argv.includes("--remove")) controller.abort();
    return {
    stdout: stream(argv.includes("devices") ? "List of devices attached\nsynthetic device\n" : argv.includes("package") ? "versionName=153.0.0.0" : ""),
    stderr: stream(""), exited: Promise.resolve(0), kill() {},
  }; }) as typeof Bun.spawn);
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    "Android-Package": "com.android.chrome", Browser: "Chrome/153.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1:9238/devtools/browser/synthetic",
  })));
  const realSocket = globalThis.WebSocket;
  class Socket {
    onmessage?: (event: { data: string }) => void; onopen?: () => void; onerror?: () => void;
    constructor() {
      if (scenario === "constructor-throws") throw new Error("synthetic socket construction failure");
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
      const result = message.method === "Browser.getVersion" ? { product: "Chrome/153.0.0.0" } :
        message.method === "Target.createTarget" ? { targetId: "owned-tab" } :
        message.method === "Target.closeTarget" ? { success: scenario !== "close-refused" || calls.filter(call => call === "Target.closeTarget").length > 1 } : {};
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }));
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const started = performance.now();
  try {
    await expect(withAndroidChrome(async driver => { await driver.openTab(); await driver.closeTab(); throw new Error("synthetic completion"); }, { port: 9238, launchBrowser: false,
      execution: { signal: controller.signal, deadline: started + 100 } })).rejects.toThrow();
    if (scenario === "abort-attach" || scenario === "abort-create") expect(calls).toContain("Target.closeTarget");
    if (scenario === "close-refused") expect(calls.filter(call => call === "Target.closeTarget")).toHaveLength(2);
    expect(calls).toContain("forward.remove");
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally { globalThis.WebSocket = realSocket; fetchMock.mockRestore(); spawn.mockRestore(); }
}, 12_000);
