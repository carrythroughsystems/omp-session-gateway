# Architecture decision records

ADR-001 through ADR-027 are **fork-era historical records**. Their references to patches,
publication credentials, endpoint settings, source pins, and qualification results describe the
then-current architecture, not the shipping prerequisite. ADR-028 records the mainline cutover;
entries superseded by it keep their original rationale and evidence below.

## Current implementation audit — 2026-09-14

This note describes current discrepancies; it does not amend the historical decisions below.

- **ADR-016 recovery timing:** ADR-019 supersedes clearing last-known metadata on transport
  failure, and ADR-020 supersedes the collaboration-client probe mechanics. The 5-second SSE
  keepalive and 12-second silence deadline remain implemented. Current directory recovery instead
  uses 20-second snapshots after the initial 4-second request and randomized delays in the upper
  half of 1/2/4/8/16/30-second caps. That numeric policy differs from ADR-016; this audit does not
  approve the divergence.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [PROTOCOL.md](PROTOCOL.md) for current behavior.

## ADR-001 — Use a PWA, not a native Android protocol client

**Status:** Accepted

**Context:** OMP already ships a browser collaboration client that understands the encrypted capability, relay protocol, transcript, composer, tools, interrupts, and subagents.

**Decision:** Build a PWA dashboard and reuse that client. Add a TWA only for packaging needs.

**Consequences:** Lowest duplication and protocol risk. Native-only background/OS features are deferred.

---

## ADR-002 — Aggregate through a local daemon

**Status:** Superseded by ADR-028 (publication transport); fork-era record

**Context:** Multiple independent OMP processes need one discoverable list. Capabilities must not be persisted to disk.

**Decision:** A per-user daemon holds an in-memory registry and receives authenticated local IPC publications.

**Consequences:** Requires one autostart component, but provides clean lifecycle/TTL semantics and one secure phone endpoint.

---

## ADR-003 — Require a small OMP core patch

**Status:** Superseded by ADR-028 (core-patch prerequisite); fork-era record

**Context:** Process scanning cannot create/recover a live collaboration host, and the documented extension API does not currently expose built-in collab startup.

**Decision:** Extract a reusable `CollabController`, add opt-in auto-start, and publish controller events. Preserve an upstream-safe default of off.

**Consequences:** A fork/PR is required initially. The patch can later enable an extension-only publisher.

---

## ADR-004 — Tailnet-only dashboard via Tailscale Serve

**Status:** Accepted

**Context:** The dashboard distributes bearer capabilities and must not be public. The user wants access from one Android phone without port forwarding.

**Decision:** Bind the gateway to loopback and expose it through Tailscale Serve, with grants and application allowlisting.

**Consequences:** Requires Tailscale on both devices and initial login. Avoids public ingress and supplies authenticated identity headers.

---

## ADR-005 — Keep the existing E2EE relay for v1

**Status:** Accepted

**Context:** The collaboration protocol already encrypts payloads client-side. Proxying/self-hosting the relay increases deployment and long-lived WebSocket risk.

**Decision:** Use the existing relay for v1. Self-hosting is optional after a soak-tested transport is available.

**Consequences:** The relay still observes limited traffic metadata and remains an availability dependency, but not plaintext/content keys.

---

## ADR-006 — Capabilities are memory-only and fetched just in time

**Status:** Superseded by ADR-028 (daemon capability storage); fork-era record

**Context:** Full links grant control; even view links expose sensitive transcripts.

**Decision:** Store capabilities only in daemon and process memory, omit them from list/SSE, and return one only after an explicit no-store launch POST.

**Consequences:** Daemon restart loses the registry until live OMP publishers reconnect, which is desirable. Offline access is intentionally impossible.

---

## ADR-007 — Use SSE for dashboard metadata

**Status:** Accepted

**Context:** The dashboard needs one-way low-rate updates; WebSocket proxying is unnecessary for discovery.

**Decision:** Use ordinary HTTP plus SSE for metadata. The collab client connects directly to its relay.

**Consequences:** Simple proxy behavior, reconnection, observability, and security. No secret crosses SSE.

---

## ADR-008 — Optional WebAuthn gate, not native biometrics

**Status:** Proposed after v1

**Context:** A lost/unlocked phone with an active tailnet identity could control sessions.

**Decision:** Offer WebAuthn user verification for Control launches before considering a native app.

**Consequences:** Strong user-presence check with the same PWA; requires one-time credential enrollment.


---

## ADR-009 — Bootstrap the collab client in memory, not through a URL

**Status:** Accepted

**Context:** OMP browser deep links conventionally carry the collaboration capability in a URL fragment. Fragments are not sent to the HTTP server, but they can remain in browser history, copied URLs, screenshots, and test artifacts.

**Decision:** Add a small pinned/upstreamable in-memory bootstrap API to `collab-web` and pass the just-in-time capability directly from the PWA. A same-origin `MessageChannel` is acceptable for a separate client page. Ephemeral fragment removal is a temporary compatibility fallback only.

**Consequences:** Requires a small collab-web integration change, but materially reduces accidental persistence and makes the security invariant testable. Reload intentionally returns to the session directory.

---

## ADR-010 — Open source under MIT with no telemetry by default

**Status:** Accepted

**Context:** The gateway handles powerful bearer capabilities, so users benefit from auditable code and reproducible releases. The upstream OMP project is MIT-licensed.

**Decision:** Publish OMP Session Gateway under MIT, preserve upstream notices, ship no telemetry/analytics/remote runtime assets, and require private vulnerability reporting plus release provenance.

**Consequences:** Public review improves trust, while maintainers assume responsibility for security triage, dependency hygiene, compatibility documentation, and release integrity.

---

## ADR-011 — Pin OMP main and patch collab-web source in memory

**Status:** Superseded by ADR-028 (host core-patch prerequisite; pinned client integration remains); fork-era record

**Context:** Upstream `main` at `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` still has the slash command directly own `CollabHost`, exposes no supported `ctx.collab` extension API, and has `collab-web` write every connected capability to `location.hash`. Its relevant host, UI, wire v3, and collab-web blocks are byte-identical to the prior pin; unrelated interactive-mode plan/token-rate changes must be preserved.

**Decision:** Target that exact v17.0.6 commit, keep the initial controller/publisher integration as a narrow core patch, and build a pinned collab-web source integration with a direct in-memory bootstrap that never writes the capability to a URL.

**Consequences:** The OMP patch remains necessary for automatic startup and lifecycle-safe publication. The gateway cannot consume upstream collab-web unchanged because doing so would violate the no-persistence capability invariant.

---

## ADR-012 — Prove managed readiness and activate immutable runtimes

**Status:** Superseded by ADR-028 (shared publication/readiness token only; immutable runtime activation remains); fork-era record

**Context:** A generic loopback health body does not prove that the configured port belongs to the
newly managed gateway; another local account can pre-bind it. In-place runtime replacement also
makes failed upgrades and cross-version rollback difficult to verify.

**Decision:** Stage each gateway payload in a private content-addressed version directory, verify
its manifest and complete payload digest before activation, and advance an atomic current pointer
only after the exact managed service answers a fresh publisher-token HMAC challenge bound to a
one-time instance nonce in its service definition. Snapshot the prior config before mutation and
restore config, service state, and runtime pointer if install fails. Probe both prior and requested
loopback endpoints before replacement. Runtime manifests record the readiness protocol; accept
prior SemVer runtime directories only after the same containment, manifest, and digest verification,
and use a stable service-manager check with the legacy HMAC only for a verified pre-nonce runtime.
Publisher-token rotation never restores the previous token; a failed restart retains the fresh
token and stops the service.

**Consequences:** Installs and upgrades reject generic, same-token-stale, and authenticated
foreground readiness responses without exposing the publisher token. Verified legacy payloads
remain rollback-compatible. Disk use grows by one immutable payload per staged version until an
explicit future garbage-collection policy is qualified.

---

## ADR-013 — Mutually authenticate local registry peers without transmitting the key

**Status:** Superseded by ADR-028 (publisher-token mutual-authentication protocol); fork-era record

**Context:** A first-frame publisher key authenticates the client to the gateway but not the gateway
to the publisher. On Windows, a same-session process may pre-create the expected named-pipe name
before the gateway starts and receive that key and subsequent capabilities. OS ACLs prevent
cross-user access but do not establish that the process owning the pipe is `omp-gatewayd`.

**Decision:** Replace the raw-key hello with a four-frame, nonce-bound mutual HMAC handshake on every
platform. The publisher sends a fresh client nonce; the gateway sends a fresh server nonce and a
domain-separated server proof; the publisher validates that proof before sending its separately
domain-separated client proof; and the gateway accepts capability-bearing frames only after that
proof validates. Bind both proofs to both nonces, `instanceId`, and PID. Require exact frame keys,
fixed 43-character base64url values, constant-time proof comparison, bounded handshake time/space,
and mutable-buffer scrubbing. Derive the Windows pipe name identically in both components and
require the private token ACL to contain only the current user and SYSTEM.

**Consequences:** The publisher key never crosses IPC, a process that merely squats the pipe
namespace receives only a nonce-bearing hello, stale proofs do not replay, and Windows OMP
publication can fail closed on an unauthenticated server instead of remaining disabled. This is a
clean pre-alpha protocol cutover: old publishers and daemons do not interoperate. Same-user malware
that can read the private token remains outside the v1 threat boundary.

---

## ADR-014 — Recover publication by reconnecting without replacing ambient tool configuration

**Status:** Superseded by ADR-028 (publisher reconnect and token-path override); fork-era record

**Context:** A host suspension can outlive the registry TTL while leaving the local IPC socket open.
The registry then forgets the record, but a heartbeat alone cannot reconstruct capability-bearing
state. Sending a protocol-error frame after authentication also makes the security-hardened
publisher disable itself rather than reconnect. Separately, an isolated trial that repoints
`XDG_CONFIG_HOME` so the publisher can find its token also hides GitHub and other XDG-backed
credentials from OMP child tools.

**Decision:** When an authenticated publisher exceeds its idle deadline or heartbeats a missing
record, close its IPC connection without an error payload. The existing bounded reconnect path
must re-read the token, mutually authenticate, and re-send the current upsert. Permit isolated
launchers to provide an absolute publisher-token path through
`OMP_GATEWAY_PUBLISHER_TOKEN_PATH`, while retaining every ownership, mode, ACL, symlink, length,
and alphabet check and leaving normal installations on the standard per-user token path.

**Consequences:** Gateway and publisher suspension ordering no longer leaves a live OMP session
permanently absent after TTL. Trial OMP processes retain ambient Git, GitHub, and other XDG-backed
tool configuration without sharing the gateway token location. Actual OS sleep, wake, and network
transition still require native-device qualification.

---

