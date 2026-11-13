import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView, type ToolViewProps } from "../upstream/src/tool-render/ToolView";
import { click, installDomGlobals, mount, queryAll, restoreDomGlobals, unmountAll } from "./react-dom-harness";

const render = (props: ToolViewProps): string => renderToStaticMarkup(createElement(ToolView, { defaultOpen: true, ...props }));

describe("tool result image safety", () => {
  beforeEach(installDomGlobals);
  afterEach(unmountAll);
  afterAll(restoreDomGlobals);

  for (const [mimeType, accepted] of [
    ["text/html", false], ["image/svg+xml", false],
    ["image/png", true], ["IMAGE/PNG", true], ["image/jpeg", true], ["image/webp", true], ["image/gif", true],
  ] as const) {
    test(`renders and opens only raster tool result images: ${mimeType}`, async () => {
      const open = mock(() => null);
      const previousOpen = Object.getOwnPropertyDescriptor(window, "open");
      Object.defineProperty(window, "open", { configurable: true, value: open });
      const createObjectURL = spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-tool-image");
      try {
        const props: ToolViewProps = {
          name: "synthetic_image_tool",
          result: { content: [{ type: "image", mimeType, data: btoa("<b>x</b>") }] },
        };
        expect(render(props).includes('class="tv-img"')).toBe(accepted);
        const tree = await mount(createElement(ToolView, { defaultOpen: true, ...props }));
        const images = queryAll(tree.container, "tv-img");
        expect(images).toHaveLength(accepted ? 1 : 0);
        await click(images[0] ?? tree.container);
        expect(createObjectURL).toHaveBeenCalledTimes(accepted ? 1 : 0);
        expect(open).toHaveBeenCalledTimes(accepted ? 1 : 0);
        if (accepted) {
          expect((createObjectURL.mock.calls[0]![0] as Blob).type).toBe(mimeType.toLowerCase());
          expect(open).toHaveBeenCalledWith("blob:synthetic-tool-image", "_blank", "noopener");
        }
      } finally {
        createObjectURL.mockRestore();
        if (previousOpen) Object.defineProperty(window, "open", previousOpen);
        else Reflect.deleteProperty(window, "open");
      }
    });
  }
});

