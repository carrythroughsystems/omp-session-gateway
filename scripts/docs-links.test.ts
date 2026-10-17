import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = fileURLToPath(new URL("../", import.meta.url));

export interface ExtractedLink {
  readonly line: number;
  readonly target: string;
}

function unfencedLines(markdown: string): Array<{ readonly line: number; readonly text: string }> {
  const lines: Array<{ readonly line: number; readonly text: string }> = [];
  let activeFence: { readonly char: string; readonly length: number } | undefined;

  for (const [index, rawLine] of markdown.split(/\r?\n/u).entries()) {
    if (activeFence !== undefined) {
      const closeMatch = rawLine.match(/^\s{0,3}(`{3,}|~{3,})\s*$/u);
      if (closeMatch?.[1] !== undefined && closeMatch[1][0] === activeFence.char && closeMatch[1].length >= activeFence.length) {
        activeFence = undefined;
      }
      continue;
    }
    const openMatch = rawLine.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/u);
    const marker = openMatch?.[1];
    const rest = openMatch?.[2] ?? "";
    if (marker !== undefined && !(marker[0] === "`" && rest.includes("`"))) {
      activeFence = { char: marker[0] ?? "`", length: marker.length };
      continue;
    }
    lines.push({ line: index + 1, text: rawLine });
  }

  return lines;
}

export function slugifyHeading(heading: string): string {
  const stripped = heading
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/\s+#+\s*$/u, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .trim()
    .toLowerCase();
  return stripped.replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /gu, "-");
}

export function extractMarkdownAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const slugCounts = new Map<string, number>();

  for (const { text: rawLine } of unfencedLines(markdown)) {
    const headingMatch = rawLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (headingMatch?.[1] !== undefined) {
      const base = slugifyHeading(headingMatch[1]);
      if (base.length > 0) {
        const seen = slugCounts.get(base) ?? 0;
        anchors.add(seen === 0 ? base : `${base}-${seen}`);
        slugCounts.set(base, seen + 1);
      }
    }

    for (const idMatch of rawLine.matchAll(/\bid=(?:"([^"]+)"|'([^']+)')/gu)) {
      const id = idMatch[1] ?? idMatch[2];
      if (id !== undefined && id.length > 0) anchors.add(id);
    }
  }

  return anchors;
}

export function extractMarkdownLinks(markdown: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  for (const { line: lineNumber, text: rawLine } of unfencedLines(markdown)) {
    const sanitized = rawLine.replace(/`[^`\n]+`/gu, codeSpan =>
      codeSpan.includes("[") && codeSpan.includes("](") ? " ".repeat(codeSpan.length) : codeSpan,
    );

    const refMatch = sanitized.match(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+["'][^"']*["'])?\s*$/u);
    if (refMatch?.[1] !== undefined) {
      const target = refMatch[1];
      if (!/^(?:https?:|mailto:)/iu.test(target)) {
        links.push({ line: lineNumber, target });
      }
      continue;
    }

    for (const match of sanitized.matchAll(/\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^)>\s]+)>?(?:\s+["'][^"']*["'])?\s*\)/gu)) {
      const target = match[1];
      if (target === undefined || /^(?:https?:|mailto:)/iu.test(target)) continue;
      links.push({ line: lineNumber, target });
    }
  }

  return links;
}

function fileExists(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

async function childReadmes(parentDir: string): Promise<string[]> {
  const entries = await readdir(join(rootPath, parentDir), { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => `${parentDir}/${entry.name}/README.md`)
    .filter(relPath => fileExists(join(rootPath, relPath)))
    .sort();
}

async function scannedMarkdownFiles(): Promise<string[]> {
  const docsEntries = await readdir(join(rootPath, "docs"), { withFileTypes: true });
  const docsFiles = docsEntries
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => `docs/${entry.name}`)
    .sort();
  return [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    ...docsFiles,
    "docs/media/README.md",
    ...(await childReadmes("apps")),
    ...(await childReadmes("packages")),
  ];
}

test("extractMarkdownAnchors suffixes duplicate headings and accepts HTML ids", () => {
  const markdown = [
    "# Overview",
    "## Repeat — section",
    "### Repeat — section",
    "#### Repeat — section",
    '<p><a id="custom-anchor"></a></p>',
    "<section id='second-anchor'></section>",
  ].join("\n");
  const anchors = extractMarkdownAnchors(markdown);
  expect([...anchors]).toEqual([
    "overview",
    "repeat--section",
    "repeat--section-1",
    "repeat--section-2",
    "custom-anchor",
    "second-anchor",
  ]);
});

test("extractMarkdownLinks skips fenced code blocks and external schemes", () => {
  const markdown = [
    "See [guide](docs/USAGE.md#the-directory) and [site](https://example.com).",
    "Contact [security](mailto:you@example.com).",
    "```md",
    "[ignored in fence](docs/DOES_NOT_EXIST.md#missing)",
    "[ignored-ref]: docs/MISSING_REF.md",
    "```",
    "~~~sh",
    "# [also ignored](nope.md)",
    "~~~",
    "[omp-lock]: UPSTREAM.lock.json",
  ].join("\n");
  expect(extractMarkdownLinks(markdown)).toEqual([
    { line: 1, target: "docs/USAGE.md#the-directory" },
    { line: 10, target: "UPSTREAM.lock.json" },
  ]);
});

test("fragment links to an explicit HTML id resolve alongside heading slugs", () => {
  const markdown = [
    "# Document title",
    "Jump to [custom section](#explicit-html-anchor).",
    "```html",
    '<a id="fenced-id"></a>',
    "```",
    '<a id="explicit-html-anchor"></a>',
  ].join("\n");
  const anchors = extractMarkdownAnchors(markdown);
  const links = extractMarkdownLinks(markdown);
  expect(links).toEqual([{ line: 2, target: "#explicit-html-anchor" }]);
  expect(anchors.has("explicit-html-anchor")).toBe(true);
  expect(anchors.has("fenced-id")).toBe(false);
});

test("every relative Markdown link and heading fragment resolves", async () => {
  const files = await scannedMarkdownFiles();
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = async (absolutePath: string): Promise<Set<string>> => {
    const cached = anchorCache.get(absolutePath);
    if (cached !== undefined) return cached;
    const text = await readFile(absolutePath, "utf8");
    const computed = extractMarkdownAnchors(text);
    anchorCache.set(absolutePath, computed);
    return computed;
  };

  const broken: string[] = [];
  for (const file of files) {
    const sourcePath = join(rootPath, file);
    const text = await readFile(sourcePath, "utf8");
    anchorCache.set(sourcePath, extractMarkdownAnchors(text));

    for (const { line, target } of extractMarkdownLinks(text)) {
      const hashIndex = target.indexOf("#");
      const rawPath = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
      const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : undefined;
      const targetPath = rawPath === "" ? sourcePath : resolve(dirname(sourcePath), rawPath);

      if (!fileExists(targetPath)) {
        broken.push(`${file}:${line} → ${target}`);
        continue;
      }

      if (fragment !== undefined && /\.md$/iu.test(targetPath)) {
        const anchors = await anchorsFor(targetPath);
        if (fragment.length === 0 || !anchors.has(fragment)) {
          broken.push(`${file}:${line} → ${target}`);
        }
      }
    }
  }

  expect(broken).toEqual([]);
});
