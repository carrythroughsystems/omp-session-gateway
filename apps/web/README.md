# `apps/web`

This package gives contributors the source layout, browser storage ownership, service-worker caching rules, UI controllers, and test commands for the **OMP Sessions** Progressive Web App (PWA). Paths under `src/`, `test/`, `e2e/`, `visual/`, and `playwright*.config.ts` are relative to `apps/web/`; paths under `scripts/`, `docs/`, `packages/`, `assets/`, `licenses/`, and `THIRD_PARTY_NOTICES.md` are relative to the repository root.

The PWA renders session metadata and launches the pinned Oh My Pi (OMP) collaboration client in memory; a View or Control link is a bearer secret, called a capability in the contracts.

The dashboard never prefetches capabilities, stores them, or implements the collaboration protocol; user flows are in [Using OMP Sessions](../../docs/USAGE.md), visual tokens in [Brand and UI specification](../../docs/BRANDING.md), and runtime invariants in [OMP Sessions PWA](../../docs/ARCHITECTURE.md#14-omp-sessions-pwa).

## Module map

| Module | Responsibility |
|---|---|
| `src/app.ts` | Directory state machine, SSE and snapshot reconciliation, generation-bound launch and collaboration shell, first-run introduction, and **Background alerts** / **Hosts** settings UI. |
| `src/availability.ts` | Pure eight-state source availability (`sourceAvailability`) and multi-host scope coverage summaries (`scopeCoverage`). |
| `src/fleet.ts` | DOM-free `GET /api/v1/client-config` bootstrap, browser-direct CORS polling (`FleetTransport`), fleet grant and recipient calls (`FleetNotificationTransport`), creation calls (`SessionCreationTransport`), and `localStorage` codecs. |
| `src/fleet-worker-store.ts` | Service-worker IndexedDB store (`FleetWorkerStore`, database `omp-notification-ordering`, 2,000 ms open timeout) with in-memory fallback for Push v2 and Push v3 ordering and tombstones. |
| `src/icons.ts` | Inline SVG icon factory (`createIcon`) on a 20 px grid with normalized `pathLength="1"` strokes. |
| `src/service-worker.ts` | Versioned shell and lazy-font caching, Push v2 and Push v3 reduction and app-badge updates, in-page notification click routing (`routeInPage`), and navigation-free activation. |
| `src/session-creation.ts` | `SessionCreationController` wizard trays, 120-second status watching, 1-hour explicit `POST` replay, and memory-only **First task** draft holder. |
| `src/tray.ts` | `createTray` controller over `<dialog id="tray" closedby="closerequest">`: up-to-three-panel modal stack, non-modal **Undo** status row, grip drag, height transitions, and request-tray promotion. |

`src/index.html`, `src/styles.css`, `src/manifest.webmanifest`, and `src/fonts/` supply the HTML shell, Signal stylesheet, web app manifest, and vendored font subsets compiled by `scripts/build-web.ts`.

## Browser storage

Every persistent browser record is metadata-only and holds no capability.

| Key or database | Owner | Contents (holds no capability) | Bound |
|---|---|---|---|
| `omp.sessions.held-asks.v2` (`localStorage`) | `src/fleet.ts`, `src/app.ts` | `{ sourceId, sourceOrigin, instanceId, requestId, heldAt }` array; no capability, title, path, model, prompt, or transcript. | 100 records, 512,000 UTF-16 chars |
| `omp.sessions.dismissed.v2` (`localStorage`) | `src/fleet.ts`, `src/app.ts` | `{ sourceId, sourceOrigin, instanceId, generation, dismissedAt }` array; no capability, title, path, model, prompt, or transcript. | 100 records, 512,000 UTF-16 chars |
| `omp.sessions.held-asks.v1`, `omp.sessions.dismissed.v1` (`localStorage`) | `src/fleet.ts` (`readSourceRecords`) | Pre-fleet local triage records with no capability; migrated to `sourceId: "local"` and deleted only after `.v2` write succeeds. | 100 records, 512,000 chars on read |
| `omp.sessions.first-run.v1` (`localStorage`) | `src/app.ts` (`readFirstRunStep`) | `{ "version": 1, "step": "alerts" \| "modes" \| "done", "updatedAt": "<ISO timestamp>" }`; no capability, session ID, or permission state. | 128 UTF-16 chars |
| `omp.sessions.creation-prefs.v1` (`localStorage`) | `src/fleet.ts`, `src/session-creation.ts` | `{ version: 1, choices: [{sourceId, sourceOrigin, projectId, workingCopyId, profileId, updatedAt}] }`; no capability, operation ID, path, or **First task**. | 8 records, 16 KiB (`16,384` bytes) |
| `omp-notification-ordering` (`IndexedDB`, store `state`, key `"worker"`) | `src/fleet-worker-store.ts`, `packages/protocol` | `FleetWorkerState` counters, sequences, and per-session or per-request integer maps (`marks`, `touched`, `tombstones`, `shown`, `asks`); no capability, title, path, or push body. | 2,048 entries per map, 30-minute tombstones |

Returning to step 1 (**Connected**) of the three-step introduction (**Connected**, **Background alerts**, **View or Control**) removes `omp.sessions.first-run.v1`, while **Skip introduction** or **Done** writes `done`.

Source-bound `localStorage` records for removed or origin-rebound hosts are pruned only after an authoritative `client-config` bootstrap, never during bootstrap or transport failures; corrupt or inaccessible records fall back cleanly (`done` for first-run, empty or in-memory decisions elsewhere).

## Service worker

`scripts/build-web.ts` compiles `src/service-worker.ts` with a content-hashed cache name (`omp-sessions-shell-<sha256-12>`) and two asset allowlists:

- On `install`, `__SHELL_ASSETS__` precaches hashed `app.<hash>.js`, `app.<hash>.css`, `collab-client.<hash>.js`, `collab-client.<hash>.css`, and the upright Geist and Geist Mono WOFF2 faces.
- On first fetch, `__LAZY_ASSETS__` caches content-hashed Symbols Nerd Font Mono WOFF2 chunks (Private Use Area `unicode-range` subsets) and the italic Geist WOFF2 face in the active shell cache, serving them cache-first thereafter.
- On `fetch`, the worker bypasses non-`GET` requests, document navigations (`request.mode === "navigate"`), cross-origin requests, URLs with a query string, `/api/`, `/client/`, `/collab/`, `/internal/`, and any pathname outside those two allowlists.

Activation deletes older `omp-sessions-shell-*` caches and calls `clients.claim()` without navigating open windows; idle pages reload themselves after 1 second ([Shell updates and caching](../../docs/ARCHITECTURE.md#shell-updates-and-caching)). Runtime assets are strictly first-party, with no remote fonts, analytics, third-party scripts, or CDNs.

## Appearance

`src/styles.css` implements the Signal tokens from [Brand and UI specification](../../docs/BRANDING.md) on `:root`, dark by default with `prefers-color-scheme: light` overrides. To theme the embedded client without colliding with its tokens, `src/app.ts` sets `--gateway-*` custom properties on `.gateway-shell` and inserts `collab-client.<hash>.css` ahead of `app.<hash>.css`.

Regenerate the vendored Geist subsets with `bun scripts/vendor-geist.ts` and the Nerd Fonts v3.5.1 PUA chunks with `bun scripts/vendor-nerd-symbols.ts` (each verifies a SHA-256 archive or accepts `--source <directory>`, requires `pyftsubset` on `PATH` and Python `fontTools` with Brotli — optionally selected via `FONTTOOLS_PYTHON=<python-bin>` — and caps chunks at 160 populated BMP PUA glyphs or 768 plane-15 glyphs).

Render raster icons (`src/*.png`), `src/badge-96.png`, and social artwork (`assets/*.png`) with `bun run media:brand`; licenses and attributions are in `licenses/fonts/` and `THIRD_PARTY_NOTICES.md`.

## Motion

In `src/app.ts`, `render()` computes a structural signature before mutating the DOM and starts a same-document view transition (`list`, `forward`, `back`) only when session membership, group placement, or route changes; routine `lastSeenAt` refreshes commit directly.

A same-scope transition from a non-empty waiting or held queue to all clear sets `data-arrived="true"` (`--motion-long` ring fade and `--motion-medium` title rise in `src/styles.css`) and strips it before row detachment so cached rows cannot replay. Unsupported browsers, hidden documents, open `<dialog>` elements, and `prefers-reduced-motion: reduce` skip view transitions ([PWA UI system](../../docs/BRANDING.md#pwa-ui-system-omp-sessions)).

## Trays

`src/tray.ts` drives `<dialog id="tray" closedby="closerequest">` (`src/index.html:64`) with an up-to-three-panel modal stack (`showModal()`). Intercepting `cancel` pops child panels or invokes `onBack`, `close` restores modality after non-cancelable consecutive Chromium close requests, exit waits for `transitionend` with a fallback, and root panels light-dismiss on outside clicks.

In `src/app.ts`, **Hide** opens `#tray` non-modally (`show()`, `role="status"`) for a 5-second **Undo** window paused on hover or focus. **Open request** mounts `packages/collab-client` at roughly 72% of the visual viewport, and **Expand** calls `tray.promote()` to reparent `.gateway-shell` and its client `#root` into `document.body` at `/client/` without remounting or dropping its socket or draft.

In **Control**, **Hold → next** tracks unanswered questions in a multi-question prompt rather than directory metadata alone; first-run trays reparent the hidden `#alerts-panel` template from `src/index.html` rather than cloning `#notify` ([PWA UI system](../../docs/BRANDING.md#pwa-ui-system-omp-sessions)).

## Multiple configured hosts

`src/fleet.ts` loads `GET /api/v1/client-config` (4-second timeout, 32 KiB cap) and polls up to seven remote `fleet.targets` directly with CORS and omitted credentials, while `src/app.ts` binds launches, history, and bfcache resume to `SourceKey` (`id + "\0" + origin`) and a monotonic selection epoch ([Fleet sources](../../docs/ARCHITECTURE.md#fleet-sources), [Availability model](../../docs/ARCHITECTURE.md#availability-model)).

For fleet notifications (background Web Push alerts from other hosts via the home gateway's Push v3 coordinator; [Fleet notifications](../../docs/ATTENTION_SPEC.md#fleet-notifications)), one installed home PWA covers both local and selected remote hosts without a second PWA install.

`FleetNotificationTransport` posts 30-day owner grants to selected remote sources and activates them on the home gateway, while `src/app.ts` sends `omp-notification-mode` (`fleet: true`) and `omp-notification-reconcile` snapshots to `src/service-worker.ts` via `postMessage` and passes `probeGateway` and `speech.browserRecognition` to `startCollabWithCapability` (`packages/collab-client/upstream/src/embed.ts`).

## Creating a session in Tern

`src/session-creation.ts` (`SessionCreationController`) drives **New session** on the shared tray via `replace()`, skipping single-choice **Host** or **Working copy** steps, preselecting valid `omp.sessions.creation-prefs.v1` choices, and tracking **Starting in Tern → Waiting for OMP → Opening Control**.

`SessionCreationTransport` uses 4-second `GET` and 10-second `POST` timeouts, polls status 1 second after each response across a 120-second budget, and limits **Check creation** `POST` replay to intents younger than 1 hour ([Session creation state machine](../../docs/PROTOCOL.md#session-creation-state-machine)).

The optional **First task** (at most 8,000 Unicode code points and 32 KiB) stays in page memory and passes once through `takeInitialPromptDraft` into an empty writable **Control** composer after ordinary OMP discovery and launch, never auto-sending.

## Synthetic visual review

From the repository root, `bun run test:visual` builds `apps/web/dist/` and runs `visual/dashboard.visual.ts` (`playwright.visual.config.ts`) across 21 deterministic synthetic snapshots (seven states at `390×844`, `810×1080`, and `1280×800`) from `e2e/synthetic-product-fixture.ts` without starting Percy or requiring a token (`visual/snapshot-safety.test.ts` checks the serializer guards).

`bun run test:visual:percy` uploads those 21 guarded snapshots when `PERCY_TOKEN` and native Node.js (24.22.0 LTS in CI) are on `PATH` for the Percy CLI while builds and workers run on Bun 1.4.4; serialization guards and preflight rules are in [BrowserStack and Percy visual review](../../docs/BROWSERSTACK.md).

## Tests

After `bun install --frozen-lockfile` and `bunx playwright install` (see [Contributing](../../CONTRIBUTING.md#build-from-source)), run `bun --cwd=apps/web run typecheck` and `bun test apps/web/test` from the repository root.

Run the Chromium mobile lane (`playwright.config.ts`) with `bun run test:browser`, the cross-engine `@core` lane (`playwright.compat.config.ts`) with `bun run test:browser:compat`, or one suite with:

```sh
bun run build && bun scripts/test-browser.ts apps/web/e2e/trays.e2e.ts
```

| Suite (`e2e/`) | Coverage |
|---|---|
| `availability-lifecycle.e2e.ts` | Local and remote fault ownership, `403` withdrawal, retained empty clocks, cross-host triage notices, and bfcache revalidation. |
| `client-refresh.e2e.ts` | Embedded collaboration client refresh behavior in **View** and **Control** across phone and desktop viewports. |
| `desktop-layout.e2e.ts` | Narrow directory column and widened `60rem` collaboration shell alignment on desktop viewports (`@core`). |
| `embedded-progress.e2e.ts` | Chunked join and reconnect progress, pre-live gateway or relay outages in request trays, and first-draft non-submission. |
| `first-run.e2e.ts` | Three-step introduction, step resume, skip/Escape dismissal, corrupt-storage suppression, and queue-to-all-clear arrival gates (`OMP_FIRST_RUN_SCREENSHOTS=<dir>`). |
| `fleet.e2e.ts` | Two-origin CORS polling and launches, credential omission, forbidden remote traffic audit, offline grace, and bootstrap recovery. |
| `fleet-notifications.e2e.ts` | **Settings → Hosts** grant enrollment, renewal, revocation, Push v3 click revalidation, Push v2 compatibility, and IndexedDB worker persistence (`@core`). |
| `launch.e2e.ts` | Same-document **View** and **Control** handoff, answer triage bar, `/client/` reload fallback, and capability-free bfcache restore (`@core`). |
| `motion.e2e.ts` | Structural-signature view transitions vs quiet refreshes, cancelled forward transitions, and `prefers-reduced-motion` (`@core`). |
| `network-recovery.e2e.ts` | SSE/snapshot reconnect, first-snapshot retry fault retention, stale rows, and 45-second **Troubleshooting** guidance (`@core`). |
| `notifications.e2e.ts` | Activity-stop **View** routing, exact-request **Control** routing, stale route rejection, and in-place notification taps (`@core`). |
| `session-creation.e2e.ts` | **New session** wizard, terminal errors, 1-hour lost-acknowledgement replay, memory-only **First task**, and remote CORS creation (`OMP_CREATION_SCREENSHOTS=<dir>`). |
| `software-keyboard.e2e.ts` | Visual-viewport software-keyboard avoidance and zoom-free mobile composer sizing (`@core`). |
| `theme.e2e.ts` | Live dark/light system scheme switching and 4.5:1 text contrast across Signal surfaces (`@core`). |
| `trays.e2e.ts` | Modal stack, paused **Undo**, ~72% request tray and full-screen promotion, and multi-section **Hold → next** (`OMP_TRAY_SCREENSHOTS=<dir>`). |
| `update.e2e.ts` | Immediate worker claim, 1-second idle directory reload, and deferred updates during active launches, routed alerts, or sessions (`@core`). |
