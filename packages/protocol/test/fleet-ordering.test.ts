import { describe, expect, test } from "bun:test";
import vectors from "./vectors/fleet-ordering.json" with { type: "json" };
import {
  EMPTY_FLEET_WORKER_STATE,
  MAX_FLEET_WORKER_RECORDS,
  fleetNotificationTag,
  parseAttentionPushMessage,
  parseFleetPushMessage,
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
  const common = { version: 3, ...(source === undefined ? {} : { source }), seq: { epoch, n }, badge: { count, complete } };
  if (step.type === "sync") {
    const pending = (step.pending as Json[]).map(ask => ({ ...ask, source: binding(ask.source) })).map(ask =>
      ask.source === undefined ? (({ source: _source, ...rest }) => rest)(ask) : ask);
    const fresh = (step.fresh as string[]).map(token => token === "local" ? token : binding(token)!);
    return parseFleetPushMessage({ version: 3, type: "sync", seq: common.seq, badge: common.badge, fresh, pending });
  }
  const session = { ...common, type: step.type, instanceId: step.instanceId, generation: 1 };
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
    else if ("push" in step) {
      const message = fleetMessage(step.push as Json);
      apply(reduceFleetPush(state, message, surface, now), message.type === "sync" ? undefined : intentOf(message));
    } else if ("legacy" in step) {
      const legacy = step.legacy as Json;
      const message = parseAttentionPushMessage({
        version: 2, ...legacy, ...(legacy.type === "clear" ? {} : { generation: 1, title: legacy.type === "attention" ? "OMP session needs attention" : "OMP session activity stopped" }),
      });
      apply(reduceLegacyPush(state, message, surface, now), message.type === "clear" ? undefined : intentOf(message));
    } else {
      const reconcile = step.reconcile as Json;
      const [count, complete] = reconcile.badge as [number, boolean];
      const fresh = (reconcile.fresh as string[]).map(token => token === "local" ? token : binding(token)!);
      apply(reduceFleetReconcile(state, { fresh, pending: [], badge: { count, complete } }, surface, now));
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

  test("tombstones, shown requests, and marks stay bounded under a flood", () => {
    let state = EMPTY_FLEET_WORKER_STATE;
    for (let n = 1; n <= MAX_FLEET_WORKER_RECORDS + 64; n++) {
      const instanceId = `inst${String(n).padStart(8, "0")}`;
      const attention = fleetMessage({ type: "attention", instanceId, requestId: `req_flood_${String(n).padStart(8, "0")}`, seq: [1, 2 * n - 1], badge: [1, true] });
      state = reduceFleetPush(state, attention, [], n).state;
      const clear = fleetMessage({ type: "clear", instanceId, requestId: `req_flood_${String(n).padStart(8, "0")}`, seq: [1, 2 * n], badge: [0, true] });
      state = reduceFleetPush(state, clear, [], n).state;
    }
    expect(Object.keys(state.tombstones)).toHaveLength(MAX_FLEET_WORKER_RECORDS);
    expect(Object.keys(state.marks)).toHaveLength(MAX_FLEET_WORKER_RECORDS);
    expect(Object.keys(state.shown).length).toBeLessThanOrEqual(MAX_FLEET_WORKER_RECORDS);
    // The newest records survive; the oldest are the ones dropped.
    expect(Object.keys(state.tombstones).some(key => key.includes(`req_flood_${String(MAX_FLEET_WORKER_RECORDS + 64).padStart(8, "0")}`))).toBe(true);
    expect(Object.keys(state.tombstones).some(key => key.includes("req_flood_00000001"))).toBe(false);
  });

  test("an older epoch changes nothing at all", () => {
    const newer = reduceFleetPush(EMPTY_FLEET_WORKER_STATE, fleetMessage({ type: "attention", instanceId: "aaaa1111bbbb2222", requestId: "req_epoch_check_0a", seq: [9, 1], badge: [1, true] }), [], 0);
    const older = reduceFleetPush(newer.state, fleetMessage({ type: "clear", instanceId: "aaaa1111bbbb2222", requestId: "req_epoch_check_0a", seq: [8, 9], badge: [0, true] }), [], 0);
    expect(older.state).toBe(newer.state);
    expect(older.effects).toEqual([]);
  });
});
