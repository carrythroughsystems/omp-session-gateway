import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkChangelogFragment } from "./release-policy.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

const rootPath = fileURLToPath(new URL("../", import.meta.url));

const required = [
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "changelog.d/README.md",
  "LICENSE",
  "NOTICE.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "THIRD_PARTY_NOTICES.md",
  "UPSTREAM.lock.json",
  "docs/ARCHITECTURE.md",
  "docs/COMPATIBILITY.md",
  "docs/DECISIONS.md",
  "docs/OMP_INTEGRATION.md",
  "docs/OPERATIONS.md",
  "docs/PROTOCOL.md",
  "docs/RELEASE.md",
  "docs/RELEASE_STATUS.md",
  "docs/SECURITY.md",
  "docs/TEST_PLAN.md",
  "docs/UPGRADE_ROLLBACK.md",
  "schemas/omp-host-registry.schema.json",
  "schemas/session-list.schema.json",
  "schemas/client-config.schema.json",
  "schemas/session-creation-options.schema.json",
  "schemas/session-creation-request.schema.json",
  "schemas/session-creation-status.schema.json",
  "schemas/launch-request.schema.json",
  "schemas/launch-response.schema.json",
  "schemas/sse-event.schema.json",
  "schemas/upstream-lock.schema.json",
] as const;

const forbiddenLegacy = [
  "OMP Mobile Hub",
  "omp-mobile-hub",
  "gitgateway.com",
  "tag:omp-hub",
  "OMP Collab Hub",
  "omp-collab-hub",
  "tag:omp-gateway",
] as const;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

// Direct fetches in harness code are provider reads unless this exact target was reviewed.
// Gateway/browser probes deliberately observe first-failure behavior; capability POSTs must not retry.
const nonProviderFetches: Readonly<Record<string, readonly string[]>> = {
  "android-acceptance.ts": ['"/api/v1/sessions/" + id + "/launch"', '"/api/v1/sessions"', 'new URL("/api/v1/sessions"'],
  "android-collab-smoke.ts": ['`${options.origin}/api/v1/sessions`'],
  // The caller's owned adb-forwarded Chrome endpoint, never a provider request.
  "android-device.ts": ['"http://127.0.0.1:" + port + "/json/version"'],
  "android-leak-sweep.ts": ['origin + "/api/v1/sessions"'],
  // Authenticated reads of the owned retained gateway, never subscription endpoints or a provider.
  "android-push-runtime.ts": ['`${identity.origin}/api/v1/sessions`', '`${identity.origin}/api/v1/push/config`', "'/api/v1/sessions'", "'/api/v1/sessions/'+${JSON.stringify(fixture.instanceId)}+'/launch'"],
  "browser-journey.ts": ['"/api/v1/sessions"', '"/api/v1/sessions/" + target.instanceId + "/launch"'],
  "device-cloud-runtime.ts": ['`${origin}/`', '`${origin}/api/v1/sessions`', '`${origin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`'],
  // Single-shot latency and stream measurements of the isolated loopback gateway; a retry would skew them.
  "gateway-endurance.ts": ['`${base}${path}`', '`${base}/api/v1/events`'],
  // Readiness probe of its own isolated loopback gateway; the loop itself retries until ready.
  "omp-lifecycle-development.ts": ['`${origin}/api/v1/health`'],
  "post-release-smoke.ts": ['`${config.http.publicOrigin}/api/v1/sessions`', '`http://127.0.0.1:${port}/json/list`'],
  "relay-soak.ts": ['`${config.gatewayOrigin}/api/v1/sessions`', '`${config.gatewayOrigin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`'],
  "stable-qualification.ts": ['`${origin}/api/v1/sessions`', '`${origin}/api/v1/sessions/${encodeURIComponent(instanceId)}/launch`', '`http://127.0.0.1:${port}/api/v1/health`'],
  // Single-shot local Percy session health; upload mode must never silently no-op.
  "test-visual.ts": ['new URL("/percy/healthcheck"', 'new URL("/test/logs"'],
};

/** Consume the complete init object and the same dispatcher's immediately following GET gate. */
function windowsReadDispatcher(after: string, signalOwned: boolean): boolean {
  const tokens = sourceTokens(after, true);
  let token = tokens.next().value as SourceToken | undefined;
  const advance = () => { token = tokens.next().value as SourceToken | undefined; };
  const take = (value: string): boolean => {
    if (token?.value !== value) return false;
    advance(); return true;
  };
  const sequence = (...values: string[]): boolean => values.every(take);
  if (!sequence(",", "{")) return false;
  const keys = new Set<string>();
  while (token && token.value !== "}") {
    const key = token.value;
    if (!["method", "headers", "body", "signal"].includes(key) || keys.has(key)) return false;
    keys.add(key); advance();
    if (key === "method") {
      if (take(":") && !take("method")) return false;
    } else {
      if (!take(":")) return false;
      const closes: string[] = [];
      let count = 0;
      while (token) {
        const value = token.value;
        if (closes.length === 0 && (value === "," || value === "}")) break;
        const close = ({ "(": ")", "[": "]", "{": "}" } as Record<string, string>)[value];
        if (close !== undefined) closes.push(close);
        else if ([")", "]", "}"].includes(value) && closes.pop() !== value) return false;
        count++; advance();
      }
      if (count === 0 || closes.length !== 0) return false;
    }
    if (token?.value !== "}" && !take(",")) return false;
  }
  if (!keys.has("method") || !keys.has("headers") || !sequence("}", ")", ";", "}", ";")) return false;
  if (take("try") && !take("{")) return false;
  if (!sequence("const", "response", "=", "method", "=", "=", "=") || token?.literal !== "GET") return false;
  advance();
  if (!sequence("?", "await", "readProvider", "(", "send")) return false;
  if (signalOwned && !sequence(",", "{", "signal", ",", "deadline", ":", "operationDeadline", "}")) return false;
  return sequence(")", ":", "await", "send", "(", ")", ";");
}

