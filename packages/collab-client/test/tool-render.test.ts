import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView, type ToolViewProps } from "../upstream/src/tool-render/ToolView";

const render = (props: ToolViewProps): string => renderToStaticMarkup(createElement(ToolView, { defaultOpen: true, ...props }));

describe("tool renderers across supported OMP releases", () => {
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

  // OMP 18.3.0 replaced these tools with `wait` and upstream unregistered them, but hosts on
  // the older releases the gateway supports still emit them.
  test("keeps rendering the hub-family tools that older supported hosts emit", () => {
    expect(render({ name: "irc", args: { op: "send", to: "Main", message: "hi" }, result: { content: [] } })).toContain("→ Main");
    const job = render({ name: "job", args: { poll: ["a1b2"] }, result: { content: [] } });
    expect(job).toContain("poll a1b2");
    expect(job).not.toContain("tv-out-title");
  });
});
