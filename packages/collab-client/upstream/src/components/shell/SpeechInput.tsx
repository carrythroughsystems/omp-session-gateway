import { Mic } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
	SPEECH_MESSAGES,
	SpeechRecognitionController,
	sameSpeechBinding,
	speechRecognitionConstructor,
	type SpeechBinding,
	type SpeechSnapshot,
	type SpeechWindow,
} from "../../lib/speech-recognition";

// Disclosure is document-scoped, never persisted. A new destination still needs a Start gesture.
const disclosedDocuments = new WeakSet<Document>();

interface SpeechInputOptions {
	enabled: boolean;
	binding: SpeechBinding;
	destination: RefObject<HTMLTextAreaElement | null>;
	setDraft(text: string): void;
}

export function insertSpeechText(draft: string, text: string, start: number, end: number): { text: string; caret: number } {
	const from = Math.max(0, Math.min(start, draft.length));
	const to = Math.max(from, Math.min(end, draft.length));
	const insertion = from === draft.length && to === draft.length && draft.length > 0 ? `\n${text}` : text;
	return { text: draft.slice(0, from) + insertion + draft.slice(to), caret: from + insertion.length };
}

export interface SpeechInputState {
	snapshot: SpeechSnapshot;
	disclosure: boolean;
	available: boolean;
	busy: boolean;
	isBusy(): boolean;
	start(): void;
	confirmStart(): void;
	cancelDisclosure(): void;
	stop(): void;
	cancel(): void;
	editReview(text: string): void;
	useText(): void;
}

export function useSpeechInput(options: SpeechInputOptions): SpeechInputState {
	const latest = useRef(options);
	latest.current = options;
	const mounted = useRef(false);
	const controller = useRef<SpeechRecognitionController | null>(null);
	const Recognition = speechRecognitionConstructor(window as unknown as SpeechWindow);
	const [snapshot, setSnapshot] = useState<SpeechSnapshot>({ phase: Recognition ? "idle" : "unsupported", text: "", error: null, notice: null, elapsedSeconds: 0, runId: 0 });
	const [disclosure, setDisclosure] = useState(false);
	const isCurrent = (binding: SpeechBinding): boolean => mounted.current && latest.current.enabled &&
		document.visibilityState !== "hidden" && latest.current.destination.current !== null &&
		sameSpeechBinding(binding, latest.current.binding);

	useLayoutEffect(() => {
		mounted.current = true;
		const instance = new SpeechRecognitionController({
			Recognition,
			language: navigator.language || "en-US",
			now: () => performance.now(),
			setTimeout: (callback, delay) => window.setTimeout(callback, delay),
			clearTimeout: timer => window.clearTimeout(timer),
			isCurrent,
			onChange: setSnapshot,
		});
		controller.current = instance;
		setSnapshot(instance.snapshot);
		const cancel = (): void => { instance.cancel(); setDisclosure(false); };
		const visibility = (): void => { if (document.visibilityState === "hidden") cancel(); };
		document.addEventListener("visibilitychange", visibility);
		document.addEventListener("freeze", cancel);
		window.addEventListener("pagehide", cancel);
		return () => {
			mounted.current = false;
			instance.dispose();
			controller.current = null;
			document.removeEventListener("visibilitychange", visibility);
			document.removeEventListener("freeze", cancel);
			window.removeEventListener("pagehide", cancel);
		};
	}, [Recognition]);

	useLayoutEffect(() => {
		controller.current?.cancel();
		setDisclosure(false);
	}, [options.enabled, options.binding.destination, options.binding.requestId, options.binding.requestKind]);

	const start = (): void => {
		if (!isCurrent(latest.current.binding)) return;
		if (!disclosedDocuments.has(document)) { setDisclosure(true); return; }
		controller.current?.start(latest.current.binding);
	};
	const confirmStart = (): void => {
		if (!isCurrent(latest.current.binding)) { setDisclosure(false); return; }
		disclosedDocuments.add(document);
		setDisclosure(false);
		controller.current?.start(latest.current.binding);
	};
	const useText = (): void => {
		const destination = latest.current.destination.current;
		if (!destination || !isCurrent(latest.current.binding)) { controller.current?.cancel(); return; }
		const text = controller.current?.takeReview();
		if (text === undefined || text.length === 0) return;
		const next = insertSpeechText(destination.value, text, destination.selectionStart, destination.selectionEnd);
		// No input/keyboard/submit events: this is a draft edit, not a submission.
		destination.value = next.text;
		latest.current.setDraft(next.text);
		destination.focus();
		destination.setSelectionRange(next.caret, next.caret);
	};
	return {
		snapshot,
		disclosure,
		available: options.enabled && Recognition !== undefined,
		busy: snapshot.phase !== "idle" && snapshot.phase !== "unsupported",
		isBusy: (): boolean => controller.current?.busy ?? false,
		start,
		confirmStart,
		cancelDisclosure: (): void => setDisclosure(false),
		stop: (): void => controller.current?.stop(),
		cancel: (): void => controller.current?.cancel(),
		editReview: (text: string): void => controller.current?.editReview(text),
		useText,
	};
}

