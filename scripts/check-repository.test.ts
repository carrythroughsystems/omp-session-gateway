import { expect, test } from "bun:test";
import { checkDocumentTimers, checkE2EReadiness, checkProviderReads, checkUnsafeFinally } from "./check-repository.ts";
import { readFile } from "node:fs/promises";

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

test.each(["plain", "signal"] as const)("Windows guarded %s dispatcher retains exact GET-only retry admission", shape => {
  const parameters = shape === "plain" ? "()" : "(readSignal: AbortSignal = signal)";
  const localGuard = shape === "plain" ? 'if (deadline !== undefined) windowsRemaining(started, deadline, performance.now(), execution, "not_started");' : "";
  const read = shape === "plain" ? "readProvider(send)" : "readProvider(send, { signal, deadline: operationDeadline })";
  const source = `const send = ${parameters} => {
    assertWindowsExecution(execution);
    ${localGuard}
    return fetch(url, { method, headers: {} });
  };
  const response = method === "GET" ? await ${read} : await send();`;
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", source)).toEqual([]);
  for (const unsafe of [
    source.replace("assertWindowsExecution(execution);", ""),
    source.replace("assertWindowsExecution(execution);", "unknownGuard(execution);"),
    source.replace("return fetch", "mutate(); return fetch"),
    ...(shape === "plain" ? [source.replace(localGuard, "")] : []),
    source.replace('method === "GET"', 'method !== "DELETE"'),
    source.replace(": await send();", ": await readProvider(send);"),
    source.replace("{ method,", '{ method: "POST",'),
    source.replace("fetch(url,", "fetch(otherUrl,"),
  ]) expect(checkProviderReads("scripts/windows-qualification-runtime.ts", unsafe)).toHaveLength(1);
  expect(checkProviderReads("scripts/other-runtime.ts", source)).toHaveLength(1);
});
test.each(["plain", "signal"] as const)("Windows guarded %s egress callback admits only the reviewed target and read options", shape => {
  const parameters = shape === "plain" ? "()" : "(signal)";
  const signal = shape === "plain" ? "AbortSignal.timeout(15_000)" : "AbortSignal.any([signal, AbortSignal.timeout(15_000)])";
  const source = `const external = await readProvider(${parameters} => {
    assertWindowsExecution(execution);
    return fetch("https://api.ipify.org", { signal: ${signal} });
  });`;
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", source)).toEqual([]);
  if (shape === "signal") {
    const bound = source.replace("  });", "  }, execution ?? {});");
    expect(checkProviderReads("scripts/windows-qualification-runtime.ts", bound)).toEqual([]);
    expect(checkProviderReads("scripts/windows-qualification-runtime.ts", bound.replace("{ signal:", '{ method: "POST", signal:'))).toHaveLength(1);
  }
  for (const unsafe of [
    source.replace("assertWindowsExecution(execution);", ""),
    source.replace("assertWindowsExecution(execution);", "unknownGuard(execution);"),
    source.replace("return fetch", "mutate(); return fetch"),
    source.replace("https://api.ipify.org", "https://synthetic.invalid"),
    source.replace("{ signal:", '{ method: "POST", signal:'),
    source.replace("{ signal:", "{ ...options, signal:"),
    source.replace("readProvider(", "("),
  ]) expect(checkProviderReads("scripts/windows-qualification-runtime.ts", unsafe)).toHaveLength(1);
  expect(checkProviderReads("scripts/other-runtime.ts", source)).toHaveLength(1);
});
test.each((["plain", "signal"] as const).flatMap(shape =>
  (["spread", "computed", "override", "unrelated-gate", "nested-gate"] as const).map(variant => [shape, variant] as const)))(
  "499 R1 %s dispatcher rejects %s", (shape, variant) => {
  const parameters = shape === "plain" ? "()" : "(readSignal: AbortSignal = signal)";
  const guard = shape === "plain" ? 'if (deadline !== undefined) windowsRemaining(started, deadline, performance.now(), execution, "not_started");' : "";
  const read = shape === "plain" ? "readProvider(send)" : "readProvider(send, { signal, deadline: operationDeadline })";
  const source = `const send = ${parameters} => {
    assertWindowsExecution(execution);
    ${guard}
    return fetch(url, { method, headers: {}, signal: AbortSignal.timeout(60_000) });
  };
  const response = method === "GET" ? await ${read} : await send();`;
  const options = {
    spread: '{ method, headers: {}, ...{ method: "POST" }, signal: AbortSignal.timeout(60_000) }',
    computed: '{ method, headers: {}, ["method"]: "POST", signal: AbortSignal.timeout(60_000) }',
    override: '{ method, headers: {}, method: "POST", signal: AbortSignal.timeout(60_000) }',
  };
  const unsafe = variant === "unrelated-gate"
    ? source.replace(`const response = method === "GET" ? await ${read} : await send();`,
      `const response = await readProvider(send);\nfunction other() { const response = method === "GET" ? await ${read} : await send(); }`)
    : variant === "nested-gate"
      ? source.replace('const response = method === "GET"', 'function other() { const response = method === "GET"') + "}"
      : source.replace("{ method, headers: {}, signal: AbortSignal.timeout(60_000) }", options[variant]);
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", unsafe)).toHaveLength(1);
});
test("499 R1 unguarded concise Windows dispatcher is no longer admitted", () => {
  const source = 'const send = () => fetch(url, { method, headers: {} });\n' +
    'const response = method === "GET" ? await readProvider(send) : await send();';
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", source)).toHaveLength(1);
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
  const source = 'const send = (readSignal: AbortSignal = signal) => {\nassertWindowsExecution(execution);\n' +
    'return fetch(url, { method, headers: {}, signal: readSignal });\n};\ntry {\n' +
    'const response = method === "GET" ? await readProvider(send, { signal, deadline: operationDeadline }) : await send();\n' +
    '} finally { clearTimeout(timer); }';
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", source)).toEqual([]);
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", source.replace('method === "GET"', 'method !== "DELETE"'))).toHaveLength(1);
  expect(checkProviderReads("scripts/windows-qualification-runtime.ts", source.replace(': await send();', ': await readProvider(send);'))).toHaveLength(1);
});


