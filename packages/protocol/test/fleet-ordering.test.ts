import { describe, expect, test } from "bun:test";
import vectors from "./vectors/fleet-ordering.json" with { type: "json" };
import {
  EMPTY_FLEET_WORKER_STATE,
  MAX_FLEET_WORKER_RECORDS,
  fleetNotificationTag,
  parseAttentionPushMessage,
  parseFleetPushMessage,
  parseFleetReconcileMessage,
  reduceFleetPush,
  reduceFleetReconcile,
  reduceLegacyPush,
  type FleetDisplayedNotification,
  type FleetEffect,
  type FleetReduction,
  type FleetWorkerState,
  type NotificationLaunchIntent,
} from "../src/index.ts";

type Json = Record<string, unknown>;
const aliases = vectors.defaults as Record<string, string>;
const binding = (source: unknown): string | undefined => source === undefined ? undefined : aliases[source as string] ?? (source as string);

function fleetMessage(step: Json) {
  const [epoch, n] = step.seq as [number, number];
  const [count, complete] = step.badge as [number, boolean];
  const source = binding(step.source);
  const session = {
    version: 3, ...(source === undefined ? {} : { source }), seq: { epoch, n }, badge: { count, complete },
    type: step.type, instanceId: step.instanceId, generation: 1,
  };
  if (step.type === "attention") return parseFleetPushMessage({ ...session, requestId: step.requestId, title: "OMP session needs attention" });
  if (step.type === "activity_stop") return parseFleetPushMessage({ ...session, title: "OMP session activity stopped" });
  return parseFleetPushMessage({ ...session, requestId: step.requestId });
}

function intentOf(message: { readonly type: string; readonly source?: string; readonly instanceId: string; readonly requestId?: string }): NotificationLaunchIntent {
  const source = message.source === undefined ? {} : { source: message.source };
  return message.type === "attention"
    ? { kind: "attention", ...source, instanceId: message.instanceId, requestId: message.requestId! }
    : { kind: "activity_stop", ...source, instanceId: message.instanceId, generation: 1 };
}

/** A stand-in notification surface: one notification per tag, replaced on show. */
function run(scenario: (typeof vectors.scenarios)[number]) {
  let state: FleetWorkerState = { ...EMPTY_FLEET_WORKER_STATE, fleet: "fleet" in scenario && scenario.fleet === true };
  const displayed = new Map<string, FleetDisplayedNotification>();
  let badge: [number, boolean] | undefined;
  let alerts = 0;
  let now = 0;
  let captured = 0;
  const apply = (reduction: FleetReduction, shown?: NotificationLaunchIntent): void => {
    state = reduction.state;
    for (const effect of reduction.effects as FleetEffect[]) {
      if (effect.kind === "badge") badge = [effect.count, effect.complete];
      else if (effect.kind === "close") {
        const current = displayed.get(effect.tag);
        if (current?.intent.kind === "attention" && current.intent.requestId === effect.requestId) displayed.delete(effect.tag);
      } else {
        if (!displayed.has(effect.tag) || effect.renotify) alerts++;
        displayed.set(effect.tag, { tag: effect.tag, intent: shown! });
      }
    }
  };
  for (const step of scenario.steps as Json[]) {
    const surface = [...displayed.values()];
    if ("advance" in step) now += step.advance as number;
    else if ("restart" in step) state = JSON.parse(JSON.stringify(state)) as FleetWorkerState;
    else if ("capture" in step) captured = state.received;
    else if ("push" in step) {
      const message = fleetMessage(step.push as Json);
      apply(reduceFleetPush(state, message, surface, now), intentOf(message));
    } else if ("legacy" in step) {
      const legacy = step.legacy as Json;
      const message = parseAttentionPushMessage({
        version: 2, ...legacy, ...(legacy.type === "clear" ? {} : { generation: 1, title: legacy.type === "attention" ? "OMP session needs attention" : "OMP session activity stopped" }),
      });
      apply(reduceLegacyPush(state, message, surface, now), message.type === "clear" ? undefined : intentOf(message));
    } else {
      const reconcile = step.reconcile as Json;
      const [count, complete] = reconcile.badge as [number, boolean];
      const message = parseFleetReconcileMessage({
        type: "omp-notification-reconcile",
        version: 3,
        asOf: { received: captured },
        fresh: (reconcile.fresh as string[]).map(token => token === "local" ? token : binding(token)!),
        pending: reconcile.pending,
        badge: { count, complete },
      });
      apply(reduceFleetReconcile(state, message, surface, now));
    }
  }
  const describe = (notification: FleetDisplayedNotification): string => {
    const { intent } = notification;
    return `${notification.tag}|${intent.kind}|${intent.kind === "attention" ? intent.requestId : intent.generation}`;
  };
  return { displayed: [...displayed.values()].map(describe).sort(), badge, alerts, state };
}

