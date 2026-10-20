import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import percySnapshot from "@percy/playwright";
import type { DashboardFixture } from "../e2e/fixture-server.ts";
import { findCapabilityLeaks } from "../../../scripts/capability-leak-rules.ts";
import { findIdentifierLeaks } from "../../../scripts/identifier-leak-rules.ts";

const requirePercy = createRequire(import.meta.resolve("@percy/cli"));
const serializerPath = requirePercy.resolve("@percy/dom");
const serializer = readFile(serializerPath, "utf8");
const requireSDK = createRequire(import.meta.resolve("@percy/playwright"));
const SAFETY_FAILURE = "visual safety: serialized upload rejected";

export interface SerializedSnapshot {
  readonly html: string;
  readonly resources: readonly { readonly url: string; readonly content: string; readonly mimetype: string }[];
  readonly warnings?: readonly string[];
}

export interface SnapshotOptions {
  widths: number[];
  minHeight: number;
  enableJavaScript: false;
  responsiveSnapshotCapture: false;
  discovery: { allowedHostnames: string[]; disableCache: true };
}

interface PercyWindow extends Window {
  PercyDOM: { serialize(options: SnapshotOptions): unknown };
}

export function snapshotOptions(width: number, height: number): SnapshotOptions {
  return {
    widths: [width],
    minHeight: height,
    enableJavaScript: false,
    responsiveSnapshotCapture: false,
    // The source is already at this width; no executable rendering or cross-host discovery.
    discovery: { allowedHostnames: ["127.0.0.1"], disableCache: true },
  };
}

function assertTextSafe(text: string, fixture: Pick<DashboardFixture, "assertNoCapabilityMaterial">): void {
  fixture.assertNoCapabilityMaterial(text);
  if (findCapabilityLeaks(text).length !== 0 || findIdentifierLeaks(text).length !== 0) {
    throw new Error(SAFETY_FAILURE);
  }
}

/** The exact CLI-log payload is a third-party sink too, including structured metadata. */
export function assertPercyLogsSafe(logs: unknown, fixture: Pick<DashboardFixture, "assertNoCapabilityMaterial">): void {
  try {
    const text = JSON.stringify(logs);
    if (typeof text !== "string") throw new Error();
    assertTextSafe(text, fixture);
  } catch {
    throw new Error("visual log audit: unsafe CLI logs");
  }
}

/** Check the exact serializer result, including hidden/form state, diagnostics and resource bytes. */
export function assertSerializedSnapshotSafe(
  value: unknown,
  fixture: Pick<DashboardFixture, "assertNoCapabilityMaterial">,
): asserts value is SerializedSnapshot {
  try {
    if (value === null || typeof value !== "object" ||
      !("html" in value) || typeof value.html !== "string" ||
      !("resources" in value) || !Array.isArray(value.resources)) throw new Error();
    assertTextSafe(JSON.stringify(value), fixture);
    assertTextSafe(value.html, fixture);
    if ("warnings" in value && (!Array.isArray(value.warnings) || value.warnings.length !== 0)) throw new Error();
    for (const resource of value.resources) {
      if (typeof resource.content !== "string" || typeof resource.url !== "string" || typeof resource.mimetype !== "string") {
        throw new Error();
      }
      const url = new URL(resource.url);
      if (!["127.0.0.1", "render.percy.local"].includes(url.hostname) || url.username || url.password ||
        !/^https?:$/u.test(url.protocol) || !url.pathname.startsWith("/__serialized__/")) throw new Error();
      assertTextSafe(resource.content, fixture);
      // Percy encodes non-text resources in base64. Scan decoded bytes too, including SVG/JSON.
      const bytes = Buffer.from(resource.content, resource.mimetype.includes("text") ? "utf8" : "base64");
      assertTextSafe(bytes.toString("utf8"), fixture);
    }
  } catch {
    // Never retain input, matches, scanner findings, serializer warnings, or an unsafe cause.
    throw new Error(SAFETY_FAILURE);
  }
}

