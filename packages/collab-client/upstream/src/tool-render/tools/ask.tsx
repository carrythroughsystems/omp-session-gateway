/** `ask` — HTML forms, with question cards retained for older supported hosts. */
import type { ReactNode } from "react";
import { Badge, InvalidArg, Note, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

interface AskOption {
	label: string;
	description?: string;
}

interface AskQuestion {
	id: string;
	question: string;
	options: AskOption[];
	multi: boolean;
	recommended?: number;
}

/** Selections made for one question (from `details` or `details.results[]`). */
interface AskAnswer {
	id?: string;
	selectedOptions: string[];
	customInput?: string;
	/** Free-form note the user attached to the answer via the rich ask dialog. */
	note?: string;
	timedOut?: boolean;
}

/** The TUI appends this to the recommended option's label before selection. */
const RECOMMENDED_SUFFIX = " (Recommended)";

function stripRecommended(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

/** Bare strings become labels; entries without a string label are dropped. */
function normalizeOptions(raw: unknown): AskOption[] {
	if (!Array.isArray(raw)) return [];
	const out: AskOption[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			out.push({ label: entry });
			continue;
		}
		if (!isRecord(entry)) continue;
		const label = str(entry.label);
		if (label === null) continue;
		const description = str(entry.description);
		out.push(description !== null ? { label, description } : { label });
	}
	return out;
}

/**
 * Coerce untrusted `questions` call args. Models occasionally double-encode
 * the array as a JSON string; partially streamed args can be missing fields.
 */
function normalizeQuestions(raw: unknown): AskQuestion[] {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(raw)) return [];
	const out: AskQuestion[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		out.push({
			id: str(entry.id) ?? "?",
			question: str(entry.question) ?? "",
			options: normalizeOptions(entry.options),
			multi: entry.multi === true,
			recommended: num(entry.recommended) ?? undefined,
		});
	}
	return out;
}

/** Question list from call args; tolerates the legacy single-question shape. */
function questionsOf(args: Record<string, unknown>): AskQuestion[] {
	const questions = normalizeQuestions(args.questions);
	if (questions.length > 0) return questions;
	const question = str(args.question);
	if (question === null) return [];
	return [
		{
			id: "?",
			question,
			options: normalizeOptions(args.options),
			multi: args.multi === true,
			recommended: num(args.recommended) ?? undefined,
		},
	];
}

function answerOf(rec: Record<string, unknown>): AskAnswer {
	const selectedOptions: string[] = [];
	if (Array.isArray(rec.selectedOptions)) {
		for (const entry of rec.selectedOptions) {
			const label = str(entry);
			if (label !== null) selectedOptions.push(stripRecommended(label));
		}
	}
	return {
		id: str(rec.id) ?? undefined,
		selectedOptions,
		customInput: str(rec.customInput) ?? undefined,
		note: str(rec.note) ?? undefined,
		timedOut: rec.timedOut === true,
	};
}

/**
 * Per-question answers from `result.details` — `results[]` in multi-part mode,
 * flat single-question fields otherwise. Null when the result carries no
 * usable selection data (error, cancel before details).
 */
function answersOf(details: Record<string, unknown> | null): AskAnswer[] | null {
	if (!details) return null;
	if (Array.isArray(details.results)) {
		const out: AskAnswer[] = [];
		for (const entry of details.results) if (isRecord(entry)) out.push(answerOf(entry));
		return out.length > 0 ? out : null;
	}
	if (details.question !== undefined || details.selectedOptions !== undefined || details.customInput !== undefined) {
		return [answerOf(details)];
	}
	return null;
}

/**
 * Rebuild renderable questions from result details when call args are
 * malformed or absent — `QuestionResult` carries question text and bare
 * option labels (no descriptions, no recommended index).
 */
