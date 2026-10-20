# Test plan

This test plan is for maintainers and contributors running automated verification and release
qualification. It defines behavioral contracts and acceptance scenarios; in the current stable
release (`v0.7.4`), every qualification lane and the post-release published-byte smoke passed.
Exact hardware combinations and lane receipts are recorded in [Compatibility](COMPATIBILITY.md) and
[Release status](RELEASE_STATUS.md); historical fork-era receipts do not transfer.

## Activity extension scenarios

- Mixed current/legacy host snapshots: busy true/false, missing/null unknown, malformed rejection.
- Known true-to-false only on continuing identity/generation, neither sample waiting for input.
- No stops from first idle, repeated idle, retained/query gaps, unknown, replacements, removal,
  expiry, or restart; activity knowledge changes never extend TTL.
- Ordered internal delivery and reentrancy; queued stop ABA invalidation; no internal event in SSE.
- View-only stop eligibility; no history replay on subscribe/renew; all three server privacy levels.
- Shared tag, no Web Push `Topic`, displayed ask priority, and request-specific clear cannot close a stop.
- Strict scrubbed routes, same-generation View-only launch, changed/gone targets, and no new secret sinks.
- Real built browser activity labels, notification navigation, and existing supported viewport layouts.

These are implementation checks, not a physical-device or background-delivery qualification claim.

## 1. Unit tests

### OMP discovery, queries, and registry

- exact discovery-file and snapshot/reply validation; unknown versions and malformed or oversized data;
  date-range boundaries and per-host projection failure isolation beside a healthy peer;
- private ownership/permission checks, symlink rejection, and reading the published endpoint rather
  than deriving it, including OMP’s relocated long-path socket;
- newline framing, one request per connection, and bounded query time/bytes;
  immediate replies and post-timeout connection callbacks close without late request writes;
- metadata-only snapshots and per-launch links: no prefetch or registry capability retention;
- only `ENOENT`/`ECONNREFUSED` retires a queried host immediately; timeouts, permission/resource
  errors, malformed replies, and all wire errors retain metadata until TTL expiry;
- directory absence, transient unreadability, recovery, and host removal without filesystem writes;
- coalesced concurrent polls and reconciliation of observed/retained hosts;
- monotonic freshness independent of the OMP wall clock;
- generation, role, and request-identity revalidation across an asynchronous link query;
- bounded discovery entries and registry records;
- same-generation false-to-true-to-false attention transitions and stale-generation rejection.

The dedicated behavioral suite is `apps/gateway/test/omp-registry.test.ts`. Repository proof does
not qualify an actual OMP binary, native host, relay, or physical client.

### HTTP/auth

- missing Tailscale identity denied in production mode;
- disallowed login denied;
- allowed login accepted;
- localhost dev mode refuses non-loopback source;
- exact Origin enforcement;
- content-type/body-size enforcement;
- list/SSE browser-metadata schema;
- gateway-created attention identity is stable across repeated true updates and replaced on clear/re-arm or generation replacement;
- list/SSE contain only bounded labels, boolean attention, opaque request ID, and daemon receipt time—never a capability, transcript, answer, or tool output;
- launch generation mismatch returns 409;
- expired/missing returns non-enumerating 404;
- requested access no longer shared returns `409 mode_unavailable`;
- all API responses no-store;
- CSP and security headers.
- strict push v2 config/subscription/unsubscribe schemas, exact-origin mutation enforcement, private persistence, detail-level migration, subscription bounds, and stale-endpoint removal;
- ordered attention/clear delivery, per-instance deduplication, exact-request clearing, pending-count badges, and generation-safe replacement;

### PWA local triage

- exact-ask Hold persistence, FIFO partitioning, explicit requeue, and garbage collection when the
  authoritative ask changes or clears;
- Hold leaves authoritative pending counts and badges unchanged and closes only the notification
  whose instance tag and request ID match;
- generation-scoped Hide, immediate local hiding, five-second Undo, persistent Show all, and
  zero network mutation when the Undo window expires;
- session removal, generation replacement, and later attention restore a dismissed row
  immediately, while transport failure preserves local routing choices;
- malformed, oversized, excess, or non-canonical local records fail closed within the documented
  bounds, and allowed records contain identifiers and timestamps only.

### Collaboration photo composer

- JPEG, PNG, and WebP inputs at or below an 8,192px edge and 20 megapixels normalize to JPEG no
  larger than a 2,048px edge or 1 MiB;
- the Photo control exposes two 44px choices; **Take photo** targets the environment camera input,
  **Choose existing** targets the no-capture library input, Escape closes the panel and returns
  focus, and cancelling either picker prepares nothing;
- unsupported, empty, over-24-MiB, over-dimension, undecodable, and over-detailed inputs fail
  visibly before decode or relay send;
- at most four volatile previews are retained; remove, host-confirmed send, and unmount drop
  preview data URLs and base64 references;
- text-only, photo-plus-note, and photo-only prompts produce the existing v3 frame shape, with the
  documented neutral text used only when the note is empty;
- an unacknowledged photo prompt retains its exact preview and note, disables editing, and offers
  retry after five seconds only when relay health is current; a matching `collab-prompt` entry
  clears it only after the recorded pre-send transcript baseline;
- a View link remains read-only when an older host omits the optional welcome flag, and direct
  prompt, abort, agent-command, fresh Ask response, and pending-response replay all emit no mutation;
- read-only, disconnected, and preparing states cannot open or submit the photo path;
- a moving status row cannot cancel a pointer-captured Send, Stop, remove, or camera action.

### Mainline OMP

- require stock OMP `>= 18.1.20`, `collab.autoStart` only, and plain `omp` startup;
- exercise the integration contract in `docs/OMP_INTEGRATION.md`; record exact qualification
  evidence and limits in [RELEASE_STATUS.md](RELEASE_STATUS.md);
