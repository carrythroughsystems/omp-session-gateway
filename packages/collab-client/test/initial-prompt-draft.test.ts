import type { ImageContent, SessionEntry } from "@oh-my-pi/pi-wire";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { Composer, type ComposerProps } from "../upstream/src/components/shell/Composer";
import type { GuestClient } from "../upstream/src/lib/client";
import * as photoAttachment from "../upstream/src/lib/photo-attachment";
import { click, dispatch, installDomGlobals, mount, query, restoreDomGlobals, unmountAll, type MiniElement, type MountedTree } from "./react-dom-harness";

const INITIAL_DRAFT = "SYNTHETIC_FIRST_TASK_DRAFT_NOT_FOR_STORAGE_73b5";
const PHOTO: ImageContent = { type: "image", mimeType: "image/jpeg", data: "synthetic-normalized-photo" };

function harness() {
  const prompts: unknown[][] = [];
  const responses: unknown[][] = [];
  let takes = 0;
  const take = (): string => { takes += 1; return INITIAL_DRAFT; };
  const props: ComposerProps = {
    client: {
      sendPrompt: (...args: unknown[]) => prompts.push(args),
      sendUiResponse: (...args: unknown[]) => responses.push(args),
      sendAbort: () => {},
    } as unknown as GuestClient,
    phase: "live", readOnly: false, relayReady: true, uiRequest: null,
    working: false, queuedMessageCount: 0, uiResponsePending: false,
    entries: [], recommendedIndex: undefined, embedded: true,
  };
  return {
    prompts, responses, take,
    get takes() { return takes; },
    node: (patch: Partial<ComposerProps> = {}) => createElement(Composer, { ...props, ...patch }),
  };
}

async function type(input: MiniElement, value: string): Promise<void> {
  input.value = value;
  await dispatch(input, "input");
}

async function attachPhoto(tree: MountedTree): Promise<void> {
  const input = query(tree.container, "sh-photo-input-library")!;
  Object.assign(input, { files: [new File(["synthetic-image"], "fixture.png", { type: "image/png" })] });
  await dispatch(input, "change");
}

beforeEach(installDomGlobals);
afterEach(async () => { await unmountAll(); });
afterAll(restoreDomGlobals);

