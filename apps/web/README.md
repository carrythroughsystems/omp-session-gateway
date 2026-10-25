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
- one native tray system for Background alerts, Alert detail, Troubleshooting, request Options,
  paused-on-interaction Undo, and requests that expand into the same live session;
- resumable, skippable first-run trays: Connected, Background alerts, View or Control;
- one-shot all-clear arrival when the last queued/held request clears or ends, with an
  answered/all-clear check draw-in inside the session shell;
- privacy/security guidance.
- opt-in **New session** trays for host, approved project/working copy/profile, review, and
  creation tracking; **Create and open Control** adopts the new OMP session through its ordinary
  discovery and generation-bound launch, never a native Tern handoff.

Background alerts (Web Push) are opt-in per device from the Settings tray; see
[Compatibility](../../docs/COMPATIBILITY.md#platforms-and-browsers) for exact qualified
combinations and evidence. Passkey enrollment and per-Control WebAuthn verification are not
implemented.

Service workers never navigate open pages during activation or notification clicks: activating a
new worker claims clients in place (`clients.claim()`), and each open page reloads itself only when
it is idle with no pending launch, routed notification, or mounted collaboration client.

The dashboard receives metadata only. It must not render transcripts, prefetch capabilities, or implement the OMP collaboration protocol.

The service worker precaches only immutable, versioned application-shell assets. Content-hashed,
first-party-served Symbols Nerd Font Mono chunks cover only Private Use Area glyphs; they are
downloaded lazily by `unicode-range`, cached on first use in the shell cache, and served cache-first
thereafter. It must bypass `/api/`, `/client/`, launch responses, and collaboration navigation.
Use no third-party runtime scripts, remote fonts, analytics, or CDNs.

Text keeps system/local font stacks; the symbols use the Mono face's uniform one-em advance and
never replace ordinary Unicode characters. Regenerate the vendored Nerd Fonts v3.5.1 subsets with
`bun scripts/vendor-nerd-symbols.ts` (fontTools with Brotli and `pyftsubset` on `PATH`;
`FONTTOOLS_PYTHON` can select its Python environment). The script downloads and SHA-256-verifies
the pinned archive, or accepts `--source <directory>` for an already-extracted copy. Deterministic
chunks contain at most 160 populated BMP PUA glyphs or 768 plane-15 glyphs each; the build hashes
their bytes and appends their `@font-face` rules without changing the shell precache list.
See `licenses/fonts/nerd-fonts/` and `THIRD_PARTY_NOTICES.md` for licenses and icon-set attributions.

## Motion

Motion runs only on user-initiated transitions and genuine state changes (ADR-040). `render()`
computes a structural signature before touching the DOM and starts a typed same-document view
transition (`list`) only when it changed; a refresh that moves `lastSeenAt` alone commits without
one. Full-screen View from the directory runs a `forward` transition in which the tapped tile morphs into
the shell header tile, and the interactive return runs `back`; renders that arrive during a
navigation wait for it. Every commit is the same with or without motion: an unsupported browser,
a hidden page, an open dialog, or `prefers-reduced-motion` skips the transition and applies the
DOM directly. `e2e/motion.e2e.ts` pins which changes animate; the visual lane keeps reduced motion.

ADR-042 adds one deliberate arrival inside a genuine same-scope `list` transition:
`data-arrived="true"` expands/fades the emerald ring over `--motion-long`, raises the title
4px over `--motion-medium`, and settles the copy 60ms later. The prior signature includes the
scope and both waiting/held groups; a fresh load, scope change, or unchanged return never plays it.
A queue emptied while a session was open does play on return. Cached rows lose the arrival
attribute before detaching, preventing replay. The shell's **Answered — all clear** check is an
inline SVG stroke drawn once over medium. Reduced motion removes both effects.

## Trays

`src/tray.ts` owns one native `#tray` dialog and a maximum-three-panel stack (ADR-041).
Each modal panel has one topic or primary action, a title, and a 48px leading Close or Back control.
Settings opens **Background alerts**; only enabled alerts reveal **Alert detail**, whose radios
apply immediately and return to the root. The existing notification elements are moved, not copied.
The quiet, outlined **Options** chip opens **This request** with immediate Hold for desk and View transcript choices.

Modal trays use `showModal()`, native focus containment and focus return, body scroll lock, and
safe-area padding. Escape/platform close requests pop a child or dismiss the root without adding
history entries. Only the grip drags; the body scrolls independently. Content swaps make the
outgoing panel inert and move focus to the incoming heading while measured heights transition.
Adjacent panels differ by at least 24px; reduced motion swaps instantly. Class-driven exits keep
the dialog modal until `transitionend` or a bounded fallback closes it on engines without
`overlay`/`display` transitions. Backdrop coordinates provide light dismiss without `closedby`.

Hide uses the same host non-modally as a compact tile/copy/filled-Undo row, without a heading,
grip or countdown. Its polite status announcement has a five-second Undo window paused while
hovered or focused. Generation/source-bound Undo and persistent Show all
retain their device-local semantics and storage formats.

Open request immediately presents a compact amber loading tray. The ordinary validated launch
mounts the pinned client once inside a roughly 72%-visual-viewport panel. One header owns the
session tile/title, connection dot and icon-only Expand control; the client's inner frame is flat,
and its shell bar stays hidden until promotion. Expand (or tapping the
tray title) grows to the visual viewport, then reparents the same shell and `#root` into the body;
the relay socket and composer draft survive, and only promotion replaces the URL with `/client/`.
Closing disposes synchronously and restores the cached directory. Pagehide drops the capability;
bfcache resume revalidates and reacquires it with the original full/tray presentation. No document
View Transition runs while the dialog is open. `e2e/trays.e2e.ts` covers these transitions and
capability non-persistence; optional `OMP_TRAY_SCREENSHOTS` writes synthetic smoke screenshots.

The first-run introduction uses the same host after an authoritative render on a visible `/`
entry, never during loading, a session, a routed launch, or another open tray. Connected uses
the masthead mark and the current host label/session count. Background alerts moves the single
`#alerts-panel` (and its real seven-state `#notify` control); **Not now** advances without enabling.
View or Control explains the two explicit actions. **Next**/**Done**, native Back/Esc, and the
leading controls share the stack; resume preloads Back destinations without showing intermediate
steps. The root control is named **Skip introduction**. Every step focuses its heading and has
a different height on phone and desktop. `e2e/first-run.e2e.ts` covers persistence, notifications,
arrival gates, privacy, and optional synthetic screenshots via `OMP_FIRST_RUN_SCREENSHOTS`.

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

The separate `localStorage` key `omp.sessions.first-run.v1` stores only
`{ "version": 1, "step": "alerts" | "modes" | "done", "updatedAt": "<ISO timestamp>" }`,
bounded to 128 characters. A missing record starts Connected; Back to Connected removes the
record; advancing records the current step; Done or skip records `done`. Corrupt/unsupported
records and inaccessible storage count as done. No identifiers, permission state, or capabilities
are stored by the introduction.

The embedded client receives a bounded source-bound sessions probe and the home configuration's
`speech.browserRecognition` opt-in. Keyboard dictation remains the baseline. In-page recognition,
when enabled and supported, is Control-only; accepting recognized text and sending it are separate
actions owned by the pinned collaboration client.

Focused checks: `bun --cwd=apps/web run typecheck` and `bun test apps/web/test`.
`e2e/fleet.e2e.ts` runs two real loopback origins with reciprocal exact-origin CORS, verifies
preflight and credential omission, and audits a metadata-only request log for forbidden remote
SSE/configuration/push traffic. Browser coverage uses the repository's normal browser runner.

## Creating a session in Tern

**New session** appears beside the directory controls and in its empty state. A host must opt in
with administrator-approved Tern choices; an older or unconfigured gateway shows an honest
unavailable panel with **Retry options**, never a guessed executable or path. The wizard uses
logical Back on the existing native tray, replacing one panel per step without browser history
entries. One host and one working copy skip their respective choice panels; a scoped/remembered
host and valid remembered choices are preselected against fresh options.

The explicit **Create and open Control** action generates one operation UUID. Options/status
requests time out after four seconds; POST after ten. Remote calls use CORS with omitted
credentials and refused redirects; readable authorization loss revokes the source. Status polling
starts one second after the preceding request completes, with a 120-second watching budget.
Starting session shows **Starting in Tern → Waiting for OMP → Opening Control**: completed steps
use the triage check, the active emerald dot uses the existing status pulse, and future steps are
muted. Reduced motion keeps the dot still. Opening Control remains visible and cancellable until
the ordinary session shell mounts.
Closing, changing scope, competing navigation/trays, authorization loss, backgrounding, freeze,
and pagehide stop watching, not the command running in Tern. Foregrounding never automatically
creates or opens. **Check creation** reads the known operation or explicitly replays the identical
POST after a lost acknowledgement; after the watching deadline it performs only one bounded check.
No uncertain outcome automatically retries creation.

Only `{sourceId, sourceOrigin, projectId, workingCopyId, profileId, updatedAt}` choices persist in
`omp.sessions.creation-prefs.v1`: version 1, at most eight records and 16 KiB. Removed/rebound
sources are pruned only after an authoritative bootstrap. Storage failure leaves creation usable.
Tracking intents and the optional **First task** remain in page memory, never requests, history,
storage, logs, or process arguments. The task is bounded to 8,000 Unicode code points / 32 KiB;
backgrounding preserves it in the suspended flow, while explicit Close, selection changes,
authorization loss and pagehide discard it.

Ready refreshes that source, requires the exact instance/generation and Control, then opens the
ordinary full-screen client. A source/instance/generation-bound holder supplies the draft once
through `takeInitialPromptDraft`; only the client inserts it into an empty, live writable composer.
It never sends, overwrites an existing draft, or fills an Ask. A failed pre-mount open may retry
the same binding; cancellation, changed bindings and shell disposal discard the holder.

`e2e/session-creation.e2e.ts` covers the wizard, terminal states, lost acknowledgements, native
Back, background/foreground, preferences, source-bound CORS and private sinks. Set
`OMP_CREATION_SCREENSHOTS` for synthetic step/state captures at 412×915 and 1280×800.
This browser evidence is not real-host Tern or physical-device qualification.

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
