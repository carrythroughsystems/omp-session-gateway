import { describe, expect, test } from "bun:test";
import {
  MAX_FRAME_BYTES,
  ProtocolValidationError,
  SecretCapability,
  parseOmpDiscoveryEntry,
  parseOmpHostSnapshot,
  parseOmpSnapshotReply,
  parseOmpLinkReply,
  observedSessionFromSnapshot,
  parseJsonFrame,
  parseClientConfigResponse,
  parseFleetOrigin,
  parseLaunchRequest,
  parseLaunchResponse,
  parseAttentionPushMessage,
  parseNotificationData,
  parseNotificationRoute,
  notificationRoutePath,
  parsePushConfigResponse,
  parsePushSubscriptionRequest,
  parsePushSubscriptionResponse,
  parsePushUnsubscribeRequest,
  parseSessionEvent,
  parseSessionListResponse,
  sessionMetadataFromObserved,
} from "../src/index.ts";

const encoder = new TextEncoder();
const instanceId = "aaaa1111bbbb2222";
const entryId = "eaaa1111bbbb2222";
const capability = ["VIEW", "CANARY", "VALUE", "0000000000000000"].join("__");

function discoveryFile(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    instanceId,
    pid: 1234,
    endpoint: "/tmp/omp-host-double/relocated.sock",
    createdAt: Date.parse("2026-07-19T00:00:00.000Z"),
    token: "a".repeat(64),
    ...overrides,
  };
}

function hostSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    instanceId,
    generation: 1,
    pid: 1234,
    sessionId: "session-one",
    sessionName: "Example session",
    cwd: "/Users/you/projects/repository/",
    model: { provider: "provider", id: "model" },
    startedAt: Date.parse("2026-07-19T00:00:00.000Z"),
    participants: 1,
    relayConnected: true,
    inputRequired: false,
    access: "view" as const,
    ...overrides,
  };
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instanceId,
    generation: 1,
    title: "Example session",
    startedAt: "2026-07-19T00:00:00.000Z",
    lastSeenAt: "2026-07-19T00:00:01.000Z",
    canView: true,
    canControl: false,
    inputRequired: false,
    ...overrides,
  };
}

