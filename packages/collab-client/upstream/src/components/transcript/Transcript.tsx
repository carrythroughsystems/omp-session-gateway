import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	suppressAskTool?: boolean;
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
	/** Changes even if React batches reconnecting and live into one render. */
	liveEpoch?: number;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry (locked within 40px of the bottom). */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}

function Row({
	kind,
	gutter,
	title,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	gutter: ReactNode;
	title?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}`}>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
	suppressAskTool,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
	suppressAskTool?: boolean;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return pending ? <StreamingMarkdown key={i} text={block.text} /> : <Markdown key={i} text={block.text} />;
			case "toolCall": {
				if (suppressAskTool === true && block.name === "ask") return null;
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	suppressAskTool?: boolean;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (
		prev.entry !== next.entry ||
		prev.host !== next.host ||
		prev.suppressAskTool !== next.suppressAskTool
	) return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({ entry, results, active, host, suppressAskTool }: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row kind="user" gutter="host" title={entry.timestamp}>
							<MsgContent content={msg.content} />
						</Row>
					);
				case "assistant":
					if (
						suppressAskTool === true &&
						msg.content.every(block => block.type === "toolCall" && block.name === "ask")
					) return null;
					return (
						<Row kind="assistant" gutter="agent" title={entry.timestamp}>
							<AssistantBody
								message={msg}
								results={results}
								active={active}
								pending={false}
								host={host}
								suppressAskTool={suppressAskTool}
							/>
						</Row>
					);
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row kind="user" gutter={<span className="tr-badge">{from}</span>} title={entry.timestamp}>
						<MsgContent content={entry.content} />
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" gutter="" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

/** Entries rendered from the tail of a long transcript before any expansion. */
export const TRANSCRIPT_WINDOW = 150;
/** Older entries revealed per `Show earlier` tap. */
export const TRANSCRIPT_WINDOW_STEP = 300;

/**
 * First entry the window renders — also the count of older entries kept out of
 * the DOM. A long history arrives as one snapshot burst, so only its tail is
 * mounted; pinning the oldest mounted entry then keeps later tail appends from
 * dropping a row under a reader who scrolled up (or silently reclaiming an
 * expansion), while a tap still reaches further back.
 */
function transcriptWindowStart(
	entries: readonly SessionEntry[],
	extraCount: number,
	pinnedOldestId: string | null,
): number {
	const tail = entries.length - TRANSCRIPT_WINDOW - extraCount;
	if (tail <= 0) return 0;
	if (pinnedOldestId === null) return tail;
	const pinned = entries.findIndex(entry => entry.id === pinnedOldestId);
	return pinned >= 0 && pinned < tail ? pinned : tail;
}

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host, suppressAskTool, phase, liveEpoch } = props;

	// Include results outside the visible window for retained host transcripts.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [entries]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);

	// Windowed tail. `results` above and `committedToolIds` below still scan every
	// entry, so a windowed assistant row keeps its tool results and the active
	// tail stays exact.
	const [extraCount, setExtraCount] = useState(0);
	const pinnedOldestRef = useRef<string | null>(null);
	const start = transcriptWindowStart(entries, extraCount, pinnedOldestRef.current);
	const windowed = useMemo(() => (start === 0 ? entries : entries.slice(start)), [entries, start]);

	// Upstream's row anchor also holds when the same commit appends live entries.
	const prependRef = useRef<{ anchor: Element; offset: number } | null>(null);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) followTranscriptTail(el, lockRef);
	}, [entries, stream, activeTools, working]);

	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position. Absent for the agent drawer's compact transcript.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null) return;
		followTranscriptTail(el, lockRef, true);
	}, [phase, liveEpoch]);

	useLayoutEffect(() => {
		pinnedOldestRef.current = windowed.length === 0 ? null : windowed[0].id;
	}, [windowed]);

	// Keep the reader's content in place when earlier rows mount above it.
	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (el === null || before === null) return;
		prependRef.current = null;
		if (!before.anchor.isConnected) return;
		el.scrollTop += before.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
	}, [extraCount]);

	const revealEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start === 0 || prependRef.current !== null) return;
		const top = el.getBoundingClientRect().top;
		for (const row of el.children) {
			if (row.classList.contains("tr-earlier")) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top) continue;
			prependRef.current = { anchor: row, offset: rect.top - top };
			break;
		}
		setExtraCount(prev => prev + TRANSCRIPT_WINDOW_STEP);
	};

	// Upstream separates the committed scan from per-token stream updates.
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (suppressAskTool === true && tool.toolName === "ask") continue;
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools, suppressAskTool]);
	const visibleActiveToolCount = [...activeTools.values()].filter(
		tool => suppressAskTool !== true || tool.toolName !== "ask",
	).length;

	const settled = phase === undefined || phase === "live";

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el === null) return;
				updateTranscriptTailLock(el, lockRef);
			}}
		>
			{settled && entries.length === 0 && stream === null && !working && <div className="tr-empty">no activity yet</div>}
			{start > 0 && (
				<button type="button" className="tr-earlier" onClick={revealEarlier}>
					Show earlier · {start} more
				</button>
			)}
			{windowed.map(entry => (
				<EntryRow
					key={entry.id}
					entry={entry}
					results={results}
					active={activeTools}
					host={host}
					suppressAskTool={suppressAskTool}
				/>
			))}
			{stream !== null &&
				!(
					suppressAskTool === true &&
					stream.content.every(block => block.type === "toolCall" && block.name === "ask")
				) && (
				<Row kind="assistant" gutter="agent">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
						suppressAskTool={suppressAskTool}
					/>
				</Row>
			)}
			{tailTools.length > 0 && (
				<Row kind="assistant" gutter={stream === null ? "agent" : ""}>
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</Row>
			)}
			{working && stream === null && visibleActiveToolCount === 0 && suppressAskTool !== true && (
				<Row kind="assistant" gutter="agent">
					<div className="tr-shimmer">thinking…</div>
				</Row>
			)}
		</div>
	);
}
