import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient } from "./lib/client";
import { installBrowserConnectionRecovery } from "./lib/browser-recovery";
import type { CollabEmbedOptions, CollabEmbedState, PathHealth } from "./embed-contract";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";

interface Creds {
	link: string;
	name: string;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}
const UNKNOWN_PATH_HEALTH: PathHealth = {
	state: "checking",
	rttMs: null,
	lastSuccessAt: null,
	failureSince: null,
	retryAt: null,
};



export interface AppProps {
	capability: string;
	onDispose(): void;
	embedOptions?: CollabEmbedOptions;
}

export function App({ capability, onDispose, embedOptions }: AppProps): ReactNode {
	const shellOwnsLifecycle = embedOptions?.shellOwnsLifecycle === true;
	const [initialConnection] = useState(() => {
		if (!shellOwnsLifecycle) return undefined;
		const name = storedName();
		try {
			return {
				client: new GuestClient(capability, name),
				creds: { link: capability, name } satisfies Creds,
				error: null,
			};
		} catch {
			return {
				client: null,
				creds: null,
				error: "Unable to open this collaboration session.",
			};
		}
	});
	const [client, setClient] = useState<GuestClient | null>(initialConnection?.client ?? null);
	const [connectError, setConnectError] = useState<string | null>(initialConnection?.error ?? null);
	const credsRef = useRef<Creds | null>(initialConnection?.creds ?? null);

	const connect = useCallback((link: string, name: string): void => {
		let next: GuestClient;
		try {
			next = new GuestClient(link, name);
		} catch {
			setConnectError("Unable to open this collaboration session.");
			return;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link, name };
		setConnectError(null);
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	const leave = useCallback((): void => {
		setClient(prev => {
			prev?.close();
			return null;
		});
		credsRef.current = null;
		onDispose();
		window.location.replace("/");
	}, [onDispose]);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	useEffect(() => {
		if (initialConnection === undefined) {
			connect(capability, storedName());
		} else if (initialConnection.client !== null) {
			initialConnection.client.connect();
			try {
				localStorage.setItem(NAME_KEY, initialConnection.creds.name);
			} catch {
				// storage unavailable (private mode) — non-fatal
			}
		}
		return () => {
			credsRef.current = null;
			setClient(current => {
				current?.close();
				return null;
			});
		};
	}, [capability, connect, initialConnection]);

	useEffect(() => {
		if (!client || client.getSnapshot().phase === "ended") return;
		const disposeRecovery = installBrowserConnectionRecovery(
			() => client.refreshConnection(),
			undefined,
			health => client.setGatewayHealth(health),
			() => client.remeasureRelay(),
			paused => client.setRelayProbesPaused(paused),
			embedOptions?.probeGateway,
		);
		let unsubscribe = (): void => {};
		const stop = (): void => {
			unsubscribe();
			disposeRecovery();
		};
		unsubscribe = client.subscribe(() => {
			if (client.getSnapshot().phase === "ended") stop();
		});
		return stop;
	}, [client, embedOptions?.probeGateway]);

	useEffect(() => {
		if (!client) document.title = "OMP collaboration";
	}, [client]);

	useEffect(() => {
		if (client !== null) return;
		embedOptions?.onStateChange?.({
			phase: connectError === null ? "connecting" : "ended",
			endedReason: connectError,
			requestPending: false,
			responsePending: false,
			gatewayHealth: UNKNOWN_PATH_HEALTH,
			relayHealth: UNKNOWN_PATH_HEALTH,
		});
	}, [client, connectError, embedOptions]);

	if (!client) {
		if (shellOwnsLifecycle) return null;
		return (
			<main className="co-connect">
				<h1>{connectError ? "Session unavailable" : "Connecting…"}</h1>
				<p>{connectError ?? "Opening the encrypted OMP collaboration client."}</p>
				<button type="button" onClick={leave}>Return to sessions</button>
			</main>
		);
	}
	return <Session client={client} onLeave={leave} onRejoin={rejoin} embedOptions={embedOptions} />;
}

interface SessionProps {
	client: GuestClient;
	onLeave(): void;
	onRejoin(): void;
	embedOptions?: CollabEmbedOptions;
}

export function Session({ client, onLeave, onRejoin, embedOptions }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const embedded = embedOptions?.shellOwnsLifecycle === true;
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const focusedRequestRef = useRef<number | null>(null);

	useLayoutEffect(() => {
		const publish = (): void => {
			const current = client.getSnapshot();
			embedOptions?.onStateChange?.({
				phase: current.phase,
				endedReason: current.endedReason,
				requestPending: current.uiRequest !== null,
				responsePending: current.uiResponsePending,
				gatewayHealth: current.gatewayHealth,
				relayHealth: current.relayHealth,
			});
		};
		publish();
		return client.subscribe(publish);
	}, [client, embedOptions]);

	useLayoutEffect(() => {
		const requestId = snap.uiRequest?.reqId;
		if (
			embedOptions?.focusPendingRequest !== true ||
			requestId === undefined ||
			focusedRequestRef.current === requestId
		) {
			return;
		}
		const composer = document.querySelector<HTMLElement>(".sh-composer-ask");
		if (composer === null) return;
		focusedRequestRef.current = requestId;
		composer.scrollIntoView({ block: "end" });
		composer
			.querySelector<HTMLElement>("button:not([disabled]), textarea:not([disabled]), input:not([disabled])")
			?.focus({ preventScroll: true });
	}, [embedOptions?.focusPendingRequest, snap.uiRequest?.reqId]);
	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// The gateway shell is the complete mobile chrome. Its embedded client keeps
	// agent drill-downs from transcript cards, but never opens a competing rail.
	useEffect(() => {
		if (!embedded && subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [embedded, subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;

	return (
		<div className="sh-app" data-embedded={embedded ? "true" : undefined}>
			{!embedded && <div className="sh-ambient" />}
			{!embedded && (
				<HeaderBar
					snapshot={snap}
					subCount={subCount}
					railOpen={railOpen}
					onToggleRail={() => setRailOpen(open => !open)}
					onLeave={onLeave}
				/>
			)}
			<main className="sh-main">
				<section
					className="sh-panel"
					data-rail={!embedded && railOpen ? "true" : "false"}
					data-embedded-ask={embedded && snap.uiRequest !== null ? "true" : "false"}
				>
					{embedded && snap.uiRequest !== null ? (
						<div className="sh-embedded-body">
							<div className="sh-transcript">
								<Transcript
										entries={snap.entries}
										stream={snap.stream}
										streamDone={snap.streamDone}
										activeTools={snap.activeTools}
										working={snap.working}
										host={toolHost}
										phase={snap.phase}
										suppressAskTool
									/>
							</div>
							<Composer client={client} snapshot={snap} embedded browserRecognitionEnabled={embedOptions?.browserRecognitionEnabled === true} />
						</div>
					) : (
						<div className="sh-transcript">
							<Transcript
									entries={snap.entries}
									stream={snap.stream}
									streamDone={snap.streamDone}
									activeTools={snap.activeTools}
									working={snap.working}
									host={toolHost}
									phase={snap.phase}
								/>
						</div>
					)}
					{(!embedded || snap.uiRequest === null) && (
						<Composer client={client} snapshot={snap} embedded={embedded} browserRecognitionEnabled={embedOptions?.browserRecognitionEnabled === true} />
					)}
				</section>
				{!embedded && railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
			{!embedded && (
				<Banners phase={snap.phase} endedReason={snap.endedReason} loading={snap.loading} onRejoin={onRejoin} onNewLink={onLeave} />
			)}
			<Toasts notices={snap.notices} />
		</div>
	);
}