/** Only these Windows callbacks may put a synchronous ownership guard before a provider fetch. */
function reviewedWindowsGuardedFetch(rel: string, before: string, target: string | undefined, after: string): boolean {
  if (rel !== "scripts/windows-qualification-runtime.ts") return false;
  if (target === "url") {
    const send = /const send = (\(\)|\(readSignal: AbortSignal = signal\)) => \{\s*assertWindowsExecution\(execution\);\s*(if \(deadline !== undefined\) windowsRemaining\(started, deadline, performance\.now\(\), execution, "not_started"\);\s*)?return\s*$/u.exec(before);
    if (!send || (send[1] === "()" && send[2] === undefined)) return false;
    return windowsReadDispatcher(after, send[1] !== "()");
  }
  if (target !== '"https://api.ipify.org"') return false;
  const callback = /readProvider\(\s*(\(\)|\(signal\))\s*=>\s*\{\s*assertWindowsExecution\(execution\);\s*return\s*$/u.exec(before);
  if (!callback) return false;
  return callback[1] === "()"
    ? /^,\s*\{\s*signal:\s*AbortSignal\.timeout\(15_000\)\s*\}\s*\);\s*\}\s*\)/u.test(after)
    : /^,\s*\{\s*signal:\s*AbortSignal\.any\(\[signal,\s*AbortSignal\.timeout\(15_000\)\]\)\s*\}\s*\);\s*\}\s*(?:,\s*execution\s*\?\?\s*\{\s*\})?\s*\)/u.test(after);
}

