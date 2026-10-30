import { expect, test } from "bun:test";
import { confirmAbsence, readProvider } from "./provider-read.ts";

const replies = (statuses: readonly number[]) => {
  const queue = [...statuses];
  let reads = 0;
  return {
    read: async () => { reads += 1; return new Response(null, { status: queue.shift() ?? 599 }); },
    reads: () => reads,
  };
};

test("a provider read survives a transient 5xx with bounded backoff", async () => {
  const provider = replies([502, 503, 200]);
  const delays: number[] = [];
  const response = await readProvider(provider.read, { sleep: async milliseconds => void delays.push(milliseconds) });
  expect(response.status).toBe(200);
  expect(provider.reads()).toBe(3);
  expect(delays).toEqual([2_000, 4_000]);
});

test("a persistent 5xx reaches the caller after five reads spanning half a minute, without a final sleep", async () => {
  const provider = replies([502, 502, 502, 502, 502, 200]);
  const delays: number[] = [];
  const response = await readProvider(provider.read, { sleep: async milliseconds => void delays.push(milliseconds) });
  expect(response.status).toBe(502);
  expect(provider.reads()).toBe(5);
  expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
});

test("a client error or a missing object is final at once", async () => {
  for (const status of [404, 401, 429]) {
    const provider = replies([status, 200]);
    const delays: number[] = [];
    expect((await readProvider(provider.read, { sleep: async milliseconds => void delays.push(milliseconds) })).status).toBe(status);
    expect([provider.reads(), delays.length]).toEqual([1, 0]);
  }
});

test("an owned resource is absent only when a second read agrees", async () => {
  const delays: number[] = [];
  const sleep = async (milliseconds: number) => void delays.push(milliseconds);
  const flicker: Array<string | undefined> = [undefined, "owned"];
  expect(await confirmAbsence(async () => flicker.shift(), { sleep })).toBe("owned");
  const gone: Array<string | undefined> = [undefined, undefined, "never read"];
  expect(await confirmAbsence(async () => gone.shift(), { sleep })).toBeUndefined();
  expect(gone).toEqual(["never read"]);
  const present = ["owned"];
  expect(await confirmAbsence(async () => present.shift(), { sleep })).toBe("owned");
  expect(delays).toEqual([5_000, 5_000]);
});

test("transient network errors retry and recover within the shared HTTP budget", async () => {
  for (const error of [
    new TypeError("fetch failed"),
    Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" }),
    Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }),
    new TypeError("fetch failed", { cause: Object.assign(new Error("synthetic DNS failure"), { code: "ENOTFOUND" }) }),
    new DOMException("synthetic deadline", "TimeoutError"),
  ]) {
    let reads = 0;
    const delays: number[] = [];
    const response = await readProvider(async () => {
      reads += 1;
      if (reads === 1) throw error;
      return new Response(null, { status: reads === 2 ? 503 : 200 });
    }, { sleep: async ms => void delays.push(ms) });
    expect(response.status).toBe(200);
    expect(reads).toBe(3);
    expect(delays).toEqual([2_000, 4_000]);
  }
});

test("persistent network failure surfaces the last error after exactly five attempts", async () => {
  let reads = 0;
  const delays: number[] = [];
  const errors = Array.from({ length: 5 }, () => new TypeError("fetch failed"));
  await expect(readProvider(async () => { throw errors[reads++]; }, {
    sleep: async ms => void delays.push(ms),
  })).rejects.toBe(errors[4]);
  expect(reads).toBe(5);
  expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
});

test("programming errors, invalid fetch input and caller cancellation are not retried", async () => {
  for (const error of [new Error("bug"), new TypeError("Cannot read properties of undefined"), new TypeError("Invalid URL"), new DOMException("cancelled", "AbortError")]) {
    let reads = 0;
    const delays: number[] = [];
    await expect(readProvider(async () => { reads += 1; throw error; }, {
      sleep: async ms => void delays.push(ms),
    })).rejects.toBe(error);
    expect(reads).toBe(1);
    expect(delays).toEqual([]);
  }
});

test("caller cancellation aborts an owned read and awaits its termination without replay", async () => {
  const controller = new AbortController();
  let calls = 0, settled = false;
  const result = readProvider(async signal => {
    calls += 1;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    await Bun.sleep(5);
    settled = true;
    throw signal.reason;
  }, { signal: controller.signal });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await expect(result).rejects.toThrow("cancelled");
  expect(settled).toBe(true);
  expect(calls).toBe(1);
});

test("cancellation during backoff prevents another provider read", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = readProvider(async () => {
    calls += 1;
    return new Response(null, { status: 503 });
  }, { signal: controller.signal });
  await Bun.sleep(5);
  controller.abort();
  await expect(result).rejects.toThrow();
  expect(calls).toBe(1);
});

test("backoff is charged to the one total budget without another provider read", async () => {
  let calls = 0;
  const delays: number[] = [];
  await expect(readProvider(async () => {
    calls += 1;
    return new Response(null, { status: 503 });
  }, {
    budgetMs: 20,
    sleep: async (milliseconds, signal) => {
      delays.push(milliseconds);
      if (signal === undefined) throw new Error("expected the budget signal");
      // Await expiry itself rather than require backoff to beat the budget timer.
      signal.throwIfAborted();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  })).rejects.toThrow("budget exhausted");
  expect(calls).toBe(1);
  expect(delays).toEqual([2_000]);
});

test("an expiring budget cancels a pending provider read and waits for it to settle", async () => {
  let calls = 0, ended = false;
  await expect(readProvider(async signal => {
    calls += 1;
    if (!signal.aborted) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    await Bun.sleep(5);
    ended = true;
    throw signal.reason;
  }, { budgetMs: 20 })).rejects.toThrow("budget exhausted");
  expect(calls).toBe(1);
  expect(ended).toBe(true);
});

test("expired budgets never issue a read or a confirming absence read", async () => {
  let calls = 0;
  await expect(readProvider(async () => { calls += 1; return new Response(); }, { deadline: performance.now() - 1 })).rejects.toThrow("budget exhausted");
  await expect(confirmAbsence(async () => { calls += 1; return undefined; }, { budgetMs: 0 })).rejects.toThrow("budget exhausted");
  expect(calls).toBe(0);
});
