import { describe, expect, it, vi } from "bun:test";
import type { AgentSnapshot, AssistantMessage, HostFrame, SessionEntry, SessionHeader, SessionState, SubagentProgressPayload, WireMessage } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../upstream/src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../upstream/src/lib/link";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };

const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

const AGENTS: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	},
];

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test/model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageEntry(id: string, message: WireMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-06-12T00:00:01Z", message };
}

function welcomeFrame(entryCount = 0, readOnly?: boolean): HostFrame {
	return { t: "welcome", proto: COLLAB_PROTO, header: HEADER, state: STATE, agents: AGENTS, entryCount, ...(readOnly === undefined ? {} : { readOnly }) };
}

function snapshotChunk(entries: SessionEntry[], final = true): HostFrame {
	return { t: "snapshot-chunk", entries, final };
}

function liveClient(entries: SessionEntry[] = []): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest(welcomeFrame(entries.length));
	if (entries.length > 0) client.applyFrameForTest(snapshotChunk(entries));
	return client;
}

describe("upstream render coalescing and bus retention", () => {
	it("publishes streaming frames once per animation frame and flushes them with the next immediate frame", () => {
		vi.useFakeTimers();
		try {
			const client = liveClient();
			let commits = 0;
			client.subscribe(() => commits++);
			for (const text of ["a", "ab", "abc"]) {
				client.applyFrameForTest(
					{ t: "event", event: { type: "message_update", message: assistantMessage(text) } },
					{ flush: false },
				);
			}
			expect(commits).toBe(0);
			expect(client.getSnapshot().stream).toBeNull();

			vi.advanceTimersByTime(16);
			expect(commits).toBe(1);
			expect(client.getSnapshot().stream).toEqual(assistantMessage("abc"));

			client.applyFrameForTest(
				{ t: "event", event: { type: "message_update", message: assistantMessage("abcd") } },
				{ flush: false },
			);
			client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } }, { flush: false });
			expect(commits).toBe(2);
			expect(client.getSnapshot().stream).toEqual(assistantMessage("abcd"));
			vi.advanceTimersByTime(16);
			expect(commits).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("prunes subagent progress once the host stops listing the agent", () => {
		const client = liveClient();
		const payload = (id: string): SubagentProgressPayload => ({
			index: 0,
			agent: "task",
			task: "t",
			progress: {
				index: 0,
				id,
				agent: "task",
				status: "running",
				task: "t",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			},
		});
		const sub: AgentSnapshot = { ...AGENTS[0]!, id: "Sub1", kind: "sub" };
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload("Sub1") });
		// Progress may outrun its agent's first listing: one unlisted `agents` frame keeps it.
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);
		client.applyFrameForTest({ t: "agents", agents: [...AGENTS, sub] });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);

		const before = client.getSnapshot().progress;
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);
		expect(client.getSnapshot().progress).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(false);
		expect(client.getSnapshot().progress).not.toBe(before);
	});

});
