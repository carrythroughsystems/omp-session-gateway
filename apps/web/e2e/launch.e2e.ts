import { expect, test, type Page } from "@playwright/test";
import type { SessionMetadata } from "@omp-session-gateway/protocol";
import {
  installSilentWebSocket,
  relaySocketCount,
  startDashboardFixture,
} from "./fixture-server.ts";
import { JOURNEY_VIEW_STATE } from "../../../scripts/browser-journey.ts";

const SESSION_TITLE = "Implement seamless registry recovery across long-running upgraded OMP sessions";
// The ask fixture pins Math.random to 0.5, so the relay socket's jittered retry fires within half of
// its 30 s backoff cap. Each held reconnect doubles that delay; waiting for the bound keeps recovery
// assertions independent of how many attempts a slow runner accumulated before the relay returned.
const RELAY_RECOVERY_TIMEOUT_MS = 17_000;

function session(): SessionMetadata {
  return {
    instanceId: "standalone-launch-0001",
    generation: 1,
    title: SESSION_TITLE,
    cwdLabel: "project",
    model: "provider/model",
    startedAt: "2026-07-21T10:00:00.000Z",
    lastSeenAt: "2026-07-21T10:00:01.000Z",
    canView: true,
    canControl: true,
    inputRequired: true,
    ask: {
      requestId: "standalone-request-0001",
      since: "2026-07-21T10:00:01.000Z",
    },
  };
}

function answeredSession(
  source: SessionMetadata,
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  const answered = { ...source, ...overrides, inputRequired: false };
  delete answered.ask;
  return answered;
}

function workingSession(index: number): SessionMetadata {
  const id = `working-session-${String(index).padStart(4, "0")}`;
  return answeredSession(session(), {
    instanceId: id,
    title: id,
    startedAt: `2026-07-21T${String(9 + index).padStart(2, "0")}:00:00.000Z`,
  });
}

