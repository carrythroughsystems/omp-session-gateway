import { describe, expect, test } from "bun:test";
import type { FleetSource } from "@omp-session-gateway/protocol";
import { FleetTransport, sourceKey, sessionKey, readSourceRecords, HELD_KEY, DISMISSED_KEY, boundedJson } from "../src/fleet";

const local: FleetSource = { id: "local", label: "Home", origin: "https://home.example" };
const remote: FleetSource = { id: "remote", label: "Remote", origin: "https://remote.example" };
const snapshot = (revision: number): Response => Response.json({ revision, sessions: [] });
class Clock {
  value = 0;
  next = 0;
  readonly timers = new Map<number, { callback: () => void; at: number }>();
  now = (): number => this.value;
  random = (): number => 0.5;
  setTimeout = (callback: () => void, delay: number): number => {
    const key = ++this.next;
    this.timers.set(key, { callback, at: this.value + delay });
    return key;
  };
  clearTimeout = (key: number): void => { this.timers.delete(key); };
  advance(milliseconds: number): void {
    this.value += milliseconds;
    for (const [key, timer] of [...this.timers]) {
      if (timer.at > this.value) continue;
      this.timers.delete(key);
      timer.callback();
    }
  }
}
class Storage {
  readonly items = new Map<string, string>();
  fail = false;
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { if (this.fail) throw new Error("denied"); this.items.set(key, value); }
  removeItem(key: string): void { this.items.delete(key); }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("fleet transport", () => {
  test("coalesces requests, binds CORS options, and accepts lower revisions after a restart", async () => {
    const time = new Clock();
    const requests: RequestInit[] = [];
    let revision = 100;
    const transport = new FleetTransport(remote, () => {}, (async (url, init) => {
      expect(url).toBe(`${remote.origin}/api/v1/sessions`);
      requests.push(init!);
      return snapshot(revision);
    }) as typeof fetch, time);
    transport.setVisible(true);
    expect(transport.refresh()).toBe(transport.refresh());
    expect(await transport.refresh()).toBe("healthy");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: "cors", credentials: "omit", cache: "no-store", redirect: "error" });
    revision = 1;
    expect(await transport.refresh()).toBe("healthy");
    expect(transport.revision).toBe(1);
    expect(transport.status).toBe("fresh");
    transport.setVisible(false);
  });

  test("ignores late responses from another epoch and aborts without recording a failure", async () => {
    const time = new Clock();
    const first = Promise.withResolvers<Response>();
    let calls = 0;
    const transport = new FleetTransport(remote, () => {}, (async () => ++calls === 1 ? await first.promise : snapshot(2)) as unknown as typeof fetch, time);
    transport.setVisible(true);
    const old = transport.refresh();
    transport.setVisible(false);
    expect(transport.staleSince).toBeUndefined();
    transport.setVisible(true);
    await transport.refresh();
    first.resolve(snapshot(50));
    await old;
    expect(transport.revision).toBe(2);
    expect(transport.sequence).toBe(2);
    transport.setVisible(false);
  });

  test("forbidden clears rows, stops automatic polling and permits only explicit or foreground retry", async () => {
    const time = new Clock();
    let forbidden = false;
    let calls = 0;
    const transport = new FleetTransport(remote, () => {}, (async () => {
      calls++;
      return forbidden ? new Response(null, { status: 403 }) : snapshot(4);
    }) as unknown as typeof fetch, time);
    transport.setVisible(true);
    await transport.refresh();
    forbidden = true;
    expect(await transport.refresh()).toBe("forbidden");
    expect(transport.snapshot).toBeUndefined();
    expect(time.timers.size).toBe(0);
    expect(await transport.refresh()).toBe("forbidden");
    expect(calls).toBe(2);
    forbidden = false;
    expect(await transport.refresh(true)).toBe("healthy");
    transport.setVisible(false);
  });

