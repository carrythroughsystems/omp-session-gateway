import { ProtocolValidationError, SecretCapability } from "./secret.ts";
import {
  CLIENT_CONFIG_VERSION,
  FLEET_SOURCE_ID_PATTERN,
  LOCAL_FLEET_SOURCE_ID,
  MAX_FLEET_LABEL_CODEPOINTS,
  MAX_FLEET_TARGETS,
  MAX_FRAME_BYTES,
  INSTANCE_ID_PATTERN,
  MAX_LABEL_CODEPOINTS,
  MAX_PUSH_PENDING_COUNT,
  MAX_REQUEST_ID_BYTES,
  MAX_PUSH_ENDPOINT_BYTES,
  MAX_SESSIONS,
  OMP_REGISTRY_VERSION,
  PUSH_API_VERSION,
  type AttentionPushMessage,
  type BrowserPushSubscription,
  type ClientConfigResponse,
  type FleetSource,
  type LaunchMode,
  type LaunchRequest,
  type LaunchResponse,
  type NotificationLaunchIntent,
  type ObservedSessionInput,
  type OmpDiscoveryEntry,
  type OmpHostSnapshot,
  type OmpRegistryErrorCode,
  type PushConfigResponse,
  type PushSubscriptionRequest,
  type PushSubscriptionResponse,
  type PushDetailLevel,
  type PushUnsubscribeRequest,
  type SessionEvent,
  type SessionListResponse,
  type SessionMetadata,
  SESSION_CREATION_VERSION,
  SESSION_CREATION_UUID_PATTERN,
  SESSION_CREATION_STATES,
  SESSION_CREATION_ERRORS,
  MAX_SESSION_CREATION_OPTIONS_BYTES,
  MAX_SESSION_CREATION_REQUEST_BYTES,
  MAX_SESSION_CREATION_STATUS_BYTES,
  MAX_SESSION_CREATION_PROJECTS,
  MAX_SESSION_CREATION_WORKING_COPIES,
  MAX_SESSION_CREATION_PROFILES,
  type SessionCreationChoice,
  type SessionCreationOptions,
  type SessionCreationRequest,
  type SessionCreationReceipt,
  type SessionCreationStatus,
  type SessionCreationState,
} from "./types.ts";

const SESSION_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;
const DISALLOWED_LABEL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
const PUSH_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const PUSH_DETAIL_LEVELS: Readonly<Record<PushDetailLevel, true>> = {
  private: true,
  session: true,
  preview: true,
};

/** 32 random bytes, hex encoded, written into the discovery file by the host. */
const OMP_DISCOVERY_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const OMP_REGISTRY_ERROR_CODES: Readonly<Record<OmpRegistryErrorCode, true>> = {
  malformed_request: true,
  unsupported_protocol: true,
  authentication_failed: true,
  snapshot_unavailable: true,
  invalid_operation: true,
  invalid_access: true,
  stale_generation: true,
  access_unavailable: true,
};

/**
 * Keys that would carry ask content. Upstream's registry snapshot is metadata-only; a snapshot that
 * names one of these is a privacy regression to review, not an additive field, so it is refused.
 */
const FORBIDDEN_OMP_SNAPSHOT_KEYS = ["prompt", "question", "options", "prefill", "answer", "requestId", "count"] as const;

type JsonRecord = Record<string, unknown>;

function requireRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError();
  }
  return value as JsonRecord;
}

function requireExactKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ProtocolValidationError();
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ProtocolValidationError();
  }
}

/**
 * OMP evolves its registry v1 wire additively: it added `busy` without a version bump because a
 * bump would hide every host from differently versioned listers. OMP input therefore requires the
 * fields the gateway reads and ignores the rest; each parser builds its result from named fields
 * only, so an unknown key can never reach a projection. Gateway-owned protocols stay exact.
 */
function requireKeys(value: JsonRecord, required: readonly string[]): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ProtocolValidationError();
  }
}

function requireInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProtocolValidationError();
  }
  return value as number;
}

/** Every instance identity on every surface: the one OMP mints, validated the way OMP does. */
function requireInstanceId(value: unknown): string {
  if (typeof value !== "string" || !INSTANCE_ID_PATTERN.test(value)) throw new ProtocolValidationError();
  return value;
}

function requireRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > MAX_REQUEST_ID_BYTES ||
    !REQUEST_ID_PATTERN.test(value)
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function requireDateTime(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new ProtocolValidationError();
  }
  return value;
}

function optionalLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ProtocolValidationError();
  const normalized = value.normalize("NFC").replace(DISALLOWED_LABEL_PATTERN, "").trim();
  if ([...normalized].length > MAX_LABEL_CODEPOINTS) throw new ProtocolValidationError();
  return normalized;
}

function assertNoDuplicateObjectKeys(text: string): void {
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const current = text[index];
      if (current === "\\") {
        index += 2;
        continue;
      }
      if (current === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          throw new ProtocolValidationError();
        }
      }
      index += 1;
    }
    throw new ProtocolValidationError();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const current = text[index];
    if (current === "{") {
      index += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        if (text[index] !== '"') throw new ProtocolValidationError();
        const key = parseString();
        if (keys.has(key)) throw new ProtocolValidationError();
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") throw new ProtocolValidationError();
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new ProtocolValidationError();
        index += 1;
      }
      throw new ProtocolValidationError();
    }
    if (current === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new ProtocolValidationError();
        index += 1;
      }
      throw new ProtocolValidationError();
    }
    if (current === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,}\]]/u.test(text[index] ?? "")) index += 1;
    if (start === index) throw new ProtocolValidationError();
  };

  parseValue();
  skipWhitespace();
  if (index !== text.length) throw new ProtocolValidationError();
}

export function parseJsonFrame(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES) throw new ProtocolValidationError();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolValidationError();
  }
  if (text.includes("\0")) throw new ProtocolValidationError();
  assertNoDuplicateObjectKeys(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolValidationError();
  }
}

/**
 * Parses one `<entryId>.json` discovery file. The file is written once per publication and never
 * rewritten, so an unparseable file or one missing a required field is a stale or alien artifact,
 * not a host. Fields a later upstream adds are ignored.
 */
export function parseOmpDiscoveryEntry(entryId: string, value: unknown): OmpDiscoveryEntry {
  const record = requireRecord(value);
  requireKeys(record, ["version", "instanceId", "pid", "endpoint", "createdAt", "token"]);
  if (typeof record.endpoint !== "string" || record.endpoint.length === 0 || record.endpoint.includes("\0")) {
    throw new ProtocolValidationError();
  }
  if (typeof record.token !== "string" || !OMP_DISCOVERY_TOKEN_PATTERN.test(record.token)) {
    throw new ProtocolValidationError();
  }
  return {
    entryId: requireInstanceId(entryId),
    version: requireInteger(record.version, 1),
    instanceId: requireInstanceId(record.instanceId),
    pid: requireInteger(record.pid, 1, 2_147_483_647),
    endpoint: record.endpoint,
    createdAt: requireInteger(record.createdAt, 0),
    token: record.token,
  };
}

function parseOmpHostModel(value: unknown): { provider: string; id: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireRecord(value);
  requireKeys(record, ["provider", "id"]);
  const provider = optionalLabel(record.provider);
  const id = optionalLabel(record.id);
  if (provider === undefined || id === undefined || provider === "" || id === "") return undefined;
  return { provider, id };
}

