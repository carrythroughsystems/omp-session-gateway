# Security design and threat model

This document is for operators, contributors, and auditors reviewing the threat model, trust
boundaries, and security invariants of OMP Session Gateway. For installation, Tailscale Serve
setup, and lost-phone recovery, see [Operations](OPERATIONS.md). To report a vulnerability
privately, follow the [security policy](../SECURITY.md).

## 1. Security objective

OMP Session Gateway safely brokers existing OMP collaboration bearer capabilities from local OMP processes to one authorized mobile user without persisting or broadly exposing those capabilities.

The project reduces manual secret handling; it does not make an OMP collaboration capability less powerful. A full-control link can read and steer a session, and a view-only link can read sensitive transcript/tool activity.

Stock OMP `>= 18.1.20` supplies the native collaboration controller and local registry. No fork,
custom OMP build, or gateway-specific OMP plugin is required. The separately installed gateway
reads metadata and brokers one capability per authorized launch; native integration does not
remove the TUN-mode Tailscale Serve, allowlist, or user-controlled-workstation requirements below.

## 2. Assets

Highest-value assets:

- full-control collaboration capabilities;
- view-only collaboration capabilities;
- transcript/tool/subagent data reachable through those capabilities;
- session metadata such as project names, models, activity timing, and whether human input is required;
- per-host OMP query tokens and the gateway-only readiness token;
- tailnet and WebAuthn identity material;
- private VAPID key material and browser push subscription endpoints/keys;
- release-signing and update infrastructure.

## 3. Threat model

### In scope

- public-Internet scanning and accidental public exposure;
- other devices/users on the LAN;
- unauthorized users or devices in the tailnet;
- cross-site requests and malicious web origins;
- accidental secret persistence in logs, traces, metrics, caches, history, browser storage, screenshots, crash reports, source-map services, or diagnostics;
- stale capability use after an OMP process exits, crashes, stops collaboration, or changes session;
- a lost or temporarily unlocked phone that remains authorized in the tailnet;
- malicious or malformed IPC/API input and resource exhaustion;
- dependency, build, installer, and update compromise;
- a relay operator observing permitted metadata and ciphertext.

### Out of scope or inherited compromise

- code already executing as the same desktop OS user;
- a compromised OMP process, desktop kernel, browser engine, Android OS, identity provider, or Tailscale control plane;
- a user intentionally sharing a collaboration link;
- OMP model/provider behavior and tool authorization on the host;
- forensic recovery from process memory or swap after full local compromise.

Document these limits plainly. Do not market the project as protection against same-user malware.

## 4. Network exposure

Required default:

- `omp-gatewayd` binds only to loopback;
- Tailscale Serve provides tailnet HTTPS and strips spoofed incoming identity headers before adding trusted ones;
- tailnet grants restrict HTTPS access to the intended user/device posture;
- the application independently allowlists exact login names;
- missing identity fails closed;
- Tailscale Funnel and public reverse tunnels are not configured;
- plain LAN HTTP is unsupported.

Keep the backend on localhost because another remotely reachable path would let callers inject
`Tailscale-User-*` headers themselves. Direct loopback requests cannot be distinguished
cryptographically from Serve-originated requests, so every untrusted process or OS account able
to run on the desktop host is outside the v1 HTTP trust boundary. V1 is for a user-controlled
workstation without mutually untrusted local accounts; do not deploy it on a shared shell host.
OMP’s private discovery files and endpoints restrict per-host queries to their OS-user boundary.
The gateway-only readiness token proves managed-install readiness; neither credential authenticates
browser API requests.

