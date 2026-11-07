import {
  FLEET_TOMBSTONE_RETENTION_MS,
  LOCAL_FLEET_SOURCE_ID,
  MAX_FLEET_WORKER_RECORDS,
  type AttentionPushMessage,
  type FleetBadge,
  type FleetPendingAsk,
  type FleetPushMessage,
  type FleetSequence,
  type NotificationLaunchIntent,
} from "./types.ts";

/**
 * The service worker's notification ordering rules (ADR-048) as one pure reducer, shared by the
 * worker, its tests, and the qualification harness. The worker persists `FleetWorkerState` in
 * IndexedDB and executes the returned effects; nothing here reads a clock except the `now` it is
 * given, which only ages out tombstones on this device.
 */
export interface FleetWorkerState {
  /** Highest coordinator epoch seen; 0 before the first fleet message. */
  readonly epoch: number;
  /** Highest message counter seen in `epoch`. */
  readonly lastN: number;
  /** Last applied counter per source session in `epoch`. */
  readonly marks: Readonly<Record<string, number>>;
  /** Cleared requests, by request key, with the device time they were recorded. */
  readonly tombstones: Readonly<Record<string, number>>;
  /** Requests already shown, so a replay after a coordinator restart does not alert again. */
  readonly shown: Readonly<Record<string, number>>;
  /** Sequence of the badge currently applied, or null when only Push v2 has set it. */
  readonly badge: FleetSequence | null;
  /** True once the page enabled fleet delivery for this device; Push v2 counts stop applying. */
  readonly fleet: boolean;
}

export const EMPTY_FLEET_WORKER_STATE: FleetWorkerState = {
  epoch: 0, lastN: 0, marks: {}, tombstones: {}, shown: {}, badge: null, fleet: false,
};

/** A notification currently displayed by this worker, with its parsed metadata-only data. */
export interface FleetDisplayedNotification {
  readonly tag: string;
  readonly intent: NotificationLaunchIntent;
}

export type FleetEffect =
  | { readonly kind: "show"; readonly tag: string; readonly renotify: boolean }
  | { readonly kind: "close"; readonly tag: string; readonly requestId: string }
  | { readonly kind: "badge"; readonly count: number; readonly complete: boolean };

export interface FleetReduction {
  readonly state: FleetWorkerState;
  readonly effects: readonly FleetEffect[];
}

/** Local sessions keep the Push v2 tag, so a v2 and a v3 alert for one local ask replace each other. */
export function fleetNotificationTag(source: string | undefined, instanceId: string): string {
  return source === undefined ? `omp-attention-${instanceId}` : `omp-attention-${source}-${instanceId}`;
}

const sourceToken = (source: string | undefined): string => source ?? LOCAL_FLEET_SOURCE_ID;
const sessionKey = (source: string | undefined, instanceId: string): string => `${sourceToken(source)}\0${instanceId}`;
const requestKey = (source: string | undefined, instanceId: string, requestId: string): string =>
  `${sourceToken(source)}\0${instanceId}\0${requestId}`;

function compareSequence(left: FleetSequence, right: FleetSequence): number {
  return left.epoch === right.epoch ? left.n - right.n : left.epoch - right.epoch;
}

/** Keep at most `MAX_FLEET_WORKER_RECORDS` entries, dropping the smallest values first. */
function bounded(record: Readonly<Record<string, number>>, keep: (value: number) => boolean = () => true): Record<string, number> {
  const entries = Object.entries(record).filter(([, value]) => keep(value));
  entries.sort((left, right) => right[1] - left[1]);
  return Object.fromEntries(entries.slice(0, MAX_FLEET_WORKER_RECORDS));
}

function aged(state: FleetWorkerState, now: number): FleetWorkerState {
  const fresh = (recordedAt: number): boolean => now - recordedAt < FLEET_TOMBSTONE_RETENTION_MS;
  return { ...state, tombstones: bounded(state.tombstones, fresh), shown: bounded(state.shown, fresh) };
}

function badgeEffect(badge: FleetBadge): FleetEffect {
  return { kind: "badge", count: badge.count, complete: badge.complete };
}