async function attachSyntheticPhoto(
  page: Page,
  label: string,
  mimeType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
  source: "camera" | "library" = "library",
): Promise<void> {
  await page.locator(".sh-photo-input-" + source).evaluate(async (element, options) => {
    const input = element as HTMLInputElement;
    const canvas = document.createElement("canvas");
    canvas.width = 2_400;
    canvas.height = 1_200;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("missing synthetic photo canvas");
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#1b2528");
    gradient.addColorStop(0.5, "#c99855");
    gradient.addColorStop(1, "#334e56");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#eee7da";
    context.lineWidth = 14;
    for (let x = 80; x < canvas.width; x += 120) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(canvas.width - x / 2, canvas.height);
      context.stroke();
    }
    context.fillStyle = "#141410";
    context.font = "700 96px system-ui";
    context.fillText(options.label, 120, 180);

    const { promise, resolve } = Promise.withResolvers<Blob | null>();
    canvas.toBlob(resolve, options.mimeType, 0.92);
    const blob = await promise;
    if (!blob) throw new Error("failed to encode synthetic photo");
    const transfer = new DataTransfer();
    const extension = options.mimeType === "image/jpeg" ? "jpg" : options.mimeType === "image/png" ? "png" : "webp";
    transfer.items.add(new File([blob], `component.${extension}`, { type: options.mimeType }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { label, mimeType });
}

function capturedPhotoPrompts(page: Page): Promise<readonly {
  text: string;
  imageCount: number;
  mimeType: string;
  bytes: number;
  jpegMagic: string;
}[]> {
  return page.evaluate(() => {
    const frames = (globalThis as typeof globalThis & { __askGuestFrames?: unknown[] }).__askGuestFrames ?? [];
    return frames.flatMap(frame => {
      if (!frame || typeof frame !== "object" || !("t" in frame) || frame.t !== "prompt") return [];
      const prompt = frame as { text?: unknown; images?: unknown };
      if (typeof prompt.text !== "string" || !Array.isArray(prompt.images) || prompt.images.length === 0) return [];
      const first = prompt.images[0] as { data?: unknown; mimeType?: unknown };
      if (typeof first.data !== "string" || typeof first.mimeType !== "string") return [];
      const binary = atob(first.data);
      return [{
        text: prompt.text,
        imageCount: prompt.images.length,
        mimeType: first.mimeType,
        bytes: binary.length,
        jpegMagic: [binary.charCodeAt(0), binary.charCodeAt(1)].join(","),
      }];
    });
  });
}

test("installed-PWA View and Control mount in the current window without losing the handoff", { tag: "@core" }, async ({ context, page }) => {
  const fixture = await startDashboardFixture([session(), ...Array.from({ length: 12 }, (_, index) => workingSession(index))]);
  let auxiliaryPages = 0;
  context.on("page", candidate => {
    if (candidate !== page) auxiliaryPages += 1;
  });

  try {
    await page.addInitScript(() => {
      const nativeMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string): MediaQueryList => {
        if (query !== "(display-mode: standalone)") return nativeMatchMedia(query);
        return {
          matches: true,
          media: query,
          onchange: null,
          addEventListener(): void {},
          removeEventListener(): void {},
          addListener(): void {},
          removeListener(): void {},
          dispatchEvent(): boolean { return true; },
        };
      };
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: class {
          static readonly CONNECTING = 0;
          static readonly OPEN = 1;
          static readonly CLOSING = 2;
          static readonly CLOSED = 3;
          readonly url: string;
          readyState = 0;
          binaryType = "blob";
          onopen: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;

          constructor(url: string) {
            this.url = url;
          }

          close(): void {
            this.readyState = 3;
          }

          send(): void {}
        },
      });
    });

    await page.goto(fixture.origin);
    const card = page.locator(".queue-hero");
    await expect(card).toHaveCount(1);
    const directoryOrder = await page.locator("[data-instance-id]").evaluateAll(elements =>
      elements.map(element => (element as HTMLElement).dataset.instanceId),
    );
    await page.evaluate(() => window.scrollTo(0, 360));
    const directoryScroll = await page.evaluate(() => window.scrollY);
    expect(directoryScroll).toBeGreaterThan(0);

    await card.getByRole("button", { name: "Options" }).evaluate(button => (button as HTMLButtonElement).click());
    await page.getByRole("button", { name: "View transcript", exact: true }).evaluate(
      button => (button as HTMLButtonElement).click(),
    );
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator("#root[role='application']")).toHaveCount(1);
    await expect(page.locator(".shell-title")).toHaveText(SESSION_TITLE);
    await expect(page.locator(".shell-control")).toBeVisible();
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "reconnecting");
    await expect(page.locator(".triage-bar")).toBeHidden();
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    await expect(page.locator(".co-connect, .sh-connect, .sh-header, .sh-rail, .sh-banner, .sh-ended")).toHaveCount(0);
    // The real-device journey's exact View assertion must hold against the client this build ships.
    expect(await page.evaluate(JOURNEY_VIEW_STATE)).toEqual({ readOnly: true, controlVisible: true, rootMounted: true });
    const shippedClient = await page.evaluate(async () => {
      const asset = performance.getEntriesByType("resource").find(entry =>
        /\/assets\/collab-client\.[a-f0-9]+\.js$/u.test(entry.name),
      );
      if (asset === undefined) throw new Error("collaboration client was not loaded");
      return (await fetch(asset.name)).text();
    });
    expect(shippedClient).not.toContain("M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z");
    expect(await page.locator(".gateway-shell").evaluate(element =>
      [...element.children].map(child => child.id || child.className),
    )).toEqual(["shell-bar", "root", "triage-bar"]);
    const shellTargets = await page.locator(".shell-back, .shell-control").evaluateAll(elements =>
      elements.filter(element => !(element as HTMLElement).hidden).map(element => element.getBoundingClientRect().height),
    );
    expect(shellTargets.every(height => height >= 44)).toBe(true);
    const shellOverlap = await page.locator(".shell-bar").evaluate(bar => {
      const title = bar.querySelector<HTMLElement>(".shell-title")?.getBoundingClientRect();
      const back = bar.querySelector<HTMLElement>(".shell-back")?.getBoundingClientRect();
      const actions = bar.querySelector<HTMLElement>(".shell-actions")?.getBoundingClientRect();
      const overlaps = (left?: DOMRect, right?: DOMRect): boolean =>
        left !== undefined &&
        right !== undefined &&
        left.left < right.right &&
        left.right > right.left &&
        left.top < right.bottom &&
        left.bottom > right.top;
      return {
        actions: overlaps(title, actions),
        back: overlaps(title, back),
      };
    });
    expect(shellOverlap).toEqual({ actions: false, back: false });
    expect(auxiliaryPages).toBe(0);
    expect(fixture.requests).toContain("POST /api/v1/sessions/standalone-launch-0001/launch");
    expect(fixture.launchRequests[0]).toEqual({
      instanceId: "standalone-launch-0001",
      generation: 1,
      mode: "view",
    });

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".queue-hero")).toHaveCount(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(directoryScroll);
    expect(
      await page.locator("[data-instance-id]").evaluateAll(elements =>
        elements.map(element => (element as HTMLElement).dataset.instanceId),
      ),
    ).toEqual(directoryOrder);
    const controlDirectoryScroll = await page.evaluate(() => window.scrollY);

    await page.locator(".queue-hero").getByRole("button", { name: "Open request" }).evaluate(
      button => (button as HTMLButtonElement).click(),
    );
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator("#root[role='application']")).toHaveCount(1);
    await expect(page.locator(".shell-control")).toBeHidden();
    expect(fixture.launchRequests[1]).toEqual({
      instanceId: "standalone-launch-0001",
      generation: 1,
      mode: "control",
      requestId: "standalone-request-0001",
    });
    const next = {
      ...session(),
      instanceId: "next-attention-000001",
      title: "Next attention",
      ask: {
        requestId: "next-request-identity-0001",
        since: "2026-07-21T10:00:02.000Z",
      },
    };
    fixture.upsert(next);
    fixture.upsert(answeredSession(session()));
    await expect(page.locator(".triage-copy")).toHaveText("✓ Answered — 1 more needs you");
    await expect(page.locator(".triage-action")).toHaveText("Next ask →");
    await page.locator(".triage-action").click();
    await expect(page.locator(".shell-title")).toHaveText("Next attention");
    expect(fixture.launchRequests[2]).toEqual({
      instanceId: "next-attention-000001",
      generation: 1,
      mode: "control",
      requestId: "next-request-identity-0001",
    });
    fixture.upsert(answeredSession(next));
    await expect(page.locator(".triage-action")).toHaveText("Sessions");
    await page.locator(".triage-action").click();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".all-clear-title")).toHaveText("All clear");
    await expect(page.locator(".all-clear-copy")).toHaveText("Nothing needs you.");
    await expect(page.locator(".working-row")).toHaveCount(14);
    await expect(page.locator("#settings")).toBeVisible();
    const legacyAlertsBlock = await page.evaluate(() =>
      Boolean(document.querySelector(".home-alerts")),
    );
    expect(legacyAlertsBlock).toBe(false);
    expect(auxiliaryPages).toBe(0);
    expect(fixture.requests.filter(request => request.endsWith("/launch"))).toHaveLength(3);

    const residue = await page.evaluate(async () => ({
      url: location.href,
      historyState: JSON.stringify(history.state),
      localStorage: JSON.stringify({ ...localStorage }),
      sessionStorage: JSON.stringify({ ...sessionStorage }),
      cacheUrls: (await Promise.all((await caches.keys()).map(async name => {
        const cache = await caches.open(name);
        return (await cache.keys()).map(request => request.url);
      }))).flat(),
    }));
    expect(residue.url).toBe(`${fixture.origin}/`);
    expect(residue.url).not.toContain("handoff");
    expect(residue.url).not.toContain("#");
    expect(JSON.parse(residue.historyState)).toMatchObject({
      ompDirectory: { scrollY: controlDirectoryScroll },
    });
    expect(JSON.parse(residue.localStorage)).toEqual({
      "omp.collab.name": "guest",
      "omp.sessions.first-run.v1": JSON.stringify({ version: 1, step: "done", updatedAt: "2026-10-24T00:00:00.000Z" }),
    });
    expect(residue.sessionStorage).toBe("{}");
    expect(residue.cacheUrls.every(url => !url.includes("/api/") && !url.includes("/client/"))).toBe(true);
  } finally {
    await fixture.stop();
  }
});

