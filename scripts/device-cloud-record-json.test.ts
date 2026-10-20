import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseRetainedVendorJson, RetainedVendorJsonError } from "./device-cloud-record-json.ts";

const DUPLICATES = [
  '{"logs":{},"logs":{}}',
  '{"assets":{"logs":{"appium":"first","appium":"second"}}}',
  '[{"steps":[{"value":"first","value":"second"}]}]',
  String.raw`{"logs":{},"\u006cogs":{}}`,
  String.raw`{"nested":{"a\\\"b":1,"a\\\"b":2}}`,
  '{"__proto__":1,"__proto__":2}',
];

describe("shared strict retained vendor JSON", () => {
  test.each(DUPLICATES)("rejects duplicate decoded object keys at any depth: %s", text => {
    try {
      parseRetainedVendorJson(text);
      throw new Error("expected duplicate rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RetainedVendorJsonError);
      expect((error as RetainedVendorJsonError).code).toBe("duplicate-key");
      expect(String(error)).not.toContain(text);
    }
  });

  test.each(['{"logs":{},}', '{"x":NaN}', '{"x":undefined}', '{"x":"unterminated}', '{"x":1} trailing', '\ufeff{"x":1}'])(
    "refuses non-JSON without echoing its contents: %s", text => {
      try {
        parseRetainedVendorJson(text);
        throw new Error("expected syntax rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(RetainedVendorJsonError);
        expect((error as RetainedVendorJsonError).code).toBe("invalid-json");
        expect(String(error)).not.toContain(text);
      }
    },
  );

  test("permits repeated keys in different objects and key-like punctuation inside strings", () => {
    const text = String.raw`{"one":{"logs":1},"two":{"logs":2},"array":[{"logs":3},{"logs":4}],"text":"escaped \\\"logs\\\":{} and [{}]"}`;
    expect(parseRetainedVendorJson(text)).toEqual(JSON.parse(text));
  });

  test("every retained TestingBot parse site uses the shared strict parser", async () => {
    const text = await readFile(new URL("./testingbot.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/\bJSON\s*\.\s*parse\s*\(/u);
    expect(text).not.toMatch(/\bvendorJson\s*\(/u);
    const start = text.indexOf("async testRecord(");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const retainedBody = text.slice(start, end);
    expect(retainedBody).not.toMatch(/\.\s*json\s*\(/u);
    // Detail, inventory, and every JSON log use exactly this parser. A newly added parse
    // surface must update this invariant instead of silently falling back to a lenient path.
    expect([...retainedBody.matchAll(/\bparseRetainedVendorJson\s*\(/gu)].length).toBe(3);
  });
});
