export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_CAPABILITY_BYTES = 8 * 1024;
export const MAX_LABEL_CODEPOINTS = 256;
export const MAX_SESSIONS = 1_000;
/**
 * OMP mints every instance identity now, so its own `COLLAB_INSTANCE_ID_PATTERN` is the contract:
 * 8-64 characters of `[a-z0-9-]`. A host is free to use the 8-character minimum, and a gateway that
 * required more would admit that host from discovery and then fail the whole directory response in
 * the browser, so every layer validates against this one value.
 */
export const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/u;
export const MAX_OMP_REGISTRY_REQUEST_BYTES = 4 * 1024;
export const MAX_OMP_REGISTRY_RESPONSE_BYTES = 64 * 1024;
export const PUSH_API_VERSION = 2 as const;
export const MAX_PUSH_ENDPOINT_BYTES = 4 * 1024;
export const MAX_PUSH_SUBSCRIPTION_BYTES = 8 * 1024;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_PUSH_PENDING_COUNT = 1_000;
/**
 * Public bootstrap contract for the PWA: this gateway's own source identity, the explicitly
 * configured remote gateways it may contact directly, and the home document's speech opt-in.
 * Versioned independently of the session wire so an older gateway (no route) and an unsupported
 * version are distinguishable to the browser.
 */
export const CLIENT_CONFIG_VERSION = 1 as const;
/** The implicit local source plus every configured remote target. */
export const MAX_FLEET_SOURCES = 8;
export const MAX_FLEET_TARGETS = MAX_FLEET_SOURCES - 1;
/** Reserved for the gateway serving the document; remote targets may never use it. */
export const LOCAL_FLEET_SOURCE_ID = "local";
export const FLEET_SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
export const MAX_FLEET_LABEL_CODEPOINTS = 64;
export const MAX_CLIENT_CONFIG_BYTES = 32 * 1024;

export const SESSION_CREATION_VERSION = 1 as const;
export const MAX_SESSION_CREATION_OPTIONS_BYTES = 64 * 1024;
export const MAX_SESSION_CREATION_REQUEST_BYTES = 4 * 1024;
export const MAX_SESSION_CREATION_STATUS_BYTES = 2 * 1024;
export const MAX_SESSION_CREATION_PROJECTS = 16;
export const MAX_SESSION_CREATION_WORKING_COPIES = 8;
export const MAX_SESSION_CREATION_PROFILES = 8;
export const SESSION_CREATION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const SESSION_CREATION_STATES = [
  "accepted", "launching", "awaiting_omp", "ready", "started_unavailable", "failed", "outcome_unknown",
] as const;
export type SessionCreationState = typeof SESSION_CREATION_STATES[number];
export type SessionCreationUnavailableReason =
  | "not_configured" | "tern_unavailable" | "configuration_unavailable" | "ledger_unavailable";
export const SESSION_CREATION_ERRORS = {
  failed: ["preflight_failed", "spawn_failed", "interrupted"],
  started_unavailable: ["adoption_timeout", "correlation_ambiguous", "control_unavailable", "interrupted"],
  outcome_unknown: ["launch_outcome_unknown", "interrupted"],
} as const;
export type SessionCreationError = typeof SESSION_CREATION_ERRORS[keyof typeof SESSION_CREATION_ERRORS][number];
export interface SessionCreationChoice {
  readonly id: string;
  readonly label: string;
}
export interface SessionCreationProject extends SessionCreationChoice {
  readonly workingCopies: readonly SessionCreationChoice[];
}
export type SessionCreationOptions = {
  readonly version: typeof SESSION_CREATION_VERSION;
  readonly revision: string;
} & ({
  readonly available: true;
  readonly projects: readonly SessionCreationProject[];
  readonly profiles: readonly SessionCreationChoice[];
} | {
  readonly available: false;
  readonly reason: SessionCreationUnavailableReason;
  readonly projects: readonly [];
  readonly profiles: readonly [];
});
export interface SessionCreationRequest {
  readonly clientOperationId: string;
  readonly revision: string;
  readonly projectId: string;
  readonly workingCopyId: string;
  readonly profileId: string;
}
export interface SessionCreationReceipt {
  readonly operationId: string;
  readonly state: SessionCreationState;
}
export type SessionCreationStatus = {
  readonly operationId: string;
  readonly updatedAt: string;
} & (
  | { readonly state: "accepted" | "launching" | "awaiting_omp" }
  | { readonly state: "ready"; readonly session: { readonly instanceId: string; readonly generation: number } }
  | { readonly state: "failed"; readonly error: typeof SESSION_CREATION_ERRORS.failed[number] }
  | { readonly state: "started_unavailable"; readonly error: typeof SESSION_CREATION_ERRORS.started_unavailable[number] }
  | { readonly state: "outcome_unknown"; readonly error: typeof SESSION_CREATION_ERRORS.outcome_unknown[number] }
);


export type LaunchMode = "view" | "control";
/**
 * Wire version of OMP's own local collaboration host registry. Mainline OMP publishes one
 * discovery file and one owner-only socket per live host; the gateway reads them. Upstream calls
 * this `COLLAB_REGISTRY_VERSION` and rejects any other value with `unsupported_protocol`.
 */
export const OMP_REGISTRY_VERSION = 1 as const;

/** Parsed `<entryId>.json` from OMP's discovery directory. Never carries a capability. */
export interface OmpDiscoveryEntry {
  /** Basename without `.json`. Fresh per publication, so a rotated room never reuses it. */
  readonly entryId: string;
  readonly version: number;
  readonly instanceId: string;
  readonly pid: number;
  /** Absolute socket or named-pipe path. OMP relocates long paths, so never derive it. */
  readonly endpoint: string;
  readonly createdAt: number;
  /** Bearer for querying this host only. Authorizes a question, never an answer. */
  readonly token: string;
}