export function SpeechInput({ speech }: { speech: SpeechInputState }): ReactNode {
	const [help, setHelp] = useState(false);
	const { snapshot } = speech;
	const capturing = ["starting", "listening", "stopping"].includes(snapshot.phase);
	return (
		<div className="sh-speech">
			<div className="sh-speech-actions">
				<button type="button" className="sh-btn sh-dictation-help" aria-expanded={help} onClick={() => setHelp(value => !value)}>Dictate help</button>
				{speech.available && !speech.busy && !speech.disclosure && (
					<button type="button" className="sh-btn sh-speech-start" aria-label="Start browser speech input" onClick={speech.start}><Mic size={14} aria-hidden="true" /> Start speech</button>
				)}
			</div>
			{help && <p className="sh-speech-help">{SPEECH_MESSAGES.keyboard}</p>}
			{speech.available && speech.disclosure && (
				<div className="sh-speech-disclosure">
					<p>{SPEECH_MESSAGES.disclosure}</p>
					<div className="sh-speech-actions">
						<button type="button" className="sh-btn sh-speech-confirm" onClick={speech.confirmStart}>Start recording</button>
						<button type="button" className="sh-btn" onClick={speech.cancelDisclosure}>Not now</button>
					</div>
				</div>
			)}
			{speech.available && capturing && (
				<div className="sh-speech-capture">
					<div role="status" aria-live="polite">{snapshot.phase === "starting" ? "Starting…" : snapshot.phase === "listening" ? "Listening…" : "Stopping…"} {snapshot.elapsedSeconds}s</div>
					<p className="sh-speech-transcript">{snapshot.text}</p>
					<div className="sh-speech-actions">
						<button type="button" className="sh-btn sh-speech-stop" disabled={snapshot.phase === "stopping"} onClick={speech.stop}>Stop recording</button>
						<button type="button" className="sh-btn sh-speech-cancel" onClick={speech.cancel}>Cancel recording</button>
					</div>
				</div>
			)}
			{speech.available && snapshot.phase === "review" && (
				<div className="sh-speech-review">
					<label>Review speech text
						<textarea className="sh-speech-review-input" aria-label="Review speech text" rows={3} value={snapshot.text} onChange={event => speech.editReview(event.target.value)} />
					</label>
					<div className="sh-speech-actions">
						<button type="button" className="sh-btn sh-speech-use" disabled={!snapshot.text} onClick={speech.useText}>Use text</button>
						<button type="button" className="sh-btn sh-speech-discard" onClick={speech.cancel}>Discard</button>
					</div>
				</div>
			)}
			{speech.available && snapshot.error && <p className="sh-speech-error" role="alert">{snapshot.error}</p>}
			{speech.available && snapshot.notice && <p role="status">{snapshot.notice}</p>}
		</div>
	);
}