test("embedded active ask matches the original 3d shell interaction", async ({ page }) => {
  test.setTimeout(70_000);
  const roomKey = new Uint8Array(32).fill(37);
  const fixture = await startDashboardFixture([session()], { roomKey });

  try {
    await page.addInitScript(({ keyBytes }) => {
      const question = "How should ADR-0036 proceed?";
      const options = [
        { label: "Implement ADR-0036 locally", description: "Apply the compatibility fix in the gateway." },
        { label: "Wait for upstream", description: "Leave the current behavior unchanged." },
      ];
      const args = {
        questions: [{ id: "adr-0036", question, options, multi: false, recommended: 0 }],
      };
      const key = crypto.subtle.importKey("raw", new Uint8Array(keyBytes), "AES-GCM", false, ["encrypt", "decrypt"]);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const guestFrames: unknown[] = [];
      (globalThis as typeof globalThis & { __askGuestFrames?: unknown[] }).__askGuestFrames = guestFrames;
      let holdConnections = false;
      let holdNextSnapshot = true;
      let resumeSnapshot: (() => void) | undefined;
      Math.random = () => 0.5;

      class AskWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly url: string;
        readyState = AskWebSocket.CONNECTING;
        binaryType: BinaryType = "arraybuffer";

        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        sentWelcome = false;
        hostFramesSent = false;
        promptSequence = 0;
        suppressedPromptAcks = 0;

        constructor(url: string) {
          this.url = url;
          (globalThis as typeof globalThis & { __askSocket?: AskWebSocket }).__askSocket = this;
          queueMicrotask(() => {
            if (holdConnections) {
              this.readyState = AskWebSocket.CLOSED;
              this.onclose?.(new CloseEvent("close", { code: 1006, reason: "relay unavailable" }));
              return;
            }
            this.readyState = AskWebSocket.OPEN;
            this.onopen?.(new Event("open"));
          });
        }

        close(): void {
          this.readyState = AskWebSocket.CLOSED;
        }

        transientClose(): void {
          this.readyState = AskWebSocket.CLOSED;
          this.onclose?.(new CloseEvent("close", { code: 1006, reason: "network changed" }));
        }

        holdSnapshotAndClose(): void {
          holdNextSnapshot = true;
          this.transientClose();
        }

        releaseSnapshot(): void {
          resumeSnapshot?.();
          resumeSnapshot = undefined;
        }

        holdAndClose(): void {
          holdConnections = true;
          this.transientClose();
        }

        allowRecovery(): void {
          holdConnections = false;
        }

        suppressNextPromptAck(): void {
          this.suppressedPromptAcks += 1;
        }

        send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          void this.captureGuestFrame(data);
          if (this.sentWelcome) return;
          this.sentWelcome = true;
          void this.sendHostFrames();
        }

        async captureGuestFrame(data: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<void> {
          if (typeof data === "string" || data instanceof Blob) return;
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          if (bytes.byteLength <= 16) return;
          const iv = bytes.slice(4, 16);
          const ciphertext = bytes.slice(16);
          const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await key, ciphertext);
          const frame = JSON.parse(decoder.decode(plaintext)) as unknown;
          guestFrames.push(frame);
          if (!frame || typeof frame !== "object" || !("t" in frame) || frame.t !== "prompt") return;
          if (this.suppressedPromptAcks > 0) {
            this.suppressedPromptAcks -= 1;
            return;
          }
          const prompt = frame as { text?: unknown; images?: unknown };
          if (typeof prompt.text !== "string") return;
          const images = Array.isArray(prompt.images) ? prompt.images : [];
          this.promptSequence += 1;
          await this.sendHostFrame({
            t: "entry",
            entry: {
              id: `guest-photo-${this.promptSequence}`,
              parentId: null,
              timestamp: "2026-07-25T00:00:02.000Z",
              type: "custom_message",
              customType: "collab-prompt",
              content: images.length > 0 ? [{ type: "text", text: prompt.text }, ...images] : prompt.text,
              details: { from: "guest" },
              display: true,
            },
          });
        }

        async sendHostFrame(frame: unknown): Promise<void> {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-GCM", iv },
              await key,
              encoder.encode(JSON.stringify(frame)),
            ),
          );
          const envelope = new Uint8Array(4 + iv.byteLength + ciphertext.byteLength);
          new DataView(envelope.buffer).setUint32(0, 1, false);
          envelope.set(iv, 4);
          envelope.set(ciphertext, 4 + iv.byteLength);
          this.onmessage?.(new MessageEvent("message", { data: envelope.buffer }));
        }

        async sendHostFrames(): Promise<void> {
          const assistantEntry = {
            id: "ask-entry",
            parentId: null,
            timestamp: "2026-07-25T00:00:00.000Z",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "ask-active", name: "ask", arguments: args }],
              model: "test/model",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
              stopReason: "toolUse",
              timestamp: 0,
            },
          };
          const frames = [
            {
              t: "welcome",
              proto: 3,
              header: {
                type: "session",
                id: "ask-browser-smoke",
                title: "Recommended ask browser smoke",
                timestamp: "2026-07-25T00:00:00.000Z",
                cwd: "/test",
              },
              state: {
                isStreaming: true,
                queuedMessageCount: 0,
                cwd: "/test",
                participants: [{ name: "host", role: "host" }],
              },
              agents: [{
                id: "subagent-browser-smoke",
                displayName: "scout",
                kind: "sub",
                status: "parked",
                hasSessionFile: true,
                createdAt: 1,
                lastActivity: 1,
              }],
              entryCount: 1,
              readOnly: false,
            },
            { t: "snapshot-chunk", entries: [assistantEntry], final: true },
            { t: "gateway-health-pong", seq: 0 },
            {
              t: "event",
              event: { type: "tool_execution_start", toolCallId: "ask-active", toolName: "ask", args },
            },
            {
              t: "ui-request",
              request: {
                reqId: 7,
                kind: "select",
                title: question,
                options,
                initialIndex: 0,
                selectionMarker: "radio",
              },
            },
          ];
          for (const frame of frames) {
            await this.sendHostFrame(frame);
            if (frame === frames[0] && holdNextSnapshot) {
              holdNextSnapshot = false;
              await new Promise<void>(resolve => {
                resumeSnapshot = resolve;
              });
            }
          }
          this.hostFramesSent = true;
        }
      }

      Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: AskWebSocket });
    }, { keyBytes: [...roomKey] });

    let initialHealthFailures = 0;
    await page.goto(fixture.origin);
    await expect(page.getByRole("button", { name: "Open request" })).toBeVisible();
    await page.route(`${fixture.origin}/api/v1/sessions`, route => {
      initialHealthFailures += 1;
      return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });

    await page.getByRole("button", { name: "Open request" }).click();
    await expect.poll(() => initialHealthFailures, { timeout: 4_000 }).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { releaseSnapshot(): void };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      socket.releaseSnapshot();
    });
    await expect(page.locator(".conn-chip")).toHaveText("Reconnecting…");
    await expect(page.locator(".sh-ask-option").first()).toBeFocused();
    await page.unroute(`${fixture.origin}/api/v1/sessions`);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "connected", { timeout: 5_000 });


    const recommended = page.locator(".sh-ask-option-recommended");
    await expect(recommended).toHaveText("Recommended");
    await expect(recommended).toHaveCount(1);
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "connected");
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-compact", "true");
    await expect(page.locator(".conn-chip")).toHaveText("Connected");
    await expect(page.locator(".conn-chip")).toHaveCSS("font-size", "0px");
    await expect(page.locator(".conn-chip")).toHaveAttribute("aria-label", "Connected");
    await expect(page.locator(".conn-chip")).toHaveAttribute("role", "status");
    await expect(page.locator(".conn-chip")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "hold");
    await expect(page.locator(".triage-copy")).toHaveText("Need the desk for this one?");
    await expect(page.locator(".triage-action")).toHaveText("Hold → next");
    await expect(page.locator(".sh-composer")).toHaveCount(1);
    await expect(page.locator(".gateway-shell > .sh-composer")).toHaveCount(0);
    await expect(page.locator(".sh-header, .sh-rail, .sh-rail-backdrop")).toHaveCount(0);
    await expect(page.locator(".sh-transcript")).toHaveCount(1);
    await expect(page.locator(".sh-btn-stop, .sh-ended, .sh-banner")).toHaveCount(0);
    await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(1);
    await expect(page.locator(".sh-ask-kicker")).toHaveText("input required");
    await expect(page.locator(".sh-ask-option").first()).toHaveClass(/sh-ask-option-checked/u);
    await expect(page.locator(".sh-ask-option-label").first()).toContainText("1 · Implement ADR-0036 locally");
    await expect(page.locator(".sh-ask-send")).toHaveText("Send");
    await expect(page.locator(".sh-ask-send")).toHaveCSS("background-color", "rgb(49, 196, 141)");
    await expect(
      page.locator(".sh-ask-option").filter({ hasText: "Implement ADR-0036 locally" }).locator(".sh-ask-option-recommended"),
    ).toHaveText("Recommended");
    await expect(
      page.locator(".sh-ask-option").filter({ hasText: "Wait for upstream" }).locator(".sh-ask-option-recommended"),
    ).toHaveCount(0);
    await page.evaluate(() => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { transientClose(): void };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      socket.transientClose();
    });
    await expect(page.locator(".conn-chip")).toHaveText("Reconnecting…");
    await expect(page.locator(".triage-bar")).toBeHidden();
    await expect(page.locator(".conn-chip")).toHaveText("Connected", { timeout: 2_500 });
    await expect(page.locator(".triage-bar")).toBeVisible();
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "hold");
    const nextAsk = {
      ...session(),
      instanceId: "held-next-session-0001",
      title: "Held flow next ask",
      canControl: false,
      ask: {
        requestId: "held-next-request-0001",
        since: "2026-07-21T10:00:02.000Z",
      },
    };
    fixture.upsert(nextAsk);
    let rejectNextAdvance = true;
    const nextLaunchRoute = "**/api/v1/sessions/held-next-session-0001/launch";
    await page.route(nextLaunchRoute, async route => {
      if (rejectNextAdvance) {
        rejectNextAdvance = false;
        await route.fulfill({ status: 409, contentType: "application/json", body: "{}" });
        return;
      }
      await route.continue();
    });
    await page.locator(".triage-action").click();
    await expect(page.locator(".shell-title")).toHaveText(SESSION_TITLE);
    await expect(page.locator(".triage-copy")).toHaveText(
      "Couldn't open the next request. This one is still queued.",
    );
    await expect(page.locator(".triage-action")).toHaveText("Try again");
    expect(await page.evaluate(() =>
      JSON.parse(localStorage.getItem("omp.sessions.held-asks.v2") ?? "[]"),
    )).toEqual([]);

    await page.locator(".triage-action").click();
    await expect(page.locator(".shell-title")).toHaveText("Held flow next ask");
    expect(fixture.launchRequests.at(-1)).toEqual({
      instanceId: nextAsk.instanceId,
      generation: 1,
      mode: "view",
      requestId: undefined,
    });
    expect(await page.evaluate(() =>
      JSON.parse(localStorage.getItem("omp.sessions.held-asks.v2") ?? "null"),
    )).toEqual([
      {
        instanceId: "standalone-launch-0001",
        requestId: "standalone-request-0001",
        heldAt: expect.any(String),
        sourceId: "local",
        sourceOrigin: fixture.origin,
      },
    ]);
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "hold");
    await expect(page.locator(".triage-copy")).toHaveText("Need the desk for this one?");
    await page.unroute(nextLaunchRoute);
    await page.getByRole("button", { name: "Close Held flow next ask", exact: true }).click();
    await expect(page).toHaveURL(fixture.origin + "/");
    await expect(page.locator(".held-row .row-title")).toHaveText(SESSION_TITLE);
    await page.locator(".held-requeue").click();
    await expect(page.locator(".queue-hero h2")).toHaveText(SESSION_TITLE);
    await page.locator(".queue-hero").getByRole("button", { name: "Open request", exact: true }).click();
    await expect(page.locator(".shell-title")).toHaveText(SESSION_TITLE);
    await expect(page.locator(".sh-ask-option").first()).toBeVisible();
    fixture.remove(nextAsk.instanceId, nextAsk.generation);

    await page.evaluate(() => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { holdSnapshotAndClose(): void };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      socket.holdSnapshotAndClose();
    });
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "reconnecting");
    await expect(page.locator(".conn-chip")).toHaveText("Reconnecting…");
    await expect(page.locator(".triage-bar")).toBeHidden();
    await expect(page.locator(".conn-chip")).toHaveText("Reconnecting… 0%");
    await page.waitForTimeout(3_200);
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "reconnecting");
    await expect(page.locator(".triage-bar")).toBeHidden();
    await page.evaluate(() => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { releaseSnapshot(): void };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      socket.releaseSnapshot();
    });
    await expect(page.locator(".sh-ask-option").first()).toBeVisible();
    await expect(page.locator(".conn-chip")).toHaveText("Connected");
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "connected");
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "hold");
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-compact", "true");

    await page.evaluate(() => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { holdAndClose(): void };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      socket.holdAndClose();
    });
    await expect(page.locator(".conn-chip")).toHaveText("Reconnecting…");
    await expect(page.locator(".triage-bar")).toBeHidden();
    await expect(page.locator(".conn-chip")).toHaveText("Relay unavailable", { timeout: 5_000 });
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "reconnecting");
    await expect(page.locator(".triage-copy")).toContainText("Relay unavailable — retrying");
    await page.evaluate(() => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { allowRecovery(): void };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      socket.allowRecovery();
    });
    await expect(page.locator(".conn-chip")).toHaveText("Connected", { timeout: RELAY_RECOVERY_TIMEOUT_MS });
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "hold");
    await page.locator(".sh-ask-option").nth(1).click();
    await expect(page.locator(".sh-ask-option").first()).not.toHaveClass(/sh-ask-option-checked/u);
    await expect(page.locator(".sh-ask-option").nth(1)).toHaveClass(/sh-ask-option-checked/u);
    await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(1);
    const immediateTriage = await page.locator(".sh-ask-send").evaluate(button => {
      (button as HTMLButtonElement).click();
      const triage = document.querySelector<HTMLElement>(".triage-bar");
      return {
        kind: triage?.dataset.kind,
        copy: triage?.querySelector<HTMLElement>(".triage-copy")?.textContent,
      };
    });
    expect(immediateTriage).toEqual({ kind: "sending", copy: "Sending…" });
    await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(1);
    await expect(page.locator(".sh-ask-kicker")).toHaveText("Sending…");
    await expect(page.locator(".sh-ask-send")).toHaveText("Sending…");
    await expect(page.locator(".sh-ask-send")).toBeDisabled();
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "sending");
    await expect(page.locator(".triage-copy")).toHaveText("Sending…");
    fixture.upsert(answeredSession(session()));
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "sending");
    await expect(page.locator(".triage-copy")).toHaveText("Sending…");
    await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(1);
    await page.evaluate(async () => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { sendHostFrame(frame: unknown): Promise<void> };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      await socket.sendHostFrame({ t: "ui-request-end", reqId: 7 });
    });
    await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(0);
    await expect(page.locator(".sh-composer")).toHaveCount(1);
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "clear");

    await page.route(`${fixture.origin}/api/v1/sessions`, route =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    await page.evaluate(() => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { holdAndClose(): void };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      socket.holdAndClose();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".conn-chip")).toHaveText("Gateway unavailable", { timeout: 5_000 });
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "clear");
    await page.unroute(`${fixture.origin}/api/v1/sessions`);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".conn-chip")).toHaveText("Relay unavailable", { timeout: 7_000 });
    // The tray title now expands; tap neutral client content to dismiss only answer feedback.
    await page.locator(".sh-transcript").click({ position: { x: 2, y: 2 } });
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "reconnecting");
    await expect(page.locator(".triage-copy")).toContainText("Relay unavailable — retrying");
    await page.evaluate(() => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { allowRecovery(): void };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      socket.allowRecovery();
    });
    await expect(page.locator(".conn-chip")).toHaveText("Connected", { timeout: RELAY_RECOVERY_TIMEOUT_MS });
    await expect(page.locator(".triage-bar")).toBeHidden();
    await page.evaluate(async () => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { sendHostFrame(frame: unknown): Promise<void> };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      await socket.sendHostFrame({ t: "ui-request-end", reqId: 7 });
    });
    await expect(page.locator(".sh-composer-ask-embedded")).toHaveCount(0);

    const cameraInput = page.locator(".sh-photo-input-camera");
    const photoInput = page.locator(".sh-photo-input-library");
    const photoTrigger = page.getByRole("button", { name: "Add a photo" });
    const promptInput = page.locator(".sh-composer-input");
    const promptSend = page.locator(".sh-composer > .sh-composer-inner .sh-btn-primary");
    await expect(cameraInput).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    await expect(cameraInput).toHaveAttribute("capture", "environment");
    await expect(photoInput).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    await expect(photoInput).not.toHaveAttribute("capture", /.+/u);
    await expect(photoTrigger).toBeEnabled();
    await photoTrigger.click();
    await expect(photoTrigger).toHaveAttribute("aria-expanded", "true");
    const takePhoto = page.getByRole("button", { name: /Take photo/u });
    const chooseExisting = page.getByRole("button", { name: /Choose existing/u });
    await expect(takePhoto).toBeVisible();
    await expect(chooseExisting).toBeVisible();
    for (const choice of [takePhoto, chooseExisting]) {
      const bounds = await choice.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await takePhoto.focus();
    await page.keyboard.press("Escape");
    await expect(photoTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(photoTrigger).toBeFocused();
    await photoTrigger.click();
    await expect(takePhoto).toBeVisible();
    const cameraChooserPromise = page.waitForEvent("filechooser");
    await takePhoto.click();
    const cameraChooser = await cameraChooserPromise;
    expect(await cameraChooser.element().getAttribute("capture")).toBe("environment");
    await cameraChooser.setFiles([]);
    await expect(photoTrigger).toHaveAttribute("aria-expanded", "false");

    await photoTrigger.click();
    const libraryChooserPromise = page.waitForEvent("filechooser");
    await chooseExisting.click();
    const libraryChooser = await libraryChooserPromise;
    expect(await libraryChooser.element().getAttribute("capture")).toBeNull();
    await libraryChooser.setFiles([]);
    await expect(photoTrigger).toHaveAttribute("aria-expanded", "false");

    await photoTrigger.click();

    await attachSyntheticPhoto(page, "CONNECTOR A", "image/jpeg", "camera");
    await expect(photoTrigger).toHaveAttribute("aria-expanded", "false");
    const preview = page.locator(".sh-photo img");
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate(image => ({
      width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight,
    }))).toEqual({ width: 2_048, height: 1_024 });
    await expect(promptInput).toHaveAttribute("placeholder", "add a note (optional)…");
    await promptInput.fill("Is this connector fully seated?");
    await expect(promptSend).toBeEnabled();
    expect(await promptSend.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return {
        height: Math.round(bounds.height),
        hit: hit === button || (hit !== null && button.contains(hit)),
        width: Math.round(bounds.width),
      };
    })).toEqual({ height: 44, hit: true, width: 44 });
    await promptSend.click();
    await expect(page.locator(".sh-photo")).toHaveCount(0);
    await expect(promptInput).toHaveValue("");
    const transcriptPhoto = page.locator(".tr-msg-img").last();
    await expect(transcriptPhoto).toBeVisible();
    expect(await transcriptPhoto.evaluate(image => {
      const bounds = image.getBoundingClientRect();
      return { fitsViewport: bounds.left >= 0 && bounds.right <= innerWidth, source: (image as HTMLImageElement).src.slice(0, 16) };
    })).toEqual({ fitsViewport: true, source: "data:image/jpeg;" });
    await expect.poll(async () => (await capturedPhotoPrompts(page)).length).toBe(1);
    const [captionedPhoto] = await capturedPhotoPrompts(page);
    expect(captionedPhoto).toEqual({
      text: "Is this connector fully seated?",
      imageCount: 1,
      mimeType: "image/jpeg",
      bytes: expect.any(Number),
      jpegMagic: "255,216",
    });
    expect(captionedPhoto?.bytes).toBeLessThanOrEqual(1_024 * 1_024);

    await page.evaluate(() => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { suppressNextPromptAck(): void };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      socket.suppressNextPromptAck();
    });
    await attachSyntheticPhoto(page, "CONNECTOR B", "image/png");
    await expect(page.locator(".sh-photo img")).toBeVisible();
    await expect(promptSend).toBeEnabled();
    await promptSend.tap();
    await expect.poll(async () => (await capturedPhotoPrompts(page)).length).toBe(2);
    await expect(page.locator(".sh-photo")).toHaveCount(1);
    await expect(page.locator(".sh-photo-send-state")).toHaveText("Sending photo…");
    await expect(promptInput).toBeDisabled();
    await expect(page.locator(".sh-photo-send-state")).toHaveText(
      "Photo not confirmed. Tap Send to retry.",
      { timeout: 7_000 },
    );
    await expect(promptSend).toBeEnabled();
    await expect(promptSend).toHaveAttribute("title", "retry photo send");
    await promptSend.tap();
    await expect.poll(async () => (await capturedPhotoPrompts(page)).length).toBe(3);
    await expect(page.locator(".sh-photo")).toHaveCount(0);
    const photoPrompts = await capturedPhotoPrompts(page);
    expect(photoPrompts[1]?.text).toBe("Please inspect this photo.");
    expect(photoPrompts[2]?.text).toBe("Please inspect this photo.");

    await attachSyntheticPhoto(page, "CONNECTOR C", "image/webp");
    await expect(page.locator(".sh-photo img")).toBeVisible();
    await page.getByRole("button", { name: "Remove photo 1" }).tap();
    await expect(page.locator(".sh-photo")).toHaveCount(0);
    await expect(promptSend).toBeDisabled();

    await photoInput.evaluate(input => {
      const bytes = new Uint8Array(24);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const view = new DataView(bytes.buffer);
      view.setUint32(8, 13, false);
      bytes.set([0x49, 0x48, 0x44, 0x52], 12);
      view.setUint32(16, 100_000, false);
      view.setUint32(20, 100_000, false);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "oversized.png", { type: "image/png" }));
      (input as HTMLInputElement).files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.locator(".sh-photo-error")).toHaveText(
      "That photo is too large to process safely. Use a lower-resolution image.",
    );
    await expect(page.locator(".sh-photo")).toHaveCount(0);

    await photoInput.evaluate(input => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["not an image"], "notes.txt", { type: "text/plain" }));
      (input as HTMLInputElement).files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.locator(".sh-photo-error")).toHaveText("Choose a JPEG, PNG, or WebP photo.");
    await expect(promptSend).toBeDisabled();

    const photoResidue = await page.evaluate(async () => {
      const cacheUrls = (
        await Promise.all((await caches.keys()).map(async name => {
          const cache = await caches.open(name);
          return (await cache.keys()).map(request => request.url);
        }))
      ).flat();
      const persistence = JSON.stringify({
        url: location.href,
        historyState: history.state,
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
        cookies: document.cookie,
        cacheUrls,
        indexedDatabases: (await indexedDB.databases()).map(database => database.name),
      });
      return {
        dataUrlPersisted: persistence.includes("data:image/jpeg;base64,"),
        promptPersisted: persistence.includes("Is this connector fully seated?"),
        preparedPreviews: document.querySelectorAll(".sh-photo").length,
        transcriptPhotos: document.querySelectorAll(".tr-msg-img").length,
      };
    });
    expect(photoResidue).toEqual({
      dataUrlPersisted: false,
      promptPersisted: false,
      preparedPreviews: 0,
      transcriptPhotos: 2,
    });
    expect(
      fixture.requests.some(request =>
        ["Is this connector fully seated?", "data:image/jpeg", "/media", "/upload"].some(fragment =>
          request.includes(fragment),
        ),
      ),
    ).toBe(false);

    await page.evaluate(async () => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { sendHostFrame(frame: unknown): Promise<void> };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing ask socket");
      await socket.sendHostFrame({ t: "bye", reason: "Session exited with code 0" });
    });
    await expect(page.locator(".conn-chip")).toHaveAttribute("data-state", "offline");
    await expect(page.locator(".conn-chip")).toHaveText("Ended");
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "ended");
    await expect(page.locator(".triage-copy")).toHaveText("Mac/session ended · exit 0");
    await expect(page.locator(".triage-action")).toHaveText("Back to Sessions");
    await expect(page.locator(".sh-ended")).toHaveCount(0);
    const snapshotsAtEnd = fixture.requests.filter(request => request === "GET /api/v1/sessions").length;
    await page.locator(".triage-action").evaluate(element => {
      element.setAttribute("data-terminal-action", "original");
      (element as HTMLElement).focus();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    // The directory refreshes once on foreground recovery, but the terminal client must not probe.
    await expect.poll(() => fixture.requests.filter(request => request === "GET /api/v1/sessions").length).toBe(snapshotsAtEnd + 1);
    await page.waitForTimeout(100);
    expect(fixture.requests.filter(request => request === "GET /api/v1/sessions")).toHaveLength(snapshotsAtEnd + 1);
    await expect(page.locator('[data-terminal-action="original"]')).toBeFocused();

    await page.locator(".triage-action").click();
    await expect(page).toHaveURL(fixture.origin + "/");
    await page.evaluate(async () => {
      const moduleUrl = performance
        .getEntriesByType("resource")
        .map(entry => entry.name)
        .find(name => /\/assets\/collab-client\.[a-f0-9]+\.js$/u.test(name));
      if (moduleUrl === undefined) throw new Error("missing collab client module URL");
      const response = await fetch("/api/v1/sessions/standalone-launch-0001/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "control", generation: 1 }),
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = await response.json() as { capability?: unknown };
      if (typeof payload.capability !== "string") throw new Error("missing standalone capability");
      // The hashed build URL is runtime-selected; this test intentionally exercises that module boundary.
      const collab = await import(moduleUrl) as {
        startCollabWithCapability(
          container: HTMLElement,
          capability: string,
          onDispose: () => void,
        ): () => void;
      };
      const container = document.createElement("div");
      container.id = "standalone-collab";
      document.body.replaceChildren(container);
      const dispose = collab.startCollabWithCapability(container, payload.capability, () => undefined);
      (globalThis as typeof globalThis & { __disposeStandalone?: () => void }).__disposeStandalone = dispose;
    });
    await expect(page.locator(".sh-ask-option")).toHaveCount(2);
    // Upstream now docks the composer inside the panel behind the mobile agents rail.
    await page.getByTitle("hide agents", { exact: true }).click();
    await page.locator(".sh-ask-option").nth(1).click();
    await expect(page.locator(".sh-ask-option").nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".sh-ask-option").nth(1)).toBeDisabled();
    await expect(page.locator(".sh-ask-kicker")).toHaveText("Sending…");
    await expect(page.locator(".sh-ask-kicker")).toHaveAttribute("role", "status");
    await expect(page.locator(".sh-ask-kicker")).toHaveAttribute("aria-live", "polite");
    await page.evaluate(() => {
      const globals = globalThis as typeof globalThis & {
        __askSocket?: { transientClose(): void };
        __previousAskSocket?: object;
      };
      const socket = globals.__askSocket;
      if (socket === undefined) throw new Error("missing standalone socket");
      globals.__previousAskSocket = socket;
      socket.transientClose();
    });
    await expect.poll(() => page.evaluate(() => {
      const globals = globalThis as typeof globalThis & {
        __askSocket?: { hostFramesSent: boolean };
        __previousAskSocket?: object;
      };
      return globals.__askSocket !== undefined &&
        globals.__askSocket !== globals.__previousAskSocket &&
        globals.__askSocket.hostFramesSent;
    }), { timeout: 5_000 }).toBe(true);
    await expect(page.locator(".sh-ask-kicker")).toHaveText("Sending…");
    await expect(page.locator(".sh-ask-option").nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".sh-ask-option").nth(1)).toBeDisabled();
    await page.evaluate(async () => {
      const socket = (globalThis as typeof globalThis & {
        __askSocket?: { sendHostFrame(frame: unknown): Promise<void> };
      }).__askSocket;
      if (socket === undefined) throw new Error("missing standalone socket");
      await socket.sendHostFrame({ t: "ui-request-end", reqId: 7 });
    });
    await expect(page.locator(".sh-ask-kicker")).toHaveCount(0);
    await expect(page.locator(".sh-composer-ask")).toHaveCount(0);
    await page.evaluate(() => {
      (globalThis as typeof globalThis & { __disposeStandalone?: () => void }).__disposeStandalone?.();
    });
  } finally {
    await fixture.stop();
  }
});

