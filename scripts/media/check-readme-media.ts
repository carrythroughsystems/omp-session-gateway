import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { findCapabilityLeaks } from "../capability-leak-rules.ts";
import { findIdentifierLeaks } from "../identifier-leak-rules.ts";
import {
  BINARY_MEDIA_NAMES,
  DEMO_DURATION_SECONDS,
  DEMO_FPS,
  DEMO_FRAME_COUNT,
  DEMO_HEIGHT,
  DEMO_WIDTH,
  FORBIDDEN_PNG_CHUNKS,
  GIF_TARGET_BYTES,
  MAX_BYTES,
  MEDIA_DIRECTORY_NAMES,
  PNG_DIMENSIONS,
  POSTER_FRAME_INDEX,
  REPOSITORY_ROOT,
  isJsonObject,
  normalizedVersion,
  parseGif,
  parsePng,
  parseRate,
  parseTopLevelMp4Atoms,
  probeMedia,
  runProcess,
  sha256File,
  type BinaryMediaName,
  type MediaAssetManifestRecord,
  type MediaManifest,
} from "./readme-media-contract.ts";

export interface MediaCheckResult {
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
}

export interface MediaCheckContext {
  readonly repositoryRoot: string;
  readonly runProcess: typeof runProcess;
  readonly probeMedia: typeof probeMedia;
}

const DEFAULT_CHECK_CONTEXT: MediaCheckContext = { repositoryRoot: REPOSITORY_ROOT, runProcess, probeMedia };

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_COMPOSITE_INPUT_IDS: Readonly<Record<string, true>> = {
  "runtime:01-all-clear.png": true,
  "runtime:discovered-live-five": true,
  "runtime:02-needs-you.png": true,
  "runtime:03-open-request.png": true,
  "brand:assets/logo.svg": true,
  "brand:apps/web/src/fonts/geist/geist-latin.woff2": true,
};
const REQUIRED_README_REFERENCES = [
  "docs/media/omp-session-gateway-demo.gif",
  "docs/media/omp-session-gateway-demo.mp4",
  "docs/media/omp-session-gateway-product-flow.png",
  "docs/media/01-all-clear.png",
  "docs/media/02-needs-you.png",
  "docs/media/03-open-request.png",
  "docs/media/04-notification-settings.png",
  "docs/media/README.md",
] as const;
const REQUIRED_IMAGE_ALT_TERMS: Readonly<Record<string, readonly string[]>> = {
  "docs/media/omp-session-gateway-demo.gif": ["session", "request"],
  "docs/media/omp-session-gateway-product-flow.png": ["discover", "triage", "control"],
  "docs/media/01-all-clear.png": ["all clear", "session"],
  "docs/media/02-needs-you.png": ["needs you", "waiting"],
  "docs/media/03-open-request.png": ["request", "collaboration"],
  "docs/media/04-notification-settings.png": ["notification", "session"],
};
const FORBIDDEN_MP4_TAGS: Readonly<Record<string, true>> = {
  creation_time: true,
  location: true,
  location_eng: true,
  title: true,
  comment: true,
  description: true,
  synopsis: true,
};

function addFailure(failures: string[], path: string, category: string): void {
  failures.push(`${path}: ${category}`);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string,
  failures: string[],
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    addFailure(failures, path, "manifest keys differ from schema");
  }
}


