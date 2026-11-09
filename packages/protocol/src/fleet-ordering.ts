import {
  FLEET_TOMBSTONE_RETENTION_MS,
  LOCAL_FLEET_SOURCE_ID,
  MAX_FLEET_WORKER_RECORDS,
  type AttentionPushMessage,
  type FleetBadge,
  type FleetPushMessage,
  type FleetReconcileMessage,
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
  /** Highest coordinator message counter seen in `epoch`. */
  readonly lastN: number;
  /** Last applied coordinator counter per source session in `epoch`. */
  readonly marks: Readonly<Record<string, number>>;
  /** Pushes (v2 or v3) this worker has received, ever; foreground reconciliation is ordered by it. */
  readonly received: number;
  /** `received` at the last push that named each source session. */
  readonly touched: Readonly<Record<string, number>>;
  /** Cleared requests, by request key, with the device time they were recorded. */
  readonly tombstones: Readonly<Record<string, number>>;
  /** Requests already shown, so a repeated attention does not alert again. */
  readonly shown: Readonly<Record<string, number>>;
  /**
   * Each source session's pending ask, by request key, with `received` when it was recorded. Push v3
   * attentions and fresh page snapshots record it; exact clears remove it. The badge counts a selected
   * source the page could not refresh from here. Records saved before this field existed lack it.
   */
  readonly asks: Readonly<Record<string, number>>;
  /**
   * `received` when `asks` was last maintained. A worker without `asks` keeps both fields through its
   * spreads but advances `received`, so any push it handled leaves `asks` unknown (read as empty).
   */
  readonly asksReceived: number;
  /** Sequence of the badge currently applied, or null when only Push v2 has set it. */
  readonly badge: FleetSequence | null;
  /** True once the page enabled fleet delivery for this device; Push v2 counts stop applying. */
  readonly fleet: boolean;
}

export const EMPTY_FLEET_WORKER_STATE: FleetWorkerState = {
  epoch: 0, lastN: 0, marks: {}, received: 0, touched: {}, tombstones: {}, shown: {}, asks: {}, asksReceived: 0,
  badge: null, fleet: false,
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
  if (entries.length <= MAX_FLEET_WORKER_RECORDS) return Object.fromEntries(entries);
  entries.sort((left, right) => right[1] - left[1]);
  return Object.fromEntries(entries.slice(0, MAX_FLEET_WORKER_RECORDS));
}

/** The asks this state vouches for: none before they existed or after another worker handled a push. */
function knownAsks(state: FleetWorkerState): Readonly<Record<string, number>> {
  return state.asks !== undefined && state.asksReceived === state.received ? state.asks : {};
}

/** Make `key` its session's one pending ask, unless that request was already cleared. */
function recordAsk(asks: Record<string, number>, tombstones: Readonly<Record<string, number>>, session: string, key: string, at: number): void {
  if (tombstones[key] !== undefined) return;
  for (const existing of Object.keys(asks)) if (existing.startsWith(`${session}\0`)) delete asks[existing];
  asks[key] = at;
}

/** Age out tombstones and shown requests, and count this push against the session it names. */
function received(state: FleetWorkerState, now: number, session: string): FleetWorkerState {
  const fresh = (recordedAt: number): boolean => now - recordedAt < FLEET_TOMBSTONE_RETENTION_MS;
  const count = state.received + 1;
  return {
    ...state,
    received: count,
    touched: bounded({ ...state.touched, [session]: count }),
    tombstones: bounded(state.tombstones, fresh),
    shown: bounded(state.shown, fresh),
    asks: knownAsks(state),
    asksReceived: count,
  };
}

function badgeEffect(badge: FleetBadge): FleetEffect {
  return { kind: "badge", count: badge.count, complete: badge.complete };
}