## ADR-015 — Publish metadata-only response-required state

**Status:** Accepted

**Context:** A phone user cannot tell which OMP session is blocked on a host-origin response operation. The gateway does not proxy or decrypt collaboration traffic, and a user may open Control only after the operation began.

**Decision:** Add a boolean `inputRequired` field to the existing v1 publisher and browser metadata contracts. OMP retains a bounded serializable UI request before any writable guest exists, publishes `true` while at least one admitted host-origin response operation remains unresolved, and replays the request to later Control guests. Concurrent operations use generation-scoped reference-counted leases; no prompt text, options, answers, request IDs, counts, or transcript content leave OMP through the gateway. The dashboard orders attention cards first. An optional explicit permission action enables foreground-only browser notifications for authoritative false-to-true transitions; notification text contains only a fixed title and the already-approved bounded session title or directory label, and a tap opens or focuses `/`.

**Consequences:** The gateway remains a session directory and capability broker rather than a collaboration proxy. View stays read-only. Same-generation metadata can change without rotating capabilities, but old generations cannot mutate or retain attention state. Browser notification permission is browser-managed; application request state and dedupe state remain volatile. Multiple open dashboard tabs may each notify, killed-browser and background Push API delivery are unsupported, and physical Android lock-screen presentation remains a release qualification gate.

---

## ADR-016 — Detect silent dashboard transport loss with observable SSE heartbeats

**Status:** Accepted

**Context:** On physical Android, Tailscale can keep a virtual interface present while the radio path is unavailable. In that state `navigator.onLine` may remain true and an existing `EventSource` TCP connection may emit no error for more than 30 seconds. The gateway's SSE comment pings kept intermediaries alive but were not observable by dashboard JavaScript, so stale session cards could remain visible.

**Decision:** Emit a metadata-free named `keepalive` SSE event every 5 seconds. The loaded dashboard resets a 12-second liveness deadline on every directory event or keepalive. Missing that deadline clears all displayed session metadata, closes the potentially half-open `EventSource`, and begins authenticated snapshot retries with a 4-second request timeout and bounded 1/2/4-second backoff. While the collaboration client is visible, probe the same-origin generic health endpoint every 5 seconds with a 3-second timeout and listen for browser online, foreground, BFCache, and Network Information changes. A failed-then-successful probe or explicit network transition replaces the potentially stale relay WebSocket without replacing the logical guest.

**Consequences:** Silent dashboard partitions now have a bounded 12-second stale-display window and recover without waiting for a half-open transport to emit another event. Each loaded dashboard receives at most twelve metadata-free keepalives per minute; each visible collaboration client makes at most twelve generic health requests per minute. This local/tailnet availability traffic is accepted to avoid manual Refresh after radio roaming. The additive keepalive remains safe for older v1 clients, and probes carry no session metadata or capability. API responses and navigation remain outside service-worker caches; a cold installed-PWA launch while fully offline is intentionally unavailable, while an already loaded shell fails closed without stale metadata.

---

## ADR-017 — Deliver actionable attention through metadata-only Web Push

**Status:** Accepted; amended 2026-09-25 (no coalescing topic) and 2026-09-30 (taps routed into an open page)

**Context:** Foreground SSE notifications cannot reach an installed PWA after its page closes. The
phone user needs an actionable alert that reaches the exact live session with one tap, without
placing a collaboration capability or prompt content in a notification, URL, or persistent browser
state. A native Android/FCM wrapper would retain the same server-side delivery work while adding an
APK, signing, Digital Asset Links, distribution, and native lifecycle surface.

**Decision:** Use standard Web Push from the loopback gateway to each browser-provided push endpoint.
Persist one per-install VAPID key pair and at most eight authenticated browser subscriptions in a
user-only state file; this state is separate from the in-memory session registry and never contains
session metadata or collaboration capabilities. Send only strict `attention`/`resolved` envelopes
containing protocol version, `instanceId`, and generation, encrypted by Web Push, with a short TTL,
high urgency, and a per-generation coalescing topic. Visible notifications use a fixed title and no
body. After explicit opt-in, the notification tap is the explicit Control action: open a
metadata-only attention route, synchronously scrub it to `/`, authenticate through the normal
Tailscale path, validate exact generation plus current `inputRequired`/Control availability, and
then use the existing no-store in-memory launch flow. Stale taps fail closed to the directory.

**Consequences:** Closed-page delivery works without public gateway ingress or a custom cloud broker,
but the browser push service observes endpoint and delivery timing and remains an availability
dependency; payload content is encrypted. Browser force-stop, notification settings, power policy,
offline devices, or a sleeping desktop may delay or prevent delivery. Push state now has a narrowly
scoped private persistence exception, while collaboration capabilities and the session registry
remain memory-only. Physical Android background, lock-screen, tap, force-stop, and network-change
qualification is release-blocking. A native FCM wrapper remains a fallback only if this path fails
that qualification.

