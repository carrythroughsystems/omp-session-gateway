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

## Multiple configured hosts

`GET /api/v1/client-config` is loaded once per document, bounded to 32 KiB with a four-second
deadline. A 404 retains the local-only experience; malformed, unsupported or origin-mismatched
configuration leaves the local directory usable and offers Reload. Configuration changes need
a reload. The native Host picker scopes counts and actions, not transport work.

`fleet.ts` owns DOM-free remote transport and persistence helpers. Each configured remote origin
is fetched directly with CORS, omitted credentials, no-store and redirects refused. There is no
gateway proxy, remote SSE, remote configuration discovery, remote health endpoint or fleet push.
Visible pages poll every ten seconds with one coalesced request per host, a five-second deadline
and an 8 MiB body cap. Transient failures retain disabled stale rows for 35 seconds, then remove
them; a readable 403 clears rows immediately and stops automatic polling until Retry or foreground
transition. Hiding/freezing aborts work without recording a failure. Each source owns its epoch,
request sequence and revision domain; a completed full snapshot can have a lower revision after
a remote daemon restarts.

Session identity includes both the configured source ID and canonical origin. Launches freeze
that binding, generation, requested mode, optional ask identity and selection epoch. A newer intent,
picker change, pagehide, or withdrawn source cancels the old attempt; a late response cannot mount
another host's same-ID session. View-to-Control, Hold-to-next, history, and bfcache resume retain
the binding. All-hosts attention uses this browser's first-observed waiting order, not clocks from
different hosts. Single-host queues retain ask timestamp FIFO.

Hold and Hide persist only bounded metadata records in `omp.sessions.held-asks.v2` and
`omp.sessions.dismissed.v2`, adding `sourceId` and `sourceOrigin` to the previous record shapes.
V1 records migrate to the local source; the old key is removed only after the v2 write succeeds.
Removed or rebound source records are discarded. Transport failures never prune these decisions.
Push and notification intents always address the home host, even when remote instance IDs collide.
Remote Hold never enumerates home notifications. Alerts for other hosts require their own PWA install.

The embedded client receives a bounded source-bound sessions probe and the home configuration's
`speech.browserRecognition` opt-in. Keyboard dictation remains the baseline. In-page recognition,
when enabled and supported, is Control-only; accepting recognized text and sending it are separate
actions owned by the pinned collaboration client.

Focused checks: `bun --cwd=apps/web run typecheck` and `bun test apps/web/test`.
`e2e/fleet.e2e.ts` runs two real loopback origins with reciprocal exact-origin CORS, verifies
preflight and credential omission, and audits a metadata-only request log for forbidden remote
SSE/configuration/push traffic. Browser coverage uses the repository's normal browser runner.

## Synthetic visual review

From the repository root, `bun run test:visual` builds the real dashboard/client and validates six
states at 390×844, 810×1080 and 1280×800 (18 unique state/project names). It never starts Percy
or passes a token. Fixed clock/randomness, en-US/UTC, dark theme, reduced motion and DPR 1 keep
captures deterministic. Directory asks are metadata-only; collaboration prose/code are authored
synthetic content from `e2e/synthetic-product-fixture.ts`, whose defaults also serve README capture.

`bun run test:visual:percy` requires `PERCY_TOKEN`, a healthy local Percy server started by the
pinned CLI, all 18 guarded submissions and a finalized build. Native Node.js (24.22.0 LTS in CI)
must be on `PATH` for the Percy CLI only; builds and the visual worker stay on Bun 1.4.0. CI
passes the executable from its SHA-pinned setup-node step; missing local Node fails closed with
`reason=node-missing`. Percy must not run under Bun's HTTP compatibility layer.
Serialized HTML/resources and the
SDK's exact POST fail on any canary/identifier material; no silent fallback, traces, recordings,
raw diagnostics or committed Percy output are allowed. Geometry includes the 560px directory,
900px desktop View transcript and aligned session header, plus serialized parity at every viewport.
Control Ask retains its bounded 880px embedded body and inner transcript, with the same parity
and header-alignment checks rather than the normal View width.
This advisory signal does not replace functional e2e or qualification. Project setup, eligible
CI events and review policy are in [BrowserStack](../../docs/BROWSERSTACK.md).
Failures report only closed-set phases/reasons and bounded counts, never raw Percy/browser text.
Upload mode additionally runs an 18-state testing-host preflight and scans the redacted CLI logs
Percy would receive; the vendor uploads CLI logs with builds even while CI-log upload is disabled.
The retained fixture guard must also reject a planted SDK-log canary. This preflight never runs
in local mode or uses a real token.
