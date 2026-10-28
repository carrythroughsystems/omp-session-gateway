import { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { startDashboardFixture } from "../../apps/web/e2e/fixture-server.ts";
import {
  FIXED_NOW,
  GATEWAY_WAITING,
  GATEWAY_WORKING,
  INITIAL_SESSIONS,
  RELEASE_WAITING,
  installSyntheticProductFixture,
} from "../../apps/web/e2e/synthetic-product-fixture.ts";
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
  MEDIA_DIRECTORY,
  MEDIA_DIRECTORY_NAMES,
  PNG_DIMENSIONS,
  POSTER_FRAME_INDEX,
  REPOSITORY_ROOT,
  assertCondition,
  jsonWithFinalNewline,
  normalizedVersion,
  parseGif,
  parsePng,
  parseRate,
  parseTopLevelMp4Atoms,
  probeMedia,
  runProcess,
  sha256Bytes,
  sha256File,
  type BinaryMediaName,
  type CompositeInput,
  type MediaAssetManifestRecord,
  type MediaManifest,
} from "./readme-media-contract.ts";
import {
  createDemoCompositorHtml,
  createFlowCompositorHtml,
} from "./readme-media-compositor.ts";

const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const ANDROID_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";

const PUBLIC_SCREEN_LABELS: Readonly<Record<string, true>> = {
  "Gateway auth hardening": true,
  "Release qualification": true,
  "Android reconnect soak": true,
  "Docs & examples": true,
  "Upstream compatibility": true,
};

interface CapturePaths {
  readonly allClear: string;
  readonly discovered: string;
  readonly needsYou: string;
  readonly openRequest: string;
  readonly notificationSettings: string;
}

interface CaptureResult {
  readonly tapPoint: {
    readonly xFraction: number;
    readonly yFraction: number;
  };
  readonly unexpectedRequests: number;
}

interface ToolVersions {
  readonly bun: string;
  readonly typescript: string;
  readonly playwright: string;
  readonly chromium: string;
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

async function waitForExactText(page: Page, selector: string, expected: string): Promise<void> {
  try {
    await page.locator(selector).waitFor({ state: "visible" });
    await page.waitForFunction(
      ({ selector: query, expected: value }) => document.querySelector(query)?.textContent?.trim() === value,
      { selector, expected },
    );
  } catch (cause) {
    const observed = await page.locator(selector).evaluateAll(elements =>
      elements.map(element => ({
        text: (element.textContent ?? "").trim().slice(0, 240),
        hidden: (element as HTMLElement).hidden,
        display: getComputedStyle(element).display,
        state: (element as HTMLElement).dataset.state ?? (element as HTMLElement).dataset.kind ?? null,
      })),
    );
    throw new Error(
      `waitForExactText timed out: selector=${selector} expected=${JSON.stringify(expected)} observed=${JSON.stringify(observed)}`,
      { cause },
    );
  }
}

async function waitForCount(page: Page, selector: string, expected: number): Promise<void> {
  await page.waitForFunction(
    ({ selector: query, expected: value }) => document.querySelectorAll(query).length === value,
    { selector, expected },
  );
}

async function assertProductSurface(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const geometry = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    activeTag: document.activeElement?.tagName ?? "",
  }));
  assertCondition(
    geometry.viewportWidth === MOBILE_VIEWPORT.width && geometry.viewportHeight === MOBILE_VIEWPORT.height,
    "capture viewport changed from the canonical mobile size",
  );
  assertCondition(geometry.scrollWidth <= geometry.viewportWidth, "product surface has horizontal overflow");
  assertCondition(!["BUTTON", "INPUT", "A"].includes(geometry.activeTag), "interactive control remained focused at capture");

  const visibleText = await page.locator("body").innerText();
  const safetyLabels = new Set<string>();
  for (const finding of findCapabilityLeaks(visibleText)) safetyLabels.add(finding.label);
  for (const finding of findIdentifierLeaks(visibleText)) safetyLabels.add(finding.label);
  if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(visibleText)) safetyLabels.add("email address");
  if (/\b(?:https?|wss?):\/\//iu.test(visibleText)) safetyLabels.add("visible URL");
  if (/media-request-|canonical-media|push\.example\.test/iu.test(visibleText)) safetyLabels.add("fixture identifier");
  assertCondition(
    safetyLabels.size === 0,
    `visible product text failed public-safety gate (${[...safetyLabels].sort().join(", ")})`,
  );

  const productLabels = await page
    .locator(".row-title, .queue-hero h2, .shell-title")
    .allTextContents();
  for (const label of productLabels.map(value => value.trim()).filter(Boolean)) {
    assertCondition(PUBLIC_SCREEN_LABELS[label] === true, "product surface contains a non-canonical session label");
  }
}

