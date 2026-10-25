import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { TernConfig, TernProfile, TernWorkingCopy } from "./config.ts";

class NumericLexeme { constructor(readonly value: string) {} }
type Json = null | boolean | string | NumericLexeme | Json[] | { [key: string]: Json };
const invalid = (): never => { throw new Error("invalid Tern metadata"); };

/** Never passes a numeric token through Number, including unknown metadata fields. */
export function parseTernJson(bytes: Uint8Array): Json {
  if (bytes.byteLength > 1024 * 1024) return invalid();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return invalid(); }
  let at = 0;
  let count = 0;
  const space = (): void => { while (/[ \t\r\n]/u.test(text[at] ?? "")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") { at++; continue; }
      if (char === '"') {
        let value: unknown;
        try { value = JSON.parse(text.slice(start, at)); } catch { return invalid(); }
        if (typeof value !== "string" || Buffer.byteLength(value) > 8192) return invalid();
        return value;
      }
    }
    return invalid();
  };
  const value = (depth: number): Json => {
    if (++count > 50_000 || depth > 32) return invalid();
    space();
    const char = text[at];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      at++; space();
      const array = char === "[";
      const end = array ? "]" : "}";
      const entries: Json[] = [];
      const record = Object.create(null) as { [key: string]: Json };
      if (text[at] === end) { at++; return array ? entries : record; }
      while (at < text.length) {
        space();
        if (array) entries.push(value(depth + 1));
        else {
          if (text[at] !== '"') return invalid();
          const key = string();
          if (Object.hasOwn(record, key)) return invalid();
          space(); if (text[at++] !== ":") return invalid();
          record[key] = value(depth + 1);
        }
        space();
        if (text[at] === end) { at++; return array ? entries : record; }
        if (text[at++] !== ",") return invalid();
      }
      return invalid();
    }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(token, at)) { at += token.length; return result; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(at));
    if (!number) return invalid();
    at += number[0].length;
    return new NumericLexeme(number[0]);
  };
  const result = value(0); space();
  if (at !== text.length) return invalid();
  return result;
}
function object(value: Json | undefined): { [key: string]: Json } {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof NumericLexeme) return invalid();
  return value;
}
function array(value: Json | undefined, maximum: number): Json[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
}
function unsignedTernId(value: Json | undefined): bigint {
  if (!(value instanceof NumericLexeme) || !/^(?:0|[1-9][0-9]*)$/u.test(value.value)) return invalid();
  const id = BigInt(value.value);
  if (id > 0xffffffffffffffffn) return invalid();
  return id;
}
export function localTernId(value: Json | undefined): string {
  const id = unsignedTernId(value);
  if (id >> 56n !== 0n) return invalid();
  return id.toString();
}
export interface TernInspection {
  readonly blocks: readonly string[];
  readonly panes: readonly { readonly paneId: string; readonly sessionBasename?: string }[];
}
export function parseTernInspection(bytes: Uint8Array): TernInspection {
  const root = object(parseTernJson(bytes));
  const blocks: string[] = [];
  let tabs = 0;
  for (const session of array(root.sessions, 64)) {
    const sessionTabs = array(object(session).tabs, 256);
    tabs += sessionTabs.length; if (tabs > 256) return invalid();
    for (const tab of sessionTabs) {
      for (const block of array(object(tab).blocks, 4096)) {
        // Remote panes may coexist in an inspection, but are never local candidates.
        const raw = object(block).id;
        if (!(raw instanceof NumericLexeme) || !/^(?:0|[1-9][0-9]*)$/u.test(raw.value) || BigInt(raw.value) > 0xffffffffffffffffn) return invalid();
        blocks.push(BigInt(raw.value).toString());
        if (blocks.length > 4096) return invalid();
      }
    }
  }
  const panes = array(root.panes, 4096).map(value => {
    const pane = object(value);
    const raw = pane.pane;
    if (!(raw instanceof NumericLexeme) || !/^(?:0|[1-9][0-9]*)$/u.test(raw.value) || BigInt(raw.value) > 0xffffffffffffffffn) return invalid();
    const paneId = BigInt(raw.value).toString();
    const file = pane.omp_session_file;
    if (file === undefined || file === null || file === "") return { paneId };
    if (typeof file !== "string" || !isAbsolute(file) || file.includes("\0") || Buffer.byteLength(file) > 4096) return invalid();
    return { paneId, sessionBasename: basename(file) };
  });
  return { blocks, panes };
}
export function matchingTernBasename(inspection: TernInspection, blockId: string): string | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(blockId) || BigInt(blockId) >> 56n !== 0n) return undefined;
  if (inspection.blocks.filter(id => id === blockId).length !== 1) return undefined;
  const panes = inspection.panes.filter(pane => pane.paneId === blockId);
  return panes.length === 1 ? panes[0]!.sessionBasename : undefined;
}
export function sessionBasenameMatches(basename: string, sessionId: string): boolean {
  const tokens: readonly string[] = basename.slice(0, -6).match(/[A-Za-z0-9-]+/gu) ?? [];
  return basename.endsWith(".jsonl") && /^[A-Za-z0-9-]+$/u.test(sessionId) &&
    tokens.includes(sessionId);
}
export interface TernSpawnTime {
  readonly monotonicMs: number;
  readonly wallTimeMs: number;
}
export type TernCreateResult = { readonly kind: "not_started" } | { readonly kind: "unknown" } |
  { readonly kind: "started"; readonly blockId: string; readonly spawnedAt: TernSpawnTime };
