import { describe, expect, test } from "bun:test";
import type { FleetSource, SessionCreationOptions } from "@omp-session-gateway/protocol";
import {
  FleetTransport, sourceKey, sessionKey, readSourceRecords, HELD_KEY, DISMISSED_KEY, boundedJson,
  SessionCreationTransport, CreationTransportError, readCreationPreferences, writeCreationPreferences, CREATION_PREFERENCES_KEY,
  FleetNotificationTransport,
} from "../src/fleet";

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

const revision = "6e32a064-7baf-4f50-a903-09e04f882011";
const operationId = "6e32a064-7baf-4f50-a903-09e04f882012";
const creationRequest = { clientOperationId: operationId, revision, projectId: "project", workingCopyId: "main", profileId: "omp" };
const creationOptions: SessionCreationOptions = { version: 1, revision, available: true, projects: [
  { id: "project", label: "Project", workingCopies: [{ id: "main", label: "Main" }] },
], profiles: [{ id: "omp", label: "OMP" }] };

describe("fleet notification transport", () => {
  const grantId = "71000000-0000-4000-8000-000000000001";
  const verifier = "FLEET_SYNTHETIC_VERIFIER_".padEnd(43, "v");
  const endpoint = "https://push.example.test/send/FLEET_SYNTHETIC_ENDPOINT";

  test("validates every HTTP body and uses exact credential-free source origins without redirects", async () => {
    const requests: { path: string; init: RequestInit }[] = [];
    const transport = new FleetNotificationTransport((async (url, init) => {
      const path = String(url);
      requests.push({ path, init: init! });
      if (path.endsWith("/status")) return Response.json({ version: 1, sources: [] });
      if (path.endsWith("/fleet/grants")) return Response.json({ version: 1, grantId, verifier }, { status: 201 });
      if (path.endsWith("/activate") || path.endsWith("/revoke")) return new Response(null, { status: 204 });
      if (path.endsWith("/recipient")) return Response.json({ version: 1, sources: [], released: [{ sourceId: remote.id, grantId }] });
      return Response.json({ version: 1, grantId, expiresAt: "2026-12-07T00:00:00.000Z" });
    }) as typeof fetch, new Clock());
    await transport.status(endpoint);
    const grant = await transport.create(remote.id);
    await transport.authorize(remote, grant);
    await transport.activate(grantId);
    await transport.renew(remote, grantId);
    await transport.recipient(endpoint, [remote.id]);
    await transport.recipient(endpoint, []);
    await transport.revoke(grantId);
    await transport.revoke(grantId, remote);
    for (const request of requests) {
      expect(request.init).toMatchObject({ cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" } });
      expect(request.init.credentials).toBe(request.path.startsWith(remote.origin) ? "omit" : "same-origin");
      expect(request.init.mode).toBe(request.path.startsWith(remote.origin) ? "cors" : undefined);
      expect(JSON.stringify(request.init)).not.toContain("Authorization");
      expect(request.path).not.toContain("notification-feed");
    }
    expect(JSON.parse(String(requests[2]!.init.body))).toEqual({ version: 1, grantId, verifier });
    expect(requests[5]!.init.method).toBe("PUT");
    expect(requests[6]!.init.method).toBe("DELETE");
    expect(() => transport.recipient(endpoint, ["local"])).toThrow();
    expect(requests).toHaveLength(9);
  });

  test("old status is unsupported; activation problems keep only their closed code and never retry", async () => {
    const missing = new FleetNotificationTransport((async () => new Response(null, { status: 404 })) as unknown as typeof fetch, new Clock());
    expect(await missing.status(endpoint)).toBeUndefined();
    await expect(missing.authorize(remote, { version: 1, grantId, verifier })).rejects.toMatchObject({ code: "unsupported" });
    for (const [status, code] of [[409, "grant_rejected"], [503, "source_unreachable"], [404, "unsupported"]] as const) {
      let calls = 0;
      const transport = new FleetNotificationTransport((async () => {
        calls++;
        return Response.json({ code, message: "FLEET_SYNTHETIC_DO_NOT_EXPOSE" }, { status });
      }) as unknown as typeof fetch, new Clock());
      await expect(transport.activate(grantId)).rejects.toMatchObject({ code, message: code });
      expect(calls).toBe(1);
    }
  });

  test("rejects malformed, duplicate-key, oversized, and missing grant identity/status fields", async () => {
    for (const body of [
      '{"version":1,"version":1,"sources":[]}',
      JSON.stringify({ version: 1, sources: [{ sourceId: "remote", selected: true, state: "current" }] }),
      JSON.stringify({ version: 1, sources: [], secret: "FLEET_SYNTHETIC_SECRET" }),
      " ".repeat(64 * 1024),
    ]) {
      const transport = new FleetNotificationTransport((async () => new Response(body)) as unknown as typeof fetch, new Clock());
      await expect(transport.status(endpoint)).rejects.toMatchObject({ code: "source_unreachable" });
    }
  });
});

describe("session creation transport", () => {
  test("uses same-origin locally and exact credential-free CORS remotely for every route", async () => {
    for (const source of [local, remote]) {
      const requests: { url: string; init: RequestInit }[] = [];
      const transport = new SessionCreationTransport(source, () => {}, (async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return Response.json(String(url).endsWith("options") ? creationOptions
          : init!.method === "POST" ? { operationId, state: "accepted" }
            : { operationId, state: "awaiting_omp", updatedAt: "2026-10-24T00:00:00.000Z" });
      }) as typeof fetch, new Clock());
      const signal = new AbortController().signal;
      expect(await transport.options(signal)).toEqual(creationOptions);
      expect(await transport.create(creationRequest, signal)).toEqual({ operationId, state: "accepted" });
      expect((await transport.status(operationId, signal)).state).toBe("awaiting_omp");
      expect(requests.map(request => request.url)).toEqual([
        "/api/v1/session-creation-options", "/api/v1/session-creations", `/api/v1/session-creations/${operationId}`,
      ].map(path => source === local ? path : `${source.origin}${path}`));
      for (const { init } of requests) {
        expect(init.credentials).toBe(source === local ? "same-origin" : "omit");
        expect(init.mode).toBe(source === local ? undefined : "cors");
        expect(init.redirect).toBe("error");
        expect(init.cache).toBe("no-store");
      }
      expect(JSON.parse(String(requests[1]!.init.body))).toEqual(creationRequest);
    }
  });

  test("deadlines are 4/10/4 seconds and a failed POST is never retried", async () => {
    for (const method of ["options", "create", "status"] as const) {
      const time = new Clock();
      let calls = 0;
      const transport = new SessionCreationTransport(local, () => {}, (async (_url, init) => {
        calls++;
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("synthetic response lost")), { once: true });
        });
      }) as typeof fetch, time);
      const signal = new AbortController().signal;
      const pending = method === "options" ? transport.options(signal) : method === "create"
        ? transport.create(creationRequest, signal) : transport.status(operationId, signal);
      expect([...time.timers.values()].map(timer => timer.at)).toEqual([method === "create" ? 10_000 : 4_000]);
      time.advance(method === "create" ? 10_000 : 4_000);
      await expect(pending).rejects.toMatchObject({ code: "unavailable" });
      time.advance(60_000);
      expect(calls).toBe(1);
      expect(time.timers.size).toBe(0);
    }
  });

  test("readable 403 follows source-forbidden while old options 404 is unavailable", async () => {
    let denied: FleetSource | undefined;
    const missing = new SessionCreationTransport(local, () => {}, (async () => new Response(null, { status: 404 })) as unknown as typeof fetch, new Clock());
    expect(await missing.options(new AbortController().signal)).toBeUndefined();
    await expect(missing.status(operationId, new AbortController().signal)).rejects.toMatchObject({ code: "not_found" });
    const forbidden = new SessionCreationTransport(remote, source => { denied = source; }, (async () => new Response(null, { status: 403 })) as unknown as typeof fetch, new Clock());
    await expect(forbidden.options(new AbortController().signal)).rejects.toMatchObject({ code: "forbidden" });
    expect(denied).toBe(remote);
  });

  test("rejects duplicate keys, state combinations, unknown fields and oversized streamed bodies", async () => {
    for (const body of [
      JSON.stringify(creationOptions).replace('"version":1', '"version":1,"version":1'),
      JSON.stringify({ ...creationOptions, path: "/synthetic-secret-must-not-cross" }),
      " ".repeat(64 * 1024 + 1),
      '{"available":true}',
    ]) {
      const transport = new SessionCreationTransport(local, () => {}, (async () => new Response(body)) as unknown as typeof fetch, new Clock());
      await expect(transport.options(new AbortController().signal)).rejects.toBeInstanceOf(CreationTransportError);
    }
    const transport = new SessionCreationTransport(local, () => {}, (async () => Response.json({
      operationId, state: "ready", updatedAt: "2026-10-24T00:00:00.000Z",
    })) as unknown as typeof fetch, new Clock());
    await expect(transport.status(operationId, new AbortController().signal)).rejects.toMatchObject({ code: "unavailable" });
  });

  test("errors retain closed codes, not arbitrary response text; caller abort blocks late success", async () => {
    const canary = ["SYNTHETIC", "CREATION", "SECRET"].join("_");
    for (const code of ["revision_mismatch", "operation_conflict", "creation_busy", "ledger_unavailable"]) {
      const transport = new SessionCreationTransport(local, () => {}, (async () => Response.json({ code, message: canary }, { status: 409 })) as unknown as typeof fetch, new Clock());
      try { await transport.create(creationRequest, new AbortController().signal); throw new Error("expected rejection"); }
      catch (error) {
        expect(error).toMatchObject({ code });
        expect(String(error)).not.toContain(canary);
      }
    }
    const deferred = Promise.withResolvers<Response>();
    const controller = new AbortController();
    const time = new Clock();
    const transport = new SessionCreationTransport(local, () => {}, (async () => deferred.promise) as unknown as typeof fetch, time);
    const pending = transport.options(controller.signal);
    controller.abort();
    deferred.resolve(Response.json(creationOptions));
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(time.timers.size).toBe(0);
  });
});