test("e2e readiness forbids completion access, request-finished events and networkidle, including optional/computed access", () => {
  for (const source of [
    "await response.finished();", "const completion = response?.finished;", 'await response["finished"]();',
    'await response?.["finished"]?.();', 'await response[`finished`]();',
    'const completion = response["fin\\u0069shed"];',
    'await page.waitForEvent("requestfinished");', 'await page["waitForEvent"]("requestfinished");',
    'await page?.waitForEvent?.(`requestfinished`);', 'page.on("requestfinished", done);',
    'await page.goto(url, { waitUntil: "networkidle" });', 'await page.waitForLoadState("networkidle");',
    'await page.waitForURL(url, { waitUntil: "networkidle" });', 'await page.setContent(html, { waitUntil: "networkidle" });',
    'await page["waitForLoadState"]?.("networkidle");',
  ]) expect(checkE2EReadiness("apps/web/e2e/nested/example.e2e.ts", source)).toHaveLength(1);
  expect(checkE2EReadiness("apps/web/e2e/example.e2e.ts", "// response.finished()\nawait response?.finished();")[0]).toContain(":2:");
});

test.each([
  'const k = "finished"; await response[k]();',
  'const s = "networkidle"; await page.goto(url, { waitUntil: s });',
  'const e = "requestfinished"; page.on(e, done);',
  'const k = "finished"; async function scenario() { await response?.[(k)]?.(); }',
  'const s = "networkidle"; if (ready) { await page.goto(url, { waitUntil: s }); }',
  'const e = "requestfinished"; page.waitForEvent((e));',
])("e2e readiness resolves unchanged string aliases: %s", source => {
  expect(checkE2EReadiness("apps/web/e2e/example.e2e.ts", source)).toHaveLength(1);
});

test("e2e readiness leaves safe, reassigned, shadowed and unavailable string bindings alone", () => {
  for (const source of [
    'const s = "domcontentloaded"; await page.goto(origin, { waitUntil: s });',
    'let s = "networkidle"; s = "domcontentloaded"; await page.goto(origin, { waitUntil: s });',
    'let s = "networkidle"; if (ready) { s = "domcontentloaded"; } await page.goto(origin, { waitUntil: s });',
    'const k = "finished"; { const k = "status"; response[k](); }',
    'const k = "finished"; { const k = property; response[k](); }',
    '{ const k = "finished"; } response[k]();',
    'response[k](); const k = "finished";',
    'const k = "finished" + suffix; response[k]();',
  ]) expect(checkE2EReadiness("apps/web/e2e/example.e2e.ts", source)).toEqual([]);
});

