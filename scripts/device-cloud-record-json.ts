/** Retained vendor JSON cannot silently discard an object member before audit or reference discovery. */
export class RetainedVendorJsonError extends Error {
  constructor(readonly code: "invalid-json" | "duplicate-key") {
    super(code === "duplicate-key" ? "duplicate retained vendor JSON object key" : "invalid retained vendor JSON");
    this.name = "RetainedVendorJsonError";
  }
}

/** Validate JSON syntax and reject duplicate decoded object keys at every nesting depth. */
export function parseRetainedVendorJson(text: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new RetainedVendorJsonError("invalid-json"); }

  // Native parsing validates token syntax; scan the original tokens before any parsed value is
  // returned, because a reviver cannot see keys the native parser already discarded.
  // null marks an array; an object's set is allocated only when its first key is encountered.
  const frames: (Set<string> | undefined | null)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") frames.push(undefined);
    else if (character === "[") frames.push(null);
    else if (character === "}" || character === "]") frames.pop();
    else if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      let next = index + 1;
      while (next < text.length && " \t\r\n".includes(text[next]!)) next += 1;
      if (text[next] !== ":") continue;
      let keys = frames.at(-1);
      if (frames.length === 0 || keys === null) throw new RetainedVendorJsonError("invalid-json");
      if (keys === undefined) { keys = new Set<string>(); frames[frames.length - 1] = keys; }
      let key: string;
      try { key = JSON.parse(text.slice(start, index + 1)) as string; }
      catch { throw new RetainedVendorJsonError("invalid-json"); }
      if (keys.has(key)) throw new RetainedVendorJsonError("duplicate-key");
      keys.add(key);
    }
  }
  return parsed;
}