/** One host's `snapshot` payload. Upstream bounds every free-form string to 1024 characters. */
export function parseOmpHostSnapshot(value: unknown): OmpHostSnapshot {
  const record = requireRecord(value);
  requireKeys(record, [
    "instanceId",
    "generation",
    "pid",
    "sessionId",
    "startedAt",
    "participants",
    "relayConnected",
    "inputRequired",
    "access",
  ]);
  if (FORBIDDEN_OMP_SNAPSHOT_KEYS.some(key => Object.hasOwn(record, key))) throw new ProtocolValidationError();
  if (typeof record.sessionId !== "string" || !SESSION_ID_PATTERN.test(record.sessionId)) {
    throw new ProtocolValidationError();
  }
  if (typeof record.relayConnected !== "boolean" || typeof record.inputRequired !== "boolean") {
    throw new ProtocolValidationError();
  }
  if (record.access !== "view" && record.access !== "control") throw new ProtocolValidationError();
  if (record.busy !== undefined && record.busy !== null && typeof record.busy !== "boolean") {
    throw new ProtocolValidationError();
  }
  const sessionName = record.sessionName === null ? undefined : optionalLabel(record.sessionName);
  const cwd = record.cwd === null ? undefined : optionalLabel(record.cwd);
  const model = parseOmpHostModel(record.model);
  return {
    instanceId: requireInstanceId(record.instanceId),
    generation: requireInteger(record.generation, 1),
    pid: requireInteger(record.pid, 1, 2_147_483_647),
    sessionId: record.sessionId,
    // ECMAScript TimeClip limit: every accepted timestamp must survive ISO projection.
    startedAt: requireInteger(record.startedAt, 0, 8_640_000_000_000_000),
    participants: requireInteger(record.participants, 0),
    relayConnected: record.relayConnected,
    inputRequired: record.inputRequired,
    access: record.access,
    ...(typeof record.busy === "boolean" ? { busy: record.busy } : {}),
    ...(sessionName === undefined || sessionName === "" ? {} : { sessionName }),
    ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
  };
}

export type OmpRegistryReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OmpRegistryErrorCode };

function parseOmpEnvelope(value: unknown): { record: JsonRecord; ok: boolean } {
  const record = requireRecord(value);
  if (record.v !== OMP_REGISTRY_VERSION || typeof record.ok !== "boolean") throw new ProtocolValidationError();
  if (!record.ok && (typeof record.error !== "string" || !Object.hasOwn(OMP_REGISTRY_ERROR_CODES, record.error))) {
    throw new ProtocolValidationError();
  }
  return { record, ok: record.ok };
}

export function parseOmpSnapshotReply(value: unknown): OmpRegistryReply<OmpHostSnapshot> {
  const { record, ok } = parseOmpEnvelope(value);
  if (!ok) return { ok: false, error: record.error as OmpRegistryErrorCode };
  requireKeys(record, ["snapshot"]);
  return { ok: true, value: parseOmpHostSnapshot(record.snapshot) };
}

/**
 * A successful `link` reply carries the one capability this whole system exists to broker, so it is
 * wrapped before it can be logged, serialized, or copied into a plain field.
 */
export function parseOmpLinkReply(value: unknown): OmpRegistryReply<SecretCapability> {
  const { record, ok } = parseOmpEnvelope(value);
  if (!ok) return { ok: false, error: record.error as OmpRegistryErrorCode };
  requireKeys(record, ["url"]);
  return { ok: true, value: SecretCapability.from(record.url) };
}

/**
 * Reduces one host snapshot to the browser-safe directory entry. `cwd` becomes a basename label:
 * the directory listing shows which project a session belongs to, and the full path is neither
 * needed for that nor worth broadcasting to every authenticated viewer.
 */
export function observedSessionFromSnapshot(snapshot: OmpHostSnapshot): ObservedSessionInput {
  const title = optionalLabel(snapshot.sessionName);
  // Not a `[/\\]+$` trim: that regex backtracks quadratically on a long separator run mid-string.
  const cwdLabel = optionalLabel(snapshot.cwd?.split(/[/\\]/u).filter((segment) => segment !== "").pop());
  const model = snapshot.model === undefined ? undefined : optionalLabel(`${snapshot.model.provider}/${snapshot.model.id}`);
  return {
    instanceId: snapshot.instanceId,
    generation: snapshot.generation,
    pid: snapshot.pid,
    sessionId: snapshot.sessionId,
    startedAt: new Date(snapshot.startedAt).toISOString(),
    canControl: snapshot.access === "control",
    inputRequired: snapshot.inputRequired,
    ...(snapshot.busy === undefined ? {} : { busy: snapshot.busy }),
    ...(title === undefined || title === "" ? {} : { title }),
    ...(cwdLabel === undefined || cwdLabel === "" ? {} : { cwdLabel }),
    ...(model === undefined || model === "" ? {} : { model }),
  };
}