export function checkProviderReads(rel: string, text: string): string[] {
  if (!/^scripts\/.+\.ts$/u.test(rel) || rel.endsWith(".test.ts")) return [];
  const failures: string[] = [];
  // One optional signal parameter changes cancellation, not the read-only replay boundary.
  const readCallback = /readProvider\(\s*(?:\(\s*(?:[A-Za-z_$][\w$]*)?\s*\)|[A-Za-z_$][\w$]*)\s*=>\s*$/u;
  for (const match of text.matchAll(/\b(?:globalThis\.)?fetch\s*\(\s*([^,\n]+)/gu)) {
    const target = match[1]?.trim().replace(/\);$/u, "");
    const before = text.slice(0, match.index);
    if (reviewedWindowsGuardedFetch(rel, before, target, text.slice(match.index! + match[0].length))) continue;
    if (rel === "scripts/browserstack.ts" && target === '`${API}/sessions/${sessionId}.json`') {
      const after = text.slice(match.index! + match[0].length);
      if (!readCallback.test(before) && /^,\s*\{\s*method:\s*"DELETE"/u.test(after)) continue;
      failures.push(`${rel}:${before.split("\n").length}: BrowserStack record deletion must be a single unretried DELETE`);
      continue;
    }
    if (rel === "scripts/device-cloud-webdriver.ts" && target === '`${connection.endpoint}${path}`') {
      if (/const send = \(\) => $/u.test(before) &&
        (text.includes('const response = method === "GET" ? await readProvider(send) : await send();') ||
          text.includes('const response = method === "GET" ? await readProvider(send, signal === undefined ? {} : { signal }) : await send();')) &&
        text.includes('endpoint: "https://hub.testingbot.com/wd/hub"') &&
        text.includes('endpoint: "https://hub.browserstack.com/wd/hub"')) continue;
      failures.push(`${rel}:${before.split("\n").length}: cloud WebDriver dispatcher must pin endpoints and retry GET only`);
      continue;
    }
    if (rel !== "scripts/windows-qualification-runtime.ts" && readCallback.test(before)) continue;
    if (target !== undefined && nonProviderFetches[rel.slice("scripts/".length)]?.includes(target)) continue;
    failures.push(rel + ":" + (before.split("\n").length) + ": unreviewed direct fetch; use readProvider for idempotent provider reads or document the exact non-provider target");
  }
  return failures;
}

interface SourceToken {
  value: string;
  line: number;
  literal?: string;
}

function decodeSourceLiteral(raw: string): string {
  return raw.replace(/\\(?:\r\n|[\n\r\u2028\u2029]|u\{[a-f0-9]+\}|u[a-f0-9]{4}|x[a-f0-9]{2}|.)/giu, escaped => {
    const value = escaped.slice(1);
    if (/^[\n\r\u2028\u2029]/u.test(value)) return "";
    if (/^[ux]/u.test(value)) {
      const code = Number.parseInt(value.startsWith("u{") ? value.slice(2, -1) : value.slice(1), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : escaped;
    }
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[value] ?? value;
  });
}

function* sourceTokens(source: string, retainLiterals = false): Generator<SourceToken> {
  let offset = 0;
  let line = 1;
  const advance = (): string => {
    const char = source[offset++] ?? "";
    if (char === "\n" || (char === "\r" && source[offset] !== "\n") || char === "\u2028" || char === "\u2029") line++;
    return char;
  };
  const quoted = (quote: string): void => {
    advance();
    while (offset < source.length) {
      const char = advance();
      if (char === "\\") advance();
      else if (char === quote) break;
    }
  };
  function* code(interpolation = false): Generator<SourceToken> {
    let depth = 0;
    let previous = "";
    let regexAllowed = true;
    const controlParens: boolean[] = [];
    while (offset < source.length) {
      const char = source[offset] ?? "";
      const next = source[offset + 1];
      if (/\s/u.test(char)) {
        advance();
        continue;
      }
      if (char === "/" && next === "/") {
        while (offset < source.length && !/[\r\n\u2028\u2029]/u.test(source[offset] ?? "")) advance();
        continue;
      }
      if (char === "/" && next === "*") {
        advance();
        advance();
        while (offset < source.length && !(source[offset] === "*" && source[offset + 1] === "/")) advance();
        advance();
        advance();
        continue;
      }
      const tokenLine = line;
      let value: string;
      let literal: string | undefined;
      if (char === "'" || char === '"') {
        const start = offset;
        quoted(char);
        if (retainLiterals) literal = decodeSourceLiteral(source.slice(start + 1, offset - 1));
        value = "<literal>";
      } else if (char === "\x60") {
        advance();
        const start = offset;
        let interpolated = false;
        while (offset < source.length) {
          const templateChar = advance();
          if (templateChar === "\\") advance();
          else if (templateChar === "\x60") break;
          else if (templateChar === "$" && source[offset] === "{") {
            if (!interpolated) yield { value: "<literal>", line: tokenLine };
            interpolated = true;
            advance();
            yield { value: "{", line };
            yield* code(true);
          }
        }
        if (retainLiterals && !interpolated) literal = decodeSourceLiteral(source.slice(start, offset - 1));
        value = "<literal>";
      } else if (char === "/" && regexAllowed) {
        advance();
        let inClass = false;
        while (offset < source.length) {
          const regexChar = advance();
          if (regexChar === "\\") advance();
          else if (regexChar === "[") inClass = true;
          else if (regexChar === "]") inClass = false;
          else if (regexChar === "/" && !inClass) break;
          else if (/[\r\n\u2028\u2029]/u.test(regexChar)) break;
        }
        while (/[a-z]/iu.test(source[offset] ?? "")) advance();
        value = "<literal>";
      } else if (/[$\p{ID_Continue}]/u.test(char)) {
        const start = offset;
        do { advance(); } while (/[$\p{ID_Continue}]/u.test(source[offset] ?? ""));
        value = source.slice(start, offset);
      } else {
        value = advance();
        if (["=>", "?.", "++", "--", "&&", "||", "??"].includes(value + (source[offset] ?? ""))) value += advance();
      }
      yield { value, line: tokenLine, ...(literal === undefined ? {} : { literal }) };
      if (value === "{") depth++;
      if (value === "}" && depth-- === 0 && interpolation) return;
      if (value === "(") controlParens.push(/^(?:if|while|for|with|switch|catch)$/u.test(previous));
      regexAllowed = value === ")"
        ? controlParens.pop() === true
        : /^(?:[({[,:;=!?&|+*%~^<>-]|=>|&&|\|\||\?\?|return|throw|case|delete|void|typeof|yield|await|in|of|else|do|instanceof|new)$/u.test(value);
      previous = value;
    }
  }
  yield* code();
}

export function checkUnsafeFinally(relativePath: string, source: string): string[] {
  if (!/^(?:scripts\/|apps\/[^/]+\/src\/).+\.ts$/u.test(relativePath) || /\.(?:test|e2e)\.ts$/u.test(relativePath)) return [];
  const violations: string[] = [];
  const braces: boolean[] = [];
  let finallyDepth = 0;
  let previous = "";
  let candidate: SourceToken | undefined;
  // Deliberately lexical: nested function bodies also count; move their control flow outside finally.
  for (const token of sourceTokens(source)) {
    if (candidate !== undefined && token.value !== ":") {
      violations.push(relativePath + ":" + candidate.line + ": unsafe " + candidate.value + " in finally block");
    }
    candidate = undefined;
    if (token.value === "{") {
      const isFinally = previous === "finally";
      braces.push(isFinally);
      if (isFinally) finallyDepth++;
    } else if (token.value === "}") {
      if (braces.pop()) finallyDepth--;
    } else if (finallyDepth > 0 && (token.value === "throw" || token.value === "return") && previous !== "." && previous !== "?.") {
      candidate = token;
    }
    previous = token.value;
  }
  if (candidate !== undefined) violations.push(relativePath + ":" + candidate.line + ": unsafe " + candidate.value + " in finally block");
  return violations;
}

/**
 * All test races are checked, not just receivers named "subprocess": a helper/alias can own the
 * real process or socket. Behavioral/fake-clock deadlines need a reason on the timer's own line
 * or the immediately preceding line. Strings, regexes and comments are not executable timers.
 */
export function checkHangDeadlines(relativePath: string, source: string): string[] {
  if (!/^(?:apps\/[^/]+\/(?:test|e2e)\/.+\.tsx?|scripts\/.+\.test\.ts|scripts\/test-(?:support|browser|portable|visual)\.ts)$/u.test(relativePath)) return [];
  const tokens = [...sourceTokens(source, true)];
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (["(", "[", "{"].includes(token.value)) stack.push(index);
    else if ([")", "]", "}"].includes(token.value)) {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, index);
    }
  }
  const races: Array<{ start: number; end: number }> = [];
  for (const [index, token] of tokens.entries()) {
    if (token.value === "Promise" && tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.value === "race" && tokens[index + 3]?.value === "(") {
      races.push({ start: index + 3, end: pairs.get(index + 3) ?? index + 3 });
    }
  }
  const lines = source.split(/\r\n|[\r\n\u2028\u2029]/u);
  const violations: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (tokens[index + 1]?.value !== "(") continue;
    const receiver = tokens[index - 2]?.value;
    const member = tokens[index - 1]?.value === ".";
    const abort = member && receiver === "AbortSignal" && token.value === "timeout";
    const sleep = member && receiver === "Bun" && token.value === "sleep";
    const timer = token.value === "setTimeout";
    if (!abort && !sleep && !timer) continue;
    const end = pairs.get(index + 1);
    if (end === undefined) continue;
    let argument = index + 2;
    if (timer) {
      for (; argument < end && tokens[argument]?.value !== ","; argument++) {
        argument = pairs.get(argument) ?? argument;
      }
      argument++;
    }
    const numeric = tokens[argument];
    if (numeric === undefined || !/^\d[\d_]*$/u.test(numeric.value) ||
      ![",", ")"].includes(tokens[argument + 1]?.value ?? "")) continue;
    const milliseconds = Number(numeric.value.replaceAll("_", ""));
    if (milliseconds >= HANG_DEADLINE_MS) continue;
    const killsChild = timer && tokens.slice(index + 2, end).some((part, at, body) =>
      part.value === "kill" && body[at - 1]?.value === ".");
    if (!abort && !killsChild && !races.some(race => race.start < index && index < race.end)) continue;
    const allowance = /\/\/\s*hang-deadline:\s*behavior-under-test\s+--\s+\S/u;
    if ([lines[token.line - 1], lines[token.line - 2]].some(line => line !== undefined && allowance.test(line))) continue;
    violations.push(`${relativePath}:${token.line}: literal ${milliseconds}ms hang deadline is below HANG_DEADLINE_MS (${HANG_DEADLINE_MS}); use the shared budget or annotate behavior under test`);
  }
  return violations;
}

/**
 * Document-context web sources schedule every timer through `window` or an injected clock. A bare
 * global timer cannot be cancelled by the page's owner, and in the unit harness it outlives the
 * fake document it would render into: a fleet grace timer once fired during another test file.
 * The service worker is a different global and is excluded.
 */
export function checkDocumentTimers(relativePath: string, source: string): string[] {
  if (!/^apps\/web\/src\/(?!service-worker\.ts$).+\.ts$/u.test(relativePath)) return [];
  const tokens = [...sourceTokens(source)];
  const violations: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!/^(?:set|clear)(?:Timeout|Interval)$/u.test(token.value) || tokens[index + 1]?.value !== "(") continue;
    const previous = tokens[index - 1]?.value ?? "";
    // Member access and `function setTimeout` definitions are not global calls.
    if (previous === "." || previous === "?." || previous === "function") continue;
    // A method signature in an interface or type literal: `setTimeout(...): number;`.
    let depth = 0;
    let close = index + 1;
    for (; close < tokens.length; close++) {
      if (tokens[close]?.value === "(") depth++;
      else if (tokens[close]?.value === ")" && --depth === 0) break;
    }
    if (tokens[close + 1]?.value === ":" && /^(?:\{|\}|;|,)$/u.test(previous)) continue;
    violations.push(relativePath + ":" + token.line + ": bare " + token.value + "; schedule through window or an injected clock");
  }
  return violations;
}

/** Network completion is not application readiness. Keep HTTP-contract assertions explicit. */
export function checkE2EReadiness(relativePath: string, source: string): string[] {
  if (!/^apps\/web\/e2e\/.+\.ts$/u.test(relativePath)) return [];
  const tokens = [...sourceTokens(source, true)];
  const violations: string[] = [];
  const pairs = new Map<number, number>();
  const delimiters: number[] = [];
  const scopes: number[] = [];
  const blocks = [-1];
  for (const [index, token] of tokens.entries()) {
    scopes[index] = blocks.at(-1)!;
    if (["(", "[", "{"].includes(token.value)) delimiters.push(index);
    else if ([")", "]", "}"].includes(token.value)) {
      const open = delimiters.pop();
      if (open !== undefined) { pairs.set(open, index); pairs.set(index, open); }
    }
    if (token.value === "{") blocks.push(index);
    else if (token.value === "}") blocks.pop();
  }
  const conciseArrowEnd = (start: number): number => {
    let end = start;
    for (; end < tokens.length && ![";", ",", ")", "]", "}"].includes(tokens[end]?.value ?? ""); end++) {
      if (["(", "[", "{"].includes(tokens[end]?.value ?? "")) end = pairs.get(end) ?? end;
    }
    return end;
  };
  // Expression-bodied arrows have function scopes too, even without a brace to stop a scan.
  for (const [index, token] of tokens.entries()) {
    if (token.value !== "=>" || tokens[index + 1]?.value === "{") continue;
    const parent = scopes[index];
    const end = conciseArrowEnd(index + 1);
    for (let cursor = index + 1; cursor < end; cursor++) {
      if (scopes[cursor] === parent) scopes[cursor] = index;
    }
  }
  type Span = { start: number; end: number }; // end is exclusive.
  const unwrap = (input: Span): Span => {
    let { start, end } = input;
    while (start < end) {
      if (tokens[start]?.value === "await") start++;
      else if (tokens[start]?.value === "(" && pairs.get(start) === end - 1) { start++; end--; }
      else break;
    }
    return { start, end };
  };
  const expressions = (start: number, end: number): Span[] => {
    const values: Span[] = [];
    let first = start;
    for (let cursor = start; cursor < end; cursor++) {
      if (tokens[cursor]?.value === ",") { values.push({ start: first, end: cursor }); first = cursor + 1; }
      else if (["(", "[", "{"].includes(tokens[cursor]?.value ?? "")) cursor = pairs.get(cursor) ?? cursor;
    }
    values.push({ start: first, end });
    return values;
  };
  const expressionStart = (last: number): number => {
    let start = [")", "]"].includes(tokens[last]?.value ?? "") ? pairs.get(last) ?? last : last;
    while (start > 1 && [".", "?."].includes(tokens[start - 1]?.value ?? "")) {
      const before = start - 2;
      start = [")", "]"].includes(tokens[before]?.value ?? "") ? pairs.get(before) ?? before : before;
    }
    return start;
  };
  interface Binding { name: string; at: number; scope: number; initializer: Span; slot?: number }
  const bindings: Binding[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!["const", "let", "var"].includes(token.value)) continue;
    const pattern = index + 1;
    const array = tokens[pattern]?.value === "[";
    const patternEnd = array ? (pairs.get(pattern) ?? pattern) + 1 : pattern + 1;
    if (!array && !/^[$_\p{ID_Start}][\p{ID_Continue}$]*$/u.test(tokens[pattern]?.value ?? "")) continue;
    let equal = patternEnd;
    // A type annotation does not change the binding; its nested type literal is not a block.
    for (; equal < tokens.length && !["=", ";", "}"].includes(tokens[equal]?.value ?? ""); equal++) {
      if (["(", "[", "{"].includes(tokens[equal]?.value ?? "")) equal = pairs.get(equal) ?? equal;
    }
    if (tokens[equal]?.value !== "=") continue;
    let end = equal + 1;
    for (; end < tokens.length && ![";", ",", "}"].includes(tokens[end]?.value ?? ""); end++) {
      if (["(", "[", "{"].includes(tokens[end]?.value ?? "")) end = pairs.get(end) ?? end;
    }
    const initializer = { start: equal + 1, end };
    const names = array ? expressions(pattern + 1, patternEnd - 1) : [{ start: pattern, end: patternEnd }];
    for (const [slot, name] of names.entries()) {
      if (name.end !== name.start + 1 || !/^[$_\p{ID_Start}][\p{ID_Continue}$]*$/u.test(tokens[name.start]?.value ?? "")) continue;
      bindings.push({ name: tokens[name.start]!.value, at: name.start, scope: scopes[index]!, initializer, ...(array ? { slot } : {}) });
    }
  }
  const resolveBinding = (name: string, at: number, scope: number): Binding | undefined =>
    bindings.filter(binding => binding.scope === scope && binding.name === name && binding.at < at).at(-1);
  const unmodified = (binding: Binding, until: number): boolean => {
    for (let cursor = binding.at + 1; cursor < until; cursor++) {
      // Parameter bindings are not recorded; do not mistake their writes for outer mutations.
      // Skip only the nested function, then keep looking for later outer writes.
      if (tokens[cursor]?.value === "function") {
        let body = cursor + 1;
        for (; body < tokens.length && tokens[body]?.value !== "{"; body++) {
          if (["(", "["].includes(tokens[body]?.value ?? "")) body = pairs.get(body) ?? body;
        }
        cursor = pairs.get(body) ?? body;
        continue;
      }
      if (tokens[cursor]?.value === "=>") {
        const body = cursor + 1;
        cursor = tokens[body]?.value === "{" ? pairs.get(body) ?? body : conciseArrowEnd(body) - 1;
        continue;
      }
      if (tokens[cursor]?.value === binding.name &&
        ![".", "?."].includes(tokens[cursor - 1]?.value ?? "") && tokens[cursor + 1]?.value === "=") return false;
    }
    return true;
  };
  const staticString = (index: number): string | undefined => {
    const token = tokens[index];
    if (token?.literal !== undefined) return token.literal;
    if (!/^[$_\p{ID_Start}][\p{ID_Continue}$]*$/u.test(token?.value ?? "")) return undefined;
    for (let scope = scopes[index]!; ; scope = scopes[scope]!) {
      const binding = resolveBinding(token!.value, index, scope);
      if (binding !== undefined) {
        if (binding.slot !== undefined || !unmodified(binding, index)) return undefined;
        const value = unwrap(binding.initializer);
        return value.end === value.start + 1 ? tokens[value.start]?.literal : undefined;
      }
      if (scope === -1) return undefined;
    }
  };
  const memberAt = (index: number): { name: string; after: number; receiver: number } | undefined => {
    const token = tokens[index]!;
    const previous = tokens[index - 1]?.value ?? "";
    if (token.value === "[") {
      const close = pairs.get(index);
      if (close === undefined || !/^(?:[$\p{ID_Continue}]+|[)\]]|\?\.)$/u.test(previous)) return undefined;
      const literal = unwrap({ start: index + 1, end: close });
      const name = literal.end === literal.start + 1 ? staticString(literal.start) : undefined;
      if (name !== undefined) return { name, after: close + 1, receiver: index - (previous === "?." ? 2 : 1) };
    } else if (previous === "." || previous === "?.") return { name: token.value, after: index + 1, receiver: index - 2 };
    return undefined;
  };
  const httpAsserted = (origin: number, callOpen: number, callEnd: number, receiver: number): boolean => {
    const scope = scopes[origin]!;
    const callStart = expressionStart(receiver);
    const refersToResponse = (input: Span, at: number, seen = new Set<Binding>()): boolean => {
      const span = unwrap(input);
      if (span.start === callStart && span.end === callEnd + 1) return true;
      if (span.end !== span.start + 1) return false;
      const binding = resolveBinding(tokens[span.start]?.value ?? "", at, scope);
      if (binding === undefined || seen.has(binding) || !unmodified(binding, at)) return false;
      seen.add(binding);
      let value = unwrap(binding.initializer);
      if (binding.slot !== undefined) {
        // Promise.all preserves the correspondence between destructured variables and inputs.
        if (tokens[value.start]?.value !== "Promise" || tokens[value.start + 1]?.value !== "." ||
          tokens[value.start + 2]?.value !== "all" || tokens[value.start + 3]?.value !== "(" ||
          tokens[value.start + 4]?.value !== "[") return false;
        const close = pairs.get(value.start + 4);
        if (close === undefined) return false;
        const item = expressions(value.start + 5, close)[binding.slot];
        if (item === undefined) return false;
        value = item;
      }
      return refersToResponse(value, binding.at, seen);
    };
    const boundary = scope === -1 ? tokens.length : pairs.get(scope) ?? tokens.length;
    // Inline expect((await page.waitForResponse(...)).status()) starts before the response call.
    for (let cursor = 0; cursor < boundary; cursor++) {
      if (scopes[cursor] !== scope || tokens[cursor]?.value !== "expect" || tokens[cursor + 1]?.value !== "(") continue;
      const close = pairs.get(cursor + 1);
      if (close === undefined || close <= callOpen) continue;
      let matcher = close + 1;
      if (tokens[matcher]?.value !== ".") continue;
      matcher++;
      if (tokens[matcher]?.value === "not") matcher += 2;
      if (!tokens[matcher]?.value.startsWith("to")) continue;
      for (let position = cursor + 2; position < close; position++) {
        if (scopes[position] !== scope) continue;
        const member = memberAt(position);
        if (member === undefined || !["status", "ok", "headers", "headerValue", "json", "body", "text"].includes(member.name)) continue;
        const reference = { start: expressionStart(member.receiver), end: member.receiver + 1 };
        if (refersToResponse(reference, position)) return true;
      }
    }
    return false;
  };
  for (const [index, token] of tokens.entries()) {
    const member = memberAt(index);
    if (member === undefined) continue;
    if (member.name === "finished") {
      violations.push(`${relativePath}:${token.line}: response completion access is not e2e readiness; observe application state`);
      continue;
    }
    let after = member.after;
    if (tokens[after]?.value === "?.") after++;
    if (tokens[after]?.value !== "(") continue;
    const end = pairs.get(after) ?? tokens.length;
    if (["waitForEvent", "on", "once", "addListener"].includes(member.name)) {
      const first = unwrap(expressions(after + 1, end)[0]!);
      if (first.end === first.start + 1 && staticString(first.start) === "requestfinished") {
        violations.push(`${relativePath}:${token.line}: request-finished events are not e2e readiness; observe application state`);
      }
    } else if (["goto", "reload", "goBack", "goForward", "setContent", "waitForURL", "waitForNavigation", "waitForLoadState"].includes(member.name)) {
      for (let argument = after + 1; argument < end; argument++) {
        if (staticString(argument) !== "networkidle") continue;
        violations.push(`${relativePath}:${token.line}: networkidle is not e2e readiness; observe application state`);
        break;
      }
    } else if (member.name === "waitForResponse" && !httpAsserted(index, after, end, member.receiver)) violations.push(`${relativePath}:${token.line}: waitForResponse requires an explicit HTTP-contract assertion, not UI readiness`);
  }
  return violations;
}