test("direct client navigation returns to the session directory without legacy bootstrap UI", { tag: "@core" }, async ({ page }) => {
  const fixture = await startDashboardFixture([session()]);

  try {
    await page.goto(`${fixture.origin}/client/`);
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator("#session-list")).toBeVisible();
    await expect(page.locator(".co-connect, .gateway-shell, .sh-ended")).toHaveCount(0);
  } finally {
    await fixture.stop();
  }
});

test("answer feedback dismisses from the keyboard with Escape", { tag: "@core" }, async ({ page }) => {
  const initial = session();
  const fixture = await startDashboardFixture([initial]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Open request" }).click();
    await page.locator(".tray-expand").click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    fixture.upsert(answeredSession(initial));
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "clear");
    await page.locator(".shell-back").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".triage-bar")).toBeHidden();
  } finally {
    await fixture.stop();
  }
});

test("answer feedback dismisses by tap-out, swipe, and the eight-second timeout", { tag: "@core" }, async ({ page }) => {
  const initial = session();
  const fixture = await startDashboardFixture([initial]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Open request" }).click();
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    fixture.upsert(answeredSession(initial));
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "clear");
    await expect.poll(() => page.locator("#tray").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    const inset = await page.evaluate(() => {
      const composer = document.querySelector(".sh-composer")?.getBoundingClientRect();
      const triage = document.querySelector(".triage-bar")?.getBoundingClientRect();
      if (composer === undefined || triage === undefined) return undefined;
      return { composerBottom: composer.bottom, triageTop: triage.top };
    });
    expect(inset).toBeDefined();
    expect(inset?.composerBottom).toBeLessThanOrEqual(inset?.triageTop ?? 0);
    await page.locator(".shell-bar").dispatchEvent("pointerdown", { pointerId: 1, clientY: 20 });
    await expect(page.locator(".triage-bar")).toBeHidden();

    await page.getByRole("button", { name: `Close ${SESSION_TITLE}`, exact: true }).click();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    const second = {
      ...initial,
      inputRequired: true,
      ask: {
        requestId: "standalone-request-0002",
        since: "2026-07-21T10:00:02.000Z",
      },
    };
    fixture.upsert(second);
    await page.getByRole("button", { name: "Open request" }).click();
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    fixture.upsert(answeredSession(second));
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "clear");
    await page.locator(".triage-bar").dispatchEvent("pointerdown", { pointerId: 2, clientY: 80 });
    await page.locator(".triage-bar").dispatchEvent("pointerup", { pointerId: 2, clientY: 20 });
    await expect(page.locator(".triage-bar")).toBeHidden();

    await page.getByRole("button", { name: `Close ${SESSION_TITLE}`, exact: true }).click();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    const third = {
      ...initial,
      inputRequired: true,
      ask: {
        requestId: "standalone-request-0003",
        since: "2026-07-21T10:00:03.000Z",
      },
    };
    fixture.upsert(third);
    await page.getByRole("button", { name: "Open request" }).click();
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await page.clock.install();
    fixture.upsert(answeredSession(third));
    await expect(page.locator(".triage-bar")).toHaveAttribute("data-kind", "clear");
    await page.clock.fastForward(8_100);
    await expect(page.locator(".triage-bar")).toBeHidden();
  } finally {
    await fixture.stop();
  }
});

