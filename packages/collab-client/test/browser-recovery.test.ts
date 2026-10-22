import { describe, expect, test } from "bun:test";
import type { GatewayProbeResult } from "../upstream/src/embed-contract";
import type { PathHealth } from "../upstream/src/lib/client";
import {
  installBrowserConnectionRecovery,
  type BrowserRecoveryEnvironment,
} from "../upstream/src/lib/browser-recovery";

class FakeRecoveryWindow extends EventTarget {
  readonly timers = new Map<number, { callback: () => void; delay: number }>();
  now = 1_000;
  #nextTimer = 1;

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  setTimeout(callback: () => void, delay = 0): number {
    const handle = this.#nextTimer;
    this.#nextTimer += 1;
    this.timers.set(handle, { callback, delay });
    return handle;
  }

  pendingDelays(): number[] {
    return [...this.timers.values()].map(timer => timer.delay).sort((left, right) => left - right);
  }

  runNextTimer(): void {
    const next = [...this.timers.entries()].sort(([, left], [, right]) => left.delay - right.delay)[0];
    if (next === undefined) throw new Error("missing recovery timer");
    const [handle, timer] = next;
    this.timers.delete(handle);
    this.now += timer.delay;
    timer.callback();
  }
}

class FakeRecoveryDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface RecoveryHarness {
  readonly connection: EventTarget;
  readonly document: FakeRecoveryDocument;
  readonly deferredAborts: Array<() => void>;
  readonly environment: BrowserRecoveryEnvironment;
  readonly fetches: Array<{ input: string; init: RequestInit | undefined }>;
  readonly health: PathHealth[];
  readonly refreshed: { count: number };
  readonly relayMeasurements: { count: number };
  readonly window: FakeRecoveryWindow;
}

function recoveryHarness(results: readonly (boolean | "hang" | "deferred-abort")[]): RecoveryHarness {
  const connection = new EventTarget();
  const document = new FakeRecoveryDocument();
  const window = new FakeRecoveryWindow();
  const fetches: Array<{ input: string; init: RequestInit | undefined }> = [];
  const deferredAborts: Array<() => void> = [];
  const health: PathHealth[] = [];
  const refreshed = { count: 0 };
  const relayMeasurements = { count: 0 };
  const responses = [...results];
  const environment: BrowserRecoveryEnvironment = {
    connection,
    document,
    now: () => window.now,
    random: () => 0.5,
    window,
    async fetch(input, init): Promise<Response> {
      fetches.push({ input: String(input), init });
      const result = responses.shift();
      if (result === "hang" || result === "deferred-abort") {
        return await new Promise<Response>((_resolve, reject) => {
          const abort = (): void => reject(new DOMException("probe timed out", "AbortError"));
          const handleAbort = result === "deferred-abort"
            ? (): void => { deferredAborts.push(abort); }
            : abort;
          if (init?.signal?.aborted === true) handleAbort();
          else init?.signal?.addEventListener("abort", handleAbort, { once: true });
        });
      }
      return new Response(null, { status: result === false ? 503 : 200 });
    },
  };
  return { connection, deferredAborts, document, environment, fetches, health, refreshed, relayMeasurements, window };
}

function installInjectedRecovery(
  harness: RecoveryHarness,
  probeGateway: (signal: AbortSignal) => Promise<GatewayProbeResult>,
): () => void {
  return installBrowserConnectionRecovery(
    () => { harness.refreshed.count += 1; },
    harness.environment,
    state => harness.health.push(state),
    () => { harness.relayMeasurements.count += 1; },
    undefined,
    probeGateway,
  );
}