Concretely, and stated as an operator rule because the reasoning above is easy to read as advisory:
**never point any other forwarder at the gateway's loopback port.** A tunnel, reverse proxy, port
forward, container publish, or SSH `-L` that terminates remote traffic and relays it to
`127.0.0.1:<port>` presents a loopback peer, which satisfies the first authorization check in
`apps/gateway/src/auth.ts`, and then forwards whatever `Tailscale-User-Login` the remote caller
chose. That is not a weakened boundary but a complete authentication bypass: any client reaching the
forwarder can name an allowlisted login and receive the session directory and live view and control
capabilities. Tailscale Serve is safe here only because it overwrites caller-supplied identity
headers; nothing else in this design does. A future non-Serve path therefore requires its own
authenticator plus unconditional stripping of `Tailscale-User-*`, not merely a transport swap. See
[#74](https://github.com/alphastorm/omp-session-gateway/issues/74) and
[#158](https://github.com/alphastorm/omp-session-gateway/issues/158) for worked examples of
proposals that fail on exactly this point.

**The listener now refuses requests that carry evidence of a second HTTP hop,** so the most likely
version of that mistake fails closed instead of silently granting control. An HTTP proxy leaves
marks that Serve never produces, and a remote caller cannot instruct the proxy in front of it to
stop inserting them. Measured against Serve's own proxy (`ipn/ipnlocal/serve.go`,
`addProxyForwardedHeaders` and `addTailscaleIdentityHeaders`), a Serve-originated request carries
`X-Forwarded-For` set to exactly one address — the tailnet source — and `X-Forwarded-Host` set to
the host Serve answered on, and Serve deletes every inbound `Tailscale-*` header before setting its
own. `authorizeHttpRequest` therefore refuses, before reading the identity header, when
`X-Forwarded-For` names more than one hop or a non-Tailscale address, when `X-Forwarded-Host`
disagrees with the configured public origin, when `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`,
`CF-Ray`, or `X-Forwarded-Server` is present, or when the request is marked as Funnel.

**This is defence in depth and explicitly not authentication.** It catches Cloudflare Tunnel,
ngrok, and ordinary reverse proxies, which all insert at least one of those headers. It does not
catch a raw TCP forwarder — `socat`, `ssh -L`, a bare tunnel — which inserts nothing and remains
indistinguishable from Serve, and it does not make the operator rule above optional. Only an
authenticator the gateway can verify itself closes that gap. The mode dispatch in
`authorizeHttpRequest` is exhaustive for the same reason: a future auth mode denies until it is
given an explicit arm, rather than inheriting Tailscale header trust by omission.

**Tailscale's own userspace-networking mode is such a forwarder, and this is the trap most likely to
catch a real operator.** `tailscaled --tun=userspace-networking` has no TUN device, so its netstack
accepts inbound tailnet connections and dials `localhost` to service them. The gateway then sees a
genuine loopback peer for traffic that originated on another machine, and trusts the caller's
`Tailscale-User-Login` verbatim. Serve is not in that path and cannot overwrite anything.

On a host running userspace-mode `tailscaled` with its listener bound to `127.0.0.1:4317` only, a
probe from a different tailnet node to `http://<node-tailnet-ip>:4317/api/v1/sessions` reaches the
loopback listener directly and can supply a forged `Tailscale-User-Login` header unless the gateway
verifies the host's tailnet interface. On a host running the normal TUN-mode client, direct probes
to the gateway port on tailnet and LAN addresses are refused outright.

Userspace mode is not exotic: it is the usual way to run Tailscale in a container, on many VPS
images, and on headless servers, which are exactly the hosts an operator is most likely to automate.
Run the TUN-mode client on any host serving this gateway. Tracked as
[#98](https://github.com/alphastorm/omp-session-gateway/issues/98).

**The gateway now refuses rather than warns.** Because Tailscale gives the backend no secret,
signature, or channel binding that Serve alone could present, there is nothing to verify per
request; the only thing checkable is whether the topology still makes Serve the sole path in. In
`tailscale-serve` mode the daemon therefore reads the host's interface table and, unless an interface
looks like Tailscale's *tunnel device*, returns `403` to every request instead of believing
`Tailscale-User-Login`. It logs `http.identity_trust_unsound` once when it observes that state, and
`doctor` reports `loopbackTrustSound: false`. Refusing costs nothing when the signal is absent:
without a tailnet interface, Serve cannot be routing tailnet requests to that process anyway.

**`100.64.0.0/10` does not vouch for itself.** That range is not Tailscale's: RFC 6598 assigns it as
shared address space, and carriers, mobile hotspots and container networks allocate out of it
routinely, so a host holding a CGNAT lease would otherwise pass this check while running userspace
mode — a container with a CGNAT pod CIDR being the obvious case, and containers being exactly where
userspace networking is used. Accepted instead are an address in `fd7a:115c:a1e0::/48`, which is
Tailscale's own allocation and decisive on its own, or a `100.64.0.0/10` **host route** on a
tunnel-named interface (`tailscale0`, `utun<n>`, `Tailscale`). An IPv6-disabled host whose device is
renamed through `--tun` fails closed and visibly, which is the safe direction for that error.

An admitted `/api/v1/events` stream is re-authorized on each keepalive, so a feed cannot outlive the
topology that justified it.

The signal has to be read in that direction. Probing our own tailnet address cannot tell the two
topologies apart, because in userspace mode the host has no route to that address either, so the
probe fails identically on a safe host and an exposed one. Detecting *whether tailscaled is running*
is no better: its socket path is platform-specific and can be overridden on the command line, so a
detection miss would silently re-open the bypass. Absence of a tailnet interface is therefore treated
as unsafe rather than inconclusive.

One escape exists for automated harnesses, `auth.trustIdentityWithoutTailnetDevice`. It declares that
no tailnet can reach the host at all, which is true of a CI runner with no Tailscale installed and is
how the capacity job exercises the production identity path. It asserts a fact rather than
establishing one: setting it on a host running userspace-mode `tailscaled` restores the full bypass.
`doctor` reports `loopbackTrustSound` from the interface table and not from the configuration, so a
host that sets the flag while running userspace mode still fails that check. Never set it on a host
that has Tailscale installed.

A host that sets the flag also **cannot roll back** to an earlier gateway without editing its
configuration, because the older parser rejects unknown `auth` keys and refuses to start.

**If a pre-fix build ever ran on a userspace-mode host, treat what it accepted as compromised.**
Refusing new requests does not retract what the exposed window granted. Push subscriptions are the
persistent case: delivery re-checks the stored identity against the current allowlist on every send,
so removing a login stops delivery, but a subscription registered under a *forged allowlisted* login
is indistinguishable from a legitimate one. Delete `push-state.json` from the state directory and
re-enable notifications from the phone. Collaboration capabilities need no such step because they are
never persisted and die with their generation.

A second tailnet node remains the only *end-to-end* proof, because the refusal above is a local
inference about the topology rather than an observation of what a remote peer can reach; the
qualification lanes probe the gateway port from a distinct node for that reason.

According to [Tailscale Serve’s identity contract](https://tailscale.com/kb/1312/serve#identity-headers),
user identity headers are populated for user-owned source devices, not tagged source devices.
The gateway trusts `Tailscale-User-Login` only on its loopback backend behind Serve and compares
the normalized login against an exact application allowlist. Keep the Android phone user-owned;
a tagged destination gateway is distinct from a tagged source phone. The latter is denied even
when network policy permits its connection. Do not weaken authentication or treat Tailscale app
capabilities as an implemented alternative. See the
[deployment dependency matrix](COMPATIBILITY.md#deployment-dependency-matrix).

### Tailnet controls are separate from application authorization

The [operator procedure](OPERATIONS.md#6-tailnet-access-policy) covers the gateway node and phone
separately. All controls below retain the exact login allowlist, loopback/TUN-mode boundary, and
Serve-only tailnet HTTPS path; none permits Funnel or another forwarder. In particular, the
gateway does **not** read or enforce device posture.

| Control | Protection and failure mode | What it does not replace |
|---|---|---|
| [Grants / legacy ACLs](https://tailscale.com/docs/reference/grants-vs-acls) | Scope the phone’s user to the gateway tag and HTTPS port; restrict gateway-originated access separately. [Grants are additive](https://tailscale.com/docs/reference/syntax/grants), so broader overlapping access defeats a narrow rule. | Network permission is not gateway authorization. A user selector is not a unique-phone selector, and a tag owner is not automatically an authorized application user. |
| [Device approval](https://tailscale.com/kb/1099/device-approval) | Review device admission; pending devices cannot send or receive tailnet traffic. Pre-approved keys can skip manual review, and approval applies to the device rather than each user/node on shared hardware. | Not ongoing compliance, current user verification, or the application allowlist. |
| [Node key expiry](https://tailscale.com/kb/1028/key-expiry) | Forces periodic reauthentication when enabled; expiration breaks endpoint connectivity, even if the gateway daemon remains healthy. Tagged devices start with expiry disabled on first tagged authentication; operators must check the actual setting. | Not immediate lost-phone revocation or the application allowlist. Disabling expiry trades away that periodic boundary for availability. |
| [Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock) | Peers require trusted signatures on node keys; an unsigned phone/gateway stays locked out. Compromised signers and lost recovery secrets are separate custody risks. | Not device health, the application allowlist, or protection from a compromised signed phone. **Device approval and Tailnet Lock are currently mutually exclusive**, not cumulative controls. |
| [Device posture](https://tailscale.com/kb/1288/device-posture) | `postures` plus a grant’s `srcPosture` constrain source devices using reported attributes. Nonmatching or required-but-unset attributes prevent that posture matching; another unrestricted rule can still allow access. | Not destination/gateway attestation, hardware identity, whole-device security, or the application allowlist. Tailscale’s documented shared-node/subnet-source exceptions mean posture must not be assumed across those paths. |

Keep signing authority and disablement secrets under separate, documented custody; an Android
phone can be signed by a trusted desktop but cannot itself serve as a signing node under the
current [Tailnet Lock limitations](https://tailscale.com/kb/1226/tailnet-lock#limitations). Validate
merged policy in the admin console’s
[policy preview](https://tailscale.com/docs/features/tailnet-policy-file/manage-tailnet-policies#preview-changes),
then exercise allowed and denied devices. Preview and `doctor` are not independent proof of every
tailnet control. Revoking tailnet access does not retract an already-issued bearer capability or
terminate an established OMP relay session; follow the
[lost-phone procedure](OPERATIONS.md#10-lost-phone-and-revocation) to rotate host capabilities.

Background notifications add outbound HTTPS from the gateway to browser-provided push endpoints.
No inbound public gateway route is required. Web Push encrypts the payload for the browser
subscription, while the push service still observes the endpoint, source IP, size, and delivery
timing (including activity-stop timing). Messages carry no Web Push `Topic`, so the push service
receives no per-session identifier. Private notification detail does not hide this traffic
metadata. Treat subscription endpoints and keys as sensitive private state even though they cannot
grant collaboration access.

## 5. Relay exposure

OMP encrypts collaboration frames client-side. The relay can observe room identifiers, connection/routing metadata, participant counts, timing, and ciphertext sizes, but should not receive plaintext payloads or room keys.

The existing relay is acceptable for v1 when this metadata/availability dependency is understood. Self-hosting can reduce third-party exposure but introduces TLS, WebSocket, update, and availability responsibilities. Treat it as an explicit advanced mode and run long-lived connection tests through the exact deployment path.

Phone photos are prompt content, not gateway metadata. A writable client accepts only JPEG, PNG,
or WebP source files up to 24 MiB, rejects source dimensions above an 8,192px edge or 20 megapixels,
canvas-re-encodes at most four as JPEG with a 2,048px edge and 1 MiB per-image cap, and thereby
removes filenames, EXIF, and location metadata before transport.
Only the normalized bytes enter the existing encrypted `prompt.images` frame. They never traverse
gateway HTTP/IPC, the service worker, URLs, history, logs, diagnostics, analytics, or browser
storage. Preview data URLs and base64 references are dropped on remove, host-confirmed send, and
client disposal; an unconfirmed send retains the draft for retry. JavaScript memory is not claimed
to be zeroized. After send, the normalized image
is ordinary OMP prompt content and may persist in the host transcript and at the selected model
provider under those systems' normal retention policies. The original phone file is not uploaded.

The Photo action uses two hidden file inputs behind explicit user choices. **Take photo** adds the
browser `capture="environment"` hint; **Choose existing** omits `capture`. Native file-input
capture launches the operating-system camera UI and does not grant script-level camera access, so
the gateway keeps `Permissions-Policy: camera=()` and never invokes `getUserMedia`.


Speech input follows two distinct paths ([ADR-037](DECISIONS.md#adr-037--speech-input-keyboard-dictation-baseline-and-opt-in-browser-speech-recognition)):

- **OS keyboard dictation (default baseline):** handled by the operating-system keyboard outside page JavaScript and inserts text into the standard composer `<textarea>` (with composer help copy `"Use your keyboard's microphone key to dictate into this box. iPhone: Settings → General → Keyboard → Enable Dictation. Dictation never sends — tap Send when the text is right."`). Like the file-input camera path above, it needs no browser microphone grant, so the gateway keeps `Permissions-Policy: microphone=()` when `speech.browserRecognition` is `false`.
- **Opt-in in-page browser speech recognition (`speech.browserRecognition: true`):** unlike `<input type="file" capture="environment">`, browser Web Speech implementations (`SpeechRecognition` / `webkitSpeechRecognition`) require document-level `Permissions-Policy: microphone=(self)`. When `speech.browserRecognition` is `true`, only document HTML responses switch to `microphone=(self)` (keeping `camera=()` and all other directives unchanged), while API, SSE, problem, and static asset responses retain `microphone=()`. Because HTTP headers apply to the hosting document and cannot distinguish read-only **View** from writable **Control**, Control-only enforcement lives in the collaboration client (`browserRecognitionEnabled`, writable **Control** mode, and a healthy connection). Audio captured by in-page speech recognition is sent by the browser or OS to its speech provider **outside the encrypted OMP relay and before any prompt is sent**; no on-device processing claim is made, and the client displays the explicit disclosure `"Your browser or OS may send audio to its speech provider before any OMP prompt is sent."` before starting recognition. Recognizer configuration is bounded (`lang = navigator.language || "en-US"`, `continuous = true`, `interimResults = true`, one alternative, no auto-restart; watchdogs `10 s` start, `120 s` capture, `5 s` stop; review buffer capped at `128` segments, `8,000` code points, and `32 KiB`). No speech-to-text server, API key, or audio persistence exists in the gateway, and **Use text** inserts the reviewed draft into the composer without submitting (**Send** remains a separate explicit action). In a federated session, the home document's `speech.browserRecognition` setting is authoritative.
## 6. Capability handling

Mandatory rules:

- keep capabilities only in OMP process memory, transient gateway query/launch-response memory, and
  active browser client memory; the gateway never stores or caches them;
- keep the memory-only registry metadata-only, structurally separate from secret-bearing responses;
- never give capability-bearing objects generic serializers, inspectors, debug printers, or telemetry hooks;
- minimize query/response references and drop browser references on launch disposal;
- revalidate generation, access, and attention identity before releasing a queried capability;
- never pre-render, prefetch, preload, or include capabilities in HTML, SSE, manifests, or hydration data;
- release exactly one requested role through a no-store POST after an explicit user action;
- prefer in-memory client bootstrap; do not use a URL path, query, fragment, window name, DOM attribute, clipboard, cookie, Local Storage, IndexedDB, Cache Storage, service-worker message, BroadcastChannel, notification, or crash/error SDK;
- suppress access/body tracing for launch endpoints;
- disable third-party runtime scripts, analytics, telemetry, remote fonts, and source-map upload services;
- use generated canary capabilities for tests, never real user links.

The embedded `v18.12.6` client keeps the same capability boundary across coalesced renders.
Request trays use that same in-memory bootstrap and mount exactly one client. Expanding reparents
the existing shell; it neither fetches another capability nor creates another React root. Tray
descriptors, DOM attributes and history state never contain capability material. Native modal
close requests consume Back without tray history entries; only promotion replaces the route with
`/client/`. Closing disposes the client synchronously. The bfcache resume intent retains only the
metadata binding and full/tray presentation, then reacquires a fresh capability after revalidation.
Both one-shot and streaming-tail Markdown route links through the same browser-URL scheme
sanitizer; raw HTML stays escaped and KaTeX emits MathML with `trust: false`. Only pure
TypeScript parser sources are vendored, with no pi-utils/pi-natives runtime dependency.

`inputRequired` and optional boolean `busy` are the accepted host attention/activity signals.
Missing/null activity is unknown, never idle or completion. The gateway may
derive an opaque random request ID and receipt timestamp in memory for each false-to-true
transition, expose them in list/SSE and routing URLs, and destroy them on clear, removal, expiry, or
generation replacement. They are metadata, not authorization. Prompt text, options, answers, and
transcript content remain prohibited unless a later OMP snapshot contract explicitly introduces a
bounded plain-text preview contract; the current implementation always uses the boolean fallback.

The PWA may persist two bounded, non-secret local routing record types under `localStorage` keys
`omp.sessions.held-asks.v2` and `omp.sessions.dismissed.v2`: an exact source-qualified held ask
`(sourceId, sourceOrigin, instanceId, requestId, heldAt)`, and a generation-scoped dismissed session
`(sourceId, sourceOrigin, instanceId, generation, dismissedAt)` (migrating legacy v1 keys to the local
source and dropping unconfigured or re-pointed sources at bootstrap). It must reject malformed,
oversized, non-canonical, or excess records (100 items / 512,000 bytes max) and must never persist
the composite in-memory `SourceKey`, session labels, paths, models, prompt content, transcript
content, or capabilities. Holding does not change authoritative attention or badge counts. Dismissal
is only a reversible local hide of a non-attention row: it makes no network request and does not stop
OMP. Authoritative ask changes clear holds; removal, generation replacement, or attention clears
dismissals. Transport failures clear neither. A held ask on the local source may close only a home
notification with the matching instance tag and request ID; holding an ask on a remote fleet source
never enumerates or closes home notifications even when `instanceId` collides.
The separate first-run key `omp.sessions.first-run.v1` stores only
`{ version: 1, step: "alerts" | "modes" | "done", updatedAt: ISO }` (128 characters maximum).
It contains no host/session identifiers, labels, permissions or capabilities. Missing means fresh;
malformed, unsupported, oversized or inaccessible records suppress the introduction. The flow
reuses the existing notification opt-in control and never requests a capability or notification
permission merely by opening or advancing a step.
After an explicit permission/subscription action, the gateway may persist a user-only VAPID key
pair, bounded browser subscription set, authenticated identity, and per-device `private`,
`session`, or `preview` choice. It assembles encrypted push presentation at send time. `private`
uses the fixed title and no body; `session` may add bounded session/project labels; `preview` may
also add a bounded preview but falls back to `session` until such data is available. The UI must
warn that visible notification text can persist in notification history, screenshots, and
wearables. A tap hands the notification's metadata-only data to an open same-origin page over a
worker `MessageChannel`, or opens `/collab/:instanceId?request=:requestId` when no page accepts.
Either way the page fetches a current authenticated snapshot, requires the exact current attention
identity and Control availability, and then uses the existing generation-bound no-store launch
POST; the worker never navigates an open page. Activity-stop notification data
contains only version, type, instance ID, and generation. Its strict route is scrubbed before
networking and resolves only to View for that same generation after authentication; it carries no
request ID and cannot be used as an ask/Control intent. Stop detail obeys the same server-side
privacy choice, with no preview content. No activity state is persisted.
Never put a collaboration capability in a payload, notification data, route, history,
service-worker message, persisted push state, badge, or request identifier.
Web Push subscriptions, VAPID keys, notification tags, app badges, and service-worker tap routes remain strictly home-scoped to the originating gateway ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors)). Remote fleet targets never share push state or routes, and foreground remote counts never feed the home app badge.

JavaScript strings cannot be reliably zeroized. Minimize lifetime, copies, closures, global state, and persistence instead of claiming memory erasure.

### Opt-in creation and first-task drafts

[ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption) permits creation
only from administrator-authored IDs in `config.tern` resolving to approved canonical working
copies (`workingCopies[].path` equal to its `realpath`), absolute executables (`tern.executable`
and `profiles[].argv[0]`), literal `profiles[].argv` arrays, and a complete explicit CLI
environment (`profiles[].env`). The browser supplies none of those execution values. Never merge
the daemon's `process.env` or use a shell, task text, or labels as command input. Tern's pane
environment (`collab.autoStart = control` publishing into `omp.discoveryDir`) is a separate
operator prerequisite, not an assumed environment-forwarding mechanism.

**Creation is stronger trust than directory/launch access:** a target with `tern` configured
trusts every `http.trustedDashboardOrigins` entry's JavaScript to start processes from its
approved profiles using the caller's allowed Tailscale identity. Removing that trust prevents
further API requests, but does not cancel accepted work, kill a started OMP process, or revoke
an already-issued relay capability. Browser Close/abort stops watching only. Neither an
uncertain CLI result nor restart may trigger automatic re-spawn.

Creation options expose only IDs/labels and an opaque per-daemon revision; status exposes only
state/timestamp, closed errors, and an OMP instance/generation when ready. They carry no
capabilities or execution paths. The private owner-scoped ledger contains operation/request
IDs, normalized owner identity, timestamps, state, optional block ID and ready binding, and closed
errors, never labels, paths, argv/env, prompts, capabilities, raw CLI output, or session-file
paths. Its 64-record/24-hour/512-KiB bounds and durable-before-spawn checkpoints do not make it a
capability store. Corruption or failed private durable writes disable creation without deleting
evidence or affecting ordinary discovery/launch.

The optional First task (8,000 code points/32 KiB maximum) never enters a gateway request,
operation ledger, URL, log, diagnostic, notification, or browser storage. A volatile holder binds
it to the exact source/instance/generation. The client's `takeInitialPromptDraft` drains it once
only into an empty ordinary composer in live writable Control with a healthy relay, no active
Ask, and no photo draft/pending photo send; it never overwrites an existing draft or sends.
Cancel, changed binding, authorization loss, pagehide, or shell disposal clears the holder;
background suspension alone may retain the unsent draft in that page's suspended flow.
`localStorage` key `omp.sessions.creation-prefs.v1` may store at most eight source-qualified
choice records (`sourceId`, `sourceOrigin`, `projectId`, `workingCopyId`, `profileId`, `updatedAt`)
in a versioned 16-KiB record, validated against fresh options. It stores no labels, execution
values, draft text, operation IDs, client-operation IDs, or capabilities.

## 7. Browser controls

Representative response policy; adapt CSP hashes/nonces to the build and configured relay allowlist:

```http
Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' wss://my.omp.sh; manifest-src 'self'; worker-src 'self'
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()
```
Document HTML responses extend `connect-src` with each configured `fleet.targets[].origin` (`http.trustedDashboardOrigins` is never added to `connect-src`) and switch `Permissions-Policy` to `microphone=(self)` only when `speech.browserRecognition` is `true`. API, SSE, problem, and static asset responses always keep `connect-src 'self' wss://my.omp.sh` and `microphone=()`.

Additional requirements:

- exact `Origin` validation on `POST` and any future WebAuthn enrollment/assertion endpoints;
- validate `Sec-Fetch-Site` when supplied (`same-origin` on same-origin mutations; `same-site` or `cross-site` accepted on `POST /api/v1/sessions/:instanceId/launch` and `POST /api/v1/session-creations` **only** when the request `Origin` header is an exact match in `http.trustedDashboardOrigins` and `Content-Type` is exactly `application/json` — missing Fetch Metadata is never permission to skip exact `Origin` validation);
- no wildcard CORS and no `Access-Control-Allow-Credentials`;
- **federated dashboard origin exception ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors), extended by ADR-043):** when `http.trustedDashboardOrigins` is empty (default), no cross-origin API access is permitted. Any foreign non-admitted `Origin` on any `/api/` route except loopback `GET /api/v1/health` is refused with `403` before identity checks. An explicitly trusted dashboard may read metadata, request existing View/Control capabilities, and, when the target opts in, create from approved profiles under the viewer's own authorized Tailscale identity. Only `GET /api/v1/sessions`, `POST /api/v1/sessions/:instanceId/launch`, `GET /api/v1/session-creation-options`, `POST /api/v1/session-creations`, `GET /api/v1/session-creations/:operationId` (exact lowercase UUIDv4), and their authenticated `OPTIONS` preflights may emit `Access-Control-Allow-Origin: <exact origin>` and `Vary: Origin`; preflights consume no mutation rate-limit tokens. `/api/v1/events`, `/api/v1/push/*`, `/api/v1/client-config`, `/api/v1/health`, and static assets are never exposed cross-origin. Removing dashboard trust blocks further cross-origin API requests (and a readable `403` disposes the remote shell and shows `Access withdrawn`), but does not cancel accepted creation, kill a process, or revoke an already issued OMP relay capability;
- all metadata rendered as text, never unsanitized HTML;
- strip control/bidi characters or display them safely in titles/paths;
- cap label length and session count;
- service worker caches only explicitly listed, queryless, content-hashed static assets (the precached app shell plus the pinned collaboration-client module and stylesheet, and first-party-served Private Use Area font chunks cached lazily on first use — never a capability-bearing response) and explicitly bypasses cross-origin requests, `/api/`, `/internal/`, `/client/`, `/collab/`, `/update/`, navigation, query-bearing URLs, and all non-GET requests;
- text uses system/local fonts; the only bundled web font is a self-hosted Symbols Nerd Font Mono subset for Private Use Area glyphs, loaded from the gateway under the existing `default-src 'self'` policy with no remote font requests;
- service worker Push handling accepts exact `attention`/`clear`/`activity_stop` envelopes, uses one per-instance tag, updates only the bounded app badge count, and never fetches or receives a collaboration capability;
- transient directory transport failure retains the last authenticated metadata only in volatile page memory, marks it stale with the last-fresh timestamp, and disables no actions solely because SSE disconnected; authorization failure clears it;
- no capability in Redux/React Query persistence, devtools globals, error boundaries, replay tools, performance marks, history state, or directory snapshots;
- external links use `rel="noopener noreferrer"`;
- production builds disable framework devtools hooks where practical;
- reload returns to the metadata directory.
- an activated shell update never navigates a client; the page reloads itself only while no launch is pending, no routed notification awaits its snapshot, and no collaboration client is mounted (ADR-018 amendment). An activation by an earlier worker, such as one restored by rollback, may still navigate a client to the no-store `/update/` bootstrap, which the new document synchronously scrubs to `/`.

If relay origins are configurable, generate `connect-src` only from administrator-controlled validated origins.

## 8. Tailnet authorization

In `auth.mode = "tailscale-serve"`:

1. require `Tailscale-User-Login`;
2. decode/normalize only according to documented header encoding rules;
3. compare against an exact configured allowlist;
4. reject wildcard defaults;
5. treat external users who accepted a device share as ordinary identities requiring explicit allowlisting;
6. optionally display the current identity without persisting it;
7. log only numeric or boolean fields, never identity strings or hashes;
8. maintain a separate `dev-localhost` mode that starts only with an explicit flag and accepts loopback clients only.

Tailnet grants and application allowlisting are both required defense layers. Future device-specific policy may use posture or Tailscale app capabilities, but must have tests and must not fall back to “any tailnet member.”

## 9. Local discovery and queries

Stock mainline OMP `>= 18.1.20` owns the discovery/query endpoint, introduced by [PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20).
The gateway is a reader and query client, not a publisher server. Required boundaries:

- read only private, current-user-owned discovery entries and endpoints; reject symlinks and
  unsafe ownership or permissions;
- use each entry’s endpoint and per-host query token, never a guessed socket path;
- bound newline-framed requests, responses, connection time, and discovery entries;
- never write, rename, or unlink OMP-owned files or sockets;
- fetch metadata with `snapshot`, capabilities only with an explicit generation-bound `link`;
- never log query tokens, raw replies, transport error strings, or capability-bearing parse errors;
- treat only `ENOENT`/`ECONNREFUSED` as conclusive host death; permission, timeout, resource,
  and wire failures retain existing metadata until TTL expiry;
- reject stale generations and unavailable roles rather than substituting a newer or stronger link.

A discovery token is not a collaboration capability, but permits querying that host for links and
therefore remains private. These controls reduce accidental and cross-user access; they are not a
sandbox against same-user malware. The gateway has no capability store, even in memory.

Opt-in Tern creation does not change these read-only discovery boundaries. It reads only bounded
`tern inspect --json` metadata, parses unsigned 64-bit numeric IDs losslessly, rejects remote host
tags at bit 56 or above, and requires one exact local block/pane match plus a unique fresh
OMP-native binding. `omp_session_file` is used only for an in-memory basename token match; never
open, stat, tail, or scrape that JSONL file. No focus/order/cwd/PID fallback, pane content,
`tsp.ts`, keystrokes, or native handoff is allowed. Control is reauthorized before `ready` and
again through the ordinary capability launch path.

Service installation and `doctor` do not trust a generic loopback health response. The daemon
returns an HMAC over a fresh 256-bit challenge using its private `readiness-token`; managed startup
also binds the HMAC to a one-time instance nonce written into the new service definition. The CLI
requires that exact nonce before activating the staged runtime, so an older same-token process
cannot satisfy replacement readiness. This token belongs only to gateway/CLI readiness and is
never provisioned to OMP. Token rotation validates the managed runtime first and never restores
the prior token after replacement; a failed restart retains the fresh token and stops the service.

Fork-era runtimes used a shared publication/readiness credential. Their recorded readiness and
rollback results are historical, not proof that a mainline cutover can be reversed by changing
only the gateway pointer; follow [UPGRADE_ROLLBACK.md](UPGRADE_ROLLBACK.md).

## 10. Lost phone and user presence

Minimum guidance:

- use Android device lock/biometrics;
- require strong identity-provider authentication for Tailscale;
- remove or expire a lost device promptly;
- keep tailnet grants narrow;
- persist no session capability in the PWA.

Proposed stronger Control protection (WebAuthn, not currently implemented):

Passkey enrollment and per-launch WebAuthn verification are not currently implemented. If added in
a future release, they must enforce the following contract and still do not replace device
revocation, screen lock, or tailnet policy:

- enroll a WebAuthn credential with user verification;
- require a fresh assertion for each Control launch or a very short verified window;
- bind challenge, operation, origin, instance, generation, and mode server-side;
- store only public credential material;
- never treat a successful View action as authorization for Control.

## 11. Logging, diagnostics, and test artifacts

Allowed at normal verbosity:

- fixed event names selected by the implementation, not data from a host or request;
- numeric protocol versions, generations, counts, and durations;
- boolean success/failure and health fields.

All gateway log fields are numeric or boolean. Never attach string-valued identifiers, hashes,
paths, error messages, metadata, or serialized query objects.

The stable qualification CLI's private stderr separately retains developer-authored Error messages
and stacks along cause/AggregateError edges. Readiness's private `browser-substep.json` retains the
failed browser step, error message, CDP method and elapsed time. Both use the repository's identifier
and capability rules to redact private identifiers and withhold capability-bearing lines, never
serialize arbitrary error properties, and never enter receipts, gateway logs or public artifacts.
Repeated/cyclic errors and traversal-limit exhaustion are marked explicitly rather than recursed.

Qualification explicitly supplies `--qualification-log-dir`; an environment variable alone never
enables daemon retention. Ordinary installations are unchanged. The sink accepts only closed event
names/fields, finite numbers and booleans (plus the fixed envelope timestamp/level/name), and retains
four files of at most 256 KiB. The existing absolute destination must be current-user-owned, mode
0700, with no symlink components; files are single-link, current-user-owned 0600 regular files.
Unsafe startup fails. Each synchronous burst durably invalidates the existing private health inode
before touching log data; its microtask commit flushes the bounded current file and commits the exact
event index and first retained index. Rotation flushes the file being moved; per-event appends do not require per-event fsync.
An interrupted or failed burst never publishes success. Writer startup and final collection acquire
the same exclusive private in-directory claim. The writer makes its claim durable before logging;
a failed close retains it even if a closed-looking lease write reached the cache and every health
invalidation fails. Graceful teardown drains admitted HTTP handlers (not just sockets) and every other
event producer, then fsyncs final health, closed lease and directory state. Claim unlink is the last
fallible close step. Restart and collection reject any held claim; abrupt death or a claim unlink
that did not survive a crash requires explicit reset, never automatic repair. Writes after close are
discarded with a bounded in-memory drop count, not thrown into a late handler. All state
stays inside the accepted service writable location. Restart and collection require
contiguous records in oldest-to-newest file order, beginning at index 1 unless the committed rotation
boundary explains the prefix. Missing/truncated retained files and record reordering are failures.
Rate-limited IPC events use the same closed vocabulary. Raw daemon
stdout/stderr remain discarded independently of structured retention, proven on the gateway's host.
Install/rollback/repair only forward the logging option to runtimes advertising `structured-v1`;
older installed runtimes omit it rather than receiving an unsupported command-line option.

Push events retain only numeric sequence and opaque request alias, kind flags, subscription counts,
durations, and HTTP status. Qualification-only aliases are allocated from the next retained-log append
index and mapped to exact session/generation/request tuples only in process memory. They are not
identity encodings, hashes, or keys, and retained append indices prevent reuse across daemon restarts
in the same job. The existing authenticated read-only session list exposes the optional
`qualificationPushAlias` only for the exact current ask; ordinary responses omit it. Before any re-arm,
the runtime re-fetches the owned fixture snapshot and requires its alias to match queue, send and
failure evidence. The matching outbound clear acknowledgement is required before issuing the new ask.
Immediately before transport, a fresh snapshot must still have the original instance and generation,
controllability, no active ask, and matching request/alias state. The existing private fixture
acknowledgement carries its OMP session ID into a guarded command; the extension checks that ID
synchronously before showing the ask. This detects a session switch, not a same-session host-generation
rotation between the runtime's check and the extension's mutation; the cross-process check is not atomic.
Provider acknowledgement is acceptance, not phone presentation. Collector windows use event indices
and one exact request alias; every queue's declared fan-out must have all sends acknowledged before
delivery telemetry is sufficient. Queue sequences must increase, and every send in a queue must start
before its first completion. Multiple acknowledged recipients are legitimate. Missing completions,
foreign aliases, rotation gaps and invalid telemetry never establish success by time proximity.
Retry authority remains narrower: only the existing single-send explicit retryable failure permits
re-arm; a partially acknowledged fan-out never does. Request identities remain volatile.
Subscription replay provenance is a required boolean on queue/send events; omission cannot mean a fresh
send. Subscription replays cannot authorize a fresh-ask retry. Radio
restoration closes the original window before reopening the WebAPK; post-restoration observation
uses a new window. Re-arm requires both phone clear and outbound clear acknowledgement.
A late post cannot satisfy a fresh ask: the existing worker must attest its exact request and the
authoritative snapshot must retain its generation.
Deadline expiry installs late-post sampling before returning a typed unexplained timeout; readiness
also samples restoration and retains any late delivery in its failure observations. Ask-metadata
waits install their sampler before waiting; only exhaustion of the metadata window is
`delivery_metadata_timeout`. Snapshot errors retain their original identity, and an expired execution
budget is `delivery_timeout`. Readiness starts its failure clock before mutation; even an error
normalizing failure evidence cannot skip restoration. Containment errors take precedence over an
expired delivery budget, including request attestation after a recovered delivery.
Late samplers remain armed through the old ask's clear settlement, are replaced for a fresh ask,
and are disarmed immediately on in-budget delivery or an ambiguous overlap retry.
Late-sampler failure is retained without skipping device restoration. Execution deadlines are
rechecked after asynchronous observations and before success, including readiness telemetry,
ownership and clear verification. Every persisted duration/count is a bounded safe integer;
monotonic durations are rounded before persistence. Readiness retains separate 160-second delivery
and clear windows. Ordinary, re-arm, overlap and Doze clear budgets start before their answer and
metadata work; entering the final phone observation never grants a new window.
Unacknowledged target creation remains unresolved after its bounded response route expires.
Target/forward cleanup failure blocks Pixel release with a harness root and causally linked
containment collateral, including failures inside network fallback and diagnostic paths; final task
restoration uses ADB without reopening CDP. Notification cleanup inspects both v1 and source-scoped
v2 Hold/Hide stores and does not treat malformed records as evidence of absence.
At most one evidence-backed fresh ask is allowed per phase, separate from overlap recovery; all
privacy assertions and the 60/160-second bounds remain unchanged. The forbidden-sink proof requires
both raw-stream discard and validated structured-log safety.
Per-phase `deliveryTimings` retains ordered first/second millisecond pairs for each delivery,
without overwriting earlier observations; the phase-wide one-re-arm budget remains independent.

Logs live outside fixture-cleanup directories. Reads bracket event files with health reads and retry
any changed or pending health/lease state; a torn snapshot never becomes evidence. After the daemon stops,
collection holds the exclusive claim while validating bounded records into private, exclusively-created immutable job files and
lane/phase slices, fsyncs the files and their directory, and rechecks the retained health state before
atomically retiring the remote directory. Only the retired directory is unlinked; startup refuses
claimed/retired destinations. Failed validation or retention leaves remote evidence and its claim
intact; a deletion failure leaves the remaining evidence in the retired directory.
No raw errors, endpoints, real identifiers or identifier hashes, notification text, payloads, capabilities,
tokens, or provider bodies are retained in these artifacts.

Forbidden:

- capabilities or substrings;
- request/response bodies for launch endpoints;
- authorization or identity headers;
- per-host query tokens or the readiness token;
- transcript, prompt, tool, or subagent content;
- full filesystem paths by default;
- browser network traces containing secret responses;
- screenshots while a canary capability is visible;
- unredacted tailnet names and identities in public bundles.

Creation adds no logging exception: request payloads, operation/owner identifiers, labels,
executable and working-copy paths, argv/env, raw Tern stdout/stderr or inspection output, and
`omp_session_file` never enter logs or public errors. Diagnostics exclude the creation ledger,
creation request payloads, argv/env, and raw CLI/inspection output; never add the ledger to a
support archive. Snapshot progress publishes counters only, not transcript content.

Test infrastructure must fail when a known canary appears in logs, files, Playwright traces, HARs, screenshots, video, browser history, DOM snapshots, caches, storage, service-worker state, or diagnostics archives.
Tern, multi-host fleet, and speech test fixtures or qualification notes follow the same leak rules: never record a literal 43-character base64url token, a 64-hex discovery token, a collaboration capability, a real `*.ts.net` tailnet hostname (use `<name>.example.ts.net`), a public IPv4 address, or a `/Users/<name>` path.

### Percy visual upload boundary and Live

Percy is a test-only third-party sink for authored synthetic DOM and first-party build resources,
never a production gateway or real OMP session. Synthetic View/Control canaries still count as
forbidden material. `DashboardFixture.assertNoCapabilityMaterial` closes over full capabilities,
room ID and encoded key, every contiguous 16-character segment, and URL/JSON/HTML-escaped forms;
none is exposed as a fixture property. The installed `@percy/dom` serializer runs with the SDK's
same options. Its full HTML (including hidden attributes, current form values, inline styles and
text) and every resource, including decoded bytes, must pass that guard plus the capability and
identifier scanners. The SDK's exact last-mile POST is checked again. A finding fails; it is not
redacted away. Errors, reporter output and SDK diagnostics never repeat the input or match.

Discovery is restricted to the loopback fixture host, uses Playwright's installed Chromium, and
keeps JavaScript rendering disabled. Source requests cannot leave the fixture origin; unreviewed
embedded/executable and resource surfaces fail. There is no live relay or production gateway
connection. Local mode starts no Percy and strips all Percy credentials. Eligible upload mode
requires a healthy Percy server, exactly 21 submissions and successful build finalization.
Forks and every gateway-ci dispatch receive no token and explicitly report not uploaded.
No traces, screenshots, videos, raw diagnostics or Percy output enter CI artifacts. Local CLI
logs stay in memory, but Percy redacts and uploads its **CLI logs with each build**. Setting
`PERCY_CLIENT_ERROR_LOGS=false` disables the separate **CI-log** upload only, not CLI logs.
Vendor redaction is not the capability boundary: structured log metadata is scanned too.
Before the real upload starts, upload mode runs the identical 21-case suite against a native-Node
Percy testing host with real asset discovery and no vendor effects. A private local pipe supplies
one distinctive ephemeral authority to those fixtures; its guard stays in host memory. After all 21
submissions, the host reads the testing server's logger records, selects non-`ci` entries and
applies the pinned CLI redactor exactly as `sendBuildLogs` does. The resulting `clilogs` candidate
must pass that fixture's full/segment/escape guard plus the capability and identifier scanners.
A planted SDK-log canary must fail the same scan without repeating it. The audit has a five-minute
deadline, passes no real token, and never calls `sendBuildLogs`; local mode remains Percy-free.
Only closed-set phase/reason codes and bounded counts may pass through nested process output.
The CLI runs under native Node (exactly pinned in CI); the Bun worker requires a responsive API
and active build before a snapshot can be submitted.

Live is restricted to manual, capability-free synthetic fixtures only. Never point it at a
production gateway or forward a loopback/tailnet service to it. This lane authorizes no Live
tunnel, real-session access or candidate qualification. See [ADR-035](DECISIONS.md#adr-035--advisory-percy-review-of-capability-free-serialized-fixtures)
and the [maintainer runbook](BROWSERSTACK.md).

### Real-device cloud qualification

Cloud-device qualification opens View and Control on TestingBot's real devices, so a vendor-operated
phone briefly holds a live capability. Only isolated qualification sessions on a candidate gateway
are opened there: the qualification live OMP session and the lane's own fixture, both with a
synthetic model key and no user data, and both revoked when the run stops them. The boundary:

- TestingBot's tunnel fetches whatever its devices request from the machine it runs on. Run as
  shipped, it would reach that machine's loopback, where a gateway trusts identity headers, its LAN,
  and every tailnet service its login may open, including an operator's own production gateway. The
  lane therefore runs the tunnel with `--noproxy` and serves the tunnel's local proxy itself. That
  proxy opens CONNECT tunnels only to the candidate origin and the sources the candidate's
  `connect-src` names, and refuses everything else, plain HTTP included. It relays TLS without
  decrypting it, so the vendor sees the tailnet hostname and traffic sizes, not content. The lane
  closes the proxy and stops the tunnel before it releases the Pixel lease, so this path exists only
  while its devices run.
- Stock tunnel 4.9 also opens a Selenium relay and a metrics server on every interface, and the relay
  lends the TestingBot account to any unauthenticated caller that can reach it. The lane asks for
  port -1 for both, so neither opens, and stops any tunnel that listens anywhere but loopback or
  fails to start, before going on.
- Sessions request no video, screenshots, or device logs, and are not public. The lane does not
  rely on log-disable requests to prevent vendor retention, so page evaluations return only counts,
  booleans, and fixed names, and a failed evaluation only its error's name. The in-page sink sweep
  keeps the capability inside the page and returns no digest, length, matched detail, address, or
  cache or database name. Control residuals, missing-target labels, arbitrary payload keys and raw
  headers are also excluded: vendor-safe results contain bounded counts, booleans, closed codes,
  and `LEAK_SINKS` names only. Allocation user agents/client hints are parsed in-page into constrained
  family, browser, hardware-code and version fields, and attestation precedes any capability open.
- Evidence text comes only from fixed grammars (a pinned model, a version number, Apple's push
  service), so neither a device nor TestingBot can write a link or a reflected credential into a
  receipt.
- After the sessions end, the lane fetches every test record TestingBot kept for the attempt, and
  fails if one contains either session's live View or Control link, or any contiguous 16-character
  window of one, or kept video or screenshots. Interior and delimiter-crossing windows count,
  not only delimiter-separated parts. This audit also covers partial/failed attempts: every known
  session is ended first and every retained record is inspected before fixture/tunnel/workspace
  release. An audit or cleanup error combined with device availability is diagnostic, never a hold.
  The links and windows exist only in orchestrator memory; only record counts and verdicts persist,
  never matched text, windows, digests or lengths.
  Every declared retained surface is scanned as bounded raw bytes as well as canonical JSON:
  the shared strict parser rejects duplicate object keys at every depth before references are
  discovered, and JSON escape forms are also covered. Plaintext logs remain raw-only and never
  supply references; malformed JSON-declared logs fail closed. The test
  detail, asset inventory, and declared log/HAR/performance references share one raw-byte budget.
  Signed log reads forward no account authorization, refuse redirects and unreviewed HTTPS
  origins/buckets, and fail if any declared surface cannot be inspected. A log-disable request
  and an empty inventory do not prove anything about unobservable vendor-internal retention.
- The page compares its loaded application asset with the expected archive asset and returns
  only a boolean, never a page-controlled pathname, in vendor-logged evaluation results.
- Each target's sessions end before the next allocation. Any cloud release failure, including
  a restoration checkpoint failure, marks the result `pixelUnrestored` through aggregate errors;
  the existing Pixel-lease guard refuses queued device work until cleanup recovery.
- TestingBot credentials are supplied only through child-process environment variables and in-memory
  request headers, never command-line arguments, receipts, or logs.
- BrowserStack is a fixed fallback for iPad Safari and Samsung Chrome only, never iPhone. Selection
  occurs only on a valid empty TestingBot eligible pool, before a primary write; failures cannot
  trigger vendor switching. Vendor-qualified ownership prevents colliding IDs from deleting or
  auditing the wrong account's session, and an ambiguous create remains dirty.
- BrowserStack Local 8.9 uses the pinned Darwin x64 artifact under Rosetta, force-local, exact host
  inclusion and force-proxy through the same loopback CONNECT proxy. Include/exclude filters cover
  all ports and do not replace the proxy's exact authority check. Local's listeners must be
  loopback-only; cleanup closes the proxy first, then stops only processes with the exact pinned
  executable and unique attempt working directory, including respawned children. Both paths are
  realpath-resolved; process enumeration never depends on argv or a `BrowserStackLocal` title.
  Private 0600 PID/birth identities and parent lineage retain ownership of retitled descendants;
  exact executable/cwd finds orphaned children and birth checks reject reused PIDs. A missing
  never-created directory is releasable only when a process snapshot proves no matching executable
  lineage; ambiguous ownership fails closed. Binary/directory preparation precedes tunnel intent.
- **Explicit argv exception, single-user orchestrator only:** the lane never places the BrowserStack
  key in argv, URLs, receipts or logs. It creates only a 0600 key config in the attempt's owned 0700
  directory and supplies `--config-file`. The pinned vendor binary expands the key into its child's
  argv; same-user processes already can read the 1Password service-account token. This is accepted
  exposure, not argv secrecy. Prefer a dedicated BrowserStack team-member key (the plan permits
  unlimited users), and rotate on suspected exposure. Local stdout/stderr are discarded and its
  readiness log is a private FIFO, not an evidence file. Stop and crash recovery remove both files.
- BrowserStack's mandatory text logs, session JSON and every known log/media surface receive the
  same bounded raw-plus-canonical and exact-16 audit, including partial failures. Signed artifact
  references come only from JSON parsed by the shared duplicate-key-rejecting parser. JSON logs
  use it too; ordinary plaintext logs remain raw-only and never supply references. Signed artifact
  requests carry no account authorization, refuse redirects and unreviewed origins. No recording
  setting proves vendor-internal absence. Video disabled plus clean indicators and the observed
  missing-object S3 403 is accepted as no retained media observed; media returning 200 fails.
  Media detection rejects nonempty screenshot/video/visual fields, including opaque failed-command
  screenshot payloads, not just familiar media URLs. Only null, false, empty-string and empty-list
  markers are treated as disabled; dashboard `video_url` is an audited indicator, never a fetch target.
  Only an entire JSON string value that is one well-formed absolute HTTP(S) URL is a reference:
  one case-insensitive `://`, its hostname appearing exactly once, and no comma.
  Keys are never references; any key or non-reference value containing `://` or a pinned artifact,
  dashboard or documentation hostname, case-insensitively, fails closed rather than extracting or repairing URLs.
  Before accepting any retained JSON body, a census independently counts every pinned
  artifact/dashboard hostname in raw text and strict canonical JSON; each count must equal its accepted reference occurrences,
  including duplicates, or fail with `unaccounted BrowserStack artifact reference`.
  The census also covers canonical text percent-decoded to a fixpoint within four passes (malformed
  escapes stay literal; excess depth fails closed) and requires one decoded `://` per reference.
  `browserstack-pins.json` defines disjoint origin sets:
  reviewed API/S3 artifact-storage origins are fetched, scanned, privately inventoried and
  absence-verified; dashboard presentations are counted but never fetched/followed.
  Capability-free BrowserStack probes on 2026-10-20 pin top-level `browser_url`, `public_url`, `logs`
  and `video_url` to exact record-bound dashboard paths and query grammars (no userinfo, ports or fragments), and accept only
  `insights.summary.time_breakdown.{browserstack_time,user_time,capabilities_impact}.optimize_url`
  links under `/docs/` on the separately pinned documentation origin (no query; optional safe fragment), never fetched or included in the artifact census.
  A dashboard presentation's content is the already-audited session record, whose API deletion proves removal.
  Any other origin anywhere, or a dashboard-host URL embedded in longer text or in another field,
  fails closed. Duplicate references retain the same inventory and media-classification checks.
  A reference received before finalized build identification is an `unbound retained reference`:
  persist an incident and fail closed, never queue volatile references for later discovery.
  Clean later metadata still permits deletion and absence checks, but cannot clear that incident;
  fresh cleanup after a crash also remains blocked until operator incident handling.
  Any artifact object (origin plus pathname) first declared after the audit, including pre-DELETE reads, atomically
  checkpoints its inventory and a `post-audit retained reference` incident while deletion/absence
  verification continues without late auditing; keys use the value media classifier and any
  case-insensitive `data:` or media-pattern key fails closed.
  Post-audit schema, census or body-validation failures atomically checkpoint a `post-audit
  unvalidated record` incident and individually validated pinned-origin whole-value URLs recovered
  from strict JSON, then continue DELETE and bounded absence checks rather than accepting the
  body or inferring references from malformed JSON; checkpoint failures themselves still halt.
  A missing artifact inventory blocks restoration only after record/all-log absence verification,
  while XML/text artifact errors remain raw-scanned and hostname-censused rather than JSON-parsed
  unless declared JSON, preserving clean 404 and the reviewed media-403 absence evidence.
  DELETE acknowledgement, 404 on session JSON and all six log APIs, and absence of **every declared
  artifact object** are required before removal/restoration, including references returning 404 at
  the first audit. The observed missing-object S3 403 remains the reviewed media-absence response.
  Text-log media keys include nonempty objects/arrays and `http(s):`, `data:` or reviewed
  base64-prefixed strings, and raw `iVBORw0KGgo`, `/9j/`, `R0lGOD` or `UklGR` runs followed by at
  least 64 base64 characters count as media; re-signed objects retain origin/path identity and the
  latest private URL without clearing
  incidents, and installed-shell timeouts and completed incident removals use closed-code,
  stage-accurate diagnostics rather than page strings.
  When present, artifact queries require `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`,
  `X-Amz-Expires`, `X-Amz-SignedHeaders` and `X-Amz-Signature` exactly once with only
  `response-content-type` optional, every BrowserStack record-audit failure persists an incident
  without broadening trusted error causes, and conflicting WebDriver session identifiers are
  unidentified regardless of capabilities shape.
  Finalized `video_url` must match the session-bound dashboard video presentation before any media
  exclusion, and text-body media keys accept bare/single/double-quoted names with `:` or `=` only
  for nonempty containers or quoted/unquoted media-prefixed strings, never quoted placeholders
  such as `"[REDACTED]"`.
  Every running/finalized session read is media-classified with no running `video_url` exemption,
  and bodies not declared image/video receive bounded-byte PNG/JPEG/GIF/WebP/MP4/WebM/plausible-BMP
  signature checks before decoding and the existing memory-only text scans, while declared media
  still count as media without reading their bodies.
  Retained text is audited only as UTF-8: any declared charset other than UTF-8/US-ASCII, a repeated
  charset parameter, or a NUL in a decoded body (UTF-16/32 text without a byte-order mark) is an
  unreviewed encoding and an incident.
  No lingering-clean-text exception remains. Any already-audited artifact that starts serving
  content is inspected again; exhausted absence waits keep cleanup incomplete and block the Pixel lease.
  Signed references persist only in private 0600 recovery progress (inside its 0700 directory),
  until verified absent. They never enter returned evidence, public summaries or logs; do not
  publish the private receipt. Recovery does not rely on an in-memory inventory or a saved clean
  flag. It re-audits finalized raw surfaces using the exact whole-link/16-character scan when both
  recorded session generations still match. If those links cannot be reconstructed, deletion
  still proceeds for confidentiality, but `unauditedRecordsDeleted` explicitly counts it and the
  deletion receives no new clean-audit claim. Audit, API deletion and artifact absence are
  monotonic stages: a post-DELETE 404 never downgrades an earlier audit into an unaudited deletion.
  Every non-media retained-surface response body is scanned before rejection, both before and
  after the initial audit, whatever its HTTP status. This includes rejected DELETE acknowledgements,
  signed-artifact checks, 200s while waiting for 404, and transient 5xx bodies before a GET retry
  discards them. Raw scanning precedes parsing; declared JSON also receives the strict canonical
  scan and reference discovery. A capability hit checkpoints an incident before the original
  status/format rejection or retry proceeds. Image/video bodies remain unread and report retained
  media instead; plan, catalog and Local-download transport bodies are not retained surfaces.
  An audit hit or unverifiable required surface is a persisted
  incident: deletion is attempted, but cleanup remains failed for operator incident handling.
  Deletion is defense in depth after the audit, not its replacement.
  Release proceeds through records, tunnels, fixture, then workspace. Unverified records or Local
  termination retain the fixture/generation and workspace for recovery; fixture-stop failure also
  preserves the workspace. Closing the proxy and removing the key config still happen on failure.
- The iPhone turns background alerts off before its session ends. If its attempt fails first, the
  subscription stays on the candidate gateway until qualification cleanup uninstalls the gateway,
  and any alerts sent meanwhile carry only session metadata.

### Manual `/collab` is outside this boundary

The rules above bind the gateway. Upstream OMP's manual `/collab` command deliberately prints the
full capability to the terminal, because showing you the link is the entire point of that flow. It
is not a defect there and this project cannot change it.

The consequence is that anything recording an OMP terminal captures a live, unexpired capability:
session transcripts, terminal recorders, CI logs of a PTY, and supervised process managers that
retain stdout. If `/collab` runs inside a recorded or supervised session, stop the session to
revoke the printed link.

This is the sharpest argument for the gateway's model rather than a gap in it. The gateway never
renders a capability: the session list is metadata-only, a capability is fetched just-in-time after
an explicit action, bound to the session's generation, and returned `no-store` to same-origin
JavaScript that hands it straight to the pinned client. Nothing on that path is printable.

Operationally: treat any recording of a terminal that ran `/collab` as containing a secret, and
prefer gateway-mediated access wherever a session is being recorded or supervised.

## 12. Supply-chain and updates

- minimal reviewed dependencies and committed lockfiles;
- dependency license and maintenance review;
- CI builds from tagged source;
- checksums, SBOM, and provenance for release artifacts;
- signed tags/artifacts where maintainers can support them;
- installer verifies downloaded artifacts before execution;
- no self-update channel in v1 unless it is signed, rollback-safe, and separately threat-modeled;
- preserve upstream OMP attribution for vendored or adapted code.

## 13. Security acceptance gates

Before release, prove:

- public and LAN clients cannot reach the service;
- unauthorized, absent, shared-but-not-allowlisted, and tagged-without-supported-auth identities are denied;
- remote identity-header spoofing cannot bypass the loopback Serve path;
- list/SSE/static HTML contain no capability canary;
- launch responses are no-store and absent from logs/traces/caches;
- browser URL, history, DOM, clipboard, cookies, Local Storage, IndexedDB, Cache Storage, service-worker state, test artifacts, and diagnostics contain no canary after leaving a session;
- collaboration-capability canaries never enter attention metadata, persisted push state, push payloads, notifications, or notification routes;
- persisted push state contains only the private subscription/VAPID/identity/detail contract, never session metadata or content;
- attention and notification surfaces expose only ADR-019's approved bounded metadata: opaque request identity, count, and detail-selected labels; Private has no body, and Preview falls back to Session because current OMP snapshots supply no preview. Prompt/option/answer/transcript content, full paths, and any field outside that contract remain forbidden;
- stopped, expired, and replaced generations cannot launch;
- view-only mutation attempts are rejected by the OMP host;
- unconfigured cross-origin requests and launches fail with `403` before identity checks and without CORS headers; configured `http.trustedDashboardOrigins` admit only exact-origin `GET /api/v1/sessions`, `POST /api/v1/sessions/:instanceId/launch`, and their authenticated `OPTIONS` preflights (without consuming launch rate-limit tokens) under full Tailscale identity authorization; any future WebAuthn endpoints must enforce the same exact-origin boundary;
- malformed and oversized IPC/API input stays bounded;
- gateway restart starts empty and discovery polling repopulates only live hosts;
- every test record either vendor kept from the stable campaign's cloud devices contains neither
  session's live View or Control link, and the tunnel can reach nothing but the candidate origin and
  its `connect-src` sources;
- release binaries bind loopback only and match published checksums.
