import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { Composer } from "../upstream/src/components/shell/Composer";
import { insertSpeechText } from "../upstream/src/components/shell/SpeechInput";
import type { GuestClient, GuestSnapshot } from "../upstream/src/lib/client";
import { SPEECH_MESSAGES, type NativeSpeechEvent, type NativeSpeechRecognition } from "../upstream/src/lib/speech-recognition";
import { click, dispatch, installDomGlobals, mount, query, queryAll, restoreDomGlobals, textOf, unmountAll, type MiniDocument, type MiniElement, type MountedTree } from "./react-dom-harness";

const instances: FakeRecognition[] = [];
class FakeRecognition implements NativeSpeechRecognition {
	lang = ""; continuous = false; interimResults = false; maxAlternatives = 0;
	onstart: (() => void) | null = null;
	onresult: ((event: NativeSpeechEvent) => void) | null = null;
	onerror: ((event: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	starts = 0; stops = 0; aborts = 0;
	constructor() { instances.push(this); }
	start(): void { this.starts++; }
	stop(): void { this.stops++; }
	abort(): void { this.aborts++; }
	result(text: string): void { this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); }
}

function snapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
	return {
		phase: "live", endedReason: null, header: null, entries: [], state: null, agents: [],
		progress: new Map(), lifecycle: new Map(), stream: null, streamDone: false, activeTools: new Map(),
		working: false, readOnly: false, uiRequest: null, uiResponsePending: false,
		gatewayHealth: { state: "healthy", rttMs: 20, lastSuccessAt: 0, failureSince: null, retryAt: null },
		relayHealth: { state: "healthy", rttMs: 20, lastSuccessAt: 0, failureSince: null, retryAt: null },
		notices: [], loading: null, ...overrides,
	};
}

function harness(initial = snapshot(), enabled = true) {
	const prompts: unknown[][] = [];
	const responses: unknown[][] = [];
	const client = {
		sendPrompt: (...args: unknown[]) => prompts.push(args),
		sendUiResponse: (...args: unknown[]) => responses.push(args),
		sendAbort: () => {},
	} as unknown as GuestClient;
	return {
		prompts, responses,
		node: (next = initial, flag = enabled) => createElement(Composer, { client, snapshot: next, browserRecognitionEnabled: flag, embedded: true }),
	};
}

async function start(tree: MountedTree): Promise<FakeRecognition> {
	await click(query(tree.container, "sh-speech-start")!);
	const confirm = query(tree.container, "sh-speech-confirm");
	if (confirm) await click(confirm);
	return instances.at(-1)!;
}

async function review(native: FakeRecognition, text = "dictated text"): Promise<void> {
	await act(async () => { native.onstart?.(); native.result(text); native.onend?.(); });
}

async function type(node: MiniElement, value: string): Promise<void> {
	node.value = value;
	node.setSelectionRange(value.length, value.length);
	await dispatch(node, "input");
}

beforeEach(() => {
	installDomGlobals();
	instances.length = 0;
	Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
	Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeRecognition });
	(document as unknown as MiniDocument).visibilityState = "visible";
});
afterEach(async () => {
	await unmountAll();
	Reflect.deleteProperty(window, "SpeechRecognition");
	Reflect.deleteProperty(window, "webkitSpeechRecognition");
	Reflect.deleteProperty(window, "isSecureContext");
});
afterAll(restoreDomGlobals);