export function parseLaunchRequest(value: unknown): LaunchRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["mode", "generation"], ["requestId"]);
  if (record.mode !== "view" && record.mode !== "control") throw new ProtocolValidationError();
  if (record.requestId !== undefined && record.mode !== "control") throw new ProtocolValidationError();
  return {
    mode: record.mode,
    generation: requireInteger(record.generation, 1),
    ...(record.requestId === undefined ? {} : { requestId: requireRequestId(record.requestId) }),
  };
}
function requirePushEndpoint(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_PUSH_ENDPOINT_BYTES) {
    throw new ProtocolValidationError();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ProtocolValidationError();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    endpoint.href !== value
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function requirePushKey(value: unknown, minimumLength: number, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    !PUSH_KEY_PATTERN.test(value)
  ) {
    throw new ProtocolValidationError();
  }
  return value;
}

function parseBrowserPushSubscription(value: unknown): BrowserPushSubscription {
  const record = requireRecord(value);
  // WebKit's PushSubscription.toJSON() omits a null expirationTime; Chromium serializes it.
  requireExactKeys(record, ["endpoint", "keys"], ["expirationTime"]);
  const expirationTime = record.expirationTime ?? null;
  const keys = requireRecord(record.keys);
  requireExactKeys(keys, ["p256dh", "auth"]);
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || (expirationTime as number) < 0)) {
    throw new ProtocolValidationError();
  }
  return {
    endpoint: requirePushEndpoint(record.endpoint),
    expirationTime: expirationTime as number | null,
    keys: {
      p256dh: requirePushKey(keys.p256dh, 80, 128),
      auth: requirePushKey(keys.auth, 20, 64),
    },
  };
}

export function parsePushSubscriptionRequest(value: unknown): PushSubscriptionRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "subscription"], ["detailLevel"]);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  let detailLevel: PushDetailLevel | undefined;
  if (record.detailLevel !== undefined) {
    if (
      typeof record.detailLevel !== "string" ||
      !Object.hasOwn(PUSH_DETAIL_LEVELS, record.detailLevel)
    ) {
      throw new ProtocolValidationError();
    }
    detailLevel = record.detailLevel as PushDetailLevel;
  }
  return {
    version: PUSH_API_VERSION,
    ...(detailLevel === undefined ? {} : { detailLevel }),
    subscription: parseBrowserPushSubscription(record.subscription),
  };
}

export function parsePushSubscriptionResponse(value: unknown): PushSubscriptionResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "detailLevel"]);
  if (
    record.version !== PUSH_API_VERSION ||
    typeof record.detailLevel !== "string" ||
    !Object.hasOwn(PUSH_DETAIL_LEVELS, record.detailLevel)
  ) {
    throw new ProtocolValidationError();
  }
  return {
    version: PUSH_API_VERSION,
    detailLevel: record.detailLevel as PushDetailLevel,
  };
}

export function parsePushUnsubscribeRequest(value: unknown): PushUnsubscribeRequest {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "endpoint"]);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  return { version: PUSH_API_VERSION, endpoint: requirePushEndpoint(record.endpoint) };
}

export function parsePushConfigResponse(value: unknown): PushConfigResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "applicationServerKey"]);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  return {
    version: PUSH_API_VERSION,
    applicationServerKey: requirePushKey(record.applicationServerKey, 80, 128),
  };
}

export function parseAttentionPushMessage(value: unknown): AttentionPushMessage {
  const record = requireRecord(value);
  if (record.version !== PUSH_API_VERSION) throw new ProtocolValidationError();
  if (record.type === "attention") {
    requireExactKeys(
      record,
      ["version", "type", "instanceId", "generation", "requestId", "pendingAskCount", "title"],
      ["body"],
    );
    if (record.title !== "OMP session needs attention") throw new ProtocolValidationError();
    const body = optionalLabel(record.body);
    return {
      version: PUSH_API_VERSION,
      type: "attention",
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
      requestId: requireRequestId(record.requestId),
      pendingAskCount: requireInteger(record.pendingAskCount, 0, MAX_PUSH_PENDING_COUNT),
      title: record.title,
      ...(body === undefined ? {} : { body }),
    };
  }
  if (record.type === "activity_stop") {
    requireExactKeys(record, ["version", "type", "instanceId", "generation", "pendingAskCount", "title"], ["body"]);
    if (record.title !== "OMP session activity stopped") throw new ProtocolValidationError();
    const body = optionalLabel(record.body);
    return {
      version: PUSH_API_VERSION,
      type: "activity_stop",
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
      pendingAskCount: requireInteger(record.pendingAskCount, 0, MAX_PUSH_PENDING_COUNT),
      title: record.title,
      ...(body === undefined ? {} : { body }),
    };
  }
  if (record.type === "clear") {
    requireExactKeys(record, ["version", "type", "instanceId", "requestId", "pendingAskCount"]);
    return {
      version: PUSH_API_VERSION,
      type: "clear",
      instanceId: requireInstanceId(record.instanceId),
      requestId: requireRequestId(record.requestId),
      pendingAskCount: requireInteger(record.pendingAskCount, 0, MAX_PUSH_PENDING_COUNT),
    };
  }
  throw new ProtocolValidationError();
}


