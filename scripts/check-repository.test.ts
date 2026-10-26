import { expect, test } from "bun:test";
import { checkDocumentTimers, checkProviderReads, checkUnsafeFinally } from "./check-repository.ts";

test("cloud transport may retry only GET, and record DELETE is never replayed", () => {
  const source = 'const connection = { endpoint: "https://hub.testingbot.com/wd/hub", fallback: { endpoint: "https://hub.browserstack.com/wd/hub" } };\n' +
    'const send = () => fetch(`${connection.endpoint}${path}`, { method });\n' +
    'const response = method === "GET" ? await readProvider(send) : await send();';
  expect(checkProviderReads("scripts/device-cloud-webdriver.ts", source)).toEqual([]);
  expect(checkProviderReads("scripts/device-cloud-webdriver.ts", source.replace('method === "GET"', 'method !== "DELETE"'))).toHaveLength(1);
  expect(checkProviderReads("scripts/device-cloud-webdriver.ts", source.replace("const send = () => fetch", "const send = () => readProvider(() => fetch"))).toHaveLength(1);
  const deletion = 'const response = await fetch(`${API}/sessions/${sessionId}.json`, { method: "DELETE" });';
  expect(checkProviderReads("scripts/browserstack.ts", deletion)).toEqual([]);
  expect(checkProviderReads("scripts/browserstack.ts", deletion.replace("await fetch", "await readProvider(() => fetch"))).toHaveLength(1);
  for (const callback of ["signal", "(signal)", "(readSignal)"]) {
    expect(checkProviderReads("scripts/testingbot.ts", `await readProvider(${callback} => fetch(url, { signal }));`)).toEqual([]);
    expect(checkProviderReads("scripts/browserstack.ts", deletion.replace("await fetch", `await readProvider(${callback} => fetch`))).toHaveLength(1);
  }
  const cancellable = source.replace("readProvider(send)", "readProvider(send, signal === undefined ? {} : { signal })");
  expect(checkProviderReads("scripts/device-cloud-webdriver.ts", cancellable)).toEqual([]);
  expect(checkProviderReads("scripts/device-cloud-webdriver.ts", cancellable.replace('method === "GET"', 'method !== "DELETE"'))).toHaveLength(1);
  expect(checkProviderReads("scripts/device-cloud-webdriver.ts", cancellable.replace(": await send()", ": await readProvider(send)"))).toHaveLength(1);
});

test("reports both abrupt completions through nested blocks without leaking past finally", () => {
  const source = [
    "try { return work(); } finally {",
    "  if (failed) {",
    "    throw failure;",
    "  }",
    "  { if (done) return; }",
    "}",
    "return outside;",
    "try { work(); } catch (error) { throw error; }",
    "try {} finally { return other; }",
  ].join("\n");
  expect(checkUnsafeFinally("scripts/nested/cleanup.ts", source)).toEqual([
    "scripts/nested/cleanup.ts:3: unsafe throw in finally block",
    "scripts/nested/cleanup.ts:5: unsafe return in finally block",
    "scripts/nested/cleanup.ts:9: unsafe return in finally block",
  ]);
});

test("keeps outer finally active after an inner finally closes", () => {
  const source = [
    "try {} finally {",
    "  try {} finally { throw inner; }",
    "  return outer;",
    "}",
    "throw outside;",
  ].join("\n");
  expect(checkUnsafeFinally("apps/gateway/src/cleanup.ts", source)).toEqual([
    "apps/gateway/src/cleanup.ts:2: unsafe throw in finally block",
    "apps/gateway/src/cleanup.ts:3: unsafe return in finally block",
  ]);
});

