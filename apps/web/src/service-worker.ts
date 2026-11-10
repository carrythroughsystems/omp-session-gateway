import {
  PUSH_API_VERSION,
  FLEET_PUSH_VERSION,
  MAX_FLEET_WORKER_RECORDS,
  parseAttentionPushMessage,
  parseFleetPushMessage,
  parseFleetReconcileMessage,
  parseNotificationData,
  notificationRoutePath,
  fleetNotificationTag,
  reduceFleetPush,
  reduceLegacyPush,
  reduceFleetReconcile,
  type AttentionPushMessage,
  type FleetPushMessage,
  type FleetEffect,
  type FleetDisplayedNotification,
} from "@omp-session-gateway/protocol";
import { FleetWorkerStore } from "./fleet-worker-store";

declare const __SHELL_ASSETS__: readonly string[];
declare const __LAZY_ASSETS__: readonly string[];
declare const __CACHE_NAME__: string;

const cacheableAssets = new Set([...__SHELL_ASSETS__, ...__LAZY_ASSETS__]);
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const SHELL_CACHE_PREFIX = "omp-sessions-shell-";
const store = new FleetWorkerStore(worker.indexedDB);

function isNotificationSupportRequest(value: unknown): value is { version: 2 | 3 } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("version") &&
    record.type === "omp-notification-support-request" &&
    (record.version === PUSH_API_VERSION || record.version === FLEET_PUSH_VERSION)
  );
}

worker.addEventListener("message", event => {
  if (isNotificationSupportRequest(event.data)) {
    const version = event.data.version;
    if (version === PUSH_API_VERSION) {
      event.ports[0]?.postMessage({ type: "omp-notification-support-response", version });
    } else {
      event.waitUntil(serialize(async () => {
        const state = await store.read();
        event.ports[0]?.postMessage({ type: "omp-notification-support-response", version, received: state.received });
      }));
    }
    return;
  }
  const message: unknown = event.data;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return;
  const record = message as Record<string, unknown>;
  if (record.type === "omp-notification-mode" && record.version === FLEET_PUSH_VERSION &&
    Object.keys(record).length === 3 && typeof record.fleet === "boolean") {
    const fleet = record.fleet;
    event.waitUntil(serialize(async () => {
      const committed = await store.write({ ...await store.read(), fleet }, true);
      event.ports[0]?.postMessage({
        type: committed ? "omp-notification-mode-set" : "omp-notification-mode-failed", version: FLEET_PUSH_VERSION,
      });
    }));
    return;
  }
  try {
    const snapshot = parseFleetReconcileMessage(message);
    event.waitUntil(serialize(async () => {
      const displayed = await worker.registration.getNotifications();
      const reduction = reduceFleetReconcile(await store.read(), snapshot, describeNotifications(displayed), Date.now());
      await store.write(reduction.state);
      await executeEffects(reduction.effects);
    }));
  } catch { /* Unsupported or malformed page messages have no effects. */ }
});

async function updateAppBadge(count: number, complete: boolean): Promise<void> {
  const badgeNavigator = worker.navigator as Navigator & {
    clearAppBadge?: () => Promise<void>;
    setAppBadge?: (contents?: number) => Promise<void>;
  };
  if (count === 0 && complete) {
    await badgeNavigator.clearAppBadge?.();
  } else {
    await badgeNavigator.setAppBadge?.(count === 0 ? undefined : count);
  }
}

// Serialize notification read/replace and badge updates across overlapping push events.
let pushTail: Promise<void> = Promise.resolve();
function serialize(action: () => Promise<void>): Promise<void> {
  const delivery = pushTail.then(action);
  pushTail = delivery.catch(() => {});
  return delivery;
}
// Chrome 153 posted warm replacements 48–78 ms after cancellation. Allow ~25× that observed lag.
const CLOSE_SETTLE_MS = 2_000;
const shownAtByTag = new Map<string, number>();

function matchesRequest(notification: Notification, requestId: string): boolean {
  const intent = parseNotificationData(notification.data);
  return intent?.kind === "attention" && intent.requestId === requestId;
}

function describeNotifications(notifications: readonly Notification[]): FleetDisplayedNotification[] {
  return notifications.flatMap(notification => {
    const intent = parseNotificationData(notification.data);
    return intent === undefined ? [] : [{ tag: notification.tag, intent }];
  });
}

async function executeEffects(effects: readonly FleetEffect[], message?: AttentionPushMessage | FleetPushMessage): Promise<void> {
  for (const effect of effects) {
    if (effect.kind === "badge") {
      await updateAppBadge(effect.count, effect.complete);
      continue;
    }
    const { tag } = effect;
    if (effect.kind === "close") {
      let notifications = await worker.registration.getNotifications({ tag });
      const shownAt = shownAtByTag.get(tag);
      if (shownAt !== undefined && notifications.some(notification => matchesRequest(notification, effect.requestId))) {
        const remaining = CLOSE_SETTLE_MS - (performance.now() - shownAt);
        if (remaining > 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, remaining);
          await promise;
          notifications = await worker.registration.getNotifications({ tag });
        }
      }
      for (const notification of notifications) {
        if (matchesRequest(notification, effect.requestId)) {
          notification.close();
          shownAtByTag.delete(tag);
        }
      }
      continue;
    }
    if (message === undefined || message.type === "clear") continue;
    const options = {
      tag,
      icon: "/icon-192.png",
      // Android draws the badge as a silhouette in the status bar: it has to be transparent.
      badge: "/badge-96.png",
      renotify: effect.renotify,
      ...(message.body === undefined ? {} : { body: message.body }),
      data: {
        version: message.version,
        type: message.type,
        ...(message.version === FLEET_PUSH_VERSION && message.source !== undefined ? { source: message.source } : {}),
        instanceId: message.instanceId,
        ...(message.type === "attention" ? { requestId: message.requestId } : { generation: message.generation }),
      },
    } satisfies NotificationOptions & { readonly renotify: boolean };
    await worker.registration.showNotification(message.title, options);
    shownAtByTag.delete(tag);
    shownAtByTag.set(tag, performance.now());
    if (shownAtByTag.size > MAX_FLEET_WORKER_RECORDS) shownAtByTag.delete(shownAtByTag.keys().next().value!);
  }
}