export interface TernCliBoundary {
  inspect(profile: TernProfile, signal: AbortSignal): Promise<TernInspection | undefined>;
  createTab(copy: TernWorkingCopy, profile: TernProfile, signal: AbortSignal): Promise<TernCreateResult>;
}

export async function validateTernRuntime(config: TernConfig): Promise<boolean> {
  try {
    if (!config.executable || !config.projects?.length || !config.profiles?.length) return false;
    for (const path of [config.executable, ...config.profiles.map(profile => profile.argv[0]!)]) {
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isFile()) return false;
      await access(canonical, constants.X_OK);
    }
    for (const copy of config.projects.flatMap(project => project.workingCopies)) {
      if (await realpath(copy.path) !== copy.path || !(await stat(copy.path)).isDirectory()) return false;
      await access(copy.path, constants.R_OK | constants.X_OK);
    }
    return true;
  } catch { return false; }
}

export class TernCli implements TernCliBoundary {
  #busy = false;
  constructor(readonly executable: string, readonly timeouts = { inspect: 5000, create: 10_000 }) {}
  async #run(args: readonly string[], profile: TernProfile, signal: AbortSignal, bound: number, timeout: number): Promise<
    { kind: "not_started" } | { kind: "unknown" } | { kind: "output"; bytes: Uint8Array; spawnedAt: TernSpawnTime }> {
    if (this.#busy || signal.aborted) return { kind: "not_started" };
    this.#busy = true;
    let child: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupted = false;
    const kill = (): void => { interrupted = true; try { child?.kill("SIGKILL"); } catch { /* already reaped */ } void reader?.cancel().catch(() => {}); };
    try {
      const executable = await realpath(this.executable);
      if (signal.aborted) return { kind: "not_started" };
      child = Bun.spawn([executable, ...args], { env: { ...profile.env }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const spawnedAt = { monotonicMs: performance.now(), wallTimeMs: Date.now() };
      reader = child.stdout.getReader();
      signal.addEventListener("abort", kill, { once: true });
      timer = setTimeout(kill, timeout);
      if (signal.aborted) kill();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (!interrupted) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > bound) { kill(); break; }
        chunks.push(value);
      }
      const exit = await child.exited;
      if (interrupted || exit !== 0) return { kind: "unknown" };
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { kind: "output", bytes, spawnedAt };
    } catch {
      if (child) kill();
      return { kind: child ? "unknown" : "not_started" };
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", kill);
      if (child) await child.exited.catch(() => {});
      await reader?.cancel().catch(() => {}); reader?.releaseLock();
      this.#busy = false;
    }
  }
  async inspect(profile: TernProfile, signal: AbortSignal): Promise<TernInspection | undefined> {
    const result = await this.#run(["inspect", "--json"], profile, signal, 1024 * 1024, this.timeouts.inspect);
    if (result.kind !== "output") return undefined;
    try { return parseTernInspection(result.bytes); } catch { return undefined; }
  }
  async createTab(copy: TernWorkingCopy, profile: TernProfile, signal: AbortSignal): Promise<TernCreateResult> {
    let argv: string[];
    try { argv = [await realpath(profile.argv[0]!), ...profile.argv.slice(1)]; } catch { return { kind: "not_started" }; }
    const result = await this.#run(["new", "tab", "--json", "--keep-open", "--cwd", copy.path, "--", ...argv],
      profile, signal, 8192, this.timeouts.create);
    if (result.kind !== "output") return result;
    try {
      const receipt = object(parseTernJson(result.bytes));
      // Tern includes session/tab locators and may add bounded metadata; only the local block is adopted.
      for (const key of ["session", "tab"]) {
        if (Object.hasOwn(receipt, key)) unsignedTernId(receipt[key]);
      }
      return { kind: "started", blockId: localTernId(receipt.block), spawnedAt: result.spawnedAt };
    } catch { return { kind: "unknown" }; }
  }
}
