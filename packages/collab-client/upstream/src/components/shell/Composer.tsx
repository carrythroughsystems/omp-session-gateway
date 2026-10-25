import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabUiRequest, type ImageContent, type SessionEntry } from "@oh-my-pi/pi-wire";
import { Camera, ImagePlus, Images, SendHorizontal, Square, X } from "lucide-react";
import type { ChangeEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionPhase, GuestClient } from "../../lib/client";
import {
	MAX_PHOTO_ATTACHMENTS,
	PhotoAttachmentError,
	preparePhotoAttachment,
	type PreparedPhoto,
} from "../../lib/photo-attachment";
import { SpeechInput, useSpeechInput } from "./SpeechInput";

export interface ComposerProps {
	client: GuestClient;
	embedded?: boolean;
	browserRecognitionEnabled?: boolean;
	takeInitialPromptDraft?: (() => string | undefined) | undefined;
	phase: ConnectionPhase;
	readOnly: boolean;
	/** Pending host-side UI request this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Host agent turn in flight. */
	working: boolean;
	/** Prompts queued behind the running turn. */
	queuedMessageCount: number;
	uiResponsePending: boolean;
	relayReady: boolean;
	entries: readonly SessionEntry[];
	recommendedIndex: number | undefined;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;
const PHOTO_CONFIRM_TIMEOUT_MS = 5_000;

export interface PendingPhotoPrompt {
	readonly text: string;
	readonly images: readonly ImageContent[];
	readonly afterEntryId: string | null;
}

export function photoPromptAcknowledged(entries: readonly SessionEntry[], pending: PendingPhotoPrompt): boolean {
	let startIndex = 0;
	let baselineFound = pending.afterEntryId === null;
	if (pending.afterEntryId !== null) {
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			if (entries[index]?.id === pending.afterEntryId) {
				startIndex = index + 1;
				baselineFound = true;
				break;
			}
		}
	}
	if (!baselineFound) return false;
	for (let index = entries.length - 1; index >= startIndex; index -= 1) {
		const entry = entries[index];
		if (
			!entry ||
			entry.type !== "custom_message" ||
			entry.customType !== COLLAB_PROMPT_MESSAGE_TYPE ||
			typeof entry.content === "string" ||
			entry.content.length !== pending.images.length + 1
		) {
			continue;
		}
		const text = entry.content[0];
		if (text?.type !== "text" || text.text !== pending.text) continue;
		let matches = true;
		for (let imageIndex = 0; imageIndex < pending.images.length; imageIndex += 1) {
			const actual = entry.content[imageIndex + 1];
			const expected = pending.images[imageIndex];
			if (
				actual?.type !== "image" ||
				!expected ||
				actual.mimeType !== expected.mimeType ||
				actual.data !== expected.data
			) {
				matches = false;
				break;
			}
		}
		if (matches) return true;
	}
	return false;
}

function captureComposerPointer(event: ReactPointerEvent<HTMLButtonElement>): void {
	event.currentTarget.setPointerCapture(event.pointerId);
	event.preventDefault();
}

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	prefill: string | undefined;
	disabled: boolean;
	sending: boolean;
	onSubmit(value: string): void;
	submitLabel?: string;
	request: CollabUiRequest;
	browserRecognitionEnabled: boolean;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ disabled, prefill, sending, onSubmit, submitLabel = "Submit", request, browserRecognitionEnabled }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	const speech = useSpeechInput({
		enabled: browserRecognitionEnabled && !disabled,
		binding: { destination: "ask", requestId: request.reqId, requestKind: request.kind },
		destination: taRef,
		setDraft,
	});

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (speech.isBusy()) return;
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			if (!disabled) onSubmit(draft);
		}
	};

	return (
		<>
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				disabled={disabled}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					disabled={disabled || speech.busy}
					onClick={() => { if (!disabled && !speech.isBusy()) onSubmit(draft); }}
					title="submit response"
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">{sending ? "Sending…" : submitLabel}</span>
				</button>
			</div>
		</div>
		<SpeechInput speech={speech} />
		</>
	);
}
type SelectRequest = Extract<CollabUiRequest, { kind: "select" }>;