test("ignores comments and quoted text while preserving their newlines", () => {
  const source = [
    "// finally { throw fake; return; }",
    "const label = 'finally { return; }';",
    'const quoted = "finally { throw fake; }";',
    "/* finally {",
    "  return; throw fake;",
    "} */",
    "try {} finally /* } return; */ {",
    "  const double = \"\\\" } throw fake;\";",
    "  const single = '\\\' } return;';",
    "  // } return;",
    "  /* } throw fake; */",
    "  throw real;",
    "}",
    "return outside;",
  ].join("\n");
  expect(checkUnsafeFinally("scripts/cleanup.ts", source)).toEqual([
    "scripts/cleanup.ts:12: unsafe throw in finally block",
  ]);
});

test("ignores template text, escaped backticks and escaped interpolation delimiters", () => {
  const source = [
    "const fake = `finally { return; throw fake; }`;",
    "try {} finally {",
    "  const text = `} return;",
    "    \\` throw fake; \\${return} ${'finally { throw fake; }'}`;",
    "  const nested = `${`finally { return } ${value}`}`;",
    "}",
    "throw outside;",
  ].join("\n");
  expect(checkUnsafeFinally("scripts/cleanup.ts", source)).toEqual([]);
});

test("scans executable template interpolations including nested templates", () => {
  const source = [
    "try {} finally {",
    "  const text = `raw } return ${(() => {",
    "    const nested = `${(() => { throw failure; })()}`;",
    "    return nested;",
    "  })()}`;",
    "  throw outer;",
    "}",
    "return outside;",
  ].join("\n");
  expect(checkUnsafeFinally("scripts/cleanup.ts", source)).toEqual([
    "scripts/cleanup.ts:3: unsafe throw in finally block",
    "scripts/cleanup.ts:4: unsafe return in finally block",
    "scripts/cleanup.ts:6: unsafe throw in finally block",
  ]);
});

test("finds finally introduced inside a template interpolation outside any outer finally", () => {
  const source = "const text = `raw finally { return; } ${(() => { try {} finally { throw failure; } })()}`;";
  expect(checkUnsafeFinally("scripts/cleanup.ts", source)).toEqual([
    "scripts/cleanup.ts:1: unsafe throw in finally block",
  ]);
});

test("applies the conservative lexical policy to nested function bodies", () => {
  const source = [
    "try {} finally {",
    "  function callback() { return value; }",
    "  const arrow = () => { throw failure; };",
    "}",
    "function outside() { return value; }",
  ].join("\n");
  expect(checkUnsafeFinally("scripts/cleanup.ts", source)).toEqual([
    "scripts/cleanup.ts:2: unsafe return in finally block",
    "scripts/cleanup.ts:3: unsafe throw in finally block",
  ]);
});

test("does not mistake identifiers or member and property names for abrupt completions", () => {
  const source = [
    "promise.finally(() => { return value; });",
    "const obj = { finally: { value: true } };",
    "try {} finally {",
    "  iterator.return(); iterator?.throw(failure);",
    "  const object = { return: true, throw: false };",
    "  const returnValue = object.return; const throwFailure = object.throw;",
    "  const returné = 1; const thrown = 2;",
    "}",
  ].join("\n");
  expect(checkUnsafeFinally("scripts/cleanup.ts", source)).toEqual([]);
});

test("regex braces and keyword text do not close finally or create violations", () => {
  const source = [
    "const fake = /finally { throw fake; return; }/;",
    "try {} finally {",
    "  const regex = /[}\\/]return|throw/giu;",
    "  if (match) /} return; throw/.test(value);",
    "  const ratio = count / total / scale;",
    "  throw real;",
    "}",
  ].join("\n");
  expect(checkUnsafeFinally("scripts/cleanup.ts", source)).toEqual([
    "scripts/cleanup.ts:6: unsafe throw in finally block",
  ]);
});

test("a regex after else, do or an operand keyword cannot end finally early", () => {
  const source = [
    "function f(v) { try {} finally {",
    "  if (v) work(); else /[}]/.test(v);",
    "  do /[}]/.test(v); while (false);",
    "  const typed = v instanceof /[}]/.constructor;",
    "  return;",
    "} }",
  ].join("\n");
  expect(checkUnsafeFinally("scripts/cleanup.ts", source)).toEqual([
    "scripts/cleanup.ts:5: unsafe return in finally block",
  ]);
});

