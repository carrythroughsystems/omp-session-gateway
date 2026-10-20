import { PAGE_PRELUDE } from "./android-leak-probe.ts";

/** The page surface the journeys drive: Chrome DevTools on the Pixel, W3C WebDriver on cloud devices. */
export interface JourneyPage {
  navigate(url: string): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
}

export const APP_ASSET_PATTERN = /^\/assets\/app\.[0-9a-f]+\.js$/u;

/**
 * The device journey's View assertion. The browser e2e evaluates this same expression against the
 * built client, so a client refresh that changes its read-only surface fails CI rather than a device
 * lane (OMP 18.4.2 capitalized the placeholder and only a Pixel run noticed).
 */
export const JOURNEY_VIEW_STATE = `(() => {
  const editor = document.querySelector(".sh-composer-input");
  const control = document.querySelector(".shell-control");
  return {
    readOnly: editor instanceof HTMLTextAreaElement && editor.disabled && editor.placeholder === "Read-only session — watching only",
    controlVisible: control instanceof HTMLButtonElement && !control.hidden,
    rootMounted: document.querySelector("#root[role=application]") !== null,
  };
})()`;

export interface CollaborationJourneyOptions {
  readonly origin: string;
  readonly label: string;
  /** Distinctive text the Control prompt sends; its echo proves acceptance. */
  readonly promptMarker: string;
  readonly expectedAppAsset?: string;
  /** Receives the journey stages in order. */
  readonly announce?: (stage: "installed shell" | "directory" | "View" | "Control" | "prompt" | "directory return") => void;
}

export interface CollaborationJourneyResult {
  /** The trusted expected asset, only when supplied; never page-controlled result text. */
  readonly appAsset?: string;
  readonly viewReadOnly: true;
  readonly controlWritable: true;
  readonly promptAccepted: true;
  readonly returnedToDirectory: true;
}

/**
 * True once the controlling worker is the settled one whose only shell cache holds this document's
 * app bundle, and that bundle is the expected release bundle when one is given. The first visit
 * after a gateway upgrade installs and activates the new shell, and the page then reloads itself if
 * it is idle (ADR-018); driving View/Control before that settles races the reload.
 */
function currentShellExpression(expectedAppAsset: string | undefined): string {
  return `(async () => {
  const expected = ${JSON.stringify(expectedAppAsset ?? null)};
  const registration = await navigator.serviceWorker.getRegistration("/");
  const controller = navigator.serviceWorker.controller;
  if (registration?.active?.state !== "activated" || registration.installing !== null || registration.waiting !== null) return false;
  if (controller === null || controller.state !== "activated") return false;
  const asset = performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname).find(path => /^\\/assets\\/app\\.[0-9a-f]+\\.js$/.test(path));
  if (asset === undefined || (expected !== null && asset !== expected)) return false;
  const shells = (await caches.keys()).filter(name => name.startsWith("omp-sessions-shell-"));
  return shells.length === 1 && (await (await caches.open(shells[0])).match(asset)) !== undefined;
})()`;
}

/** Names the first unmet readiness condition; "ready-late" means it held by the time of this read. */
function shellDiagnosticExpression(expectedAppAsset: string | undefined): string {
  return `(async () => {
  try {
    const expected = ${JSON.stringify(expectedAppAsset ?? null)};
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (registration === undefined) return "no-registration";
    if (registration.installing !== null) return "sw-installing";
    if (registration.waiting !== null) return "sw-waiting";
    if (registration.active?.state !== "activated") return "sw-not-active";
    const controller = navigator.serviceWorker.controller;
    if (controller === null) return "uncontrolled";
    if (controller.state !== "activated") return "controller-not-active";
    const asset = performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname).find(path => /^\\/assets\\/app\\.[0-9a-f]+\\.js$/.test(path));
    if (asset === undefined) return "no-app-asset";
    if (expected !== null && asset !== expected) return "asset-mismatch";
    const shells = (await caches.keys()).filter(name => name.startsWith("omp-sessions-shell-"));
    if (shells.length !== 1) return "shell-caches:" + shells.length;
    if ((await (await caches.open(shells[0])).match(asset)) === undefined) return "asset-not-cached";
    return "ready-late";
  } catch { return "evaluation-error"; }
})()`;
}

async function pause(milliseconds: number): Promise<void> {
  const paused = Promise.withResolvers<void>();
  setTimeout(paused.resolve, milliseconds);
  await paused.promise;
}