function questionsFromDetails(details: Record<string, unknown>): AskQuestion[] {
	const source = Array.isArray(details.results) ? details.results : [details];
	const out: AskQuestion[] = [];
	for (const entry of source) {
		if (!isRecord(entry)) continue;
		const question = str(entry.question);
		if (question === null) continue;
		out.push({
			id: str(entry.id) ?? "?",
			question,
			options: normalizeOptions(entry.options),
			multi: entry.multi === true,
		});
	}
	return out;
}

function LegacySummary({ args }: ToolRenderProps): ReactNode {
	const questions = questionsOf(args);
	const first = questions[0];
	if (!first) return <InvalidArg what="questions" />;
	return (
		<>
			<span>{truncate(normalizeWs(first.question), 70)}</span>
			{questions.length > 1 && <Badge>{questions.length} questions</Badge>}
		</>
	);
}

function QuestionBlock({ q, answer }: { q: AskQuestion; answer: AskAnswer | undefined }): ReactNode {
	const selected = new Set(answer?.selectedOptions);
	return (
		<div className="tv-list">
			<Row>
				{q.id !== "?" && <span className="tv-faint">[{q.id}] </span>}
				{q.question ? <span>{q.question}</span> : <InvalidArg what="question" />}
				{q.multi && <Badge>multi</Badge>}
			</Row>
			{q.options.map((opt, i) => {
				const isSelected = selected.has(stripRecommended(opt.label));
				const marker = q.multi ? (isSelected ? "■" : "□") : isSelected ? "●" : "○";
				return (
					<Row key={i} k={<span className={isSelected ? "tv-ok-text" : undefined}>{marker}</span>}>
						<span className={answer && !isSelected ? "tv-muted" : undefined}>{opt.label}</span>
						{i === q.recommended && <Badge tone="accent">recommended</Badge>}
						{opt.description && <span className="tv-muted"> — {opt.description}</span>}
					</Row>
				);
			})}
			{answer?.customInput !== undefined && (
				<Row k="✎">
					<span className="tv-ok-text">{answer.customInput}</span>
				</Row>
			)}
			{answer?.note !== undefined && (
				<Row k="note:">
					<span className="tv-muted">{answer.note}</span>
				</Row>
			)}
			{answer && answer.selectedOptions.length === 0 && answer.customInput === undefined && (
				<Row k="—">
					<span className="tv-warn-text">no selection</span>
				</Row>
			)}
			{answer?.timedOut && <Note tone="warn">auto-selected after timeout — not a user choice</Note>}
		</div>
	);
}

function LegacyBody({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const answers = answersOf(details);
	let questions = questionsOf(args);
	if (questions.length === 0 && details) questions = questionsFromDetails(details);
	return (
		<>
			{questions.map((q, i) => {
				const answer = answers ? (answers.find(a => a.id !== undefined && a.id === q.id) ?? answers[i]) : undefined;
				return <QuestionBlock key={i} q={q} answer={answer} />;
			})}
			{questions.length === 0 && !result && <InvalidArg what="questions" />}
			{!answers && <ResultText result={result} maxLines={10} />}
		</>
	);
}

/** One named field's question and its answer text, as the TUI records them. */
interface FormAnswer {
	name: string;
	question: string;
	answer: string;
}

interface AskOptionNote {
	name: string;
	question: string;
	option: string;
	text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Text content of an HTML fragment: tags dropped, common entities decoded, whitespace folded. */
function htmlText(fragment: string): string {
	const decoded = fragment
		.replace(/<[^>]*>?/g, " ")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
			if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? entity;
			const point = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
			return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
		});
	return normalizeWs(decoded);
}

