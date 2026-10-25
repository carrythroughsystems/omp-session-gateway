import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { CollabEmbedState } from "../upstream/src/embed-contract";
import type { GuestClient, GuestSnapshot } from "../upstream/src/lib/client";
import { installDomGlobals, mount, query, restoreDomGlobals, unmountAll } from "./react-dom-harness";

installDomGlobals();
// Session's tool/theme modules read browser globals during initialization; install the harness first.
const { App, Session } = await import("../upstream/src/app");

function snapshot(patch: Partial<GuestSnapshot> = {}): GuestSnapshot {
  const health = { state: "healthy" as const, rttMs: 10, lastSuccessAt: 0, failureSince: null, retryAt: null };
  return {
    phase: "waiting", liveEpoch: 0, endedReason: null, header: null, entries: [], state: null,
    agents: [], progress: new Map(), lifecycle: new Map(), stream: null, streamDone: false,
    activeTools: new Map(), working: false, readOnly: false, uiRequest: null, uiResponsePending: false,
    gatewayHealth: health, relayHealth: health, notices: [], loading: null, ...patch,
  };
}

function guest(initial: GuestSnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
  const prompts: unknown[][] = [];
  const client = {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendPrompt: (...args: unknown[]) => prompts.push(args),
  } as unknown as GuestClient;
  return {
    client, prompts, listeners,
    async publish(patch: Partial<GuestSnapshot>): Promise<void> {
      current = { ...current, ...patch };
      await act(async () => { for (const listener of [...listeners]) listener(); });
    },
  };
}

beforeEach(installDomGlobals);
afterEach(unmountAll);
afterAll(restoreDomGlobals);

describe("embedded state publication", () => {
  test("publishes required null loading without a client and redacts invalid capability input", async () => {
    const states: CollabEmbedState[] = [];
    const capability = "SYNTHETIC_INVALID_CAPABILITY_DO_NOT_PUBLISH_7d13";
    await mount(createElement(App, {
      capability, onDispose: () => {},
      embedOptions: { shellOwnsLifecycle: true, onStateChange: state => states.push(state) },
    }));
    expect(states).toHaveLength(1);
    expect(states[0]!.phase).toBe("ended");
    expect(states[0]!.loading).toBeNull();
    expect(JSON.stringify(states)).not.toContain(capability);
  });

  test("publishes only snapshot counters across join, completion, reconnect and disposal", async () => {
    const loading = { received: 0, total: 100, entries: ["SYNTHETIC_TRANSCRIPT_EXCLUDED_FROM_EMBED_98af"] };
    const h = guest(snapshot({ loading }));
    const states: CollabEmbedState[] = [];
    const tree = await mount(createElement(Session, {
      client: h.client, onLeave: () => {}, onRejoin: () => {},
      embedOptions: { shellOwnsLifecycle: true, onStateChange: state => states.push(state) },
    }));
    expect(Object.keys(states[0]!).sort()).toEqual([
      "endedReason", "gatewayHealth", "loading", "phase", "relayHealth", "requestPending", "responsePending",
    ]);
    expect(states[0]!.loading).toEqual({ received: 0, total: 100 });
    expect(states[0]!.loading).not.toBe(loading);
    await h.publish({ loading: { ...loading, received: 43 } });
    await h.publish({ phase: "live", liveEpoch: 1, loading: null });
    await h.publish({ phase: "reconnecting", loading: null });
    await h.publish({ loading: { ...loading, received: 16 } });
    await h.publish({ phase: "live", liveEpoch: 2, loading: null });
    expect(states.map(state => state.loading)).toEqual([
      { received: 0, total: 100 }, { received: 43, total: 100 }, null, null, { received: 16, total: 100 }, null,
    ]);
    expect(JSON.stringify(states)).not.toContain(loading.entries[0]!);
    const count = states.length;
    await tree.unmount();
    expect(h.listeners.size).toBe(0);
    await h.publish({ phase: "ended" });
    expect(states).toHaveLength(count);
  });

  test("threads the optional draft callback through Session without sending or seeding during loading", async () => {
    const h = guest(snapshot({ loading: { received: 43, total: 100 } }));
    let takes = 0;
    const tree = await mount(createElement(Session, {
      client: h.client, onLeave: () => {}, onRejoin: () => {},
      embedOptions: { shellOwnsLifecycle: true, takeInitialPromptDraft: () => { takes += 1; return "Synthetic first task"; } },
    }));
    expect(takes).toBe(0);
    expect(query(tree.container, "sh-composer-input")!.value).toBe("");
    await h.publish({ phase: "live", liveEpoch: 1, loading: null });
    expect(takes).toBe(1);
    expect(query(tree.container, "sh-composer-input")!.value).toBe("Synthetic first task");
    await h.publish({ phase: "reconnecting", loading: { received: 80, total: 100 } });
    await h.publish({ phase: "live", liveEpoch: 2, loading: null });
    expect(takes).toBe(1);
    expect(query(tree.container, "sh-composer-input")!.value).toBe("Synthetic first task");
    expect(h.prompts).toEqual([]);
  });
});
