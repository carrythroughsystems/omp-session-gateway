import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView, type ToolViewProps } from "../upstream/src/tool-render/ToolView";
import { click, installDomGlobals, mount, queryAll, restoreDomGlobals, unmountAll } from "./react-dom-harness";

const render = (props: ToolViewProps): string => renderToStaticMarkup(createElement(ToolView, { defaultOpen: true, ...props }));

/** Marker in the key cell of the question-card option row labelled `label`. */
function optionMarker(html: string, label: string): string | undefined {
  const row = new RegExp(`<span class="tv-row-key"><span(?: class="[^"]*")?>([●○■□])</span></span><span class="tv-row-val"><span(?: class="[^"]*")?>${label}</span>`);
  return row.exec(html)?.[1];
}

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
      args: { html: '<form><legend>Release gate</legend><input name="ship"><script>alert(1)</script></form>' },
      result: { content: [{ type: "text", text: "host result text" }], details: {
        answers: [{ name: "ship", question: "Ship & test?", answer: "<img src=x onerror=alert(1)>" }],
        notes: [
          { name: "ship", question: "Ship & test?", option: "Yes", text: "after review" },
          { name: "other", question: "Ship & test?", option: "No", text: "must not leak" },
          { name: 3, question: "Ship & test?", option: "No", text: "malformed note" },
        ],
        timedOut: true,
      } },
    });
    // The recorded answer, not the form outline, supplies the question.
    expect(html).toContain("Ship &amp; test?");
    expect(html).not.toContain("Release gate");
    expect(html).not.toContain("host result text");
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

  test("shows the host's result text when a form ask records no answers", () => {
    // Upstream ask.ts returns this text with `details: { answers: [] }` for a form without named controls.
    const noControls = render({
      name: "ask", args: { html: "<form><p>Pick one</p></form>" },
      result: { content: [{ type: "text", text: "Error: the form has no named controls. Put at least one <input> inside the <form>." }], details: { answers: [] } },
    });
    expect(noControls).toContain("Error: the form has no named controls.");
    expect(noControls).not.toContain("<input");
    const timedOut = render({
      name: "ask", args: { html: '<form><input name="a"></form>' },
      result: { content: [{ type: "text", text: "No answer before the timeout" }], details: { answers: [], timedOut: true } },
    });
    expect(timedOut).toContain("No answer before the timeout");
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
    // 18.18-era multi-question details: `results[]` correlated by id, deliberately out of order.
    const ask = render({
      name: "ask",
      args: { questions: [
        { id: "ship", question: "Ship this build?", options: [{ label: "Ship now" }, { label: "Hold" }] },
        { id: "extra", question: "Anything else?", options: [{ label: "Nothing" }] },
        { id: "channel", question: "Which channel?", options: [{ label: "Beta" }] },
      ] },
      result: { content: [{ type: "text", text: "legacy fallback text" }], details: { results: [
        { id: "extra", question: "Anything else?", options: ["Nothing"], multi: false, selectedOptions: [], customInput: "Custom reply text" },
        { id: "ship", question: "Ship this build?", options: ["Ship now", "Hold"], multi: false, selectedOptions: ["Ship now"], note: "after review" },
        { id: "channel", question: "Which channel?", options: ["Beta"], multi: false, selectedOptions: [] },
      ] } },
    });
    expect(ask).toContain("3 questions");
    expect(optionMarker(ask, "Ship now")).toBe("●");
    expect(optionMarker(ask, "Hold")).toBe("○");
    expect(optionMarker(ask, "Nothing")).toBe("○");
    expect(optionMarker(ask, "Beta")).toBe("○");
    expect(ask).toContain('<span class="tv-row-key">✎</span><span class="tv-row-val"><span class="tv-ok-text">Custom reply text</span>');
    expect(ask).toContain('<span class="tv-row-key">note:</span><span class="tv-row-val"><span class="tv-muted">after review</span>');
    expect(ask.split("no selection")).toHaveLength(2);
    const [ship, extra, channel] = ["Ship this build?", "Anything else?", "Which channel?"].map(question => ask.lastIndexOf(question));
    expect(ask.indexOf("after review")).toBeGreaterThan(ship!);
    expect(ask.indexOf("after review")).toBeLessThan(extra!);
    expect(ask.indexOf("Custom reply text")).toBeGreaterThan(extra!);
    expect(ask.indexOf("Custom reply text")).toBeLessThan(channel!);
    expect(ask.indexOf("no selection")).toBeGreaterThan(channel!);
    expect(ask).not.toContain("legacy fallback text");
    // Single-question details are flat.
    const flat = render({
      name: "ask", args: { question: "Deploy where?", options: ["Blue", "Green"] },
      result: { content: [], details: { question: "Deploy where?", options: ["Blue", "Green"], multi: false, selectedOptions: ["Green"] } },
    });
    expect(optionMarker(flat, "Green")).toBe("●");
    expect(optionMarker(flat, "Blue")).toBe("○");
    expect(flat).not.toContain("no selection");
    const task = render({
      name: "task", args: { agent: "legacy-agent", tasks: [{ id: "old-task", description: "Old description", assignment: "Old assignment" }] },
    });
    expect(task).toContain('<span class="tv-badge tv-badge--accent">legacy-agent</span>');
    expect(task).toContain('<span class="tv-row-key"><span class="tv-badge tv-badge--accent">old-task</span></span>');
    expect(task).toContain("Old description");
    expect(task).toContain("Old assignment");
    const flatTask = render({ name: "task", args: { agent: "legacy-agent", id: "flat-task", description: "Flat description", assignment: "Flat assignment" } });
    for (const text of ["flat-task", "Flat description", "Flat assignment"]) expect(flatTask).toContain(text);
  });

  test("renders named tasks and ordered steps", () => {
    const html = render({
      name: "task", args: { tasks: [
        { name: "Refresh", agent: "worker", task: "Import source", steps: ["Review patches", "Run proofs"] },
        { name: "Audit", agent: "auditor", task: "Inspect result", steps: [null, 3] },
      ] },
    });
    for (const name of ["Refresh", "Audit"]) {
      expect(html).toContain(`<span class="tv-row-key"><span class="tv-badge tv-badge--accent">${name}</span></span>`);
    }
    for (const agent of ["worker", "auditor"]) expect(html).toContain(`<span class="tv-badge">${agent}</span>`);
    expect(html.split("steps</span>")).toHaveLength(2);
    expect(html).toContain("2 steps");
    for (const text of ["Import source", "Inspect result", "Review patches", "Run proofs"]) expect(html).toContain(text);
    expect(html.indexOf("Import source")).toBeLessThan(html.indexOf("Review patches"));
    expect(html.indexOf("Review patches")).toBeLessThan(html.indexOf("Run proofs"));
    expect(html.indexOf("Run proofs")).toBeLessThan(html.indexOf("Inspect result"));
    expect(html).toContain("step 1/2");
    expect(html).toContain("step 2/2");
    expect(html).not.toContain("step 1/0");
  });

  test("summarizes a task by its first non-empty label", () => {
    // Upstream accepts an empty task name and generates the agent name itself.
    const summary = render({ name: "task", args: { tasks: [{ name: "", agent: "worker", task: "\n\nImport source\nthen review" }] }, defaultOpen: false });
    expect(summary).not.toContain("tv-body");
    expect(summary).toContain("Import source");
    expect(summary).not.toContain("then review");
    const stepped = render({ name: "task", args: { tasks: [{ name: "", agent: "worker", steps: ["Collect inputs", "Write report"] }] }, defaultOpen: false });
    expect(stepped).toContain("Collect inputs");
    expect(stepped).not.toContain("Write report");
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

describe("task drill-down", () => {
  beforeEach(installDomGlobals);
  afterEach(unmountAll);
  afterAll(restoreDomGlobals);

  test("opens only the agent id the host reports, never an earlier agent holding the requested name", async () => {
    // Upstream allocates `Refresh-2` when an earlier task in the session already took `Refresh`.
    const openAgent = mock((_id: string) => undefined);
    const host = { hasAgent: (id: string) => id === "Refresh" || id === "Refresh-2", openAgent };
    const tree = await mount(createElement(ToolView, {
      defaultOpen: true, name: "task", host,
      args: { tasks: [{ name: "Refresh", agent: "worker", task: "Import source" }] },
      result: { content: [], details: { progress: [{ index: 0, id: "Refresh-2", status: "running", description: "Import source" }] } },
    }));
    const links = queryAll(tree.container, "tv-agent-link");
    expect(links).toHaveLength(1);
    for (const link of links) await click(link);
    expect(openAgent.mock.calls.map(([id]) => id)).toEqual(["Refresh-2"]);
  });
});
