/** Browser speech is optional. These structural types deliberately do not augment browser globals. */
export interface NativeSpeechResult {
	readonly isFinal: boolean;
	readonly [index: number]: { readonly transcript: string } | undefined;
}
export interface NativeSpeechEvent {
	readonly resultIndex: number;
	readonly results: { readonly length: number; readonly [index: number]: NativeSpeechResult | undefined };
}
export interface NativeSpeechRecognition {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	onstart: (() => void) | null;
	onresult: ((event: NativeSpeechEvent) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}
export type SpeechRecognitionConstructor = new () => NativeSpeechRecognition;
export interface SpeechWindow {
	readonly isSecureContext?: boolean;
	readonly SpeechRecognition?: SpeechRecognitionConstructor;
	readonly webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
export function speechRecognitionConstructor(window: SpeechWindow): SpeechRecognitionConstructor | undefined {
	return window.isSecureContext === true ? window.SpeechRecognition ?? window.webkitSpeechRecognition : undefined;
}

export const SPEECH_MESSAGES = {
	keyboard: "Use your keyboard's microphone key to dictate into this box. iPhone: Settings → General → Keyboard → Enable Dictation. Dictation never sends — tap Send when the text is right.",
	disclosure: "Your browser or OS may send audio to its speech provider before any OMP prompt is sent.",
	denied: "Microphone access was denied. Use keyboard dictation or check your browser's microphone permission.",
	noSpeech: "No speech was detected. Try again or use keyboard dictation.",
	audio: "No microphone is available. Check your microphone or use keyboard dictation.",
	network: "The speech provider could not be reached. Try again or use keyboard dictation.",
	language: "This language is not supported for browser speech. Use keyboard dictation.",
	unavailable: "Browser speech could not start or continue. Try again or use keyboard dictation.",
	startTimeout: "Browser speech did not start in time. Try again or use keyboard dictation.",
	stopTimeout: "Browser speech did not finish in time. Review the buffered text or use keyboard dictation.",
	limit: "Speech text was truncated at the review limit. Review it before using it.",
	captureLimit: "The two-minute recording limit was reached. Review the text before using it.",
} as const;

export function speechErrorMessage(error: string): string {
	switch (error) {
		case "not-allowed":
		case "service-not-allowed": return SPEECH_MESSAGES.denied;
		case "no-speech": return SPEECH_MESSAGES.noSpeech;
		case "audio-capture": return SPEECH_MESSAGES.audio;
		case "network": return SPEECH_MESSAGES.network;
		case "language-not-supported": return SPEECH_MESSAGES.language;
		default: return SPEECH_MESSAGES.unavailable;
	}
}

export const MAX_SPEECH_SEGMENTS = 128;
export const MAX_SPEECH_CODEPOINTS = 8_000;
export const MAX_SPEECH_BYTES = 32 * 1024;
export const SPEECH_START_TIMEOUT_MS = 10_000;
export const SPEECH_CAPTURE_LIMIT_MS = 120_000;
export const SPEECH_STOP_TIMEOUT_MS = 5_000;

/** Bound before retaining text; iterating code points never slices a surrogate pair. */
export function boundSpeechText(text: string): { text: string; truncated: boolean } {
	let points = 0;
	let bytes = 0;
	let end = 0;
	for (const point of text) {
		const code = point.codePointAt(0)!;
		const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		if (points === MAX_SPEECH_CODEPOINTS || bytes + size > MAX_SPEECH_BYTES) break;
		points += 1;
		bytes += size;
		end += point.length;
	}
	return { text: text.slice(0, end), truncated: end < text.length };
}

export interface SpeechBinding {
	// The shell mounts a capability for one generation; revocation ends that live relay.
	// Mount lifetime and live/writable checks therefore bind the run to that generation.
	readonly destination: "prompt" | "ask";
	readonly requestId: number | undefined;
	readonly requestKind: string | undefined;
}
export function sameSpeechBinding(a: SpeechBinding, b: SpeechBinding): boolean {
	return a.destination === b.destination &&
		a.requestId === b.requestId && a.requestKind === b.requestKind;
}
export type SpeechPhase = "unsupported" | "idle" | "starting" | "listening" | "stopping" | "review";
export interface SpeechSnapshot {
	readonly phase: SpeechPhase;
	readonly text: string;
	readonly error: string | null;
	readonly notice: string | null;
	readonly elapsedSeconds: number;
	readonly runId: number;
}
export interface SpeechEnvironment {
	readonly Recognition: SpeechRecognitionConstructor | undefined;
	readonly language: string;
	now(): number;
	setTimeout(callback: () => void, delay: number): number;
	clearTimeout(timer: number): void;
	isCurrent(binding: SpeechBinding): boolean;
	onChange(snapshot: SpeechSnapshot): void;
}

/** One controller belongs to one mounted destination. Nothing here knows how to send a prompt. */
export class SpeechRecognitionController {
	#environment: SpeechEnvironment;
	#native: NativeSpeechRecognition | null = null;
	#binding: SpeechBinding | null = null;
	#segments: string[] = [];
	#timers = new Set<number>();
	#startTimer: number | undefined;
	#startedAt = 0;
	#disposed = false;
	#snapshot: SpeechSnapshot;

