# `apps/web`

Implementation of the **OMP Sessions** dashboard PWA.

Implemented states:

- authenticated live session list;
- empty state with gateway/OMP setup guidance;
- desktop offline or unreachable;
- unauthorized identity;
- SSE reconnect and snapshot recovery, retaining stale metadata only in page memory on transport failure;
- request-specific attention queue, device-local Hold for desk and reversible Hide;
- View and Control launch actions through the pinned client's same-document, in-memory bootstrap;
- stale generation/request, unavailable role, expired session, and process-ended errors;
- explicit Settings-based Push v2 opt-in with Private/Session/Preview detail and exact-request routing;
- privacy/security guidance.

Background alerts (Web Push) are opt-in per device from the Settings sheet; see
[Compatibility](../../docs/COMPATIBILITY.md#platforms-and-browsers) for exact qualified
combinations and evidence. Passkey enrollment and per-Control WebAuthn verification are not
implemented.

Service workers never navigate open pages during activation or notification clicks: activating a
new worker claims clients in place (`clients.claim()`), and each open page reloads itself only when
it is idle with no pending launch, routed notification, or mounted collaboration client.

The dashboard receives metadata only. It must not render transcripts, prefetch capabilities, or implement the OMP collaboration protocol.

The service worker may cache only immutable versioned application-shell assets. It must bypass `/api/`, `/client/`, launch responses, and collaboration navigation. Use no third-party runtime scripts, fonts, analytics, or CDNs.
