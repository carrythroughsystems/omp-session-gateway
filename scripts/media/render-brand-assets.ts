import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "@playwright/test";
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
  }>>;
}

/** Exported artwork renders from its committed HTML source; see the asset inventory in docs/BRANDING.md. */
const ARTWORK = [
  { source: "assets/banner.html", output: "assets/banner.png", width: 1280, height: 320, scale: 2 },
  { source: "assets/og.html", output: "assets/og.png", width: 1280, height: 640, scale: 1 },
] as const;

/** The artwork sources load their display faces from Google Fonts; no other request may leave the page. */
const FONT_HOSTS: Readonly<Record<string, true>> = { "fonts.googleapis.com": true, "fonts.gstatic.com": true };
const DISPLAY_FAMILIES = ["Space Grotesk", "JetBrains Mono"] as const;

async function renderArtwork(browser: Browser, artwork: (typeof ARTWORK)[number]): Promise<ArtworkManifest["artwork"][string]> {
  const context = await browser.newContext({
    viewport: { width: artwork.width, height: artwork.height },
    deviceScaleFactor: artwork.scale,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const unexpectedOrigins: string[] = [];
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.protocol === "file:" || FONT_HOSTS[url.hostname] === true) return route.continue();
    unexpectedOrigins.push(url.origin);
    return route.abort();
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(join(REPOSITORY_ROOT, artwork.source)).href, { waitUntil: "networkidle" });
    const loadedFamilies = await page.evaluate(async families => {
      await document.fonts.ready;
      const faces = [...document.fonts];
      return families.filter(family =>
        faces.some(face => face.family.replaceAll('"', "") === family && face.status === "loaded"),
      );
    }, [...DISPLAY_FAMILIES]);
    const missing = DISPLAY_FAMILIES.filter(family => !loadedFamilies.includes(family));
    assertCondition(missing.length === 0, `${artwork.source}: display faces did not load (${missing.join(", ")})`);
    assertCondition(
      unexpectedOrigins.length === 0,
      `${artwork.source}: unexpected request to ${[...new Set(unexpectedOrigins)].join(", ")}`,
    );

    const output = join(REPOSITORY_ROOT, artwork.output);
    await page.screenshot({ path: output, fullPage: false, animations: "disabled", scale: "device" });
    const info = parsePng(await readFile(output));
    assertCondition(
      info.width === artwork.width * artwork.scale && info.height === artwork.height * artwork.scale,
      `${artwork.output}: rendered ${info.width}x${info.height}, expected ${artwork.width * artwork.scale}x${artwork.height * artwork.scale}`,
    );
    for (const chunk of info.chunks) {
      assertCondition(FORBIDDEN_PNG_CHUNKS[chunk] !== true, `${artwork.output}: contains forbidden PNG ${chunk} metadata`);
    }
    console.log(`media:brand: ${artwork.output} ${info.width}x${info.height}`);
    return {
      source: artwork.source,
      sourceSha256: await sha256File(join(REPOSITORY_ROOT, artwork.source)),
      outputSha256: await sha256File(output),
      width: info.width,
      height: info.height,
    };
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const rendered: Record<string, ArtworkManifest["artwork"][string]> = {};
  try {
    for (const artwork of ARTWORK) {
      rendered[artwork.output] = await renderArtwork(browser, artwork);
    }
  } finally {
    await browser.close();
  }
  const manifest: ArtworkManifest = { generatedBy: "bun run media:brand", artwork: rendered };
  await writeFile(join(REPOSITORY_ROOT, ARTWORK_MANIFEST), jsonWithFinalNewline(manifest));
}

if (import.meta.main) await main();
