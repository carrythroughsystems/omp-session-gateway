import type { AssistantMessage, ImageContent, SessionEntry } from "@oh-my-pi/pi-wire";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer, type ComposerProps, photoPromptAcknowledged, shouldSubmitOnEnter } from "../upstream/src/components/shell/Composer";
import { recommendedOptionIndex } from "../upstream/src/components/shell/ask-recommendation";
import { GuestClient, type ActiveTool, type GuestSnapshot } from "../upstream/src/lib/client";
import { encodeBase64Url } from "../upstream/src/lib/link";
import { installDomGlobals, restoreDomGlobals } from "./react-dom-harness";

const QUESTION = "How should ADR-0036 proceed?";
const OPTIONS = [
  { label: "Implement ADR-0036 locally", description: "Apply the compatibility fix in the gateway." },
  { label: "Wait for upstream", description: "Leave the current behavior unchanged." },
];

function composerProps(uiRequest: ComposerProps["uiRequest"]): ComposerProps {
  return {
    client: new GuestClient(`roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`, "tester"),
    phase: "live", readOnly: false, uiRequest, working: true, queuedMessageCount: 0,
    entries: [], recommendedIndex: undefined, uiResponsePending: false, relayReady: true,
  };
}

describe("upstream composer field contract", () => {
  beforeEach(() => installDomGlobals());
  afterEach(() => restoreDomGlobals());
  test("renders selectable Ask responses for mobile guests", () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({
      reqId: 1, kind: "select", title: "Continue?",
      options: ["Yes", { label: "No", description: "Stop here" }], selectionMarker: "radio",
    })));
    expect(html).toContain("Continue?");
    expect(html).toContain("Yes");
    expect(html).toContain("Stop here");
  });

  test("renders a submit field for custom Ask responses", () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({
      reqId: 2, kind: "editor", title: "Other", prefill: "draft",
    })));
    expect(html).toContain("Other");
    expect(html).toContain("draft");
    expect(html).toContain("Submit");
  });

  test("keeps the editor submit enabled for whitespace-only drafts", () => {
    const html = renderToStaticMarkup(createElement(Composer, composerProps({
      reqId: 3, kind: "editor", title: "Other", prefill: "   ",
    })));
    const submit = { found: false, disabled: false };
    new HTMLRewriter().on('button[title="submit response"]', {
      element(el) { submit.found = true; submit.disabled = el.hasAttribute("disabled"); },
    }).transform(html);
    expect(submit).toEqual({ found: true, disabled: false });
  });
});

describe("composer Enter and composition guard", () => {
  for (const [key, shiftKey, isComposing, composing, expected] of [
    ["Enter", false, false, false, true],
    ["Enter", true, false, false, false],
    ["Enter", false, true, false, false],
    ["Enter", false, false, true, false],
    ["Enter", false, true, true, false],
    ["Process", false, false, false, false],
    ["a", false, false, false, false],
  ] as const) {
    test(`${key} shift=${shiftKey} native composition=${isComposing} deferred composition=${composing}`, () => {
      const event = { key, shiftKey, nativeEvent: { isComposing } } as KeyboardEvent<HTMLTextAreaElement>;
      expect(shouldSubmitOnEnter(event, composing)).toBe(expected);
    });
  }
});

function askArgs(recommended?: number): Record<string, unknown> {
  return {
    questions: [
      {
        id: "adr-0036",
        question: QUESTION,
        options: OPTIONS,
        multi: false,
        ...(recommended === undefined ? {} : { recommended }),
      },
    ],
  };
}

function assistantEntry(toolCallId: string, args: Record<string, unknown>): SessionEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "ask", arguments: args }],
    model: "test/model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
  return {
    id: `entry-${toolCallId}`,
    parentId: null,
    timestamp: "2026-07-25T00:00:00.000Z",
    type: "message",
    message,
  };
}

function toolResultEntry(toolCallId: string): SessionEntry {
  return {
    id: `result-${toolCallId}`,
    parentId: `entry-${toolCallId}`,
    timestamp: "2026-07-25T00:00:01.000Z",
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "ask",
      content: [{ type: "text", text: "answered" }],
      isError: false,
      timestamp: 1,
    },
  };
}

function activeAsk(toolCallId: string, args: Record<string, unknown>): ActiveTool {
  return { toolCallId, toolName: "ask", args, startedAt: 0 };
}

const PHOTO: ImageContent = { type: "image", data: "normalized-photo", mimeType: "image/jpeg" };

function photoPromptEntry(id: string, text: string, image: ImageContent = PHOTO): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: "2026-07-25T00:00:02.000Z",
    type: "custom_message",
    customType: "collab-prompt",
    content: [{ type: "text", text }, image],
    details: { from: "guest" },
    display: true,
  };
}

function snapshot(overrides: Partial<GuestSnapshot> = {}): GuestSnapshot {
  return {
    phase: "live",
    liveEpoch: 1,
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
    working: true,
    readOnly: false,
    uiRequest: {
      reqId: 7,
      kind: "select",
      title: QUESTION,
      options: OPTIONS,
      initialIndex: 0,
      selectionMarker: "radio",
    },
	uiResponsePending: false,
	gatewayHealth: { state: "healthy", rttMs: 20, lastSuccessAt: 0, failureSince: null, retryAt: null },
	relayHealth: { state: "healthy", rttMs: 30, lastSuccessAt: 0, failureSince: null, retryAt: null },
    notices: [],
    loading: null,
    ...overrides,
  };
}

describe("collaboration ask recommendations", () => {
  test("finds an explicit recommendation on the matching active option", () => {
    const current = snapshot({
      activeTools: new Map([["ask-active", activeAsk("ask-active", askArgs(0))]]),
    });

    expect(recommendedOptionIndex(current)).toBe(0);
  });

  test("recovers recommendation metadata from an unresolved persisted tool call after late join", () => {
    const current = snapshot({ entries: [assistantEntry("ask-persisted", askArgs(1))] });

    expect(recommendedOptionIndex(current)).toBe(1);
  });

  test("does not mistake initialIndex or a resolved historical ask for a recommendation", () => {
    const current = snapshot({
      entries: [assistantEntry("ask-old", askArgs(0)), toolResultEntry("ask-old")],
      activeTools: new Map([["ask-current", activeAsk("ask-current", askArgs())]]),
    });

    expect(recommendedOptionIndex(current)).toBeUndefined();
  });
});

describe("photo prompt acknowledgements", () => {
  const pending = { text: "Please inspect this photo.", images: [PHOTO], afterEntryId: "baseline" };

  test("never lets an older identical entry replace a missing baseline", () => {
    expect(photoPromptAcknowledged([photoPromptEntry("older", pending.text)], pending)).toBeFalse();
  });

  test("requires an exact matching entry after the baseline", () => {
    const entries = [
      photoPromptEntry("baseline", "Earlier prompt"),
      photoPromptEntry("wrong", pending.text, { ...PHOTO, data: "different-photo" }),
      photoPromptEntry("acknowledged", pending.text),
    ];
    expect(photoPromptAcknowledged(entries, pending)).toBeTrue();
    expect(photoPromptAcknowledged(entries.slice(0, 2), pending)).toBeFalse();
  });

  test("accepts the first exact entry when the send had no baseline", () => {
    expect(
      photoPromptAcknowledged([photoPromptEntry("acknowledged", pending.text)], {
        ...pending,
        afterEntryId: null,
      }),
    ).toBeTrue();
  });
});