export function checkWorkflowMergeQueue(name: string, text: string): string[] {
  if (!["ci.yml", "compatibility.yml", "platform-qualification.yml"].includes(name)) return [];
  const workflow = Bun.YAML.parse(text) as { on?: Record<string, unknown> };
  const trigger = workflow.on?.merge_group;
  if (JSON.stringify(trigger) !== JSON.stringify({ types: ["checks_requested"] })) {
    return [`${name}: required checks must run on merge_group checks_requested without filters`];
  }
  return [];
}

export function checkWorkflowBunVersions(name: string, text: string, packageManager: string): string[] {
  const failures: string[] = [];
  const version = packageManager.replace(/^bun@/u, "");
  const workflow = Bun.YAML.parse(text) as {
    jobs?: Record<string, { steps?: Array<{ uses?: string; if?: unknown; with?: Record<string, unknown>; run?: string }> }>;
  };
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const steps = job.steps ?? [];
    const setups = steps.filter(step => step.uses?.startsWith("oven-sh/setup-bun@"));
    if (name === "ci.yml" && !setups.some(step => step.if === undefined && step.with?.["bun-version"] === version)) {
      failures.push(`${name}: ${jobName} must unconditionally install the packageManager Bun version`);
    }
    for (const setup of setups) {
      if (setup.with?.["bun-version"] !== version) {
        failures.push(`${name}: ${jobName} setup-bun must use the packageManager Bun version (${version})`);
      }
    }
    for (const step of steps) {
      for (const match of (step.run ?? "").matchAll(/\btest\s+"\$\(\s*bun\s+--version\s*\)"\s+=\s+(?:"([^"]+)"|'([^']+)'|([^\s;]+))/gu)) {
        if ((match[1] ?? match[2] ?? match[3]) !== version) {
          failures.push(`${name}: ${jobName} Bun version assertion must use the packageManager Bun version (${version})`);
        }
      }
    }
  }
  return failures;
}