test("reports one-based lines across CRLF, CR and Unicode line separators", () => {
  const source = "try {} finally {\r\n/* comment\rcontinued */\u2028return;\u2029throw error;\n}";
  expect(checkUnsafeFinally("scripts/cleanup.ts", source)).toEqual([
    "scripts/cleanup.ts:4: unsafe return in finally block",
    "scripts/cleanup.ts:5: unsafe throw in finally block",
  ]);
});

test("restricts enforcement to production TypeScript scripts and application sources", () => {
  const source = "try {} finally { return; }";
  for (const path of ["scripts/cleanup.ts", "scripts/nested/cleanup.ts", "apps/web/src/cleanup.ts", "apps/gateway/src/nested/cleanup.ts"]) {
    expect(checkUnsafeFinally(path, source)).toEqual([path + ":1: unsafe return in finally block"]);
  }
  for (const path of [
    "scripts/cleanup.test.ts", "scripts/cleanup.e2e.ts", "apps/web/src/cleanup.test.ts", "apps/web/src/nested/cleanup.e2e.ts",
    "packages/shared/src/cleanup.ts", "apps/web/cleanup.ts", "apps/nested/web/src/cleanup.ts", "apps/web/src/cleanup.tsx",
    "scripts/cleanup.js", "other/scripts/cleanup.ts",
  ]) {
    expect(checkUnsafeFinally(path, source)).toEqual([]);
  }
});

test("document-context web sources schedule timers only through window or an injected clock", () => {
  // The two shapes fleet.ts shipped with: a bare abort timer and a bare-global default clock.
  const leaked = [
    "const timer = setTimeout(() => controller.abort(), 4_000);",
    "const clock = { setTimeout: (callback, delay) => Number(setTimeout(callback, delay)), clearTimeout: timer => clearTimeout(timer) };",
    "try { work(); } finally { clearTimeout(timer); }",
  ].join("\n");
  expect(checkDocumentTimers("apps/web/src/fleet.ts", leaked)).toEqual([
    "apps/web/src/fleet.ts:1: bare setTimeout; schedule through window or an injected clock",
    "apps/web/src/fleet.ts:2: bare setTimeout; schedule through window or an injected clock",
    "apps/web/src/fleet.ts:2: bare clearTimeout; schedule through window or an injected clock",
    "apps/web/src/fleet.ts:3: bare clearTimeout; schedule through window or an injected clock",
  ]);
  const owned = [
    "const timer = window.setTimeout(() => controller.abort(), 4_000);",
    "window.clearTimeout(timer); this.time.setTimeout(run, 10_000); time?.clearTimeout(handle);",
    "interface FleetClock { setTimeout(callback: () => void, delay: number): number; clearTimeout(timer: number): void; }",
    "// a comment mentioning setTimeout( and 'setInterval(' in a string",
  ].join("\n");
  expect(checkDocumentTimers("apps/web/src/fleet.ts", owned)).toEqual([]);
  // The worker global has no window; the gateway and scripts have their own lifecycles.
  for (const path of ["apps/web/src/service-worker.ts", "apps/gateway/src/http.ts", "scripts/relay-soak.ts", "apps/web/test/app.test.ts", "apps/web/e2e/fixture-server.ts"]) {
    expect(checkDocumentTimers(path, leaked)).toEqual([]);
  }
});
test("council491 Windows dispatcher forwards cancellation without permitting write replay", () => {
  const source = 'const send = (readSignal: AbortSignal = signal) => fetch(url, { method, signal: readSignal });\n' +
    'const response = method === "GET" ? await readProvider(send, { signal, ...(execution === undefined ? {} : { deadline: execution.deadline }) }) : await send();';
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", source)).toEqual([]);
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", source.replace('method === "GET"', 'method !== "DELETE"'))).toHaveLength(1);
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", source.replace(': await send();', ': await readProvider(send);'))).toHaveLength(1);
});

