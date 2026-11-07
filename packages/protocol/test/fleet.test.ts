import { describe, expect, test } from "bun:test";
import {
  FLEET_PUSH_VERSION,
  MAX_FLEET_SYNC_ENTRIES,
  ProtocolValidationError,
  fleetGrantVerifier,
  fleetOwnerDigest,
  fleetSessionSuffix,
  fleetSourceBinding,
  newFleetGrantSecret,
  notificationRoutePath,
  parseFleetBearer,
  parseFleetFeedEvent,
  parseFleetGrantActionRequest,
  parseFleetGrantCreateRequest,
  parseFleetGrantCreateResponse,
  parseFleetPushMessage,
  parseFleetRecipientRemoveRequest,
  parseFleetRecipientRequest,
  parseFleetRecipientResponse,
  parseFleetStatusResponse,
  parseNotificationData,
  parseNotificationRoute,
  parseSourceGrantRequest,
  parseSourceGrantResponse,
} from "../src/index.ts";

// Vectors are pinned so the gateway, the page, and the worker can never drift apart; an
// independent `openssl dgst -sha256` over the documented NUL-delimited encoding reproduces them.
const binding = "xeffoL_kxqTcht3AiIR0FT";
const otherBinding = "Zm7JF6omGejLZ9M1ygWBi2";
const instanceId = "aaaa1111bbbb2222";
const requestId = "req_0123456789abcdef";
const grantId = "0c5f6c1e-6a9b-4d7e-9f10-2b3c4d5e6f70";
const digest = "UIY1STgcFTMSksoBq-sN4ok5uPtHtqzHD1ch5Py3hII";
const endpoint = "https://fcm.googleapis.com/fcm/send/fleet-contract-example";

const attention = {
  version: 3,
  type: "attention",
  source: binding,
  instanceId,
  generation: 3,
  requestId,
  seq: { epoch: 7, n: 42 },
  badge: { count: 2, complete: true },
  title: "OMP session needs attention",
  body: "Studio · bb2222",
};

const reject = (parse: () => unknown): void => {
  expect(parse).toThrow(ProtocolValidationError);
};