function scanPublicSafety(path: string, text: string, failures: string[], byteBase = 0): void {
  for (const finding of findCapabilityLeaks(text)) {
    addFailure(failures, path, `${finding.label} at byte ${byteBase + finding.byteOffset}`);
  }
  for (const finding of findIdentifierLeaks(text)) {
    addFailure(failures, path, `${finding.label} on line ${finding.line}`);
  }
  const patterns: readonly (readonly [string, RegExp])[] = [
    ["email address", /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu],
    ["macOS or Linux home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+/gu],
    ["Windows home path", /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/gu],
    ["GPS or location metadata", /(?:GPS|ISO6709|location(?:_eng)?)\s*[=:]/giu],
  ];
  for (const [category, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      addFailure(failures, path, `${category} at byte ${byteBase + match.index}`);
    }
  }

  const urlPattern = /\b(?:https?|wss?):\/\/[^\s"'`<>]+/giu;
  for (const match of text.matchAll(urlPattern)) {
    try {
      const url = new URL(match[0]);
      const safeHost = url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname.endsWith(".test") ||
        url.hostname === "example.com" ||
        url.hostname.endsWith(".example");
      if (!safeHost) addFailure(failures, path, `non-reserved hostname at byte ${byteBase + match.index}`);
    } catch {
      addFailure(failures, path, `unparseable URL at byte ${byteBase + match.index}`);
    }
  }
}

function validateManifestShape(value: unknown, failures: string[]): value is MediaManifest {
  const initialFailureCount = failures.length;
  const path = "docs/media/manifest.json";
  if (!isJsonObject(value)) {
    addFailure(failures, path, "manifest root is not an object");
    return false;
  }
  hasExactKeys(value, ["schemaVersion", "sourceRevision", "upstreamClient", "generatedBy", "capture", "assets"], path, failures);
  if (value.schemaVersion !== 1) addFailure(failures, path, "unsupported schemaVersion");
  if (typeof value.sourceRevision !== "string" || !COMMIT_PATTERN.test(value.sourceRevision)) {
    addFailure(failures, path, "sourceRevision is not a full commit hash");
  }

  if (!isJsonObject(value.upstreamClient)) {
    addFailure(failures, path, "upstreamClient is not an object");
  } else {
    hasExactKeys(value.upstreamClient, ["tag", "commit", "packageVersion"], `${path} upstreamClient`, failures);
    if (typeof value.upstreamClient.tag !== "string" || value.upstreamClient.tag.length === 0) {
      addFailure(failures, path, "upstream client tag is missing");
    }
    if (typeof value.upstreamClient.commit !== "string" || !COMMIT_PATTERN.test(value.upstreamClient.commit)) {
      addFailure(failures, path, "upstream client commit is invalid");
    }
    if (typeof value.upstreamClient.packageVersion !== "string" || value.upstreamClient.packageVersion.length === 0) {
      addFailure(failures, path, "upstream client package version is missing");
    }
  }

  if (!isJsonObject(value.generatedBy)) {
    addFailure(failures, path, "generatedBy is not an object");
  } else {
    const toolKeys = ["command", "bun", "typescript", "playwright", "chromium", "ffmpeg", "ffprobe"];
    hasExactKeys(value.generatedBy, toolKeys, `${path} generatedBy`, failures);
    if (value.generatedBy.command !== "bun run media:capture") {
      addFailure(failures, path, "capture command is not canonical");
    }
    for (const key of toolKeys.slice(1)) {
      if (typeof value.generatedBy[key] !== "string" || value.generatedBy[key].length === 0) {
        addFailure(failures, path, `${key} version is missing`);
      }
    }
    if (typeof value.generatedBy.ffmpeg === "string" && !/^\d+(?:\.\d+)*$/u.test(value.generatedBy.ffmpeg)) {
      addFailure(failures, path, "ffmpeg version is not normalized");
    }
    if (typeof value.generatedBy.ffprobe === "string" && !/^\d+(?:\.\d+)*$/u.test(value.generatedBy.ffprobe)) {
      addFailure(failures, path, "ffprobe version is not normalized");
    }
  }

  if (!isJsonObject(value.capture)) {
    addFailure(failures, path, "capture is not an object");
  } else {
    hasExactKeys(
      value.capture,
      [
        "clock",
        "locale",
        "timezone",
        "colorScheme",
        "reducedMotion",
        "viewportCss",
        "deviceScaleFactor",
        "runtimeNetworkPolicy",
        "compositorNetworkPolicy",
        "unexpectedRuntimeRequests",
        "unexpectedCompositorRequests",
      ],
      `${path} capture`,
      failures,
    );
    const viewport = value.capture.viewportCss;
    if (!Array.isArray(viewport) || viewport.length !== 2 || viewport[0] !== 390 || viewport[1] !== 844) {
      addFailure(failures, path, "capture viewport is not 390x844 CSS pixels");
    }
    const exactCaptureFields: Readonly<Record<string, unknown>> = {
      clock: "2026-08-21T12:10:00.000Z",
      locale: "en-US",
      timezone: "UTC",
      colorScheme: "dark",
      reducedMotion: "reduce",
      deviceScaleFactor: 2,
      runtimeNetworkPolicy: "same-origin-fixture-only",
      compositorNetworkPolicy: "offline-data-urls-only",
      unexpectedRuntimeRequests: 0,
      unexpectedCompositorRequests: 0,
    };
    for (const [key, expected] of Object.entries(exactCaptureFields)) {
      if (value.capture[key] !== expected) addFailure(failures, path, `${key} differs from capture contract`);
    }
  }

  if (!isJsonObject(value.assets)) {
    addFailure(failures, path, "assets is not an object");
    return false;
  }
  hasExactKeys(value.assets, BINARY_MEDIA_NAMES, `${path} assets`, failures);
  for (const name of BINARY_MEDIA_NAMES) {
    const record = value.assets[name];
    if (!isJsonObject(record)) {
      addFailure(failures, path, `${name} record is not an object`);
      continue;
    }
    const allowedKeys = [
      "bytes",
      "sha256",
      "width",
      "height",
      "provenance",
      "frameCount",
      "durationSeconds",
      "fps",
      "loopCount",
      "codec",
      "pixelFormat",
      "sourceFrame",
      "compositeInputs",
    ];
    const unknownKeys = Object.keys(record).filter(key => !allowedKeys.includes(key));
    if (unknownKeys.length > 0) addFailure(failures, path, `${name} record has unknown keys`);
    if (!Number.isInteger(record.bytes) || Number(record.bytes) <= 0) addFailure(failures, path, `${name} byte size is invalid`);
    if (typeof record.sha256 !== "string" || !HASH_PATTERN.test(record.sha256)) addFailure(failures, path, `${name} hash is invalid`);
    if (!Number.isInteger(record.width) || !Number.isInteger(record.height)) addFailure(failures, path, `${name} dimensions are invalid`);
    if (
      record.provenance !== "built-pwa-runtime" &&
      record.provenance !== "built-pwa-runtime-with-pinned-collab-client" &&
      record.provenance !== "capture-only-presentation-composite"
    ) {
      addFailure(failures, path, `${name} provenance is invalid`);
    }
    if (record.compositeInputs !== undefined) {
      if (!Array.isArray(record.compositeInputs) || record.compositeInputs.length === 0) {
        addFailure(failures, path, `${name} compositeInputs is invalid`);
      } else {
        for (const input of record.compositeInputs) {
          if (!isJsonObject(input) || typeof input.id !== "string" || SAFE_COMPOSITE_INPUT_IDS[input.id] !== true) {
            addFailure(failures, path, `${name} has a non-canonical composite input`);
            continue;
          }
          if (typeof input.sha256 !== "string" || !HASH_PATTERN.test(input.sha256)) {
            addFailure(failures, path, `${name} composite input hash is invalid`);
          }
        }
      }
    }
  }
  return failures.length === initialFailureCount;
}

function expectedProvenance(name: BinaryMediaName): MediaAssetManifestRecord["provenance"] {
  if (name === "03-open-request.png") return "built-pwa-runtime-with-pinned-collab-client";
  if (name.endsWith(".png") && /^0[124]-/u.test(name)) return "built-pwa-runtime";
  return "capture-only-presentation-composite";
}

function validateReadmeReferences(readme: string, mediaNames: Readonly<Record<string, true>>, failures: string[]): void {
  for (const reference of REQUIRED_README_REFERENCES) {
    if (!readme.includes(reference)) addFailure(failures, "README.md", `missing canonical reference ${reference}`);
  }

  const altByPath: Record<string, string> = {};
  for (const tag of readme.matchAll(/<img\b[^>]*>/giu)) {
    const sourceMatch = /\bsrc\s*=\s*(["'])(.*?)\1/iu.exec(tag[0]);
    const source = sourceMatch?.[2]?.replace(/^\.\//u, "");
    if (source === undefined || !source.startsWith("docs/media/")) continue;
    const altMatch = /\balt\s*=\s*(["'])(.*?)\1/iu.exec(tag[0]);
    altByPath[source] = (altMatch?.[2] ?? "").trim();
  }
  for (const match of readme.matchAll(/!\[([^\]]*)\]\((?:\.\/)?(docs\/media\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/gu)) {
    altByPath[match[2] as string] = (match[1] ?? "").trim();
  }

  for (const [path, terms] of Object.entries(REQUIRED_IMAGE_ALT_TERMS)) {
    const alt = altByPath[path] ?? "";
    if (alt.length < 20) {
      addFailure(failures, "README.md", `${path} alt text is missing or too generic`);
      continue;
    }
    const lower = alt.toLowerCase();
    for (const term of terms) {
      if (!lower.includes(term)) addFailure(failures, "README.md", `${path} alt text omits ${term}`);
    }
    if (path.endsWith("demo.gif") && /(?:resolv|answer|returns? to all clear)/iu.test(alt)) {
      addFailure(failures, "README.md", "GIF alt text claims an unauthored resolution");
    }
  }

  for (const reference of readme.matchAll(/(?:\.\/)?docs\/media\/[A-Za-z0-9._-]+/gu)) {
    const name = reference[0].replace(/^\.\/docs\/media\//u, "").replace(/^docs\/media\//u, "");
    if (mediaNames[name] !== true) addFailure(failures, "README.md", "references an unknown docs/media path");
  }
}

export async function validatePackagePins(
  manifest: Pick<MediaManifest, "upstreamClient" | "generatedBy">,
  failures: string[],
  repositoryRoot = REPOSITORY_ROOT,
): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    readonly packageManager: string;
    readonly devDependencies: Readonly<Record<string, string>>;
  };
  const upstream = JSON.parse(await readFile(join(repositoryRoot, "packages/collab-client/upstream/UPSTREAM.json"), "utf8")) as {
    readonly tag: string;
    readonly commit: string;
    readonly packageVersion: string;
  };
  const expectedBun = packageJson.packageManager.replace(/^bun@/u, "");
  if (manifest.generatedBy.bun !== expectedBun || manifest.generatedBy.bun !== Bun.version) {
    addFailure(failures, "docs/media/manifest.json", "Bun version differs from the pinned capture tool");
  }
  if (manifest.generatedBy.typescript !== packageJson.devDependencies.typescript) {
    addFailure(failures, "docs/media/manifest.json", "TypeScript version differs from package pin");
  }
  if (manifest.generatedBy.playwright !== packageJson.devDependencies["@playwright/test"]) {
    addFailure(failures, "docs/media/manifest.json", "Playwright version differs from package pin");
  }
  if (
    manifest.upstreamClient.tag !== upstream.tag ||
    manifest.upstreamClient.commit !== upstream.commit ||
    manifest.upstreamClient.packageVersion !== upstream.packageVersion
  ) {
    addFailure(failures, "docs/media/manifest.json", "pinned collaboration client provenance differs from packages/collab-client/upstream/UPSTREAM.json");
  }
}

async function validateToolAndSourcePins(manifest: MediaManifest, failures: string[], context: MediaCheckContext): Promise<void> {
  await validatePackagePins(manifest, failures, context.repositoryRoot);
  const [ffmpegOutput, ffprobeOutput] = await Promise.all([
    context.runProcess("ffmpeg", ["-version"]),
    context.runProcess("ffprobe", ["-version"]),
  ]);
  if (manifest.generatedBy.ffmpeg !== normalizedVersion(ffmpegOutput, "ffmpeg")) {
    addFailure(failures, "docs/media/manifest.json", "FFmpeg version differs from capture provenance");
  }
  if (manifest.generatedBy.ffprobe !== normalizedVersion(ffprobeOutput, "ffprobe")) {
    addFailure(failures, "docs/media/manifest.json", "ffprobe version differs from capture provenance");
  }
  try {
    await context.runProcess("git", ["-C", context.repositoryRoot, "cat-file", "-e", `${manifest.sourceRevision}^{commit}`]);
  } catch {
    addFailure(failures, "docs/media/manifest.json", "source revision is not available in repository history");
  }
}

async function validateManifestInputs(manifest: MediaManifest, failures: string[], repositoryRoot: string): Promise<void> {
  const canonicalHashes: Readonly<Record<string, string>> = {
    "runtime:01-all-clear.png": manifest.assets["01-all-clear.png"].sha256,
    "runtime:02-needs-you.png": manifest.assets["02-needs-you.png"].sha256,
    "runtime:03-open-request.png": manifest.assets["03-open-request.png"].sha256,
    "brand:assets/logo.svg": await sha256File(join(repositoryRoot, "assets/logo.svg")),
    "brand:apps/web/src/fonts/geist/geist-latin.woff2": await sha256File(join(repositoryRoot, "apps/web/src/fonts/geist/geist-latin.woff2")),
  };
  for (const name of BINARY_MEDIA_NAMES) {
    const record = manifest.assets[name];
    if (record.provenance !== expectedProvenance(name)) {
      addFailure(failures, "docs/media/manifest.json", `${name} has the wrong provenance category`);
    }
    const isComposite = record.provenance === "capture-only-presentation-composite";
    if (isComposite !== (record.compositeInputs !== undefined)) {
      addFailure(failures, "docs/media/manifest.json", `${name} composite input provenance is incomplete`);
    }
    for (const input of record.compositeInputs ?? []) {
      const expected = canonicalHashes[input.id];
      if (expected !== undefined && input.sha256 !== expected) {
        addFailure(failures, "docs/media/manifest.json", `${name} composite input hash differs from its canonical source`);
      }
    }
  }
  if (manifest.assets["omp-session-gateway-demo-poster.png"].sourceFrame !== POSTER_FRAME_INDEX) {
    addFailure(failures, "docs/media/manifest.json", "poster source frame is not frame 0060");
  }
}

async function decodedGifHashes(path: string, execute: typeof runProcess): Promise<readonly string[]> {
  const frameMd5 = await execute("ffmpeg", [
    "-v",
    "error",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-f",
    "framemd5",
    "-",
  ]);
  return frameMd5
    .split("\n")
    .filter(line => line !== "" && !line.startsWith("#"))
    .map(line => line.split(",").at(-1)?.trim() ?? "");
}

export async function checkReadmeMedia(context: MediaCheckContext = DEFAULT_CHECK_CONTEXT): Promise<MediaCheckResult> {
  const repositoryRoot = context.repositoryRoot;
  const mediaDirectory = join(repositoryRoot, "docs/media");
  const failures: string[] = [];
  const warnings: string[] = [];
  const allowedNames: Readonly<Record<string, true>> = Object.fromEntries(
    MEDIA_DIRECTORY_NAMES.map(name => [name, true]),
  );

  let directoryNames: string[] = [];
  try {
    directoryNames = await readdir(mediaDirectory);
  } catch {
    addFailure(failures, "docs/media", "canonical media directory is missing");
    return { failures, warnings };
  }
  for (const name of MEDIA_DIRECTORY_NAMES) {
    if (!directoryNames.includes(name)) addFailure(failures, "docs/media", `missing required file ${name}`);
  }
  for (const name of directoryNames) {
    if (allowedNames[name] !== true) addFailure(failures, "docs/media", "unexpected file (concept/contact-sheet/stale output)");
  }

  let manifest: MediaManifest | undefined;
  try {
    const manifestText = await readFile(join(mediaDirectory, "manifest.json"), "utf8");
    scanPublicSafety("docs/media/manifest.json", manifestText, failures);
    const parsed: unknown = JSON.parse(manifestText);
    if (validateManifestShape(parsed, failures)) manifest = parsed;
  } catch {
    addFailure(failures, "docs/media/manifest.json", "manifest is unreadable or invalid JSON");
  }

  // Never regex-scan compressed pixel/video payloads: arbitrary codec bytes produce random
  // identifier- and URL-shaped strings. Public text and the manifest are scanned above; PNG text
  // chunks, GIF comments, and MP4 tags are rejected or scanned structurally below.
  for (const name of BINARY_MEDIA_NAMES) {
    const path = join(mediaDirectory, name);
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) {
        addFailure(failures, `docs/media/${name}`, "canonical asset is not a regular file");
        continue;
      }
      if (fileStat.size <= 0 || fileStat.size > MAX_BYTES[name]) {
        addFailure(failures, `docs/media/${name}`, "asset size is outside the canonical limit");
      }
      if (name === "omp-session-gateway-demo.gif" && fileStat.size > GIF_TARGET_BYTES) {
        warnings.push(`docs/media/${name}: above the 3 MiB target but below the hard cap`);
      }
      if (manifest !== undefined) {
        const hash = await sha256File(path);
        const record = manifest.assets[name];
        if (record.bytes !== fileStat.size) addFailure(failures, `docs/media/${name}`, "manifest byte size mismatch");
        if (record.sha256 !== hash) addFailure(failures, `docs/media/${name}`, "manifest SHA-256 mismatch");
      }
    } catch {
      addFailure(failures, `docs/media/${name}`, "asset is missing or unreadable");
    }
  }

  for (const [name, dimensions] of Object.entries(PNG_DIMENSIONS)) {
    try {
      const info = parsePng(await readFile(join(mediaDirectory, name)));
      if (info.width !== dimensions[0] || info.height !== dimensions[1]) {
        addFailure(failures, `docs/media/${name}`, "PNG dimensions differ from contract");
      }
      if (info.bitDepth !== 8 || (info.colorType !== 2 && info.colorType !== 6)) {
        addFailure(failures, `docs/media/${name}`, "PNG is not 8-bit RGB/RGBA");
      }
      for (const chunk of info.chunks) {
        if (FORBIDDEN_PNG_CHUNKS[chunk] === true) {
          addFailure(failures, `docs/media/${name}`, `forbidden PNG ${chunk} metadata`);
        }
      }
    } catch {
      addFailure(failures, `docs/media/${name}`, "PNG parser rejected asset");
    }
  }

  try {
    const gifPath = join(mediaDirectory, "omp-session-gateway-demo.gif");
    const info = parseGif(await readFile(gifPath));
    if (info.width !== DEMO_WIDTH || info.height !== DEMO_HEIGHT) addFailure(failures, "docs/media/omp-session-gateway-demo.gif", "GIF dimensions differ");
    if (info.frameCount !== DEMO_FRAME_COUNT) addFailure(failures, "docs/media/omp-session-gateway-demo.gif", "GIF frame count differs");
    if (Math.abs(info.durationSeconds - DEMO_DURATION_SECONDS) > 0.1) addFailure(failures, "docs/media/omp-session-gateway-demo.gif", "GIF duration differs");
    if (info.frameCount / info.durationSeconds > 15) addFailure(failures, "docs/media/omp-session-gateway-demo.gif", "GIF effective frame rate exceeds 15 fps");
    if (!info.delaysCentiseconds.every(delay => delay === 10)) addFailure(failures, "docs/media/omp-session-gateway-demo.gif", "GIF frames are not all 100ms");
    if (info.loopCount !== 0) addFailure(failures, "docs/media/omp-session-gateway-demo.gif", "GIF is not an infinite loop");
    if (info.commentExtensions !== 0) addFailure(failures, "docs/media/omp-session-gateway-demo.gif", "GIF contains comment metadata");
    const hashes = await decodedGifHashes(gifPath, context.runProcess);
    if (hashes.length !== DEMO_FRAME_COUNT || hashes[0] !== hashes.at(-1)) {
      addFailure(failures, "docs/media/omp-session-gateway-demo.gif", "decoded first and last frames do not form the authored calm loop");
    }
  } catch {
    addFailure(failures, "docs/media/omp-session-gateway-demo.gif", "GIF parser or decoder rejected asset");
  }

  try {
    const mp4Path = join(mediaDirectory, "omp-session-gateway-demo.mp4");
    const [bytes, probe] = await Promise.all([readFile(mp4Path), context.probeMedia(mp4Path)]);
    const atoms = parseTopLevelMp4Atoms(bytes);
    const moov = atoms.indexOf("moov");
    const mdat = atoms.indexOf("mdat");
    if (moov < 0 || mdat < 0 || moov > mdat) addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 faststart atom order is invalid");
    if (probe.streams?.length !== 1) addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 must have exactly one stream");
    const stream = probe.streams?.[0];
    if (stream?.codec_type !== "video") addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 has a non-video stream");
    if (stream?.codec_name !== "h264") addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 codec is not H.264");
    if (stream?.pix_fmt !== "yuv420p") addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 pixel format is not yuv420p");
    if (stream?.width !== DEMO_WIDTH || stream.height !== DEMO_HEIGHT) addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 dimensions differ");
    if (Number(stream?.nb_read_frames ?? stream?.nb_frames) !== DEMO_FRAME_COUNT) addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 frame count differs");
    if (Math.abs(Number(stream?.duration ?? probe.format?.duration) - DEMO_DURATION_SECONDS) > 0.1) addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 duration differs");
    if (Math.abs(parseRate(stream?.avg_frame_rate ?? stream?.r_frame_rate) - DEMO_FPS) > 0.001) addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 frame rate differs");
    for (const tags of [stream?.tags, probe.format?.tags]) {
      scanPublicSafety("docs/media/omp-session-gateway-demo.mp4 metadata", JSON.stringify(tags ?? {}), failures);
      for (const key of Object.keys(tags ?? {})) {
        if (FORBIDDEN_MP4_TAGS[key.toLowerCase()] === true) {
          addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", `forbidden MP4 ${key} metadata`);
        }
      }
    }
  } catch {
    addFailure(failures, "docs/media/omp-session-gateway-demo.mp4", "MP4 parser or ffprobe rejected asset");
  }

  const textPaths = [
    join(repositoryRoot, "scripts/media/readme-media-contract.ts"),
    join(repositoryRoot, "scripts/media/readme-media-compositor.ts"),
    join(repositoryRoot, "scripts/media/capture-readme-media.ts"),
    join(mediaDirectory, "README.md"),
  ];
  for (const path of textPaths) {
    try {
      scanPublicSafety(relative(repositoryRoot, path), await readFile(path, "utf8"), failures);
    } catch {
      addFailure(failures, relative(repositoryRoot, path), "public-safety source is unreadable");
    }
  }

  try {
    const provenance = await readFile(join(mediaDirectory, "README.md"), "utf8");
    const markers = [
      "synthetic",
      "capture-only",
      "actual built PWA",
      "pinned OMP collaboration client",
      "memory-only capabilities",
      "no transcript storage",
      "not affiliated with OMP",
    ];
    for (const marker of markers) {
      if (!provenance.includes(marker)) addFailure(failures, "docs/media/README.md", `missing public provenance marker ${marker}`);
    }
  } catch {
    addFailure(failures, "docs/media/README.md", "provenance file is unreadable");
  }

  try {
    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
    validateReadmeReferences(readme, allowedNames, failures);
  } catch {
    addFailure(failures, "README.md", "root README is unreadable");
  }

  if (manifest !== undefined) {
    await validateToolAndSourcePins(manifest, failures, context);
    await validateManifestInputs(manifest, failures, repositoryRoot);
    const animation = manifest.assets["omp-session-gateway-demo.gif"];
    if (
      animation.width !== DEMO_WIDTH ||
      animation.height !== DEMO_HEIGHT ||
      animation.frameCount !== DEMO_FRAME_COUNT ||
      animation.durationSeconds !== DEMO_DURATION_SECONDS ||
      animation.fps !== DEMO_FPS ||
      animation.loopCount !== 0
    ) {
      addFailure(failures, "docs/media/manifest.json", "GIF semantic record differs from canonical animation");
    }
    const video = manifest.assets["omp-session-gateway-demo.mp4"];
    if (
      video.width !== DEMO_WIDTH ||
      video.height !== DEMO_HEIGHT ||
      video.frameCount !== DEMO_FRAME_COUNT ||
      video.durationSeconds !== DEMO_DURATION_SECONDS ||
      video.fps !== DEMO_FPS ||
      video.codec !== "h264" ||
      video.pixelFormat !== "yuv420p"
    ) {
      addFailure(failures, "docs/media/manifest.json", "MP4 semantic record differs from canonical animation");
    }
  }

  return { failures, warnings };
}

async function main(): Promise<void> {
  const result = await checkReadmeMedia();
  for (const warning of result.warnings) console.warn(`media:check warning: ${warning}`);
  if (result.failures.length > 0) {
    console.error("media:check failed:");
    for (const failure of result.failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("media:check passed");
}

if (import.meta.main) await main();