/** Starts by navigating to `${origin}/`; the caller owns tab/session setup. */
export async function runCollaborationJourney(
  page: JourneyPage,
  options: CollaborationJourneyOptions,
): Promise<CollaborationJourneyResult> {
    await page.navigate(`${options.origin}/`);

    let failedReads = 0;
    const waitFor = async (name: string, expression: string, attempts = 60): Promise<void> => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await page.evaluate<boolean>(expression).catch(() => { failedReads += 1; return false; })) return;
        await pause(500);
      }
      throw new Error(`${name} did not become ready`);
    };

    options.announce?.("installed shell");
    try { await waitFor("installed application shell", currentShellExpression(options.expectedAppAsset), 120); }
    catch {
      const diagnostic = await page.evaluate<unknown>(shellDiagnosticExpression(options.expectedAppAsset)).catch(() => "evaluation-error");
      const code = typeof diagnostic === "string" &&
        /^(?:no-registration|sw-installing|sw-waiting|sw-not-active|uncontrolled|controller-not-active|no-app-asset|asset-mismatch|asset-not-cached|ready-late|evaluation-error|shell-caches:(?:0|[1-9][0-9]{0,9}))$/u.test(diagnostic)
        ? diagnostic : "evaluation-error";
      // Failed reads separate a page whose state never settled from evaluations that kept failing.
      throw new Error(`installed application shell did not become ready (${code}; ${failedReads} of 120 reads failed)`);
    }
    // Start from a document the settled worker controlled from load, so no update reload can follow.
    await page.navigate(`${options.origin}/`);

    options.announce?.("directory");
    const quotedLabel = JSON.stringify(options.label);
    await waitFor(
      "directory target",
      `Boolean([...document.querySelectorAll("button[aria-label]")].find(button => button.getAttribute("aria-label") === "View " + ${quotedLabel}))`,
    );

    const appAssetMatched = await page.evaluate<boolean>(`(() => {
      const expected = ${JSON.stringify(options.expectedAppAsset ?? null)};
      const asset = performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname).find(path => /^\\/assets\\/app\\.[0-9a-f]+\\.js$/.test(path));
      return typeof asset === "string" && (expected === null || asset === expected);
    })()`);
    if (appAssetMatched !== true) throw new Error(options.expectedAppAsset === undefined ? "hashed app asset was not loaded" : "installed app asset does not match the release archive");

    options.announce?.("View");
    const openedView = await page.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll("button[aria-label]")].find(
        candidate => candidate.getAttribute("aria-label") === "View " + ${quotedLabel},
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (!openedView) throw new Error("View action was unavailable");

    await waitFor(
      "View collaboration shell",
      `location.pathname === "/client/" && document.querySelector(".conn-chip")?.dataset.state === "connected" && document.querySelector(".sh-composer-input") instanceof HTMLTextAreaElement`,
      120,
    );
    const view = await page.evaluate<{ readOnly: boolean; controlVisible: boolean; rootMounted: boolean }>(JOURNEY_VIEW_STATE);
    if (!view.readOnly || !view.controlVisible || !view.rootMounted) throw new Error("View did not remain read-only");

    options.announce?.("Control");
    const upgraded = await page.evaluate<boolean>(`(() => {
      const control = document.querySelector(".shell-control");
      if (!(control instanceof HTMLButtonElement) || control.hidden) return false;
      control.click();
      return true;
    })()`);
    if (!upgraded) throw new Error("Control upgrade action was unavailable");

    await waitFor(
      "Control collaboration shell",
      `document.querySelector(".conn-chip")?.dataset.state === "connected" && document.querySelector(".shell-control")?.hidden === true && document.querySelector(".sh-composer-input") instanceof HTMLTextAreaElement && !document.querySelector(".sh-composer-input").disabled`,
      120,
    );
    const control = await page.evaluate<{ writable: boolean; sendInitiallyDisabled: boolean }>(`(() => {
      const editor = document.querySelector(".sh-composer-input");
      const send = document.querySelector('button[title="send (Enter)"]');
      return {
        writable: editor instanceof HTMLTextAreaElement && !editor.disabled && editor.placeholder === "prompt the host agent…",
        sendInitiallyDisabled: send instanceof HTMLButtonElement && send.disabled,
      };
    })()`);
    if (!control.writable || !control.sendInitiallyDisabled) throw new Error("Control composer was not writable");

    options.announce?.("prompt");
    const drafted = await page.evaluate<boolean>(`(() => {
      const editor = document.querySelector(".sh-composer-input");
      if (!(editor instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(editor, ${JSON.stringify(options.promptMarker)});
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!drafted) throw new Error("Control prompt could not be drafted");
    await waitFor("Control send", `document.querySelector('button[title="send (Enter)"]')?.disabled === false`);
    const sent = await page.evaluate<boolean>(`(() => {
      const send = document.querySelector('button[title="send (Enter)"]');
      if (!(send instanceof HTMLButtonElement) || send.disabled) return false;
      send.click();
      return true;
    })()`);
    if (!sent) throw new Error("Control prompt could not be sent");
    await waitFor("Control prompt acceptance", `document.body.innerText.includes(${JSON.stringify(options.promptMarker)})`, 60);

    await page.evaluate(`(() => {
      const stop = document.querySelector(".sh-btn-stop");
      if (stop instanceof HTMLButtonElement && !stop.disabled) stop.click();
    })()`);

    options.announce?.("directory return");
    const returned = await page.evaluate<boolean>(`(() => {
      const back = document.querySelector(".shell-back");
      if (!(back instanceof HTMLButtonElement)) return false;
      back.click();
      return true;
    })()`);
    if (!returned) throw new Error("Sessions return action was unavailable");
    await waitFor(
      "directory return",
      `location.pathname === "/" && Boolean([...document.querySelectorAll("button[aria-label]")].find(button => button.getAttribute("aria-label") === "View " + ${quotedLabel}))`,
    );

    return {
      ...(options.expectedAppAsset === undefined ? {} : { appAsset: options.expectedAppAsset }),
      viewReadOnly: true,
      controlWritable: true,
      promptAccepted: true,
      returnedToDirectory: true,
    };
}

/** Sinks the sweep inspects. The control must be able to plant and detect every one. */
export const LEAK_SINKS = [
  "localStorage",
  "sessionStorage",
  "cookie",
  "cacheBody",
  "indexedDB",
  "locationHash",
  "historyState",
] as const;

export interface LeakControlResult {
  readonly plantedUnique: readonly string[];
  readonly detectedUnique: readonly string[];
  readonly residual: Record<string, unknown>;
}

export interface LeakSweepResult {
  readonly target?: Record<string, unknown>;
  readonly launchStatus?: number;
  readonly launchCacheControl?: string | null;
  readonly launchNoStore?: boolean;
  readonly launchKeys?: readonly string[];
  readonly capabilityLength?: number;
  readonly capabilityDigest?: string;
  readonly needleCount?: number;
  /** With `detail`: the names themselves. Without it: only how many there are. */
  readonly cacheNames?: readonly string[];
  readonly indexedDbNames?: readonly string[];
  readonly cacheCount?: number;
  readonly indexedDbCount?: number;
  readonly locationHref?: string;
  readonly locationHashLength?: number;
  readonly findings?: readonly string[];
  readonly findingCount?: number;
  readonly error?: string;
  readonly seen?: readonly string[];
}

/** Self-contained page expression that plants, detects and removes the synthetic control secret. */
function leakControlExpression(detail: boolean): string {
  return `(async () => {
    ${PAGE_PRELUDE}
    const NEEDLE = "SYNTHETIC-CAPABILITY-CONTROL-b7f3a91c2d8e4056";
    const CONTROL_KEY = "__leak_control__";
    const hit = value => typeof value === "string" && value.includes(NEEDLE);
    const planted = [];
    const detected = [];

    localStorage.setItem(CONTROL_KEY, NEEDLE); planted.push("localStorage");
    sessionStorage.setItem(CONTROL_KEY, NEEDLE); planted.push("sessionStorage");
    document.cookie = CONTROL_KEY + "=" + NEEDLE + "; path=/"; planted.push("cookie");
    const controlCache = await caches.open(CONTROL_KEY);
    await controlCache.put(new Request("/" + CONTROL_KEY), new Response(NEEDLE));
    planted.push("cacheBody");
    const db = await openDb(CONTROL_KEY, 1, handle => handle.createObjectStore("s"));
    const writing = Promise.withResolvers();
    const tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put(NEEDLE, "k");
    tx.oncomplete = () => writing.resolve(undefined);
    tx.onerror = () => writing.reject(tx.error);
    await writing.promise;
    planted.push("indexedDB");
    history.replaceState({ control: NEEDLE }, "", location.pathname + "#" + NEEDLE);
    planted.push("locationHash", "historyState");

    await scanSinks(hit, sink => detected.push(sink));

    localStorage.removeItem(CONTROL_KEY);
    sessionStorage.removeItem(CONTROL_KEY);
    document.cookie = CONTROL_KEY + "=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    await caches.delete(CONTROL_KEY);
    db.close();
    indexedDB.deleteDatabase(CONTROL_KEY);
    history.replaceState(null, "", location.pathname);

    const residual = {
      localStorage: localStorage.getItem(CONTROL_KEY),
      sessionStorage: sessionStorage.getItem(CONTROL_KEY),
      cookie: document.cookie.includes(CONTROL_KEY),
      hash: location.hash,
      caches: await caches.keys(),
    };
    ${detail ? `return {
      plantedUnique: [...new Set(planted)].sort(),
      detectedUnique: [...new Set(detected)].sort(),
      residual,
    };` : `const sinks = ${JSON.stringify(LEAK_SINKS)};
    return {
      complete: planted.length === sinks.length,
      detected: sinks.filter(sink => detected.includes(sink)),
      missedCount: sinks.filter(sink => !detected.includes(sink)).length,
      residualCount: Number(residual.localStorage !== null) + Number(residual.sessionStorage !== null) +
        Number(residual.cookie) + Number(residual.hash !== "") + Number(residual.caches.includes(CONTROL_KEY)),
    };`}
  })()`;
}

export const LEAK_CONTROL_EXPRESSION = leakControlExpression(true);

export interface VendorLeakControlResult {
  readonly complete: boolean;
  readonly detected: readonly (typeof LEAK_SINKS)[number][];
  readonly missedCount: number;
  readonly residualCount: number;
}

/** Vendor-safe control: even residual failure branches return only booleans, counts and sink names. */
export function vendorLeakControlExpression(): string {
  return leakControlExpression(false);
}

/** Sinks the control missed and control plants it left behind. */
export function leakControlGaps(control: LeakControlResult): {
  readonly missed: readonly string[];
  readonly residualPlants: readonly (readonly [string, unknown])[];
} {
  const missed = LEAK_SINKS.filter(sink => !control.detectedUnique.includes(sink));
  const residualPlants = Object.entries(control.residual).filter(
    ([key, value]) => (key === "cookie" && value === true) || (key === "hash" && value !== "") || (key !== "cookie" && key !== "hash" && key !== "caches" && value !== null),
  );
  return { missed, residualPlants };
}

/**
 * Launches View in-page and scans every sink. `detail: true` also returns the capability's length,
 * a truncated digest, the needle count, the matched sink details, the cache and database names, and
 * the address, for an operator's own terminal. `detail: false` returns sink names and counts only,
 * for a driver whose command log a vendor keeps: any page-controlled text could hold part of the link.
 */
export function leakSweepExpression(label: string, options: { readonly detail: boolean }): string {
  return `(async () => {
    ${PAGE_PRELUDE}
    const out = {};
    const list = await (await fetch("/api/v1/sessions", { cache: "no-store" })).json();
    const target = list.sessions.find(session => session.cwdLabel === ${JSON.stringify(label)});
    if (!target) return ${options.detail ? '{ error: "target session not published", seen: list.sessions.map(s => s.cwdLabel) }' : '{ error: "target-not-published" }'};
${options.detail ? "    out.target = { generation: target.generation, canView: target.canView, canControl: target.canControl };" : ""}

    const response = await fetch("/api/v1/sessions/" + target.instanceId + "/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ generation: target.generation, mode: "view" }),
    });
    out.launchStatus = response.status;
${options.detail ? '    out.launchCacheControl = response.headers.get("cache-control");' : '    out.launchNoStore = response.headers.get("cache-control")?.split(",").some(value => value.trim().toLowerCase() === "no-store") === true;'}
    if (!response.ok) return { ...out, error: "launch-rejected" };

    const payload = await response.json();
${options.detail ? "    out.launchKeys = Object.keys(payload).sort();" : ""}
    const capability = payload.capability;
    if (typeof capability !== "string") return { ...out, error: "invalid-launch-payload" };

${options.detail ? "    out.capabilityLength = capability.length;\n    const digest = await crypto.subtle.digest(\"SHA-256\", new TextEncoder().encode(capability));\n    out.capabilityDigest = [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, \"0\")).join(\"\");" : ""}

    // The whole value, plus every opaque segment long enough to be the secret itself.
    const needles = [capability];
    for (const part of capability.split(/[\\/?#&=]/)) if (part.length >= 16) needles.push(part);
${options.detail ? "    out.needleCount = needles.length;" : ""}

    const hit = value => typeof value === "string" && needles.some(needle => value.includes(needle));
    const findings = [];
    await scanSinks(hit, (sink, detail) => findings.push(${options.detail ? 'detail ? sink + ": " + detail : sink' : "sink"}));

    const cacheNames = await caches.keys();
    const indexedDbNames = ((await indexedDB.databases?.()) ?? []).map(entry => entry.name);
${options.detail ? "    out.cacheNames = cacheNames;\n    out.indexedDbNames = indexedDbNames;" : "    out.cacheCount = cacheNames.length;\n    out.indexedDbCount = indexedDbNames.length;"}
${options.detail ? "    out.locationHref = location.href;\n    out.locationHashLength = location.hash.length;" : ""}
    out.findingCount = findings.length;
    out.findings = ${options.detail ? "findings" : `${JSON.stringify(LEAK_SINKS)}.filter(sink => findings.map(name => name === "cacheName" || name === "cacheKey" ? "cacheBody" : name === "indexedDbName" ? "indexedDB" : name).includes(sink))`};
    return out;
  })()`;
}