export interface OmpHostModel {
  readonly provider: string;
  readonly id: string;
}

/** One `snapshot` answer from a live OMP host. Metadata only, by upstream's contract. */
export interface OmpHostSnapshot {
  readonly instanceId: string;
  readonly generation: number;
  readonly pid: number;
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly cwd?: string;
  readonly model?: OmpHostModel;
  readonly startedAt: number;
  readonly participants: number;
  readonly relayConnected: boolean;
  readonly inputRequired: boolean;
  /** Omitted means the host does not report activity; never infer idle from omission. */
  readonly busy?: boolean;
  readonly access: LaunchMode;
}

/** Every wire error string upstream's registry server can return. */
export type OmpRegistryErrorCode =
  | "malformed_request"
  | "unsupported_protocol"
  | "authentication_failed"
  | "snapshot_unavailable"
  | "invalid_operation"
  | "invalid_access"
  | "stale_generation"
  | "access_unavailable";

/**
 * A host the gateway observed this poll, reduced to what the directory needs. Capability-free by
 * construction: the gateway asks a host for a link only when an operator presses View or Control.
 */
export interface ObservedSessionInput {
  readonly instanceId: string;
  readonly generation: number;
  readonly pid: number;
  readonly sessionId: string;
  readonly title?: string;
  readonly cwdLabel?: string;
  readonly model?: string;
  readonly startedAt: string;
  readonly canControl: boolean;
  readonly inputRequired: boolean;
  /** Omitted means activity is unknown, not idle. */
  readonly busy?: boolean;
}

export interface SessionAskMetadata {
  readonly requestId: string;
  readonly since: string;
  readonly preview?: string;
  readonly optionCount?: number;
}

/** Browser-safe metadata. This type can never contain a collaboration capability. */
export interface SessionMetadata {
  readonly instanceId: string;
  readonly generation: number;
  readonly title?: string;
  readonly cwdLabel?: string;
  readonly model?: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly canView: boolean;
  readonly canControl: boolean;
  readonly inputRequired: boolean;
  readonly busy?: boolean;
  readonly ask?: SessionAskMetadata;
}

export interface SessionListResponse {
  readonly revision: number;
  readonly sessions: readonly SessionMetadata[];
}

export type SessionEvent =
  | { readonly type: "snapshot"; readonly revision: number; readonly sessions: readonly SessionMetadata[] }
  | { readonly type: "session_upsert"; readonly revision: number; readonly session: SessionMetadata }
  | {
      readonly type: "session_remove";
      readonly revision: number;
      readonly instanceId: string;
      readonly generation: number;
    };
export interface PushSubscriptionKeys {
  readonly p256dh: string;
  readonly auth: string;
}

export interface BrowserPushSubscription {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: PushSubscriptionKeys;
}

export type PushDetailLevel = "private" | "session" | "preview";

export interface PushSubscriptionRequest {
  readonly version: typeof PUSH_API_VERSION;
  readonly detailLevel?: PushDetailLevel;
  readonly subscription: BrowserPushSubscription;
}

export interface PushSubscriptionResponse {
  readonly version: typeof PUSH_API_VERSION;
  readonly detailLevel: PushDetailLevel;
}

export interface PushUnsubscribeRequest {
  readonly version: typeof PUSH_API_VERSION;
  readonly endpoint: string;
}

export interface PushConfigResponse {
  readonly version: typeof PUSH_API_VERSION;
  readonly applicationServerKey: string;
}

/** Capability-free message encrypted for one browser push subscription. */
export type AttentionPushMessage =
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "attention";
      readonly instanceId: string;
      readonly generation: number;
      readonly requestId: string;
      readonly pendingAskCount: number;
      readonly title: "OMP session needs attention";
      readonly body?: string;
    }
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "activity_stop";
      readonly instanceId: string;
      readonly generation: number;
      readonly pendingAskCount: number;
      readonly title: "OMP session activity stopped";
      readonly body?: string;
    }
  | {
      readonly version: typeof PUSH_API_VERSION;
      readonly type: "clear";
      readonly instanceId: string;
      readonly requestId: string;
      readonly pendingAskCount: number;
    };


/** Capability-free launch intent, revalidated against the current directory before launch. */
export type NotificationLaunchIntent =
  | { readonly kind: "attention"; readonly instanceId: string; readonly requestId: string }
  | { readonly kind: "activity_stop"; readonly instanceId: string; readonly generation: number };

export interface LaunchRequest {
  readonly mode: LaunchMode;
  readonly generation: number;
  readonly requestId?: string;
}

export interface LaunchResponse {
  readonly mode: LaunchMode;
  readonly generation: number;
  readonly capability: string;
}

export interface ProblemResponse {
  readonly code: string;
  readonly message: string;
}

/** One gateway the browser may list and launch against. Never carries credentials. */
export interface FleetSource {
  readonly id: string;
  readonly label: string;
  /** Canonical `URL.origin`: scheme, host, and non-default port only. */
  readonly origin: string;
}

export interface ClientConfigResponse {
  readonly version: typeof CLIENT_CONFIG_VERSION;
  /** The gateway serving this document; `id` is always `LOCAL_FLEET_SOURCE_ID`. */
  readonly local: FleetSource;
  /** Configured remote gateways in configuration order; the local source is not repeated. */
  readonly targets: readonly FleetSource[];
  readonly speech: {
    readonly browserRecognition: boolean;
  };
}