test("e2e readiness ignores comments and inert strings and permits explicit HTTP-contract assertions", () => {
  const source = [
    "// await response.finished();",
    'const text = "networkidle"; const example = `response.finished()`;',
    'const response = await page.waitForResponse("/api/v1/sessions");',
    "expect(response.status()).toBe(200);",
    "expect(await response.json()).toMatchObject({ sessions: [] });",
    'await page.goto(origin, { waitUntil: "domcontentloaded" });',
    'await expect(page.locator("#ready")).toHaveText("Ready");',
  ].join("\n");
  expect(checkE2EReadiness("apps/web/e2e/example.e2e.ts", source)).toEqual([]);
  expect(checkE2EReadiness("apps/web/e2e/example.e2e.ts", 'await page.waitForResponse("/api/v1/sessions");')).toHaveLength(1);
  expect(checkE2EReadiness("apps/web/test/example.test.ts", "response.finished()")).toEqual([]);
});

test("HTTP assertion exemptions never cross scopes, shadowing or a response reassignment", () => {
  for (const source of [
    'test("a", async () => { const response = await page.waitForResponse(url); }); test("b", () => { const response = other; expect(response.status()).toBe(200); });',
    'async function scenario() { const response = await page.waitForResponse(url); { const response = other; expect(response.status()).toBe(200); } }',
    'async function scenario() { let response = await page.waitForResponse(url); response = other; expect(response.status()).toBe(200); }',
    'async function scenario() { let response = await page.waitForResponse(url); if (ready) { response = other; } expect(response.status()).toBe(200); }',
    'async function scenario() { const response = await page.waitForResponse(url); function later(response) { expect(response.status()).toBe(200); } }',
    'async function scenario() { const response = await page.waitForResponse(url); const later = response => expect(response.status()).toBe(200); }',
    'async function scenario() { var response = await page.waitForResponse(url); var response = other; expect(response.status()).toBe(200); }',
  ]) expect(checkE2EReadiness("apps/web/e2e/example.e2e.ts", source)).toHaveLength(1);
});

test("race-free response contracts support destructuring, promise aliases, annotations and inline awaits", () => {
  for (const source of [
    'const [response] = await Promise.all([page.waitForResponse(url), page.click("#go")]); expect(response.status()).toBe(200);',
    'const [, response] = await Promise.all([page.click("#go"), page.waitForResponse(url)]); expect(response.status()).toBe(200);',
    'const pending = page.waitForResponse(url); await page.click("#go"); const response = await pending; expect(response.status()).toBe(200);',
    'const pending = page.waitForResponse(url); await page.click("#go"); expect((await pending).status()).toBe(200);',
    'const response: Response = await page.waitForResponse(url); expect(response.status()).toBe(200);',
    'expect((await page.waitForResponse(url)).status()).toBe(200);',
    'const response = await page.waitForResponse(url); expect(response.status()).not.toBe(500);',
    'const response = await page.waitForResponse(url); function later(response) { response = other; } expect(response.status()).toBe(200);',
    'const response = await page.waitForResponse(url); const later = response => { response = other; }; expect(response.status()).toBe(200);',
    'const response = await page.waitForResponse(url); state.response = other; state?.response = other; expect(response.status()).toBe(200);',
  ]) expect(checkE2EReadiness("apps/web/e2e/example.e2e.ts", source)).toEqual([]);
});

test("completion access cannot hide a literal behind nested parentheses", () => {
  for (const source of [
    'await response[("finished")]();', 'await response?.[((("finished")))]?.();',
    'const completion = response[((`finished`))];',
  ]) expect(checkE2EReadiness("apps/web/e2e/example.e2e.ts", source)).toHaveLength(1);
});

test("startup-retry browser regressions install and freeze their clock before first navigation", async () => {
  for (const [file, title] of [
    ["availability-lifecycle.e2e.ts", "await page.clock.install({ time });"],
    ["network-recovery.e2e.ts", 'await page.clock.install({ time: new Date("2026-10-25T01:30:00Z") });'],
  ]) {
    const source = await readFile(new URL(`../apps/web/e2e/${file}`, import.meta.url), "utf8");
    const controlled = source.slice(source.indexOf(title!));
    expect(controlled.indexOf("await page.clock.pauseAt(")).toBeLessThan(controlled.indexOf("await page.goto("));
  }
});
