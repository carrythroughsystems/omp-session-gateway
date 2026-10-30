// One-time fixture normalization only. Production generation never inserts missing markers.
// Original pre/post-PR bytes remain in history.json, including every unowned historical section.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

type Tree = Record<string, string>;
export function historicalTrees(): Record<string, Tree> {
  const fixture = JSON.parse(readFileSync(new URL("./history.json", import.meta.url), "utf8")) as { payload: string[] };
  const { base, deltas } = JSON.parse(gunzipSync(Buffer.from(fixture.payload.join(""), "hex")).toString()) as {
    base: Tree;
    deltas: Record<string, Record<string, { start: number; remove: number; insert: string }>>;
  };
  const trees: Record<string, Tree> = { "dcfa0b3^": base };
  for (const [ref, changes] of Object.entries(deltas)) {
    const tree = { ...base };
    for (const [path, delta] of Object.entries(changes)) {
      const prior = base[path]!;
      tree[path] = prior.slice(0, delta.start) + delta.insert + prior.slice(delta.start + delta.remove);
    }
    trees[ref] = tree;
  }
  return trees;
}

function wrap(source: string, name: string, part: string): string {
  if (!part || source.split(part).length !== 2) throw new Error(`ambiguous historical marker: ${name}`);
  return source.replace(part, () => `<!-- release-generate:${name}:start -->\n${part.trim()}\n<!-- release-generate:${name}:end -->`);
}
function matched(source: string, pattern: RegExp): string {
  const value = source.match(pattern)?.[0];
  if (!value) throw new Error(`missing historical anchor: ${pattern.source}`);
  return value;
}

export function normalizeHistoricalTree(tree: Tree, { emptyLedger = false }: { emptyLedger?: boolean } = {}): Tree {
  const result = { ...tree };
  for (const [path, source] of Object.entries(tree)) {
    let text = source;
    if (path === "CHANGELOG.md") {
      const pending = text.match(/\n## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/u)?.[1];
      if (pending?.trim()) {
        let index = 0;
        for (const section of pending.trim().split(/\n(?=### )/u)) {
          const heading = /^### (Added|Changed|Deprecated|Removed|Fixed|Security)\n\n([\s\S]*)$/u.exec(section);
          if (!heading) throw new Error("unknown historical changelog section");
          for (const bullet of heading[2]!.match(/^- .*(?:\n {2}.*)*/gmu) ?? []) {
            result[`changelog.d/${heading[1]!.toLowerCase()}-${String(++index).padStart(3, "0")}-historical.md`] = `${bullet}\n`;
          }
        }
        text = text.replace(/\n## \[Unreleased\]\n[\s\S]*?(?=\n## \[|$)/u, "\n## [Unreleased]\n");
      }
      result["changelog.d/README.md"] = "Historical bullets migrated to fragment inputs for generation tests.\n";
    }
    if (path === "docs/COMPATIBILITY.md") {
      text = wrap(text, "platforms", matched(text, /\| Surface \| Status \| Tested by \| Qualified on hardware \|[\s\S]*?(?=\n\n)/u));
      text = wrap(text, "release", matched(text, /\*\*(?:Published stable|Qualified; publication pending):\*\*[\s\S]*?(?=\n\nThe qualified scope)/u));
      text = wrap(text, "qualification", matched(text, /\| Surface \| Current contract \| Qualification \|[\s\S]*?(?=\n\n)/u));
    }
    if (path === "docs/RELEASE_STATUS.md") {
      if (emptyLedger) {
        text = text.replace("# Release status\n", "# Release status\n\n<!-- release-generate:current:start -->\n\n<!-- release-generate:current:end -->");
      } else {
        const end = text.indexOf("\n## Engineering baseline");
        text = wrap(text, "current", text.slice("# Release status\n\n".length, end).trim());
      }
    }
    if (path === "docs/UPGRADE_ROLLBACK.md") {
      const start = text.indexOf("\n## ") + 1;
      text = wrap(text, "predecessor", text.slice(start, text.indexOf("\n## ", start)).trim());
    }
    if (path === "site/llms.txt") {
      text = wrap(text, "summary", text.slice(0, text.indexOf("\n## ")).trim());
      const start = text.indexOf("## Current qualification boundary\n") + "## Current qualification boundary\n".length;
      text = wrap(text, "boundary", text.slice(start, text.indexOf("\n## ", start)).trim());
    }
    if (path === "site/status/index.html") {
      text = wrap(text, "description", matched(text, /<meta name="description"[^\n]+/u));
      text = wrap(text, "og-description", matched(text, /<meta property="og:description"[^\n]+/u));
      text = wrap(text, "status", text.slice(text.indexOf("<h1>"), text.indexOf("<h2>Known limits")).trim());
      text = wrap(text, "verified", matched(text, /<p class="verified">[^\n]+/u));
    }
    if (path === "docs/ANDROID.md") {
      text = wrap(text, "campaign", matched(text, /The v0\.7\.\d campaign qualified these phases[\s\S]*?\[ATTENTION_SPEC\.md\][^\n]+/u));
    }
    if (path === "docs/ATTENTION_SPEC.md") {
      const part = matched(text, /and before `force_stop_verified`\. The v0\.7\.\d campaign qualified them[\s\S]*?(?=\nOn 2026-10-01)/u);
      text = text.replace(part, () => "and before `force_stop_verified`.\n\n" + wrap(part, "campaign", part).replace("and before `force_stop_verified`. ", "") + "\n");
      text = text.replace(/The boxes below stay unchecked[\s\S]*?(?=\nThe lane owns)/u, "The boxes below stay unchecked because every candidate requalifies these phases; qualification is recorded in the ledger.");
    }
    if (path === "docs/LIFECYCLE_BRANCH_RESUME.md") {
      text = wrap(text, "campaign", matched(text, /(?:the v0\.7\.\d qualification stays|the v0\.7\.\d campaign qualified)[\s\S]*?\[release ledger\]\(RELEASE_STATUS\.md\)\./u));
    }
    if (path === "docs/BACKLOG.md") {
      const tasks = text.match(/- (?:Qualify and publish|Requalify the specialized attention)[^\n]*(?:\n {2}[^\n]*)*\n/gu)?.join("").trim();
      text = tasks ? wrap(text, "release-task", tasks) : text.replace("## Current\n", "## Current\n\n<!-- release-generate:release-task:start -->\n\n<!-- release-generate:release-task:end -->");
    }
    result[path] = text;
  }
  return result;
}