- keep upstream controller tests upstream; do not recreate a downstream OMP patch suite.
- Linux ARM64 source-checkout CI stages the pinned platform native and runs only
  upstream `registry.test.ts`, `registry-smoke.test.ts`, and `host-registry.test.ts`; gateway
  gates cover the discovery/query contract, not upstream's unrelated suites or full repo checks.
- Windows CI covers gateway contracts, ACLs, and service lifecycle on every change; upstream's
  Windows registry tests stay outside that gate. Real named-pipe discovery runs in the daily
  `canary-windows` lane below, which is tested evidence, not qualification.

The daily [upstream OMP canary](../.github/workflows/upstream-canary.yml) installs latest stock OMP
into an isolated directory on Linux and, in `canary-windows`, on Windows. Its ordered stages are
`publish`, `snapshot`, `stale-generation`, `view`, `control`, `new-generation`, `fork`,
`branch-rewind`, `continue`, and `unregister`. On POSIX it drives a tmux host: `/new` and `/fork`
must keep the instance and increment generation, refuse stale View/Control queries once the new
generation is visible, and permit fresh links. Fork retains both synthetic prompts in a fresh
View transcript. Rewind must show the anchored in-memory terminal status (never printed), keep
instance/generation, and leave links working; replicated sibling entries cannot prove rewind.
Continue must retire the old instance/links and publish a new instance at generation 1 whose
View transcript retains a pre-stop prompt. Windows runs `continue` in a hidden console, ended by
process-tree termination, without keystroke transport. It skips exactly `new-generation`, `fork`,
and `branch-rewind`; summary JSON includes `platform` and rejects other successful skip patterns.
Run locally with `bun scripts/upstream-canary.ts --omp <binary>`; `--model <provider/id>` overrides
the shared fixture model for diagnosis. After SIGTERM (or, on Windows, termination), it requires PID exit plus an absent entry
or a gateway `gone` reply, never `unavailable`. Stock 18.1.20 and 18.3.0 leave their publication on
SIGTERM: `discoveryFileRemoved` reports that separately, and OMP prunes its own dead entry only
after the verdict. This is not qualification, touches no phone, and proves neither provider
completion nor relay endurance; it uses OMP’s public relay.

### Qualification tooling

Provider-read fault injection covers network recovery, mixed network/HTTP failures, bounded
exhaustion with the last error, and immediate programming-error/cancellation propagation.
Repository admission requires direct TypeScript harness fetches to use the read helper or an
exact reviewed target exemption. Gateway/session, browser and loopback probes remain single-shot
observations (or keep their own observation deadline); capability POSTs and provider writes must
not replay. Provider CLI operations (gh/doctl/scw), remote shell package/bootstrap downloads and
guest metadata reads are outside this Response-based helper: their command exit/status and
existing polling semantics remain unchanged, not covered by the direct-fetch invariant.

The shared adb runner is tested with fake spawners for non-zero exit propagation and redaction of
device identifiers, stdout/stderr and raw spawn/pipe exceptions. Repository admission forbids adb
argv/spawn construction outside `scripts/android-device.ts`. Host-side subprocess smokes can exercise
stdin, output and exit behavior by injecting a Bun-child spawner, without invoking adb. Reachability
tests run a local shell with synthetic ping exits 1/2: the remote ping status is an unreachable
observation, while an adb transport exit remains fatal. Unsafe host text is refused before dispatch.
Best-effort CDP-forward cleanup remains explicit; device mutations must fail the lane, and
the shared restoration owner attempts every step without replacing the original phase error. Tests
cover its success/failure combinations, primary-error identity and ordering, continued restoration
after a failed step, and nested unrestored-Pixel errors retaining both development and campaign
leases. Acceptance regressions combine phase and restoration failures, round-trip Wi-Fi-on/data-off
baselines, and reject a mismatching radio read-back. The Push and acceptance paths share radio
capture/restoration, including validated Wi-Fi before enabling mobile data; a multi-SIM fake whose
global `mobile_data` key is stale proves the baseline reads the default data subscription's key
(a Pixel 10 Pro read `mobile_data=1` with data off). Repository admission
rejects lexical throw/return statements inside finally blocks in production scripts and app source;
scanner tests distinguish comments, strings, template text and regex literals (including after
`else`, `do` and operand keywords) from executable nested blocks. Real child processes prove a
failed or timed-out acceptance child poisons the campaign Pixel lease.

The stable-qualification suite also covers the 1,800-second relay floor, malformed or inadequate
passed evidence, and resume rejection without new admission or dispatch. A rejected proof must
still clean recorded pending Mac effects and must not reopen already completed cleanup.

The retained-Mac `ompPublication` lane adds the shared
[lifecycle runner](../scripts/omp-lifecycle-qualification.ts) after every live-session consumer
settles successfully and the relay tunnel stops. It writes `/new` and `/fork` (after two
synthetic messages) to the existing `ssh -tt` stdin, then stops/revokes, relaunches with
`--continue`, and stops/revokes again. Each rotation keeps the instance, increments generation by
one, requires stale launch POST `409 generation_mismatch` without a capability, and requires
current View/Control `200 no-store`. Resume requires a new instance at generation 1 with the same
label and working launches. Rewind is not gateway-visible and is covered only by the canary.
Additive `ompPublication.evidence.lifecycle` holds `newGeneration`, `fork`, and `resumed`
boolean/count records; schema 3 is unchanged. An interrupted step cannot pass and reruns in full.
Prove this path before a campaign with
`bun scripts/omp-lifecycle-development.ts --omp <absolute path to stock OMP dist/cli.js>`.
The isolated loopback/PTY runner and dated tested evidence are documented in
[LIFECYCLE_BRANCH_RESUME.md](LIFECYCLE_BRANCH_RESUME.md); local passes do not qualify a candidate.