/** Record a clear: tombstone the exact request, forget it as pending, and close it only if displayed. */
function clearRequest(
  state: FleetWorkerState,
  source: string | undefined,
  instanceId: string,
  requestId: string,
  displayed: readonly FleetDisplayedNotification[],
  now: number,
): FleetReduction {
  const key = requestKey(source, instanceId, requestId);
  const tag = fleetNotificationTag(source, instanceId);
  const { [key]: _shown, ...shown } = state.shown;
  const { [key]: _ask, ...asks } = state.asks;
  const next = { ...state, tombstones: bounded({ ...state.tombstones, [key]: now }), shown, asks };
  const visible = displayed.some(notification => notification.tag === tag &&
    notification.intent.kind === "attention" && notification.intent.requestId === requestId);
  return { state: next, effects: visible ? [{ kind: "close", tag, requestId }] : [] };
}

/**
 * Show an attention unless its request is tombstoned or already shown. A replaced stop, or an older
 * request whose clear has not arrived yet, alerts again; Push v2 keeps its stop-only re-alert.
 */
function showAttention(
  state: FleetWorkerState,
  source: string | undefined,
  instanceId: string,
  requestId: string,
  displayed: readonly FleetDisplayedNotification[],
  now: number,
  realertOlderRequest: boolean,
): FleetReduction {
  const key = requestKey(source, instanceId, requestId);
  if (state.tombstones[key] !== undefined) return { state, effects: [] };
  const tag = fleetNotificationTag(source, instanceId);
  const atTag = displayed.filter(notification => notification.tag === tag);
  const alreadyShown = state.shown[key] !== undefined ||
    atTag.some(notification => notification.intent.kind === "attention" && notification.intent.requestId === requestId);
  const next = { ...state, shown: bounded({ ...state.shown, [key]: now }) };
  if (alreadyShown) return { state: next, effects: [] };
  const renotify = atTag.some(notification => notification.intent.kind === "activity_stop" ||
    (realertOlderRequest && notification.intent.kind === "attention" && notification.intent.requestId !== requestId));
  return { state: next, effects: [{ kind: "show", tag, renotify }] };
}

/** Apply one Push v3 message. Messages from an older coordinator epoch change nothing. */
export function reduceFleetPush(
  previous: FleetWorkerState,
  message: FleetPushMessage,
  displayed: readonly FleetDisplayedNotification[],
  now: number,
): FleetReduction {
  if (message.seq.epoch < previous.epoch) return { state: previous, effects: [] };
  const { source, instanceId } = message;
  const session = sessionKey(source, instanceId);
  let state = received(previous, now, session);
  if (message.seq.epoch > state.epoch) state = { ...state, epoch: message.seq.epoch, lastN: 0, marks: {} };
  state = { ...state, lastN: Math.max(state.lastN, message.seq.n) };
  const effects: FleetEffect[] = [];
  if (state.badge === null || compareSequence(message.seq, state.badge) > 0) {
    state = { ...state, badge: message.seq };
    effects.push(badgeEffect(message.badge));
  }
  const mark = state.marks[session] ?? 0;
  if (message.type === "clear") {
    state = { ...state, marks: bounded({ ...state.marks, [session]: Math.max(mark, message.seq.n) }) };
    const cleared = clearRequest(state, source, instanceId, message.requestId, displayed, now);
    return { state: cleared.state, effects: [...effects, ...cleared.effects] };
  }
  if (mark >= message.seq.n) return { state, effects };
  state = { ...state, marks: bounded({ ...state.marks, [session]: message.seq.n }) };
  const tag = fleetNotificationTag(source, instanceId);
  if (message.type === "activity_stop") {
    const attentionShown = displayed.some(notification => notification.tag === tag && notification.intent.kind === "attention");
    return { state, effects: attentionShown ? effects : [...effects, { kind: "show", tag, renotify: false }] };
  }
  const asks = { ...state.asks };
  recordAsk(asks, state.tombstones, session, requestKey(source, instanceId, message.requestId), state.received);
  state = { ...state, asks: bounded(asks) };
  const shown = showAttention(state, source, instanceId, message.requestId, displayed, now, true);
  return { state: shown.state, effects: [...effects, ...shown.effects] };
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
  const state = received(previous, now, sessionKey(undefined, message.instanceId));
  const tag = fleetNotificationTag(undefined, message.instanceId);
  let reduction: FleetReduction;
  if (message.type === "clear") {
    reduction = clearRequest(state, undefined, message.instanceId, message.requestId, displayed, now);
  } else if (message.type === "activity_stop") {
    const attentionShown = displayed.some(notification => notification.tag === tag && notification.intent.kind === "attention");
    reduction = { state, effects: attentionShown ? [] : [{ kind: "show", tag, renotify: false }] };
  } else {
    reduction = showAttention(state, undefined, message.instanceId, message.requestId, displayed, now, false);
  }
  if (reduction.state.fleet) return reduction;
  return { state: reduction.state, effects: [...reduction.effects, badgeEffect({ count: message.pendingAskCount, complete: true })] };
}