/** Notification data is deliberately smaller than a push payload and admits no extra fields. */
export function parseNotificationData(value: unknown): NotificationLaunchIntent | undefined {
  try {
    const record = requireRecord(value);
    if (record.version !== PUSH_API_VERSION) return undefined;
    if (record.type === "attention") {
      requireExactKeys(record, ["version", "type", "instanceId", "requestId"]);
      return { kind: "attention", instanceId: requireInstanceId(record.instanceId), requestId: requireRequestId(record.requestId) };
    }
    if (record.type === "activity_stop") {
      requireExactKeys(record, ["version", "type", "instanceId", "generation"]);
      return { kind: "activity_stop", instanceId: requireInstanceId(record.instanceId), generation: requireInteger(record.generation, 1) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Shared by the HTTP shell guard and the browser; query keys are exact and non-repeating. */
export function parseNotificationRoute(url: URL): NotificationLaunchIntent | undefined {
  const match = /^\/collab\/([^/]{1,384})$/u.exec(url.pathname);
  if (match?.[1] === undefined || url.hash !== "") return undefined;
  try {
    const instanceId = requireInstanceId(decodeURIComponent(match[1]));
    const entries = [...url.searchParams];
    if (entries.length === 1 && entries[0]?.[0] === "request") {
      return { kind: "attention", instanceId, requestId: requireRequestId(entries[0][1]) };
    }
    if (entries.length !== 2 || url.searchParams.getAll("activity").length !== 1 || url.searchParams.getAll("generation").length !== 1) return undefined;
    const generation = url.searchParams.get("generation");
    if (url.searchParams.get("activity") !== "stopped" || generation === null || !/^[1-9][0-9]*$/u.test(generation)) return undefined;
    return { kind: "activity_stop", instanceId, generation: requireInteger(Number(generation), 1) };
  } catch {
    return undefined;
  }
}

export function notificationRoutePath(intent: NotificationLaunchIntent): string {
  const path = "/collab/" + requireInstanceId(intent.instanceId);
  return intent.kind === "attention"
    ? path + "?request=" + requireRequestId(intent.requestId)
    : path + "?activity=stopped&generation=" + requireInteger(intent.generation, 1);
}

function parseSessionMetadata(value: unknown): SessionMetadata {
  const record = requireRecord(value);
  requireExactKeys(
    record,
    ["instanceId", "generation", "startedAt", "lastSeenAt", "canView", "canControl"],
    ["title", "cwdLabel", "model", "inputRequired", "ask", "busy", "qualificationPushAlias"],
  );
  if (
    typeof record.canView !== "boolean" ||
    typeof record.canControl !== "boolean" ||
    (record.inputRequired !== undefined && typeof record.inputRequired !== "boolean") ||
    (Object.hasOwn(record, "busy") && typeof record.busy !== "boolean")
  ) {
    throw new ProtocolValidationError();
  }
  const title = optionalLabel(record.title);
  const cwdLabel = optionalLabel(record.cwdLabel);
  const model = optionalLabel(record.model);
  let ask: SessionMetadata["ask"];
  if (record.ask !== undefined) {
    const askRecord = requireRecord(record.ask);
    requireExactKeys(askRecord, ["requestId", "since"], ["preview", "optionCount"]);
    const preview = optionalLabel(askRecord.preview);
    const optionCount =
      askRecord.optionCount === undefined ? undefined : requireInteger(askRecord.optionCount, 1, 128);
    ask = {
      requestId: requireRequestId(askRecord.requestId),
      since: requireDateTime(askRecord.since),
      ...(preview === undefined ? {} : { preview }),
      ...(optionCount === undefined ? {} : { optionCount }),
    };
  }
  const inputRequired = record.inputRequired ?? false;
  if ((inputRequired && ask === undefined) || (!inputRequired && ask !== undefined)) {
    throw new ProtocolValidationError();
  }
  if (Object.hasOwn(record, "qualificationPushAlias") && ask === undefined) throw new ProtocolValidationError();
  const qualificationPushAlias = Object.hasOwn(record, "qualificationPushAlias") ? requireInteger(record.qualificationPushAlias, 1) : undefined;
  return {
    instanceId: requireInstanceId(record.instanceId),
    generation: requireInteger(record.generation, 1),
    ...(title === undefined ? {} : { title }),
    ...(cwdLabel === undefined ? {} : { cwdLabel }),
    ...(model === undefined ? {} : { model }),
    startedAt: requireDateTime(record.startedAt),
    lastSeenAt: requireDateTime(record.lastSeenAt),
    canView: record.canView,
    canControl: record.canControl,
    inputRequired,
    ...(record.busy === undefined ? {} : { busy: record.busy as boolean }),
    ...(ask === undefined ? {} : { ask }),
    ...(qualificationPushAlias === undefined ? {} : { qualificationPushAlias }),
  };
}

function parseSessionArray(value: unknown): readonly SessionMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) throw new ProtocolValidationError();
  return value.map(parseSessionMetadata);
}

export function parseSessionListResponse(value: unknown): SessionListResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["revision", "sessions"]);
  return {
    revision: requireInteger(record.revision, 0),
    sessions: parseSessionArray(record.sessions),
  };
}