export function checkChangelogFile(path: string, source: string): string[] {
  if (path.startsWith("changelog.d/") && path !== "changelog.d/README.md") {
    return checkChangelogFragment(path, source);
  }
  if (path !== "CHANGELOG.md") return [];
  const pending = source.match(/(?:^|\n)## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/u)?.[1];
  if (pending === undefined) return ["CHANGELOG.md: missing [Unreleased] header"];
  return pending.trim() ? ["CHANGELOG.md: [Unreleased] must be empty; add changelog.d/ fragments instead"] : [];
}

async function main(): Promise<void> {
  const errors: string[] = [];
  for (const rel of required) {
    try {
      await readFile(join(rootPath, rel));
    } catch {
      errors.push(`missing required file: ${rel}`);
    }
  }

  for (const file of await walk(rootPath)) {
    // Rules below name files with forward slashes; Windows `relative` returns backslashes.
    const rel = relative(rootPath, file).split(sep).join("/");
    if (!/\.(?:md|json|jsonc|hujson|ts|tsx|yml|yaml|toml|sh|ps1)$/.test(file) && !["LICENSE", "NOTICE"].includes(rel) && !rel.startsWith("changelog.d/")) {
      continue;
    }
    const text = await readFile(file, "utf8");
    errors.push(...checkChangelogFile(rel, text));
    errors.push(...checkProviderReads(rel, text));
    errors.push(...checkUnsafeFinally(rel, text));
    errors.push(...checkDocumentTimers(rel, text));
    errors.push(...checkE2EReadiness(rel, text));
    errors.push(...checkHangDeadlines(rel, text));
    if (rel === "scripts/check-repository.ts") continue;
    // adb argv must be constructed only by its redacting, exit-checking owner, including calls
    // routed through generic subprocess wrappers. The one executable-prerequisite list is not argv.
    if (rel.startsWith("scripts/") && rel.endsWith(".ts") && !rel.endsWith(".test.ts") && rel !== "scripts/android-device.ts") {
      const commands = text.replace('["adb", "security", "git", "gh", "cosign", "shasum", "ssh", "scp", "bash", "python3", "curl"]', "[]");
      if (/\[\s*["'](?:[^"'\r\n]*[/\\])?adb(?:\.exe)?["']/u.test(commands) ||
        /\b(?:spawn|spawnSync|exec|execFile|execFileSync)\s*\(\s*["'](?:[^"'\r\n]*[/\\])?adb(?:\.exe)?(?:["']|\s)/u.test(commands)) {
        errors.push(rel + ": spawns adb outside android-device.ts; use runAdb");
      }
    }
    for (const old of forbiddenLegacy) {
      if (text.includes(old)) errors.push(`${rel}: contains legacy identifier ${JSON.stringify(old)}`);
    }
    // Bun's Database.exec runs each statement of a multi-statement string, but ignores a runtime
    // failure of every statement except the last. The release-host lease once ignored its busy
    // BEGIN IMMEDIATE that way, then waited out its busy timeout a second time on the next statement.
    if (/\.tsx?$/u.test(rel) && /from\s+["']bun:sqlite["']/u.test(text)) {
      for (const match of text.matchAll(/\.(?:exec|run)\(\s*(?:"[^"]*;\s*[^"\s][^"]*"|'[^']*;\s*[^'\s][^']*'|`[^`]*;\s*[^`\s][^`]*`)/gu)) {
        errors.push(`${rel}:${text.slice(0, match.index).split("\n").length}: runs several SQLite statements in one exec; Bun ignores the failure of all but the last`);
      }
    }
    // A file URL's pathname is "/D:/..." on Windows, which no filesystem API can open.
    if (/\.tsx?$/u.test(rel) && /import\.meta\.url\)\.pathname\b/u.test(text)) {
      errors.push(`${rel}: uses a file URL's pathname as a filesystem path; use fileURLToPath`);
    }
    // A candidate tag keeps its prerelease suffix when only the "v" is removed: v0.6.0-prealpha.1
    // installs as 0.6.0, and the Windows lane once compared against "0.6.0-prealpha.1".
    if (/^scripts\/.+\.ts$/u.test(rel) && /[Tt]ag\.slice\(1\)/u.test(text)) {
      errors.push(`${rel}: derives a package version by slicing a release tag; use releaseVersion`);
    }
    if (rel.endsWith(".md") && /\$\{[A-Z_]*TAG#v\}/u.test(text)) {
      errors.push(`${rel}: derives a package version by stripping a release tag's "v"; a prerelease tag keeps its suffix`);
    }
    // `config set` can exit 0 without writing: over WinRM, a compiled OMP's first write did, and the
    // Windows lane's host started with auto-start off and never published. Only a read-back proves it.
    if (/^scripts\//u.test(rel) && /config['",\s]+set['",\s]+collab\.autoStart/u.test(text) && !/config['",\s]+get['",\s]+collab\.autoStart/u.test(text)) {
      errors.push(`${rel}: enables collab.autoStart without reading it back`);
    }
    // A create-time `mode` is filtered by the umask. A test that needs a group- or world-accessible
    // fixture must chmod it, or a 077 umask silently makes it private, as provision-linux-qual.test.ts did.
    if (rel.endsWith(".test.ts")) {
      for (const [, target, mode] of text.matchAll(/\b(?:writeFile|mkdir)\(\s*([\w.]+)\s*,[^;]*?\{\s*(?:recursive:\s*true,\s*)?mode:\s*0o([0-7]{3,4})\s*\}/gu)) {
        if (!target || !mode || (Number.parseInt(mode, 8) & 0o077) === 0) continue;
        if (!new RegExp(`\\b(?:chmod|makeFixtureUnsafe)\\(\\s*${target.replaceAll(".", "\\.")}\\s*[,)]`, "u").test(text)) {
          errors.push(`${rel}: creates ${target} with mode 0o${mode} but never chmods it; the umask can make it private`);
        }
      }
    }
  }

  for (const rel of [
    "package.json",
    "UPSTREAM.lock.json",
    "schemas/omp-host-registry.schema.json",
    "schemas/session-list.schema.json",
    "schemas/client-config.schema.json",
    "schemas/session-creation-options.schema.json",
    "schemas/session-creation-request.schema.json",
    "schemas/session-creation-status.schema.json",
    "schemas/launch-request.schema.json",
    "schemas/launch-response.schema.json",
    "schemas/sse-event.schema.json",
    "schemas/upstream-lock.schema.json",
  ]) {
    try {
      JSON.parse(await readFile(join(rootPath, rel), "utf8"));
    } catch (error) {
      errors.push(`${rel}: invalid JSON (${error instanceof Error ? error.message : "unknown error"})`);
    }
  }

  const packageJson = JSON.parse(await readFile(join(rootPath, "package.json"), "utf8")) as { name?: string; packageManager: string };
  if (packageJson.name !== "omp-session-gateway") {
    errors.push(`package.json: expected name omp-session-gateway, got ${String(packageJson.name)}`);
  }

  const dependabot = Bun.YAML.parse(await readFile(join(rootPath, ".github/dependabot.yml"), "utf8")) as {
    updates?: Array<{
      "package-ecosystem"?: string;
      directory?: string;
      ignore?: Array<{ "dependency-name"?: string }>;
    }>;
  };
  const bunUpdates = dependabot.updates?.filter(update => update["package-ecosystem"] === "bun") ?? [];
  if (bunUpdates.length !== 1 || bunUpdates[0]?.directory !== "/") {
    errors.push("dependabot.yml: expected one root Bun ecosystem update");
  }
  if (dependabot.updates?.some(update => update["package-ecosystem"] === "npm") === true) {
    errors.push("dependabot.yml: npm cannot maintain bun.lock; use the Bun ecosystem");
  }
  const collabClientPackage = JSON.parse(
    await readFile(join(rootPath, "packages/collab-client/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const ignoredBunDependencies = new Set(
    bunUpdates[0]?.ignore?.map(entry => entry["dependency-name"]).filter(name => name !== undefined),
  );
  for (const dependency of [
    ...Object.keys(collabClientPackage.dependencies ?? {}),
    "@types/bun",
    "@playwright/test",
    "@percy/cli",
    "@percy/playwright",
  ]) {
    if (!ignoredBunDependencies.has(dependency)) {
      errors.push(`dependabot.yml: ${dependency} must move with its pinned runtime owner, not Dependabot`);
    }
  }

  // Fleet images may carry an older Bun. CI jobs must establish the pin unconditionally,
  // and every workflow's setup and explicit version assertions must agree with packageManager.
  const workflows = join(rootPath, ".github/workflows");
  for (const name of await readdir(workflows)) {
    if (!/\.ya?ml$/u.test(name)) continue;
    const source = await readFile(join(workflows, name), "utf8");
    errors.push(...checkWorkflowBunVersions(name, source, packageJson.packageManager));
    errors.push(...checkWorkflowMergeQueue(name, source));
  }

  const canonicalChecks: Array<[string, string]> = [
    ["README.md", "# OMP Session Gateway"],
    ["AGENTS.md", "Daemon: `omp-gatewayd`"],
    ["AGENTS.md", "PWA name: **OMP Sessions**"],
    ["AGENTS.md", "Default example tailnet tag: `tag:omp-session-gateway`"],
  ];
  for (const [rel, expected] of canonicalChecks) {
    const text = await readFile(join(rootPath, rel), "utf8");
    if (!text.includes(expected)) errors.push(`${rel}: missing canonical identifier ${JSON.stringify(expected)}`);
  }

  if (errors.length > 0) {
    console.error(errors.map(error => `- ${error}`).join("\n"));
    process.exit(1);
  }

  console.log(`repository check passed (${(await walk(rootPath)).length} files scanned)`);
}

if (import.meta.main) await main();
