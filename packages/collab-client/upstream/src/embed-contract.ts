export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

/**
 * `forbidden` is a readable authorization loss from the selected gateway (a 403 the browser could
 * read). It is terminal for automatic recovery: no relay refresh and no probe retry follow it.
 */
export type PathHealthState = "checking" | "healthy" | "degraded" | "unreachable" | "forbidden";

export type GatewayProbeResult = "healthy" | "unavailable" | "forbidden";

export interface PathHealth {
	state: PathHealthState;
	rttMs: number | null;
	lastSuccessAt: number | null;
	failureSince: number | null;
	retryAt: number | null;
}

export interface CollabEmbedState {
	phase: ConnectionPhase;
	endedReason: string | null;
	requestPending: boolean;
	responsePending: boolean;
	/** Snapshot counters only; null before a client exists or outside a snapshot download. */
	loading: { received: number; total: number } | null;
	gatewayHealth: PathHealth;
	relayHealth: PathHealth;
}

export interface CollabEmbedOptions {
	focusPendingRequest?: boolean;
	shellOwnsLifecycle?: boolean;
	onStateChange?(state: CollabEmbedState): void;
	/** Drains a volatile ordinary prompt draft once, only when Composer can safely accept it. */
	takeInitialPromptDraft?: () => string | undefined;
	/**
	 * Reachability probe for the gateway this session was launched from. The host shell supplies
	 * it for every embed, pointing at the selected source's authenticated metadata GET; absent, the
	 * client probes same-origin `/api/v1/health`. The callback must honor `signal` and resolve
	 * `healthy` only for a valid metadata response, never for an arbitrary 2xx.
	 */
	probeGateway?(signal: AbortSignal): Promise<GatewayProbeResult>;
	/**
	 * The home document's `speech.browserRecognition` opt-in. Default false. Enables the in-page
	 * Web Speech recognizer in live, writable Control composers only; the document's
	 * Permissions-Policy must already allow `microphone=(self)`.
	 */
	browserRecognitionEnabled?: boolean;
}