/**
 * Foreground reconciliation from the page's fresh, authenticated snapshots. `asOf.received` is the
 * worker's push count when the page began fetching: only alerts whose session received no push since
 * may be closed as resolved, and only those sessions take a fresh source's snapshot as their pending
 * ask. The badge applies only if no push at all arrived since; it counts the known asks of `counted`
 * sources, so a source the page could not refresh keeps what pushes and earlier snapshots taught this
 * worker, never an older page's view. The applied badge is pinned to the newest coordinator sequence
 * seen, so a delayed older push cannot overwrite it.
 */
export function reduceFleetReconcile(
  previous: FleetWorkerState,
  snapshot: Pick<FleetReconcileMessage, "asOf" | "fresh" | "pending" | "counted" | "complete">,
  displayed: readonly FleetDisplayedNotification[],
  now: number,
): FleetReduction {
  if (snapshot.asOf.received > previous.received) return { state: previous, effects: [] };
  const fresh = new Set(snapshot.fresh);
  const settled = (session: string): boolean => (previous.touched[session] ?? 0) <= snapshot.asOf.received;
  const pending = new Set(snapshot.pending.map(ask => requestKey(ask.source, ask.instanceId, ask.requestId)));
  const tombstones = { ...previous.tombstones };
  const effects: FleetEffect[] = [];
  for (const notification of displayed) {
    const { intent } = notification;
    if (intent.kind !== "attention" || !fresh.has(sourceToken(intent.source))) continue;
    if (!settled(sessionKey(intent.source, intent.instanceId))) continue;
    const key = requestKey(intent.source, intent.instanceId, intent.requestId);
    if (pending.has(key)) continue;
    tombstones[key] = now;
    effects.push({ kind: "close", tag: notification.tag, requestId: intent.requestId });
  }
  const asks: Record<string, number> = {};
  for (const [key, at] of Object.entries(knownAsks(previous))) {
    if (!fresh.has(key.slice(0, key.indexOf("\0"))) || !settled(key.slice(0, key.lastIndexOf("\0")))) asks[key] = at;
  }
  for (const ask of snapshot.pending) {
    const session = sessionKey(ask.source, ask.instanceId);
    if (settled(session)) recordAsk(asks, tombstones, session, requestKey(ask.source, ask.instanceId, ask.requestId), previous.received);
  }
  let badge = previous.badge;
  if (previous.received === snapshot.asOf.received) {
    const counted = new Set(snapshot.counted);
    const count = Object.keys(asks).filter(key => counted.has(key.slice(0, key.indexOf("\0")))).length;
    effects.push(badgeEffect({ count, complete: snapshot.complete }));
    if (previous.epoch > 0) badge = { epoch: previous.epoch, n: previous.lastN };
  }
  return { state: { ...previous, tombstones: bounded(tombstones), asks: bounded(asks), asksReceived: previous.received, badge }, effects };
}