export function parseSessionEvent(value: unknown): SessionEvent {
  const record = requireRecord(value);
  if (record.type === "snapshot") {
    requireExactKeys(record, ["type", "revision", "sessions"]);
    return {
      type: "snapshot",
      revision: requireInteger(record.revision, 0),
      sessions: parseSessionArray(record.sessions),
    };
  }
  if (record.type === "session_upsert") {
    requireExactKeys(record, ["type", "revision", "session"]);
    return {
      type: "session_upsert",
      revision: requireInteger(record.revision, 0),
      session: parseSessionMetadata(record.session),
    };
  }
  if (record.type === "session_remove") {
    requireExactKeys(record, ["type", "revision", "instanceId", "generation"]);
    return {
      type: "session_remove",
      revision: requireInteger(record.revision, 0),
      instanceId: requireInstanceId(record.instanceId),
      generation: requireInteger(record.generation, 1),
    };
  }
  throw new ProtocolValidationError();
}

export function parseLaunchResponse(value: unknown): LaunchResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["mode", "generation", "capability"]);
  if (record.mode !== "view" && record.mode !== "control") throw new ProtocolValidationError();
  return {
    mode: record.mode,
    generation: requireInteger(record.generation, 1),
    capability: SecretCapability.from(record.capability).reveal(),
  };
}

const LOOPBACK_HOSTNAMES: Readonly<Record<string, true>> = { "127.0.0.1": true, "[::1]": true };

/**
 * A gateway origin the browser may contact directly. Only the canonical `URL.origin` spelling is
 * accepted, so credentials, paths, queries, fragments, default ports, and case variants are all
 * rejected rather than silently aliased. HTTPS is required except for loopback development
 * origins, which only a `dev-localhost` gateway ever publishes.
 */
export function parseFleetOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new ProtocolValidationError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProtocolValidationError();
  }
  if (url.origin !== value) throw new ProtocolValidationError();
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && LOOPBACK_HOSTNAMES[url.hostname] === true) return value;
  throw new ProtocolValidationError();
}

export function parseFleetSourceId(value: unknown): string {
  if (typeof value !== "string" || !FLEET_SOURCE_ID_PATTERN.test(value)) throw new ProtocolValidationError();
  return value;
}

