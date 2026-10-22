import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { GuestClient, GuestSnapshot } from "../upstream/src/lib/client";
import type { TranscriptProps } from "../upstream/src/components/transcript/Transcript";
import {
  type MiniElement,
  click,
  installDomGlobals,
  mount,
  query,
  queryAll,
  restoreDomGlobals,
  textOf,
  unmountAll,
} from "./react-dom-harness";

// The transcript pulls in the `<omp-tool-view>` custom element and the theme
// store, which both need browser globals while their modules initialize, so the
// harness above has to be in place before either module is loaded.
installDomGlobals();
const { TRANSCRIPT_WINDOW, TRANSCRIPT_WINDOW_STEP, Transcript } = await import(
  "../upstream/src/components/transcript/Transcript",
);
const { Composer } = await import("../upstream/src/components/shell/Composer");
const { Session } = await import("../upstream/src/app");

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };

function userEntry(index: number): SessionEntry {
  return {
    id: `entry-${index}`,
    parentId: null,
    timestamp: "2026-08-01T00:00:00.000Z",
    type: "message",
    message: { role: "user", content: `message ${index}`, timestamp: index },
  };
}

function userEntries(count: number): SessionEntry[] {
  return Array.from({ length: count }, (_unused, index) => userEntry(index));
}

function toolCallEntry(toolCallId: string): SessionEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "grep", arguments: { pattern: "needle" } }],
    model: "test/model",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: 0,
  };
  return { id: `call-${toolCallId}`, parentId: null, timestamp: "2026-08-01T00:00:00.000Z", type: "message", message };
}

function toolResultEntry(toolCallId: string, text: string): SessionEntry {
  return {
    id: `result-${toolCallId}`,
    parentId: null,
    timestamp: "2026-08-01T00:00:00.000Z",
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "grep",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    },
  };
}

function transcriptProps(entries: readonly SessionEntry[], overrides: Partial<TranscriptProps> = {}): TranscriptProps {
  return {
    entries,
    stream: null,
    streamDone: false,
    activeTools: new Map(),
    working: false,
    ...overrides,
  };
}

async function mountTranscript(props: TranscriptProps): Promise<{ root: MiniElement; render(next: TranscriptProps): Promise<void> }> {
  const tree = await mount(createElement(Transcript, props));
  const root = query(tree.container, "tr-root");
  if (root === null) throw new Error("transcript did not render a root");
  return { root, render: next => tree.render(createElement(Transcript, next)) };
}

function rowTexts(root: MiniElement): string[] {
  return queryAll(root, "tr-row").map(row => textOf(row));
}

afterEach(async () => {
  await unmountAll();
});

afterAll(() => {
  restoreDomGlobals();
});

