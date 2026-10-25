import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProvider } from "./provider-read.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "v3.5.1";
const archive = "NerdFontsSymbolsOnly.zip";
const url = `https://github.com/ryanoasis/nerd-fonts/releases/download/${version}/${archive}`;
const sha256 = "fdca3682534f6f65e1ccb2345b0362ccf67d9b8eca7c8025330946e93e2473bc";
const face = "SymbolsNerdFontMono-Regular.ttf";
const family = "Symbols Nerd Font Mono";
const maxChunkBytes = 80_000;
const outputDirectory = join(root, "apps/web/src/fonts/nerd-symbols");
const licenseDirectory = join(root, "licenses/fonts/nerd-fonts");

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source" || !args[1])) {
  throw new Error("usage: bun scripts/vendor-nerd-symbols.ts [--source <extracted-directory>]");
}
const subsetter = Bun.which("pyftsubset");
if (subsetter === null) throw new Error("pyftsubset (fontTools with Brotli support) must be on PATH");
// Use the subsetter's Python environment, including isolated Homebrew/pipx installations.
const shebang = (await readFile(subsetter, "utf8")).split("\n", 1)[0] ?? "";
const python = process.env.FONTTOOLS_PYTHON ?? /^#!(\/\S*\/python[0-9.]*)\s*$/u.exec(shebang)?.[1] ?? Bun.which("python3");
if (python === null) throw new Error("Python with fontTools is required; set FONTTOOLS_PYTHON if needed");

const cmapScript = `import json, sys
from fontTools.ttLib import TTFont
with TTFont(sys.argv[1]) as font:
    print(json.dumps(sorted(cp for cp in font.getBestCmap()
        if 0xE000 <= cp <= 0xF8FF or 0xF0000 <= cp <= 0xFFFFD)))
`;
const chunks: Array<{ file: string; unicodeRange: string; glyphs: number }> = [];
const sizes: Array<{ name: string; range: string; glyphs: number; bytes: number }> = [];
let temporaryDirectory: string | undefined;
try {
  let sourceDirectory: string;
  if (args[1] !== undefined) {
    sourceDirectory = resolve(args[1]);
  } else {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-nerd-symbols-"));
    sourceDirectory = temporaryDirectory;
    const response = await readProvider(() => fetch(url));
    if (!response.ok) throw new Error(`font archive download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) throw new Error(`font archive SHA-256 mismatch: expected ${sha256}, got ${actual}`);
    const archivePath = join(sourceDirectory, archive);
    await writeFile(archivePath, bytes);
    await Bun.$`unzip -q ${archivePath} ${face} LICENSE README.md -d ${sourceDirectory}`;
  }

  const fontPath = join(sourceDirectory, face);
  const codepoints = JSON.parse(await Bun.$`${python} -c ${cmapScript} ${fontPath}`.text()) as number[];
  const readme = await readFile(join(sourceDirectory, "README.md"), "utf8");
  const iconSetTable = /^\| Icon set name[^\n]*\n(?:\|[^\n]*(?:\n|$))+/mu.exec(readme)?.[0];
  if (iconSetTable === undefined) throw new Error("upstream README.md is missing its icon-set license table");
  await mkdir(outputDirectory, { recursive: true });
  for (const plane of [
    { name: "bmp", min: 0xE000, max: 0xF8FF, maxGlyphs: 160 },
    { name: "md", min: 0xF0000, max: 0xFFFFD, maxGlyphs: 768 },
  ]) {
    const populated = codepoints.filter(codepoint => codepoint >= plane.min && codepoint <= plane.max);
    for (let start = 0; start < populated.length; start += plane.maxGlyphs) {
      const end = Math.min(start + plane.maxGlyphs, populated.length);
      const name = `${plane.name}-${String(start / plane.maxGlyphs + 1).padStart(2, "0")}`;
      const file = `${name}.woff2`;
      const first = populated[start]!.toString(16).toUpperCase().padStart(4, "0");
      const last = populated[end - 1]!.toString(16).toUpperCase().padStart(4, "0");
      const unicodeRange = `U+${first}-${last}`;
      const output = join(outputDirectory, file);
      await Bun.$`${subsetter} ${fontPath} --unicodes=${unicodeRange} --flavor=woff2 --no-hinting --desubroutinize --drop-tables+=PfEd --output-file=${output}`;
      const bytes = (await stat(output)).size;
      if (bytes > maxChunkBytes) throw new Error(`${file} exceeds the ${maxChunkBytes}-byte chunk limit`);
      chunks.push({ file, unicodeRange, glyphs: end - start });
      sizes.push({ name, range: unicodeRange, glyphs: end - start, bytes });
    }
  }
  const manifest = {
    family,
    source: { project: "ryanoasis/nerd-fonts", version, archive, sha256, face, license: "MIT" },
    chunks,
  };
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const currentFiles = new Set(chunks.map(chunk => chunk.file));
  for (const entry of await readdir(outputDirectory)) {
    if (entry.endsWith(".woff2") && !currentFiles.has(entry)) await rm(join(outputDirectory, entry));
  }
  await mkdir(licenseDirectory, { recursive: true });
  await copyFile(join(sourceDirectory, "LICENSE"), join(licenseDirectory, "LICENSE"));
  await writeFile(join(licenseDirectory, "ICON_SETS.md"), `# Nerd Fonts icon-set attributions

Source: [Nerd Fonts ${version}](https://github.com/ryanoasis/nerd-fonts/tree/${version}),
\`${archive}\` README.md. The upstream icon-set table is reproduced verbatim below;
Nerd Fonts' MIT license is retained in the adjacent \`LICENSE\`.

${iconSetTable}
## CC BY 4.0 attribution

- Font Awesome 6.5.1 by Fonticons, Inc. (<https://fontawesome.com>),
  from <https://github.com/FortAwesome/Font-Awesome/tree/6.5.1>,
  licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Codicons 0.0.45 by Microsoft and contributors,
  from <https://github.com/microsoft/vscode-codicons>,
  licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Local modifications: Private Use Area-only subsets split by unicode-range, hinting
removed, and converted to WOFF2 by \`scripts/vendor-nerd-symbols.ts\`. No endorsement
by the upstream authors is implied.
`);
  console.table(sizes);
  console.log(`Total: ${chunks.length} chunks, ${sizes.reduce((sum, chunk) => sum + chunk.glyphs, 0)} glyphs, ${sizes.reduce((sum, chunk) => sum + chunk.bytes, 0)} bytes`);
} finally {
  if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
}