describe("tool renderers across supported OMP releases", () => {
  test("renders HTML-form answers and selected-option notes without mounting HTML", () => {
    const html = render({
      name: "ask",
      args: { html: '<form><legend>Ship &amp; test?</legend><input name="ship"><script>alert(1)</script></form>' },
      result: { content: [], details: {
        answers: [{ name: "ship", question: "Ship & test?", answer: "<img src=x onerror=alert(1)>" }],
        notes: [
          { name: "ship", question: "Ship & test?", option: "Yes", text: "after review" },
          { name: "other", question: "Ship & test?", option: "No", text: "must not leak" },
          { name: 3, question: "Ship & test?", option: "No", text: "malformed note" },
        ],
        timedOut: true,
      } },
    });
    expect(html).toContain("Ship &amp; test?");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("after review");
    expect(html).toContain("auto-selected after timeout");
    expect(html).not.toContain("must not leak");
    expect(html).not.toContain("malformed note");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });

  test("renders pending form outlines as text and preserves malformed-result fallback", () => {
    const pending = render({
      name: "ask", args: { html: '<form><legend>Choose &amp; review</legend><input name="a"><input name="a"><textarea name="b"></textarea><input type="hidden" name="secret"></form>' },
      running: true,
    });
    expect(pending).toContain("Choose &amp; review");
    expect(pending).toContain("2 fields");
    expect(pending).not.toContain("<form");
    expect(pending).not.toContain("<textarea");
    const failed = render({
      name: "ask", args: { html: "<form></form>" },
      result: { content: [{ type: "text", text: "form unavailable" }], details: { answers: [{ question: null }] } },
    });
    expect(failed).toContain("form unavailable");
  });

  test("retains older question cards and task assignments", () => {
    const ask = render({
      name: "ask",
      args: { questions: [{ id: "ship", question: "Legacy question", options: [{ label: "Legacy answer" }] }] },
      result: { content: [], details: { answers: [{ id: "ship", selected: ["Legacy answer"] }] } },
    });
    expect(ask).toContain("Legacy question");
    expect(ask).toContain("Legacy answer");
    const task = render({
      name: "task", args: { agent: "legacy-agent", tasks: [{ id: "old-task", description: "Old description", assignment: "Old assignment" }] },
    });
    expect(task).toContain("legacy-agent");
    expect(task).toContain("old-task");
    expect(task).toContain("Old description");
    expect(task).toContain("Old assignment");
  });

  test("renders named tasks and ordered steps", () => {
    const html = render({
      name: "task", args: { tasks: [
        { name: "Refresh", agent: "worker", task: "Import source", steps: ["Review patches", "Run proofs"] },
        { name: "Review", agent: "reviewer", task: "Inspect result", steps: [null, 3] },
      ] },
    });
    for (const text of ["Refresh", "worker", "Import source", "2 steps", "Review patches", "Run proofs", "reviewer", "Inspect result"]) {
      expect(html).toContain(text);
    }
    expect(html.indexOf("Review patches")).toBeLessThan(html.indexOf("Run proofs"));
    expect(html).toContain("step 1/2");
    expect(html).toContain("step 2/2");
  });

  test("renders eval printed views once and preserves their surrounding text order", () => {
    const html = render({
      name: "eval", args: { language: "py", code: "print(result)" },
      result: {
        content: [{ type: "text", text: "fallback must not duplicate cell output" }],
        details: { cells: [{
          index: 0, language: "py", code: "print(result)", status: "success",
          output: "before\nTABLE_MARKER\nbetween\nJSON_MARKER\nMARKDOWN_MARKER\nafter",
          views: [
            { text: "TABLE_MARKER", view: { kind: "table", columns: [{ head: "value", numeric: true }], rows: [["42"]] } },
            { text: "JSON_MARKER", view: { kind: "json", value: { answer: "unique-json-value" } } },
            { text: "MARKDOWN_MARKER", view: { kind: "markdown", text: "**rendered once**" } },
          ],
        }] },
      },
    });
    expect(html).toContain("<table>");
    expect(html).toContain("<strong>rendered once</strong>");
    expect(html.match(/unique-json-value/g)?.length).toBe(1);
    expect(html.indexOf("before")).toBeLessThan(html.indexOf("<table>"));
    expect(html.indexOf("</table>")).toBeLessThan(html.indexOf("between"));
    expect(html.indexOf("between")).toBeLessThan(html.indexOf("unique-json-value"));
    expect(html.indexOf("rendered once")).toBeLessThan(html.indexOf("after"));
    expect(html).not.toContain("_MARKER");
    expect(html).not.toContain("fallback must not duplicate");
  });

  test("keeps legacy eval text outputs when no typed views are present", () => {
    const html = render({
      name: "eval", args: { language: "js", code: "print('legacy output')" },
      result: { content: [{ type: "text", text: "legacy plain result" }] },
    });
    expect(html).toContain("legacy plain result");
  });

  test("renders a received wait message without falling back to JSON", () => {
    const html = render({
      name: "wait",
      args: {},
      result: {
        content: [{ type: "text", text: "[42] Worker: ready" }],
        details: { op: "wait", waited: { id: "42", from: "Worker", to: "Main", body: "ready", ts: 0 } },
      },
    });
    expect(html).toContain("← Worker");
    expect(html).toContain("ready");
    expect(html).not.toContain("tv-out-title");
  });

  test("renders every OMP 18.17.0 wait message with its senders and bodies", () => {
    const html = render({
      name: "wait",
      args: {},
      result: {
        content: [{ type: "text", text: "[42] Worker: ready\n\n[43] Reviewer: looks good" }],
        details: {
          op: "wait",
          waited: [
            { id: "42", from: "Worker", to: "Main", body: "ready", ts: 0 },
            { id: "43", from: "Reviewer", to: "Main", body: "looks good", ts: 1, replyTo: "41" },
          ],
        },
      },
    });
    expect(html).toContain('<span class="tv-pattern">← Worker, Reviewer</span>');
    expect(html).toContain('<span class="tv-muted">2 messages</span>');
    expect(html).toContain("← Worker");
    expect(html).toContain("← Reviewer");
    expect(html).toContain("ready");
    expect(html).toContain("looks good");
    expect(html).toContain('<span class="tv-badge">reply</span>');
    expect(html).not.toContain("tv-out-title");
  });

  test("renders a one-message wait list with its sender and body", () => {
    const html = render({
      name: "wait",
      args: {},
      result: {
        content: [{ type: "text", text: "[42] Worker: ready" }],
        details: {
          op: "wait",
          waited: [{ id: "42", from: "Worker", to: "Main", body: "ready", ts: 0 }],
        },
      },
    });
    expect(html).toContain('<span class="tv-pattern">← Worker</span>');
    expect(html).toContain('<span class="tv-muted">ready</span>');
    expect(html).not.toContain("tv-out-title");
  });

  test("renders settled wait job output", () => {
    const html = render({
      name: "wait",
      args: {},
      result: {
        content: [],
        details: {
          op: "wait",
          jobs: [{ id: "a1b2", type: "bash", status: "completed", label: "build", durationMs: 25, resultText: "Built", errorText: "" }],
        },
      },
    });
    expect(html).toContain("Built");
    expect(html).toContain("1 done");
  });

  test("renders legacy timeouts and empty message lists without losing the wait state", () => {
    for (const name of ["wait", "irc"]) {
      for (const waited of [null, []]) {
        const html = render({
          name, args: { op: "wait" },
          result: { content: [], details: { op: "wait", waited } },
        });
        expect(html).toContain("← anyone");
        expect(html).toContain(waited === null ? "timed out" : "No messages received.");
        expect(html).not.toContain("all running jobs");
        expect(html).not.toContain("tv-out-title");
      }
    }
  });

  test("keeps IRC sender order and duplicate-sender bodies for both host shapes", () => {
    const first = { from: "Worker", body: "first body", replyTo: "prior" };
    for (const waited of [first, [first, { from: "Reviewer", body: "second body" }, { from: "Worker", body: "third body" }]]) {
      const html = render({ name: "irc", args: { op: "wait" }, result: { content: [], details: { waited } } });
      expect(html).toContain("first body");
      expect(html).toContain('<span class="tv-badge">reply</span>');
      if (Array.isArray(waited)) {
        expect(html).toContain("← Worker, Reviewer");
        expect(html).toContain("3 messages");
        expect(html.indexOf("first body")).toBeLessThan(html.indexOf("second body"));
        expect(html.indexOf("second body")).toBeLessThan(html.indexOf("third body"));
      }
    }
  });

  test("falls back to plain wait errors and tolerates malformed or unfinished message results", () => {
    for (const waited of [undefined, [{ from: 1, body: null }], "invalid"]) {
      const html = render({
        name: "wait", args: {}, result: {
          isError: true, content: [{ type: "text", text: "fixed failure text" }], details: { waited },
        },
      });
      expect(html).toContain("fixed failure text");
    }
    expect(render({ name: "wait", args: {}, running: true })).toContain("all running jobs");
  });

  test("prefers job intent and falls back to legacy command labels", () => {
    for (const name of ["job", "wait", "await", "poll", "cancel_job"]) {
      for (const intent of ["  Compile\nclient  ", "", "   ", undefined]) {
        const html = render({
          name, args: {}, result: { content: [], details: { jobs: [{
            id: "build", type: "bash", status: "completed", label: "bun run build", intent,
            durationMs: 25, resultText: "Built", errorText: "",
          }] } },
        });
        expect(html).toContain(intent?.trim() ? "Compile client" : "bun run build");
        if (intent?.trim()) expect(html).not.toContain("bun run build");
        expect(html).toContain("Built");
      }
    }
  });

  test("keeps shell-trace strings and byte arrays on the safe text fallback", () => {
    // The live bash view deliberately does not interpret details.trace or load omp-stats.
    for (const value of ["<img src=x onerror=alert(1)>", [255, 0, 60, 62]]) {
      const html = render({
        name: "bash", args: { command: "printf output" },
        result: { content: [{ type: "text", text: "safe output <script>bad()</script>" }], details: {
          exitCode: 0, wallTimeMs: 25,
          trace: { v: 1, seq: 1, t_ns: 1, script: "printf output", units: [{
            line: 1, bytes: 1, source: value,
            nodes: [{ k: "simple", lo: 0, hi: 1, state: "ok", argv: [value],
              env: [[value, value]], redirs: [{ fd: 1, op: ">", target: value }] }],
          }], diags: [{ code: "test", message: value }] },
        } },
      });
      expect(html).toContain("printf output");
      expect(html).toContain("safe output &lt;script&gt;bad()&lt;/script&gt;");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("onerror");
      expect(html).not.toContain("255");
    }
  });

  // OMP 18.3.0 replaced these tools with `wait` and upstream unregistered them, but hosts on
  // the older releases the gateway supports still emit them.
  test("keeps rendering the hub-family tools that older supported hosts emit", () => {
    expect(render({ name: "irc", args: { op: "send", to: "Main", message: "hi" }, result: { content: [] } })).toContain("→ Main");
    const job = render({ name: "job", args: { poll: ["a1b2"] }, result: { content: [] } });
    expect(job).toContain("poll a1b2");
    expect(job).not.toContain("tv-out-title");
  });
});