describe("fleet ordering vectors", () => {
  for (const scenario of vectors.scenarios) {
    test(scenario.name, () => {
      const result = run(scenario);
      expect(result.displayed).toEqual([...scenario.expect.displayed].sort());
      expect(result.badge).toEqual(scenario.expect.badge as [number, boolean]);
      expect(result.alerts).toBe(scenario.expect.alerts);
    });
  }
});

describe("fleet ordering bounds", () => {
  test("tags keep the Push v2 form for local sessions and qualify remote ones", () => {
    expect(fleetNotificationTag(undefined, "aaaa1111bbbb2222")).toBe("omp-attention-aaaa1111bbbb2222");
    expect(fleetNotificationTag(aliases.studio, "aaaa1111bbbb2222")).toBe(`omp-attention-${aliases.studio}-aaaa1111bbbb2222`);
  });

  test("tombstones, shown requests, marks, and touched sessions stay bounded under a flood", () => {
    let state = EMPTY_FLEET_WORKER_STATE;
    const total = MAX_FLEET_WORKER_RECORDS + 64;
    for (let n = 1; n <= total; n++) {
      const id = String(n).padStart(8, "0");
      state = reduceFleetPush(state, fleetMessage({ type: "attention", instanceId: `inst${id}`, requestId: `req_flood_${id}`, seq: [1, 2 * n - 1], badge: [1, true] }), [], n).state;
      state = reduceFleetPush(state, fleetMessage({ type: "clear", instanceId: `inst${id}`, requestId: `req_flood_${id}`, seq: [1, 2 * n], badge: [0, true] }), [], n).state;
    }
    for (const record of [state.tombstones, state.marks, state.touched]) expect(Object.keys(record)).toHaveLength(MAX_FLEET_WORKER_RECORDS);
    expect(Object.keys(state.shown).length).toBeLessThanOrEqual(MAX_FLEET_WORKER_RECORDS);
    // The newest records survive; only the oldest are dropped.
    expect(Object.keys(state.tombstones).some(key => key.endsWith(`req_flood_${String(total).padStart(8, "0")}`))).toBe(true);
    expect(Object.keys(state.tombstones).some(key => key.endsWith("req_flood_00000001"))).toBe(false);
  });

  test("an older epoch changes nothing at all", () => {
    const newer = reduceFleetPush(EMPTY_FLEET_WORKER_STATE, fleetMessage({ type: "attention", instanceId: "aaaa1111bbbb2222", requestId: "req_epoch_check_0a", seq: [9, 1], badge: [1, true] }), [], 0);
    const older = reduceFleetPush(newer.state, fleetMessage({ type: "clear", instanceId: "aaaa1111bbbb2222", requestId: "req_epoch_check_0a", seq: [8, 9], badge: [0, true] }), [], 0);
    expect(older.state).toBe(newer.state);
    expect(older.effects).toEqual([]);
  });

  test("a reconciliation claiming more receipts than the worker has seen changes nothing", () => {
    const message = parseFleetReconcileMessage({
      type: "omp-notification-reconcile", version: 3, asOf: { received: 5 }, fresh: ["local"], pending: [], badge: { count: 0, complete: true },
    });
    const result = reduceFleetReconcile(EMPTY_FLEET_WORKER_STATE, message, [], 0);
    expect(result.state).toBe(EMPTY_FLEET_WORKER_STATE);
    expect(result.effects).toEqual([]);
  });
});