describe("collaboration browser network recovery", () => {
  test("uses a connection change only to trigger gateway and relay measurements", async () => {
    const harness = recoveryHarness([true, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.window.pendingDelays()).toEqual([15_000]);

    harness.connection.dispatchEvent(new Event("change"));
    expect(harness.health.at(-1)?.state).toBe("healthy");
    await settle();
    expect(harness.refreshed.count).toBe(0);
    expect(harness.relayMeasurements.count).toBe(1);
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.window.pendingDelays()).toEqual([15_000]);
    expect(harness.fetches).toHaveLength(2);
    expect(harness.fetches[1]?.init?.cache).toBe("no-store");

    dispose();
    expect(harness.window.timers.size).toBe(0);
  });

  test("discards an event-cancelled probe before measuring the replacement", async () => {
    const harness = recoveryHarness(["hang", true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
    );

    harness.window.runNextTimer();
    await settle();
    harness.window.dispatchEvent(new Event("offline"));
    await settle();
    expect(harness.health.map(state => state.state)).toEqual(["checking"]);
    expect(harness.window.pendingDelays()).toEqual([0]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.refreshed.count).toBe(0);
    expect(harness.relayMeasurements.count).toBe(1);

    dispose();
  });

  test("discards a hide-cancelled probe after rapid foregrounding", async () => {
    const harness = recoveryHarness(["deferred-abort", true]);
    const relayPauses: boolean[] = [];
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
      paused => relayPauses.push(paused),
    );

    harness.window.runNextTimer();
    await settle();
    harness.document.visibilityState = "hidden";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    expect(harness.deferredAborts).toHaveLength(1);

    harness.document.visibilityState = "visible";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    harness.deferredAborts.shift()?.();
    await settle();
    expect(harness.health.map(state => state.state)).toEqual(["checking"]);
    expect(relayPauses).toEqual([false, true]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(relayPauses).toEqual([false, true, false]);
    expect(harness.relayMeasurements.count).toBe(1);

    dispose();
  });

  test("pauses relay probes while hidden and remeasures after foregrounding", async () => {
    const harness = recoveryHarness([true, true]);
    const relayPauses: boolean[] = [];
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
      paused => relayPauses.push(paused),
    );

    harness.window.runNextTimer();
    await settle();
    harness.document.visibilityState = "hidden";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    expect(harness.window.timers.size).toBe(0);

    harness.document.visibilityState = "visible";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(relayPauses).toEqual([false, true, false]);
    expect(harness.relayMeasurements.count).toBe(1);
    expect(harness.health.at(-1)?.state).toBe("healthy");

    dispose();
    expect(relayPauses.at(-1)).toBe(true);
  });

  test("keeps relay probes paused until foreground gateway recovery succeeds", async () => {
    const harness = recoveryHarness([true, false, true, true]);
    const relayPauses: boolean[] = [];
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
      () => {
        harness.relayMeasurements.count += 1;
      },
      paused => relayPauses.push(paused),
    );

    harness.window.runNextTimer();
    await settle();
    harness.document.visibilityState = "hidden";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    harness.document.visibilityState = "visible";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");
    expect(relayPauses).toEqual([false, true]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(relayPauses).toEqual([false, true]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(relayPauses).toEqual([false, true, false]);
    expect(harness.relayMeasurements.count).toBe(1);

    dispose();
  });

  test("uses hysteresis and full jitter across a measured gateway outage", async () => {
    const harness = recoveryHarness([false, false, true, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");
    expect(harness.window.pendingDelays()).toEqual([2_000]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("unreachable");
    expect((harness.health.at(-1)?.retryAt ?? 0) - harness.window.now).toBe(1_000);
    expect(harness.window.pendingDelays()).toEqual([1_000]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(harness.refreshed.count).toBe(1);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.refreshed.count).toBe(1);

    dispose();
  });

  test("recovers after an offline signal without waiting for an online event", async () => {
    const harness = recoveryHarness([true, false, true, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");

    harness.window.dispatchEvent(new Event("offline"));
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");

    harness.connection.dispatchEvent(new Event("change"));
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(harness.refreshed.count).toBe(1);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.fetches).toHaveLength(4);

    dispose();
  });

  test("uses the injected selected-gateway probe without fetching same-origin health", async () => {
    const harness = recoveryHarness([]);
    const signals: AbortSignal[] = [];
    const dispose = installInjectedRecovery(harness, async signal => {
      signals.push(signal);
      return "healthy";
    });

    harness.window.runNextTimer();
    await settle();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.window.pendingDelays()).toEqual([15_000]);

    harness.connection.dispatchEvent(new Event("change"));
    await settle();
    expect(signals).toHaveLength(2);
    expect(harness.fetches).toHaveLength(0);
    expect(harness.refreshed.count).toBe(0);
    expect(harness.relayMeasurements.count).toBe(1);
    expect(harness.window.pendingDelays()).toEqual([15_000]);

    dispose();
  });

  test("stops forbidden recovery until a visible, pageshow, or online transition probes once", async () => {
    const harness = recoveryHarness([]);
    let probes = 0;
    const dispose = installInjectedRecovery(harness, async () => {
      probes += 1;
      return "forbidden";
    });

    harness.window.runNextTimer();
    harness.connection.dispatchEvent(new Event("change"));
    await settle();
    expect(harness.health.map(state => state.state)).toEqual(["checking", "forbidden"]);
    expect(harness.health.at(-1)?.failureSince).toBe(1_000);
    expect(harness.health.at(-1)?.retryAt).toBeNull();
    expect(harness.window.pendingDelays()).toEqual([]);
    expect(probes).toBe(1);

    harness.connection.dispatchEvent(new Event("change"));
    harness.window.dispatchEvent(new Event("offline"));
    await settle();
    expect(probes).toBe(1);
    expect(harness.window.pendingDelays()).toEqual([]);

    harness.document.visibilityState = "hidden";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    expect(probes).toBe(1);
    harness.document.visibilityState = "visible";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(probes).toBe(2);
    expect(harness.health.at(-1)?.state).toBe("forbidden");
    expect(harness.window.pendingDelays()).toEqual([]);

    harness.window.dispatchEvent(new Event("pageshow"));
    await settle();
    expect(probes).toBe(3);
    expect(harness.window.pendingDelays()).toEqual([]);

    harness.window.dispatchEvent(new Event("online"));
    await settle();
    expect(probes).toBe(4);
    expect(harness.window.pendingDelays()).toEqual([]);
    expect(harness.refreshed.count).toBe(0);
    expect(harness.relayMeasurements.count).toBe(0);
    expect(harness.fetches).toHaveLength(0);

    dispose();
  });

  test("recovers a restored authorization through the existing success hysteresis", async () => {
    const harness = recoveryHarness([]);
    let probes = 0;
    const dispose = installInjectedRecovery(harness, async () => {
      probes += 1;
      return probes === 1 ? "forbidden" : "healthy";
    });

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("forbidden");

    harness.document.visibilityState = "hidden";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    harness.document.visibilityState = "visible";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(harness.refreshed.count).toBe(1);
    expect(harness.relayMeasurements.count).toBe(0);
    expect(harness.window.pendingDelays()).toEqual([2_000]);

    harness.window.runNextTimer();
    await settle();
    expect(probes).toBe(3);
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.health.at(-1)?.failureSince).toBeNull();
    expect(harness.refreshed.count).toBe(1);
    expect(harness.relayMeasurements.count).toBe(1);
    expect(harness.window.pendingDelays()).toEqual([15_000]);

    dispose();
  });

  test("ignores injected probe completions after disposal aborts their signal", async () => {
    for (const result of ["healthy", "forbidden"] as const) {
      const harness = recoveryHarness([]);
      const signals: AbortSignal[] = [];
      const completions: Array<(result: GatewayProbeResult) => void> = [];
      const dispose = installInjectedRecovery(harness, signal => {
        signals.push(signal);
        return new Promise(resolve => { completions.push(resolve); });
      });

      harness.window.runNextTimer();
      await settle();
      expect(completions).toHaveLength(1);
      expect(harness.window.pendingDelays()).toEqual([3_000]);
      dispose();
      expect(signals[0]?.aborted).toBe(true);
      completions[0]?.(result);
      await settle();
      expect(harness.health.map(state => state.state)).toEqual(["checking"]);
      expect(harness.window.pendingDelays()).toEqual([]);
      expect(harness.refreshed.count).toBe(0);
      expect(harness.relayMeasurements.count).toBe(0);
      expect(harness.fetches).toHaveLength(0);
    }
  });

  test("ignores a hide-aborted injected result before probing the foreground gateway", async () => {
    const harness = recoveryHarness([]);
    const signals: AbortSignal[] = [];
    const completions: Array<(result: GatewayProbeResult) => void> = [];
    const dispose = installInjectedRecovery(harness, signal => {
      signals.push(signal);
      if (signals.length === 1) {
        return new Promise(resolve => { completions.push(resolve); });
      }
      return Promise.resolve("healthy");
    });

    harness.window.runNextTimer();
    await settle();
    harness.document.visibilityState = "hidden";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    expect(signals[0]?.aborted).toBe(true);
    harness.document.visibilityState = "visible";
    harness.document.dispatchEvent(new Event("visibilitychange"));
    expect(signals).toHaveLength(1);

    completions[0]?.("forbidden");
    await settle();
    expect(harness.health.map(state => state.state)).toEqual(["checking"]);
    expect(harness.window.pendingDelays()).toEqual([0]);

    harness.window.runNextTimer();
    await settle();
    expect(signals).toHaveLength(2);
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.refreshed.count).toBe(0);
    expect(harness.relayMeasurements.count).toBe(1);
    expect(harness.fetches).toHaveLength(0);

    dispose();
  });

  test("uses the same degraded and jittered outage delays for injected unavailable results", async () => {
    const harness = recoveryHarness([]);
    let probes = 0;
    const dispose = installInjectedRecovery(harness, async () => {
      probes += 1;
      return probes <= 2 ? "unavailable" : "healthy";
    });

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");
    expect(harness.health.at(-1)?.failureSince).toBe(1_000);
    expect(harness.window.pendingDelays()).toEqual([2_000]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("unreachable");
    expect((harness.health.at(-1)?.retryAt ?? 0) - harness.window.now).toBe(1_000);
    expect(harness.window.pendingDelays()).toEqual([1_000]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(harness.refreshed.count).toBe(1);
    expect(harness.window.pendingDelays()).toEqual([2_000]);

    harness.window.runNextTimer();
    await settle();
    expect(probes).toBe(4);
    expect(harness.health.at(-1)?.state).toBe("healthy");
    expect(harness.refreshed.count).toBe(1);
    expect(harness.window.pendingDelays()).toEqual([15_000]);
    expect(harness.fetches).toHaveLength(0);

    dispose();
  });

  test("counts synchronous throws and rejected injected probes as unavailable", async () => {
    const harness = recoveryHarness([]);
    let probes = 0;
    const dispose = installInjectedRecovery(harness, () => {
      probes += 1;
      if (probes === 1) throw new Error("selected gateway probe failed");
      return Promise.reject(new Error("selected gateway probe rejected"));
    });

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");
    expect(harness.window.pendingDelays()).toEqual([2_000]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("unreachable");
    expect(harness.window.pendingDelays()).toEqual([1_000]);
    expect(harness.refreshed.count).toBe(0);
    expect(harness.fetches).toHaveLength(0);

    dispose();
  });

  test("bounds an injected probe with the existing initial abort timeout", async () => {
    const harness = recoveryHarness([]);
    const signals: AbortSignal[] = [];
    const dispose = installInjectedRecovery(harness, signal => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("probe timed out", "AbortError"));
        }, { once: true });
      });
    });

    harness.window.runNextTimer();
    await settle();
    expect(harness.window.pendingDelays()).toEqual([3_000]);

    harness.window.runNextTimer();
    await settle();
    expect(signals[0]?.aborted).toBe(true);
    expect(harness.health.at(-1)?.state).toBe("degraded");
    expect(harness.window.pendingDelays()).toEqual([2_000]);
    expect(harness.refreshed.count).toBe(0);
    expect(harness.fetches).toHaveLength(0);

    dispose();
  });

  test("times out a silent health probe before recovering the relay", async () => {
    const harness = recoveryHarness(["hang", true, true]);
    const dispose = installBrowserConnectionRecovery(
      () => {
        harness.refreshed.count += 1;
      },
      harness.environment,
      state => harness.health.push(state),
    );

    harness.window.runNextTimer();
    await settle();
    expect(harness.window.pendingDelays()).toEqual([3_000]);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("degraded");
    expect(harness.refreshed.count).toBe(0);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("checking");
    expect(harness.refreshed.count).toBe(1);

    harness.window.runNextTimer();
    await settle();
    expect(harness.health.at(-1)?.state).toBe("healthy");

    dispose();
  });
});