**Amendment — 2026-09-25:** Messages carry no coalescing topic. FCM treats a Web Push `Topic` as
a collapse key and limits collapsible messages to "a burst of 20 messages per app per device, with
a refill of 1 message every 3 minutes"
([FCM throttling](https://firebase.google.com/docs/cloud-messaging/throttling-and-quotas)). Every
ask sends an attention and a clear, and stops and page-load replays add more, so ordinary use
exceeds that budget. The physical background-Push lane failed twice at the same late step: an
answered ask's clear did not arrive within a minute, so its notification stayed up. A controlled
comparison on the same Pixel isolated the topic. With it, 21 messages arrived within 3.5 seconds
and the next two took 151 and 172 seconds; without it, immediately afterwards and with that budget
spent, all 28 arrived within 3.1 seconds. Dropping the topic also stops exposing a stable
per-session identifier to the push service.

Residual, accepted: a device that was offline receives every unexpired message on reconnect, not
only the newest, so an ask resolved meanwhile can alert briefly before its clear closes it. Push
services do not guarantee order either way, and the request-specific clear still cannot close a
newer ask. Activity-stop messages follow the same rule.

**Amendment — 2026-09-30:** A tap is routed into an open page; the worker never navigates one.
Chromium reports a window client's creation URL, not the route the page later reached through the
history API (ADR-018 amendment), so the worker cannot tell an idle directory from a live `/client/`
collaboration. On a Pixel 10 Pro (Android 17, Chrome 154.0.8037.57) the installed WebAPK reported
`/` while live at `/client/`, and a tap's `navigate()` reloaded that document in the foreground and
in the background: the live client, its in-memory capability, and any unsent composer text were
lost, and an activity-stop tap relaunched a Control session as View.

The worker now focuses the most recently focused same-origin window and posts it the notification's
metadata-only data (version, type, instance ID, and request ID or generation) over a
`MessageChannel`. A page that accepts it takes the routed-load path in place: fresh authenticated
metadata, the exact request or generation, then the ordinary generation-bound no-store launch. A tap
for the collaboration already open, at the authority the tap grants, keeps it, so an activity stop
never downgrades Control and an attention tap relaunches only to gain Control. A stale tap during a
collaboration keeps it open and shows a notice only when no triage prompt is showing. Focus comes
first because Chrome freezes a page about a minute after it is hidden: a hidden WebAPK page answered
at 2 and 17 seconds but not at 62, a Chrome tab received `freeze` 60 seconds after it was hidden, and
bringing the page forward resumes it. With no open window, or none that accepts within three
seconds, the worker opens the route exactly as before.

Residual, accepted: a page loaded before this change never accepts, so its tap waits three seconds
and then opens the route; in the WebAPK that route may still replace the open document. Pages
reload into current code when idle (ADR-018), so this lasts only while an older collaboration stays
open.

---

## ADR-018 — Activate PWA upgrades automatically without interrupting live collaboration

**Status:** Accepted; amended 2026-09-23 (worker-initiated client navigation removed)

**Context:** An installed Android PWA can keep an already-loaded JavaScript document and leave a newly installed service worker waiting, so a gateway upgrade previously required a manual Refresh or reopen. Reloading while `/client/` is active would destroy the collaboration capability that intentionally exists only in JavaScript memory.

**Decision:** Build every shell with content-hashed assets and a content-derived cache name. The new service worker caches its complete shell, calls `skipWaiting`, removes prior shell caches during activation, and claims clients. If activation observes a prior shell cache, it navigates only an exact same-origin `/` directory client to the no-store `/update/` bootstrap; the newly loaded app synchronously scrubs that route to `/`. Reserve `/client/` synchronously when a View or Control launch begins, and never auto-navigate `/client/`, `/attention/`, query-bearing, or cross-origin clients. An update-aware page also observes controller replacement and performs a bounded fallback reload only when no capability launch or collaboration client is active. A deferred update applies after a failed launch returns to the directory or when the user naturally leaves collaboration.

**Consequences:** Idle installed PWAs adopt a new build without manual action, including the transition from older clients that do not understand the update protocol. Active collaboration remains uninterrupted and adopts the update on its ordinary return to Sessions. The update route carries no metadata or capability, is synchronously removed from history, is never cached, and adds one authenticated shell navigation per upgrade. A browser that cannot install or activate service workers retains ordinary network-navigation behavior but cannot provide zero-touch in-place upgrades.

**Amendment — 2026-09-23:** Chromium reports a window client's creation URL, not the route a
page later reaches through `history.pushState` or `replaceState`: in desktop Chromium,
`Clients.matchAll()` kept reporting `/` for a page at `/client/`. The worker could therefore not
tell an idle directory from a pending launch or a live `/client/` collaboration, and activation
navigated all three to `/update/`. That also matches the recurring first physical View/Control
smoke failure after a gateway upgrade, which later runs never reproduced. Activation now only
retires prior shell caches and claims clients; it never navigates a client, so no synchronous
`/client/` reservation is needed. The page alone performs the bounded fallback reload, and only
while no launch is pending, no routed notification awaits its snapshot, and no collaboration
client is mounted. Every published release since `v0.1.0-prealpha.8` carries that page fallback,
so older update-unaware clients no longer justify worker navigation. The no-store `/update/`
bootstrap and its synchronous scrub remain only for activations by earlier workers.

Residual, accepted: a `skipWaiting` activation replaces the controller of every existing client,
whether or not the worker claims it, so a page still running v0.5.0 or earlier code when the fixed
worker activates applies its own predecessor fallback. That fallback still protects a single
pending launch and a mounted collaboration; it can still reload during two concurrent launches or
while a routed notification awaits its snapshot. Only pages loaded from the fixed release onward
carry the complete guard. Avoiding this would require giving up `skipWaiting`, which this decision
rejects.

---

## ADR-019 — Complete the couch-flow attention contract with bounded presentation metadata

**Status:** Accepted

**Context:** The approved couch-flow handoff requires request-specific triage, per-device notification detail, notification-to-Control routing, and stale-list recovery. ADR-017 deliberately limited attention to one boolean and a bodyless notification, so the partial implementation could not distinguish consecutive requests in one generation, preserve an exact opened request through the shell, or offer the explicitly approved notification detail choices.

**Decision:** Keep the OMP publisher protocol compatible and capability-free. On each accepted `inputRequired: false → true` transition, the gateway creates an opaque, random, in-memory request identifier and receipt timestamp; repeated `true` updates retain them, and clear, removal, or generation replacement destroys them. Browser metadata exposes this bounded attention identity as `ask.requestId` and `ask.since`; an optional server-truncated plain-text preview and option count may be added only when a future publisher contract explicitly supplies them. Until then every surface uses the specified boolean fallback. Push subscriptions persist only endpoint/key material, authenticated identity, and the chosen `private`, `session`, or `preview` detail level. Encrypted push payloads are assembled at send time: `private` is bodyless, `session` may contain bounded session/project labels, and `preview` may add the bounded preview but falls back to `session`. The settings UI warns that non-private text may persist in notification history, screenshots, and wearables.

Push messages use a per-instance notification tag, carry only bounded presentation metadata plus opaque routing identifiers and pending count, and never carry a capability. A tap opens `/collab/:instanceId?request=:requestId`; every request-specific Control POST carries that opaque identity, and the gateway atomically revalidates it with the generation at final capability lookup before releasing Control. Directory transport failures retain the last authenticated metadata in volatile page memory with an explicit stale timestamp; authorization failure still clears it. History state contains only route-safe ordering and scroll data, never session records or capabilities.

**Consequences:** Session labels and optional previews can leave the desktop in encrypted Web Push and become visible/persistent on the selected phone surfaces, but only at the user's per-device detail level. Opaque request IDs and timestamps may appear in list/SSE, push, routes, and history; they are routing metadata, not authorization. Collaboration capabilities remain confined to live process/gateway/client memory. ADR-017's bodyless, generation-tagged envelope and `/attention/` route are superseded; its explicit permission, private push-state, capability isolation, and stale-tap fail-closed requirements remain.


---

### Activity-stop extension — 2026-09-23

**Decision:** Consume the optional `busy` sample added by upstream PR #12844. The registry owns
true-to-false detection on a continuing identity/generation, excluding either waiting sample and
all observation gaps. Its internal event and record-local revision marker prevent stale queued
stops without a new broker or durable activity history. Add strict `activity_stop` to Push v2,
reuse existing privacy levels/topic/tag, and give attention precedence. Stop taps always revalidate
and open View, including on a view-only host; no new Control authority or completion claim.
The complete trigger, coalescing, rollout, and routing rules are in ATTENTION_SPEC.md.

## ADR-020 — Measure network paths adaptively and acknowledge remote actions

**Status:** Accepted

**Context:** Browser online/type signals do not prove the gateway or encrypted relay path, fixed
five-second polling wastes healthy radio time, deterministic retry bursts synchronize clients, and
WebSocket-open state does not prove the host is still reachable. The shell also removed an Ask as
soon as its response was written to the socket, so a drop before host settlement looked successful.
The installed PWA and existing top/bottom shell already provide the required lifecycle surfaces;
a native wrapper, Workbox runtime cache, or persisted Background Sync queue would add complexity and
could retain capability-bearing action data.

**Decision:** Keep the PWA and its exact no-secret service worker. Treat browser lifecycle and
Network Information events only as triggers. Measure the same-origin gateway with smoothed RTT and
variance, bounded adaptive timeouts, a 15-second healthy cadence, a two-second suspect cadence, two
result hysteresis, and capped full-jitter outage retries. Count authenticated host frames as passive
relay liveness between explicit probes; after ten idle seconds, hosts that advertise the optional
encrypted extension answer sequence-numbered ping frames. Hidden pages cancel idle and pending
relay probes; foreground and network signals request a gateway probe and, only after required
gateway hysteresis reaches healthy, an immediate relay probe. A stale pong or unrelated inbound
frame does not satisfy the current bidirectional probe.
One missed reply degrades the path and triggers an immediate second probe; two
misses replace the socket. Every WebSocket handshake has a ten-second deadline, and subsequent
reconnects use capped full jitter.

Healthy chrome is only an accessible green dot. A disruption first shows `Reconnecting…`; after
three seconds the existing top/bottom shell identifies `Gateway unavailable` or `Relay unavailable`
and shows a meaningful retry countdown. Recovery shows `Connected` for 1.8 seconds. Submitted UI
responses remain visible, disabled, and marked `Sending…` in embedded and standalone modes until
the host sends `ui-request-end`; directory metadata cannot announce `Answered` first. The client
preserves and resends one pending response after a fresh welcome. A writable duplicate or late
response receives a targeted end frame even when the host already settled it, making the
acknowledgement idempotent without changing the v3 wire protocol. Adaptive recovery stops when the
client becomes terminal so the final action, status, and keyboard focus remain stable.

**Consequences:** Healthy operation has no persistent status text and fewer active probes. Gateway,
relay, and terminal Mac/session failures are distinguishable on existing surfaces without trusting
browser hints. Active actions cannot be mistaken for acknowledged actions, and an acknowledgement
lost during reconnect converges without a second user action when OMP includes patch commit 5.
Older hosts remain usable for ordinary live collaboration: their frames provide passive liveness
and they never advertise idle probes. They do not provide the duplicate-response acknowledgement
needed to guarantee pending-action convergence across reconnect. The extension adds only encrypted
timing traffic and no session data, capability, storage, URL, native surface, Workbox dependency,
or Background Sync queue. ADR-016's fixed collaboration-client probe cadence and reconnect
mechanics are superseded by this decision; its SSE heartbeat contract remains.

---

## ADR-021 — Treat the registry rendezvous path as failure-prone and make readiness prove it

**Status:** Superseded by ADR-028 (gateway publisher-socket watchdog); fork-era record

**Context:** A production daemon ran continuously for a week yet published no sessions. It had not
crashed: macOS reaps entries under the per-user `TMPDIR` after roughly three idle days, and it had
deleted `omp-session-gateway-<uid>/registry.sock` together with its parent directory. Bun kept the
listening socket alive on the now-unlinked inode, so `lsof` still showed the bound path while
`stat` returned `ENOENT`. Publishers resolve that path by name, so every OMP `upsert` attempt failed
with `ENOENT`. ADR-required behavior — a missing gateway never breaks OMP — then converted a total
outage into silence: bounded retry, no UI noise, and nothing in the daemon log. `GET /api/v1/health`
returned `{"status":"ready"}` throughout because it only proved that the HTTP listener answered, so
`omp-gateway status`, `doctor`, and the install readiness probe all agreed the daemon was healthy.
The runtime directory cannot simply move: OMP's publisher independently computes the same darwin
`TMPDIR` path, so changing one side alone breaks the rendezvous until a patched OMP ships.

**Decision:** Treat the filesystem rendezvous point as failure-prone rather than assuming the OS
preserves it. The IPC server records the device and inode it bound, and `verifyEndpoint()`
re-`lstat`s that path on a bounded 15-second cadence. A missing path means our own rendezvous point
vanished, so the daemon stops the orphaned listener, recreates the `0700` runtime directory, re-binds,
re-applies `0600`, and re-asserts private permissions. A path that exists but resolves to a different
inode means another process owns it; the daemon reports an unhealthy endpoint and never clobbers it,
because two daemons fighting over one socket is worse than one daemon reporting degraded. Readiness
becomes state-faithful: `/api/v1/health` returns `degraded` whenever the endpoint is unreachable,
keeping the HMAC challenge shape unchanged and still exposing no paths, counts, or publisher detail.
`gatewayReady` already requires `status === "ready"`, so an unreachable endpoint now fails readiness
instead of passing it.

Moving the darwin runtime directory out of the reapable `TMPDIR` to
`~/.local/state/omp-session-gateway/run/` remains the preferred way to remove the trigger, but it is
a rendezvous-contract change that must ship in lockstep with a regenerated OMP publisher patch. It is
deferred to that coordinated release; the watchdog is not a reason to skip it.

**Consequences:** A reaped socket now self-heals within one watchdog interval instead of causing a
silent multi-day outage, and the same control covers any other cause of socket loss. Detection costs
one `lstat` per interval. Sessions published before a reap survive the re-bind because live publisher
connections are not closed. The `degraded` status is a new observable value for health consumers, so
monitoring that only checked HTTP reachability now distinguishes a serving daemon from a usable one.
Until the lockstep path migration lands, the reap still happens; the daemon merely repairs it.

---

## ADR-022 — Refresh the OMP pin to v17.3.8 and keep npm `marked` in the vendored client

**Status:** Accepted

**Context:** The repository pinned `v17.0.6` / `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` from
2026-07-21, but the maintained downstream integration and the author's activated runtime had moved
to `v17.3.8` / `858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`. The shipped mbox no longer applied
there: `interactive-mode.ts`, `agent-session.ts`, `session-manager.ts`, and `builtin-registry.ts`
all conflicted. Separately, upstream `collab-web` replaced its npm `marked` dependency with
`@oh-my-pi/pi-utils/marked`, which drags `@oh-my-pi/pi-natives` and its per-platform binaries into
the bundled runtime dependency closure.

**Decision:** Refresh the pin to `v17.3.8`. Take the maintained series verbatim from the reviewed
handoff artifact `gateway-collaboration-v17.3.8.mbox` (sha256 `f63f74c9…`, four commits in
authoritative order `0006 → 0002 → 0003 → 0004`) and append a fifth commit. Take upstream's `collab-web` source wholesale
except for one line: keep `import { Marked } from "marked"`. Restore the health-probe and
response-acknowledgement commit, which the maintained series had dropped.

**Consequences:** The gateway ships a pure-JavaScript runtime closure instead of multi-platform
native addons for a markdown renderer, at the cost of a twelfth documented local patch that must be
re-applied on every refresh. The `Marked` API is identical across both import sources, so the
divergence is one import line. Because only source-level evidence was regenerated, every native,
Tailscale, relay, Android, browser, and signed-artifact row reverts to **NOT RUN** for this pin;
the previous pin's platform evidence does not transfer. Had the dropped health-probe commit not
been restored, the client's relay probes would have gone permanently inert rather than failing
loudly, because `#relayProbeSupported` only becomes true when the host sends a seed pong.

---

## ADR-023 — Move the unreleased OMP target to v17.4.1 without widening alpha support

**Status:** Accepted

**Context:** OMP released `v17.4.1` at
`9350b7990d26ebf69a604edc82d8558ef04adf30`. The maintained downstream
`gateway-collaboration` series already uses that exact base. Relative to the alpha's v17.3.8 pin,
upstream changed neither collab-web source nor wire-protocol source; collab-web only changed package
authorship metadata, while coding-agent integration points changed enough that the new
slash-command fixture needed to model `resumePublication()`. The published alphas remain qualified
only for v17.3.8.

**Decision:** Target v17.4.1 on the default branch for the next candidate. Regenerate the shipped
six-commit mbox from the maintained v17.4.1 commits `0006 → 0002 → 0003 → 0004 → 0007`, restoring
the separately carried health-probe commit before `0007`. Update `@oh-my-pi/pi-wire`, upstream
locks, licenses, notices, release metadata, doctor expectations, and hosted patch-application lanes
to the same immutable commit. Keep npm `marked` and the existing in-memory client integration;
there is no upstream client-source change to re-vendor.

**Consequences:** Source application and test results can establish that the patch is correctly
rebased, but v17.3.8 platform evidence does not transfer. Until a signed candidate repeats the
applicable host, relay, and physical-client lanes, v17.4.1 is an unreleased development target and
must not be advertised as supported. The published alpha matrix remains immutable.

**Qualification update (2026-08-21):** Signed candidate `v0.1.0-prealpha.20` repeated the
applicable Debian, macOS, physical-Pixel, patched-OMP, and relay lanes at this exact pin. The
condition above is therefore satisfied for the bounded beta matrix only; alpha support remains
immutable at v17.3.8 and no loose OMP compatibility range is inferred.

---

## ADR-024 — Use the exact OMP patch as the beta prerequisite and defer paired packaging

**Status:** Superseded by ADR-028 (patched-activation-route prerequisite); fork-era record

**Context:** Stock OMP v17.4.1 still does not provide the automatic collaboration controller and
authenticated registry publication required by the product. Removing the patch would restore
manual `/collab` commands and link transfer, eliminate zero-touch discovery, and drop the
generation-ordered revoke/publish guarantees. A persistent Windows source lane proved the patch can
produce and run a working binary, but building, signing, installing, updating, rolling back, and
qualifying paired OMP artifacts is a separate distribution project.

**Decision:** Accept the exact, tested v17.4.1 patch in `patches/oh-my-pi` as the supported beta
prerequisite. Upstreaming discussion #6460 and a paired OMP package are not beta gates. The route
must remain command-complete and versioned: exact checkout and tree assertions, upstream-supported
source build, a separate `omp-gateway-patched` activation path, explicit config verification, and
symlink-based rollback. Do not imply stock-OMP compatibility. Windows remains unadvertised for
independent signed-platform reasons, not because paired packaging is absent.

**Consequences:** Beta can ship without waiting on an upstream maintainer or expanding into a
second installer. Installation is more manual than the final product goal, and every participating
OMP process must be launched from the verified patched binary. A future upstream seam or paired
installer can replace this prerequisite, but neither blocks the bounded beta support matrix.

**Qualification update (2026-08-21):** The exact route now passes on both advertised architectures.
macOS candidate qualification and Debian [run `32537603211`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32537603211)
each reproduced the source/tree, used the matching official native addon, built the binary,
auto-published View/Control, validated no-store launches, and revoked on process close. Isolated
exact alpha/beta builds also passed symlink/version/config reversal. This proves the documented
manual primitive; it does not create a coupled gateway/OMP updater or weaken the paired-packaging
deferral.

**Engineering baseline update (2026-09-08):** Accept exact upstream v18.1.14
(`daf07999c2fee9b22edc7bf8fea1fb6272e0df5e`) plus the refreshed standalone gateway patch for
the current 0.3.0 source. Reuse the maintained downstream collaboration series and preserve the
gateway-only encrypted health/acknowledgement seam. The versioned build, in-memory client
bootstrap, manual rollback, stock-OMP exclusion, and paired-packaging deferral remain unchanged.
This supersedes the source baseline only: published v0.2.1 qualification stays bound to v17.4.1;
v18.1.14 needs its own exact evidence before a stable claim.

## ADR-025 — Publish stable 0.1 against a narrow matrix and bound browser-process failure

**Status:** Accepted; its support scope is amended by ADR-030

**Context:** GitHub excludes every prerelease from its Latest release surface. The qualified beta
already proves the gateway's core security, host, lifecycle, View/Control, and physical-Android
paths for two exact hosts and one exact client, but the release workflow intentionally rejects a
bare tag. Issue #65 separately proves a failure below the PWA: Android retained a healthy default
route while Chrome failed both the gateway and unrelated public traffic, stopped answering on its
DevTools socket, and recovered only after its process was force-stopped. A newly landed Chromium
NetworkChangeNotifier self-heal is relevant but not yet proven to resolve that failure.

**Decision:** Add one fail-closed stable channel selected only by the exact bare v0.1.0 tag. The
stable claim remains limited to the Debian, macOS, physical Pixel, TUN-mode Tailscale Serve, and
exact patched-OMP combinations recorded at the tag's source commit. Every pre-alpha, alpha, beta,
provenance, unknown, and cross-version tag stays a prerelease or fails before artifact creation.
Publish the bare tag as GitHub Latest only after a signed candidate repeats the applicable matrix.
The stable workflow must also refuse the bare tag until the exact signed tag's tree contains a fully
passed STABLE_RELEASE.lock.json candidate matrix and runtime-byte comparison. It must require a
GitHub-verified signed annotated tag, assert checked-out HEAD equals the event SHA, bind the
candidate tag/source/archive digest, and revalidate tag targets before provenance, draft creation,
and public promotion.
The non-prerelease and Latest flags must be rehearsed against GitHub in a private repository before
the real tag; syntax-only or mock evidence is insufficient for that external state transition.
The hardened workflow moves to signed-release.yml. The superseded release.yml workflow must be
disabled in GitHub before another tag is created; otherwise an old commit can select its historical
workflow definition and bypass controls that did not exist there.
**Control-plane update (2026-08-22):** historical workflow ID 316404456 for release.yml reports
state deleted; hardened signed-release.yml is active on main as workflow ID 339848215.
Draft and published release state must be read back through the GitHub API, including six uploaded
asset digests compared with the exact local signed files and Latest status. Observation receives
bounded 0/2/4/8-second retries. A persistently failed draft or post-publication observation attempts
release deletion; public attestation/Rekor evidence may remain as failed-attempt provenance.

Treat #65 as a documented browser-process environment limitation, not as a passing PWA reconnect
case and not as a reason to add another transport workaround. After 45 uninterrupted seconds of
failure while visibly foregrounded, the PWA must offer a clean retry and an in-shell
force-stop/reopen help panel; it must reset that clock while offline or hidden, remove guidance on
recovery, and make no third-party connectivity probe.
The physical-device driver must validate package, activity, and socket selectors before ADB,
require an explicit socket for alternate packages, and reject evidence when the CDP product version
does not match the selected Android package version. Canary evidence may narrow or retire the
limitation later; v0.1.0 does not claim the upstream fix is proven.

ADR-024's exact patched-OMP prerequisite and paired-packaging deferral extend to this narrow 0.1
release. Windows, background Push qualification, Portal Tunnel, userspace-networking Tailscale,
and self-hosted/proxied relays remain outside the stable core support claim.

**Consequences:** stable means supported inside one exact, evidence-backed matrix; it does not
mean universal platform support or that page JavaScript can repair a failed browser process. The
project can publish an honest GitHub Latest release without waiting for a speculative Chromium
backport, while every correction still requires a new immutable tag. Operators retain a manual
patched-OMP prerequisite until upstreaming or paired packaging is separately accepted.

## ADR-026 — Keep couch triage device-local without inventing session lifecycle

**Status:** Accepted

**Context:** The directory can identify one current input request, but its metadata has no
completed/activity signal and the PWA has no OMP-side command path that can gracefully exit or
deregister a process. A couch workflow still needs to defer a request that requires the desk and
hide an ordinary row that is not useful on one device. Calling that second action Close would claim
an effect the PWA cannot perform.

**Decision:** Implement both choices only in the PWA. **Hold for desk** records the exact
`(instanceId, requestId, heldAt)` ask and removes it from this device's couch rotation while the
gateway's authoritative attention state, pending count, and badge remain unchanged. **Dismiss
here** records `(instanceId, generation, dismissedAt)` only for a non-attention row, immediately
hides it on this device, offers five-second Undo plus persistent Show all, and performs no network
mutation. An authoritative ask change clears its exact hold; removal, generation replacement, or
later attention clears a dismissal. Transport failures clear neither. Both record sets are bounded
and may contain no labels, paths, models, prompts, transcripts, or collaboration capabilities. An
active-shell Hold is committed only after the next launch succeeds; a failed advance keeps the
current ask queued and the capability-bearing shell mounted. Live/working totals continue to count
rows hidden by dismissal.

Do not change the gateway/IPC protocol or OMP patch for these presentation choices. Do not call a
non-attention row Completed, and do not label local dismissal Close or Exit. A real graceful remote
close requires a separately threat-modeled OMP command path and protocol decision.

**Consequences:** A held ask still needs input and remains visible to other devices. A dismissed
session keeps running and consuming its ordinary resources until OMP itself stops; only this
device's row is hidden. Exact ask/generation scoping makes later work visible automatically, and
the permanent restore surface prevents local state from becoming irrecoverable.

## ADR-027 — Ship the couch-flow visual system with a Settings sheet and a precached client

**Status:** Accepted

**Context:** The first couch-flow directory carried a labeled "Dismiss here" button on every
working row, rendered ask previews in uppercase mono, kept notification controls as a bottom-of-
page block, showed an "All clear · 0 working" summary for an empty directory, and promised "You'll
get pinged" regardless of alert state. Launching View/Control fetched the ~600 KB pinned
collaboration-client module over the tailnet at tap time because the service worker precached only
the app shell.

**Decision:** Keep every couch-triage semantic from ADR-026 and restyle its presentation: the
dismiss action becomes a hairline-divided compact per-row control with the explicit "Dismiss …
on this device" accessible label; ask previews render as sentence-case body text with the option
count; held rows requeue with a labeled control; list re-renders animate nothing. Move
device-scoped preferences — the seven-state background-alert toggle, notification detail options,
and build identity — into one Settings bottom sheet behind a persistent masthead control, with the
toggle disabling in place instead of reopening the sheet. Show the `collab.autoStart` empty state
when zero sessions are live, and state the ping promise only while alerts are enabled, otherwise
offering a Settings chip. Treat the pinned collaboration-client module and stylesheet as part of
the content-hashed application shell: the service worker precaches them, the document preloads
them, and an idle directory warms the module import while capabilities remain fetched only on tap.

**Consequences:** Session titles get the full row width and rare actions stop dominating the
resting screen. Notification behavior keeps its exact seven labels and explicit-gesture permission
flow with one added tap of indirection through Settings. The shell cache grows by the client
bundle, keeping launches independent of tailnet round-trips for static bytes; the update flow is
unchanged because the cache name derives from the full asset list. The alerts promise is now
truthful per device state, and media, e2e, and unit fixtures encode the new presentation.

---

## ADR-028 — Consume mainline OMP discovery and resolve capabilities only at launch

**Status:** Accepted

**Date:** 2026-09-14

**Context:** [PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20). Mainline OMP now owns the
collaboration controller and local registry. Maintaining a second OMP transport, activation route,
and shared credential is no longer necessary. Fork-era gateway artifacts retain their original
compatibility and qualification evidence.

**Decision:** Require stock OMP `>= 18.1.20` and only `collab.autoStart`. Remove the downstream
OMP patch set and gateway publisher listener. Read OMP’s private discovery directory, query
metadata snapshots on a bounded poll interval, and resolve the exact generation and access with
a per-host `link` request only after an explicit authorized launch. Never write, rename, or
unlink OMP’s discovery files or sockets. Only `ENOENT`/`ECONNREFUSED` proves a queried host dead;
transient errors retain metadata until TTL expiry. Never store or cache capabilities in the gateway.

**Additive extension, 2026-09-23:** Accept the optional boolean `busy` introduced by upstream
PR #12844 (`1eb2f51bb4d1a4324e46cdfad5c259be9b8ccee9`) under unchanged registry v1. Omitted/null
means unknown, not idle. Keep other snapshot keys strict and retain the 18.1.20 baseline and
existing client/native pins. The compatibility fix does not itself implement stop notifications.

**Additive evolution, 2026-09-24:** Supersedes "keep other snapshot keys strict" above. Upstream
adds registry v1 fields without a version bump, because a bump would hide every host from
differently versioned listers; rejecting unknown keys therefore hides every session on each
addition, as #219 did. Require and validate the discovery, snapshot, `model`, and reply fields the
gateway reads, ignore other keys, and build every result from named fields only, so nothing
unknown reaches browser metadata. Keep the exact version gate, and refuse a snapshot that names ask
content (`prompt`, `question`, `options`, `prefill`, `answer`, `requestId`, `count`).

Upstream prunes a killed host's discovery file only while listing, and the gateway never deletes
one. After revisiting admitted publications, examine at most 4,096 names per round and read
unknown publications newest first, so leftovers and other residue ahead of a new session in
directory order cannot displace it. Remember each publication whose endpoint proved dead by file
identity, bounded at ten per admission slot, and skip its unchanged file without a read or query.
A replaced file is read again; a pruned one is forgotten.

Rename the local managed-readiness credential to `readiness-token` and the rotation command to
`rotate-readiness-token`; it is not an OMP credential. Installation removes the legacy fork-era
`publisher-token`. Add `omp.discoveryDir` and `omp.queryTimeoutMs`; retain
`registry.heartbeatSeconds` as the poll interval. Keep browser HTTP/SSE shapes, with the added
`409 mode_unavailable` refusal when OMP no longer shares the requested role.

This supersedes **ADR-024** (patched activation route), **ADR-013** (publisher-token mutual
authentication), and the shared-token portion of **ADR-012**. It also supersedes the transport or
host-patch portions of **ADR-002**, **ADR-003**, **ADR-011**, **ADR-014**, and **ADR-021**, and
narrows **ADR-006** from a memory-only secret store to no gateway capability storage at all.
Unchanged client, browser, identity, and immutable-runtime decisions remain in force. Historical
OMP pins and support decisions in ADR-022, ADR-023, and ADR-025 continue to describe only their
named fork-era releases.

**Consequences:** Operators install mainline OMP, enable `collab.autoStart` once, and start plain
`omp`; no second OMP binary, gateway-specific OMP plugin, or gateway publication credential is
provisioned. The gateway remains a separate installation with Bun 1.4.0 and TUN-mode Tailscale Serve. Gateway restart repopulates metadata by polling without an
OMP reconnect. Discovery visibility is bounded by polling rather than push timing. The exact
engineering pin is `v18.1.20` / `1bd60c6fbd0e800a75fd09b1e4804af5a5e6d63b`; the minimum
host version is not a claim that every future version is qualified. Fork-era OMP processes must
restart under mainline at cutover. Older gateway configuration/credentials must be handled through
the matching historical release during rollback, not a transport shim. Mainline core qualification
and explicit stopped-predecessor recovery passed for the exact signed candidate and matrix in
the [release ledger](RELEASE_STATUS.md). Windows, background Web Push, specialized attention, and
branch/resume remain unqualified. The approved fresh 30-minute relay check passed; eight-hour
endurance is **not rerun or claimed**, with prolonged-operation risk accepted. No old test count,
signed receipt, native result, or relay endurance result is transferred.

**Engineering baseline update (2026-09-24):** Accept exact mainline v18.3.0
(`62bc57be1b03ef0802a33cf7f5f530e534527531`, tree `b36226cce6a225a4c0d2c2162da223d61d7123da`) as the
engineering pin and refresh the embedded client to its `collab-web`. Registry v1, the collaboration
protocol, and relay framing are unchanged apart from the optional `busy` field; the minimum host
stays `18.1.20`, and the client keeps the hub-family renderers that older supported hosts still
emit. This supersedes the source baseline only: published v0.5.2 qualification stays bound to
v18.1.20, and v18.3.0 needs its own exact signed-candidate evidence before a stable claim.

**Engineering baseline update (2026-09-29):** Accept published mainline v18.4.2
(`4620bb8338e0ecace7ea237da9d5088d16068617`, tree `71855eece785c0655d99d7700b52ef5f77c0e185`) as the
engineering pin and refresh the embedded client and npm wire pin together. Registry v1 and the
wire source are unchanged; the minimum host remains `18.1.20`. Adopt upstream's buffered snapshot
publication, completion-by-count, finished-stream clearing, redesigned client surfaces, and
coarse-pointer text sizing. Keep gateway embedding, bounded recovery, capability isolation,
photo/Ask controls, and explicit transcript expansion; exclude OMP artwork. The Darwin arm64 and
Windows x64 baseline native hashes identify official npm artifacts, not qualification results.
Published v0.6.3 qualification stays bound to v18.3.0. This source update requires fresh exact
signed-candidate qualification before any stable claim; unpublished v18.4.3 is not the baseline.

**Engineering baseline update (2026-10-01):** Accept published mainline v18.4.8
(`717f97f4d22b3d65c4a4eef6a744255d46f4d1a6`, tree `3f8ecdad21e55c5f47785ccfbd4f8c0528186976`) as the
engineering pin. `packages/coding-agent/src/collab` and `packages/collab-web` are byte-identical to
v18.4.2, so registry v1, host queries, the collaboration protocol, and relay framing are unchanged,
and the minimum host remains `18.1.20`. The embedded client keeps its v18.4.2 source and npm wire
pin: a client refresh would change only provenance labels, and pi-wire 18.4.8 adds only the Tern
Surface Protocol module and optional `AgentProgress` fields, which `collab-web` does not read.
Upstream reports that 18.4.3 through 18.4.7 crash at startup on Apple silicon macOS earlier than 27,
which includes the macOS 26.6.1 qualification host, so none of them is a baseline. The Darwin arm64
and Windows x64 baseline native hashes identify official npm artifacts, not qualification results.
Published v0.7.1 qualification stays bound to v18.4.2; this source update requires fresh exact
signed-candidate qualification before any stable claim.

---

**Engineering baseline update (2026-10-02):** Accept published mainline v18.4.12
(`7318a70cf4ed04133366884d2723f72d9d490a15`, tree `d804bc6bff03bb96057dd46f3bf6ae0479e7c649`)
as the host engineering pin, with registry v1 and minimum host `18.1.20` unchanged. Relative
to v18.4.8, collaboration changes are confined to CLI guest extension lifecycle mirroring;
host/controller/registry/relay sources and the wire index are unchanged. The embedded client
retains its v18.4.2 provenance and wire pin; upstream's transcript math performance changes are
not part of this host-only update. Official npm native tarballs supply both platform hashes,
verified against registry sha512 integrity and sha1 shasums.

[Canary run 37040958377](https://github.com/alphastorm/omp-session-gateway/actions/runs/37040958377)
passed all ten Linux and all seven supported Windows stages; the three Windows keystroke stages
are intentional skips. This does not establish signed-artifact or macOS qualification. Published
v0.7.2 remains qualified on v18.4.8. The green run does not resolve the transient auto-start risk
tracked in #343; upstream retry fix can1357/oh-my-pi#14112 remains open at this observation.

---

**Engineering baseline update (2026-10-03):** Accept published mainline v18.5.1
(`d0cc52397dc2a68d39cba49b0009b9e50ffd643e`, tree `f80f979c55f14c2e097b1d83e2f37ade2fa44ce4`)
as the host engineering pin, with registry v1 and minimum host `18.1.20` unchanged. v18.5.1 is the
first release carrying upstream retry fix
[can1357/oh-my-pi#14112](https://github.com/can1357/oh-my-pi/pull/14112), merge
`b1e84317b74f5171137fecec4e1c578128f3aa72`; v18.5.0 predates it. An automatic start whose relay is
unreachable or times out now retries on the existing relaunch backoff instead of leaving the
session unpublished until `/collab`, a session switch, or a restart (#343), and the recovered room
still publishes generation 1. Relative to v18.4.12 it is the only change to the collab host and
controller; `guest.ts` gives a CLI guest's replica its own session-ownership lease. The registry,
collab settings, wire index, and `collab-web` are unchanged, so the embedded client keeps its
v18.4.2 provenance and wire pin. The minimum host stays `18.1.20`: older hosts still satisfy the
discovery/query contract and only lack the retry.

[Canary run 37140425389](https://github.com/alphastorm/omp-session-gateway/actions/runs/37140425389)
passed all ten Linux and all seven supported Windows stages; the three Windows keystroke stages
are intentional skips. A throwaway macOS tracer under Bun 1.4.2 refused each host's first relay
connection and started a local relay only after the host showed `Collab auto-start failed`: stock
18.5.1 published generation 1 with Control access 1,007 ms later, and stock 18.5.0 never published
in the following 60 seconds. This is tested evidence, not signed-artifact or macOS qualification;
published v0.7.3 remains qualified on v18.4.12. `scripts/upstream-pins.ts` now derives the lock and
Windows pins; run against v18.4.12, it reproduced every pin #351 measured by hand.

---

**Engineering baseline update (2026-10-08):** Accept published mainline v18.8.3
(`3e3c488a58d294e3a10051da588628e2cfb9d35c`, tree `307c09c826aff7f0818c7aa19722c504646a49fd`)
as the host engineering pin (#368), with registry v1 and minimum host `18.1.20` unchanged.
`scripts/upstream-pins.ts` derived every pin. Relative to v18.5.1, `registry.ts`,
`collab/settings.ts`, `docs/collab.md`, the collaboration slash commands, and
`packages/wire/src/index.ts` are unchanged, so discovery files and their socket paths, registry
v1, and `collab.autoStart` behavior are unchanged.
[can1357/oh-my-pi#14714](https://github.com/can1357/oh-my-pi/pull/14714), merge
`418bc4aa7f67cb58deb3d143153656fa23b0e7ba`, mirrors event, entry, bus, state, and agents frames
only while a guest is joined and serializes each replicated payload once; the frame fields, the
packed relay envelope, the welcome snapshot, and registry publication are unchanged, so the relay
protocol is unchanged. [#14715](https://github.com/can1357/oh-my-pi/pull/14715) and
`f085ca82927e1c3a35b13b7b5e6a928abbfa568b` touch only the CLI guest.
[#14728](https://github.com/can1357/oh-my-pi/pull/14728) and
[#14667](https://github.com/can1357/oh-my-pi/pull/14667) change `collab-web` rendering, which the
embedded client does not import; it keeps its v18.4.2 provenance and wire pin, and
`@oh-my-pi/collab-web` stays 16.3.6. `@oh-my-pi/pi-wire` 18.8.3 changes only `tsp.ts`. From 18.8.1
(`355b5d9685529d337875d7d387ef53b1f32e7a72`), a generated session title is written in the card form
`<icon> <CODE>: <title>`, so `sessionName` may begin with an emoji or Nerd Fonts glyph; the field
remains a string inside the gateway's 256-code-point label bound and needs no gateway change.

This is source review only: no canary, candidate, or qualification is claimed for v18.8.3, and
published v0.7.4 remains qualified on v18.5.1.

---

**Engineering baseline update (2026-10-10):** Accept published mainline v18.8.9
(`fa5ff4a3a977a28b93d025f4cf50f046e019f18c`, tree `3017032181e2f9a11ee8269dabb963dc5acb4703`)
as the host engineering pin (#390), with registry v1 and minimum host `18.1.20` unchanged.
`scripts/upstream-pins.ts` derived every pin. Relative to v18.8.3, `packages/coding-agent/src/collab`
(including `host.ts`, `registry.ts`, and `settings.ts`), `docs/collab.md`, `packages/collab-web`,
and `packages/wire/src/index.ts` are byte-identical, so discovery files and their socket paths,
registry v1, the relay protocol, and `collab.autoStart` behavior are unchanged. Merges
`bf1b71aba7661ba6f6b557b7a223c714fd21ed6c` and `c25d7aba89736e04456c301d543e0202343faafa` name
collab files in their first-parent diffs but leave them as at v18.8.3.
[can1357/oh-my-pi#13620](https://github.com/can1357/oh-my-pi/pull/13620)
(`be4acc5f44a1f3bbbe9446a9ac09c0172b59470b` through `c1d5701415544b7035f8e9c5f146bd324341e79d`)
adds `ctx.ui.openTerminal()` and `/fork pane|window|tab` in `docs/extensions.md`,
`modes/types.ts`, `extension-ui-controller.ts`, and `builtin-registry.ts`;
[#15077](https://github.com/can1357/oh-my-pi/pull/15077)
(`2616e32bed53579fb1dc36def292462b5e00fd12`) adds `/dump anon` to the collaboration slash
commands; [#15058](https://github.com/can1357/oh-my-pi/pull/15058)
(`61ad7d2b7486e4094830a55b209b3b57114a4b25`) and
[#14908](https://github.com/can1357/oh-my-pi/pull/14908)
(`428c97f28e9ff31ccfbb185e9472c5781dd81913`) change only TUI selector and `/wt` handler types;
`bd0a8f72caff30d4807edce275be8479db849774` documents queued asides; and
`6c99a355d64fe43e027b047ce97859a566afd760` plus the version bumps touch only `package.json`. The
gateway reads and sends none of these. `@oh-my-pi/pi-wire` 18.8.9 changes only `tsp.ts`, and
`@oh-my-pi/collab-web` stays 16.3.6; the embedded client keeps its v18.4.2 provenance and wire pin.

This is source review only: no canary, candidate, or qualification is claimed for v18.8.9, and
published v0.7.5 remains qualified on v18.8.3.

---

**Engineering baseline update (2026-10-12):** Accept published mainline v18.10.2
(`c8913466dd7bf92040de911f8e00e30b8f4e48a2`, tree `bbe0b2fa461fc34bf45cb544432a24e767f155ec`)
as the host engineering pin (#398), with registry v1 and minimum host `18.1.20` unchanged.
`scripts/upstream-pins.ts` derived every pin. Relative to v18.8.9, `host.ts`, `settings.ts`,
`docs/collab.md`, `packages/collab-web`, and `packages/wire/src/index.ts` are byte-identical, so
the discovery file format, registry v1, the relay protocol, and `collab.autoStart` behavior are
unchanged. `a608a9ca07c9443634e80d877d61c602099dab91` moves `registry.ts` onto the pi-natives
`IpcServer`/`IpcConnection` transport: each query is still one newline-terminated JSON request
and one newline-terminated JSON response, the socket stays `<dir>/<entryId>.sock` at mode 0600
beside a new `<entryId>.sock.bind.lock`, an overlong path moves from `/tmp/omp-collab-<hash>` to
the owner-only `/tmp/omp-<euid>`, Windows pipes become `\\.\pipe\omp-<entryId>-<hash>`, and the
host refuses peers running as another user. The gateway reads the endpoint verbatim, reads only
`.json` names, already requires an owner-private directory and a 0600 socket, and queries as the
publishing user, so it reads and sends the same bytes.
[can1357/oh-my-pi#14387](https://github.com/can1357/oh-my-pi/pull/14387)
(merge `ae88edd36cb31a5004fd8e3f70ede57dbf33812d`) adds host relay WebSocket pings and a
silent-socket reconnect without a new relay message;
[#15260](https://github.com/can1357/oh-my-pi/pull/15260)
(merge `d8e57c951927fbb01326f9e5330a1185e5f49520`) adds `ctx.annotations` and `supportsEditor`
in `docs/extensions.md` and `extension-ui-controller.ts`;
[#11798](https://github.com/can1357/oh-my-pi/pull/11798)
(merge `80cf9110c9b0c0847d598abe32de8caa3ac2c671`) documents command-backed extension providers;
`25d28798d9db70b72e33c37178c20cacfb601851` removes two TUI composer methods from `modes/types.ts`;
and the version bumps touch only `package.json`. The gateway reads and sends none of these.
`@oh-my-pi/pi-wire` 18.10.2 changes only `tsp.ts`, and `@oh-my-pi/collab-web` stays 16.3.6; the
embedded client keeps its v18.4.2 provenance and wire pin.

This is source review only: no canary, candidate, or qualification is claimed for v18.10.2, and
published v0.7.6 remains qualified on v18.8.9.

---

## ADR-029 — Resume a backgrounded session by relaunching it, never by retaining its capability

**Status:** Accepted

**Date:** 2026-09-22

**Context:** Reported in [#198](https://github.com/alphastorm/omp-session-gateway/issues/198).
Backgrounding an installed PWA fires `pagehide`, which disposes the collaboration client and drops
its capability — correct, and the reason nothing durable holds a secret. The page itself survives
into the bfcache, so restoring it produced an inert shell that had to be handed back to the session
directory. To the user, momentarily switching apps was indistinguishable from the session dying, and
the reporter read it as a websocket that never reconnects. Retaining the capability across the
background would fix the symptom by destroying the property that makes the teardown safe.

**Decision:** Keep the teardown exactly as it is, and make the restore re-run the ordinary launch.
On a bfcache restore of a shell disposed by `pagehide`, rebuild the directory, poll fresh metadata,
and relaunch the same session when it is still listed at the same generation and still offers the
mode that was open. A changed generation, withdrawn access, or absent session falls back to the
directory with the existing stale-launch behaviour rather than opening a successor session behind
the card the user left. The pending request identity is carried back only while it is still the
question waiting; otherwise the resume is a plain reopen.

The page keeps a launch intent — instance, generation, mode, request identity — which is metadata
the directory already publishes, in heap memory the bfcache preserves. No capability is retained,
stored, cached, or placed in history or a URL; the resume acquires one from OMP exactly as the first
launch did. This refines **ADR-028**'s "only after an explicit authorized launch" to include the
automatic relaunch of a session this page's user had already explicitly opened, under unchanged
generation binding, and leaves the gateway's own no-storage rule untouched.

**Consequences:** Returning to a backgrounded session lands back in that session rather than the
directory. Resume costs one additional launch round trip and one fresh relay transport, and cannot
fire while a client is still live, because it is reachable only after disposal. An offline restore
resumes nothing and shows the directory's own failure state. Resume is qualified by the browser lane
only; it carries no iOS claim.

**Observation (2026-09-26):** On a real iPhone 17 Pro with iOS 26.5 in TestingBot's device cloud,
running v0.6.2, backgrounding the Home Screen app for 15 seconds, 2 minutes, and 5 minutes fired only
`visibilitychange`, never `pagehide`, and each return found the page alive and the session connected
in Control. The context above overstates `pagehide`: the bfcache restore serves a page that did enter
the bfcache, while the iPhone keeps the page and its client alive. An e2e test now fails if visibility
alone tears the client down. This was a targeted device check, not a qualification lane.

## ADR-030 — Claim support for CI-tested platform families, separately from qualification

**Status:** Accepted

**Date:** 2026-09-24

**Context:** ADR-025 tied every claim to the exact matrix a signed candidate passed on physical
hardware, so the public story read as one Debian host, one Mac, and one Pixel. The web client has no
platform-specific code path: no user-agent sniffing, no install-prompt dependency, and feature
detection for badges, push, and viewport APIs. Users asking whether it works on their computer and
browser found only that matrix, and "Windows OMP remains unqualified and unadvertised" read as
"Windows does not work". Hosted CI now supplies the missing evidence at no cost for a public
repository. `portable-source` runs the checks on Linux, macOS, and Windows. `browser-core` runs the
browser-neutral e2e tests on Chromium, Firefox, WebKit, and iPhone-class WebKit. `canary-windows`
drives stock OMP's Windows named pipe through the gateway's reader, joins View and Control through
the relay, and checks the prompt echo.

**Decision:** Separate three claims, defined in the COMPATIBILITY.md status vocabulary. *Tested*: a
named CI lane is green. *Supported*: a platform family the project keeps working, backed by named
Tested lanes, with bug reports accepted. *Qualified*: the exact combination a signed release passed in
the release matrix, unchanged from ADR-025.

Public surfaces lead with the supported families: Linux, macOS, and Windows hosts; Chrome, Chromium,
and Edge through Chromium; Firefox; Safari and WebKit; Android; iPhone and iPad as a WebKit browser.
The qualified matrix stays in COMPATIBILITY.md and the release ledger. Edge has no separate lane
unless an Edge-specific defect appears.

Tested and supported never transfer into qualified, and emulation is never presented as a
physical-device result. No retry, runtime skip, or `continue-on-error` may keep a supporting lane
green. A host-bound test exclusion names its platform and reason in `scripts/test-portable.ts`.

**Consequences:** "Supported" no longer implies qualified. This replaces ADR-025's consequence that
stable means supported inside one exact matrix; stable still means qualified inside it. A supported
family can regress between qualifications. Its lanes are the tripwire, and a family whose lanes stop
running loses support status. Windows hosts are supported without release qualification until a
persistent signed Windows lane runs (WINDOWS_QUALIFICATION.md). Stable release notes list the
qualified combinations as qualified, not as the limit of support.

## ADR-031 — Qualify a Windows host and Pixel background Web Push in every stable campaign

**Status:** Accepted; amended 2026-09-27 (standard-user fresh install)

**Date:** 2026-09-25

**Context:** ADR-030 made Windows hosts supported but left them out of the qualified matrix until a
persistent signed-artifact lane could reboot a Windows host into an interactive login. Hosted runners
cannot do that. ADR-017 and ADR-019 made the physical Android background matrix release-blocking for
any Web Push claim, and that matrix had never passed. Both lanes own external state the existing
lanes do not: a billed VM and a tailnet node, and a phone's radios, Doze state, notification
permission, and push subscription.

**Decision:** `qualify:stable` gains two resource-owning lanes. Each is paired with a cleanup lane
bound to the attempt it released.

- `windows` provisions a disposable Vultr Windows Server 2025 VM, identified by a campaign label
  and firewalled to the operator's `/32`, and joins it to the tailnet as a tagged node. It runs the
  exact signed candidate and predecessor with stock OMP built at the `UPSTREAM.lock.json` pin
  through install, upgrade, a real reboot with no pre-login listener, automatic start at RDP
  logon, OMP publication and revocation, the physical Pixel, rotation, rollback, restore, and
  uninstall. Its `doctor` evidence follows the Debian tagged-node convention: every host check
  passes, and exactly the identity-derived checks are false.
- `androidPush` drives the Pixel's installed OMP Sessions app against the retained Mac's
  candidate gateway and its own stock-OMP fixture. It covers closed-app delivery at each detail
  level, lock-screen presentation, taps to current Control and View, stale-generation refusal,
  authoritative clear, force-stop, permission revocation, Doze, network transitions, and the
  capability sinks.

Each lane's progress is replaced whole on every checkpoint and carries an attempt epoch. A crashed
attempt may be resumed; a caught failure is always released before another attempt begins. The
campaign passes only when each cleanup lane passed for the epoch its lane recorded. Windows runs
beside the Debian and Mac lanes. Every Pixel action runs under one in-process lease, and an action
that cannot restore the phone blocks every later one. The receipt schema moves to version 2, and
older receipts cannot resume.

**Consequences:** A stable campaign now needs a Vultr API key that accepts the operator's current
egress, the tagged Tailscale join key and API key, and, on the Pixel, Do Not Disturb off plus the
installed app with notification permission for the retained Mac's origin. The Windows claim is start at
interactive logon, not at boot. Force-stop and Doze outcomes are recorded as observed variants,
never as a delivery guarantee. Windows and background Push enter the qualified matrix only from a
passed campaign on the exact signed candidate; development runs stay tested evidence.

**Amendment — 2026-09-27:** Every campaign's Windows qualification had run as the built-in
Administrator, so it could not see that a standard user's install failed twice: the ACL helper
needed `SeSecurityPrivilege` (#293), and the account-less logon trigger needed elevation to register
(#294). After the Administrator journey, the `windows` lane now installs the same candidate fresh as
a local account outside Administrators whose token lacks `SeSecurityPrivilege`, reboots, and requires
automatic start at that account's logon, a full doctor, rotation, and uninstall. Tailscale serves
one Windows user at a time, so the Administrator signs out of it and the account joins as a new
tagged node. Upgrade, rollback, OMP, and the Pixel stay on the Administrator path, because the
predecessor cannot install without elevation. The receipt schema is unchanged; the new observations
carry a `standard` prefix.

**Amendment — 2026-10-01:** `androidPush` adds `triage_verified` and `stale_taps_verified` after
authoritative clear and before force-stop. A second owned fixture supplies ordered asks for
device-local Hold/requeue and Hide/Undo/Show all; the directory must have no unrelated waiting or
hidden sessions. Delayed taps cover resolved, re-armed, replacement-generation, and gone-host
requests. Because authoritative clear removes the original notification, the lane re-presents its
original metadata-only data through the installed app's service-worker registration and taps it
on the physical Pixel. `replayed: true` records this limit: it proves scrub/revalidation and zero
launches for delayed taps, not Web Push delivery ordering or delay. Cleanup owns both fixtures,
their notifications, and removal of their device-local triage records.

The retained-Mac `ompPublication` lane adds `/new`, `/fork` after two synthetic messages, stop
and revocation, `--continue` relaunch, then stop and revocation, after all live-session consumers
settle successfully and the relay tunnel stops. Rotations require same-instance generation + 1,
stale launch rejection without a capability, and working current View/Control launches; resume
requires a new instance at generation 1 with the same label. Evidence is additive under
`ompPublication.evidence.lifecycle` (`newGeneration`, `fork`, `resumed`; booleans/counts only),
and the current receipt schema stays 3. An interrupted step remains non-passed and reruns in full
on resume. Mainline `/branch` rewinds within the same session file without changing instance or
generation, so rewind is excluded from the Mac lane as not gateway-visible; the POSIX canary
checks its in-memory terminal status instead. Specialized attention and lifecycle enter the
qualified matrix only from a passed campaign on an exact signed candidate. Development proofs
are required before the campaign and remain tested evidence.

**Amendment — 2026-10-06:** Stable qualification and published-byte smoke share a release-account
host lease in a fixed local SQLite database. EXCLUSIVE locking mode keeps the OS lock across
commits; a committed campaign identity survives a crash, while the OS lock cannot outlive its
process. Only that same campaign may recover its existing receipts after a failure, and success
clears ownership before closing the database. There is no PID or timeout-based live-holder
takeover. The lease covers all effects and cleanup, independently of tag/receipt paths; the
in-process Pixel queue remains responsible for lane ordering. This is not a distributed fence,
and cannot terminate orphaned children or restore devices. One account/host, local storage,
draining older scripts, and existing resource recovery remain operational prerequisites.

## ADR-032 — Qualify iPhone, iPad, and Android browsers on real cloud devices in every stable campaign

**Status:** Accepted

**Date:** 2026-09-26

**Context:** No release had run on a physical Apple device. iPhone and iPad were tested only as
WebKit with iPhone-class emulation (ADR-030), and v0.6.1 shipped the fix for WebKit's subscription
shape (#274) without a real iPhone confirming it. TestingBot's open-source plan offers real iOS and
Android devices over W3C WebDriver at no cost, two sessions at a time. Probes on 2026-09-26 passed
the Pixel lane's collaboration journey and seven-sink sweep on TestingBot's iPhone 16 and 17 Pro
(iOS 26.5), iPad (9th generation, iPadOS 26.6), and Galaxy S26 (Android 16, Chrome). An iPhone
installed the Home Screen app, enabled background alerts with a real tap on the permission prompt,
received an attention alert in 5 to 12 seconds with the app in the background, and tapped it into
Control. TestingBot keeps a WebDriver step log of every session even with recording and logs off.
Its tunnel fetches whatever its devices request from the tunnel host's network position, so run
as shipped it would also reach that host's loopback, LAN, and every tailnet service its login may
open.

**Decision:** `qualify:stable` gains a resource-owning `deviceCloud` lane, paired with a
`deviceCloudCleanup` lane on the ADR-031 contract. Once the retained Mac's candidate gateway is live,
the lane:

- starts its own stock-OMP fixture on the retained Mac, and the pinned TestingBot tunnel (v4.9,
  SHA-256 pinned) on the orchestrator workstation;
- replaces the tunnel's local proxy with its own. The proxy opens CONNECT tunnels only to the
  candidate origin and the sources the candidate's `connect-src` names, read from its response, and
  refuses everything else, plain HTTP included. It never decrypts. The tunnel's own Selenium relay
  and metrics server, which bind every interface and whose relay lends the account to any caller,
  are given port -1 so neither opens; a tunnel listening beyond loopback, or failing to start, is
  stopped before the lane goes on;
- on an iPhone, an iPad, and an Android phone, each the first free model from a pinned list, runs the
  Pixel lane's directory, View, Control, prompt, and return journey and the self-verifying seven-sink
  sweep against the campaign's live OMP session, and requires the candidate archive's app bundle.
  Each device must report itself as the requested kind of device, browser, and OS release;
- on the iPhone, also installs the Home Screen app, enables background alerts with a real tap on the
  iOS prompt, receives an attention alert from the fixture with the app in the background, taps it
  into current Control with a scrubbed address, and turns alerts off;
- fetches every TestingBot test record the attempt created, and fails if one holds either session's
  live View or Control link, or any 16-character segment of one, or kept video or screenshots.

Credentials come from the read-only 1Password service account (`op://Centaur/TestingBot/...`), with
the token only in each `op` child's environment and the identity pinned by `op whoami`, so a campaign
never waits on a prompt. Sessions request no video, screenshots, or logs and are not public. Page
evaluations return only counts, booleans, and fixed names, and a failed one only its error's name,
because TestingBot keeps every command and its result; evidence text comes only from fixed
grammars. The lane holds the Pixel lease from its first effect until it has ended its sessions and
stopped its tunnel and fixture, because its prompts and alert raise Web Push to every subscription
on the candidate gateway; the cleanup lane repeats that release only for an attempt that stopped
before finishing it. The receipt schema moves to version 3, and older receipts cannot resume.

A passed lane qualifies the exact device, OS, and browser versions its receipt names, as qualified
in the browser on a cloud device. Those are what each device reported: an iPhone's or iPad's
release is Safari's version and its model TestingBot's report of the session; a Galaxy's release
and model code are Chrome's client hints, beside the model name requested. The limits are part of
the claim:

- the tunnel runs on the workstation, so Serve saw the workstation's allowlisted login, not a
  phone's own;
- alerts are proven with the device unlocked and the app in the background, not on the lock screen;
- lock, Airplane, Doze, force-stop, and cellular behavior stay Pixel-only.

**Consequences:** A stable campaign now needs the 1Password service-account token, Java for the
tunnel (`openjdk@17`), and TestingBot's open-source plan. A TestingBot outage, or no pinned model free
within ten minutes, fails the lane and holds the release, as a Pixel failure does. Replacing the vendor
means replacing the tunnel launch and the record audit; the journeys are standard WebDriver. iPhone
and iPad enter the qualified matrix only from a passed campaign on the exact signed candidate.

## ADR-033 — Retain a macOS virtual machine as the campaign Mac

**Status:** Proposed; founder-selected design, amending ADR-030 only for the retained Mac.

**Date:** 2026-10-02

**Context:** The retained Mac now shares a physical host with the release worker and the planned
campaign operator. The Mac persistence lane reboots its SSH target while other campaign lanes run
concurrently. Rebooting that physical host interrupts the operator, release jobs, device connection,
and tunnels; resuming only the Mac lane would not preserve those other owners. ADR-030 distinguishes
tested, supported, and qualified evidence, and forbids presenting emulation as a physical-device
result. Moving the retained Mac into a VM therefore needs an explicit change to the qualified
environment, not a relabeling of the existing bare-metal result.

**Decision:** Use one persistent Apple-silicon macOS guest on the retained physical Mac, managed by
[Tart](https://github.com/openai/tart) through Apple Virtualization.framework. The guest is the
retained Mac; the operator and unrelated workers remain on the physical host. Initially allocate
four virtual CPUs and 8 GiB of memory. Use an official base image matching the host macOS major
when available, and record the selected image and the guest OS and model instead of inheriting the
physical host identity.
The staged image is `ghcr.io/cirruslabs/macos-golden-gate-base:latest`, resolved on 2026-10-02 to
`sha256:9a2f20d179d6418a128dcb76c593588ea85a263dbfa286e757db63f3d949af7c`.

The lane contract is unchanged: SSH to a standard guest qualification account, install the exact
signed candidate, run the existing identity and lifecycle checks, request a guest reboot, wait for
the same guest to return, and uninstall the gateway and fixtures during cleanup. The guest has its
own user-owned, TUN-mode Tailscale node and Serve origin. Its account has the pinned Bun, stock OMP,
command-line prerequisites, SSH key, automatic console login, and only the five exact passwordless
sudo commands documented in RELEASE.md. Tailscale runs as a guest LaunchDaemon, not a GUI client.
No operator/provider credentials belong in the guest. Cleanup retains the VM and its node; it must
not reboot the physical host or restore a disk snapshot to manufacture a clean lifecycle result.

A passed signed-candidate campaign in this guest still exercises a real macOS kernel, launchd,
loginwindow, per-user LaunchAgent, native addon, filesystem, TUN interface, and guest reboot.
Automatic login proves return at **console login**, not gateway startup before login. A bootstrap
SSH/reboot probe is only setup evidence, not proof that the gateway LaunchAgent or full campaign
passed. The guest does not exercise the physical Mac firmware, FileVault unlock, Secure Boot paths,
power loss, physical sleep/wake, or physical device drivers. A guest success does not qualify a
bare-metal model, and no physical-phone or cloud-device requirement changes.

`OMP_STABLE_MAC_MODEL` must equal the guest
`sysctl -n hw.model`, never the physical Mac model. Admission continues to compare the exact model.
The next passed campaign must name its Mac row as a **Virtualization.framework guest**, with that
model and measured macOS version in both RELEASE_STATUS.md and COMPATIBILITY.md. Keep the existing
bare-metal rows and receipts unchanged until there is new signed-candidate evidence; do not transfer
their pass counts to the guest. Complete any old target-bound cleanup before starting a new campaign
with the guest target.

VM process supervision is separate from guest service persistence. A detached Tart process survives
an SSH disconnect but is not host-boot supervision. Prefer a KeepAlive LaunchAgent in the operator
account once the founder approves its console-login policy and transfers VM ownership.
[Tart documents](https://tart.run/faq/#headless-machines) that macOS 15 and later require the VM
owner's login keychain to exist and be unlocked. Unattended host-boot recovery therefore needs
automatic console login for that owner, or a separately reviewed noninteractive keychain-unlock
design. A root-installed LaunchDaemon alone does not establish that prerequisite. Do not put an
unlock password in a plist or wrapper; enabling automatic login for an operator holding credentials
is a founder security decision, not a consequence of accepting virtualized qualification.

The base image ships public credentials. Before admitting the guest to the tailnet, the founder
must rotate the guest administrator password, qualification-account password, and automatic-login
credential together. Bootstrap may stop at an unconsumed Tailscale login URL; it must not admit a
node with public credentials. Guest SSH becomes key-only after the key has been proven.

**Bootstrap observation, 2026-10-02:** The pinned image reports macOS 27.0 (build 26A428),
`hw.model=VirtualMac2,1`, `arm64`, four virtual CPUs, 8 GiB RAM, and a 50,000,000,000-byte
virtual disk (46.566 GiB). Use `OMP_STABLE_MAC_MODEL=VirtualMac2,1` for this guest. Its private
Tart NAT address is reachable only through the physical host; it is not a tailnet address.
The standard qualification account now has proven key-only SSH, the five exact sudo grants
(with only the certificate hostname adapted), checksum-verified Bun 1.4.0, and stock OMP 18.4.8.
The image already provided administrator-owned Homebrew and Command Line Tools. The existing
automatic-login credential was authenticated against both guest accounts before reuse.
Homebrew Tailscale 1.102.5 runs as the guest `sh.brew.tailscale` LaunchDaemon. Its enrollment
command printed a login URL and was interrupted without authorizing it; the guest remains
`NeedsLogin`, with no tailnet address. Unauthenticated enrollment preferences did not survive
the reboot, so repeat the hostname-bearing enrollment command and operator grant after rotation.

The qualification account invoked its allowed `sudo -n /sbin/shutdown -r now` over SSH through
the physical host. SSH became unavailable, then answered with a new guest boot identity
**11.39 seconds** after the reboot request (one-second polling with bounded SSH connection
attempts). The original Tart process remained running with the same PID, and the physical host
boot identity was unchanged: no Tart restart or host reboot was needed. Afterward the account
owned the console, its GUI launchd domain existed, Finder and Dock ran, and the Tailscale daemon
had restarted. This proves guest reboot and automatic-console-login mechanics only; it does not
prove tailnet reachability, gateway persistence, a full campaign, or host-boot VM supervision.

**Admission observation, later on 2026-10-02:** After credential rotation the guest joined the
tailnet as a user-owned node with its own Serve-capable name; direct key-only SSH and the five
sudo grants were proven from both the workstation and the operator account. `sysadminctl
-autologin set` cannot complete from SSH on this macOS (it records the user but leaves the
automatic-login credential stale, so the next boot stops at the login window); automatic login
for both the physical operator account and the guest qualification account was configured with a
founder-run script that verifies the password and writes the credential file directly. VM
ownership moved to the operator account with a KeepAlive Aqua LaunchAgent; a physical-host reboot
returned the operator console, started the guest unattended, and the guest rejoined the tailnet
within about two minutes, satisfying the keychain prerequisite above. A guest reboot then produced
the three verdicts the strengthened Mac lane requires. The standalone host lanes installed the
current stable release in the guest (doctor 18/18, identity lane clean), the OMP Sessions WebAPK
was installed for the guest origin, and the stable preflight reported `preflight-passed` from the
operator account with `OMP_STABLE_MAC_MODEL=VirtualMac2,1`. The only code change needed was the
Push lane's handset-model pin (#350). No campaign has run against the guest yet; the ledger rows
above remain bare-metal until a signed candidate passes with the guest named.

Tart 2.40.1 is maintained by OpenAI and distributed under the Fair Source
[Functional Source License 1.1, Apache-2.0 future license](https://github.com/openai/tart/blob/main/LICENSE)
(`FSL-1.1-ALv2`), not an unrestricted open-source license at publication. Its permitted purposes
explicitly include internal use; competing commercial virtualization offerings are restricted. Each
version becomes additionally available under Apache-2.0 on its second anniversary. This internal
qualification use does not bundle Tart into the gateway or change the gateway license.

**Consequences:** Guest reboot no longer interrupts sibling lanes or physical-host workers. Host
outage still interrupts all guests and the operator; this is isolation of campaign reboots, not high
availability. The retained guest consumes host memory and disk and must not be run concurrently by
two owners. Qualification now distinguishes physical and virtual Mac environments explicitly, while
ADR-030's supported platform families and evidence vocabulary otherwise remain unchanged. The new
target remains unqualified until a full signed-candidate campaign passes on it.

## ADR-034 — Request-started releases with one founder promotion decision

**Status:** Accepted — 2026-10-07

**Decision:** A green manually dispatched stock-OMP canary opens or reuses the exact bot-authored
tracking issue. Its title, not its body, selects the upstream version. Carrythrough supplies a
draft source PR restricted to the seven ORDER_SCOPE paths; the Studio release driver lands it
only with the complete required-check set and a pinned squash merge. Equal-baseline requests
are fixes-only releases and need no source order.

The release machine account signs tags and makes all automated writes with an isolated gh config.
Deterministic generators own release-specific text and version edits; workflows are no longer
per-release editing surfaces. The driver qualifies the signed candidate and checks the generated
approve tree locally. Only a merge by the founder with that exact tree permits stable signing.
Published-byte verification, rebuilt-digest equality, smoke with rebuilt stock OMP, and a recorded
PR complete the release. Slack receives read-only status, never a write token or approval control.

**Recovery:** Atomic state, a comment outbox and deterministic external identities reconcile
crashes without repeating accepted PR/tag/comment writes. Detached long steps retain the existing
release-host lease. A failed campaign stops without retry; a new green request after a main fix
uses the next prealpha only after the old owner is recovered. No automatic rollback, tag rewrite,
default-branch push, lease stealing or discarded failed receipt is permitted.

**Consequences:** One founder approve-PR merge replaces repetitive manual release mechanics, not
qualification gates. The bot, Studio account and integrated main code remain trusted release
authorities; required checks and founder/tree equality constrain unintended promotion. The driver
is cooperative single-host automation, not protection from a compromised operator or GitHub admin.

**Amendment — 2026-10-09:** Request upstream refreshes weekly on Mondays at 15:17 UTC, resolving
npm `latest` to an exact version. Scheduled runs skip successfully when the lock already equals
or exceeds that version or any open, non-PR, bot-authored `Upstream tracking: vX.Y.Z` issue exists,
and re-check that open-request guard immediately before filing after the canary. Manual dispatch
and equal-baseline fixes-only requests are unchanged. A separate issue-read-only post-canary gate
skips the unchanged filing job on a late duplicate, so the driver cannot renew that request. Issue-write jobs
still execute no repository or upstream code; the existing promotion and qualification gates remain.

See [Unattended release driver](RELEASE.md#unattended-release-driver) for installation and the
kill switch.