describe("creation preferences", () => {
  const choice = { sourceId: "local", sourceOrigin: local.origin, projectId: "project", workingCopyId: "main", profileId: "omp", updatedAt: "2026-10-24T00:00:00.000Z" };
  test("round-trips only IDs and prunes removed or rebound sources only after authoritative bootstrap", () => {
    const storage = new Storage();
    writeCreationPreferences(storage, [choice, { ...choice, sourceId: "remote", sourceOrigin: remote.origin }]);
    expect(readCreationPreferences(storage, [local, remote], true).size).toBe(2);
    const bytes = storage.getItem(CREATION_PREFERENCES_KEY);
    expect(readCreationPreferences(storage, [local], false).size).toBe(2);
    expect(storage.getItem(CREATION_PREFERENCES_KEY)).toBe(bytes);
    expect(readCreationPreferences(storage, [local, { ...remote, origin: "https://rebound.example" }], true).size).toBe(1);
    expect([...readCreationPreferences(storage, [local], true).values()]).toEqual([choice]);
  });
  test("rejects labels, drafts, duplicate sources, invalid timestamps, oversized and unsupported records", () => {
    const storage = new Storage();
    for (const extra of [{ draft: "SYNTHETIC_DRAFT_CANARY" }, { label: "Never store" }, { operationId }, { sourceOrigin: "https://home.example/path" }, { updatedAt: "yesterday" }]) {
      storage.setItem(CREATION_PREFERENCES_KEY, JSON.stringify({ version: 1, choices: [{ ...choice, ...extra }] }));
      expect(readCreationPreferences(storage, [local], true).size).toBe(0);
    }
    for (const record of [{ version: 2, choices: [choice] }, { version: 1, choices: Array.from({ length: 9 }, () => choice) }]) {
      storage.setItem(CREATION_PREFERENCES_KEY, JSON.stringify(record));
      expect(readCreationPreferences(storage, [local], true).size).toBe(0);
    }
    storage.setItem(CREATION_PREFERENCES_KEY, " ".repeat(16 * 1024 + 1));
    expect(readCreationPreferences(storage, [local], true).size).toBe(0);
    storage.setItem(CREATION_PREFERENCES_KEY, JSON.stringify({ version: 1, choices: [choice, choice] }));
    expect(readCreationPreferences(storage, [local], true).size).toBe(1);
    storage.fail = true;
    expect(() => writeCreationPreferences(storage, [choice])).not.toThrow();
    expect(readCreationPreferences(storage, [local], true).size).toBe(1);
  });
});

