import type { GatewayProbeResult } from "../embed-contract";
import type { PathHealth } from "./client";

const HEALTHY_PROBE_INTERVAL_MS = 15_000;
const DEGRADED_PROBE_INTERVAL_MS = 2_000;
const RETRY_MAX_MS = 30_000;
const INITIAL_PROBE_TIMEOUT_MS = 3_000;
const MIN_PROBE_TIMEOUT_MS = 1_500;
const MAX_PROBE_TIMEOUT_MS = 5_000;
const REFRESH_DEBOUNCE_MS = 500;

interface RecoveryEventTarget {
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
}

interface RecoveryWindow extends RecoveryEventTarget {
	clearTimeout(handle: number): void;
	setTimeout(callback: () => void, delay: number): number;
}

interface RecoveryDocument extends RecoveryEventTarget {
	readonly visibilityState: DocumentVisibilityState;
}

export interface BrowserRecoveryEnvironment {
	readonly connection: RecoveryEventTarget | undefined;
	readonly document: RecoveryDocument;
	readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	readonly now: () => number;
	readonly random?: () => number;
	readonly window: RecoveryWindow;
}

function defaultEnvironment(): BrowserRecoveryEnvironment {
	const connection = (navigator as Navigator & { readonly connection?: EventTarget }).connection;
	return {
		connection,
		document,
		fetch: (input, init) => window.fetch(input, init),
		now: Date.now,
		random: Math.random,
		window,
	};
}

const INITIAL_HEALTH: PathHealth = {
	state: "checking",
	rttMs: null,
	lastSuccessAt: null,
	failureSince: null,
	retryAt: null,
};

/**
 * Measure the selected gateway path and refresh a potentially half-open
 * relay transport after browser or radio path changes. Network APIs are only
 * triggers; HTTP probe results are the source of truth.
 */