describe("one-shot initial ordinary prompt draft", () => {
  test("drains once without submitting, including strict effects, reconnects, Ask transitions and clearing", async () => {
    const h = harness();
    const node = (patch: Partial<ComposerProps> = {}) => createElement(StrictMode, null, h.node({ takeInitialPromptDraft: h.take, ...patch }));
    const tree = await mount(node());
    const input = query(tree.container, "sh-composer-input")!;
    expect(input.value).toBe(INITIAL_DRAFT);
    expect(h.takes).toBe(1);
    await type(input, "edited by the user");
    await tree.render(node({ phase: "reconnecting" }));
    await tree.render(node());
    expect(query(tree.container, "sh-composer-input")!.value).toBe("edited by the user");
    await tree.render(node({ uiRequest: { kind: "editor", reqId: 9, title: "Ask", prefill: "Ask's own draft" } }));
    expect(query(tree.container, "sh-composer-input")!.value).toBe("Ask's own draft");
    await tree.render(node());
    expect(query(tree.container, "sh-composer-input")!.value).toBe("edited by the user");
    await type(query(tree.container, "sh-composer-input")!, "");
    await tree.render(node({ takeInitialPromptDraft: () => { throw new Error("draft was already drained"); } }));
    expect(query(tree.container, "sh-composer-input")!.value).toBe("");
    expect(h.takes).toBe(1);
    expect(h.prompts).toEqual([]);
    expect(h.responses).toEqual([]);
  });

  for (const phase of ["connecting", "waiting", "reconnecting", "ended"] as const) {
    test(`does not drain while ${phase}`, async () => {
      const h = harness();
      const tree = await mount(h.node({ takeInitialPromptDraft: h.take, phase }));
      expect(h.takes).toBe(0);
      expect(query(tree.container, "sh-composer-input")!.value).toBe("");
      await tree.render(h.node({ takeInitialPromptDraft: h.take }));
      expect(h.takes).toBe(1);
      expect(query(tree.container, "sh-composer-input")!.value).toBe(INITIAL_DRAFT);
      expect(h.prompts).toEqual([]);
    });
  }

  for (const [name, patch] of [
    ["View", { readOnly: true }],
    ["unhealthy relay", { relayReady: false }],
    ["active editor Ask", { uiRequest: { kind: "editor", reqId: 7, title: "Other", prefill: "keep Ask draft" } }],
    ["active select Ask", { uiRequest: { kind: "select", reqId: 8, title: "Choose", options: ["One"] } }],
  ] satisfies [string, Partial<ComposerProps>][]) {
    test(`does not drain into ${name}`, async () => {
      const h = harness();
      const tree = await mount(h.node({ takeInitialPromptDraft: h.take, ...patch }));
      expect(h.takes).toBe(0);
      if (patch.uiRequest?.kind === "editor") expect(query(tree.container, "sh-composer-input")!.value).toBe("keep Ask draft");
      await tree.render(h.node({ takeInitialPromptDraft: h.take }));
      expect(query(tree.container, "sh-composer-input")!.value).toBe(INITIAL_DRAFT);
      expect(h.takes).toBe(1);
      expect(h.prompts).toEqual([]);
      expect(h.responses).toEqual([]);
    });
  }

  for (const existing of ["existing ordinary draft", "   "]) {
    test(`never overwrites an existing ${existing.trim() === "" ? "whitespace" : "text"} draft`, async () => {
      const h = harness();
      const tree = await mount(h.node());
      await type(query(tree.container, "sh-composer-input")!, existing);
      await tree.render(h.node({ takeInitialPromptDraft: h.take }));
      expect(query(tree.container, "sh-composer-input")!.value).toBe(existing);
      expect(h.takes).toBe(0);
      await type(query(tree.container, "sh-composer-input")!, "");
      expect(query(tree.container, "sh-composer-input")!.value).toBe(INITIAL_DRAFT);
      expect(h.takes).toBe(1);
      expect(h.prompts).toEqual([]);
    });
  }

  test("does not retry an empty holder or an empty string, even with a replacement callback", async () => {
    for (const result of [undefined, ""]) {
      const h = harness();
      let takes = 0;
      const tree = await mount(h.node({ takeInitialPromptDraft: () => { takes += 1; return result; } }));
      await tree.render(h.node({ takeInitialPromptDraft: h.take }));
      expect(takes).toBe(1);
      expect(h.takes).toBe(0);
      expect(query(tree.container, "sh-composer-input")!.value).toBe("");
      expect(h.prompts).toEqual([]);
      await tree.unmount();
    }
  });

  test("defers draining during photo preparation and never delivers after disposal", async () => {
    const photo = Promise.withResolvers<photoAttachment.PreparedPhoto>();
    const prepare = spyOn(photoAttachment, "preparePhotoAttachment").mockReturnValue(photo.promise);
    try {
      const h = harness();
      const tree = await mount(h.node());
      await attachPhoto(tree);
      expect(query(tree.container, "sh-photo-preparing")).not.toBeNull();
      await tree.render(h.node({ takeInitialPromptDraft: h.take }));
      expect(h.takes).toBe(0);
      await tree.unmount();
      await act(async () => photo.resolve({ content: PHOTO }));
      expect(h.takes).toBe(0);
      expect(h.prompts).toEqual([]);
    } finally { prepare.mockRestore(); }
  });

  test("preserves a photo draft until the user removes it", async () => {
    const prepare = spyOn(photoAttachment, "preparePhotoAttachment").mockResolvedValue({ content: PHOTO });
    try {
      const h = harness();
      const tree = await mount(h.node());
      await attachPhoto(tree);
      expect(query(tree.container, "sh-photo")).not.toBeNull();
      await tree.render(h.node({ takeInitialPromptDraft: h.take }));
      expect(h.takes).toBe(0);
      expect(query(tree.container, "sh-composer-input")!.value).toBe("");
      await click(query(tree.container, "sh-photo-remove")!);
      expect(query(tree.container, "sh-composer-input")!.value).toBe(INITIAL_DRAFT);
      expect(h.takes).toBe(1);
      expect(h.prompts).toEqual([]);
    } finally { prepare.mockRestore(); }
  });

  test("does not drain while a photo send awaits its transcript acknowledgement", async () => {
    const prepare = spyOn(photoAttachment, "preparePhotoAttachment").mockResolvedValue({ content: PHOTO });
    try {
      const h = harness();
      const tree = await mount(h.node());
      await attachPhoto(tree);
      await click(query(tree.container, "sh-btn-primary")!);
      await tree.render(h.node({ takeInitialPromptDraft: h.take }));
      expect(query(tree.container, "sh-photo-send-state")!.textContent).toBe("Sending photo…");
      expect(h.takes).toBe(0);
      const acknowledgement: SessionEntry = {
        id: "synthetic-photo-ack", parentId: null, timestamp: "2026-10-24T00:00:00.000Z",
        type: "custom_message", customType: "collab-prompt", display: true,
        content: [{ type: "text", text: "Please inspect this photo." }, PHOTO], details: { from: "guest" },
      };
      await tree.render(h.node({ takeInitialPromptDraft: h.take, entries: [acknowledgement] }));
      expect(h.takes).toBe(1);
      expect(query(tree.container, "sh-composer-input")!.value).toBe(INITIAL_DRAFT);
      expect(h.prompts).toEqual([["Please inspect this photo.", [PHOTO]]]);
      expect(h.responses).toEqual([]);
    } finally { prepare.mockRestore(); }
  });

  test("a drained shell holder cannot seed a subsequent mount", async () => {
    const h = harness();
    let holder: string | undefined = INITIAL_DRAFT;
    const take = (): string | undefined => { const draft = holder; holder = undefined; return draft; };
    const first = await mount(h.node({ takeInitialPromptDraft: take }));
    expect(query(first.container, "sh-composer-input")!.value).toBe(INITIAL_DRAFT);
    await first.unmount();
    const second = await mount(h.node({ takeInitialPromptDraft: take }));
    expect(query(second.container, "sh-composer-input")!.value).toBe("");
    expect(h.prompts).toEqual([]);
  });
});
