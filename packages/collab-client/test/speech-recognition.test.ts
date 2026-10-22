import { describe, expect, test } from "bun:test";
import {
	MAX_SPEECH_BYTES, MAX_SPEECH_CODEPOINTS, MAX_SPEECH_SEGMENTS, SPEECH_MESSAGES,
	SpeechRecognitionController, boundSpeechText, speechErrorMessage, speechRecognitionConstructor,
	type NativeSpeechEvent, type NativeSpeechRecognition, type SpeechBinding, type SpeechSnapshot,
} from "../upstream/src/lib/speech-recognition";

const binding: SpeechBinding = { destination: "prompt", requestId: undefined, requestKind: undefined };

function harness(options: { supported?: boolean; constructorThrows?: boolean; startThrows?: boolean; language?: string } = {}) {
	const instances: FakeRecognition[] = [];
	class FakeRecognition implements NativeSpeechRecognition {
		lang = ""; continuous = false; interimResults = false; maxAlternatives = 0;
		onstart: (() => void) | null = null;
		onresult: ((event: NativeSpeechEvent) => void) | null = null;
		onerror: ((event: { error: string }) => void) | null = null;
		onend: (() => void) | null = null;
		starts = 0; stops = 0; aborts = 0;
		constructor() { if (options.constructorThrows) throw new Error("private native detail"); instances.push(this); }
		start(): void { this.starts++; if (options.startThrows) throw new Error("private native detail"); }
		stop(): void { this.stops++; }
		abort(): void { this.aborts++; }
		result(parts: string[], resultIndex = 0): void {
			this.onresult?.({ resultIndex, results: parts.map((transcript, index) => ({ isFinal: index < parts.length - 1, 0: { transcript } })) });
		}
	}
	let now = 0;
	let id = 0;
	let current = true;
	const timers = new Map<number, { at: number; callback(): void }>();
	const snapshots: SpeechSnapshot[] = [];
	const controller = new SpeechRecognitionController({
		Recognition: options.supported === false ? undefined : FakeRecognition,
		language: options.language ?? "fr-FR",
		now: () => now,
		setTimeout: (callback, delay) => { const timer = ++id; timers.set(timer, { at: now + delay, callback }); return timer; },
		clearTimeout: timer => { timers.delete(timer); },
		isCurrent: () => current,
		onChange: snapshot => snapshots.push(snapshot),
	});
	return {
		controller, instances, snapshots, timers,
		invalidate(): void { current = false; },
		advance(ms: number): void {
			const target = now + ms;
			for (;;) {
				const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > target) break;
				now = next[1].at; timers.delete(next[0]); next[1].callback();
			}
			now = target;
		},
	};
}