test("a bfcache restore whose session changed generation returns to the live directory", async ({ page }) => {
  const active = session();
  const fixture = await startDashboardFixture([
    active,
    ...Array.from({ length: 12 }, (_, index) => workingSession(index)),
  ]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    await expect(page.locator(".queue-hero")).toHaveCount(1);
    await expect(page.locator(".working-row")).toHaveCount(12);
    await page.evaluate(() => window.scrollTo(0, 360));
    const directoryScroll = await page.evaluate(() => window.scrollY);
    expect(directoryScroll).toBeGreaterThan(0);

    await page.locator(".queue-hero").getByRole("button", { name: "Open request" }).evaluate(
      button => (button as HTMLButtonElement).click(),
    );
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    expect(fixture.launchRequests).toHaveLength(1);

    // The client opens its relay transport after it mounts, asynchronously; on some engines the
    // first frame lands before it. Wait for it so the freeze below starts from a live transport.
    await expect.poll(() => relaySocketCount(page)).toBeGreaterThanOrEqual(1);
    // Count the bearer's transports and freeze the page in the same task, so no relay attempt can
    // slip between the reading and the teardown. Never return the capability-bearing URLs to the
    // test runner, where a failed assertion could print them into CI output.
    const bootstrapSocketCount = await page.evaluate(() => {
      const count =
        (globalThis as typeof globalThis & { __ompRelaySocketCount?: number }).__ompRelaySocketCount ?? 0;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      return count;
    });
    expect(bootstrapSocketCount).toBeGreaterThanOrEqual(1);
    await expect(page.locator("#root > .sh-app")).toHaveCount(0);
    await expect(page.locator(".gateway-shell")).toHaveCount(1);
    await expect(page).toHaveURL(`${fixture.origin}/`);

    // The host restarted while the page was frozen, which legitimately ended the session the shell
    // was showing. Resuming into its successor would hand the user a different conversation behind
    // the card they left, so this restore must fall back to the directory.
    fixture.upsert({ ...active, generation: 2 });
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".gateway-shell")).toHaveCount(0);
    await expect(page.locator("#session-list")).toBeVisible();
    await expect(page.locator(".queue-hero")).toHaveCount(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(directoryScroll);

    fixture.upsert(answeredSession(active, { generation: 2 }));
    await expect(page.locator(".all-clear-title")).toHaveText("All clear");
    await expect(page.locator(".working-row")).toHaveCount(13);
    expect(fixture.launchRequests).toHaveLength(1);
    expect(await relaySocketCount(page)).toBe(bootstrapSocketCount);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.working-row[data-instance-id="working-session-0000"]').click();
    await expect(page).toHaveURL(`${fixture.origin}/client/`);
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    expect(fixture.launchRequests[1]).toEqual({
      instanceId: "working-session-0000",
      generation: 1,
      mode: "view",
    });
    expect(await relaySocketCount(page)).toBeGreaterThan(bootstrapSocketCount);

    await page.goBack();
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator(".all-clear-title")).toHaveText("All clear");
    await expect(page.locator(".working-row")).toHaveCount(13);
  } finally {
    await fixture.stop();
  }
});

