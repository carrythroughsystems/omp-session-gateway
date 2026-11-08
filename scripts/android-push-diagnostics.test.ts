import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { fleetAttentionDiagnostics } from "./android-push-runtime.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";

const session: SessionMetadata = { instanceId: "synthetic-instance", generation: 1, canView: true, canControl: true,
  inputRequired: true, startedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z",
  ask: { requestId: "synthetic-request", since: "2026-01-01T00:00:00.000Z" } };
const at = Date.parse(session.ask!.since), tag = "omp-attention-synthetic-instance", pkg = "org.chromium.webapk.synthetic";
const record = (packageName: string, suffix = tag, flags = "0x10") => `
  NotificationRecord(synthetic pkg=${packageName} tag=prefix:${suffix} Notification(flags=${flags} groupKey=synthetic-private))
    key=synthetic-private-key
    mUpdateTimeMs=${at + 250}
    android.title=String (SYNTHETIC_PRIVATE_TITLE)
`;
const seconds = at / 1000;
const rateLog = (limited: boolean) => [
  "--------- beginning of system",
  ...(limited ? [
    `${seconds - 30}.500  1000  1200 E NotificationService: Package enqueue rate is 7.5. Shedding 0|${pkg}|1|SYNTHETIC_PRIVATE_KEY|1. package=${pkg}`,
    `${seconds - 10}.250  1000  1200 E NotificationService: Package has already posted or enqueued 50 notifications.  Not showing more.  package=com.android.chrome`,
    `${seconds - 5}.000  1000  1200 E NotificationService: Package enqueue rate is 9.0. Shedding SYNTHETIC_PRIVATE_KEY. package=${pkg}.foreign`,
  ] : []),
  `${seconds}.000  1000  1200 I NotificationService: SYNTHETIC_PRIVATE_UNRELATED package=${pkg}`,
  `DEVICE_EPOCH:${seconds}`,
].join("\n");