export function parseSessionCreationUuid(value: unknown): string {
  if (typeof value !== "string" || !SESSION_CREATION_UUID_PATTERN.test(value)) throw new ProtocolValidationError();
  return value;
}

function creationRecord(value: unknown, bound: number): JsonRecord {
  const record = requireRecord(value);
  try {
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > bound) throw new ProtocolValidationError();
  } catch {
    throw new ProtocolValidationError();
  }
  return record;
}

function creationChoices<T extends SessionCreationChoice>(
  value: unknown, maximum: number, parse: (value: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) throw new ProtocolValidationError();
  const ids = new Set<string>();
  return value.map((entry) => {
    const parsed = parse(entry);
    if (ids.has(parsed.id)) throw new ProtocolValidationError();
    ids.add(parsed.id);
    return parsed;
  });
}

function creationChoice(value: unknown): SessionCreationChoice {
  const record = requireRecord(value);
  requireExactKeys(record, ["id", "label"]);
  return { id: parseFleetSourceId(record.id), label: parseFleetLabel(record.label) };
}

export function parseSessionCreationOptions(value: unknown): SessionCreationOptions {
  const record = creationRecord(value, MAX_SESSION_CREATION_OPTIONS_BYTES);
  requireExactKeys(record, ["version", "revision", "available", "projects", "profiles"],
    record.available === false ? ["reason"] : []);
  if (record.version !== SESSION_CREATION_VERSION) throw new ProtocolValidationError();
  const revision = parseSessionCreationUuid(record.revision);
  if (record.available === false) {
    if (!["not_configured", "tern_unavailable", "configuration_unavailable", "ledger_unavailable"].includes(record.reason as string) ||
        !Array.isArray(record.projects) || record.projects.length !== 0 ||
        !Array.isArray(record.profiles) || record.profiles.length !== 0) throw new ProtocolValidationError();
    return { version: 1, revision, available: false,
      reason: record.reason as Extract<SessionCreationOptions, { available: false }>["reason"], projects: [], profiles: [] };
  }
  if (record.available !== true) throw new ProtocolValidationError();
  const projects = creationChoices(record.projects, MAX_SESSION_CREATION_PROJECTS, (value) => {
    const project = requireRecord(value);
    requireExactKeys(project, ["id", "label", "workingCopies"]);
    return { id: parseFleetSourceId(project.id), label: parseFleetLabel(project.label),
      workingCopies: creationChoices(project.workingCopies, MAX_SESSION_CREATION_WORKING_COPIES, creationChoice) };
  });
  return { version: 1, revision, available: true, projects,
    profiles: creationChoices(record.profiles, MAX_SESSION_CREATION_PROFILES, creationChoice) };
}

export function parseSessionCreationRequest(value: unknown): SessionCreationRequest {
  const record = creationRecord(value, MAX_SESSION_CREATION_REQUEST_BYTES);
  requireExactKeys(record, ["clientOperationId", "revision", "projectId", "workingCopyId", "profileId"]);
  return { clientOperationId: parseSessionCreationUuid(record.clientOperationId), revision: parseSessionCreationUuid(record.revision),
    projectId: parseFleetSourceId(record.projectId), workingCopyId: parseFleetSourceId(record.workingCopyId),
    profileId: parseFleetSourceId(record.profileId) };
}

function creationState(value: unknown): SessionCreationState {
  if (!SESSION_CREATION_STATES.includes(value as SessionCreationState)) throw new ProtocolValidationError();
  return value as SessionCreationState;
}

export function parseSessionCreationReceipt(value: unknown): SessionCreationReceipt {
  const record = creationRecord(value, MAX_SESSION_CREATION_STATUS_BYTES);
  requireExactKeys(record, ["operationId", "state"]);
  return { operationId: parseSessionCreationUuid(record.operationId), state: creationState(record.state) };
}