test("a bfcache restore reopens the backgrounded session and stores no capability", { tag: "@core" }, async ({ page }) => {
  const active = session();
  const fixture = await startDashboardFixture([
    active,
    ...Array.from({ length: 3 }, (_, index) => workingSession(index)),
  ]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    await expect(page.locator(".queue-hero")).toHaveCount(1);

    await page.locator(".queue-hero").getByRole("button", { name: "Open request" }).evaluate(
      button => (button as HTMLButtonElement).click(),
    );
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    expect(fixture.launchRequests).toHaveLength(1);

    await expect.poll(() => relaySocketCount(page)).toBeGreaterThanOrEqual(1);
    // Entering the bfcache fires `pagehide`, which disposes the client and drops its capability; the
    // restored page used to be an inert shell, which read as the session dying (#198).
    const bootstrapSocketCount = await page.evaluate(() => {
      const count =
        (globalThis as typeof globalThis & { __ompRelaySocketCount?: number }).__ompRelaySocketCount ?? 0;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      return count;
    });
    expect(bootstrapSocketCount).toBeGreaterThanOrEqual(1);
    await expect(page.locator("#root > .sh-app")).toHaveCount(0);

    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    await expect(page.locator(".shell-title")).toHaveText(SESSION_TITLE);
    // Resume is a second launch, not a restored secret: the gateway is asked again for the same
    // instance, generation, mode, and still-pending request, and the new client opens its own
    // transport rather than reusing the dead one's.
    expect(fixture.launchRequests[1]).toEqual({
      instanceId: "standalone-launch-0001",
      generation: 1,
      mode: "control",
      requestId: "standalone-request-0001",
    });
    expect(await relaySocketCount(page)).toBeGreaterThan(bootstrapSocketCount);

    const residue = await page.evaluate(async () => ({
      url: location.href,
      historyState: JSON.stringify(history.state),
      localStorage: JSON.stringify({ ...localStorage }),
      sessionStorage: JSON.stringify({ ...sessionStorage }),
      cacheUrls: (await Promise.all((await caches.keys()).map(async name => {
        const cache = await caches.open(name);
        return (await cache.keys()).map(request => request.url);
      }))).flat(),
    }));
    expect(residue.url).toBe(`${fixture.origin}/`);
    expect(residue.historyState).not.toContain("standalone-launch-0001");
    expect(JSON.parse(residue.localStorage)).toEqual({
      "omp.collab.name": "guest",
      "omp.sessions.first-run.v1": JSON.stringify({ version: 1, step: "done", updatedAt: "2026-10-24T00:00:00.000Z" }),
    });
    expect(residue.sessionStorage).toBe("{}");
    expect(residue.cacheUrls.every(url => !url.includes("/api/") && !url.includes("/client/"))).toBe(true);
  } finally {
    await fixture.stop();
  }
});

