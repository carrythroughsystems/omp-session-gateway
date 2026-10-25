import {
  PUSH_API_VERSION,
  parseAttentionPushMessage,
  parseNotificationData,
  notificationRoutePath,
  type AttentionPushMessage,
} from "@omp-session-gateway/protocol";

declare const __SHELL_ASSETS__: readonly string[];
declare const __LAZY_ASSETS__: readonly string[];
declare const __CACHE_NAME__: string;

const cacheableAssets = new Set([...__SHELL_ASSETS__, ...__LAZY_ASSETS__]);
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const SHELL_CACHE_PREFIX = "omp-sessions-shell-";

function isNotificationSupportRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("type") &&
    keys.includes("version") &&
    record.type === "omp-notification-support-request" &&
    record.version === PUSH_API_VERSION
  );
}

worker.addEventListener("message", event => {
  if (!isNotificationSupportRequest(event.data)) return;
  event.ports[0]?.postMessage({
    type: "omp-notification-support-response",
    version: PUSH_API_VERSION,
  });
});


async function updateAppBadge(pendingAskCount: number): Promise<void> {
  const badgeNavigator = worker.navigator as Navigator & {
    clearAppBadge?: () => Promise<void>;
    setAppBadge?: (contents?: number) => Promise<void>;
  };
  if (pendingAskCount === 0) {
    await badgeNavigator.clearAppBadge?.();
  } else {
    await badgeNavigator.setAppBadge?.(pendingAskCount);
  }
}

// Serialize notification read/replace and badge updates across overlapping push events.
let pushTail: Promise<void> = Promise.resolve();
// Chrome 153 posted warm replacements 48–78 ms after cancellation. Allow ~25× that observed lag.
const CLOSE_SETTLE_MS = 2_000;
const shownAtByTag = new Map<string, number>();

function matchesRequest(notification: Notification, instanceId: string, requestId: string): boolean {
  const intent = parseNotificationData(notification.data);
  return intent?.kind === "attention" && intent.instanceId === instanceId && intent.requestId === requestId;
}

worker.addEventListener("push", event => {
  let message: AttentionPushMessage;
  try {
    if (event.data === null) return;
    message = parseAttentionPushMessage(event.data.json());
  } catch {
    return;
  }
  const tag = `omp-attention-${message.instanceId}`;
  const delivery = pushTail.then(async () => {
    if (message.type === "clear") {
      let notifications = await worker.registration.getNotifications({ tag });
      const shownAt = shownAtByTag.get(tag);
      if (shownAt !== undefined && notifications.some(notification => matchesRequest(notification, message.instanceId, message.requestId))) {
        const remaining = CLOSE_SETTLE_MS - (performance.now() - shownAt);
        if (remaining > 0) {
          await new Promise<void>(resolve => setTimeout(resolve, remaining));
          notifications = await worker.registration.getNotifications({ tag });
        }
      }
      for (const notification of notifications) {
        if (matchesRequest(notification, message.instanceId, message.requestId)) {
          notification.close();
          shownAtByTag.delete(tag);
        }
      }
    } else {
      const notifications = await worker.registration.getNotifications({ tag });
      if (message.type === "attention" && notifications.some(notification =>
        matchesRequest(notification, message.instanceId, message.requestId) &&
        notification.title === message.title && notification.body === (message.body ?? ""),
      )) {
        await updateAppBadge(message.pendingAskCount);
        return;
      }
      if (message.type === "activity_stop") {
        if (notifications.some(notification => {
          const intent = parseNotificationData(notification.data);
          return intent?.kind === "attention" && intent.instanceId === message.instanceId;
        })) {
          await updateAppBadge(message.pendingAskCount);
          return;
        }
      }
      const options = {
        tag,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        renotify: message.type === "attention" && notifications.some(notification => {
          const intent = parseNotificationData(notification.data);
          return intent?.kind === "activity_stop" && intent.instanceId === message.instanceId;
        }),
        ...(message.body === undefined ? {} : { body: message.body }),
        data: {
          version: message.version,
          type: message.type,
          instanceId: message.instanceId,
          ...(message.type === "attention" ? { requestId: message.requestId } : { generation: message.generation }),
        },
      } satisfies NotificationOptions & { readonly renotify: boolean };
      await worker.registration.showNotification(message.title, options);
      shownAtByTag.set(tag, performance.now());
    }
    await updateAppBadge(message.pendingAskCount);
  });
  // Preserve this event's failure without poisoning later deliveries.
  pushTail = delivery.catch(() => {});
  event.waitUntil(delivery);
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
    record.version === PUSH_API_VERSION
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
    client.postMessage({ type: "omp-notification-route", version: PUSH_API_VERSION, data }, [channel.port2]);
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
