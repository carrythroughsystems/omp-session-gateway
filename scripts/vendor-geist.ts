import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProvider } from "./provider-read.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "v1.9.2";
const archive = `geist-font-${version}.zip`;
const url = `https://github.com/vercel/geist-font/releases/download/${version}/${archive}`;
const sha256 = "15f066d58dcb99fb10014a49913009fdaf41e464cfb8851a44b44e593c95d3d8";
/** Basic Latin, Latin-1, Latin Extended-A, general punctuation, and the arrows and operators interface copy uses. */
const unicodeRange = "U+0020-007E, U+00A0-017F, U+2010-2027, U+2030-203A, U+2044, U+20AC, U+2122, U+2190-2193, U+2196-2199, U+2212, U+2215, U+2248, U+2260, U+2264-2265";
/** Kerning and composition, tabular and proportional figures, case-sensitive forms, and the rounded-dot set (`ss08`). */
const layoutFeatures = "kern,liga,calt,ccmp,locl,mark,mkmk,tnum,pnum,case,frac,ss08";
const maxFaceBytes = 48_000;
const faces = [
  { family: "Geist", style: "normal", source: "Geist/variable/Geist[wght].ttf", file: "geist-latin.woff2", features: ["ss08", "tnum"] },
  { family: "Geist", style: "italic", source: "Geist/variable/Geist-Italic[wght].ttf", file: "geist-italic-latin.woff2", features: ["ss08", "tnum"] },
  { family: "Geist Mono", style: "normal", source: "GeistMono/variable/GeistMono[wght].ttf", file: "geist-mono-latin.woff2", features: ["ss08"] },
] as const;
const outputDirectory = join(root, "apps/web/src/fonts/geist");
const licenseDirectory = join(root, "licenses/fonts/geist");

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source" || !args[1])) {
  throw new Error("usage: bun scripts/vendor-geist.ts [--source <extracted-geist-font-directory>]");
}
const subsetter = Bun.which("pyftsubset");
if (subsetter === null) throw new Error("pyftsubset (fontTools with Brotli support) must be on PATH");
// Use the subsetter's Python environment, including isolated Homebrew/pipx installations.
const shebang = (await readFile(subsetter, "utf8")).split("\n", 1)[0] ?? "";
const python = process.env.FONTTOOLS_PYTHON ?? /^#!(\/\S*\/python[0-9.]*)\s*$/u.exec(shebang)?.[1] ?? Bun.which("python3");
if (python === null) throw new Error("Python with fontTools is required; set FONTTOOLS_PYTHON if needed");

const inspectScript = `import json, sys
from fontTools.ttLib import TTFont
with TTFont(sys.argv[1]) as font:
    print(json.dumps({
        "axes": {axis.axisTag: [axis.minValue, axis.maxValue] for axis in font["fvar"].axes} if "fvar" in font else {},
        "features": sorted({record.FeatureTag for record in font["GSUB"].table.FeatureList.FeatureRecord}),
    }))
`;

let temporaryDirectory: string | undefined;
try {
  let sourceDirectory: string;
  if (args[1] !== undefined) {
    sourceDirectory = resolve(args[1]);
  } else {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-geist-"));
    const response = await readProvider(() => fetch(url));
    if (!response.ok) throw new Error(`font archive download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) throw new Error(`font archive SHA-256 mismatch: expected ${sha256}, got ${actual}`);
    const archivePath = join(temporaryDirectory, archive);
    await writeFile(archivePath, bytes);
    // The variable files are named `Family[wght].ttf`, and unzip reads brackets as a character class.
    const members = [...new Set(faces.map(face => `geist-font/${dirname(face.source)}/*`))];
    await Bun.$`unzip -q ${archivePath} ${members} geist-font/OFL.txt -d ${temporaryDirectory}`;
    sourceDirectory = join(temporaryDirectory, "geist-font");
  }

  // A subset is a Modified Version: it may keep the family name only while the license reserves none.
  const license = await readFile(join(sourceDirectory, "OFL.txt"), "utf8");
  if (/with Reserved Font Name/iu.test(license)) throw new Error("upstream OFL.txt reserves a font name; a subset cannot keep it");

  await mkdir(outputDirectory, { recursive: true });
  const vendored: Array<{ family: string; style: string; file: string; sha256: string; bytes: number }> = [];
  for (const face of faces) {
    const output = join(outputDirectory, face.file);
    await Bun.$`${subsetter} ${join(sourceDirectory, face.source)} --unicodes=${unicodeRange.replaceAll(" ", "")} --layout-features=${layoutFeatures} --flavor=woff2 --no-hinting --desubroutinize --output-file=${output}`.quiet();
    const content = await readFile(output);
    if (content.byteLength > maxFaceBytes) throw new Error(`${face.file} exceeds the ${maxFaceBytes}-byte face limit`);
    const inspected = JSON.parse(await Bun.$`${python} -c ${inspectScript} ${output}`.text()) as {
      axes: Record<string, [number, number]>;
      features: string[];
    };
    const weight = inspected.axes.wght;
    if (weight === undefined || weight[0] !== 100 || weight[1] !== 900) throw new Error(`${face.file} lost its 100–900 weight axis`);
    const missing = face.features.filter(feature => !inspected.features.includes(feature));
    if (missing.length > 0) throw new Error(`${face.file} lost layout features: ${missing.join(", ")}`);
    vendored.push({
      family: face.family,
      style: face.style,
      file: face.file,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
    });
  }
  const manifest = {
    source: { project: "vercel/geist-font", version, archive, sha256, license: "OFL-1.1" },
    weight: "100 900",
    unicodeRange,
    layoutFeatures,
    faces: vendored,
  };
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(licenseDirectory, { recursive: true });
  await copyFile(join(sourceDirectory, "OFL.txt"), join(licenseDirectory, "LICENSE"));
  console.table(vendored.map(({ file, bytes }) => ({ file, bytes })));
} finally {
  if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
}