test("a bfcache restore reopens a session whose question was answered elsewhere", { tag: "@core" }, async ({ page }) => {
  const active = session();
  const fixture = await startDashboardFixture([active, workingSession(0)]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    await page.locator(".queue-hero").getByRole("button", { name: "Open request" }).evaluate(
      button => (button as HTMLButtonElement).click(),
    );
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);

    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await expect(page.locator("#root > .sh-app")).toHaveCount(0);
    // Answered from the Mac while the phone was in the user's pocket. The request the shell was
    // opened for is gone, and the gateway rejects a launch that still claims it, so the resume has
    // to reopen the session plainly instead of failing on a question nobody is waiting on.
    fixture.upsert(answeredSession(active));

    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    expect(fixture.launchRequests[1]).toEqual({
      instanceId: "standalone-launch-0001",
      generation: 1,
      mode: "control",
    });
  } finally {
    await fixture.stop();
  }
});

/** Reports the page hidden or visible the way a backgrounded app does, with no page-lifecycle event. */
async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate(async next => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    // Let any teardown or render the change schedules land before the caller looks.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, state);
}

// Backgrounding an iPhone Home Screen app fires no `pagehide`: on real devices iOS 26.5 and 26.6 only
// reported the page hidden, then visible, and kept it alive (TestingBot, 2026-09-26). Visibility alone
// must never tear the client down, or returning strands an inert shell that no `pageshow` restores.
test("backgrounding without a pagehide keeps the open session", { tag: "@core" }, async ({ page }) => {
  const active = session();
  const fixture = await startDashboardFixture([active, workingSession(0)]);

  try {
    await installSilentWebSocket(page);
    await page.goto(fixture.origin);
    await page.locator(".queue-hero").getByRole("button", { name: "Open request" }).evaluate(
      button => (button as HTMLButtonElement).click(),
    );
    await expect(page.locator("#tray")).toHaveAttribute("data-layout", "expanded");
    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);

    await setVisibility(page, "hidden");
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    await setVisibility(page, "visible");

    await expect(page).toHaveURL(`${fixture.origin}/`);
    await expect(page.locator("#root > .sh-app")).toHaveCount(1);
    await expect(page.locator(".shell-title")).toHaveText(SESSION_TITLE);
  } finally {
    await fixture.stop();
  }
});