/** Coarse outline only: no upstream form HTML is mounted or executed in the browser. */
function formOutline(html: string): { headings: string[]; fields: number } {
	const names = new Set<string>();
	for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>?/gi)) {
		const attrs = match[2] ?? "";
		if (/\btype\s*=\s*["']?(hidden|submit|button|reset|image)\b/i.test(attrs)) continue;
		const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
		const value = name?.[1] ?? name?.[2] ?? name?.[3];
		if (value) names.add(value);
	}
	const legends = [...html.matchAll(/<legend\b[^>]*>([\s\S]*?)(?:<\/legend>|$)/gi)]
		.map(match => htmlText(match[1] ?? ""))
		.filter(Boolean);
	if (legends.length > 0) return { headings: legends, fields: names.size };
	const first = /<(?:p|label|h[1-6])\b[^>]*>([\s\S]*?)(?:<(?:input|select|textarea|\/p|\/label|\/h[1-6])\b|$)/i.exec(
		html,
	);
	const caption = first ? htmlText(first[1] ?? "") : "";
	return { headings: caption ? [caption] : [], fields: names.size };
}

function formAnswersOf(details: Record<string, unknown> | null): FormAnswer[] | null {
	if (!details || !Array.isArray(details.answers)) return null;
	const out: FormAnswer[] = [];
	for (const entry of details.answers) {
		if (!isRecord(entry)) continue;
		const name = str(entry.name);
		const question = str(entry.question);
		const answer = str(entry.answer);
		if (question !== null && answer !== null) out.push({ name: name ?? "", question, answer });
	}
	return out.length > 0 || details.answers.length === 0 ? out : null;
}

/** Valid selected-option notes from persisted details; ignore malformed entries. */
function notesOf(details: Record<string, unknown> | null): AskOptionNote[] {
	if (!details || !Array.isArray(details.notes)) return [];
	const out: AskOptionNote[] = [];
	for (const entry of details.notes) {
		if (!isRecord(entry)) continue;
		const name = str(entry.name);
		const question = str(entry.question);
		const option = str(entry.option);
		const text = str(entry.text);
		if (name !== null && question !== null && option !== null && text !== null) {
			out.push({ name, question, option, text });
		}
	}
	return out;
}

function Summary(props: ToolRenderProps): ReactNode {
	const { args, result } = props;
	const html = str(args.html);
	const answers = formAnswersOf(detailsRecord(result));
	if (html === null && answers === null) return <LegacySummary {...props} />;
	const outline = html ? formOutline(html) : { headings: [], fields: 0 };
	const first = answers?.[0]?.question ?? outline.headings[0];
	if (!first) return null;
	const count = answers ? answers.length : outline.fields;
	return (
		<>
			<span>{truncate(normalizeWs(first), 70)}</span>
			{count > 1 && <Badge>{count} fields</Badge>}
		</>
	);
}

function Body(props: ToolRenderProps): ReactNode {
	const { args, result } = props;
	const details = detailsRecord(result);
	const answers = formAnswersOf(details);
	const notes = notesOf(details);
	if (answers) {
		return (
			<>
				<div className="tv-list">
					{answers.map((entry, i) => (
						<div key={i}>
							<Row>{entry.question}</Row>
							{entry.answer ? (
								<Row k={<span className="tv-ok-text">✓</span>}>
									<span>{entry.answer}</span>
								</Row>
							) : (
								<Row k="—">
									<span className="tv-faint">(no answer)</span>
								</Row>
							)}
							{notes
								.filter(note => note.name === entry.name && note.question === entry.question)
								.map((note, noteIndex) => (
									<Note key={`${i}-${noteIndex}`}>
										✎ {note.option}: {note.text}
									</Note>
								))}
						</div>
					))}
				</div>
				{details?.timedOut === true && <Note tone="warn">auto-selected after timeout — not a user choice</Note>}
			</>
		);
	}
	const html = str(args.html);
	if (html === null) return <LegacyBody {...props} />;
	if (result) return <ResultText result={result} maxLines={10} />;
	const { headings } = formOutline(html);
	return (
		<div className="tv-list">
			{headings.map((heading, i) => (
				<Row key={i}>{heading}</Row>
			))}
		</div>
	);
}

export const askRenderer: ToolRenderer = { Summary, Body };