describe("fleet derivations", () => {
  test("bindings are pinned, domain separated, and change with the origin", async () => {
    expect(await fleetSourceBinding("studio", "https://studio.example.ts.net")).toBe(binding);
    expect(await fleetSourceBinding("laptop", "https://studio.example.ts.net")).toBe(otherBinding);
    expect(await fleetSourceBinding("studio", "https://studio.example.ts.net:4318")).toBe("n2dBDGziCRPXcvGSCgAG3Z");
    await expect(fleetSourceBinding("Studio", "https://studio.example.ts.net")).rejects.toThrow(ProtocolValidationError);
    await expect(fleetSourceBinding("studio", "https://a.example\0b")).rejects.toThrow(ProtocolValidationError);
  });

  test("grant verifiers and owner digests are pinned and refuse malformed inputs", async () => {
    expect(await fleetGrantVerifier(grantId, "A".repeat(43))).toBe("_4EKP4Ee6GmIhUqftoQKwjhba1sAJw_smw0l7qZY_P8");
    expect(await fleetOwnerDigest("https://home.example.ts.net", "owner@example.com")).toBe("t9_CQH6PT-xMgk25xKM7gXYJpGlicUNNYqGlq4ywKlg");
    expect(await fleetOwnerDigest("https://other.example.ts.net", "owner@example.com")).not.toBe("t9_CQH6PT-xMgk25xKM7gXYJpGlicUNNYqGlq4ywKlg");
    await expect(fleetGrantVerifier("not-a-uuid", "A".repeat(43))).rejects.toThrow(ProtocolValidationError);
    await expect(fleetGrantVerifier(grantId, "short")).rejects.toThrow(ProtocolValidationError);
    expect(newFleetGrantSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(newFleetGrantSecret()).not.toBe(newFleetGrantSecret());
    expect(fleetSessionSuffix(instanceId)).toBe("bb2222");
  });
});

describe("fleet push messages", () => {
  test("accept the documented attention, stop, clear, and sync examples", () => {
    expect(parseFleetPushMessage(attention)).toEqual(attention as never);
    const { requestId: _request, title: _title, body: _body, type: _type, source: _source, ...session } = attention;
    expect(parseFleetPushMessage({ ...session, type: "activity_stop", title: "OMP session activity stopped" }).type).toBe("activity_stop");
    expect(parseFleetPushMessage({ ...session, type: "clear", requestId })).toEqual({ ...session, type: "clear", requestId } as never);
    const sync = {
      version: 3,
      type: "sync",
      seq: { epoch: 7, n: 43 },
      badge: { count: 1, complete: false },
      fresh: ["local", binding],
      pending: [{ source: binding, instanceId, generation: 3, requestId }],
    };
    expect(parseFleetPushMessage(sync)).toEqual(sync as never);
  });

  test("local messages omit the source; Push v2 and other versions never parse as fleet", () => {
    const { source: _source, ...local } = attention;
    expect(parseFleetPushMessage(local)).not.toHaveProperty("source");
    reject(() => parseFleetPushMessage({ ...attention, version: 2 }));
    reject(() => parseFleetPushMessage({ ...attention, version: 4 }));
    reject(() => parseFleetPushMessage({ version: 2, type: "attention", instanceId, generation: 3, requestId, pendingAskCount: 1, title: attention.title }));
  });

  test("reject content, capability, and unknown fields before rendering", () => {
    for (const key of ["preview", "cwdLabel", "sessionTitle", "capability", "url", "endpoint", "pendingAskCount"]) {
      reject(() => parseFleetPushMessage({ ...attention, [key]: "x" }));
    }
    reject(() => parseFleetPushMessage({ ...attention, title: "Anything else" }));
    reject(() => parseFleetPushMessage({ ...attention, body: "x".repeat(257) }));
    reject(() => parseFleetPushMessage({ ...attention, body: "x".repeat(3 * 1024) }));
  });

  test("reject malformed ordering, badge, and binding fields", () => {
    reject(() => parseFleetPushMessage({ ...attention, seq: { epoch: 0, n: 1 } }));
    reject(() => parseFleetPushMessage({ ...attention, seq: { epoch: 1, n: 0 } }));
    reject(() => parseFleetPushMessage({ ...attention, seq: { epoch: 1, n: 1, at: 1 } }));
    reject(() => parseFleetPushMessage({ ...attention, badge: { count: 1001, complete: true } }));
    reject(() => parseFleetPushMessage({ ...attention, badge: { count: 1, complete: "yes" } }));
    reject(() => parseFleetPushMessage({ ...attention, source: "local" }));
    reject(() => parseFleetPushMessage({ ...attention, source: `${binding}=` }));
    reject(() => parseFleetPushMessage({ ...attention, generation: 0 }));
  });

  test("a sync may only name pending asks of fresh sources, without duplicates, within bounds", () => {
    const sync = { version: FLEET_PUSH_VERSION, type: "sync", seq: { epoch: 1, n: 1 }, badge: { count: 0, complete: true } };
    const ask = { instanceId, generation: 1, requestId };
    expect(parseFleetPushMessage({ ...sync, fresh: ["local"], pending: [ask] }).type).toBe("sync");
    reject(() => parseFleetPushMessage({ ...sync, fresh: [binding], pending: [ask] }));
    reject(() => parseFleetPushMessage({ ...sync, fresh: ["local"], pending: [ask, ask] }));
    reject(() => parseFleetPushMessage({ ...sync, fresh: ["local", "local"], pending: [] }));
    reject(() => parseFleetPushMessage({ ...sync, fresh: ["laptop"], pending: [] }));
    const many = Array.from({ length: MAX_FLEET_SYNC_ENTRIES + 1 }, (_, index) => ({ ...ask, requestId: `${requestId}${index}` }));
    reject(() => parseFleetPushMessage({ ...sync, fresh: ["local"], pending: many }));
  });
});

describe("fleet notification data and routes", () => {
  test("v3 data may name a remote binding; v2 data may not", () => {
    expect(parseNotificationData({ version: 3, type: "attention", source: binding, instanceId, requestId }))
      .toEqual({ kind: "attention", source: binding, instanceId, requestId });
    expect(parseNotificationData({ version: 3, type: "activity_stop", instanceId, generation: 2 }))
      .toEqual({ kind: "activity_stop", instanceId, generation: 2 });
    expect(parseNotificationData({ version: 2, type: "attention", source: binding, instanceId, requestId })).toBeUndefined();
    expect(parseNotificationData({ version: 3, type: "attention", source: "studio", instanceId, requestId })).toBeUndefined();
    expect(parseNotificationData({ version: 3, type: "attention", instanceId, requestId, seq: 1 })).toBeUndefined();
  });

  test("routes round-trip the binding and reject repeated, extra, or malformed parameters", () => {
    for (const intent of [
      { kind: "attention", source: binding, instanceId, requestId },
      { kind: "activity_stop", source: binding, instanceId, generation: 4 },
      { kind: "attention", instanceId, requestId },
    ] as const) {
      expect(parseNotificationRoute(new URL(notificationRoutePath(intent), "https://home.example"))).toEqual(intent);
    }
    const base = `https://home.example/collab/${instanceId}`;
    expect(parseNotificationRoute(new URL(`${base}?request=${requestId}&source=${binding}&source=${binding}`))).toBeUndefined();
    expect(parseNotificationRoute(new URL(`${base}?request=${requestId}&source=studio`))).toBeUndefined();
    expect(parseNotificationRoute(new URL(`${base}?request=${requestId}&request=${requestId}`))).toBeUndefined();
    expect(parseNotificationRoute(new URL(`${base}?request=${requestId}&origin=x`))).toBeUndefined();
    expect(parseNotificationRoute(new URL(`${base}?source=${binding}`))).toBeUndefined();
    expect(parseNotificationRoute(new URL(`${base}?activity=stopped&generation=1&source=${binding}&extra=1`))).toBeUndefined();
  });
});

describe("fleet HTTP and feed contracts", () => {
  test("coordinator bodies are exact", () => {
    expect(parseFleetStatusResponse({ version: 1, sources: [{ sourceId: "studio", state: "current", expiresAt: "2026-12-07T00:00:00.000Z" }, { sourceId: "laptop", state: "not_enrolled" }] }).sources).toHaveLength(2);
    reject(() => parseFleetStatusResponse({ version: 1, sources: [{ sourceId: "studio", state: "online" }] }));
    reject(() => parseFleetStatusResponse({ version: 1, sources: [{ sourceId: "studio", state: "current" }, { sourceId: "studio", state: "stale" }] }));
    reject(() => parseFleetStatusResponse({ version: 1, sources: [{ sourceId: "studio", state: "current", expiresAt: "2026-12-07" }] }));
    expect(parseFleetGrantCreateRequest({ version: 1, sourceId: "studio" })).toEqual({ version: 1, sourceId: "studio" });
    reject(() => parseFleetGrantCreateRequest({ version: 1, sourceId: "studio", origin: "https://evil.example" }));
    expect(parseFleetGrantCreateResponse({ version: 1, grantId, verifier: digest }).grantId).toBe(grantId);
    reject(() => parseFleetGrantCreateResponse({ version: 1, grantId, verifier: digest, secret: digest }));
    expect(parseFleetGrantActionRequest({ version: 1 })).toEqual({ version: 1 });
    reject(() => parseFleetGrantActionRequest({ version: 1, sourceId: "studio" }));
  });

  test("recipient selections name remote sources only, once each, never the local source", () => {
    expect(parseFleetRecipientRequest({ version: 1, endpoint, sources: ["studio", "laptop"] }).sources).toEqual(["studio", "laptop"]);
    reject(() => parseFleetRecipientRequest({ version: 1, endpoint, sources: [] }));
    reject(() => parseFleetRecipientRequest({ version: 1, endpoint, sources: ["local"] }));
    reject(() => parseFleetRecipientRequest({ version: 1, endpoint, sources: ["studio", "studio"] }));
    reject(() => parseFleetRecipientRequest({ version: 1, endpoint: "http://insecure.example/push", sources: ["studio"] }));
    reject(() => parseFleetRecipientRequest({ version: 1, endpoint, sources: Array.from({ length: 8 }, (_, index) => `s${index}`) }));
    expect(parseFleetRecipientRemoveRequest({ version: 1, endpoint }).endpoint).toBe(endpoint);
    expect(parseFleetRecipientResponse({ version: 1, sources: [], released: ["studio"] }))
      .toEqual({ version: 1, sources: [], released: ["studio"] });
    reject(() => parseFleetRecipientResponse({ version: 1, sources: ["studio"] }));
    reject(() => parseFleetRecipientResponse({ version: 1, sources: [], released: ["local"] }));
  });

  test("source grant bodies carry a verifier, never a secret, and canonical expiry", () => {
    expect(parseSourceGrantRequest({ version: 1, grantId, verifier: digest })).toEqual({ version: 1, grantId, verifier: digest });
    reject(() => parseSourceGrantRequest({ version: 1, grantId, verifier: digest, secret: digest }));
    reject(() => parseSourceGrantRequest({ version: 1, grantId: grantId.toUpperCase(), verifier: digest }));
    expect(parseSourceGrantResponse({ version: 1, grantId, expiresAt: "2026-12-07T00:00:00.000Z" }).expiresAt).toBe("2026-12-07T00:00:00.000Z");
    reject(() => parseSourceGrantResponse({ version: 1, grantId, expiresAt: "2026-12-07T00:00:00Z" }));
  });

  test("feed events project identifiers and actionable requests only", () => {
    const snapshot = {
      version: 1,
      type: "snapshot",
      owner: digest,
      expiresAt: "2026-12-07T00:00:00.000Z",
      sessions: [{ instanceId, generation: 3, requestId }, { instanceId: "cccc3333dddd4444", generation: 1 }],
    };
    expect(parseFleetFeedEvent(snapshot)).toEqual(snapshot as never);
    for (const key of ["title", "cwdLabel", "preview", "busy", "canControl", "since"]) {
      reject(() => parseFleetFeedEvent({ ...snapshot, sessions: [{ instanceId, generation: 3, [key]: "x" }] }));
    }
    reject(() => parseFleetFeedEvent({ ...snapshot, sessions: [{ instanceId, generation: 3 }, { instanceId, generation: 4 }] }));
    reject(() => parseFleetFeedEvent({ ...snapshot, owner: "owner@example.com" }));
    expect(parseFleetFeedEvent({ version: 1, type: "upsert", session: { instanceId, generation: 3 } }).type).toBe("upsert");
    expect(parseFleetFeedEvent({ version: 1, type: "stop", instanceId, generation: 3 }).type).toBe("stop");
    reject(() => parseFleetFeedEvent({ version: 1, type: "stop", instanceId, generation: 3, requestId }));
    reject(() => parseFleetFeedEvent({ version: 2, type: "remove", instanceId, generation: 3 }));
  });

  test("only an exact bearer grant credential parses", () => {
    const secret = "B".repeat(43);
    expect(parseFleetBearer(`Bearer ${grantId}.${secret}`)).toEqual({ grantId, secret });
    for (const header of [null, "", `bearer ${grantId}.${secret}`, `Bearer ${grantId}.${secret}x`, `Bearer ${grantId}`, `Bearer ${grantId}.${secret} `, `Basic ${grantId}.${secret}`]) {
      expect(parseFleetBearer(header)).toBeUndefined();
    }
  });
});