describe("strict protocol validation", () => {
  test("projects known activity and rejects non-boolean browser activity without changing legacy unknown", () => {
    for (const busy of [true, false, undefined, null]) {
      const observed = observedSessionFromSnapshot(parseOmpHostSnapshot(hostSnapshot({ busy })));
      const { metadata: session } = sessionMetadataFromObserved(observed, "2026-07-19T00:00:01.000Z");
      const parsed = parseSessionListResponse({ revision: 1, sessions: [session] }).sessions[0]!;
      expect(parsed.busy).toBe(busy ?? undefined);
      expect(Object.hasOwn(parsed, "busy")).toBe(typeof busy === "boolean");
      expect(parseSessionEvent({ type: "session_upsert", revision: 1, session })).toMatchObject({ session: parsed });
    }
    for (const busy of [null, undefined, "false", 0, [], {}]) {
      expect(() => parseSessionListResponse({ revision: 1, sessions: [metadata({ busy })] })).toThrow(ProtocolValidationError);
    }
    expect(() => parseSessionEvent({ type: "activity_stop", revision: 1, session: metadata({ busy: false }) })).toThrow(ProtocolValidationError);
  });

  test("accepts exact v2 stop payloads without accepting request identities or capability fields", () => {
    const stop = { version: 2, type: "activity_stop", instanceId, generation: 1, pendingAskCount: 0, title: "OMP session activity stopped" } as const;
    expect(parseAttentionPushMessage({ ...stop, body: "Example session" })).toEqual({ ...stop, body: "Example session" });
    for (const patch of [
      { version: 1 }, { generation: 0 }, { generation: Number.MAX_SAFE_INTEGER + 1 },
      { pendingAskCount: -1 }, { pendingAskCount: 1001 }, { title: "OMP session completed" },
      { requestId: "request-identity-000001" }, { url: capability }, { body: "x".repeat(257) },
    ]) expect(() => parseAttentionPushMessage({ ...stop, ...patch })).toThrow(ProtocolValidationError);
    for (const key of Object.keys(stop)) {
      const incomplete: Record<string, unknown> = { ...stop };
      delete incomplete[key];
      expect(() => parseAttentionPushMessage(incomplete)).toThrow(ProtocolValidationError);
    }
  });

  test("round-trips strict notification data and routes for attention and activity stops", () => {
    const attention = { kind: "attention" as const, instanceId, requestId: "request-identity-000001" };
    const stop = { kind: "activity_stop" as const, instanceId, generation: Number.MAX_SAFE_INTEGER };
    for (const intent of [attention, stop]) {
      const { kind, ...identity } = intent;
      expect(parseNotificationData({ version: 2, type: kind, ...identity })).toEqual(intent);
      expect(parseNotificationRoute(new URL(notificationRoutePath(intent), "https://gateway.example"))).toEqual(intent);
    }
    expect(parseNotificationRoute(new URL("https://gateway.example/collab/" + instanceId + "?generation=1&activity=stopped"))).toEqual({ ...stop, generation: 1 });
    for (const query of [
      "activity=stopped", "activity=stopped&generation=0", "activity=stopped&generation=01",
      "activity=stopped&generation=1.0", "activity=stopped&generation=1e2", "activity=stopped&generation=%2B1",
      "activity=stopped&generation=9007199254740992", "activity=stopped&generation=1&generation=1",
      "activity=stopped&activity=stopped&generation=1", "activity=stopped&generation=1&extra=1",
      "activity=stopped&generation=1&request=" + attention.requestId,
      "request=" + attention.requestId + "&request=" + attention.requestId,
      "request=" + attention.requestId + "&extra=1", "request=short",
    ]) expect(parseNotificationRoute(new URL("https://gateway.example/collab/" + instanceId + "?" + query))).toBeUndefined();
    for (const path of ["short", "invalid_id", "%2F" + instanceId, "%FF", instanceId + "/"]) {
      expect(parseNotificationRoute(new URL("https://gateway.example/collab/" + path + "?activity=stopped&generation=1"))).toBeUndefined();
    }
    expect(parseNotificationRoute(new URL(notificationRoutePath(stop) + "#fragment", "https://gateway.example"))).toBeUndefined();
    for (const value of [
      null, [], { version: 1, type: "attention", instanceId, requestId: attention.requestId },
      { version: 2, type: "clear", instanceId, requestId: attention.requestId },
      { version: 2, type: "attention", instanceId, requestId: attention.requestId, generation: 1 },
      { version: 2, type: "activity_stop", instanceId, generation: 1, requestId: attention.requestId },
      { version: 2, type: "activity_stop", instanceId, generation: "1" },
      { version: 2, type: "activity_stop", instanceId, generation: 0 },
      { version: 2, type: "activity_stop", instanceId },
      { type: "activity_stop", instanceId, generation: 1 },
    ]) expect(parseNotificationData(value)).toBeUndefined();
  });

  test("round-trips a discovery file and a host snapshot using the mainline wire shape", () => {
    const entry = parseOmpDiscoveryEntry(entryId, parseJsonFrame(encoder.encode(JSON.stringify(discoveryFile()))));
    expect(entry).toEqual({ entryId, ...discoveryFile() });
    const snapshot = hostSnapshot();
    expect(parseOmpHostSnapshot(snapshot)).toEqual(snapshot);
    expect(
      parseOmpSnapshotReply(parseJsonFrame(encoder.encode(JSON.stringify({ ok: true, v: 1, snapshot })))),
    ).toEqual({ ok: true, value: snapshot });
  });

  test("rejects unknown versions, malformed known fields, duplicate keys, and invalid UTF-8", () => {
    expect(() => parseOmpSnapshotReply({ ok: true, v: 2, snapshot: hostSnapshot() })).toThrow(ProtocolValidationError);
    expect(() => parseOmpLinkReply({ ok: true, v: 2, url: capability })).toThrow(ProtocolValidationError);
    expect(() => parseOmpDiscoveryEntry(entryId, discoveryFile({ token: "short" }))).toThrow(ProtocolValidationError);
    expect(() => parseOmpHostSnapshot(hostSnapshot({ model: { provider: 7, id: "model" } }))).toThrow(ProtocolValidationError);
    expect(() => parseJsonFrame(encoder.encode('{"v":1,"v":1}'))).toThrow(ProtocolValidationError);
    expect(() => parseJsonFrame(new Uint8Array([0xc3, 0x28]))).toThrow(ProtocolValidationError);
    for (const inputRequired of ["true", 1, {}, []]) {
      expect(() => parseOmpHostSnapshot(hostSnapshot({ inputRequired }))).toThrow(ProtocolValidationError);
    }
    // Ask content is not additive metadata: a snapshot naming it is refused, not silently dropped.
    for (const forbiddenKey of ["prompt", "question", "options", "prefill", "answer", "requestId", "count"]) {
      expect(() => parseOmpHostSnapshot(hostSnapshot({ [forbiddenKey]: "CONTENT_CANARY" }))).toThrow(ProtocolValidationError);
    }
  });

  test("ignores additive upstream fields under v1 and never projects them", () => {
    // Upstream adds optional fields without bumping v1, as it did for `busy`. One more key must not
    // hide a healthy host, and nothing the gateway does not name may leave the parser.
    expect(parseOmpDiscoveryEntry(entryId, discoveryFile({ futureHint: "FIELD_CANARY" }))).toEqual({
      entryId,
      ...discoveryFile(),
    });
    expect(parseOmpHostSnapshot(hostSnapshot({ futureField: { nested: "FIELD_CANARY" } }))).toEqual(hostSnapshot());
    expect(
      parseOmpHostSnapshot(hostSnapshot({ model: { provider: "provider", id: "model", family: "FIELD_CANARY" } })),
    ).toEqual(hostSnapshot());
    expect(parseOmpSnapshotReply({ ok: true, v: 1, snapshot: hostSnapshot(), traceId: "FIELD_CANARY" })).toEqual({
      ok: true,
      value: hostSnapshot(),
    });
    expect(parseOmpSnapshotReply({ ok: false, v: 1, error: "stale_generation", detail: "FIELD_CANARY" })).toEqual({
      ok: false,
      error: "stale_generation",
    });
    const link = parseOmpLinkReply({ ok: true, v: 1, url: capability, expiresAt: 1 });
    expect(link.ok ? link.value.reveal() : undefined).toBe(capability);
    expect(JSON.stringify([parseOmpHostSnapshot(hostSnapshot({ futureField: "FIELD_CANARY" }))])).not.toContain(
      "FIELD_CANARY",
    );
  });

  test("accepts additive busy metadata without guessing activity for legacy hosts", () => {
    expect(parseOmpHostSnapshot(hostSnapshot({ busy: true })).busy).toBe(true);
    expect(parseOmpHostSnapshot(hostSnapshot({ busy: false })).busy).toBe(false);
    expect(parseOmpHostSnapshot(hostSnapshot()).busy).toBeUndefined();
    expect(parseOmpHostSnapshot(hostSnapshot({ busy: null })).busy).toBeUndefined();
    expect(() => parseOmpHostSnapshot(hostSnapshot({ busy: "true" }))).toThrow(ProtocolValidationError);
  });

  test("bounds snapshot timestamps before projecting them into ISO metadata", () => {
    const lastRepresentableTimestamp = 8_640_000_000_000_000;
    expect(() =>
      parseOmpHostSnapshot(hostSnapshot({ startedAt: lastRepresentableTimestamp + 1 })),
    ).toThrow(ProtocolValidationError);
    const observed = observedSessionFromSnapshot(
      parseOmpHostSnapshot(hostSnapshot({ startedAt: lastRepresentableTimestamp })),
    );
    expect(Date.parse(observed.startedAt)).toBe(lastRepresentableTimestamp);
  });

  test("requires the discovery, snapshot, and reply fields rather than supplying defaults", () => {
    const discovery: Record<string, unknown> = discoveryFile();
    delete discovery.token;
    expect(() => parseOmpDiscoveryEntry(entryId, discovery)).toThrow(ProtocolValidationError);
    const snapshot: Record<string, unknown> = hostSnapshot();
    delete snapshot.startedAt;
    expect(() => parseOmpHostSnapshot(snapshot)).toThrow(ProtocolValidationError);
    expect(() => parseOmpSnapshotReply({ ok: true, v: 1 })).toThrow(ProtocolValidationError);
    expect(() => parseOmpLinkReply({ ok: true, v: 1 })).toThrow(ProtocolValidationError);
  });

  test("parses every upstream wire error without mistaking it for a successful snapshot or link", () => {
    for (const error of [
      "malformed_request",
      "unsupported_protocol",
      "authentication_failed",
      "snapshot_unavailable",
      "invalid_operation",
      "invalid_access",
      "stale_generation",
      "access_unavailable",
    ] as const) {
      const reply = { ok: false, v: 1, error };
      expect(parseOmpSnapshotReply(reply)).toEqual({ ok: false, error });
      expect(parseOmpLinkReply(reply)).toEqual({ ok: false, error });
    }
    expect(() => parseOmpSnapshotReply({ ok: false, v: 1, error: "unknown_error" })).toThrow(ProtocolValidationError);
    expect(() => parseOmpLinkReply({ ok: false, v: 1, error: "unknown_error" })).toThrow(ProtocolValidationError);
  });

  test("rejects oversized frames and ambiguous launch bodies", () => {
    expect(() => parseJsonFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(ProtocolValidationError);
    expect(() => parseLaunchRequest({ mode: "view", generation: 1, unexpected: true })).toThrow(
      ProtocolValidationError,
    );
  });

  test("binds control launches to an exact current request", () => {
    expect(
      parseLaunchRequest({
        mode: "control",
        generation: 1,
        requestId: "request-identity-000001",
      }),
    ).toEqual({ mode: "control", generation: 1, requestId: "request-identity-000001" });
    expect(() =>
      parseLaunchRequest({
        mode: "view",
        generation: 1,
        requestId: "request-identity-000001",
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseLaunchRequest({ mode: "control", generation: 1, requestId: "short" }),
    ).toThrow(ProtocolValidationError);
  });

  test("projects a host into basename-only metadata rather than exposing its full path or identity", () => {
    const observed = observedSessionFromSnapshot(parseOmpHostSnapshot(hostSnapshot()));
    expect(observed).toMatchObject({
      cwdLabel: "repository",
      model: "provider/model",
      startedAt: "2026-07-19T00:00:00.000Z",
      canControl: false,
    });
    const projected = sessionMetadataFromObserved(observed, "2026-07-19T00:00:01.000Z");
    expect(JSON.parse(JSON.stringify(projected.metadata))).toEqual(metadata({ cwdLabel: "repository", model: "provider/model" }));
    const windows = observedSessionFromSnapshot(parseOmpHostSnapshot(hostSnapshot({
      cwd: "C:\\Users\\operator\\projects\\repository\\",
      access: "control",
    })));
    expect(windows).toMatchObject({ cwdLabel: "repository", model: "provider/model", canControl: true });
  });

  test("labels a cwd in linear time even when a caller skips the 256-code-point parse bound", () => {
    // A trailing-separator regex backtracked quadratically on a long separator run that does not end
    // the string: 200,000 separators took about 16 seconds.
    const snapshot = { ...parseOmpHostSnapshot(hostSnapshot()), cwd: `${"/\\".repeat(100_000)}repository` };
    const started = performance.now();
    const observed = observedSessionFromSnapshot(snapshot);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(observed.cwdLabel).toBe("repository");
  });

  test("wraps a link reply URL before it can be serialized or inspected", () => {
    const url = new URL("https://collab.example.test");
    url.hash = capability;
    const reply = parseOmpLinkReply({ ok: true, v: 1, url: url.href });
    if (!reply.ok) throw new Error("expected a successful link reply");
    expect(reply.value).toBeInstanceOf(SecretCapability);
    expect(reply.value.reveal() === url.href).toBe(true);
    expect(() => JSON.stringify(reply)).toThrow("must not be serialized");
    expect(Bun.inspect(reply)).not.toContain(capability);
  });

  test("redacts secret string and inspector conversions", () => {
    const secret = SecretCapability.from(capability);
    expect(String(secret)).toBe("[REDACTED]");
    expect(Bun.inspect(secret)).not.toContain(capability);
  });

  test("removes control and bidi characters from display labels", () => {
    const snapshot = parseOmpHostSnapshot(hostSnapshot({ sessionName: "safe\u202etext\u0007" }));
    expect(observedSessionFromSnapshot(snapshot).title).toBe("safetext");
  });

  /**
   * OMP mints instance ids as 8-64 characters of `[a-z0-9-]`. The browser contract used to demand
   * at least 16, so a host on OMP's own minimum parsed from discovery and then failed the directory
   * response, which blanks every card rather than that one host.
   */
  test("accepts exactly the instance identities OMP can mint", () => {
    for (const candidate of ["a1b2c3d4", "a".repeat(64), "omp-host-1"]) {
      const list = parseSessionListResponse({ revision: 1, sessions: [metadata({ instanceId: candidate })] });
      expect(list.sessions[0]?.instanceId).toBe(candidate);
    }
    for (const candidate of ["a1b2c3d", "a".repeat(65), "Instance-000001", "host.1234", "host:1234", "host_1234"]) {
      expect(() => parseSessionListResponse({ revision: 1, sessions: [metadata({ instanceId: candidate })] })).toThrow(
        ProtocolValidationError,
      );
    }
  });

  test("validates browser metadata, events, and one-time launch responses", () => {
    const list = parseSessionListResponse({ revision: 2, sessions: [metadata()] });
    expect(list.sessions[0]?.instanceId).toBe(instanceId);
    expect(list.sessions[0]?.inputRequired).toBe(false);
    expect(
      parseSessionListResponse({
        revision: 2,
        sessions: [
          metadata({
            inputRequired: true,
            ask: {
              requestId: "request-identity-000001",
              since: "2026-07-19T00:00:00.500Z",
            },
          }),
        ],
      }).sessions[0],
    ).toMatchObject({ inputRequired: true, ask: { requestId: "request-identity-000001" } });
    expect(
      parseSessionEvent({ type: "session_upsert", revision: 3, session: metadata({ generation: 2 }) }).type,
    ).toBe("session_upsert");
    expect(parseLaunchResponse({ mode: "view", generation: 2, capability }).capability).toBe(capability);
    expect(() => parseSessionListResponse({ revision: 2, sessions: [metadata({ canView: "yes" })] })).toThrow(
      ProtocolValidationError,
    );
    expect(() =>
      parseSessionListResponse({ revision: 2, sessions: [metadata({ inputRequired: "true" })] }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseSessionListResponse({ revision: 2, sessions: [metadata({ inputRequired: true })] }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseSessionEvent({ type: "session_remove", revision: 3, instanceId, generation: 2, extra: true }),
    ).toThrow(ProtocolValidationError);
    expect(() => parseLaunchResponse({ mode: "view", generation: 2, capability: "short" })).toThrow(
      ProtocolValidationError,
    );
  });
  test("validates strict capability-free Web Push contracts", () => {
    const subscription = {
      endpoint: "https://push.example.test/send/subscription-1",
      expirationTime: null,
      keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
    };
    const requestId = "request-identity-000001";
    expect(
      parsePushSubscriptionRequest({ version: 2, detailLevel: "session", subscription }),
    ).toEqual({ version: 2, detailLevel: "session", subscription });
    expect(parsePushSubscriptionRequest({ version: 2, subscription }).detailLevel).toBeUndefined();
    // WebKit's PushSubscription.toJSON() omits a null expirationTime (#274); it means null.
    const { expirationTime: _omitted, ...webkit } = subscription;
    expect(parsePushSubscriptionRequest({ version: 2, subscription: webkit }).subscription).toEqual(subscription);
    expect(
      parsePushSubscriptionResponse({ version: 2, detailLevel: "preview" }),
    ).toEqual({ version: 2, detailLevel: "preview" });
    expect(
      parsePushUnsubscribeRequest({ version: 2, endpoint: subscription.endpoint }).endpoint,
    ).toBe(subscription.endpoint);
    expect(
      parsePushConfigResponse({ version: 2, applicationServerKey: "V".repeat(87) }).applicationServerKey,
    ).toHaveLength(87);
    expect(
      parseAttentionPushMessage({
        version: 2,
        type: "attention",
        instanceId,
        generation: 3,
        requestId,
        pendingAskCount: 2,
        title: "OMP session needs attention",
        body: "Example session · repository",
      }),
    ).toMatchObject({ version: 2, type: "attention", requestId, pendingAskCount: 2 });
    expect(
      parseAttentionPushMessage({
        version: 2,
        type: "clear",
        instanceId,
        requestId,
        pendingAskCount: 0,
      }),
    ).toEqual({ version: 2, type: "clear", instanceId, requestId, pendingAskCount: 0 });

    for (const invalid of [
      { version: 1, detailLevel: "session", subscription },
      { version: 2, detailLevel: "verbose", subscription },
      { version: 2, subscription: { ...subscription, endpoint: "http://push.example.test/send" } },
      { version: 2, subscription: { ...subscription, keys: { ...subscription.keys, auth: "short" } } },
      { version: 2, subscription: { ...subscription, prompt: "PROMPT_CONTENT_CANARY" } },
    ]) {
      expect(() => parsePushSubscriptionRequest(invalid)).toThrow(ProtocolValidationError);
    }
    expect(() =>
      parseAttentionPushMessage({
        version: 2,
        type: "attention",
        instanceId,
        generation: 3,
        requestId,
        pendingAskCount: 1,
        title: "OMP session needs attention",
        prompt: "PROMPT_CONTENT_CANARY",
      }),
    ).toThrow(ProtocolValidationError);
  });
  test("validates the public client configuration and rejects aliased or colliding sources", () => {
    const local = { id: "local", label: "SF Studio", origin: "https://studio.example.ts.net" };
    const nyc = { id: "nyc", label: "NYC", origin: "https://nyc.example.ts.net" };
    const config = { version: 1 as const, local, targets: [nyc], speech: { browserRecognition: false } };
    expect(parseClientConfigResponse(config)).toEqual(config);
    expect(parseClientConfigResponse({ ...config, targets: [] }).targets).toEqual([]);
    expect(parseClientConfigResponse({ ...config, speech: { browserRecognition: true } }).speech.browserRecognition).toBe(
      true,
    );
    expect(parseFleetOrigin("http://127.0.0.1:4318")).toBe("http://127.0.0.1:4318");
    expect(parseFleetOrigin("http://[::1]:4318")).toBe("http://[::1]:4318");

    const rejected: unknown[] = [
      { ...config, version: 2 },
      { ...config, extra: true },
      { ...config, local: { ...local, id: "studio" } },
      { ...config, targets: [{ ...nyc, id: "local" }] },
      { ...config, targets: [{ ...nyc, origin: local.origin }] },
      { ...config, targets: [nyc, { ...nyc, label: "NYC again" }] },
      { ...config, targets: [nyc, { ...nyc, id: "nyc-2" }] },
      { ...config, targets: Array.from({ length: 8 }, (_, index) => ({ ...nyc, id: `t${index}`, origin: `https://t${index}.example.ts.net` })) },
      { ...config, targets: [{ ...nyc, token: "x" }] },
      { ...config, targets: [{ ...nyc, id: "NYC" }] },
      { ...config, targets: [{ ...nyc, label: "  " }] },
      { ...config, targets: [{ ...nyc, label: "x".repeat(65) }] },
      { ...config, speech: {} },
      { ...config, speech: { browserRecognition: "yes" } },
    ];
    for (const value of rejected) {
      expect(() => parseClientConfigResponse(value)).toThrow(ProtocolValidationError);
    }
    for (const origin of [
      "https://nyc.example.ts.net/",
      "https://nyc.example.ts.net/path",
      "https://nyc.example.ts.net?x=1",
      "https://nyc.example.ts.net#frag",
      "https://user:secret@nyc.example.ts.net",
      "https://NYC.example.ts.net",
      "https://nyc.example.ts.net:443",
      "http://nyc.example.ts.net",
      "http://localhost:4318",
      "http://10.0.0.5:4318",
      "wss://nyc.example.ts.net",
      "null",
      "",
    ]) {
      expect(() => parseFleetOrigin(origin)).toThrow(ProtocolValidationError);
    }
  });

});