describe("transcript windowing", () => {
  test("renders only the tail of a long transcript behind a Show earlier control", async () => {
    const { root } = await mountTranscript(transcriptProps(userEntries(460)));

    const rows = rowTexts(root);
    expect(rows.length).toBe(TRANSCRIPT_WINDOW);
    expect(rows[0]).toContain("message 310");
    expect(rows[rows.length - 1]).toContain("message 459");
    expect(textOf(root)).not.toContain("message 309");
    expect(query(root, "tr-earlier")?.textContent).toBe("Show earlier · 310 more");
  });

  test("leaves a transcript inside the window whole and unwrapped", async () => {
    const { root } = await mountTranscript(transcriptProps(userEntries(TRANSCRIPT_WINDOW)));

    expect(queryAll(root, "tr-row").length).toBe(TRANSCRIPT_WINDOW);
    expect(query(root, "tr-earlier")).toBeNull();
  });

  test("reveals one window step per tap and retires the control at the head", async () => {
    const { root } = await mountTranscript(transcriptProps(userEntries(460)));

    const earlier = query(root, "tr-earlier");
    expect(earlier).not.toBeNull();
    await click(earlier as MiniElement);

    expect(queryAll(root, "tr-row").length).toBe(TRANSCRIPT_WINDOW + TRANSCRIPT_WINDOW_STEP);
    expect(rowTexts(root)[0]).toContain("message 10");
    expect(query(root, "tr-earlier")?.textContent).toBe("Show earlier · 10 more");

    await click(query(root, "tr-earlier") as MiniElement);

    expect(queryAll(root, "tr-row").length).toBe(460);
    expect(rowTexts(root)[0]).toContain("message 0");
    expect(query(root, "tr-earlier")).toBeNull();
  });

  test("holds the reader's anchor when a tap mounts older rows above them", async () => {
    const { root } = await mountTranscript(transcriptProps(userEntries(460)));

    // Mounting bottom-locks; the reader then scrolls back up into the window.
    expect(root.scrollTop).toBe(root.scrollHeight);
    const height = root.scrollHeight;
    root.scrollTop = height - 2000;

    await click(query(root, "tr-earlier") as MiniElement);

    expect(root.scrollHeight).toBeGreaterThan(height);
    // Same content still sits under the viewport top, and the bottom lock did
    // not re-engage and drag the reader to the tail.
    expect(root.scrollHeight - root.scrollTop).toBe(2000);
    expect(root.scrollTop).not.toBe(root.scrollHeight);
  });

  test("holds a prepended row anchor when the same render also appends a live entry", async () => {
    const entries = userEntries(460);
    const { root, render } = await mountTranscript(transcriptProps(entries));
    root.scrollTop = 400;
    await act(async () => {
      for (const listener of root.listeners.get("scroll") ?? []) listener({ type: "scroll", target: root });
    });
    const top = root.getBoundingClientRect().top;
    const anchor = queryAll(root, "tr-row").find(row => row.getBoundingClientRect().bottom > top);
    if (anchor === undefined) throw new Error("visible row missing");
    const offset = anchor.getBoundingClientRect().top - top;
    await act(async () => {
      await click(query(root, "tr-earlier") as MiniElement);
      await render(transcriptProps([...entries, userEntry(460)]));
    });
    expect(anchor.isConnected).toBeTrue();
    expect(anchor.getBoundingClientRect().top - root.getBoundingClientRect().top).toBe(offset);
    expect(rowTexts(root).at(-1)).toContain("message 460");
  });

  test("extends the window on a tail append instead of dropping the oldest row", async () => {
    const entries = userEntries(200);
    const { root, render } = await mountTranscript(transcriptProps(entries));
    const oldest = rowTexts(root)[0];

    await render(transcriptProps([...entries, userEntry(200), userEntry(201)]));

    expect(queryAll(root, "tr-row").length).toBe(TRANSCRIPT_WINDOW + 2);
    expect(rowTexts(root)[0]).toBe(oldest);
    expect(query(root, "tr-earlier")?.textContent).toBe("Show earlier · 50 more");
  });

  test("re-windows to the tail when a welcome replaces the transcript wholesale", async () => {
    const { root, render } = await mountTranscript(transcriptProps(userEntries(200)));

    const replacement = userEntries(400).map(entry => ({ ...entry, id: `rejoined-${entry.id}` }));
    await render(transcriptProps(replacement));

    expect(queryAll(root, "tr-row").length).toBe(TRANSCRIPT_WINDOW);
    expect(rowTexts(root)[0]).toContain("message 250");
    expect(query(root, "tr-earlier")?.textContent).toBe("Show earlier · 250 more");
  });

  test("windows the compact agent-drawer transcript too", async () => {
    const { root } = await mountTranscript(transcriptProps(userEntries(200), { compact: true }));

    expect(root.attributes.class).toContain("tr-root--compact");
    expect(queryAll(root, "tr-row").length).toBe(TRANSCRIPT_WINDOW);
    expect(query(root, "tr-earlier")?.textContent).toBe("Show earlier · 50 more");
  });

  test("pairs a windowed assistant row with a tool result held outside the window", async () => {
    // Pairing is keyed by toolCallId over the whole log, so where the log keeps
    // the result entry — here older than the window — cannot matter.
    const { root } = await mountTranscript(
      transcriptProps([toolResultEntry("call-1", "42 matches"), ...userEntries(200), toolCallEntry("call-1")]),
    );

    expect(queryAll(root, "tr-row").length).toBe(TRANSCRIPT_WINDOW);
    expect(query(root, "tv-status--ok")).not.toBeNull();
    expect(query(root, "tv-status--pending")).toBeNull();

    await click(query(root, "tv-head") as MiniElement);
    expect(textOf(root)).toContain("42 matches");
  });

  test("keeps an out-of-window tool call from duplicating as an active tail card", async () => {
    const activeTools = new Map([
      ["call-old", { toolCallId: "call-old", toolName: "grep", args: {}, startedAt: 0 }],
    ]);
    const { root } = await mountTranscript(
      transcriptProps([toolCallEntry("call-old"), ...userEntries(200)], { activeTools, working: true }),
    );

    expect(queryAll(root, "tr-row").length).toBe(TRANSCRIPT_WINDOW);
    expect(queryAll(root, "tv-card").length).toBe(0);
  });
});

class FakeGuest {
  #snapshot: GuestSnapshot;
  readonly #listeners = new Set<() => void>();

  constructor(snapshot: GuestSnapshot) {
    this.#snapshot = snapshot;
  }

