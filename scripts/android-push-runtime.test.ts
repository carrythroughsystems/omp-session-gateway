import { expect, spyOn, test } from "bun:test";
import { runAdb, withAndroidChrome, type AndroidAdbSpawner } from "./android-device.ts";
import { createAndroidPushRuntime, observePushDeliveryRequest } from "./android-push-runtime.ts";
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

for (const scenario of ["abort-attach", "deadline-open"] as const) test(`R3/R4 CDP cleans owned targets and settles ${scenario}`, async () => {
  const controller = new AbortController(), calls: string[] = [];
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new TextEncoder().encode(text)); value.close(); } });
  const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => ({
    stdout: stream(argv.includes("devices") ? "List of devices attached\nsynthetic device\n" : argv.includes("package") ? "versionName=153.0.0.0" : ""),
    stderr: stream(""), exited: Promise.resolve(0), kill() {},
  })) as typeof Bun.spawn);
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    "Android-Package": "com.android.chrome", Browser: "Chrome/153.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1:9238/devtools/browser/synthetic",
  })));
  const realSocket = globalThis.WebSocket;
  class Socket {
    onmessage?: (event: { data: string }) => void; onopen?: () => void; onerror?: () => void;
    constructor() { if (scenario !== "deadline-open") queueMicrotask(() => this.onopen?.()); }
    close() { calls.push("socket.close"); }
    send(frame: string) {
      const message = JSON.parse(frame); calls.push(message.method);
      if (message.method === "Target.attachToTarget") { controller.abort(); return; }
      const result = message.method === "Browser.getVersion" ? { product: "Chrome/153.0.0.0" } :
        message.method === "Target.createTarget" ? { targetId: "owned-tab" } : {};
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }));
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const started = performance.now();
  try {
    await expect(withAndroidChrome(driver => driver.openTab(), { port: 9238, launchBrowser: false,
      execution: { signal: controller.signal, deadline: started + 100 } })).rejects.toThrow();
    if (scenario === "abort-attach") expect(calls).toContain("Target.closeTarget");
    else expect(performance.now() - started).toBeLessThan(1_000);
  } finally { globalThis.WebSocket = realSocket; fetchMock.mockRestore(); spawn.mockRestore(); }
}, 12_000);