async function captureProductPng(page: Page, path: string): Promise<void> {
  await assertProductSurface(page);
  await page.screenshot({
    path,
    fullPage: false,
    animations: "disabled",
    caret: "hide",
    scale: "device",
  });
  const info = parsePng(await readFile(path));
  assertCondition(info.width === 780 && info.height === 1688, "browser capture is not 390x844 at DPR 2");
  for (const chunk of info.chunks) {
    assertCondition(FORBIDDEN_PNG_CHUNKS[chunk] !== true, `browser capture contains forbidden PNG ${chunk} metadata`);
  }
}

async function captureRuntimeScreens(browser: Browser, paths: CapturePaths): Promise<CaptureResult> {
  const roomKey = randomBytes(32);
  const fixture = await startDashboardFixture(INITIAL_SESSIONS, { roomKey });
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "allow",
    userAgent: ANDROID_USER_AGENT,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  let unexpectedRequests = 0;
  await installSyntheticProductFixture(context, roomKey);
  await context.route("**/*", async route => {
    const requestUrl = route.request().url();
    if (requestUrl === fixture.origin || requestUrl.startsWith(`${fixture.origin}/`)) {
      await route.continue();
      return;
    }
    unexpectedRequests += 1;
    await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);

  try {
    await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    await page.locator(".all-clear-summary").waitFor({ state: "visible" });
    await waitForCount(page, ".working-row", 4);
    await page.locator(".alerts-hint").waitFor({ state: "visible" });

    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#settings").click();
    await page.locator("#tray").waitFor({ state: "visible" });
    await page.locator('#notify[data-state="idle"]').waitFor({ state: "visible" });
    await page.locator("#notify").click();
    await page.locator('#notify[data-state="enabled"]').waitFor({ state: "visible" });
    await page.locator("#tray .tray-leading").click();
    await page.locator("#tray").waitFor({ state: "hidden" });
    // Enabling the subscription removes the resting surface's enable-alerts hint.
    await waitForCount(page, ".alerts-hint", 0);
    await captureProductPng(page, paths.allClear);

    fixture.upsert(GATEWAY_WORKING);
    await waitForCount(page, ".working-row", 5);
    await waitForExactText(
      page,
      '.working-row[data-instance-id="media-gateway-auth-0001"] .row-title',
      "Gateway auth hardening",
    );
    await captureProductPng(page, paths.discovered);

    fixture.upsert(GATEWAY_WAITING);
    fixture.upsert(RELEASE_WAITING);
    await waitForExactText(page, ".queue-hero h2", "Gateway auth hardening");
    await page.locator(".queue-hero .ask-preview").filter({ hasText: "How should ADR-0036 proceed?" }).waitFor({ state: "visible" });
    await page.locator(".action-request").waitFor({ state: "visible" });
    await waitForCount(page, ".hero-options", 1);
    await waitForExactText(page, ".queue-row .row-title", "Release qualification");
    await waitForCount(page, ".queue-row", 1);
    await waitForCount(page, ".working-row", 3);
    const targetHeights = await page
      .locator(".action-request, .hero-options, .queue-row, .working-row")
      .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assertCondition(targetHeights.every(height => height >= 44), "captured directory has a sub-44px action target");
    const actionBox = await page.locator(".action-request").boundingBox();
    assertCondition(actionBox !== null, "Open request has no capture geometry");
    const tapPoint = {
      xFraction: (actionBox.x + actionBox.width / 2) / MOBILE_VIEWPORT.width,
      yFraction: (actionBox.y + actionBox.height / 2) / MOBILE_VIEWPORT.height,
    };
    assertCondition(
      tapPoint.xFraction > 0 && tapPoint.xFraction < 1 && tapPoint.yFraction > 0 && tapPoint.yFraction < 1,
      "Open request center falls outside the captured viewport",
    );
    await captureProductPng(page, paths.needsYou);

    await page.locator(".action-request").click();
    await page.waitForFunction(() => location.pathname === "/" && document.querySelector('#tray[data-layout="expanded"]') !== null && location.search === "" && location.hash === "");
    await page.waitForFunction(() => document.querySelector('.conn-chip[data-state="connected"][data-compact="true"]'));
    await waitForCount(page, ".gateway-shell", 1);
    await waitForCount(page, ".sh-header, .sh-rail, .sh-rail-backdrop", 0);
    await waitForCount(page, ".sh-composer-ask-embedded", 1);
    await page.locator(".sh-ask-kicker").waitFor({ state: "visible" });
    await waitForCount(page, ".sh-ask-option", 2);
    await waitForCount(page, ".sh-ask-option-recommended", 1);
    await page.locator(".sh-ask-send:enabled").waitFor({ state: "visible" });
    const selectedClasses = await page.locator(".sh-ask-option").first().getAttribute("class");
    assertCondition(selectedClasses?.includes("sh-ask-option-checked") === true, "recommended ask option is not selected");
    // An open pending request offers couch triage: the hold bar is part of the product surface.
    await page.locator('.triage-bar[data-kind="hold"]').waitFor({ state: "visible" });
    await page.locator(".triage-action").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector(".sh-ask-option-label")?.textContent?.includes("Implement ADR-0036 locally"));
    await page.waitForFunction(() => document.querySelectorAll(".sh-ask-option-label")[1]?.textContent?.includes("Wait for upstream"));
    await page.waitForFunction(() => document.querySelector(".gateway-shell")?.scrollWidth! <= window.innerWidth);
    await page.waitForFunction(() => document.querySelector(".sh-composer-ask-embedded")?.getBoundingClientRect().bottom! <= window.innerHeight);
    await page.waitForTimeout(150);
    assertCondition(fixture.launchRequests.length === 1, "capture did not produce exactly one launch request");
    const launch = fixture.launchRequests[0];
    assertCondition(
      launch?.instanceId === "media-gateway-auth-0001" &&
        launch.generation === 1 &&
        launch.mode === "control" &&
        launch.requestId === "media-request-auth-0001",
      "capture launch metadata does not match the canonical Control request",
    );
    await captureProductPng(page, paths.openRequest);

    fixture.setSnapshot(INITIAL_SESSIONS);
    await page.locator("#tray .tray-leading").click();
    await page.locator(".all-clear-summary").waitFor({ state: "visible" });
    await waitForCount(page, ".working-row", 4);
    await page.locator("#settings").click();
    await page.locator("#tray").waitFor({ state: "visible" });
    await page.locator('#notify[data-state="enabled"]').waitFor({ state: "visible" });
    await page.locator("#alert-detail").click();
    await page.locator("#notification-detail-options").waitFor({ state: "visible" });
    assertCondition(
      await page.locator('input[name="notification-detail"][value="session"]').isChecked(),
      "Session notification detail is not the real default",
    );
    await page.locator(".sheet-footnote").waitFor({ state: "visible" });
    await page.locator(".detail-warning").waitFor({ state: "visible" });
    const detailTargetHeights = await page
      .locator(".detail-option, #tray .tray-leading")
      .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assertCondition(detailTargetHeights.every(height => height >= 48), "notification tray has a sub-48px action target");
    await captureProductPng(page, paths.notificationSettings);
    assertCondition(unexpectedRequests === 0, "runtime capture attempted an unexpected external request");
    return { tapPoint, unexpectedRequests };
  } finally {
    await context.close();
    await fixture.stop();
  }
}