async function assertResourceBoundary(page: Page, origin: string): Promise<void> {
  const safe = await page.evaluate(expectedOrigin => {
    if (document.querySelector("iframe, frame, object, embed, canvas, video, audio")) return false;
    const allowed = (value: string): boolean => {
      if (!value || value.startsWith("#")) return true;
      try {
        const url = new URL(value, document.baseURI);
        const path = decodeURIComponent(url.pathname);
        return url.origin === expectedOrigin && !url.search && !url.hash && !url.username && !url.password &&
          !path.split("/").includes("..") &&
          (/^\/(?:assets|client\/assets)\/[\w.-]+$/u.test(path) ||
            /^\u002f(?:icon(?:-\d+)?\.(?:png|svg)|apple-touch-icon-\d+\.png|manifest\.webmanifest)$/u.test(path));
      } catch { return false; }
    };
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (/^on/iu.test(attribute.name)) return false;
      }
      if (element.matches("script[src], img[src], source[src], link[href]")) {
        if (!allowed(element.getAttribute("src") ?? element.getAttribute("href") ?? "")) return false;
      }
      if (element.hasAttribute("srcset")) return false;
    }
    const styles = [...document.querySelectorAll("[style]")].map(element => element.getAttribute("style") ?? "");
    for (const sheet of document.styleSheets) {
      try { styles.push([...sheet.cssRules].map(rule => rule.cssText).join("\n")); }
      catch { return false; }
    }
    for (const style of styles) {
      for (const match of style.matchAll(/(?:url\(\s*|@import\s+)["']?([^\s"')]+)["']?\s*\)?/giu)) {
        if (!allowed(match[1] ?? "")) return false;
      }
    }
    return true;
  }, origin);
  if (!safe) throw new Error(SAFETY_FAILURE);
}

export async function validateSnapshot(
  page: Page,
  fixture: DashboardFixture,
  options: SnapshotOptions,
): Promise<SerializedSnapshot> {
  try {
    await assertResourceBoundary(page, fixture.origin);
    await page.evaluate(await serializer);
    const snapshot: unknown = await page.evaluate(opts => {
      // Injected from the installed, pinned @percy/dom package immediately before evaluation.
      const percyWindow = window as unknown as PercyWindow;
      return percyWindow.PercyDOM.serialize(opts);
    }, options);
    assertSerializedSnapshotSafe(snapshot, fixture);
    return snapshot;
  } catch {
    throw new Error(SAFETY_FAILURE);
  }
}

interface SDKResponse { body?: { success?: boolean } }
interface SDKUtils {
  request: { post: (path: string, data: Record<string, unknown>) => Promise<SDKResponse> };
  logger: { log: (namespace: string, level: string, message: unknown, ...rest: unknown[]) => unknown };
}

/**
 * The pinned SDK catches failures. Inspect its final POST in memory, fail on every SDK warning,
 * and suppress raw SDK diagnostics before they can be logged or forwarded to the Percy server.
 * The last-mile recheck also covers any DOM changes after the local preflight serialization.
 */
export async function submitSnapshot(
  page: Page,
  name: string,
  fixture: DashboardFixture,
  options: SnapshotOptions,
  snapshot: typeof percySnapshot = percySnapshot,
  sdk: SDKUtils = requireSDK("@percy/sdk-utils") as SDKUtils,
): Promise<void> {
  let accepted = 0;
  let reason = "";
  const originalPost = sdk.request.post;
  const originalLog = sdk.logger.log;
  sdk.logger.log = (_namespace, level, message) => {
    if (!reason) {
      if (/Percy is not running/iu.test(String(message))) reason = "sdk-offline";
      else if (level === "warn") reason = "sdk-warning";
      else if (level === "error") reason = "sdk-error";
    }
  };
  sdk.request.post = async (path, data) => {
    if (reason) throw new Error("visual upload: submission rejected");
    if (path !== "/percy/snapshot") {
      reason = "sdk-endpoint";
      throw new Error("visual upload: unexpected SDK request");
    }
    try {
      assertSerializedSnapshotSafe(data.domSnapshot, fixture);
      // Check the envelope as well as the DOM: names, URLs and metadata are upload surfaces too.
      assertTextSafe(JSON.stringify(data), fixture);
    } catch {
      reason = "guard-rejected";
      throw new Error("visual upload: submission rejected");
    }
    try {
      const response = await originalPost(path, data);
      if (response.body?.success !== true) throw new Error();
      accepted++;
      return response;
    } catch {
      reason = "server-rejected";
      throw new Error("visual upload: submission rejected");
    }
  };
  try {
    await snapshot(page, name, options);
    if (reason || accepted !== 1) {
      reason ||= accepted === 0 ? "sdk-no-submission" : "submission-count";
      throw new Error();
    }
  } catch {
    throw new Error(`visual upload: submission failed (${reason || "sdk-exception"})`);
  } finally {
    sdk.request.post = originalPost;
    sdk.logger.log = originalLog;
  }
}
