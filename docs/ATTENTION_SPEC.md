# Needs-attention and notification detail contract

This specification is for contributors implementing or verifying the **OMP Sessions** attention queue, per-device **Background alerts** controls, Push v2 and Push v3 notification lifecycles, and notification tap revalidation in OMP Session Gateway, the companion to Oh My Pi (OMP).

For the latest release and qualified device evidence, see [Current claim](COMPATIBILITY.md#current-claim) and [Release status](RELEASE_STATUS.md); read alongside [Architecture](ARCHITECTURE.md) and [Protocol contracts](PROTOCOL.md).

Design rationale is in [ADR-017](DECISIONS.md#adr-017--deliver-actionable-attention-through-metadata-only-web-push), [ADR-019](DECISIONS.md#adr-019--complete-the-couch-flow-attention-contract-with-bounded-presentation-metadata), and [ADR-026](DECISIONS.md#adr-026--keep-couch-triage-device-local-without-inventing-session-lifecycle).

Tray and fleet alert updates are in [ADR-027](DECISIONS.md#adr-027--ship-the-couch-flow-visual-system-with-a-settings-sheet-and-a-precached-client) and [ADR-048](DECISIONS.md#adr-048--fleet-notifications-through-the-home-gateway-as-coordinator).

## Product boundary

What may **OMP Sessions** display outside the collaboration client, and where do capabilities stay? **OMP Sessions** is a metadata directory and per-tap capability broker rather than a second agent UI: a **View** or **Control** link is a bearer secret, called a capability in the contracts, and an OMP host (one running `omp` process) owns transcript and prompt state.

The directory and notification layer handle only bounded metadata:

- normalized session title and working-directory basename (`title`, `cwdLabel`);
- boolean `inputRequired` and optional boolean `busy` activity;
- an opaque gateway-minted `ask.requestId` and daemon receipt timestamp (`ask.since`);
- optional bounded `ask.preview` and `ask.optionCount` fields in the browser schema.

The directory never renders transcripts, prompt choices, prefills, answers, or capabilities. Stock OMP `>= 18.1.20` supplies boolean `inputRequired`, and OMP `>= 18.2.9` adds boolean `busy` ([Additive activity compatibility](OMP_INTEGRATION.md#additive-activity-compatibility)).

Neither supplies request text, so `ask.preview` and `ask.optionCount` are omitted: the hero shows `Waiting for your input` (or `Waiting for your input — Control unavailable` when read-only), **Preview** alerts fall back to **Session** detail, and **Control** opens the live request in the embedded collaboration client.

## Directory behavior

How does `apps/web/src/app.ts` order and render the home screen across single-host and multi-host views? The directory renders one whole-screen state at a time (user flows in [The directory](USAGE.md#the-directory), [Needs you](USAGE.md#needs-you), and [Hold and hide](USAGE.md#hold-and-hide)):

- Single-host queue ordering (`Needs you`, pill `N waiting` or `N waiting · M held`, where `N` counts waiting plus held): when one host is in view (single-host setup or a single-host filter), waiting and held rows sort FIFO by `ask.since` (falling back to `lastSeenAt`, tie-breaking by `instanceId`).
- Multi-host queue ordering: under **All hosts** across multiple configured sources (`sources.size > 1`), waiting and held rows sort by `observed waiting order` (when this open page first observed each exact request, tie-breaking by configured source order, `instanceId`, and `requestId`).
- Hero layout: when at least one unheld request is waiting, the oldest becomes the **Up next** hero card, remaining unheld waiting rows appear under **Then**, held rows appear under **On hold · N**, and non-waiting rows appear under **Live sessions · N** (or **Sessions · N** with the incomplete-coverage summary above the queue when scope coverage is incomplete).
- All-held summary: when every waiting request in view is held, `Needs you` renders `Queue clear · N on hold — handle at desk` (or `N on hold · some hosts unavailable` / `N on hold · checking other hosts` when coverage is incomplete) instead of an **Up next** hero, followed by **On hold · N** and non-waiting rows.
- Working list (`Sessions`, pill `Live · N` or `Listed · N`, including device-locally hidden rows): on complete host and alert coverage, renders **All clear** (`Nothing needs you.`, plus `Alerts are on for input requests and activity stops.` when alerts cover the view) and **Live sessions** sorted newest-first by `startedAt`.
- Settings hint and incomplete coverage: on a single host or local scope with alerts `idle` or `blocked`, **All clear** adds **Enable alerts to get pinged** or **Alerts blocked · Settings**; incomplete host or alert coverage renders **Host coverage incomplete** (or `Checking host coverage`) and labels the list **Sessions**.
- Empty state (`Sessions`, no count pill): on complete unfiltered coverage, `#empty-state` renders **No live sessions** (`Start an interactive OMP process.`) with `collab.autoStart` guidance and **New session** (`#empty-new-session`); when filtered to one host or when coverage is incomplete, denied, withdrawn, or expired, `.empty-state-detail` explains why and offers **All hosts** when filtered.
- Hero actions and **Options** tray: the primary hero button is **Open request** (`canControl: true`) or **View transcript** (`canControl: false`), opening the floating request tray. Every **Up next** hero renders **Options**, opening the **This request** tray (`#tray`) with **Hold for desk** and **View transcript** (full-screen **View** when `canView` is `true`), and any `ask.preview` renders verbatim without uppercasing alongside `N option(s) to pick from` (`ask.optionCount`).
- Row button structure: only **Then** waiting rows are single whole-row `<button>` elements. Held rows wrap `.held-open` (request tray) and **Requeue** (returns to **Needs you**), and non-waiting rows wrap `.working-row` (read-only **View**) and `.dismiss-session` (device-local **Hide** with 5-second **Undo** and the `N hidden on this device` / **Show all** footer, sending no network request).
- Freshness and activity: the masthead has no manual refresh control; snapshots, SSE, liveness checks, and bounded retries govern freshness. Known `busy` (`Working` vs `Idle`) is distinct from `Activity unknown` and never implies task completion or process exit.

## Notification control

How are per-device Web Push permissions and detail levels controlled and stored? Tapping masthead **Settings** opens the **Background alerts** floating `<dialog id="tray">` tray (`#alerts-panel` in `apps/web/src/index.html`, user flow in [Background alerts](USAGE.md#background-alerts)), whose primary control (`#notify`) uses seven exact labels:

| State | Label | Enabled? |
|---|---|---:|
| `checking` | `Checking background alerts…` | No |
| `idle` | `Enable background alerts` | Yes |
| `enabling` | `Enabling…` | No |
| `disabling` | `Disabling…` | No |
| `enabled` | `Disable background alerts` | Yes; disables in place |
| `blocked` | `Notifications blocked` | No |
| `unavailable` | `Background alerts unavailable` | No |

Browser notification permission is requested only from an explicit **Enable background alerts** tap inside the tray; an already-granted subscription reconciles on load without prompting. While `enabled`, **Background alerts** displays **Alert detail**, which pushes the child **Alert detail** panel (`#detail-panel`) onto `#tray`.

The home gateway persists one `detailLevel` per browser subscription endpoint in `<stateDir>/push-state.json` (`POST /api/v1/push/subscription` in [Background alerts in Protocol](PROTOCOL.md#background-alerts)):

- `private`: fixed title only, with `body` omitted;
- `session` (*default*): session title and project basename labels;
- `preview`: `session` detail plus `ask.preview` when available (falling back to `session` for stock OMP).

**Alert detail** warns that **Preview** text may persist in notification history, screenshots, and on wearables, and states that payloads are built on the gateway at the chosen level rather than redacted on the phone. Tapping **Disable background alerts** unsubscribes in the browser and sends `DELETE /api/v1/push/subscription` to remove that endpoint from `push-state.json`; push-service `404` and `410` responses also evict matching delivery targets.

## Notification lifecycle

When does the gateway send or clear an attention notification, and how is delivery paced? Each accepted `false → true` `inputRequired` edge mints a fresh opaque `requestId` and daemon receipt timestamp (`ask.since`), preserved across consecutive `true` polls; only **Control**-capable (`canControl: true`) sessions emit `attention` pushes because read-only **View** sessions cannot answer requests.

Answering, removing, expiring, or replacing a request queues an exact `clear` before any replacement `attention` (Push v2 JSON shapes in [Web Push notification envelopes](PROTOCOL.md#web-push-notification-envelopes)):

- Replacement tags: `apps/web/src/service-worker.ts` uses one tag per local session (`omp-attention-<instanceId>`) and `omp-attention-<binding>-<instanceId>` for a remote fleet source, where `<binding>` is the 22-character base64url source binding in [Fleet notifications in Protocol](PROTOCOL.md#fleet-notifications).
- Notification `data` and badge: the worker updates the app badge and stores minimal notification `data` (`{ version, type: "attention", source?, instanceId, requestId }` for requests or `{ version, type: "activity_stop", source?, instanceId, generation }` for stops, with `source` on Push v3 remote alerts only).
- Exact-request clear matching: a `clear` closes a displayed notification only when its stored `requestId` matches (waiting out an in-memory 2,000 ms settle window and re-querying if shown within 2,000 ms in the current worker lifetime; notices inherited across a worker restart close immediately), so a delayed clear cannot close a newer request or an activity stop.
- Urgency, TTL, and absent `Topic`: pushes use `high` urgency, a 5-minute TTL, and no Web Push `Topic` header; Firebase Cloud Messaging (FCM) treats `Topic` as a collapse key and throttles collapsible messages to 20 per app per device (refilling 1 every 3 minutes), whereas omitting `Topic` avoids that throttle and delivers all unexpired pushes when an offline device reconnects.
- Per-endpoint 1-second pacing: the gateway sends to each subscription endpoint one push at a time across a shared 8-send concurrency pool (`#withSendSlot`), waiting at least 1 second (`PUSH_ENDPOINT_SPACING_MS = 1_000`) after the previous send to that endpoint settles before acquiring a slot and revalidating live subscription ownership inside the slot.
- Cross-device Push v2 ordering: pacing one endpoint does not hold shared send slots against other endpoints, except that Push v2 chains sends per `instanceId` across subscribed devices, so a slow endpoint on one device can delay that session's next Push v2 push to another device.

## Activity-stop notifications

Which state transitions produce an `activity_stop` alert, and how does it interact with `attention` and `clear`? OMP hosts at `18.2.9` and above ([PR #12844](https://github.com/can1357/oh-my-pi/pull/12844)) publish optional boolean `busy` from `session.isStreaming` (`true` while a turn runs, `false` when idle, and unknown when `null` or omitted, never proving task completion or process exit); OMP `18.1.20`–`18.2.8` hosts remain visible with unknown activity and never emit stop alerts.

`SessionRegistry` emits an internal activity-stop event (never a browser SSE event) only on a known `true → false` sample for the same continuing `instanceId`, `generation` (OMP's counter that changes when a session is replaced), and immutable `pid`/`sessionId`/`startedAt` identity when neither sample has `inputRequired: true`:

- Non-triggers and uncertainty: ask start or resolution wins when overlapping a sampled stop; initial `false`, repeated `false`, unknown `busy`, generation or identity replacement, disappearance, dead endpoints, TTL expiry, and daemon restart never synthesize a stop, and transient unreadable polls clear `busy` knowledge without extending TTL so recovery at `false` cannot alert.
- Eligibility and send-time recheck: read-only **View** sessions are eligible (`private` omits `body`; `preview` uses `session` detail; wire shape in [Web Push notification envelopes](PROTOCOL.md#web-push-notification-envelopes)). Subscribing or opening the app never replays past stops, and an in-memory stop marker invalidates queued stops across any activity, uncertainty, ask, or identity change before transmission.
- Worker activation: handling `activity_stop` requires an active current service worker; because an older Push v2 worker ignoring an unknown type under `userVisibleOnly` can trigger a browser-generic background notice, open or refresh **OMP Sessions** after upgrading the gateway to activate the updated worker.
- Tag precedence, `clear` isolation, and badge: stops share the session's notification tag, 5-minute TTL, and ordered queue. A displayed valid `attention` suppresses an incoming stop, `attention` replacing a stop sets `renotify: true` (duplicate `requestId` deliveries are skipped, and a newer Push v2 ask sets `renotify: false`), `clear` messages never close a stop, and the badge counts waiting **Control**-capable requests only.
- Best-effort delivery: brief turns between 10-second polls can be missed, and push services can delay or reorder messages (an ask answered while offline may alert briefly before its `clear`, and a `clear` overtaking its `attention` on Push v2 leaves that alert visible until dismissed or replaced; taps always revalidate live state).

## Notification tap

How does tapping a notification route into **Control** or **View** without exposing a capability? Capabilities never enter push state or payloads, notification `data`, routing URLs, browser history, service-worker messages, browser storage, caches, logs, or diagnostics; `requestId` and `generation` are correlation metadata only, never bearer authorization ([Web Push notification envelopes](PROTOCOL.md#web-push-notification-envelopes)).

- In-page handoff (`routeInPage`): the service worker never navigates an existing window ([ADR-017](DECISIONS.md#adr-017--deliver-actionable-attention-through-metadata-only-web-push), [ADR-018](DECISIONS.md#adr-018--activate-pwa-upgrades-automatically-without-interrupting-live-collaboration)).
- Window focus and message acceptance: the worker focuses the most recently focused same-origin window client and posts `omp-notification-route` over a `MessageChannel` ([ADR-017](DECISIONS.md#adr-017--deliver-actionable-attention-through-metadata-only-web-push)), waiting up to 3 seconds for `omp-notification-route-accepted` so an open page revalidates fresh metadata in place and keeps an already-open session when its authority matches.
- Fallback shell route: when no same-origin window is open or accepts within 3 seconds, `clients.openWindow()` opens `/collab/{instanceId}?request={requestId}` (attention) or `/collab/{instanceId}?activity=stopped&generation={generation}` (stop). Both routes reject duplicate, mixed, extra, fragment-bearing, or malformed parameters, and `app.ts` synchronously scrubs the URL to `/` before networking.
- Attention tap (**Control**): loads fresh authenticated metadata and calls `POST /api/v1/sessions/:instanceId/launch` (`mode: "control"`) only when the same `instanceId` has the exact `requestId`, `inputRequired: true`, and `canControl: true`; otherwise keeps the directory with `That notification changed or expired. Choose a current session.` (or keeps an open session and shows `That alert changed or expired.` in its triage bar when that bar is hidden).
- Activity-stop tap (**View**): loads fresh authenticated metadata and opens read-only **View** only when the same `instanceId` and `generation` remain live with `canView: true`, never upgrading to **Control** even if activity resumed; gone or replaced sessions keep the directory or open session with the same expired/changed notice above.

## Fleet notifications

Fleet notifications — background Web Push alerts for selected remote hosts, called sources, delivered by the home gateway acting as coordinator ([ADR-048](DECISIONS.md#adr-048--fleet-notifications-through-the-home-gateway-as-coordinator)) — let one installed **OMP Sessions** app alert across hosts. Wire shapes and HTTP status codes are in [Fleet notifications in Protocol](PROTOCOL.md#fleet-notifications), and user steps are in [Alerts from other hosts](USAGE.md#alerts-from-other-hosts).

### Opt-in and enrollment

The **Background alerts** tray renders the **Hosts** section (`#notification-hosts`) only when `POST /api/v1/push/fleet/status` succeeds on the coordinator (`fleetNotificationsOffered` in `apps/web/src/app.ts`), background alerts are `enabled`, an active Push v3 service worker controls the page (`notificationWorkerV3`), and no worker mode transition is in flight (`fleetWorkerModePending === undefined`).

- Turning a source switch on creates, authorizes, and activates a new 30-day grant when absent or unauthorized (or unconditionally renews an existing grant at the source; background status refreshes renew selected grants within 10 days of expiry), then adds the source via `PUT /api/v1/push/fleet/recipient`.
- Turning a source switch off updates selection with `PUT /api/v1/push/fleet/recipient` when other remote sources remain selected or `DELETE /api/v1/push/fleet/recipient` when none remain (returning the subscription to Push v2); once no subscribed device of that owner selects the source, the coordinator discards the grant secret and returns `{ sourceId, grantId }` in `released` so the page revokes it at the source.

| Row condition | Status text |
|---|---|
| Selected, `current` | `Covered` |
| Selected, `pending` | `Connecting…` |
| Selected, `stale` | `Unreachable · showing last known` |
| Selected, `unauthorized` or `not_enrolled` | `Needs approval on this host` (with **Reconnect**) |
| Selected, `unsupported` | `Host gateway does not support alerts` |
| Not selected | `Off` |

The section summary reads `All selected hosts covered` when every selected source is `Covered` and `N of M selected hosts covered` otherwise (a partial enable leaves each row in its own state), without altering the **Disable background alerts** button, which reflects local permission and subscription state only.

### Alert content

Fleet pushes (`version: 3`) reuse the Push v2 titles (`OMP session needs attention` and `OMP session activity stopped`):

- Detail levels: `private` omits `body`. At `session` and `preview` (`preview` behaves as `session` for every fleet alert), a remote source alert shows `<configured host label> · <6-char instanceId suffix>` — never a session title, working directory, or preview — and a local alert prefixes `fleet.label` before local `session` detail.
- Tags and re-alerting: remote alerts use tag `omp-attention-<binding>-<instanceId>`, while coordinator-local sessions keep `omp-attention-<instanceId>` so Push v2 and Push v3 alerts for the same local session replace rather than duplicate each other. A new ask replacing a stop or an older ask whose clear has not arrived sets `renotify: true`; duplicate deliveries do not re-alert.

### Ordering and restart

Ordering and restart reconciliation span the service worker (`packages/protocol/src/fleet-ordering.ts`, `apps/web/src/fleet-worker-store.ts`), coordinator (`apps/gateway/src/fleet-coordinator.ts`), and open page:

- Durable worker reducer (`omp-notification-ordering` in IndexedDB): cleared request tombstones persist for 30 minutes (`FLEET_TOMBSTONE_RETENTION_MS`, up to 2,048 entries per map) across worker restarts and reordered pushes.
- Sequence, stop, and badge precedence: within the current epoch, `attention` and `activity_stop` pushes with `seq.n` at or below the session's mark are ignored while `clear` pushes apply; stops never replace a displayed valid `attention`; and older pushed badges never overwrite newer ones (a badge set on app open holds until the next push).
- Coordinator observation order: waiting requests across hosts are ordered by first observation at the coordinator, never by source host clocks.
- Coordinator restart clears: after startup (once local discovery and selected sources report, or after 30 seconds), the coordinator compares persisted per-recipient `outstanding` requests against live state and queues exact `clear` pushes for answered requests and for revoked, removed, or deselected sources.
- Local vs remote requests on home-gateway restart: because `SessionRegistry` is memory-only and OMP publishes boolean `inputRequired` without a durable request ID, a home-gateway restart mints a fresh `requestId` for each unanswered local ask, queuing an exact `clear` for the old ID and one replacement `attention` without concurrent duplicates or later re-alerts. Unanswered requests on remote sources keep their `requestId` and are not re-sent when only the home gateway restarts.
- Foreground snapshot reconciliation: on open, refresh, and every 10 seconds while visible, the page reads the worker's push receipt count (`asOf.received`) before fetching snapshots and posts `omp-notification-reconcile`, closing displayed attentions per session where no push touched that session after `asOf.received` and updating the badge only when zero pushes arrived since `asOf.received`.

### Badge and All clear

- App badge and persistent last-known asks: the badge counts known waiting **Control**-capable requests across `local` and selected `current` or `stale` sources. Each source's last-known asks (persisted in IndexedDB across app and phone restarts from the last fresh snapshot plus subsequent pushes and clears; cleared asks are never counted again) remain counted during an outage, and `count === 0` with `complete: false` shows the platform's unnumbered marker instead of clearing.
- Directory `All clear` gating: **All clear** renders only when every host in scope has a fresh snapshot, every selected alert source globally is `Covered`, and zero requests are waiting or held.
- Incomplete coverage summary: uncovered selected alert sources show **Host coverage incomplete** (`Known work only. Alerts unavailable for <hosts>.`, even if a snapshot poll also failed); otherwise failed or in-flight snapshot polls show `N of M hosts up to date. Other sessions may be missing.` (or `Refreshing the rest.`) while `#fleet-status` names each unavailable remote host row separately.

### Taps

Remote fleet alert routes append `&source=<binding>`. `app.ts` re-fetches `GET /api/v1/client-config` and `POST /api/v1/push/fleet/status` to verify that `<binding>` matches a configured `targets` entry whose grant is selected and `current`; an unknown binding, changed origin, or deselected/unauthorized source shows the expired/changed notice with zero launch requests, whereas a valid source refreshes `GET <origin>/api/v1/sessions` and launches directly against it.

### Limits

Fleet notifications depend on the home gateway: while the coordinator is asleep or unreachable, no fleet alert is sent, and the phone discovers missed changes only when **OMP Sessions** next opens. Install the PWA from an always-on host, and treat Web Push delivery as best-effort as in Push v2.

## Acceptance checklist

The first checklist records pre-cutover implementation acceptance, including **fork-era** layout and leak-suite evidence, rather than transferred mainline qualification.

The physical background-Push checklist below records signed-candidate evidence separately, while specialized triage and delayed-tap acceptance is requalified in each stable release on its exact signed candidate ([Current claim](COMPATIBILITY.md#current-claim)); implementation or development runs alone do not qualify a candidate, and the [release ledger](RELEASE_STATUS.md) is authoritative.

- [x] Whole-mode queue, FIFO `Up next`, boolean fallback, whole-row actions, and no manual Refresh.
- [x] Seven exact notification states; permission only after explicit enable.
- [x] Per-device Private/Session/Preview sheet with default, warning, footnote, and disable action.
- [x] Strict v2 attention/clear payloads; per-instance replacement; exact-request clear; app badge.
- [x] Notification tap scrubs and revalidates the exact ask before the no-store Control launch.
- [x] Last-known metadata survives phone, tailnet, desktop, and relay failures with distinct copy.
- [x] The measured 411×816 Pixel layout viewport and synthetic 390×844 browser checks remain overflow-free with targets at least 44px.
- [x] Capability-leak scan and focused protocol, registry, HTTP, app, worker, and browser tests pass.

### Physical background-Push acceptance

Run the [dedicated Android Push procedure](ANDROID.md#physical-background-push-lane) against the candidate gateway's exact Serve origin; an ordinary Chrome tab or a WebAPK for another gateway does not satisfy admission, and portable fake-runtime tests cannot check these physical-device boxes.

The operator turns Do Not Disturb (DND) off for the window while the lane observes DND, separates real-session alerts from the fixture by owned OS record keys and post times, allows at most one recorded phase re-arm on a single unowned overlap, and fails closed on ambiguous ownership or repeated interference.

Notification permission must be granted before admission. During the negative phase, the driver holds its origin-scoped Chrome DevTools Protocol (CDP) denial connection open without a page because disconnecting removes Chrome's override, then rewarms Chrome before releasing that connection and verifies restored preferences and fresh delivery.

- [x] Closed WebAPK task: Private, Session, and Preview delivery with exactly one owned notification.
- [x] Lock-screen UI matches the selected detail and does not contain ask/prompt/answer canaries.
- [x] Attention tap: scrubbed route, current request/generation validation, writable Control.
- [x] Known busy across two polls → idle: stop notification tap is read-only View.
- [x] Same instance N → N+1: old stop tap is scrubbed/expired with zero launch requests.
- [x] Authoritative clear removes the exact ask; a fresh request remains visible across repeated current samples.
- [x] Force-stop observed variant plus a fresh post-relaunch delivery.
- [x] Permission-denied suppression and a fresh delivery after restoration.
- [x] Lock/resume and forced-Doze observed variant, without asserting guaranteed delivery.
- [x] Actual Wi-Fi → cellular → Airplane → restored-tailnet behavior.
- [x] Seven browser sinks plus notification title/body/data, URL/history, DOM, and resource timings
  are proven detectable and clean; macOS service streams are observed discarded.
- [x] Original subscription/detail/permission, radios, battery/Doze, task, and display/keyguard
  state restored; owned fixture stopped. No screenshots, notification content, or XML persisted.

Every stable release from v0.6.0 onward passed the twelve checks above through its `androidPush` lane (failed earlier attempts are recorded in the [release ledger](RELEASE_STATUS.md)); see [Current claim](COMPATIBILITY.md#current-claim) for the latest release and its qualified device and browser versions.

The lane's detail, attention-tap, activity-stop, stale-generation, clear, force-stop, permission, lock/resume, network, Doze, forbidden-sink, and restoration phases map to these checks, recording delivery, tap/clear behavior, observed force-stop/Doze variants, ten detectable clean sinks, and restored device/browser/fixture state without guaranteeing background delivery.

<a id="specialized-triage-and-delayed-tap-acceptance--qualification-pending"></a>
### Specialized triage and delayed-tap acceptance

The checkboxes below reset for each candidate release; the latest release passed all of them in the physical background-Push lane ([Current claim](COMPATIBILITY.md#current-claim), [release ledger](RELEASE_STATUS.md)).

The implemented `triage_verified` and `stale_taps_verified` phases run after `clear_verified` and before `force_stop_verified` (followed by the fleet Push v3 phases when fleet qualification is active; [Physical background-Push lane](ANDROID.md#physical-background-push-lane)).

<!-- release-generate:campaign:start -->
The v0.11.0 qualification stays bound to its recorded candidate and devices. The v0.12.0 campaign must pass these scenarios again on its exact signed bytes before its matrix is qualified. See the [release ledger](RELEASE_STATUS.md).
<!-- release-generate:campaign:end -->
On 2026-10-01, a development run of the whole lane passed every phase,
these two included, with no re-arm, and restored the phone. It ran against the installed v0.7.1
gateway with stock OMP 18.4.8 fixtures on the Pixel 10 Pro, Android 17, Chrome `154.0.8037.57`.
That development run is tested evidence ([ANDROID.md](ANDROID.md#physical-background-push-lane)).
The boxes below stay unchecked because every candidate requalifies these phases; qualification is recorded in the [release ledger](RELEASE_STATUS.md). The lane owns a second fixture host, and before triage no other session in the installed app's directory may be waiting for input or hidden because order, **Hold for desk**, and **Show all** act on the whole device-local directory; the phase fails closed when this precondition is not met.

- [ ] Two fixture asks appear in arrival order (FIFO).
- [ ] Hold for desk on the oldest advances only this device's queue.
- [ ] Only the held ask's notification closes; the other ask's notification remains.
- [ ] Held asks remain in `N waiting · M held`; the gateway reports both asks.
- [ ] Requeue restores arrival order.
- [ ] Holding both shows `Queue clear · N on hold`, not all-clear.
- [ ] Replacing one exact request releases only its stale hold.
- [ ] Hide an idle row, then Undo within five seconds restores it.
- [ ] Hide again and let Undo expire; the row stays hidden and `Live · N` counts it.
- [ ] Later attention immediately restores the hidden row.
- [ ] Show all restores hidden rows.
- [ ] Triage actions, including Undo expiry, send no non-GET request to the gateway.
- [ ] A delayed tap after desktop resolution is rejected.
- [ ] A delayed tap after re-arming with a newer request on the same generation is rejected.
- [ ] A delayed tap after replacement by a new generation with its own request is rejected.
- [ ] A delayed tap after the host is gone is rejected.
- [ ] Each delayed tap scrubs its route before any API request, fetches metadata, makes zero launch requests, and shows the expired/changed notice.
- [ ] Cleanup stops both hosts, closes both topics' notifications, and waits for the app to drop both hosts' device-local Hold/Hide records.

Authoritative clear removes the original attention notification, so the delayed-tap phase **re-presents the original notification's own metadata-only data** through the app's service-worker registration and taps it from the physical Pixel's lock screen (`replayed: true`). This proves delayed-tap handling on that device rather than Web Push delivery ordering or delivery delay.

### Historical development observations — 2026-09-25

These observations predate the passed stable campaigns above and retain their original limits.
The 2026-09-25 development probes against v0.5.3 prove the stock-18.3.0 fixture transitions,
closed-task delivery and lock-screen detail at all three levels, full-sequence attention Control,
known-busy-to-idle View, same-instance stale rejection, clear/fresh retention, force-stop observed
delivery with fresh post-relaunch delivery, denied-permission suppression/restoration, and
digest-bound notification cleanup. The full sequence repeatedly timed out on lock/resume clear.
The smallest observed failing combined prefix was stale-generation → clear/fresh → force-stop,
failing its first post-relaunch clear. Instrumented repetitions received the exact current clear
and removed both browser and OS records; they did not establish the uninstrumented failure's cause.
Three repetitions with both page and worker DevTools detached through force-stop/relaunch/clear
also passed (0 failures in 3), with native enqueue-before-cancel ordering and unchanged delivery
targets. The absence of FCM receipt logs does not establish receipt ordering. On this Chrome
version, browser notification handles do not acknowledge native Android display; a silent
replacement followed immediately by close is therefore not a proven orphan repair.
An independent same-tag native-API probe then left orphans in 5/5 warm pairs and 0/5 cold-relaunch
pairs, despite zero browser handles after every close. Every warm replacement was enqueued after
native cancellation and remained visible to the OS observer about 15.8 seconds later. This proves
an API/native ordering failure, not its causal connection to the earlier full-sequence failure;
the worker now mitigates recent show/clear races with a 2,000 ms in-memory settle window,
an exact-request re-query before close, and duplicate-content replay suppression. This measured
budget is not an Android display fence or a qualification pass; old notices and notices
inherited by a fresh worker close immediately.
A detached native-API probe with that settle/re-query ordering then completed 10 warm and 5 cold
pairs with zero orphans. All pairs returned zero browser handles and remained natively absent
for at least 13.726 s after completion; fixture, transient UI, and device baseline were restored.
That controlled result does not substitute for the full Web Push checklist above.
Producer-first cleanup is enforced, but native-only orphan restoration was a separate explicit
experiment and is not credited as an authoritative-clear pass. Doze, the complete real network
matrix, and the final real sink sweep were then unproved end to end. These are **tested evidence**,
not qualification. See ANDROID.md for timings, restored
baselines, and the exact observed platform combination.

A later single uninterrupted run through the production adapter/runner against the retained Mac
and the development worker containing that mitigation again failed lock/resume authoritative
clear, after completing every phase through denied-permission restoration. It took 901.483 s
including cleanup; Doze, networking, and sinks were not reached. The final owned-topic native
enqueue preceded cancellation by 90.689 s with no later enqueue, unlike the controlled warm
replacement signature. FCM receipt, handler execution, and the lingering request/content identity
were not captured, so the cause remains unresolved. All ten device baseline booleans matched in
a post-run read-only check, the owned notification was absent, and the lease was released.
The original local-origin WebAPK remained installed after authorized retained-origin setup.
The mitigation is not a full-sequence fix and this run does not check the qualification boxes.

The cause was FCM's collapsible-message throttle. Every push carried a per-instance Web Push
`Topic`, which FCM limits to a burst of 20 messages per device, then one every three minutes. In a
controlled comparison on the same Pixel and origin, with byte-identical workers, transitions 1–21
stayed prompt with the `Topic`, and transitions 22 and 23 took 150.8 s and 172.4 s. Without it,
immediately afterwards, 28 of 28 arrived within 3.1 s. #255 sends pushes without a `Topic`
(ADR-017 amendment). [ANDROID.md](ANDROID.md) records the builds and a separate keyguard race
fixed in the lane's notification-tap helper.

With the no-Topic gateway, one uninterrupted development run on 2026-09-25 then completed every
original background-Push phase, including lock/resume, Doze, the Wi-Fi/cellular/Airplane matrix,
and the ten-sink
sweep, and its cleanup restored the phone. It first needed a lane fix for the Pixel's September
keyguard; [ANDROID.md](ANDROID.md) records both attempts. That run is tested evidence; the boxes
were subsequently checked by the stable campaigns, not by that development run.