function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function waitForEmbeddedImages(page: Page): Promise<void> {
  const states = await page.evaluate(async () => {
    await document.fonts.ready;
    return Promise.all([...document.images].map(async image => {
      let decoded = true;
      try {
        await image.decode();
      } catch {
        decoded = false;
      }
      return {
        id: image.id || null,
        screen: image.dataset.screen ?? null,
        decoded,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        sourceKind: image.currentSrc.startsWith("data:image/png")
          ? "embedded-png"
          : image.currentSrc.startsWith("data:image/svg+xml")
            ? "embedded-svg"
            : image.currentSrc === ""
              ? "empty"
              : "unexpected",
      };
    }));
  });
  assertCondition(
    states.every(state => state.decoded && state.complete && state.naturalWidth > 0),
    `compositor image decode failed: ${JSON.stringify(states)}`,
  );
}

async function renderComposites(
  browser: Browser,
  stagingRoot: string,
  paths: CapturePaths,
  tapPoint: CaptureResult["tapPoint"],
): Promise<number> {
  const framesDirectory = join(stagingRoot, "frames");
  await mkdir(framesDirectory);
  const [logo, allClear, discovered, needsYou, openRequest] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, "assets/logo.svg")),
    readFile(paths.allClear),
    readFile(paths.discovered),
    readFile(paths.needsYou),
    readFile(paths.openRequest),
  ]);
  const logoDataUrl = dataUrl("image/svg+xml", logo);
  const runtimeDataUrls = {
    allClear: dataUrl("image/png", allClear),
    discovered: dataUrl("image/png", discovered),
    needsYou: dataUrl("image/png", needsYou),
    openRequest: dataUrl("image/png", openRequest),
  };
  const context = await browser.newContext({
    viewport: { width: DEMO_WIDTH, height: DEMO_HEIGHT },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  let unexpectedRequests = 0;
  await context.route("**/*", async route => {
    unexpectedRequests += 1;
    await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);

  try {
    await page.setContent(
      createDemoCompositorHtml({ logoDataUrl, screens: runtimeDataUrls, tapPoint }),
      { waitUntil: "load" },
    );
    await waitForEmbeddedImages(page);
    for (let frame = 0; frame < DEMO_FRAME_COUNT; frame += 1) {
      await page.evaluate(index => {
        const render = (globalThis as typeof globalThis & { renderMediaFrame?: (frame: number) => void })
          .renderMediaFrame;
        if (render === undefined) throw new Error("compositor render function is missing");
        render(index);
      }, frame);
      await page.screenshot({
        path: join(framesDirectory, `frame-${String(frame).padStart(4, "0")}.png`),
        fullPage: false,
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
    }
    const firstFramePath = join(framesDirectory, "frame-0000.png");
    const lastFramePath = join(framesDirectory, "frame-0129.png");
    await copyFile(firstFramePath, lastFramePath);
    assertCondition(
      (await readFile(firstFramePath)).equals(await readFile(lastFramePath)),
      "canonical loop-frame normalization failed",
    );

    await copyFile(
      join(framesDirectory, `frame-${String(POSTER_FRAME_INDEX).padStart(4, "0")}.png`),
      join(stagingRoot, "omp-session-gateway-demo-poster.png"),
    );

    await page.setViewportSize({ width: 1600, height: 980 });
    await page.setContent(
      createFlowCompositorHtml({
        logoDataUrl,
        screens: {
          allClear: runtimeDataUrls.allClear,
          needsYou: runtimeDataUrls.needsYou,
          openRequest: runtimeDataUrls.openRequest,
        },
      }),
      { waitUntil: "load" },
    );
    await waitForEmbeddedImages(page);
    await page.screenshot({
      path: join(stagingRoot, "omp-session-gateway-product-flow.png"),
      fullPage: false,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
    assertCondition(unexpectedRequests === 0, "offline compositor attempted a network request");
    return unexpectedRequests;
  } finally {
    await context.close();
  }
}

async function encodeDemo(stagingRoot: string): Promise<void> {
  const inputPattern = join(stagingRoot, "frames/frame-%04d.png");
  const palettePath = join(stagingRoot, "palette.png");
  const gifPath = join(stagingRoot, "omp-session-gateway-demo.gif");
  const mp4Path = join(stagingRoot, "omp-session-gateway-demo.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-framerate",
    String(DEMO_FPS),
    "-start_number",
    "0",
    "-i",
    inputPattern,
    "-frames:v",
    String(DEMO_FRAME_COUNT),
    "-vf",
    "palettegen=max_colors=128:stats_mode=diff",
    "-map_metadata",
    "-1",
    palettePath,
  ]);
  await runProcess("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-framerate",
    String(DEMO_FPS),
    "-start_number",
    "0",
    "-i",
    inputPattern,
    "-i",
    palettePath,
    "-filter_complex",
    "[0:v]fps=10,scale=960:540:flags=lanczos[video];[video][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    "-frames:v",
    String(DEMO_FRAME_COUNT),
    "-loop",
    "0",
    "-map_metadata",
    "-1",
    gifPath,
  ]);
  await runProcess("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-framerate",
    String(DEMO_FPS),
    "-start_number",
    "0",
    "-i",
    inputPattern,
    "-frames:v",
    String(DEMO_FRAME_COUNT),
    "-an",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "18",
    "-preset",
    "slow",
    "-r",
    String(DEMO_FPS),
    "-g",
    "20",
    "-keyint_min",
    "20",
    "-sc_threshold",
    "0",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    mp4Path,
  ]);
}

async function collectToolVersions(browser: Browser): Promise<ToolVersions> {
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
    readonly devDependencies: Readonly<Record<string, string>>;
  };
  const browserVersion = browser.version();
  const chromiumMatch = /(\d+(?:\.\d+){1,3})$/u.exec(browserVersion);
  assertCondition(chromiumMatch !== null, "unable to normalize Playwright Chromium version");
  const [ffmpegOutput, ffprobeOutput] = await Promise.all([
    runProcess("ffmpeg", ["-version"]),
    runProcess("ffprobe", ["-version"]),
  ]);
  return {
    bun: Bun.version,
    typescript: packageJson.devDependencies.typescript ?? "unknown",
    playwright: packageJson.devDependencies["@playwright/test"] ?? "unknown",
    chromium: chromiumMatch[1] as string,
    ffmpeg: normalizedVersion(ffmpegOutput, "ffmpeg"),
    ffprobe: normalizedVersion(ffprobeOutput, "ffprobe"),
  };
}

function compositeInputs(
  logoHash: string,
  hashes: Readonly<Record<"allClear" | "discovered" | "needsYou" | "openRequest", string>>,
  names: readonly (keyof typeof hashes)[],
): readonly CompositeInput[] {
  const idByName: Readonly<Record<keyof typeof hashes, string>> = {
    allClear: "runtime:01-all-clear.png",
    discovered: "runtime:discovered-live-five",
    needsYou: "runtime:02-needs-you.png",
    openRequest: "runtime:03-open-request.png",
  };
  return [
    ...names.map(name => ({ id: idByName[name], sha256: hashes[name] })),
    { id: "brand:assets/logo.svg", sha256: logoHash },
  ];
}

async function assertDecodedGifLoop(gifPath: string): Promise<void> {
  const frameMd5 = await runProcess("ffmpeg", [
    "-v",
    "error",
    "-i",
    gifPath,
    "-map",
    "0:v:0",
    "-f",
    "framemd5",
    "-",
  ]);
  const hashes = frameMd5
    .split("\n")
    .filter(line => line !== "" && !line.startsWith("#"))
    .map(line => line.split(",").at(-1)?.trim() ?? "");
  assertCondition(hashes.length === DEMO_FRAME_COUNT, "decoded GIF frame count differs from the authored timeline");
  assertCondition(hashes[0] === hashes.at(-1), "decoded GIF first and last frames differ");
}

async function buildManifest(
  stagingRoot: string,
  paths: CapturePaths,
  toolVersions: ToolVersions,
  sourceRevision: string,
  runtimeUnexpectedRequests: number,
  compositorUnexpectedRequests: number,
): Promise<MediaManifest> {
  const upstream = JSON.parse(await readFile(join(REPOSITORY_ROOT, "packages/collab-client/upstream/UPSTREAM.json"), "utf8")) as {
    readonly tag: string;
    readonly commit: string;
    readonly packageVersion: string;
  };
  const upstreamClientVersion = upstream.packageVersion;
  assertCondition(upstreamClientVersion !== undefined, "pinned collab client version is missing");
  assertCondition(runtimeUnexpectedRequests === 0, "runtime network audit is not clean");
  assertCondition(compositorUnexpectedRequests === 0, "compositor network audit is not clean");
  const runtimeHashes = {
    allClear: await sha256File(paths.allClear),
    discovered: await sha256File(paths.discovered),
    needsYou: await sha256File(paths.needsYou),
    openRequest: await sha256File(paths.openRequest),
  };
  const logoHash = await sha256File(join(REPOSITORY_ROOT, "assets/logo.svg"));
  const allCompositeInputs = compositeInputs(
    logoHash,
    runtimeHashes,
    ["allClear", "discovered", "needsYou", "openRequest"],
  );
  const flowCompositeInputs = compositeInputs(
    logoHash,
    runtimeHashes,
    ["allClear", "needsYou", "openRequest"],
  );
  const posterCompositeInputs = compositeInputs(logoHash, runtimeHashes, ["needsYou"]);

  const pngRecord = async (
    name: Extract<BinaryMediaName, `${string}.png`>,
    provenance: MediaAssetManifestRecord["provenance"],
    inputs?: readonly CompositeInput[],
  ): Promise<MediaAssetManifestRecord> => {
    const path = join(stagingRoot, name);
    const [bytes, fileStat] = await Promise.all([readFile(path), stat(path)]);
    const info = parsePng(bytes);
    return {
      bytes: fileStat.size,
      sha256: sha256Bytes(bytes),
      width: info.width,
      height: info.height,
      provenance,
      ...(inputs === undefined ? {} : { compositeInputs: inputs }),
      ...(name === "omp-session-gateway-demo-poster.png" ? { sourceFrame: POSTER_FRAME_INDEX } : {}),
    };
  };

  const gifPath = join(stagingRoot, "omp-session-gateway-demo.gif");
  const gifBytes = await readFile(gifPath);
  const gifInfo = parseGif(gifBytes);
  const mp4Path = join(stagingRoot, "omp-session-gateway-demo.mp4");
  const [mp4Stat, mp4Hash, mp4Probe] = await Promise.all([
    stat(mp4Path),
    sha256File(mp4Path),
    probeMedia(mp4Path),
  ]);
  const videoStream = mp4Probe.streams?.find(stream => stream.codec_type === "video");
  assertCondition(videoStream !== undefined, "encoded MP4 has no video stream");
  const mp4Duration = Number(videoStream.duration ?? mp4Probe.format?.duration);
  const mp4FrameCount = Number(videoStream.nb_read_frames ?? videoStream.nb_frames);
  assertCondition(gifInfo.loopCount !== undefined, "encoded GIF loop count is missing");
  assertCondition(videoStream.width !== undefined && videoStream.height !== undefined, "encoded MP4 dimensions are missing");
  assertCondition(videoStream.codec_name !== undefined, "encoded MP4 codec is missing");
  assertCondition(videoStream.pix_fmt !== undefined, "encoded MP4 pixel format is missing");

  const assets: Record<BinaryMediaName, MediaAssetManifestRecord> = {
    "omp-session-gateway-demo.gif": {
      bytes: gifBytes.byteLength,
      sha256: sha256Bytes(gifBytes),
      width: gifInfo.width,
      height: gifInfo.height,
      provenance: "capture-only-presentation-composite",
      frameCount: gifInfo.frameCount,
      durationSeconds: gifInfo.durationSeconds,
      fps: gifInfo.frameCount / gifInfo.durationSeconds,
      loopCount: gifInfo.loopCount,
      compositeInputs: allCompositeInputs,
    },
    "omp-session-gateway-demo.mp4": {
      bytes: mp4Stat.size,
      sha256: mp4Hash,
      width: videoStream.width,
      height: videoStream.height,
      provenance: "capture-only-presentation-composite",
      frameCount: mp4FrameCount,
      durationSeconds: mp4Duration,
      fps: parseRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
      codec: videoStream.codec_name,
      pixelFormat: videoStream.pix_fmt,
      compositeInputs: allCompositeInputs,
    },
    "omp-session-gateway-demo-poster.png": await pngRecord(
      "omp-session-gateway-demo-poster.png",
      "capture-only-presentation-composite",
      posterCompositeInputs,
    ),
    "omp-session-gateway-product-flow.png": await pngRecord(
      "omp-session-gateway-product-flow.png",
      "capture-only-presentation-composite",
      flowCompositeInputs,
    ),
    "01-all-clear.png": await pngRecord("01-all-clear.png", "built-pwa-runtime"),
    "02-needs-you.png": await pngRecord("02-needs-you.png", "built-pwa-runtime"),
    "03-open-request.png": await pngRecord(
      "03-open-request.png",
      "built-pwa-runtime-with-pinned-collab-client",
    ),
    "04-notification-settings.png": await pngRecord(
      "04-notification-settings.png",
      "built-pwa-runtime",
    ),
  };

  return {
    schemaVersion: 1,
    sourceRevision,
    upstreamClient: {
      tag: upstream.tag,
      commit: upstream.commit,
      packageVersion: upstreamClientVersion,
    },
    generatedBy: {
      command: "bun run media:capture",
      ...toolVersions,
    },
    capture: {
      clock: FIXED_NOW,
      locale: "en-US",
      timezone: "UTC",
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewportCss: [390, 844],
      deviceScaleFactor: 2,
      runtimeNetworkPolicy: "same-origin-fixture-only",
      compositorNetworkPolicy: "offline-data-urls-only",
      unexpectedRuntimeRequests: 0,
      unexpectedCompositorRequests: 0,
    },
    assets,
  };
}

function provenanceReadme(manifest: MediaManifest): string {
  const tools = manifest.generatedBy;
  return `# Canonical README media

These files are deterministic public fixtures. Every session title, project label, request, and notification shown here is synthetic. Never replace them with a personal or production capture.

This is a synthetic product demonstration, not release-qualification evidence. Its source revision and browser-client provenance are recorded below. The notification toast is capture-only chrome, not a real system notification or proof of background Web Push delivery.

## Regenerate and verify

From the repository root after installing the locked dependencies:

\`\`\`sh
bun run media:capture
bun run media:check
\`\`\`

\`media:capture\` builds the actual PWA and pinned collaboration client before capture. It publishes the canonical set only after staging the complete package. \`media:check\` verifies the binaries, manifest, public-safety rules, and root README references; it does not regenerate media. Both use \`packages/collab-client/upstream/UPSTREAM.json\` for browser-client provenance, independently of the OMP host baseline.

Source revision: \`${manifest.sourceRevision}\`  
Pinned client: \`${manifest.upstreamClient.tag}\` / \`${manifest.upstreamClient.commit}\` (\`@oh-my-pi/collab-web\` ${manifest.upstreamClient.packageVersion})

Normalized tool versions:

- Bun ${tools.bun}
- TypeScript ${tools.typescript}
- Playwright ${tools.playwright}
- Chromium ${tools.chromium}
- FFmpeg ${tools.ffmpeg}
- ffprobe ${tools.ffprobe}

The synthetic clock is ${manifest.capture.clock}, with locale ${manifest.capture.locale}, timezone ${manifest.capture.timezone}, dark color scheme, and reduced motion. Mobile captures use a 390×844 CSS-pixel viewport at DPR 2, producing 780×1688 PNGs.

## Pixel provenance

| Files | Provenance |
| --- | --- |
| \`01-all-clear.png\`, \`02-needs-you.png\`, \`04-notification-settings.png\` | Raw viewport screenshots of the actual built PWA. No frame, caption, marker, toast, crop, or compositor pixels. |
| \`03-open-request.png\` | Raw viewport screenshot of gateway chrome containing the actual built, pinned OMP collaboration client and its synthetic encrypted ask. |
| GIF, MP4, poster, product-flow board | Offline presentation composites. The embedded phone screens are complete runtime screenshots; the surrounding grid, editorial copy, phone frame, arrows, one tap marker, and Android notification toast are capture-only chrome. |

The capture-only Android toast uses the strict product title “OMP session needs attention” and the default Session-detail body. It is not a product DOM element or a real system notification. The animation’s discovered fifth session comes from a real fixture SSE upsert, and the tap marker is derived from the runtime Open request button bounds.

Runtime requests are restricted to the same-origin loopback fixture. The compositor accepts no requests and embeds local images and the Gate mark as data URLs. The capture records no origin, port, capability, room key, endpoint, hostname, account, or filesystem path.

Security boundary: loopback-only gateway · memory-only capabilities · no transcript storage. Community project; not affiliated with OMP.

## Seeded state

The opening contains four live sessions: Release qualification, Android reconnect soak, and Upstream compatibility working, and Docs & examples idle. Gateway auth hardening then arrives as a fifth working session before becoming the oldest of two waiting asks; Release qualification is second. Open request launches Control for the synthetic “How should ADR-0036 proceed?” ask with two synthetic options.

The canonical directory contains only the eight binaries, this provenance file, and \`manifest.json\`. The [unposted launch-copy draft](../LAUNCH_COPY.md) lives outside the synthetic-media fixture directory. The checker rejects every unexpected file, including concepts and contact sheets.

When intentionally refreshing media for a changed PWA, pinned client, capture copy, spacing, typography, or responsive layout, regenerate the entire set and update its provenance together. A documentation-only refresh does not recapture or relabel historical assets. Do not hand-edit a binary or reuse a concept image from the desktop media pack.
`;
}

async function verifyStagedPackage(stagingRoot: string, manifest: MediaManifest): Promise<void> {
  assertCondition(manifest.sourceRevision.match(/^[0-9a-f]{40}$/u) !== null, "source revision is not a full commit hash");
  assertCondition(manifest.capture.unexpectedRuntimeRequests === 0, "runtime network gate is not clean");
  assertCondition(manifest.capture.unexpectedCompositorRequests === 0, "compositor network gate is not clean");

  for (const name of BINARY_MEDIA_NAMES) {
    const path = join(stagingRoot, name);
    const [fileStat, hash] = await Promise.all([stat(path), sha256File(path)]);
    const record = manifest.assets[name];
    assertCondition(fileStat.size === record.bytes, `${name} manifest byte size differs`);
    assertCondition(hash === record.sha256, `${name} manifest hash differs`);
    assertCondition(fileStat.size <= MAX_BYTES[name], `${name} exceeds its canonical size limit`);
  }

  for (const [name, dimensions] of Object.entries(PNG_DIMENSIONS)) {
    const bytes = await readFile(join(stagingRoot, name));
    const info = parsePng(bytes);
    assertCondition(info.width === dimensions[0] && info.height === dimensions[1], `${name} dimensions differ`);
    for (const chunk of info.chunks) {
      assertCondition(FORBIDDEN_PNG_CHUNKS[chunk] !== true, `${name} contains forbidden PNG ${chunk} metadata`);
    }
  }

  const gifPath = join(stagingRoot, "omp-session-gateway-demo.gif");
  const gifInfo = parseGif(await readFile(gifPath));
  assertCondition(gifInfo.width === DEMO_WIDTH && gifInfo.height === DEMO_HEIGHT, "GIF dimensions differ");
  assertCondition(gifInfo.frameCount === DEMO_FRAME_COUNT, "GIF frame count differs");
  assertCondition(Math.abs(gifInfo.durationSeconds - DEMO_DURATION_SECONDS) <= 0.1, "GIF duration differs");
  assertCondition(gifInfo.delaysCentiseconds.every(delay => delay === 10), "GIF frame delay differs from 100ms");
  assertCondition(gifInfo.loopCount === 0, "GIF is not configured for infinite looping");
  assertCondition(gifInfo.commentExtensions === 0, "GIF contains a comment extension");
  await assertDecodedGifLoop(gifPath);

  const mp4Path = join(stagingRoot, "omp-session-gateway-demo.mp4");
  const [mp4Bytes, mp4Probe] = await Promise.all([readFile(mp4Path), probeMedia(mp4Path)]);
  const atoms = parseTopLevelMp4Atoms(mp4Bytes);
  assertCondition(atoms.indexOf("moov") >= 0 && atoms.indexOf("moov") < atoms.indexOf("mdat"), "MP4 is not faststart");
  assertCondition(mp4Probe.streams?.length === 1, "MP4 must contain exactly one stream");
  const stream = mp4Probe.streams?.[0];
  assertCondition(stream?.codec_type === "video", "MP4 stream is not video");
  assertCondition(stream.codec_name === "h264", "MP4 codec is not H.264");
  assertCondition(stream.pix_fmt === "yuv420p", "MP4 pixel format is not yuv420p");
  assertCondition(stream.width === DEMO_WIDTH && stream.height === DEMO_HEIGHT, "MP4 dimensions differ");
  assertCondition(Number(stream.nb_read_frames ?? stream.nb_frames) === DEMO_FRAME_COUNT, "MP4 frame count differs");
  assertCondition(Math.abs(Number(stream.duration ?? mp4Probe.format?.duration) - DEMO_DURATION_SECONDS) <= 0.1, "MP4 duration differs");
  assertCondition(Math.abs(parseRate(stream.avg_frame_rate ?? stream.r_frame_rate) - DEMO_FPS) < 0.001, "MP4 rate differs");

  const poster = await readFile(join(stagingRoot, "omp-session-gateway-demo-poster.png"));
  const frame = await readFile(join(stagingRoot, `frames/frame-${String(POSTER_FRAME_INDEX).padStart(4, "0")}.png`));
  assertCondition(poster.equals(frame), "poster is not a byte copy of canonical frame 0060");

  const readme = provenanceReadme(manifest);
  const textFindings = [
    ...findCapabilityLeaks(readme).map(finding => finding.label),
    ...findIdentifierLeaks(readme).map(finding => finding.label),
  ];
  assertCondition(textFindings.length === 0, `provenance failed public-safety gate (${[...new Set(textFindings)].join(", ")})`);
  await writeFile(join(stagingRoot, "README.md"), readme);
  await writeFile(join(stagingRoot, "manifest.json"), jsonWithFinalNewline(manifest));

  if (manifest.assets["omp-session-gateway-demo.gif"].bytes > GIF_TARGET_BYTES) {
    console.warn("media:capture: GIF is below the hard cap but above the 3 MiB target");
  }
}

async function publishPackage(stagingRoot: string): Promise<void> {
  await mkdir(MEDIA_DIRECTORY, { recursive: true });
  const existing = await readdir(MEDIA_DIRECTORY);
  const allowedNames: Readonly<Record<string, true>> = Object.fromEntries(
    MEDIA_DIRECTORY_NAMES.map(name => [name, true]),
  );
  for (const name of existing) {
    assertCondition(allowedNames[name] === true, "docs/media contains a non-canonical file; refusing to delete it");
  }

  const publishOrder = [...BINARY_MEDIA_NAMES, "README.md", "manifest.json"] as const;
  for (const name of publishOrder) {
    const temporaryDestination = join(MEDIA_DIRECTORY, `.${name}.tmp`);
    await copyFile(join(stagingRoot, name), temporaryDestination);
    await rename(temporaryDestination, join(MEDIA_DIRECTORY, name));
  }
}

async function main(): Promise<void> {
  const stagingRoot = await mkdtemp(join(tmpdir(), "omp-session-gateway-media-"));
  const captureDirectory = join(stagingRoot, "runtime");
  await mkdir(captureDirectory);
  const paths: CapturePaths = {
    allClear: join(stagingRoot, "01-all-clear.png"),
    discovered: join(captureDirectory, "discovered-live-five.png"),
    needsYou: join(stagingRoot, "02-needs-you.png"),
    openRequest: join(stagingRoot, "03-open-request.png"),
    notificationSettings: join(stagingRoot, "04-notification-settings.png"),
  };

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const toolVersions = await collectToolVersions(browser);
    const capture = await captureRuntimeScreens(browser, paths);
    const compositorUnexpectedRequests = await renderComposites(
      browser,
      stagingRoot,
      paths,
      capture.tapPoint,
    );
    await encodeDemo(stagingRoot);
    const sourceRevision = (await runProcess("git", ["rev-parse", "HEAD"])).trim();
    const manifest = await buildManifest(
      stagingRoot,
      paths,
      toolVersions,
      sourceRevision,
      capture.unexpectedRequests,
      compositorUnexpectedRequests,
    );
    await verifyStagedPackage(stagingRoot, manifest);
    await publishPackage(stagingRoot);

    console.log("media:capture: published canonical media package");
    for (const name of BINARY_MEDIA_NAMES) {
      const record = manifest.assets[name];
      console.log(`  ${basename(name)} ${record.width}x${record.height} ${record.bytes} bytes ${record.sha256}`);
    }
  } finally {
    await browser?.close();
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