The Pixel Push lane adds `triage_verified` and `stale_taps_verified` between `clear_verified`
and `force_stop_verified`. It owns a second fixture host for queue order and gone-host taps,
requires no unrelated waiting or hidden directory rows, and cleans both hosts' notifications and
device-local Hold/Hide records. Delayed taps re-present the original metadata-only notification
after clear; `replayed: true` proves handling, not push delivery ordering or delay. Items D.9–15
below distinguish the new physical checks from broader acceptance. Develop with the pinned Bun:
`OMP_PUSH_FIXTURE_BINARY="$PINNED_OMP" bun scripts/android-push-qualification.ts development "$PUBLISHED_ARCHIVE"`.
Restored development progress from another candidate/origin/pin is archived automatically.
Follow [ANDROID.md](ANDROID.md#physical-background-push-lane) before running a stable campaign;
the [specialized checklist](ATTENTION_SPEC.md#specialized-triage-and-delayed-tap-acceptance--qualification-pending)
remains unchecked until that exact signed candidate passes.

Configured-Mac regressions require an explicit SSH destination and expected hardware model, reject
unsafe password-file ownership/mode/type, and prove that an omitted password file reaches
`sudo -n` through SSH stdin. Read-only admission rejects a measured hardware mismatch before
staging; lifecycle receipts persist the measured hardware and OS, retain schema 3, and resume
passed evidence for both the original and replacement models. The SSH exposure probe names the
configured SSH destination, which may resolve to the same tailnet address as the other probe; it
does not imply that the host has a separate public interface.

Mac ownership regressions persist the configured host before the first effect, reject mismatched
hosts and unbound legacy effects before target resolution or remote commands, leave refused
receipts unchanged, and preserve same-host cleanup after a failed admission. A model refusal
with no recorded effects cannot trigger cleanup, including when an external lane cannot parse
absent progress. Schema 3 accepts the additive `macHost` binding without reclassifying historical
evidence. Darwin shell proofs plant `sysctl`, `uname`, and `sw_vers` in the account's Bun directory
and require the actual system hardware measurement through both admission and host evidence.
Rollback verification also exercises its explicit staged Cosign outside PATH.

Both Mac preflights reject absent stock OMP, releases below 18.1.20, prereleases, and malformed
version banners before lane effects. Refusals identify the coding-agent install command from
`UPSTREAM.lock.json`; admission creates no receipt and invokes no lane or cleanup, and shell
preflight never reaches sudo. The exact compatibility minimum passes. Additional probe output
is rejected without exposing its raw diagnostic.

Optional host-owned reboot-guard regressions execute the remote shell and admission probe in
isolated local homes: a busy guard refuses before sudo, lanes, cleanup, or new receipts; a
non-regular or non-owner-executable guard names its exact path and refuses preflight. A guard
that passes preflight but becomes busy before persistence prevents shutdown and fails the lane
with only the first 400 diagnostic bytes. Absent and allowing guards preserve the exact
passwordless shutdown command. Admission keeps a fixed four-line protocol, hex-frames multiline
diagnostics, and rejects malformed, oversized, or extra guard output without creating receipts.
These local proofs do not reboot or qualify a real shared host.

It also covers the three resource-owning lanes (ADR-031, ADR-032), with injected lane modules so no
test reaches a VM, a phone, or a device cloud:

- a lane passes only with a cleanup lane bound to the attempt epoch it recorded; a failed attempt is
  released, and never converted into a pass, before a new one starts, and a failed release blocks it;
- a crashed attempt resumes from its last checkpoint, and a cleanup that leaves recorded resources
  fails;
- a resumed campaign that fails admission still destroys the Windows VM it recorded;
- the Pixel lease runs one device action at a time and refuses every later one after a lane reports
  the phone unrestored;
- fake hotspot, USB/Bluetooth tethering, pending-upstream, malformed and failed adb probes refuse
  at orchestrator admission before provider lookup, lane admission or receipt creation;
- active, invalid or unreadable DND state also refuses before provider/lane admission for stable
  campaigns; post-release smoke permits `zen_mode=1` but still refuses tethering;
- from 0.6.0, stable approval requires passed Windows and background Push evidence, and from 0.6.2
  passed real-device cloud evidence; a schema 2 receipt cannot resume;
- the retained-Mac Push fixture stages exactly its import closure, as shell operands the remote shell
  never interprets, and the gateway's two log streams are observed separately.

The Windows lane (`scripts/windows-stable-qualification.test.ts`) and the background Push lane
(`scripts/android-push-qualification.test.ts`) test their phase machines, ownership and
protection rules, failure paths, and restoration against fake providers, transports, and devices;
[WINDOWS_QUALIFICATION.md](WINDOWS_QUALIFICATION.md) and [ANDROID.md](ANDROID.md) list what each
real run exercises.

The device-cloud lane (`scripts/device-cloud-qualification.test.ts`) runs against a fake runtime:

- catalog/free admission uses identical explicit model and OS floors, refuses malformed catalogs,
  obsolete iPads and unproved A55 hardware, and a free-empty snapshot is a zero-write hold;
- injected allocation time proves busy-to-free recovery, admission races and exactly ten minutes'
  exhaustion; authentication, transport and malformed inventory never become holds;
- an iPhone-only partial attempt is ended, audited and released before an iPad hold propagates;
  an audit or cleanup failure combined with availability remains diagnostic;
- a fake vendor refusing a third concurrent session passes because each target ends before
  allocating the next, and a failed release blocks an already-queued Android lane through the
  existing `pixelUnrestored` restoration guard, including nested aggregate failures;
- duplicate keys at top level, nested inventories and JSON logs are rejected before reference
  discovery, including escaped-equivalent keys; a parse-site meta-test forbids lenient vendor
  record parsers. Escaped JSON values cannot disappear from retained audits; the
  test detail, asset inventory and declared logs are inspected, and missing/unreviewed surfaces
  fail without forwarding account credentials to log storage;
- expected application assets are compared in-page with boolean-only results, and a mismatch
  fails before View/Control; page-controlled pathnames never become vendor-logged results;
- every WebDriver session reaches a checkpoint before it is driven, and every effect, the release of
  its sessions, tunnel, fixture, and workspace included, runs in one Pixel lease turn that no queued
  lane can enter, after a failure too;
- a vendor record holding either session's live link, or a 16-character segment of one, fails the
  lane, including interior and delimiter-crossing contiguous windows, and neither the error nor
  the saved progress repeats it;
- a generation change of either session before the audit fails the lane, and so do records that kept
  video or screenshots;
- an attempt interrupted before its release is released rather than resumed, a release that cannot
  finish leaves the attempt dirty for cleanup, which retries every step, and progress from another
  candidate is refused;
- progress refuses unknown fields, secret-named observations, and any text outside its fixed
  grammars, and device text outside them fails the attempt before it is saved;
- a device that reports another kind of device, model, browser, or OS release than the one requested
  is refused, using the capability shapes TestingBot returned for real allocations.

`scripts/testingbot.test.ts` covers the vendor boundary:

- the service-account token reaches only the `op` child's environment, and no account selection
  applies;
- a loose, symlinked, or malformed token file, or a non-service or foreign `op whoami`, stops before
  any read;
- the tunnel is stopped only by its own identifier; a real process listening beyond loopback is
  refused as a tunnel and left stopped, while a loopback-only one is accepted;
- the tunnel's proxy relays only a CONNECT to an allowed host and port, and refuses every other
  target, name, and plain HTTP without opening a connection;
- a page evaluation that fails returns only its error's name, never message text or a crafted name.

`scripts/android-leak-probe.test.ts` runs the shared sink scan against an iOS Safari tab's
service-worker registration, which has no `getNotifications`, and against cache and database names
holding the needle. It also runs the sweep that a vendor-logged driver uses, which reports sink
names and counts, never the page text that held the link.

BrowserStack and shared transport tests add:

- fallback only for an empty eligible iPad/Android pool, never for iPhone or after a primary write;
  lazy fallback prerequisites, the exact Mobile/five-parallel plan and the 2027-10-20 cutoff;
- exact iPad alias and Safari attestation, Samsung-only Chrome with matching model/OS/browser;
  refusal of HTTP-200 schema errors, bounded responses and unreviewed retained surfaces;
- equal IDs at different vendors remain distinct; unknown creation stays dirty; every vendor's
  partial record audit runs even when another record fails, and deletion failure blocks the lease;
- duplicate JSON keys are refused before reference discovery, and raw plus strict canonical
  escaped values are scanned; candidate-origin
  navigation text passes because default-relay capabilities are compact `room.key` strings,
  while a capability's interior 16-character window fails without being persisted;
- missing required logs, retained media, changed/unaudited signed artifacts and unverified
  deletion fail; clean identical lingering text is counted without publishing URLs; crash cleanup
  re-inspects rather than manufacturing a clean audit;
- key-free lane argv, exact proxy flags, shared loopback-only listener refusal and the existing
  plain-HTTP/alternate-host/port/loopback/LAN/tailnet denial matrix;
- release summaries preserve historical golden bytes, attribute mixed targets individually,
  and refuse BrowserStack iPhone or non-Samsung/mismatched Android evidence.

A real run exercises the selected vendors' iPhone, iPad, and Android devices through the tunnels against the
candidate gateway, the iPhone's Home Screen alert, and the vendor-record audit; ADR-032 lists what
it proves and what stays Pixel-only.
`bun scripts/device-cloud-attestation.ts --admission` is a read-only free-inventory probe.
`--attest-public` permits at most four sequential allocation sessions (the three added iPhones
and A55), navigates only to `https://example.com`, ends each known session and inspects its retained
record. It never opens View/Control, contacts the retained Mac or Pixel, or qualifies a release.
Unavailable hardware remains disabled until its bounded attestation is proven.
The separate `scripts/device-cloud-development.ts` runner accepts an isolated candidate identity,
Mac host, HTTPS origin and session label. It runs at most three journey sessions, stops admitting
new allocations after 40 minutes, and always attempts production audit/release; provider command
and session-duration bounds still apply to in-flight work. `--hold-after-iphone` injects a marked
development-only iPad hold for partial-attempt audit testing. Its private results are explicitly
Tested and cannot approve a release. Equipment availability must be confirmed before running it.
`--mixed-vendors` selects TestingBot iPhone plus BrowserStack iPad/Samsung only in this isolated
runner; it cannot be combined with `--hold-after-iphone` and is not a production policy override.
The [release contract matrix](RELEASE.md#browserstack-device-cloud-fallback) records the bounded
public-page and crash-cleanup proofs. The capability-opening mixed journey remains a separately
scheduled development check, never an automatic extension of those probes.

## 2. Secret-leak test harness

Generate distinct per-host query tokens, readiness tokens, and capability canaries in test memory.
Never record View/Control links in fixture files or artifacts. After each test, scan:

- daemon stdout/stderr and structured logs;
- temporary/config/data directories;
- browser Local Storage, Session Storage, IndexedDB, cookies, Cache Storage;
- service-worker request cache;
- HTTP access logs/test recorder;
- generated diagnostics bundle;
- unhandled exception and snapshot output.

Fail on any canary or meaningful substring outside its designated source/sink. Per-host query
tokens belong only in private discovery fixtures and live query memory; readiness tokens belong
only in private readiness fixtures and proof memory. Neither enters logs or diagnostics.
View/Control capabilities are permitted only in live OMP/query/launch-response memory and the
collab client’s in-memory parsed value, never a gateway registry or file.

Add distinct prompt, option, prefill, answer, request, title, project, and capability canaries. Prompt,
option, prefill, answer, transcript, and capability canaries must remain absent from IPC logs/errors,
list/SSE, URLs/history, browser storage/caches, screenshots/traces, diagnostics, and repository
artifacts. Opaque synthetic request IDs are allowed only in list/SSE, encrypted push, request routes,
volatile DOM/history routing state, and bounded device-local held-ask records. Bounded instance IDs,
generations, and canonical timestamps are also allowed in the device-local Hold/Dismiss records.
Bounded title/project canaries are allowed in encrypted push and visible notification text only for
`session`/`preview`, never in persisted push or local triage state.
- generate photo-flow fixtures in the browser rather than checking real user media into the
  repository; scan gateway requests, browser storage/caches, diagnostics, logs, and retained test
  artifacts for the synthetic pixel/base64 canary. Its only permitted live sinks are volatile
  collab-client memory, the encrypted relay frame, and the receiving OMP test session;
- scan private push state, intercepted encrypted-payload plaintext, visible notification title/body/data, notification tags, app badges, and request-route history against the selected detail contract;

The Percy harness additionally scans the installed serializer's full HTML and every serialized
resource, including decoded bytes, before submission and again at the SDK POST. The fixture's
closure-owned full/room/key/16-character/escaped-material guard and both repository leak scanners
must fail on hidden attributes, current form values, inline styles, text, textual resources and
unsafe diagnostics without echoing matches. Negative tests reject unreviewed resources and
executable surfaces, SDK warnings/no-ops, unhealthy sessions and failed finalization. The safe
reporter emits only allowlisted state/project/phase names and counts; no trace, screenshot,
recording, raw SDK log or Percy output is retained as a CI artifact.

## 3. Integration tests

- OMP-shaped discovery/query fixture -> poller -> registry -> PWA card -> per-launch link;
- two hosts with the same PID but different instance IDs;
- three simultaneous hosts and changing metadata;
- gateway restart followed by polling/repopulation, without host reconnect;
- OMP starts before the gateway;
- readiness-token rotation has no OMP publication credential to re-provision;
- transient endpoint failure and recovery retain the same card until TTL;
- session generation replacement while phone card is open;
- launch race with process exit;
- SSE reconnect and full snapshot;
- Tailscale identity-header proxy fixture with direct backend spoof attempt;
- collab-web parse/connect against mock relay;
- view client write attempt is rejected;
- control prompt/interrupt against mock/real OMP host.
- explicit camera and existing-photo selection -> metadata-free bounded JPEG preview -> encrypted `prompt.images`
  frame -> real OMP host image prompt, with no gateway HTTP or service-worker media request;
- a pending response operation before any writer exists -> metadata attention -> later Control replay -> exactly one settlement -> authoritative clear;
- concurrent response operations and multiple Control writers preserve one boolean and settle each request once;
- generation replacement clears attention before removal and cannot be mutated by a stale lease;

- browser subscription -> gateway private state -> false-to-true registry transition -> selected-detail push -> service-worker notification;
- true-to-false/removal closes the per-instance notification, updates the badge, and cannot clear a re-armed request; `404`/`410` removes the endpoint;
- notification route revalidates exact current request identity and Control availability before the ordinary generation-bound launch;
## 4. End-to-end acceptance scenarios

### A. Automatic discovery

1. Start gateway and open PWA on Android.
2. With stock OMP `>= 18.1.20` and `collab.autoStart: control`, start three plain `omp` processes
   in different repositories.
3. Do not type `/collab`.
4. All three cards appear within the configured discovery poll interval plus bounded query and
   browser delivery time; record the measured latency rather than claiming push-era timing.

### B. View and control

1. Open View for process A; transcript streams and write controls are unavailable/rejected.
2. Open Control for process B; submit a benign prompt and interrupt it.
3. Host tools continue to execute on the desktop process, not the phone.
4. From the Pixel Control composer, open Photo and exercise both **Take photo** and
   **Choose existing**. Take a rear-camera photo, add a note, preview it, and send.
   Repeat without a note. The host receives one bounded JPEG each time and the active model can
   inspect it; View exposes no enabled photo action.
5. Drop one send before host acknowledgement and verify the exact draft remains until Retry is
   acknowledged. Remove a prepared photo, choose an unsupported/over-dimension file, and exceed
   the attachment bound. No rejected media reaches the relay, gateway, OMP transcript, browser
   storage, or test artifacts.

### C. Lifecycle correctness

1. Switch process A to a different OMP session.
2. Old generation becomes unlaunchable before new generation appears.
3. Exit process B normally; card disappears promptly.
4. Kill process C; card disappears no later than TTL.

The mainline canary and retained-Mac lifecycle step above provide executable transition coverage.
Their measured assertions do not prove an unobserved interval between samples; use
[LIFECYCLE_BRANCH_RESUME.md](LIFECYCLE_BRANCH_RESUME.md) for exact invariants and evidence limits.

### D. Phone/background behavior

1. Open a live session.
2. Lock phone briefly, unlock, and resume.
3. Client reconnects automatically without leaving or reopening the session.
   Leave the directory in the background for over a minute: once Chrome freezes the page, the gateway sees its event stream close; returning opens a fresh stream from a new snapshot.
4. Switch Wi-Fi/mobile network while Tailscale remains connected. If the browser process remains responsive, the dashboard and active Control/View recover without Refresh or another user action.
   - If Android has a healthy route but Chrome simultaneously fails the gateway, an unrelated origin, and browser-control probes, record the run as a browser-environment failure rather than a PWA pass. The visible directory must keep retrying, name the unreachable path, and open help already carried by the loaded shell only after 45–60 uninterrupted visible failure seconds; offline or hidden time does not count, and no page-level workaround may be claimed to repair the browser process.
5. Android back returns safely without a reusable secret-bearing history entry.
6. Explicitly enable background alerts; page load never prompts. Choose each detail level and verify the gateway builds exactly the permitted title/body while the private state stores no session text.
7. Tap the notification; `/collab/:instanceId?request=:requestId` contains routing metadata only, exact current attention is revalidated, and one tap opens Control only for that request. Tap again with a collaboration open: the page switches in place without a reload or navigation, a tap for the open session keeps it (an activity stop never downgrades Control), and a stale tap leaves it open.
8. Exercise offline, tailnet-unreachable, desktop-unreachable, gateway-unavailable, and relay-unavailable states. Verify brief loss uses only `Reconnecting…`, a three-second loss names the path and next retry, recovery briefly confirms `Connected`, and the last authenticated list remains visibly timestamped and reconciles automatically without Refresh.
9. Resolve, replace, expire, and false-to-true re-arm before tapping delayed notifications; each stale request stays on the directory without a capability request for a newer attention.
   `stale_taps_verified` covers desktop resolution, a newer request on the same generation, a new
   generation with its own request, and a gone host. It re-presents the original notification's
   metadata-only data through the worker registration, then taps on the lock screen: scrub before
   any API request, metadata fetch, zero launches, expired/changed notice. This is physical tap
   handling evidence, not evidence of Web Push delay or ordering.
10. Verify one notification per instance, silent duplicate updates, authoritative clear, and `setAppBadge`/`clearAppBadge` pending counts.
    The detail and `clear_verified` phases prove delivery/clear; `triage_verified` also requires
    held asks to remain in the authoritative pending count. Badge counts are not observed on the
    Pixel. On 2026-10-01, the installed WebAPK there (Chrome 154) exposed `setAppBadge` and
    `clearAppBadge`, but the count is shown by the launcher, which the lane does not read. Badge
    calls stay covered by the service-worker unit tests.
11. Force-stop/disable Chrome notifications and exercise Android battery policy; record best-effort failure behavior without claiming guaranteed delivery.
    `force_stop_verified`, `permission_verified`, and `doze_verified` keep their existing physical
    observations after the two new phases; lock/resume and network phases remain required.
12. Install a changed shell while the directory is idle; the new worker activates and loads it without Refresh. Repeat during pending/active collaboration; the capability-bearing client remains mounted until ordinary Back/Leave, then the updated directory loads automatically.
    This worker-update scenario is not covered by the new triage/delayed-tap phases.
13. Hold the oldest request from the dashboard and from an active collaboration shell. Verify the
    next unheld ask opens in FIFO order, the held ask remains in the authoritative pending/badge
    total, only its matching notification closes, and explicit requeue restores it.
    `triage_verified` exercises the installed directory with two fixture asks, zero non-GET gateway
    requests, and `N waiting · M held`. The active-shell scenario remains separate acceptance.
14. Hold every waiting request. Verify the device reports a clear couch queue without claiming the
    gateway is all clear, then replace one exact request and verify only that stale hold disappears.
    `triage_verified` requires `Queue clear · N on hold` and preserves the other exact hold.
15. Hide a non-attention row, exercise Undo, let a second dismissal expire, and use Show all.
    Verify no network mutation occurs; a new generation or later attention restores visibility
    immediately; live/working totals still include the hidden row; and the UI says OMP keeps
    running rather than claiming Close, Exit, or completion.
    `triage_verified` checks Undo within five seconds, expiry after a second Hide, `Live · N`
    retention, later attention restoration, and Show all. New-generation restoration remains a
    separate acceptance scenario, not a result of this physical phase.

### E. Authorization

1. Intended Android identity can access.
2. Public Internet and LAN-only clients cannot reach the service.
3. An unauthorized tailnet identity/device is denied by policy and by app allowlist.
4. Direct access to loopback is impossible remotely; a forged identity header does not bypass the tailnet path.

### F. Persistence

1. Launch and close both view and control sessions.
2. Restart browser and daemon.
3. No previous capability is recoverable from disk/browser history/storage/cache/logs.
4. The gateway rediscovers already-published live OMP hosts and rebuilds metadata-only records.
5. Device-local Hold/Dismiss state contains only the bounded identifier, generation, and timestamp
   fields; no title, path, model, prompt, transcript, or capability survives there.
6. A prepared-but-unsent photo disappears after remove, Back, reload, or client disposal and is
   absent from gateway/browser persistence and service-worker caches. A sent normalized photo may
   remain only through ordinary OMP transcript and model-provider retention; the original file,
   filename, and EXIF/location metadata do not.

## 5. Relay soak test

For any self-hosted/proxied relay mode:

- run at least a 30-minute continuous transcript stream;
- send periodic bidirectional messages;
- cover Android screen lock/resume;
- record close codes/reconnects without recording payloads or links;
- test path and query preservation required by the relay;
- fail deployment qualification on unexplained periodic disconnects.

## 6. Performance targets

Initial targets, to revise with measurements:

- 50 local OMP hosts without material CPU usage;
- metadata delivery measured from a successful poll to the phone separately from the configured
  discovery interval; do not claim the fork-era push latency for polling;
- launch API p95 < 250 ms excluding relay connection;
- daemon idle memory < 100 MiB including embedded static assets;
- no unbounded event/listener/history growth during 8-hour soak.

### Isolated synthetic endurance measurement

`bun run qualify:endurance` starts the working-tree daemon with private, temporary config/state/
runtime and discovery directories, development loopback identity, and a non-4317 port. It never
installs a service, reads the real OMP discovery directory, contacts a relay, or uses a device.
Build the static assets first; use a **new** output directory and summary filename for each run:

```sh
bun run build
bun run qualify:endurance --hosts 50 --subscribers 4 --duration-seconds 28800 \
  --sample-seconds 15 --poll-seconds 10 --metadata-seconds 30 --churn-seconds 120 \
  --launch-seconds 4 --port 4319 --output /tmp/omp-gateway-endurance-8h \
  > /tmp/omp-gateway-endurance-8h-summary.json
```

The reusable `scripts/synthetic-hosts.ts` also supplies the weekly capacity workflow. Its CLI
retains the original 1–50 host bound, private discovery files/sockets, authenticated snapshots,
and unavailable links. The endurance runner uses its opt-in, distinctively synthetic View links.
Title/activity revisions retain their generation and session identity. Churn revokes and withdraws
one host before publishing a new instance at generation 1; this is not a same-instance generation
reset. No capabilities or raw HTTP/SSE bodies are retained in evidence.

The endurance run holds all SSE subscribers open and exercises these independent measurements:

- View launch p50/p95/p99/max/count/failures, distributed across the run and hosts. Launches are at
  least four seconds apart to stay below the real per-identity 20/minute rate limit, without retries.
- Metadata-change-to-SSE-receipt latency **including discovery wait**, and
  `snapshotReplyToReceipt` latency separately. The latter starts immediately before the host writes
  the first matching successful snapshot reply; the matching event proves it was consumed. It
  includes IPC, poll-round reconciliation and loopback delivery, **not** the discovery timer wait.
  This is a host-reply proxy, not instrumentation of the daemon's exact poll-completion instant and
  not phone/browser/Tailscale latency. The configured poll interval is reported independently.
- Daemon RSS (KiB), cumulative CPU seconds and open numeric file descriptors (Linux `/proc`, macOS
  `ps` plus `lsof` when available): start/end/min/max/mean and least-squares slope per elapsed second.
  A separate idle sample precedes host registration. The CSV records actual sample times on a fixed
  cadence, plus an end sample; missed ticks are not fabricated. FD availability is explicit.
- Session membership, every raw list/SSE JSON body's forbidden fields, repository capability leak
  patterns, decoded known secret values, and the synthetic capability canary. Every scheduled
  metadata revision must reach every subscriber. A churn window allows only one missing host and
  must converge on all subscribers within twice the poll interval plus five seconds.

The JSON summary on stdout has numeric leaves only. `samples.csv` is the only file written to
the evidence directory; daemon logs, replies, socket credentials and private state are not copied.
At the above cadence an eight-hour run normally has 1,921 CSV rows: expect roughly 0.2 MiB of CSV
and a few KiB of JSON; reserve 1 MiB for evidence, plus a few MiB of transient private state
(excluding the existing build/dependencies). SIGINT/SIGTERM and correctness failures close the
streams, stop the daemon/hosts and remove the private root while preserving numeric samples.

Bounds: hosts 1–100, subscribers 1–32, duration 30–86,400 seconds, samples 1–300 seconds, polls
2–60 seconds, metadata 6–3,600 seconds, churn 0 (disabled) or 6×poll–3,600 seconds, launches
4–300 seconds, port 1,024–65,535 except 4317. Metadata and duration must span at least three polls;
sample/launch intervals cannot exceed duration. Other defaults are the command above, except a
300-second duration and a newly named output directory.

Correctness failures exit nonzero, independently of performance targets. `correctness.failureCode`
is 0 on success; 1 arguments, 2 platform/build prerequisite, 3 output/root/port setup, 4 daemon
death/readiness, 5 host/list membership, 6 SSE protocol/leak/disconnect, 7 delivery/churn deadline,
8 launch, 9 resource sampling, 10 signal, or 11 teardown. No caught error or response is echoed.
Percentiles are nearest-rank millisecond upper bounds; maxima retain the measured precision.
Target flags use 1/0 for pass/fail, and -1 for unmeasured or no numerical verdict. Launch p95 and
idle memory use the targets above; CPU uses an explicit provisional <1% of one core comparison
to make “material” inspectable, not a release gate. No numerical metadata budget is invented.
An eight-hour window and RSS/FD slopes are external growth evidence only: internal listener/event/
history counts are not measured, so this tool cannot by itself declare unbounded growth absent.
Performance flags never cause a failing exit. The weekly capacity lane remains the shorter,
static-host, list-only CPU/RSS measurement; it does not become an SSE/launch or endurance claim.

### Measured — 2026-09-30

The first eight-hour measurements come from one Mac16,5 (macOS 27.0, arm64). They are tested
evidence recorded in the [release ledger](RELEASE_STATUS.md), not qualification. The synthetic
endurance command above ran the v0.7.0 runtime source with the exact settings shown. A
default-relay soak ran the installed published runtime, following the
[release guide's procedure](RELEASE.md#default-relay-soak-qualification):

- **50 hosts:** daemon CPU was 0.32% of one core over the synthetic run, so the provisional <1%
  comparison passes. Over the soak, the published runtime used 0.27% while serving the soak and the
  maintainer's own sessions.
- **Metadata delivery:** snapshot reply → SSE receipt was p95 8 ms (max 15 ms), excluding the
  discovery wait. Change → receipt, which includes a 10-second discovery interval, was p95 2,885 ms
  (max 10,008 ms). No numerical budget is set.
- **Launch API:** p95 was 2 ms (max 32 ms) over 7,196 View launches, below the 250 ms target.
- **Idle memory:** the daemon used 54.8 MiB before any host registered, below the 100 MiB target.
  Under the synthetic load it stayed between 43.8 and 81.8 MiB. The published runtime stayed
  between 34.4 and 50.1 MiB during the soak.
- **Growth:** over eight hours neither run showed a rising resident-memory trend (−3,113 KiB/h
  synthetic, −630 KiB/h soak), and descriptors held at 11–12. These are external measurements
  only.

The targets stand. Mainline releases still do not rerun eight-hour endurance: for v0.4.0 the
founder-approved fresh 1,800-second relay gate passed, and prolonged-operation risk was accepted.
Neither the measurements above nor that gate establishes bounded memory growth by itself: internal
listener, event and history counts are not measured.

## 7. Release checklist

- all security acceptance gates pass;
- dependency audit and lockfile review;
- source maps do not contain secrets (they should not) and are not remotely uploaded;
- the Bun-runtime archive is reproducible and has verified release provenance;
- version compatibility matrix recorded;
- install/uninstall tested on every advertised OS;
- no public-listener or Funnel configuration in defaults/examples;
- after stable publication, run `bun run smoke:release` against the published digest on the configured
  local Darwin-arm64 Mac and physical Android client; require exact asset/provenance binding,
  config/token preservation, unrelated Serve preservation, View/Control, forbidden-sink,
  same-page recovery, installed-WebAPK (including resumption on `/client/` with a session-specific
  title), revocation, and owned-fixture cleanup evidence;
- documentation tells users how to revoke a lost phone and rotate the gateway-only readiness token;
- record the exact signed-candidate matrix and limitations in the [release ledger](RELEASE_STATUS.md).
  From 0.6.0 the matrix includes the Windows host and background Web Push lanes, from 0.6.2 the
  real-device cloud lane, and from 0.7.2 specialized attention triage/delayed taps and lifecycle
  transitions; each release qualifies them on its exact signed candidate. No fork-era qualification
  result transfers.

Android recovery milliseconds measure elapsed time from the disruption ending to the first
completed same-page, ready-directory probe, probing immediately and then waiting 250 ms between
completed attempts within the existing 36/160/48-second lock/airplane/Doze windows.

The v0.4.0 published-stable-byte local/Android smoke above **passed on 2026-09-14**, separately
from candidate qualification. Exact source/digest, preserved installation state, existing local
OMP 18.1.21, physical results, and the initial Control-upgrade failure, which matches the update
navigation in the ADR-018 amendment, are recorded in the [release ledger](RELEASE_STATUS.md).

## 8. Continuous integration lanes

Every pull request runs the lanes below, from `ci.yml`, `compatibility.yml`, and `platform-qualification.yml`. Only the
lanes marked **gating** are required status checks on `main`; the others publish a result without
blocking a merge.

| Lane | Runs | Merge |
| --- | --- | --- |
| `implementation-checks` | `bun run check`: repository check, typecheck, build, `bun test`, and both leak scans | gating |
| `portable-source` | `bun run check:portable` on Ubuntu, macOS, and Windows: repository check, typecheck, build, every test not bound to another host OS (`scripts/test-portable.ts` names each exclusion and its reason), and both leak scans | gating |
| `browser-notifications` | `bun run test:browser`: the whole Playwright suite on two mobile viewports, not only the notification cases its historical name suggests | gating |
| `browser-core` | `bun run test:browser:compat`: the `@core` Playwright tests on desktop Chromium, Firefox, and WebKit and on WebKit with iPhone-class emulation (`apps/web/playwright.compat.config.ts`) | gating |
| `windows-service-lifecycle` | Windows contracts and ACLs, install, readiness-token isolation and rotation, uninstall, and a standard (non-elevated) user's install, reinstall, daemon readiness, and uninstall | gating |
| `linux-arm64-source-checkout` | Native aarch64 typecheck, build, `bun test`, and the pinned mainline OMP registry fixtures | advisory |
| `coverage` | `bun run test:coverage` and the Codecov upload | advisory |
| `visual-review` | Fixed GitHub-hosted Ubuntu: `bun run test:visual` validates all 18 deterministic synthetic states and source/serialized geometry; eligible same-repository PRs, main pushes and GitHub-hosted dispatches then require guarded Percy uploads and finalization | advisory |

`coverage` is advisory by design: its upload sets `fail_ci_if_error: false`, so a merge never
depends on a third-party service being reachable.

`visual-review` always validates locally without a token. Forks and all gateway-ci dispatches
are explicitly **not uploaded** and receive no Percy secret. Eligible uploads fail visibly on
missing credentials, SDK warnings, an unavailable vendor, incomplete submission or finalization;
no retries or `continue-on-error` mask the result. The six states are empty/all-clear/needs-you
directory, Settings with Session alerts enabled, connected View and connected Control Ask, each at
390×844, 810×1080 and 1280×800 with a fixed clock/randomness, en-US/UTC, dark theme, reduced
motion and DPR 1. Directory asks are metadata-only, collaboration prose/code are authored synthetic,
and the desktop contract remains a 560px directory, 900px View transcript and aligned session
header. Control Ask preserves the client's 880px bounded embedded body and checks exact
source/serialized parity and session-header alignment instead of imposing a 900px inner transcript.
Percy re-rendering is neither functional browser coverage nor signed-release device qualification;
maintainer setup and first-build/deliberate-diff acceptance are in [BrowserStack](BROWSERSTACK.md).

Separately, `upstream-canary.yml` runs `canary` and `canary-windows` daily, by dispatch, and on
pull requests touching its workflow, scripts, fixture, or registry reader. It runs the ten stages
listed under Mainline OMP with the strict Windows projection; it is not an every-PR gate and never
substitutes for signed-candidate qualification. Both Linux and Windows canary lanes run daily in CI;
exact stage coverage and local macOS evidence are recorded in [LIFECYCLE_BRANCH_RESUME.md](LIFECYCLE_BRANCH_RESUME.md).

The browser lane gates because it holds the only executable proof of contracts that span the
gateway/vendored-client boundary. `apps/web/e2e/software-keyboard.e2e.ts` is the worked example:
the gateway chrome sizes itself from `--viewport-height`, a custom property published by the
vendored collaboration client, and no other check fails if that property stops arriving.

It is also the only place the background/restore contract of ADR-029 is executable. The three
`bfcache restore` cases in `apps/web/e2e/launch.e2e.ts` drive a real `pagehide`/`pageshow` pair and
separate resuming the same session, falling back to the directory when the host bumped its
generation, and reopening a session whose question was answered while the page was frozen. They
assert the resume is a second launch — a fresh relay transport and no capability in storage,
caches, history, or the URL — which no unit test can observe.

`capacity-qualification.yml` and `droplet-qualification.yml` deliberately have no `pull_request`
trigger; they run by dispatch or schedule and never gate a merge. The capacity workflow config
test substitutes synthetic shell variables into its config heredoc and validates it with the real
gateway loader in the ordinary script suite. Release publication runs from a pushed tag
in `signed-release.yml` and is covered by the release checklist above, not by these lanes.
