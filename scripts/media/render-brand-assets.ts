import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import {
  FORBIDDEN_PNG_CHUNKS,
  REPOSITORY_ROOT,
  assertCondition,
  jsonWithFinalNewline,
  parsePng,
  sha256File,
} from "./readme-media-contract.ts";

/** Source and output digests so `scripts/site-coherence.test.ts` can prove each PNG matches its committed source. */
export const ARTWORK_MANIFEST = "assets/artwork.json";

export interface ArtworkManifest {
  readonly generatedBy: string;
  readonly artwork: Readonly<Record<string, {
    readonly source: string;
    readonly sourceSha256: string;
    readonly outputSha256: string;
    readonly width: number;
    readonly height: number;
    /** Other committed files the render reads, so a change to one of them invalidates the output too. */
    readonly inputs?: Readonly<Record<string, string>>;
  }>>;
}

type ArtworkRecord = ArtworkManifest["artwork"][string];

/**
 * Exported artwork renders from its committed HTML source with the PWA's own vendored text faces;
 * `fonts` names each family the page must have loaded and the file it comes from. See the asset
 * inventory in docs/BRANDING.md.
 */
const GEIST = "apps/web/src/fonts/geist/geist-latin.woff2";
const GEIST_MONO = "apps/web/src/fonts/geist/geist-mono-latin.woff2";
const ARTWORK: readonly {
  source: string; output: string; width: number; height: number; scale: number; fonts: Readonly<Record<string, string>>;
}[] = [
  { source: "assets/banner.html", output: "assets/banner.png", width: 1280, height: 320, scale: 2, fonts: { Geist: GEIST } },
  { source: "assets/og.html", output: "assets/og.png", width: 1280, height: 640, scale: 1, fonts: { Geist: GEIST, "Geist Mono": GEIST_MONO } },
];

/**
 * Raster icons render from their committed SVG sources. `fill` paints an opaque square behind the
 * source (iOS composites a transparent touch icon onto black anyway); without it the canvas stays
 * transparent, which is what the Android status-bar badge is read from.
 */
const ICONS: readonly { source: string; output: string; size: number; fill?: string }[] = [
  { source: "apps/web/src/icon.svg", output: "apps/web/src/icon-192.png", size: 192 },
  { source: "apps/web/src/icon.svg", output: "apps/web/src/icon-512.png", size: 512 },
  { source: "apps/web/src/icon-maskable.svg", output: "apps/web/src/icon-maskable-512.png", size: 512 },
  { source: "apps/web/src/icon.svg", output: "apps/web/src/apple-touch-icon-180.png", size: 180, fill: "#000" },
  { source: "apps/web/src/badge.svg", output: "apps/web/src/badge-96.png", size: 96 },
];

/**
 * Every render loads from one virtual origin whose paths are repository files. Nothing else is
 * reachable, so a render makes no network request and same-origin font loading needs no flag.
 */
const ORIGIN = "https://brand.invalid";
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function serveRepository(context: BrowserContext, refused: string[]): Promise<void> {
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    const path = normalize(decodeURIComponent(url.pathname.slice(1)));
    const contentType = CONTENT_TYPES[extname(path)];
    if (
      url.origin !== ORIGIN || route.request().method() !== "GET" || contentType === undefined ||
      !/^(?:assets|apps\/web\/src)\//u.test(path)
    ) {
      refused.push(`${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    await route.fulfill({ contentType, body: await readFile(join(REPOSITORY_ROOT, path)) });
  });
}

async function recordOutput(source: string, output: string, width: number, height: number): Promise<ArtworkRecord> {
  const info = parsePng(await readFile(join(REPOSITORY_ROOT, output)));
  assertCondition(
    info.width === width && info.height === height,
    `${output}: rendered ${info.width}x${info.height}, expected ${width}x${height}`,
  );
  for (const chunk of info.chunks) {
    assertCondition(FORBIDDEN_PNG_CHUNKS[chunk] !== true, `${output}: contains forbidden PNG ${chunk} metadata`);
  }
  console.log(`media:brand: ${output} ${info.width}x${info.height}`);
  return {
    source,
    sourceSha256: await sha256File(join(REPOSITORY_ROOT, source)),
    outputSha256: await sha256File(join(REPOSITORY_ROOT, output)),
    width: info.width,
    height: info.height,
  };
}

async function renderArtwork(browser: Browser, artwork: (typeof ARTWORK)[number]): Promise<ArtworkRecord> {
  const context = await browser.newContext({
    viewport: { width: artwork.width, height: artwork.height },
    deviceScaleFactor: artwork.scale,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const refused: string[] = [];
  try {
    await serveRepository(context, refused);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/${artwork.source}`, { waitUntil: "load" });
    const families = Object.keys(artwork.fonts);
    const loadedFamilies = await page.evaluate(async names => {
      await document.fonts.ready;
      const faces = [...document.fonts];
      return names.filter(family =>
        faces.some(face => face.family.replaceAll('"', "") === family && face.status === "loaded"),
      );
    }, families);
    const missing = families.filter(family => !loadedFamilies.includes(family));
    assertCondition(missing.length === 0, `${artwork.source}: display faces did not load (${missing.join(", ")})`);
    assertCondition(refused.length === 0, `${artwork.source}: refused request to ${[...new Set(refused)].join(", ")}`);

    await page.screenshot({
      path: join(REPOSITORY_ROOT, artwork.output),
      fullPage: false,
      animations: "disabled",
      scale: "device",
    });
    const inputs: Record<string, string> = {};
    for (const input of Object.values(artwork.fonts)) inputs[input] = await sha256File(join(REPOSITORY_ROOT, input));
    return {
      ...await recordOutput(artwork.source, artwork.output, artwork.width * artwork.scale, artwork.height * artwork.scale),
      inputs,
    };
  } finally {
    await context.close();
  }
}

async function renderIcon(browser: Browser, icon: (typeof ICONS)[number]): Promise<ArtworkRecord> {
  const context = await browser.newContext({
    viewport: { width: icon.size, height: icon.size },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const refused: string[] = [];
  try {
    await serveRepository(context, refused);
    const page = await context.newPage();
    // A wrapper document rather than the SVG itself, so the image is laid out at exactly the output size.
    await page.route(`${ORIGIN}/icon`, route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><body style="margin:0;background:${icon.fill ?? "transparent"}"><img src="/${icon.source}" width="${icon.size}" height="${icon.size}" style="display:block">`,
    }));
    await page.goto(`${ORIGIN}/icon`, { waitUntil: "load" });
    await page.locator("img").evaluate(image => (image as HTMLImageElement).decode());
    assertCondition(refused.length === 0, `${icon.source}: refused request to ${[...new Set(refused)].join(", ")}`);
    await page.screenshot({
      path: join(REPOSITORY_ROOT, icon.output),
      fullPage: false,
      omitBackground: icon.fill === undefined,
      animations: "disabled",
      scale: "device",
    });
    return await recordOutput(icon.source, icon.output, icon.size, icon.size);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const rendered: Record<string, ArtworkRecord> = {};
  try {
    for (const artwork of ARTWORK) rendered[artwork.output] = await renderArtwork(browser, artwork);
    for (const icon of ICONS) rendered[icon.output] = await renderIcon(browser, icon);
  } finally {
    await browser.close();
  }
  const manifest: ArtworkManifest = { generatedBy: "bun run media:brand", artwork: rendered };
  await writeFile(join(REPOSITORY_ROOT, ARTWORK_MANIFEST), jsonWithFinalNewline(manifest));
}

if (import.meta.main) await main();