export function installBrowserConnectionRecovery(
	refreshConnection: () => void,
	environment: BrowserRecoveryEnvironment = defaultEnvironment(),
	onHealthChange: (health: PathHealth) => void = () => {},
	remeasureRelay: () => void = refreshConnection,
	setRelayProbesPaused: (paused: boolean) => void = () => {},
	probeGateway?: (signal: AbortSignal) => Promise<GatewayProbeResult>,
): () => void {
	const isHidden = (): boolean => environment.document.visibilityState === "hidden";
	let disposed = false;
	let health = INITIAL_HEALTH;
	let consecutiveFailures = 0;
	let recoverySuccesses = 0;
	let retryAttempt = 0;
	let smoothedRtt: number | null = null;
	let rttVariance: number | null = null;
	let lastRefreshAt = Number.NEGATIVE_INFINITY;
	let probeController: AbortController | undefined;
	const supersededProbes = new WeakSet<AbortController>();
	let probeInFlight = false;
	let probeRequested = false;
	let relayCheckRequested = false;
	let probeTimer: number | undefined;

	const publish = (next: PathHealth): void => {
		health = next;
		onHealthChange(next);
	};
	const clearProbeTimer = (): void => {
		environment.window.clearTimeout(probeTimer as number);
		probeTimer = undefined;
	};
	const refresh = (): void => {
		const now = environment.now();
		if (now - lastRefreshAt < REFRESH_DEBOUNCE_MS) return;
		lastRefreshAt = now;
		refreshConnection();
	};
	const recordRtt = (rttMs: number): void => {
		if (smoothedRtt === null || rttVariance === null) {
			smoothedRtt = rttMs;
			rttVariance = rttMs / 2;
			return;
		}
		rttVariance = rttVariance * 0.75 + Math.abs(smoothedRtt - rttMs) * 0.25;
		smoothedRtt = smoothedRtt * 0.875 + rttMs * 0.125;
	};
	const probeTimeout = (): number => {
		if (smoothedRtt === null || rttVariance === null) return INITIAL_PROBE_TIMEOUT_MS;
		return Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, smoothedRtt + 4 * rttVariance));
	};
	const scheduleProbe = (delay: number, exposeRetry = false): void => {
		clearProbeTimer();
		if (disposed || isHidden()) return;
		if (exposeRetry) publish({ ...health, retryAt: environment.now() + delay });
		probeTimer = environment.window.setTimeout(() => {
			probeTimer = undefined;
			void runGatewayProbe();
		}, delay);
	};
	const scheduleNextProbe = (): void => {
		if (health.state === "forbidden") return;
		if (health.state === "healthy") {
			scheduleProbe(HEALTHY_PROBE_INTERVAL_MS);
			return;
		}
		if (health.state === "unreachable") {
			const cap = Math.min(DEGRADED_PROBE_INTERVAL_MS * 2 ** retryAttempt, RETRY_MAX_MS);
			retryAttempt++;
			scheduleProbe(Math.floor((environment.random?.() ?? Math.random()) * cap), true);
			return;
		}
		scheduleProbe(DEGRADED_PROBE_INTERVAL_MS);
	};
	const runGatewayProbe = async (): Promise<void> => {
		if (disposed || probeInFlight || isHidden()) return;
		probeInFlight = true;
		const startedAt = environment.now();
		const controller = new AbortController();
		probeController = controller;
		const timeout = environment.window.setTimeout(() => controller.abort(), probeTimeout());
		let result: GatewayProbeResult = "unavailable";
		try {
			if (probeGateway !== undefined) {
				result = await probeGateway(controller.signal);
			} else {
				const response = await environment.fetch("/api/v1/health", {
					cache: "no-store",
					credentials: "same-origin",
					signal: controller.signal,
				});
				result = response.ok ? "healthy" : "unavailable";
			}
		} catch {
			// A radio handoff can leave navigator.onLine true while this probe times out.
		} finally {
			environment.window.clearTimeout(timeout);
		}
		if (probeController !== controller) return;
		probeController = undefined;
		probeInFlight = false;
		if (disposed || isHidden()) return;
		if (supersededProbes.has(controller)) {
			const runImmediately = probeRequested;
			probeRequested = false;
			if (runImmediately) scheduleProbe(0);
			else scheduleNextProbe();
			return;
		}
		const now = environment.now();
		if (controller.signal.aborted) result = "unavailable";
		if (result === "forbidden") {
			clearProbeTimer();
			probeRequested = false;
			recoverySuccesses = 0;
			publish({
				...health,
				state: "forbidden",
				failureSince: health.failureSince ?? now,
				retryAt: null,
			});
			return;
		}
		if (result === "healthy") {
			const shouldRemeasureRelay = relayCheckRequested;
			recordRtt(Math.max(0, now - startedAt));
			consecutiveFailures = 0;
			retryAttempt = 0;
			const recovering = health.state === "degraded" || health.state === "unreachable" || health.failureSince !== null;
			if (recovering && recoverySuccesses === 0) {
				recoverySuccesses = 1;
				refresh();
				publish({
					...health,
					state: "checking",
					rttMs: Math.round(smoothedRtt ?? 0),
					lastSuccessAt: now,
					retryAt: null,
				});
			} else {
				recoverySuccesses = 0;
				if (shouldRemeasureRelay) {
					relayCheckRequested = false;
					setRelayProbesPaused(false);
				}
				publish({
					state: "healthy",
					rttMs: Math.round(smoothedRtt ?? 0),
					lastSuccessAt: now,
					failureSince: null,
					retryAt: null,
				});
				if (shouldRemeasureRelay) remeasureRelay();
			}
		} else {
			recoverySuccesses = 0;
			consecutiveFailures++;
			publish({
				...health,
				state: consecutiveFailures >= 2 ? "unreachable" : "degraded",
				failureSince: health.failureSince ?? now,
				retryAt: null,
			});
		}
		const runImmediately = probeRequested;
		probeRequested = false;
		if (runImmediately) scheduleProbe(0);
		else scheduleNextProbe();
	};
	const requestProbe = (retryForbidden = false): void => {
		if (health.state === "forbidden" && !retryForbidden) return;
		relayCheckRequested = true;
		clearProbeTimer();
		if (probeInFlight) {
			probeRequested = true;
			return;
		}
		void runGatewayProbe();
	};
	const visibilityChanged: EventListener = () => {
		if (isHidden()) {
			setRelayProbesPaused(true);
			clearProbeTimer();
			if (probeController !== undefined) supersededProbes.add(probeController);
			probeController?.abort();
			return;
		}
		requestProbe(true);
	};
	const pageShown: EventListener = () => requestProbe(true);
	const online: EventListener = () => requestProbe(true);
	const offline: EventListener = () => {
		if (probeController !== undefined) supersededProbes.add(probeController);
		probeController?.abort();
		requestProbe();
	};
	const connectionChanged: EventListener = () => requestProbe();

	environment.window.addEventListener("online", online);
	environment.window.addEventListener("offline", offline);
	environment.window.addEventListener("pageshow", pageShown);
	environment.document.addEventListener("visibilitychange", visibilityChanged);
	environment.connection?.addEventListener("change", connectionChanged);
	setRelayProbesPaused(isHidden());
	onHealthChange(health);
	scheduleProbe(0);

	return () => {
		disposed = true;
		clearProbeTimer();
		probeController?.abort();
		setRelayProbesPaused(true);
		environment.window.removeEventListener("online", online);
		environment.window.removeEventListener("offline", offline);
		environment.window.removeEventListener("pageshow", pageShown);
		environment.document.removeEventListener("visibilitychange", visibilityChanged);
		environment.connection?.removeEventListener("change", connectionChanged);
	};
}