describe("bounded browser speech controller", () => {
	test("feature detection requires a secure context and supports the prefixed constructor", () => {
		const Recognition = class {} as unknown as new () => NativeSpeechRecognition;
		expect(speechRecognitionConstructor({ SpeechRecognition: Recognition })).toBeUndefined();
		expect(speechRecognitionConstructor({ isSecureContext: true, webkitSpeechRecognition: Recognition })).toBe(Recognition);
		expect(speechRecognitionConstructor({ isSecureContext: true, SpeechRecognition: Recognition, webkitSpeechRecognition: class {} as never })).toBe(Recognition);
		const h = harness({ supported: false });
		h.controller.start(binding);
		expect(h.controller.snapshot.phase).toBe("unsupported");
		expect(h.instances).toHaveLength(0);
	});

	test("idle → starting → listening → stopping → review → idle never restarts", () => {
		const h = harness();
		expect(h.controller.snapshot.phase).toBe("idle");
		h.controller.start(binding);
		const native = h.instances[0]!;
		expect(h.controller.snapshot.phase).toBe("starting");
		expect([native.lang, native.continuous, native.interimResults, native.maxAlternatives]).toEqual(["fr-FR", true, true, 1]);
		h.controller.start(binding);
		expect(h.instances).toHaveLength(1);
		native.onstart?.();
		expect(h.controller.snapshot.phase).toBe("listening");
		h.advance(2500);
		expect(h.controller.snapshot.elapsedSeconds).toBe(2);
		native.result(["Hello", "there"]);
		h.controller.stop();
		expect(h.controller.snapshot.phase).toBe("stopping");
		expect(native.stops).toBe(1);
		native.result(["Hello", "world"], 1);
		native.onend?.();
		expect(h.controller.snapshot).toMatchObject({ phase: "review", text: "Hello world" });
		expect(native.aborts).toBe(0);
		expect(h.timers.size).toBe(0);
		expect(h.controller.takeReview()).toBe("Hello world");
		expect(h.controller.snapshot).toMatchObject({ phase: "idle", text: "" });
		h.advance(200_000);
		expect(h.instances).toHaveLength(1);
	});

	test("corrected and removed result indices replace rather than duplicate words", () => {
		const h = harness(); h.controller.start(binding);
		const native = h.instances[0]!;
		native.result(["one", "too", "three"]);
		native.result(["one", "two", "three"], 1);
		expect(h.controller.snapshot.text).toBe("one two three");
		native.result(["one", "two"], 2);
		expect(h.controller.snapshot.text).toBe("one two");
		native.result(["one", "two"], 1);
		expect(h.controller.snapshot.text).toBe("one two");
		h.controller.dispose();
	});

	test("start watchdog aborts at ten seconds without repeated prompts", () => {
		const h = harness({ language: "" }); h.controller.start(binding);
		expect(h.instances[0]!.lang).toBe("en-US");
		h.advance(9999); expect(h.controller.snapshot.phase).toBe("starting");
		h.advance(1); expect(h.controller.snapshot).toMatchObject({ phase: "idle", error: SPEECH_MESSAGES.startTimeout });
		expect(h.instances[0]!.aborts).toBe(1);
		expect(h.timers.size).toBe(0);
	});

	test("absolute two-minute capture limit stops; five-second finalization aborts and retains text", () => {
		const h = harness(); h.controller.start(binding);
		const native = h.instances[0]!; native.onstart?.(); native.result(["buffered"]);
		h.advance(119_999); expect(native.stops).toBe(0);
		h.advance(1); expect(native.stops).toBe(1);
		expect(h.controller.snapshot.notice).toBe(SPEECH_MESSAGES.captureLimit);
		h.advance(4999); expect(native.aborts).toBe(0);
		h.advance(1); expect(native.aborts).toBe(1);
		expect(h.controller.snapshot).toMatchObject({ phase: "review", text: "buffered", error: SPEECH_MESSAGES.stopTimeout });
		expect(native.onresult).toBeNull(); expect(h.timers.size).toBe(0);
	});

	test("Stop before start acknowledgement keeps results; Cancel discards and detaches", () => {
		const h = harness(); h.controller.start(binding);
		const native = h.instances[0]!;
		h.controller.stop(); native.onstart?.();
		expect(h.controller.snapshot.phase).toBe("stopping");
		native.result(["keep"]); native.onend?.();
		expect(h.controller.snapshot.text).toBe("keep");
		h.controller.cancel(); h.controller.start(binding);
		const second = h.instances[1]!; second.result(["discard"]); h.controller.cancel();
		expect(second.stops).toBe(0); expect(second.aborts).toBe(1);
		expect(h.controller.snapshot).toMatchObject({ phase: "idle", text: "" });
	});

	test("segment and Unicode bounds stop capture and apply to manual review edits", () => {
		const h = harness(); h.controller.start(binding);
		const native = h.instances[0]!;
		native.result(Array.from({ length: MAX_SPEECH_SEGMENTS + 1 }, () => "word"));
		expect(h.controller.snapshot.text.split(" ")).toHaveLength(MAX_SPEECH_SEGMENTS);
		expect(h.controller.snapshot.notice).toBe(SPEECH_MESSAGES.limit);
		expect(native.stops).toBe(1); native.onend?.();
		h.controller.editReview("🧪".repeat(MAX_SPEECH_CODEPOINTS + 10));
		expect([...h.controller.snapshot.text]).toHaveLength(MAX_SPEECH_CODEPOINTS);
		expect(new TextEncoder().encode(h.controller.snapshot.text).length).toBeLessThanOrEqual(MAX_SPEECH_BYTES);
		expect(h.controller.snapshot.text.endsWith("🧪")).toBeTrue();
		expect(boundSpeechText("a".repeat(7999) + "🧪").truncated).toBeFalse();
		h.controller.cancel(); h.controller.start(binding);
		h.instances[1]!.result(["x".repeat(9000)]);
		expect(h.controller.snapshot.text).toHaveLength(8000);
		expect(h.instances[1]!.stops).toBe(1); h.controller.dispose();
	});

	for (const [error, message] of [
		["not-allowed", SPEECH_MESSAGES.denied], ["service-not-allowed", SPEECH_MESSAGES.denied],
		["no-speech", SPEECH_MESSAGES.noSpeech], ["audio-capture", SPEECH_MESSAGES.audio],
		["network", SPEECH_MESSAGES.network], ["language-not-supported", SPEECH_MESSAGES.language],
		["aborted", SPEECH_MESSAGES.unavailable], ["private native exception", SPEECH_MESSAGES.unavailable],
	] as const) {
		test(`maps ${error} to fixed recoverable guidance without dropping buffered text`, () => {
			const h = harness(); h.controller.start(binding); const native = h.instances[0]!;
			native.result(["preserve this"]); native.onerror?.({ error });
			expect(speechErrorMessage(error)).toBe(message);
			expect(h.controller.snapshot).toMatchObject({ phase: "review", text: "preserve this", error: message });
			expect(message).toContain("keyboard dictation");
			expect(native.aborts).toBe(1); expect(h.timers.size).toBe(0);
		});
	}

	test("constructor/start failures and empty denial remain explicitly retryable", () => {
		for (const options of [{ constructorThrows: true }, { startThrows: true }]) {
			const h = harness(options); h.controller.start(binding);
			expect(h.controller.snapshot).toMatchObject({ phase: "idle", error: SPEECH_MESSAGES.unavailable });
			expect(h.timers.size).toBe(0);
		}
		const h = harness(); h.controller.start(binding); h.instances[0]!.onerror?.({ error: "not-allowed" });
		expect(h.controller.snapshot.phase).toBe("idle"); h.advance(200_000); expect(h.instances).toHaveLength(1);
		h.controller.start(binding); expect(h.instances).toHaveLength(2); h.controller.dispose();
	});

	test("obsolete callbacks, duplicate end, invalidated bindings, and disposed lifetimes are inert", () => {
		const h = harness(); h.controller.start(binding); const native = h.instances[0]!;
		const lateResult = native.onresult!; const lateStart = native.onstart!; const lateError = native.onerror!; const lateEnd = native.onend!;
		h.controller.cancel(); h.controller.start(binding);
		lateResult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "wrong run" } }] });
		lateStart(); lateError({ error: "network" }); lateEnd();
		expect(h.controller.snapshot).toMatchObject({ phase: "starting", text: "", runId: 2 });
		const second = h.instances[1]!; const end = second.onend!; second.result(["right run"]); end(); end();
		expect(h.controller.snapshot).toMatchObject({ phase: "review", text: "right run" });
		h.invalidate(); expect(h.controller.takeReview()).toBeUndefined(); expect(h.controller.snapshot.text).toBe("");
		h.controller.dispose(); h.controller.start(binding); expect(h.instances).toHaveLength(2);
		const other = harness(); other.controller.start(binding); other.invalidate(); other.instances[0]!.onstart?.();
		expect(other.instances[0]!.aborts).toBe(1); expect(other.controller.snapshot.phase).toBe("idle");
	});
});