describe("Control composer speech input", () => {
	test("starts only after an explicit gesture and first-document disclosure confirmation", async () => {
		const h = harness(); const tree = await mount(h.node());
		expect(instances).toHaveLength(0);
		await click(query(tree.container, "sh-speech-start")!);
		expect(instances).toHaveLength(0);
		expect(textOf(tree.container)).toContain(SPEECH_MESSAGES.disclosure);
		await click(query(tree.container, "sh-speech-confirm")!);
		expect(instances).toHaveLength(1); expect(instances[0]!.starts).toBe(1);
		expect(query(tree.container, "sh-speech-capture")).not.toBeNull();
		expect(h.prompts).toEqual([]); expect(h.responses).toEqual([]);
	});

	test("flag off, read-only, offline and unsupported contexts hide recognition but retain Control keyboard help", async () => {
		const h = harness(); const tree = await mount(h.node(snapshot(), false));
		expect(query(tree.container, "sh-speech-start")).toBeNull();
		await click(query(tree.container, "sh-dictation-help")!);
		expect(textOf(tree.container)).toContain(SPEECH_MESSAGES.keyboard);
		await click(query(tree.container, "sh-dictation-help")!);
		expect(query(tree.container, "sh-speech-help")).toBeNull();
		for (const next of [snapshot({ readOnly: true }), snapshot({ phase: "reconnecting" }), snapshot({ phase: "ended" })]) {
			await tree.render(h.node(next)); expect(query(tree.container, "sh-speech-start")).toBeNull();
		}
		Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
		await tree.render(h.node()); expect(query(tree.container, "sh-speech-start")).toBeNull();
		expect(instances).toHaveLength(0);
	});

	test("Use text inserts at current selection without sending and requires a separate Send", async () => {
		const h = harness(); const tree = await mount(h.node());
		const draft = query(tree.container, "sh-composer-input")!;
		await type(draft, "hello old world");
		const native = await start(tree);
		expect(query(tree.container, "sh-btn-primary")!.hasAttribute("disabled")).toBeTrue();
		await review(native, "new");
		draft.setSelectionRange(6, 9);
		await click(query(tree.container, "sh-speech-use")!);
		expect(draft.value).toBe("hello new world"); expect(draft.selectionStart).toBe(9);
		expect(document.activeElement).toBe(draft as unknown as Element);
		expect(h.prompts).toEqual([]); expect(h.responses).toEqual([]);
		expect(query(tree.container, "sh-speech-review")).toBeNull();
		expect(query(tree.container, "sh-btn-primary")!.hasAttribute("disabled")).toBeFalse();
		await click(query(tree.container, "sh-btn-primary")!);
		expect(h.prompts).toEqual([["hello new world"]]);
	});

	test("review Enter is not intercepted and destination Enter never submits while speech is active", async () => {
		const h = harness(); const tree = await mount(h.node());
		const draft = query(tree.container, "sh-composer-input")!; await type(draft, "existing");
		const native = await start(tree);
		for (const phase of ["starting", "listening", "stopping", "review"]) {
			if (phase === "listening") await act(async () => { native.onstart?.(); });
			if (phase === "stopping") await click(query(tree.container, "sh-speech-stop")!);
			if (phase === "review") await review(native);
			await dispatch(draft, "keydown", { key: "Enter", keyCode: 13, which: 13 });
			expect(query(tree.container, "sh-btn-primary")!.hasAttribute("disabled")).toBeTrue();
			expect(h.prompts).toEqual([]);
		}
		const reviewInput = query(tree.container, "sh-speech-review-input")!;
		const event = await dispatch(reviewInput, "keydown", { key: "Enter", keyCode: 13, which: 13 });
		expect(event.defaultPrevented).toBeFalse();
		// The harness has no browser editing default action: apply the resulting native input explicitly.
		await type(reviewInput, "first\nsecond");
		await click(query(tree.container, "sh-speech-use")!);
		expect(draft.value).toBe("existing\nfirst\nsecond"); expect(h.prompts).toEqual([]);
	});

	test("free-text Ask uses its own review and explicit Send; SelectAsk never offers speech", async () => {
		const ask = snapshot({ uiRequest: { kind: "editor", reqId: 7, title: "Question", prefill: "existing" } });
		const h = harness(ask); const tree = await mount(h.node());
		const native = await start(tree); await review(native, "answer");
		const draft = query(tree.container, "sh-composer-input")!; draft.setSelectionRange(8, 8);
		await click(query(tree.container, "sh-speech-use")!);
		expect(draft.value).toBe("existing\nanswer"); expect(h.responses).toEqual([]);
		await click(query(tree.container, "sh-btn-primary")!);
		expect(h.responses).toEqual([[7, "existing\nanswer"]]);
		await tree.render(h.node(snapshot({ uiRequest: { kind: "select", reqId: 8, title: "Select", options: ["one"] } })));
		expect(query(tree.container, "sh-speech")).toBeNull(); expect(h.prompts).toEqual([]);
	});

	for (const [name, next] of [
		["phase leaves live", snapshot({ phase: "reconnecting" })],
		["becomes read-only", snapshot({ readOnly: true })],
		["response becomes pending", snapshot({ uiResponsePending: true })],
		["destination becomes an Ask", snapshot({ uiRequest: { kind: "editor", reqId: 4, title: "Other" } })],
	] as const) {
		test(`${name} cancels and rejects late callbacks`, async () => {
			const h = harness(); const tree = await mount(h.node()); const native = await start(tree);
			const late = native.onresult!;
			await tree.render(h.node(next));
			expect(native.aborts).toBe(1);
			await act(async () => { late({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "wrong destination" } }] }); });
			expect(query(tree.container, "sh-speech-review")).toBeNull();
			expect(h.prompts).toEqual([]); expect(h.responses).toEqual([]);
		});
	}

	test("changing Ask identity discards buffered review before a new destination can use it", async () => {
		const ask = snapshot({ uiRequest: { kind: "editor", reqId: 1, title: "One" } });
		const h = harness(ask); const tree = await mount(h.node()); const native = await start(tree);
		await review(native, "first answer");
		await tree.render(h.node(snapshot({ uiRequest: { kind: "editor", reqId: 2, title: "Two" } })));
		expect(query(tree.container, "sh-speech-review")).toBeNull();
		expect(query(tree.container, "sh-composer-input")!.value).toBe("");
		expect(h.responses).toEqual([]);
	});

	for (const event of ["visibilitychange", "pagehide", "freeze"] as const) {
		test(`${event} cancels capture without automatic restart`, async () => {
			const h = harness(); const tree = await mount(h.node()); const native = await start(tree);
			await act(async () => {
				if (event === "visibilitychange") (document as unknown as MiniDocument).visibilityState = "hidden";
				(event === "pagehide" ? window : document).dispatchEvent(new Event(event));
			});
			expect(native.aborts).toBe(1); expect(query(tree.container, "sh-speech-capture")).toBeNull();
			expect(instances).toHaveLength(1); expect(h.prompts).toEqual([]);
		});
	}

	test("unmount aborts and cannot deliver a result into a new mount", async () => {
		const h = harness(); const tree = await mount(h.node()); const native = await start(tree); const end = native.onend!;
		await tree.unmount(); expect(native.aborts).toBe(1);
		const next = await mount(h.node()); await act(async () => { end(); });
		expect(query(next.container, "sh-speech-review")).toBeNull(); expect(h.prompts).toEqual([]);
	});

	test("denial preserves the existing draft, offers fixed keyboard guidance and never restarts", async () => {
		const h = harness(); const tree = await mount(h.node()); const draft = query(tree.container, "sh-composer-input")!;
		await type(draft, "typed draft"); const native = await start(tree);
		await act(async () => { native.onerror?.({ error: "not-allowed" }); });
		expect(draft.value).toBe("typed draft"); expect(textOf(tree.container)).toContain(SPEECH_MESSAGES.denied);
		expect(instances).toHaveLength(1); expect(h.prompts).toEqual([]);
	});

	test("Cancel and Discard never alter the existing draft; photo controls remain available after discard", async () => {
		const h = harness(); const tree = await mount(h.node()); const draft = query(tree.container, "sh-composer-input")!;
		await type(draft, "keep"); await start(tree); await click(query(tree.container, "sh-speech-cancel")!);
		expect(draft.value).toBe("keep");
		const native = await start(tree); await review(native); await click(query(tree.container, "sh-speech-discard")!);
		expect(draft.value).toBe("keep"); expect(h.prompts).toEqual([]);
		await click(query(tree.container, "sh-photo-trigger")!);
		expect(queryAll(tree.container, "sh-photo-source-option")).toHaveLength(2);
	});

	test("insertion appends a newline only at a nonempty end selection", () => {
		expect(insertSpeechText("draft", "speech", 5, 5)).toEqual({ text: "draft\nspeech", caret: 12 });
		expect(insertSpeechText("draft", "speech", 0, 5)).toEqual({ text: "speech", caret: 6 });
		expect(insertSpeechText("", "speech", 0, 0)).toEqual({ text: "speech", caret: 6 });
	});
});