  getSnapshot = (): GuestSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async publish(patch: Partial<GuestSnapshot>): Promise<void> {
    this.#snapshot = { ...this.#snapshot, ...patch };
    await act(async () => {
      for (const listener of [...this.#listeners]) listener();
    });
  }

  get client(): GuestClient {
    return this as unknown as GuestClient;
  }
}

function guestSnapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
  return {
    phase: "connecting",
    endedReason: null,
    header: null,
    entries: [],
    state: null,
    agents: [],
    progress: new Map(),
    lifecycle: new Map(),
    stream: null,
    streamDone: false,
    activeTools: new Map(),
    working: false,
    readOnly: false,
    uiRequest: null,
    uiResponsePending: false,
    gatewayHealth: { state: "healthy", rttMs: 20, lastSuccessAt: 0, failureSince: null, retryAt: null },
    relayHealth: { state: "healthy", rttMs: 30, lastSuccessAt: 0, failureSince: null, retryAt: null },
    notices: [],
    loading: null,
    ...overrides,
  };
}

describe("photo source chooser", () => {
  test("routes explicit camera and library choices to separate inputs", async () => {
    const guest = new FakeGuest(guestSnapshot({ phase: "live" }));
    const tree = await mount(
      createElement(Composer, {
        client: guest.client,
        snapshot: guest.getSnapshot(),
        embedded: true,
      }),
    );
    const trigger = query(tree.container, "sh-photo-trigger");
    const cameraInput = query(tree.container, "sh-photo-input-camera");
    const libraryInput = query(tree.container, "sh-photo-input-library");
    if (trigger === null || cameraInput === null || libraryInput === null) {
      throw new Error("photo chooser controls did not render");
    }
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(cameraInput.getAttribute("capture")).toBe("environment");
    expect(libraryInput.getAttribute("capture")).toBeNull();

    let cameraClicks = 0;
    let libraryClicks = 0;
    (cameraInput as MiniElement & { click(): void }).click = () => {
      cameraClicks += 1;
    };
    (libraryInput as MiniElement & { click(): void }).click = () => {
      libraryClicks += 1;
    };

    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const choices = queryAll(tree.container, "sh-photo-source-option");
    expect(choices.map(choice => textOf(choice))).toEqual([
      "Take photoOpen rear camera",
      "Choose existingPhoto library or files",
    ]);
    await click(choices[0] as MiniElement);
    expect(cameraClicks).toBe(1);
    expect(libraryClicks).toBe(0);
    expect(query(tree.container, "sh-photo-source-options")).toBeNull();

    await click(trigger);
    await click(queryAll(tree.container, "sh-photo-source-option")[1] as MiniElement);
    expect(cameraClicks).toBe(1);
    expect(libraryClicks).toBe(1);
    expect(query(tree.container, "sh-photo-source-options")).toBeNull();
  });
});

describe("embedded session first paint", () => {
  test("returns a reader to the transcript tail when a recovered connection becomes live", async () => {
    const guest = new FakeGuest(guestSnapshot({ phase: "live", entries: userEntries(200) }));
    const tree = await mount(
      createElement(Session, {
        client: guest.client,
        onLeave: () => {},
        onRejoin: () => {},
        embedOptions: { shellOwnsLifecycle: true },
      }),
    );
    const root = query(tree.container, "tr-root");
    if (root === null) throw new Error("live transcript did not render");
    expect(root.scrollTop).toBe(root.scrollHeight);

    root.scrollTop = 0;
    await act(async () => {
      for (const listener of root.listeners.get("scroll") ?? []) listener({ type: "scroll", target: root });
    });
    await guest.publish({ phase: "reconnecting" });
    expect(root.scrollTop).toBe(0);

    await guest.publish({ phase: "live" });
    expect(root.scrollTop).toBe(root.scrollHeight);
  });

  test("keeps the published transcript mounted across loading and reconnect without competing chrome", async () => {
    const guest = new FakeGuest(guestSnapshot({ loading: { received: 0, total: 1200 } }));
    const tree = await mount(
      createElement(Session, {
        client: guest.client,
        onLeave: () => {},
        onRejoin: () => {},
        embedOptions: { shellOwnsLifecycle: true },
      }),
    );

    // Upstream buffers chunks in GuestClient rather than hiding the transcript.
    const root = query(tree.container, "tr-root") as MiniElement;
    expect(rowTexts(root)).toEqual([]);
    expect(query(root, "tr-empty")).toBeNull();
    expect(query(tree.container, "sh-composer")).not.toBeNull();

    await guest.publish({ phase: "live", entries: userEntries(1200), loading: null });
    expect(query(tree.container, "tr-root")).toBe(root);
    expect(rowTexts(root).at(-1)).toContain("message 1199");

    // A reconnect must not blank a transcript the reader already has.
    for (const phase of ["reconnecting", "waiting", "live", "ended"] as const) {
      await guest.publish({ phase });
      expect(query(tree.container, "tr-root")).toBe(root);
      expect(rowTexts(root).at(-1)).toContain("message 1199");
      for (const chrome of ["sh-header", "sh-rail", "sh-connect", "sh-banner", "sh-overlay"]) {
        expect(query(tree.container, chrome)).toBeNull();
      }
    }
  });
});