worker.addEventListener("push", event => {
  let message: AttentionPushMessage | FleetPushMessage;
  try {
    if (event.data === null) return;
    const value: unknown = event.data.json();
    message = typeof value === "object" && value !== null && "version" in value && value.version === FLEET_PUSH_VERSION
      ? parseFleetPushMessage(value) : parseAttentionPushMessage(value);
  } catch { return; }
  event.waitUntil(serialize(async () => {
    const tag = fleetNotificationTag(message.version === FLEET_PUSH_VERSION ? message.source : undefined, message.instanceId);
    const displayed = describeNotifications(await worker.registration.getNotifications({ tag }));
    const state = await store.read();
    const reduction = message.version === FLEET_PUSH_VERSION
      ? reduceFleetPush(state, message, displayed, Date.now())
      : reduceLegacyPush(state, message, displayed, Date.now());
    // Persist tombstones before closing: a killed worker cannot resurrect an overtaken attention.
    await store.write(reduction.state);
    await executeEffects(reduction.effects, message);
  }));
});

/** A page that accepts within this bound handles the tapped route itself. */
const NOTIFICATION_ROUTE_ACCEPT_MS = 3_000;

function isNotificationRouteAccepted(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("version") &&
    record.type === "omp-notification-route-accepted" &&
    (record.version === PUSH_API_VERSION || record.version === FLEET_PUSH_VERSION)
  );
}

/**
 * Hands a tapped notification's metadata to an open page, which validates it against fresh
 * directory metadata exactly as a routed load does and launches in place. A worker never
 * navigates a window: Chromium reports a window client's creation URL, not the route the page later
 * reached through the history API (ADR-018 amendment). On a Pixel 10 Pro (Android 17, Chrome 154)
 * a live `/client/` collaboration in the installed WebAPK reported `/`, and navigating it reloaded
 * the document, which dropped the live client and any unsent composer text and relaunched View.
 */
async function routeInPage(client: WindowClient, data: unknown): Promise<boolean> {
  const channel = new MessageChannel();
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timeout = setTimeout(() => resolve(false), NOTIFICATION_ROUTE_ACCEPT_MS);
  channel.port1.onmessage = event => resolve(isNotificationRouteAccepted(event.data));
  try {
    const intent = parseNotificationData(data);
    client.postMessage({ type: "omp-notification-route", version: intent?.source === undefined ? PUSH_API_VERSION : FLEET_PUSH_VERSION, data }, [channel.port2]);
  } catch {
    resolve(false);
  }
  const accepted = await promise;
  clearTimeout(timeout);
  channel.port1.close();
  return accepted;
}

worker.addEventListener("notificationclick", event => {
  event.notification.close();
  const data: unknown = event.notification.data;
  const intent = parseNotificationData(data);
  event.waitUntil(
    (async () => {
      // Most recently focused first.
      const [client] = (await worker.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(
        candidate => new URL(candidate.url).origin === worker.location.origin,
      );
      if (client !== undefined) {
        // Focus before asking: Chrome on Android freezes a page about a minute after it is hidden
        // (a WebAPK page answered at 17 seconds, not at 62), and bringing it forward resumes it.
        const focused = await client.focus().then(
          () => true,
          () => false,
        );
        if (intent === undefined ? focused : await routeInPage(client, data)) return;
      }
      await worker.clients.openWindow(intent === undefined ? "/" : notificationRoutePath(intent));
    })(),
  );
});

worker.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(__CACHE_NAME__);
      await cache.addAll(__SHELL_ASSETS__);
      await worker.skipWaiting();
    })(),
  );
});

worker.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(name => name.startsWith(SHELL_CACHE_PREFIX) && name !== __CACHE_NAME__)
          .map(name => caches.delete(name)),
      );
      // Never navigate clients here. Chromium reports a window client's creation URL, not the route a
      // page later reaches through the history API, so a live `/client/` collaboration or a pending
      // launch looks exactly like an idle `/` directory. Each page observes the controller change and
      // reloads itself only when it is idle.
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    request.mode === "navigate" ||
    url.origin !== worker.location.origin ||
    url.search !== "" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/client/") ||
    url.pathname.startsWith("/collab/") ||
    url.pathname.startsWith("/internal/") ||
    !cacheableAssets.has(url.pathname)
  ) {
    return;
  }
  event.respondWith(
    caches.open(__CACHE_NAME__).then(async cache => {
      const cached = await cache.match(request);
      if (cached !== undefined) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }),
  );
});