/** Apply one Push v3 message. Messages from an older coordinator epoch change nothing. */
export function reduceFleetPush(
  previous: FleetWorkerState,
  message: FleetPushMessage,
  displayed: readonly FleetDisplayedNotification[],
  now: number,
): FleetReduction {
  if (message.seq.epoch < previous.epoch) return { state: previous, effects: [] };
  let state = aged(previous, now);
  if (message.seq.epoch > state.epoch) state = { ...state, epoch: message.seq.epoch, lastN: 0, marks: {} };
  state = { ...state, lastN: Math.max(state.lastN, message.seq.n) };
  const effects: FleetEffect[] = [];
  if (state.badge === null || compareSequence(message.seq, state.badge) > 0) {
    state = { ...state, badge: message.seq };
    effects.push(badgeEffect(message.badge));
  }
  if (message.type === "sync") {
    const fresh = new Set(message.fresh);
    const pending = new Set(message.pending.map((ask: FleetPendingAsk) => requestKey(ask.source, ask.instanceId, ask.requestId)));
    const tombstones = { ...state.tombstones };
    for (const notification of displayed) {
      const { intent } = notification;
      if (intent.kind !== "attention" || !fresh.has(sourceToken(intent.source))) continue;
      const key = requestKey(intent.source, intent.instanceId, intent.requestId);
      if (pending.has(key)) continue;
      tombstones[key] = now;
      effects.push({ kind: "close", tag: notification.tag, requestId: intent.requestId });
    }
    return { state: { ...state, tombstones: bounded(tombstones) }, effects };
  }
  const { source, instanceId } = message;
  const tag = fleetNotificationTag(source, instanceId);
  const session = sessionKey(source, instanceId);
  const mark = state.marks[session] ?? 0;
  if (message.type === "clear") {
    const key = requestKey(source, instanceId, message.requestId);
    const { [key]: _shown, ...shown } = state.shown;
    state = {
      ...state,
      marks: bounded({ ...state.marks, [session]: Math.max(mark, message.seq.n) }),
      tombstones: bounded({ ...state.tombstones, [key]: now }),
      shown,
    };
    if (displayed.some(notification => notification.tag === tag && notification.intent.kind === "attention" &&
      notification.intent.requestId === message.requestId)) {
      effects.push({ kind: "close", tag, requestId: message.requestId });
    }
    return { state, effects };
  }
  if (mark >= message.seq.n) return { state, effects };
  state = { ...state, marks: bounded({ ...state.marks, [session]: message.seq.n }) };
  const atTag = displayed.filter(notification => notification.tag === tag);
  if (message.type === "activity_stop") {
    if (atTag.some(notification => notification.intent.kind === "attention")) return { state, effects };
    effects.push({ kind: "show", tag, renotify: false });
    return { state, effects };
  }
  const key = requestKey(source, instanceId, message.requestId);
  if (state.tombstones[key] !== undefined) return { state, effects };
  const alreadyShown = state.shown[key] !== undefined ||
    atTag.some(notification => notification.intent.kind === "attention" && notification.intent.requestId === message.requestId);
  state = { ...state, shown: bounded({ ...state.shown, [key]: now }) };
  if (!alreadyShown) {
    // A replaced stop, or an older request whose clear has not arrived yet, must not hide a new ask.
    const renotify = atTag.some(notification => notification.intent.kind === "activity_stop" ||
      (notification.intent.kind === "attention" && notification.intent.requestId !== message.requestId));
    effects.push({ kind: "show", tag, renotify });
  }
  return { state, effects };
}

/**
 * Apply one Push v2 message (local sessions only). Tombstones apply in both modes, so a delayed v2
 * attention cannot resurrect a cleared request; its count drives the badge only on a legacy device.
 */
export function reduceLegacyPush(
  previous: FleetWorkerState,
  message: AttentionPushMessage,
  displayed: readonly FleetDisplayedNotification[],
  now: number,
): FleetReduction {
  let state = aged(previous, now);
  const effects: FleetEffect[] = [];
  const tag = fleetNotificationTag(undefined, message.instanceId);
  const atTag = displayed.filter(notification => notification.tag === tag);
  if (message.type === "clear") {
    const key = requestKey(undefined, message.instanceId, message.requestId);
    const { [key]: _shown, ...shown } = state.shown;
    state = { ...state, tombstones: bounded({ ...state.tombstones, [key]: now }), shown };
    if (atTag.some(notification => notification.intent.kind === "attention" && notification.intent.requestId === message.requestId)) {
      effects.push({ kind: "close", tag, requestId: message.requestId });
    }
  } else if (message.type === "activity_stop") {
    if (!atTag.some(notification => notification.intent.kind === "attention")) effects.push({ kind: "show", tag, renotify: false });
  } else {
    const key = requestKey(undefined, message.instanceId, message.requestId);
    if (state.tombstones[key] === undefined) {
      const alreadyShown = state.shown[key] !== undefined ||
        atTag.some(notification => notification.intent.kind === "attention" && notification.intent.requestId === message.requestId);
      state = { ...state, shown: bounded({ ...state.shown, [key]: now }) };
      if (!alreadyShown) {
        effects.push({ kind: "show", tag, renotify: atTag.some(notification => notification.intent.kind === "activity_stop") });
      }
    }
  }
  if (!state.fleet) effects.push(badgeEffect({ count: message.pendingAskCount, complete: true }));
  return { state, effects };
}

/**
 * Foreground reconciliation from the page's fresh, authenticated snapshots: close alerts for asks
 * that are no longer pending on sources the page saw fresh, and apply the page's badge as of the
 * newest message this worker has seen, so a delayed older push cannot overwrite it.
 */
export function reduceFleetReconcile(
  previous: FleetWorkerState,
  snapshot: { readonly fresh: readonly string[]; readonly pending: readonly FleetPendingAsk[]; readonly badge: FleetBadge },
  displayed: readonly FleetDisplayedNotification[],
  now: number,
): FleetReduction {
  const state = aged(previous, now);
  const fresh = new Set(snapshot.fresh);
  const pending = new Set(snapshot.pending.map(ask => requestKey(ask.source, ask.instanceId, ask.requestId)));
  const tombstones = { ...state.tombstones };
  const effects: FleetEffect[] = [];
  for (const notification of displayed) {
    const { intent } = notification;
    if (intent.kind !== "attention" || !fresh.has(sourceToken(intent.source))) continue;
    const key = requestKey(intent.source, intent.instanceId, intent.requestId);
    if (pending.has(key)) continue;
    tombstones[key] = now;
    effects.push({ kind: "close", tag: notification.tag, requestId: intent.requestId });
  }
  effects.push(badgeEffect(snapshot.badge));
  const badge = state.epoch === 0 ? state.badge : { epoch: state.epoch, n: state.lastN };
  return { state: { ...state, tombstones: bounded(tombstones), badge }, effects };
}