	constructor(environment: SpeechEnvironment) {
		this.#environment = environment;
		this.#snapshot = { phase: environment.Recognition ? "idle" : "unsupported", text: "", error: null, notice: null, elapsedSeconds: 0, runId: 0 };
	}
	get snapshot(): SpeechSnapshot { return this.#snapshot; }
	get busy(): boolean { return !["idle", "unsupported"].includes(this.#snapshot.phase); }

	#publish(change: Partial<SpeechSnapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...change };
		if (!this.#disposed) this.#environment.onChange(this.#snapshot);
	}
	#timer(callback: () => void, delay: number): number {
		const timer = this.#environment.setTimeout(() => {
			this.#timers.delete(timer);
			callback();
		}, delay);
		this.#timers.add(timer);
		return timer;
	}
	#detach(abort: boolean): void {
		for (const timer of this.#timers) this.#environment.clearTimeout(timer);
		this.#timers.clear();
		this.#startTimer = undefined;
		this.#segments = [];
		const native = this.#native;
		this.#native = null;
		if (!native) return;
		native.onstart = native.onresult = native.onerror = native.onend = null;
		if (abort) { try { native.abort(); } catch { /* Native shutdown is best effort after detaching. */ } }
	}
	#valid(runId: number, native: NativeSpeechRecognition): boolean {
		if (this.#disposed || runId !== this.#snapshot.runId || native !== this.#native) return false;
		if (!this.#binding || !this.#environment.isCurrent(this.#binding)) {
			this.cancel();
			return false;
		}
		return true;
	}
	#finish(abort: boolean, error: string | null = null): void {
		this.#detach(abort);
		this.#publish({ phase: "review", error, elapsedSeconds: Math.floor((this.#environment.now() - this.#startedAt) / 1000) });
	}
	start(binding: SpeechBinding): void {
		const Recognition = this.#environment.Recognition;
		if (this.#disposed || this.busy || !Recognition || !this.#environment.isCurrent(binding)) return;
		this.#binding = { ...binding };
		this.#startedAt = this.#environment.now();
		const runId = this.#snapshot.runId + 1;
		this.#publish({ phase: "starting", text: "", error: null, notice: null, elapsedSeconds: 0, runId });
		try {
			const native = new Recognition();
			this.#native = native;
			native.lang = this.#environment.language || "en-US";
			native.continuous = true;
			native.interimResults = true;
			native.maxAlternatives = 1;
			native.onstart = () => {
				if (!this.#valid(runId, native) || this.#snapshot.phase !== "starting") return;
				if (this.#startTimer !== undefined) {
					this.#environment.clearTimeout(this.#startTimer);
					this.#timers.delete(this.#startTimer);
					this.#startTimer = undefined;
				}
				this.#publish({ phase: "listening" });
			};
			native.onresult = event => {
				if (!this.#valid(runId, native)) return;
				// Native results are the authoritative indexed list, including corrected and removed indices.
				// Replace the bounded indexed prefix, never append event text to an earlier transcript.
				let text = "";
				let truncated = event.results.length > MAX_SPEECH_SEGMENTS;
				this.#segments.length = Math.min(event.results.length, MAX_SPEECH_SEGMENTS);
				for (let index = 0; index < Math.min(event.results.length, MAX_SPEECH_SEGMENTS); index += 1) {
					const segment = boundSpeechText(event.results[index]?.[0]?.transcript ?? "");
					this.#segments[index] = segment.text.trim();
					const prefix = text + (text && this.#segments[index] ? " " : "");
					const combined = boundSpeechText(prefix + this.#segments[index]);
					this.#segments[index] = combined.text.slice(prefix.length);
					text = combined.text;
					truncated ||= segment.truncated || combined.truncated;
					if (segment.truncated || combined.truncated) {
						this.#segments.length = index + 1;
						break;
					}
				}
				this.#publish({ text, ...(truncated ? { notice: SPEECH_MESSAGES.limit } : {}) });
				if (truncated) this.stop();
			};
			native.onerror = event => {
				if (!this.#valid(runId, native)) return;
				this.#finish(true, speechErrorMessage(event.error));
				if (!this.#snapshot.text) this.#publish({ phase: "idle" });
			};
			native.onend = () => { if (this.#valid(runId, native)) this.#finish(false); };
			this.#startTimer = this.#timer(() => {
				if (!this.#valid(runId, native) || this.#snapshot.phase !== "starting") return;
				this.#finish(true, SPEECH_MESSAGES.startTimeout);
				if (!this.#snapshot.text) this.#publish({ phase: "idle" });
			}, SPEECH_START_TIMEOUT_MS);
			this.#timer(() => {
				if (!this.#valid(runId, native)) return;
				this.#publish({ notice: this.#snapshot.notice ?? SPEECH_MESSAGES.captureLimit });
				this.stop();
			}, SPEECH_CAPTURE_LIMIT_MS);
			const tick = (): void => {
				if (!this.#valid(runId, native)) return;
				this.#publish({ elapsedSeconds: Math.floor((this.#environment.now() - this.#startedAt) / 1000) });
				this.#timer(tick, 1000);
			};
			this.#timer(tick, 1000);
			native.start();
		} catch {
			this.#detach(true);
			this.#publish({ phase: this.#snapshot.text ? "review" : "idle", error: SPEECH_MESSAGES.unavailable });
		}
	}
	stop(): void {
		const native = this.#native;
		const runId = this.#snapshot.runId;
		if (!native || !this.#valid(runId, native) || this.#snapshot.phase === "stopping") return;
		this.#publish({ phase: "stopping" });
		this.#timer(() => {
			if (this.#valid(runId, native)) this.#finish(true, SPEECH_MESSAGES.stopTimeout);
		}, SPEECH_STOP_TIMEOUT_MS);
		try { native.stop(); } catch { this.#finish(true, SPEECH_MESSAGES.unavailable); }
	}
	editReview(text: string): void {
		if (this.#snapshot.phase !== "review") return;
		const bounded = boundSpeechText(text);
		this.#publish({ text: bounded.text, ...(bounded.truncated ? { notice: SPEECH_MESSAGES.limit } : {}) });
	}
	/** Revalidates synchronously at the explicit Use text gesture; returns text, never sends it. */
	takeReview(): string | undefined {
		if (this.#snapshot.phase !== "review") return undefined;
		if (!this.#binding || !this.#environment.isCurrent(this.#binding)) { this.cancel(); return undefined; }
		const text = this.#snapshot.text;
		this.cancel();
		return text;
	}
	cancel(): void {
		this.#detach(true);
		this.#binding = null;
		this.#publish({ phase: this.#environment.Recognition ? "idle" : "unsupported", text: "", error: null, notice: null, elapsedSeconds: 0 });
	}
	dispose(): void {
		this.#disposed = true;
		this.cancel();
	}
}