export function parseSessionCreationStatus(value: unknown): SessionCreationStatus {
  const record = creationRecord(value, MAX_SESSION_CREATION_STATUS_BYTES);
  const state = creationState(record.state);
  const terminal = Object.hasOwn(SESSION_CREATION_ERRORS, state);
  requireExactKeys(record, ["operationId", "state", "updatedAt",
    ...(state === "ready" ? ["session"] : terminal ? ["error"] : [])]);
  const operationId = parseSessionCreationUuid(record.operationId);
  const updatedAt = requireDateTime(record.updatedAt);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(updatedAt) ||
      new Date(updatedAt).toISOString() !== updatedAt) throw new ProtocolValidationError();
  if (state === "ready") {
    const session = requireRecord(record.session);
    requireExactKeys(session, ["instanceId", "generation"]);
    return { operationId, state, updatedAt,
      session: { instanceId: requireInstanceId(session.instanceId), generation: requireInteger(session.generation, 1) } };
  }
  if (terminal) {
    const errors: readonly string[] = SESSION_CREATION_ERRORS[state as keyof typeof SESSION_CREATION_ERRORS];
    if (typeof record.error !== "string" || !errors.includes(record.error)) throw new ProtocolValidationError();
    return { operationId, state, updatedAt, error: record.error } as SessionCreationStatus;
  }
  return { operationId, state, updatedAt } as SessionCreationStatus;
}

/** Operator-authored display text: NFC, control and bidi characters stripped, 1..64 code points. */
export function parseFleetLabel(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolValidationError();
  const normalized = value.normalize("NFC").replace(DISALLOWED_LABEL_PATTERN, "").trim();
  const length = [...normalized].length;
  if (length === 0 || length > MAX_FLEET_LABEL_CODEPOINTS) throw new ProtocolValidationError();
  return normalized;
}

function parseFleetSource(value: unknown): FleetSource {
  const record = requireRecord(value);
  requireExactKeys(record, ["id", "label", "origin"]);
  return {
    id: parseFleetSourceId(record.id),
    label: parseFleetLabel(record.label),
    origin: parseFleetOrigin(record.origin),
  };
}

/**
 * `GET /api/v1/client-config`. Strict like every gateway-owned wire: the browser must not guess a
 * fleet from a response it does not fully understand. Targets are unique by id and by origin and
 * never reuse the local identity, so a session reference can bind to exactly one source.
 */
export function parseClientConfigResponse(value: unknown): ClientConfigResponse {
  const record = requireRecord(value);
  requireExactKeys(record, ["version", "local", "targets", "speech"]);
  if (record.version !== CLIENT_CONFIG_VERSION) throw new ProtocolValidationError();
  const local = parseFleetSource(record.local);
  if (local.id !== LOCAL_FLEET_SOURCE_ID) throw new ProtocolValidationError();
  if (!Array.isArray(record.targets) || record.targets.length > MAX_FLEET_TARGETS) {
    throw new ProtocolValidationError();
  }
  const ids = new Set([local.id]);
  const origins = new Set([local.origin]);
  const targets = record.targets.map((entry) => {
    const target = parseFleetSource(entry);
    if (ids.has(target.id) || origins.has(target.origin)) throw new ProtocolValidationError();
    ids.add(target.id);
    origins.add(target.origin);
    return target;
  });
  const speech = requireRecord(record.speech);
  requireExactKeys(speech, ["browserRecognition"]);
  if (typeof speech.browserRecognition !== "boolean") throw new ProtocolValidationError();
  return { version: CLIENT_CONFIG_VERSION, local, targets, speech: { browserRecognition: speech.browserRecognition } };
}

/**
 * Projects one observed host onto the browser-safe directory record. `canView` is unconditional:
 * every published host answers a `view` link request, while `control` depends on how the session
 * was shared. No capability is involved — those are fetched per launch, straight from the host.
 */
export function sessionMetadataFromObserved(
  input: ObservedSessionInput,
  lastSeenAt: string,
): { metadata: SessionMetadata; immutableIdentity: string } {
  return {
    metadata: {
      instanceId: input.instanceId,
      generation: input.generation,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.cwdLabel === undefined ? {} : { cwdLabel: input.cwdLabel }),
      ...(input.model === undefined ? {} : { model: input.model }),
      startedAt: input.startedAt,
      lastSeenAt,
      canView: true,
      canControl: input.canControl,
      inputRequired: input.inputRequired,
      ...(input.busy === undefined ? {} : { busy: input.busy }),
    },
    immutableIdentity: `${input.pid}\0${input.sessionId}\0${input.startedAt}`,
  };
}