interface SelectAskProps {
	client: GuestClient;
	disabled: boolean;
	embedded: boolean;
	recommendedIndex: number | undefined;
	request: SelectRequest;
	sending: boolean;
}

function SelectAsk({ client, disabled, embedded, recommendedIndex, request, sending }: SelectAskProps): ReactNode {
	const initialIndex = request.initialIndex ?? request.checkedIndices?.[0];
	const [selectedIndex, setSelectedIndex] = useState<number | undefined>(
		initialIndex !== undefined && initialIndex >= 0 && initialIndex < request.options.length
			? initialIndex
			: undefined,
	);
	const selected = selectedIndex === undefined ? undefined : request.options[selectedIndex];
	const selectedLabel =
		selected === undefined ? undefined : typeof selected === "string" ? selected : selected.label;

	return (
		<>
			<div className="sh-ask-options">
				{request.options.map((option, index) => {
					const label = typeof option === "string" ? option : option.label;
					const checked = embedded || sending
						? selectedIndex === index
						: request.checkedIndices?.includes(index) ?? false;
					return (
						<button
							key={`${request.reqId}-${index}-${label}`}
							type="button"
							className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
							aria-pressed={checked}
							disabled={disabled}
							onClick={() => {
								setSelectedIndex(index);
								if (!embedded) client.sendUiResponse(request.reqId, label);
							}}
						>
							<span
								className={`sh-ask-option-marker sh-ask-option-marker-${request.selectionMarker ?? "radio"}`}
								aria-hidden="true"
							>
								{embedded ? (
									checked && <span className="sh-ask-option-marker-dot" />
								) : request.selectionMarker === "checkbox" ? (
									checked ? "☑" : "☐"
								) : checked ? (
									"◉"
								) : (
									"○"
								)}
							</span>
							<span className="sh-ask-option-copy">
								<span className="sh-ask-option-heading">
									<span className="sh-ask-option-label">
										{embedded ? `${index + 1} · ${label}` : label}
									</span>
									{index === recommendedIndex && (
										<span className="sh-ask-option-recommended">Recommended</span>
									)}
								</span>
								{typeof option !== "string" && option.description && (
									<span className="sh-ask-option-description">{option.description}</span>
								)}
							</span>
						</button>
					);
				})}
			</div>
			{embedded && (
				<button
					type="button"
					className="sh-btn sh-btn-primary sh-ask-send"
					disabled={disabled || selectedLabel === undefined}
					onClick={() => client.sendUiResponse(request.reqId, selectedLabel)}
				>
					{sending ? "Sending…" : "Send"}
				</button>
			)}
		</>
	);
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const Composer = memo(function Composer({
	client,
	phase,
	readOnly,
	uiRequest,
	working,
	queuedMessageCount,
	uiResponsePending: sendingResponse,
	relayReady,
	entries,
	recommendedIndex,
	embedded = false,
	browserRecognitionEnabled = false,
	takeInitialPromptDraft,
}: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const [photos, setPhotos] = useState<readonly PreparedPhoto[]>([]);
	const [preparingPhoto, setPreparingPhoto] = useState(false);
	const [photoError, setPhotoError] = useState<string | null>(null);
	const [pendingPhotoPrompt, setPendingPhotoPrompt] = useState<PendingPhotoPrompt | null>(null);
	const [photoConfirmationExpired, setPhotoConfirmationExpired] = useState(false);
	const [photoSourceOpen, setPhotoSourceOpen] = useState(false);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const cameraInputRef = useRef<HTMLInputElement | null>(null);
	const libraryInputRef = useRef<HTMLInputElement | null>(null);
	const photoTriggerRef = useRef<HTMLButtonElement | null>(null);
	const photosRef = useRef<readonly PreparedPhoto[]>([]);
	const mountedRef = useRef(true);
	const initialPromptDraftTakenRef = useRef(false);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = phase === "live";
	const canPrompt = live && !readOnly;
	const busy = working;
	const queued = queuedMessageCount;
	const retryReady = pendingPhotoPrompt !== null && photoConfirmationExpired && relayReady;
	const hasDraft = text.trim().length > 0 || photos.length > 0;
	const speech = useSpeechInput({
		enabled: browserRecognitionEnabled && canPrompt && uiRequest === null && !sendingResponse && !preparingPhoto && pendingPhotoPrompt === null,
		binding: { destination: "prompt", requestId: uiRequest?.reqId, requestKind: uiRequest?.kind },
		destination: taRef,
		setDraft: setText,
	});
	const canSend =
		canPrompt &&
		!speech.busy &&
		!preparingPhoto &&
		hasDraft &&
		(pendingPhotoPrompt === null ? photos.length === 0 || relayReady : retryReady);
	const canAddPhoto =
		canPrompt &&
		!speech.busy &&
		!preparingPhoto &&
		pendingPhotoPrompt === null &&
		photos.length < MAX_PHOTO_ATTACHMENTS;
	const photoSendMessage =
		pendingPhotoPrompt === null
			? null
			: !photoConfirmationExpired
				? photos.length === 1
					? "Sending photo…"
					: "Sending photos…"
				: !relayReady
					? "Waiting for relay…"
					: "Photo not confirmed. Tap Send to retry.";

	useEffect(() => {
		if (
			initialPromptDraftTakenRef.current ||
			takeInitialPromptDraft === undefined ||
			!canPrompt ||
			!relayReady ||
			uiRequest !== null ||
			text.length !== 0 ||
			preparingPhoto ||
			photos.length !== 0 ||
			pendingPhotoPrompt !== null
		) {
			return;
		}
		initialPromptDraftTakenRef.current = true;
		const draft = takeInitialPromptDraft();
		if (draft !== undefined) setText(draft);
	}, [canPrompt, relayReady, uiRequest, text, preparingPhoto, photos.length, pendingPhotoPrompt, takeInitialPromptDraft]);

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			photosRef.current = [];
		};
	}, []);

	useEffect(() => {
		if (pendingPhotoPrompt === null || !photoPromptAcknowledged(entries, pendingPhotoPrompt)) return;
		setPendingPhotoPrompt(null);
		setPhotoConfirmationExpired(false);
		setText("");
		photosRef.current = [];
		setPhotos([]);
		setPhotoError(null);
	}, [pendingPhotoPrompt, entries]);

	useEffect(() => {
		if (pendingPhotoPrompt === null) return;
		const timer = setTimeout(() => setPhotoConfirmationExpired(true), PHOTO_CONFIRM_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [pendingPhotoPrompt]);

	useEffect(() => {
		if (!canAddPhoto) setPhotoSourceOpen(false);
	}, [canAddPhoto]);

	const selectPhotos = useCallback(async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
		const files = [...(event.currentTarget.files ?? [])];
		event.currentTarget.value = "";
		setPhotoSourceOpen(false);
		if (files.length === 0 || pendingPhotoPrompt !== null) return;
		const available = MAX_PHOTO_ATTACHMENTS - photosRef.current.length;
		if (available <= 0) {
			setPhotoError(`You can attach up to ${MAX_PHOTO_ATTACHMENTS} photos.`);
			return;
		}

		setPhotoError(null);
		setPreparingPhoto(true);
		for (const file of files.slice(0, available)) {
			try {
				const prepared = await preparePhotoAttachment(file);
				if (!mountedRef.current) return;
				const next = [...photosRef.current, prepared];
				photosRef.current = next;
				setPhotos(next);
			} catch (error) {
				if (!mountedRef.current) return;
				setPhotoError(
					error instanceof PhotoAttachmentError
						? error.message
						: "This photo could not be prepared. Try another image.",
				);
			}
		}
		if (files.length > available) {
			setPhotoError(`Only the first ${available} photos were attached.`);
		}
		if (mountedRef.current) setPreparingPhoto(false);
	}, [pendingPhotoPrompt]);

	const removePhoto = useCallback((index: number): void => {
		const removed = photosRef.current[index];
		if (!removed) return;
		const next = photosRef.current.filter((_, candidate) => candidate !== index);
		photosRef.current = next;
		setPhotos(next);
		setPhotoError(null);
		setPendingPhotoPrompt(null);
		setPhotoConfirmationExpired(false);
	}, []);

	const send = useCallback((): void => {
		setPhotoSourceOpen(false);
		const trimmed = text.trim();
		const selectedPhotos = photosRef.current;
		if (
			(!trimmed && selectedPhotos.length === 0) ||
			!live ||
			readOnly ||
			speech.isBusy() ||
			preparingPhoto ||
			(pendingPhotoPrompt !== null && !retryReady)
		) {
			return;
		}
		const prompt =
			trimmed || (selectedPhotos.length === 1 ? "Please inspect this photo." : "Please inspect these photos.");
		setPhotoError(null);
		if (selectedPhotos.length === 0) {
			client.sendPrompt(prompt);
			setText("");
			return;
		}
		if (!relayReady) return;
		const images = selectedPhotos.map(photo => photo.content);
		setPendingPhotoPrompt({ text: prompt, images, afterEntryId: entries.at(-1)?.id ?? null });
		setPhotoConfirmationExpired(false);
		client.sendPrompt(prompt, images);
	}, [client, live, pendingPhotoPrompt, preparingPhoto, readOnly, relayReady, retryReady, entries, text, speech.isBusy]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (speech.isBusy()) return;
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
		}
	};

	if (uiRequest && !readOnly) {
		const requestDisabled = !live || sendingResponse;
		return (
			<div className={`sh-composer sh-composer-ask${embedded ? " sh-composer-ask-embedded" : ""}`} data-sending={sendingResponse ? "true" : undefined}>
				{(embedded || sendingResponse) && (
					<div
						className="sh-ask-kicker"
						role={embedded ? undefined : "status"}
						aria-live={embedded ? undefined : "polite"}
					>
						{sendingResponse ? "Sending…" : "input required"}
					</div>
				)}
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<SelectAsk
						key={uiRequest.reqId}
						disabled={requestDisabled}
						client={client}
						embedded={embedded}
						recommendedIndex={recommendedIndex}
						request={uiRequest}
						sending={sendingResponse}
					/>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						disabled={requestDisabled}
						prefill={uiRequest.prefill}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
						submitLabel={embedded ? "Send" : "Submit"}
						sending={sendingResponse}
						request={uiRequest}
						browserRecognitionEnabled={browserRecognitionEnabled && !preparingPhoto && pendingPhotoPrompt === null}
					/>
				)}
				{!embedded && (
					<div className="sh-composer-actions sh-ask-actions">
						<button type="button" className="sh-btn" disabled={requestDisabled} onClick={() => client.sendUiResponse(uiRequest.reqId)}>
							Cancel
						</button>
						{busy && (
							<button
								type="button"
								className="sh-btn sh-btn-stop"
								onClick={() => client.sendAbort()}
								disabled={!live}
								title="stop the current turn"
							>
								<Square size={11} /> <span className="sh-btn-label">Stop</span>
							</button>
						)}
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="sh-composer">
			{(photos.length > 0 || preparingPhoto || photoError || photoSendMessage) && (
				<div className="sh-photo-stage">
					{(photos.length > 0 || preparingPhoto) && (
						<div className="sh-photo-strip" role="list" aria-label="Photos ready to send">
							{photos.map((photo, index) => (
								<figure className="sh-photo" role="listitem" key={index}>
									<img
										src={`data:${photo.content.mimeType};base64,${photo.content.data}`}
										alt={`Photo ${index + 1} ready to send`}
									/>
									<button
										type="button"
										className="sh-photo-remove"
										onClick={() => removePhoto(index)}
										onPointerDown={captureComposerPointer}
										disabled={
											preparingPhoto || (pendingPhotoPrompt !== null && !photoConfirmationExpired)
										}
										aria-label={`Remove photo ${index + 1}`}
									>
										<X size={14} />
									</button>
								</figure>
							))}
							{preparingPhoto && (
								<div className="sh-photo-preparing" role="status" aria-live="polite">
									<span className="sh-photo-progress" aria-hidden="true" />
									Preparing photo…
								</div>
							)}
						</div>
					)}
					{photoSendMessage && (
						<div className="sh-photo-send-state" role="status" aria-live="polite">
							{photoSendMessage}
						</div>
					)}
					{photoError && <div className="sh-photo-error" role="alert">{photoError}</div>}
				</div>
			)}
			{photoSourceOpen && canAddPhoto && (
				<div
					id="sh-photo-source-choices"
					className="sh-photo-source-chooser"
					role="group"
					aria-label="Add a photo"
					onKeyDown={event => {
						if (event.key !== "Escape") return;
						setPhotoSourceOpen(false);
						photoTriggerRef.current?.focus();
					}}
				>
					<div className="sh-photo-source-options">
						<button
							type="button"
							className="sh-photo-source-option"
							onClick={() => {
								setPhotoSourceOpen(false);
								cameraInputRef.current?.click();
							}}
							onPointerDown={captureComposerPointer}
						>
							<Camera size={18} aria-hidden="true" />
							<span className="sh-photo-source-copy">
								<span className="sh-photo-source-label">Take photo</span>
								<span className="sh-photo-source-detail">Open rear camera</span>
							</span>
						</button>
						<button
							type="button"
							className="sh-photo-source-option"
							onClick={() => {
								setPhotoSourceOpen(false);
								libraryInputRef.current?.click();
							}}
							onPointerDown={captureComposerPointer}
						>
							<Images size={18} aria-hidden="true" />
							<span className="sh-photo-source-copy">
								<span className="sh-photo-source-label">Choose existing</span>
								<span className="sh-photo-source-detail">Photo library or files</span>
							</span>
						</button>
					</div>
				</div>
			)}
			<div className="sh-composer-inner">
				<input
					ref={cameraInputRef}
					className="sh-photo-input sh-photo-input-camera"
					type="file"
					accept="image/jpeg,image/png,image/webp"
					capture="environment"
					hidden
					onChange={selectPhotos}
					disabled={!canAddPhoto}
				/>
				<input
					ref={libraryInputRef}
					className="sh-photo-input sh-photo-input-library"
					type="file"
					accept="image/jpeg,image/png,image/webp"
					hidden
					onChange={selectPhotos}
					disabled={!canAddPhoto}
				/>
				<button
					ref={photoTriggerRef}
					type="button"
					className={`sh-btn sh-photo-trigger${photos.length > 0 || photoSourceOpen ? " sh-photo-trigger-active" : ""}`}
					onClick={() => {
						setPhotoError(null);
						setPhotoSourceOpen(open => !open);
					}}
					onPointerDown={captureComposerPointer}
					disabled={!canAddPhoto}
					title={
						pendingPhotoPrompt !== null
							? "Photo send pending"
							: photos.length >= MAX_PHOTO_ATTACHMENTS
								? "Photo limit reached"
								: "Take or attach a photo"
					}
					aria-label="Add a photo"
					aria-expanded={photoSourceOpen}
					aria-controls={photoSourceOpen ? "sh-photo-source-choices" : undefined}
				>
					<ImagePlus size={17} /> <span className="sh-btn-label">Photo</span>
				</button>
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => setText(e.target.value)}
					onFocus={() => setPhotoSourceOpen(false)}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? "Read-only session — watching only"
							: live
								? photos.length > 0
									? "add a note (optional)…"
									: "prompt the host agent…"
								: "waiting for session…"
					}
					disabled={!canPrompt || pendingPhotoPrompt !== null}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-actions">
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							onPointerDown={captureComposerPointer}
							disabled={!live}
							title="stop the current turn"
						>
							<Square size={14} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={send}
						onPointerDown={captureComposerPointer}
						disabled={!canSend}
						title={
							pendingPhotoPrompt === null
								? "send (Enter)"
								: photoConfirmationExpired
									? "retry photo send"
									: "waiting for host confirmation"
						}
					>
						<SendHorizontal size={15} />
						<span className="sh-btn-label">
							{pendingPhotoPrompt === null ? "Send" : photoConfirmationExpired ? "Retry" : "Sending…"}
						</span>
					</button>
				</div>
			</div>
			{!readOnly && <SpeechInput speech={speech} />}
		</div>
	);
});