describe("fleet transport", () => {
  test("audit: identical fresh snapshots update only the observation clock", async () => {
    const time = new Clock();
    let changes = 0;
    let revision = 1;
    const transport = new FleetTransport(remote, () => { changes++; },
      (async () => snapshot(revision)) as unknown as typeof fetch, time);
    transport.setVisible(true);
    await transport.refresh();
    const initial = changes;
    const payload = transport.snapshot;
    time.advance(10_000);
    await transport.refresh();
    expect(changes).toBe(initial);
    expect(transport.snapshot).toBe(payload);
    expect(transport.freshAt).toBe(10_000);
    revision++;
    await transport.refresh();
    expect(changes).toBe(initial + 1);
    transport.setVisible(false);
    transport.setVisible(true);
    const before = changes;
    await transport.refresh();
    expect(changes).toBe(before + 1);
    expect(transport.status).toBe("fresh");
    transport.setVisible(false);
  });
  test("visibility revalidation is refreshing, not a failed snapshot", async () => {
    const time = new Clock();
    // This fixture uses only the callable fetch interface, not Bun's extra fetch properties.
    const fetchSnapshot = (async () => snapshot(1)) as unknown as typeof fetch;
    const transport = new FleetTransport(remote, () => {}, fetchSnapshot, time);
    transport.setVisible(true);
    await transport.refresh();
    const epoch = transport.epoch;
    transport.setVisible(true);
    expect(transport.epoch).toBe(epoch);
    expect(transport.status).toBe("fresh");
    transport.setVisible(false);
    expect(transport.status).toBe("refreshing");
    expect(transport.staleSince).toBeUndefined();
    expect(transport.snapshot?.revision).toBe(1);
    transport.setVisible(true);
    expect(transport.status).toBe("refreshing");
    await transport.refresh();
    expect(transport.status).toBe("fresh");
    transport.setVisible(false);
  });

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

  test("receipt-captured snapshots wait for the previous request without withdrawing fresh metadata", async () => {
    const time = new Clock();
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    let calls = 0;
    const transport = new FleetTransport(remote, () => {},
      (async () => await (++calls === 1 ? first.promise : second.promise)) as unknown as typeof fetch, time);
    transport.setVisible(true);
    const captured = transport.refreshAfterCurrent();
    expect(calls).toBe(1);
    first.resolve(snapshot(1));
    await flush();
    expect(calls).toBe(2);
    expect(transport.status).toBe("fresh");
    expect(transport.snapshot?.revision).toBe(1);
    second.resolve(snapshot(2));
    expect(await captured).toBe("healthy");
    expect(transport.snapshot?.revision).toBe(2);
    transport.setVisible(false);
  });

  test("authorization-captured snapshots permit explicit retry but not background retry after forbidden", async () => {
    const time = new Clock();
    let calls = 0;
    const transport = new FleetTransport(remote, () => {},
      (async () => ++calls === 1 ? new Response(null, { status: 403 }) : snapshot(2)) as unknown as typeof fetch, time);
    transport.setVisible(true);
    expect(await transport.refresh()).toBe("forbidden");
    expect(await transport.refreshAfterCurrent()).toBe("forbidden");
    expect(calls).toBe(1);
    expect(await transport.refreshAfterCurrent(true)).toBe("healthy");
    expect(calls).toBe(2);
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
    expect(transport.status).toBe("expired");
    transport.setVisible(false);
  });

  test("offline interruption retains its observation, expires at 35 seconds and recovers without a visibility event", async () => {
    const time = new Clock();
    let broken = false;
    let requests = 0;
    const fetchSnapshot = (async () => {
      requests++;
      if (broken) throw new TypeError("synthetic outage");
      return snapshot(requests);
    }) as unknown as typeof fetch;
    const transport = new FleetTransport(remote, () => {}, fetchSnapshot, time);
    transport.setVisible(true);
    await transport.refresh();
    const observedAt = transport.freshAt;
    broken = true;
    transport.interrupt();
    expect(transport.status).toBe("stale");
    expect(transport.freshAt).toBe(observedAt);
    expect(transport.snapshot).toBeDefined();
    await flush();
    time.advance(34_999);
    await flush();
    expect(transport.snapshot).toBeDefined();
    time.advance(1);
    await flush();
    expect(transport.status).toBe("expired");
    expect(transport.snapshot).toBeUndefined();
    expect(transport.freshAt).toBe(observedAt);
    broken = false;
    const requestsBeforeRecovery = requests;
    time.advance(30_000);
    await flush();
    expect(transport.status).toBe("fresh");
    expect(requests).toBeGreaterThan(requestsBeforeRecovery);
    const requestsBeforePoll = requests;
    time.advance(10_000);
    await flush();
    expect(requests).toBe(requestsBeforePoll + 1);
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
  test("audit: a triage set over the documented bound keeps its newest records", () => {
    for (const key of [HELD_KEY, DISMISSED_KEY] as const) {
      const storage = new Storage();
      const records = Array.from({ length: 101 }, (_, index) => ({
        sourceId: local.id, sourceOrigin: local.origin, instanceId: `synthetic-session-${index}`,
        ...(key === HELD_KEY ? { requestId: "synthetic-request-0001", heldAt: "2026-07-21T10:00:00.000Z" }
          : { generation: 1, dismissedAt: "2026-07-21T10:00:00.000Z" }),
      }));
      storage.setItem(key, JSON.stringify(records.slice(0, 100)));
      expect(readSourceRecords(storage, key, [local], true).size).toBe(100);
      storage.setItem(key, JSON.stringify(records));
      const kept = readSourceRecords(storage, key, [local], true);
      expect(kept.size).toBe(100);
      // Writers append newest last, so the oldest record is the one that falls off.
      expect([...kept.values()].some(record => record.instanceId === "synthetic-session-0")).toBeFalse();
      expect([...kept.values()].some(record => record.instanceId === "synthetic-session-100")).toBeTrue();
    }
  });
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
    expect(readSourceRecords(storage, HELD_KEY, [local], true).size).toBe(1);
    expect(storage.getItem(v1)).not.toBeNull();
    storage.fail = false;
    const records = readSourceRecords(storage, HELD_KEY, [local], true);
    expect(storage.getItem(v1)).toBeNull();
    expect([...records.values()][0]).toMatchObject({ sourceId: "local", sourceOrigin: local.origin });
    storage.setItem(v1, "[]");
    readSourceRecords(storage, HELD_KEY, [local], true);
    expect(storage.getItem(v1)).toBeNull();
    storage.setItem(DISMISSED_KEY, JSON.stringify([
      { sourceId: "remote", sourceOrigin: remote.origin, instanceId: "same-id-0001", generation: 1, dismissedAt: "2026-07-21T10:00:00.000Z" },
    ]));
    expect(readSourceRecords(storage, DISMISSED_KEY, [local, { ...remote, origin: "https://replacement.example" }], true).size).toBe(0);
  });

  test("non-authoritative reads preserve valid unknown bindings and storage bytes without committing migration", () => {
    const storage = new Storage();
    const held = {
      sourceId: remote.id, sourceOrigin: remote.origin, instanceId: "remote-held-0001",
      requestId: "remote-request-0001", heldAt: "2026-07-21T10:00:00.000Z",
    };
    const dismissed = {
      sourceId: remote.id, sourceOrigin: remote.origin, instanceId: "remote-hidden-0001",
      generation: 1, dismissedAt: "2026-07-21T10:00:00.000Z",
    };
    const heldBytes = JSON.stringify([held, { ...held, sourceId: "INVALID" }, { ...held, sourceOrigin: "https://remote.example/path" }], null, 2);
    const dismissedBytes = JSON.stringify([dismissed], null, 2);
    storage.setItem(HELD_KEY, heldBytes);
    storage.setItem(DISMISSED_KEY, dismissedBytes);
    const before = [...storage.items];
    expect([...readSourceRecords(storage, HELD_KEY, [local], false).values()]).toEqual([held]);
    expect([...readSourceRecords(storage, DISMISSED_KEY, [local], false).values()]).toEqual([dismissed]);
    expect([...storage.items]).toEqual(before);
    expect(readSourceRecords(storage, HELD_KEY, [local], true).size).toBe(0);
    expect(readSourceRecords(storage, DISMISSED_KEY, [local], true).size).toBe(0);
    expect(storage.getItem(HELD_KEY)).toBe("[]");
    expect(storage.getItem(DISMISSED_KEY)).toBe("[]");

    const legacy = new Storage();
    const v1 = HELD_KEY.replace("v2", "v1");
    const bytes = JSON.stringify([{ instanceId: held.instanceId, requestId: held.requestId, heldAt: held.heldAt }], null, 2);
    legacy.setItem(v1, bytes);
    expect(readSourceRecords(legacy, HELD_KEY, [local], false).size).toBe(1);
    expect(legacy.getItem(v1)).toBe(bytes);
    expect(legacy.getItem(HELD_KEY)).toBeNull();
  });
});