  test("keeps stale rows for 35 seconds, bounds backoff, isolates malformed payloads", async () => {
    const time = new Clock();
    let broken = false;
    const transport = new FleetTransport(remote, () => {}, (async () => broken ? Response.json({ wrong: true }) : snapshot(9)) as unknown as typeof fetch, time);
    transport.setVisible(true);
    await transport.refresh();
    broken = true;
    await transport.refresh();
    expect(transport.status).toBe("stale");
    expect(transport.snapshot?.revision).toBe(9);
    expect([...time.timers.values()].map(timer => timer.at)).toContain(750);
    for (let i = 0; i < 8; i++) await transport.refresh();
    expect([...time.timers.values()].some(timer => timer.at === 22_500)).toBeTrue();
    time.advance(35_000);
    await flush();
    expect(transport.snapshot).toBeUndefined();
    expect(transport.status).toBe("unavailable");
    transport.setVisible(false);
  });

  test("a probe abort does not cancel another coalesced consumer", async () => {
    const time = new Clock();
    const response = Promise.withResolvers<Response>();
    const transport = new FleetTransport(remote, () => {}, (async () => await response.promise) as unknown as typeof fetch, time);
    transport.setVisible(true);
    const controller = new AbortController();
    const probe = transport.probe(controller.signal);
    controller.abort();
    expect(await probe).toBe("unavailable");
    response.resolve(snapshot(2));
    expect(await transport.refresh()).toBe("healthy");
    transport.setVisible(false);
  });

  test("the five-second deadline records failure but hiding aborts without failure", async () => {
    const time = new Clock();
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      return await promise;
    }) as unknown as typeof fetch;
    const transport = new FleetTransport(remote, () => {}, fetcher, time);
    transport.setVisible(true);
    const pending = transport.refresh();
    time.advance(5_000);
    expect(await pending).toBe("unavailable");
    expect(transport.staleSince).toBe(5_000);
    transport.setVisible(false);
    const hidden = new FleetTransport(remote, () => {}, fetcher, time);
    hidden.setVisible(true);
    const aborted = hidden.refresh();
    hidden.setVisible(false);
    expect(await aborted).toBe("unavailable");
    expect(hidden.staleSince).toBeUndefined();
  });

  test("bounds streamed bodies without trusting content length", async () => {
    await expect(boundedJson(new Response("123456"), 5)).rejects.toThrow("response exceeds bound");
    await expect(boundedJson(new Response("{}", { headers: { "Content-Length": "100" } }), 5)).rejects.toThrow();
  });
});

describe("fleet record identity and migration", () => {
  test("same instance ids never collide across host bindings", () => {
    expect(sourceKey(local)).not.toBe(sourceKey(remote));
    expect(sessionKey({ sourceKey: sourceKey(local), instanceId: "same-id-0001" })).not.toBe(
      sessionKey({ sourceKey: sourceKey(remote), instanceId: "same-id-0001" }),
    );
  });
  test("migrates only after a successful write, and drops removed or rebound hosts", () => {
    const storage = new Storage();
    const v1 = HELD_KEY.replace("v2", "v1");
    storage.setItem(v1, JSON.stringify([{ instanceId: "same-id-0001", requestId: "request-0000000001", heldAt: "2026-07-21T10:00:00.000Z" }]));
    storage.fail = true;
    expect(readSourceRecords(storage, HELD_KEY, [local]).size).toBe(1);
    expect(storage.getItem(v1)).not.toBeNull();
    storage.fail = false;
    const records = readSourceRecords(storage, HELD_KEY, [local]);
    expect(storage.getItem(v1)).toBeNull();
    expect([...records.values()][0]).toMatchObject({ sourceId: "local", sourceOrigin: local.origin });
    storage.setItem(v1, "[]");
    readSourceRecords(storage, HELD_KEY, [local]);
    expect(storage.getItem(v1)).toBeNull();
    storage.setItem(DISMISSED_KEY, JSON.stringify([
      { sourceId: "remote", sourceOrigin: remote.origin, instanceId: "same-id-0001", generation: 1, dismissedAt: "2026-07-21T10:00:00.000Z" },
    ]));
    expect(readSourceRecords(storage, DISMISSED_KEY, [local, { ...remote, origin: "https://replacement.example" }]).size).toBe(0);
  });
});
