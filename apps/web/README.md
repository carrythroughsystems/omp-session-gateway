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

## Synthetic visual review

From the repository root, `bun run test:visual` builds the real dashboard/client and validates six
states at 390×844, 810×1080 and 1280×800 (18 unique state/project names). It never starts Percy
or passes a token. Fixed clock/randomness, en-US/UTC, dark theme, reduced motion and DPR 1 keep
captures deterministic. Directory asks are metadata-only; collaboration prose/code are authored
synthetic content from `e2e/synthetic-product-fixture.ts`, whose defaults also serve README capture.

`bun run test:visual:percy` requires `PERCY_TOKEN`, a healthy local Percy server started by the
pinned CLI, all 18 guarded submissions and a finalized build. Serialized HTML/resources and the
SDK's exact POST fail on any canary/identifier material; no silent fallback, traces, recordings,
raw diagnostics or committed Percy output are allowed. Geometry includes the 560px directory,
900px desktop View transcript and aligned session header, plus serialized parity at every viewport.
Control Ask retains its bounded 880px embedded body and inner transcript, with the same parity
and header-alignment checks rather than the normal View width.
This advisory signal does not replace functional e2e or qualification. Project setup, eligible
CI events and review policy are in [BrowserStack](../../docs/BROWSERSTACK.md).