test.each(["chrome", "webapk", "summary", "both", "absent", "tombstoned", "no-database", "database-error", "worker-error", "reads-error", "wrong-identity", "rate-limited"] as const)(
  "fleet attention diagnostics remain read-only and closed (%s)", async scenario => {
    let opens = 0, closes = 0, evaluations = 0;
    const calls: string[][] = [];
    const shown = scenario === "absent" ? {} : { [`local\0${session.instanceId}\0${session.ask!.requestId}`]: at + 200 };
    const state = { epoch: 2, shown, tombstones: scenario === "tombstoned" ? { [`local\0${session.instanceId}\0${session.ask!.requestId}`]: at } : {},
      marks: { [`local\0${session.instanceId}`]: 7 }, received: 9, touched: { [`local\0${session.instanceId}`]: 8 } };
    const indexedDB = {
      databases: async () => scenario === "no-database" ? [] : [{ name: "omp-notification-ordering" }],
      open: (name: string) => {
        opens++; expect(name).toBe("omp-notification-ordering");
        const request = { onsuccess: () => {}, onerror: () => {}, result: {
          close: () => { closes++; },
          transaction: (store: string, mode: string) => {
            expect([store, mode]).toEqual(["state", "readonly"]);
            const transaction = { oncomplete: () => {}, objectStore: (name: string) => {
              expect(name).toBe("state");
              return { get: (key: string) => { expect(key).toBe("worker"); return { result: state }; } };
            } };
            queueMicrotask(() => transaction.oncomplete()); return transaction;
          },
        } };
        queueMicrotask(() => scenario === "database-error" ? request.onerror() : request.onsuccess()); return request;
      },
    };
    const result = await fleetAttentionDiagnostics({ packageName: pkg, tag, session, counter: { epoch: 2, n: 6 },
      command: async (...args) => {
        calls.push(args);
        if (scenario === "reads-error") throw new Error("SYNTHETIC_PRIVATE_ADB");
        if (args[2] === "notification") return "Notification List:" +
          (["webapk", "both"].includes(scenario) ? record(pkg) : "") +
          (["chrome", "summary", "both"].includes(scenario) ? record("com.android.chrome", tag, scenario === "summary" ? "0x210" : "0x10") : "") +
          record("com.android.chrome", "omp-attention-foreign-synthetic") + "\nRanking Config:";
        if (args[1]?.startsWith("logcat ")) return rateLog(scenario === "rate-limited");
        return `\n *APP* ProcessRecord{synthetic 1:${pkg}/u0a1}\n isFrozen=true\n *APP* ProcessRecord{synthetic 2:com.android.chrome/u0a2}\n cached=true isFrozen=false\n *APP* ProcessRecord{synthetic 3:${pkg}.foreign/u0a3}\n isFrozen=false`;
      },
      evaluate: async <T>(expression: string): Promise<T> => {
        evaluations++;
        expect(calls).toHaveLength(3); // Freezer sampled before worker evaluation.
        if (scenario === "worker-error") throw new Error("SYNTHETIC_PRIVATE_WORKER");
        const notices = scenario === "absent" ? [] : [{ data: { version: 3, type: "attention", instanceId: session.instanceId,
          requestId: scenario === "wrong-identity" ? "synthetic-foreign" : session.ask!.requestId } }];
        return runInNewContext(expression, { Promise, indexedDB, self: { registration: {
          getNotifications: async (options: unknown) => { expect(options).toEqual({ tag }); return notices; },
        } } });
      },
    });
    expect(evaluations).toBe(1); // Includes OS absence and read failures.
    expect(calls).toEqual([["exec-out", "dumpsys", "notification", "--noredact"],
      ["shell", "logcat -d -b system -v epoch -s NotificationService; echo DEVICE_EPOCH:$(date +%s)"], ["shell", "dumpsys", "activity", "processes"]]);
    expect(Object.values(result).every(value => typeof value === "boolean" || typeof value === "number")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/synthetic|SYNTHETIC_PRIVATE/u);
    expect(result.workerReadFailed).toBe(scenario === "worker-error");
    expect(result.identityMatches).toBe(!["absent", "worker-error", "wrong-identity"].includes(scenario));
    expect(result.durableReadFailed).toBe(["worker-error", "database-error"].includes(scenario));
    expect(result.tombstoned).toBe(scenario === "tombstoned");
    expect(result.markAtOrAbove).toBe(!["worker-error", "database-error", "no-database"].includes(scenario));
    expect(result.webApkCount).toBe(scenario === "reads-error" ? -1 : ["webapk", "both"].includes(scenario) ? 1 : 0);
    expect(result.chromeCount).toBe(scenario === "reads-error" ? -1 : ["chrome", "summary", "both"].includes(scenario) ? 1 : 0);
    expect(result.chromeGroupSummary).toBe(scenario === "summary");
    expect(result.chromeGroupChild).toBe(["chrome", "both"].includes(scenario));
    expect(result.webApkFrozen).toBe(scenario !== "reads-error"); expect(result.chromeFrozen).toBe(false);
    expect(result.chromeCached).toBe(scenario !== "reads-error"); expect(result.webApkCached).toBe(false);
    expect(result.webApkRateLimited).toBe(scenario === "reads-error" ? -1 : scenario === "rate-limited" ? 1 : 0);
    expect(result.chromeRateLimited).toBe(scenario === "reads-error" ? -1 : scenario === "rate-limited" ? 1 : 0);
    expect(result.rateLimitAgeMs).toBe(scenario === "rate-limited" ? 9_750 : -1);
    expect(result.rateReadFailed).toBe(scenario === "reads-error");
    expect(result.received).toBe(["worker-error", "database-error", "no-database"].includes(scenario) ? -1 : 9);
    expect(result.sessionTouched).toBe(["worker-error", "database-error", "no-database"].includes(scenario) ? -1 : 8);
    for (const read of ["os", "rate", "process", "worker"]) expect(result[`${read}ReadTimedOut`]).toBe(false);
    if (scenario === "chrome") expect(result).toMatchObject({ chromeAttentionTotal: 2, chromePostAskDeltaMs: 250, chromePostShownDeltaMs: 50 });
    expect(result.pushTimeKnown).toBe(false); expect(result.chromePostPushDeltaMs).toBe(-1);
    expect(opens).toBe(["worker-error", "no-database"].includes(scenario) ? 0 : 1);
    expect(closes).toBe(["worker-error", "no-database", "database-error"].includes(scenario) ? 0 : 1);
  });

test("missing worker and unknown message counter are not negative durable evidence", async () => {
  const result = await fleetAttentionDiagnostics({ packageName: pkg, tag, session,
    command: async () => { throw new Error("unavailable"); } });
  expect(result).toMatchObject({ workerReadFailed: true, durableReadFailed: true, counterKnown: false, markAtOrAbove: false,
    osReadFailed: true, processReadFailed: true, webApkCount: -1, chromeCount: -1 });
});

test("a stalled read settles within its bound as unknown, without waiting for the device or worker", async () => {
  const never = <T>() => Promise.withResolvers<T>().promise;
  const started = performance.now();
  const result = await fleetAttentionDiagnostics({ packageName: pkg, tag, session, boundMs: 20,
    command: async (...args) => args[2] === "notification" ? never<string>() : "", evaluate: never });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(result).toMatchObject({ osReadTimedOut: true, osReadFailed: true, webApkCount: -1, chromeCount: -1,
    rateReadTimedOut: false, rateReadFailed: false, webApkRateLimited: 0, processReadTimedOut: false, processReadFailed: false,
    workerReadTimedOut: true, workerReadFailed: true, durableReadFailed: true, workerCount: -1, identityMatches: false });
});
