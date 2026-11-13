# Security design and threat model

This document is for security reviewers, operators, and contributors checking the threat model, trust boundaries, and security invariants of OMP Session Gateway, the companion to Oh My Pi (OMP). Read sections 1 to 13 for the shipped gateway's security model; section 14 covers test and release qualification tooling. For setup and recovery procedures, see [Installation and operations](OPERATIONS.md); to report a vulnerability privately, follow the [security policy](../SECURITY.md).

## 1. Security objective

OMP Session Gateway safely brokers existing OMP collaboration links from local OMP processes to one authorized mobile user without persisting or broadly exposing those links. A **View** or **Control** link is a bearer secret, called a capability in this document and [Protocol](PROTOCOL.md): a **Control** capability can read and steer a session, and a **View** capability can read sensitive transcript and tool activity.

The project reduces manual secret handling; it does not narrow the privilege of a collaboration capability.

Stock mainline OMP `>= 18.1.20` supplies the native collaboration controller and local registry, introduced in [PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, and carried by [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20). No fork, custom OMP build, or gateway-specific OMP plugin is required.

The separately installed gateway reads metadata and brokers one capability per authorized launch. Native OMP integration does not remove the TUN-mode Tailscale Serve, allowlist, or user-controlled-workstation requirements below.

## 2. Assets

The threat model protects these highest-value assets:

- full-control (**Control**) collaboration capabilities;
- view-only (**View**) collaboration capabilities;
- transcript, tool, and subagent data reachable through those capabilities;
- session metadata such as project names, models, activity timing, and whether human input is required;
- per-host OMP discovery tokens (authorizing queries to each OMP host, meaning one running `omp` process) and the gateway-only readiness token;
- tailnet and WebAuthn identity material;
- private VAPID key material, browser push subscription endpoints and keys, and fleet notification grant secrets and verifiers;
- release-signing and update infrastructure.

## 3. Threat model

### In scope

The gateway defends against these threats:

- public-Internet scanning and accidental public exposure;
- other devices and users on the LAN;
- unauthorized users or devices in the tailnet;
- cross-site requests and malicious web origins;
- accidental secret persistence in logs, traces, metrics, caches, history, browser storage, screenshots, crash reports, source-map services, or diagnostics;
- stale capability use after an OMP process exits, crashes, stops collaboration, or changes session;
- a lost or temporarily unlocked phone that remains authorized in the tailnet;
- malicious or malformed IPC and API input and resource exhaustion;
- dependency, build, installer, and update compromise;
- a relay operator observing permitted metadata and ciphertext.

### Out of scope or inherited compromise

The gateway does not defend against:

- code already executing as the same desktop OS user;
- a compromised OMP process, desktop kernel, browser engine, Android OS, identity provider, or Tailscale control plane;
- a user intentionally sharing a collaboration link;
- OMP model or provider behavior and tool authorization on the host;
- forensic recovery from process memory or swap after full local compromise.

Document these limits plainly. Do not market the project as protection against same-user malware.

## 4. Network exposure

Production deployments enforce these network invariants:

- Production HTTP listeners (`omp-gatewayd`) bind only to `127.0.0.1` and optionally `::1`; plain LAN HTTP is unsupported.
- Tailscale Serve over tailnet HTTPS is the supported remote path; do not configure or document Tailscale Funnel or public reverse tunnels as a normal path.
- Never point any other forwarder (tunnel, reverse proxy, port forward, container publish, or `ssh -L`) at the gateway's loopback port, and run Tailscale in kernel TUN mode rather than `--tun=userspace-networking`.
- Trust Tailscale identity headers only on the loopback backend behind Serve, where Serve strips spoofed incoming `Tailscale-*` headers before adding trusted ones; production rejects missing identity and compares normalized `Tailscale-User-Login` against an exact allowlist (`auth.allowedLogins`).
- Development auth (`dev-localhost`) may allow loopback clients without Tailscale, and must reject non-loopback sources.
- Keep source phones and browsers user-owned: [Tailscale Serve](https://tailscale.com/kb/1312/serve#identity-headers) populates user identity headers only for user-owned source devices, so a tagged source phone (`tag:...`) is denied even when network policy permits its connection ([Deployment dependency matrix](COMPATIBILITY.md#deployment-dependency-matrix)).
- A tagged destination gateway is distinct from a tagged source phone; do not weaken authentication or treat Tailscale policy app capabilities as an implemented alternative.
- Deploy only on a user-controlled workstation without mutually untrusted local accounts: direct loopback requests cannot be distinguished cryptographically from Serve-originated requests, so untrusted local processes or OS accounts are outside the HTTP trust boundary.
- OMP's private discovery files restrict per-host queries to their OS-user boundary, and the gateway-only readiness token proves managed loopback readiness to `omp-gateway` (shorthand for `bun apps/gateway/src/cli.js <command>` from the extracted release); neither credential authenticates browser API requests.
- In `tailscale-serve` mode, `authorizeHttpRequest` and `authorizeFleetFeedContext` (`apps/gateway/src/auth.ts`, covering browser HTTP and the machine notification feed in section 6) refuse requests before reading identity headers unless a local Tailscale tunnel interface is present (`fd7a:115c:a1e0::/48`, or a `100.64.0.0/10` `/32` host route on `tailscale0`, `utun<n>`, or `Tailscale`).
- Second-hop HTTP proxy refusal likewise rejects requests before reading identity headers when `X-Forwarded-For` names multiple hops or a non-Tailscale address, when `Host` or `X-Forwarded-Host` disagrees case-insensitively with `http.publicOrigin`, or when `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, `CF-Ray`, `X-Forwarded-Server`, or `Tailscale-Funnel-Request` is present.
- Mode dispatch in `authorizeHttpRequest` is exhaustive so an unrecognized `auth.mode` denies closed, and admitted `/api/v1/events` SSE streams re-verify the tunnel interface on every keepalive so a stream cannot outlive its Serve topology.
- Never set `auth.trustIdentityWithoutTailnetDevice` on a host with Tailscale installed: that test-harness flag declares that no tailnet reaches the host, restores the userspace-mode bypass if set on a Tailscale host, blocks rollback to older parsers that reject unknown `auth` keys, and never makes `omp-gateway doctor` ([`doctor` and diagnostics bundle](OPERATIONS.md#12-doctor-and-diagnostics-bundle)) report `loopbackTrustSound: true`.
- Background notifications use outbound HTTPS from the gateway to browser-provided push endpoints with no inbound public gateway route and no Web Push `Topic` header, giving the push service no per-session identifier.
- Web Push encrypts payloads for the browser subscription, while the push service observes the endpoint, source IP, payload size, and delivery timing (including activity-stop timing); treat subscription endpoints and keys as sensitive private state even though they cannot grant collaboration access.

Why forwarders and userspace networking fail closed: any forwarder terminating remote traffic and dialing `127.0.0.1:<port>` — including `tailscaled --tun=userspace-networking`, common in containers, VPS images, and headless servers — presents a loopback peer to `apps/gateway/src/auth.ts` and forwards whatever `Tailscale-User-Login` the remote caller chose.

That creates a complete remote authentication bypass ([#74](https://github.com/carrythroughsystems/omp-session-gateway/issues/74), [#98](https://github.com/carrythroughsystems/omp-session-gateway/issues/98), [#158](https://github.com/carrythroughsystems/omp-session-gateway/issues/158)); any future non-Serve path requires its own gateway-verified authenticator plus unconditional stripping of `Tailscale-User-*`.

Second-hop refusal is defense in depth rather than authentication: it catches HTTP reverse proxies (Cloudflare Tunnel, ngrok) and browser DNS rebinding (browsers cannot forge `Host`), whereas raw TCP forwarders (`socat`, `ssh -L`) insert no HTTP headers and remain indistinguishable from Serve.

Because Tailscale offers no per-request cryptographic proof from Serve to the backend and shared `100.64.0.0/10` CGNAT leases appear routinely in containers and carrier networks, an absent tunnel interface returns `403`, logs `http.identity_trust_unsound` once, and sets `loopbackTrustSound: false` in `doctor` (an IPv6-disabled host whose device is renamed via `--tun` fails closed visibly). Qualification also probes the gateway port from a distinct tailnet node for end-to-end proof.

If an exposed forwarder or userspace-mode `tailscaled` with `auth.trustIdentityWithoutTailnetDevice` ever accepted traffic, push subscriptions registered under a forged allowlisted login remain indistinguishable from legitimate ones even though capabilities were never persisted. Delete `push-state.json` from the state directory and re-enable alerts from the phone ([Paths](OPERATIONS.md#13-paths)).

### Tailnet controls are separate from application authorization

Tailnet policy controls and application authorization are independent required layers ([Tailnet access policy](OPERATIONS.md#4-tailnet-access-policy)). Every control below retains `auth.allowedLogins`, the loopback and kernel-TUN boundary, and the Serve-only HTTPS path; none permits Funnel or another forwarder, and the gateway does not read or enforce device posture.

| Control | Protection and failure mode | What it does not replace |
|---|---|---|
| [Grants / legacy ACLs](https://tailscale.com/docs/reference/grants-vs-acls) | Scopes the phone's user to the gateway tag and HTTPS port; [additive grants](https://tailscale.com/docs/reference/syntax/grants) mean broader rules defeat narrow ones. | Application authorization, unique-phone identity, or `auth.allowedLogins` (tag owners are not automatically allowed). |
| [Device approval](https://tailscale.com/kb/1099/device-approval) | Blocks unapproved tailnet devices; pre-approved keys skip review, and approval covers the machine rather than per-user accounts. | Ongoing device compliance, active user verification, or `auth.allowedLogins`. |
| [Node key expiry](https://tailscale.com/kb/1028/key-expiry) | Forces periodic reauthentication; tagged nodes default to disabled expiry on first tagged login, and disabling expiry trades away that boundary. | Immediate lost-phone revocation or `auth.allowedLogins`. |
| [Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock) | Requires trusted node-key signatures ([Android cannot sign](https://tailscale.com/kb/1226/tailnet-lock#limitations)); signer compromise and lost recovery secrets are custody risks. | Device health, `auth.allowedLogins`, or protection from a compromised signed phone; mutually exclusive with Device approval. |
| [Device posture](https://tailscale.com/kb/1288/device-posture) | Constrains source devices via `postures` and `srcPosture`; unset attributes fail matching, while broader rules can bypass it. | Gateway attestation, hardware identity, whole-device security, shared-node/subnet paths, or `auth.allowedLogins`. |

Policy preview and `omp-gateway doctor` do not prove that unauthorized or tagged devices are denied; validate allowed, denied, and tagged sources live ([Validate the combined controls](OPERATIONS.md#validate-the-combined-controls)). Revoking tailnet access blocks new gateway requests without retracting an already-issued capability or terminating an established OMP relay room; follow [Lost phone and revocation](OPERATIONS.md#11-lost-phone-and-revocation) to stop active host rooms.

## 5. Relay exposure

Relay transport and client media handling enforce these boundaries:

- OMP encrypts collaboration frames client-side: the relay can observe room identifiers, connection and routing metadata, participant counts, timing, and ciphertext sizes, and does not receive plaintext payloads or room keys.
- Keep the default OMP relay (`wss://my.omp.sh`) for the supported path; a self-hosted or proxied relay remains unsupported until separately threat-modeled and soak-qualified ([Unsupported deployments](OPERATIONS.md#15-unsupported-deployments)).
- The embedded collaboration client ([Embedded collaboration client](../packages/collab-client/README.md)) renders and opens tool-result images only for JPEG, PNG, WebP, and GIF MIME types, rejecting HTML and SVG before thumbnails or blob windows are created.
- Writable **Control** photo prompts re-encode accepted JPEG, PNG, or WebP inputs in volatile browser memory as metadata-free JPEGs, stripping source filenames, EXIF, and location metadata before transport ([Embedded integration](../packages/collab-client/README.md#embedded-integration), [Protocol](PROTOCOL.md)).
- Normalized photo bytes enter only OMP's encrypted `prompt.images` frame and never traverse gateway HTTP or IPC, the service worker, URLs, history, logs, diagnostics, analytics, or browser storage; after send, ordinary host transcript and model-provider retention applies, and the original phone file is never uploaded.
- Native file-input camera capture (`capture="environment"`) launches the OS camera UI without script camera access, so the gateway keeps `Permissions-Policy: camera=()` and never invokes `getUserMedia`.
- `speech.browserRecognition` defaults to `false` ([ADR-037](DECISIONS.md#adr-037--speech-input-keyboard-dictation-baseline-and-opt-in-browser-speech-recognition)): OS keyboard dictation runs outside page JavaScript under `Permissions-Policy: microphone=()`.
- When `speech.browserRecognition` is `true` on the home gateway (the gateway serving the installed app, whose setting is authoritative in federated sessions), only document HTML responses set `Permissions-Policy: microphone=(self)` while non-document responses keep `microphone=()`.
- When enabled, the in-page Web Speech control mounts only in writable **Control** after disclosing that browser or OS speech providers receive audio outside the encrypted OMP relay before any prompt is sent; no speech server, API key, or audio persistence exists in the gateway, and **Use text** only populates the composer draft — it never submits (**Send** remains a separate action; recognizer bounds in [Embedded integration](../packages/collab-client/README.md#embedded-integration)).

## 6. Capability handling

**View** and **Control** links are bearer secrets. Mandatory rules:

- Allow capabilities to exist only in the live OMP process, authenticated per-host query and launch-request memory, one `no-store` launch response, and volatile collaboration-client JavaScript memory; the gateway fetches each capability from OMP at launch time and never stores or caches it, even in the gateway's session registry.
- Keep capabilities out of files, databases, ordinary logs, diagnostics, tracing, metrics, crash reports, URLs, redirect locations, window names, DOM attributes, clipboards, cookies, Local Storage, IndexedDB, Cache Storage, service-worker caches or messages, `BroadcastChannel`, notifications, analytics, third-party assets, screenshots, recordings, issue fixtures, source-map services, and CI artifacts.
- Keep the gateway's memory-only session registry metadata-only and structurally separate from transient launch responses; never give capability-bearing objects generic serializers, inspectors, debug printers, or telemetry hooks.
- Session-list and SSE responses contain metadata only; never pre-render, prefetch, preload, or include capabilities in HTML, SSE, manifests, or hydration data.
- Fetch and release at most one requested role through a `no-store` `POST` after an explicit **View** or **Control** action, including the expected `generation` (OMP's counter that advances when a session is replaced) and revalidating generation, access, and attention request identity so stale cards fail rather than receiving a newer capability.
- Transfer capabilities to the same-origin pinned client in memory, minimize query and response references, drop browser references on launch disposal, and suppress access and body tracing on launch endpoints.
- Keep runtime assets first-party (no third-party scripts, analytics, telemetry, remote fonts, or CDNs) and use generated canary capabilities for tests, never real user links.

JavaScript strings cannot be reliably zeroized; minimize lifetime, copies, closures, global state, and references instead of claiming memory erasure.

The pinned client ([Embedded integration](../packages/collab-client/README.md#embedded-integration)) keeps this capability boundary across coalesced renders and request-tray expansion: expanding reparents the mounted shell without fetching a second link, tray descriptors, DOM attributes, and history state hold no capability, closing or `pagehide` disposes synchronously, and bfcache resume revalidates metadata first ([OMP Sessions PWA](ARCHITECTURE.md#14-omp-sessions-pwa)).

Settled and streaming Markdown pass links and image sources through the browser URL scheme sanitizer (HTTP(S) and relative only for images), raw HTML stays escaped, KaTeX renders MathML with `trust: false` and `maxSize: 100`, and only pure TypeScript parser sources are vendored without `pi-utils` or `pi-natives` runtime dependencies.

`inputRequired` and optional boolean `busy` are the only accepted host attention and activity signals (`null` or missing activity is unknown, never idle or completion).

Each `false`-to-`true` `inputRequired` transition derives an opaque in-memory request ID and receipt timestamp exposed as routing metadata (never authorization) and destroyed on clear, removal, expiry, or generation replacement; prompt text, options, answers, and transcript content remain prohibited because stock OMP snapshots supply no preview ([Protocol](PROTOCOL.md)).

Keep `SourceKey` (`id + "\0" + origin`) strictly as a dashboard-side in-memory discriminator; never concatenate it into an OMP `instanceId` or send it on the wire.

Device-local triage storage (`omp.sessions.held-asks.v2`, `omp.sessions.dismissed.v2`), `omp.sessions.first-run.v1`, and `omp.sessions.creation-prefs.v1` record bounded `sourceId` and `sourceOrigin` or step choices without `SourceKey`, labels, paths, models, prompts, transcripts, or capabilities ([Browser storage](../apps/web/README.md#browser-storage)).

Local Hold and Hide never stop OMP or alter authoritative attention counts, remote Hold never enumerates or closes home notifications even when `instanceId` collides, and first-run trays never request capabilities or permissions automatically ([Local triage storage](ARCHITECTURE.md#local-triage-storage)).

Web Push, VAPID keys, notification tags, app badges, and service-worker tap routes belong to the gateway serving the PWA; remote hosts reach its worker only as [ADR-048](DECISIONS.md#adr-048--fleet-notifications-through-the-home-gateway-as-coordinator) fleet notifications below.

After an explicit opt-in, `push-state.json` stores only the user-only VAPID key pair, bounded browser subscriptions, authenticated identity, and `private`, `session`, or `preview` detail choice (`private` omits body text; `preview` falls back to `session`; visible text can persist in notification history, screenshots, and wearables).

Activity-stop notifications carry only version, type, optional remote source binding, `instanceId`, and `generation`, resolving only to **View** for that generation.

Attention and stop taps scrub the routing URL before networking, never navigate an open page from the worker, and revalidate live state before calling the `no-store` launch `POST` ([Notification lifecycle](ATTENTION_SPEC.md#notification-lifecycle), [Background alerts and activity stops](ARCHITECTURE.md#background-alerts-and-activity-stops)).

Never put a capability in a push payload, notification data, route, history entry, service-worker message, persisted push state, badge, or request identifier.

### Fleet notifications

Fleet notifications ([ADR-048](DECISIONS.md#adr-048--fleet-notifications-through-the-home-gateway-as-coordinator), background alerts for remote hosts) make the gateway serving the PWA the sole coordinator that sends every push; never share VAPID keys or add a second coordinator.

Residual risks apply even when configured safely: a source (remote host) naming a coordinator discloses enrolled owners' session identifiers and ask timing to that coordinator, a stolen coordinator grant secret reads the same metadata until revocation or 30-day expiry, pushes accepted by a push service cannot be recalled after revocation, and fleet alerts pause while the coordinator is down.

- Both administrators opt in: a coordinator pulls only sources listed in `notifications.sources`, and a source serves only coordinators listed in `notifications.coordinators` whose origins are also in `http.trustedDashboardOrigins` (trusted dashboard origin status alone grants no machine access).
- Each owner grants each source browser-direct: grant creation, renewal, and revocation at a source authenticate the caller from that source's own Serve identity and accept only the exact coordinator origin; no daemon forwards, synthesizes, or trusts `Tailscale-User-Login` for another host.
- A grant secret is stored only at the coordinator (`fleet-notifications.json`, 256-bit secret; the source stores only its SHA-256 verifier in `notification-grants.json`) and authorizes only `GET /api/v1/notification-feed`, a non-CORS machine route that refuses browser requests (`Origin` or `Sec-Fetch-*` present) and never forwards or trusts identity headers.
- `GET /api/v1/notification-feed` enforces the Serve loopback and second-hop checks, compares verifiers in constant time, refuses redirects, rechecks coordinator, trusted origin, owner allowlist, and expiry on every connection and event, and cannot list browser sessions, fetch **View** or **Control** links, create sessions, or change subscriptions.
- The feed projects only instance IDs, generations, actionable request IDs, live stop edges, an owner digest, and grant expiry; fleet pushes (`version: 3`) carry no titles, working directories, models, previews, timestamps, or capabilities ([Fleet notifications](PROTOCOL.md#fleet-notifications), [Fleet notification source](ARCHITECTURE.md#fleet-notification-source)).
- Fan-out stays owner- and device-bound: remote events reach only push subscriptions owned by the grant's allowlisted owner (verified against the feed's owner digest) and selecting that source, two owners' grants or devices never mix, both private JSON files (including the coordinator's bounded 256-ask clear tracker) fail closed when corrupt without holding labels, paths, prompts, or capabilities, and diagnostics stay numeric or boolean.

### Opt-in creation and first-task drafts

Opting into session creation in Tern (a terminal execution environment for stock OMP; [ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption)) grants stronger trust than directory or launch access: an opted-in target with `tern` configured trusts JavaScript on its own origin and every origin in `http.trustedDashboardOrigins` to create processes from its configured profiles under an allowlisted Tailscale identity, not merely read metadata or open existing sessions.

Removing dashboard trust blocks further API requests without cancelling accepted work, killing a started OMP process, or revoking an already-issued relay capability.

- Creation uses administrator-authored `argv` arrays and an explicit complete CLI environment in `config.tern` (`workingCopies[].path` equal to its `realpath`, absolute `tern.executable` and `profiles[].argv[0]`, literal `profiles[].argv`, and `profiles[].env`).
- Never merge `process.env`, invoke a shell, or accept browser-selected executables, paths, `argv`, `env`, labels, or task text; `collab.autoStart = control` publishing into `omp.discoveryDir` inside Tern is a separate operator prerequisite.
- Persist private capability-free intent to `<stateDir>/session-creations.json` before spawning; uncertainty or daemon restart never permits automatic re-spawn, and browser cancellation (**Close** or request abort) stops watching, not the process.
- Creation options expose only choice IDs, labels, and an opaque per-daemon revision; status responses and the owner-scoped `session-creations.json` ledger (64 records, 24 hours, 512 KiB max) record only operation and request IDs, normalized owner identity, timestamps, state, optional local block ID, ready `instanceId` and `generation`, and closed errors — never labels, paths, `argv`, `env`, prompts, raw CLI output, session-file paths, or capabilities.
- Ledger corruption or failed private writes disable creation without deleting evidence or affecting ordinary discovery and launch ([Session creation state machine](PROTOCOL.md#session-creation-state-machine), [Creation ledger recovery](OPERATIONS.md#creation-ledger-recovery)).
- An optional **First task** draft (8,000 code points / 32 KiB max) stays in volatile browser memory bound to the exact source, `instanceId`, and `generation`, and never enters gateway requests, ledgers, URLs, logs, diagnostics, notifications, or `localStorage`.
- `takeInitialPromptDraft` drains that draft once into an empty ordinary composer in live writable **Control** (healthy relay, no active Ask, and no photo draft or in-flight photo send) without auto-sending; cancellation, binding change, authorization loss, `pagehide`, or shell disposal clears the holder ([Embedded integration](../packages/collab-client/README.md#embedded-integration)).

## 7. Browser controls

Every API, problem, and bootstrap response carries this response policy from `apps/gateway/src/http-policy.ts` (shipped builds use `'self'` without inline script or style hashes or nonces):

```http
Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' wss://my.omp.sh; manifest-src 'self'; worker-src 'self'
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()
Cache-Control: no-store, max-age=0
Pragma: no-cache
```

Additional browser and HTTP requirements (`apps/gateway/src/http-policy.ts`, `apps/gateway/src/http.ts`, `apps/gateway/src/static.ts`):

- API, creation, launch, `application/problem+json`, and `GET` bootstrap responses (`/client/`, `/update/`, and `/collab/`) are `no-store` (`Cache-Control: no-store, max-age=0` and `Pragma: no-cache`); `index.html` and unhashed shell files are `no-cache`, and content-hashed `/assets/` files are immutable.
- Document HTML responses (`status < 400`, `text/html`) extend `connect-src` only with configured `fleet.targets[].origin` entries (`http.trustedDashboardOrigins` is never added to `connect-src`) and switch `Permissions-Policy` to `microphone=(self)` only when `speech.browserRecognition` is `true`; non-document responses retain `connect-src 'self' wss://my.omp.sh` and `microphone=()`. If relay origins are configurable, generate `connect-src` only from administrator-controlled validated origins.
- Validate exact `Origin` on state-changing requests (`POST`, `PUT`, and `DELETE`, plus any future WebAuthn enrollment or assertion endpoints) and evaluate `Sec-Fetch-Site` defensively (`requestHasValidMutationContext` requiring `http.publicOrigin` and `Sec-Fetch-Site` absent or `same-origin` on same-origin routes; missing Fetch Metadata never skips exact `Origin` validation).
- On cross-origin launches, creations, and (when also listed in `notifications.coordinators`) fleet grant `POST` routes, `requestHasTrustedDashboardContext` requires an exact match in `http.trustedDashboardOrigins`, `Sec-Fetch-Site` absent or in `{same-site, cross-site}`, and exact `Content-Type: application/json`.
- Do not use wildcard CORS or `Access-Control-Allow-Credentials`. Cross-origin admission ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors), extended by ADR-043 and ADR-048) is bounded to at most 8 `http.trustedDashboardOrigins` (`fleet.targets` is bounded to 7 remote targets, 8 sources total with `local`) and exposed only on the cross-origin routes and authenticated `OPTIONS` preflights specified in [Cross-origin access](PROTOCOL.md#cross-origin-access).
- `/api/v1/events`, `/api/v1/push/*`, `/api/v1/notification-feed`, `/api/v1/client-config`, `/api/v1/health`, and static assets are never exposed cross-origin.
- Unconfigured fleet notification routes (`/api/v1/notification-feed`, `/api/v1/notification-grants`, and `/api/v1/push/fleet/`) return `404` first; on every other `/api/` route except loopback `GET /api/v1/health`, any foreign non-admitted `Origin` is refused with `403` and no CORS headers before identity checks.
- Admitted cross-origin responses emit `Access-Control-Allow-Origin: <exact origin>` and `Vary: Origin`, while admitted `204` `OPTIONS` preflights emit `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers` and consume no mutation rate-limit tokens.
- Render all metadata as text (never unsanitized HTML), strip or safely display control and bidi characters in titles and paths, cap label length and session count, use `rel="noopener noreferrer"` on external links, and disable framework devtools hooks in production builds where practical.
- Keep runtime assets first-party: all web fonts are self-hosted subsets under `default-src 'self'` with system fallbacks, and no analytics, remote fonts, third-party scripts, source-map upload services, or CDNs are used ([Appearance](../apps/web/README.md#appearance)). Never place capabilities in state persistence, devtools globals, error boundaries, replay tools, performance marks, history state, or directory snapshots.
- The service worker caches only immutable application-shell assets and bypasses cross-origin, navigation, query-bearing, non-`GET`, `/api/`, `/internal/`, `/client/`, `/collab/`, and `/update/` collaboration-client bootstrap traffic; Push handling accepts only validated `attention`, `clear`, and `activity_stop` envelopes, updates one per-instance tag and the bounded app badge, and never fetches or receives a capability ([Service worker](../apps/web/README.md#service-worker)).
- Activated shell updates claim clients without navigating them, so an open page reloads itself only while idle with no in-flight launch, routed notification, or mounted collaboration client ([ADR-018](DECISIONS.md#adr-018--activate-pwa-upgrades-automatically-without-interrupting-live-collaboration)).
- An earlier rollback-restored worker may navigate to the `no-store` `/update/` bootstrap, which synchronously scrubs to `/`, and reloads return to the metadata directory ([Shell updates and caching](ARCHITECTURE.md#shell-updates-and-caching)).
- Transient directory transport failure retains the last authenticated metadata only in volatile page memory marked stale; authorization failure clears it immediately ([Availability model](ARCHITECTURE.md#availability-model)).

## 8. Tailnet authorization

In `auth.mode = "tailscale-serve"`, request authorization enforces these rules in order:

1. require `Tailscale-User-Login` on the verified Serve loopback path;
2. normalize `Tailscale-User-Login` with NFC normalization, trimming, and lowercasing (`1`–`320` characters, rejecting NUL, CR, LF, and commas; `apps/gateway/src/auth.ts`);
3. compare against the exact configured `auth.allowedLogins` allowlist;
4. reject wildcard defaults and empty production allowlists;
5. treat external users who accepted a device share as ordinary identities requiring explicit allowlisting;
6. optionally display the active login without persisting it;
7. log only numeric or boolean fields, never identity strings or hashes.

A separate `dev-localhost` mode (`--dev-localhost`) accepts loopback clients and the configured loopback origin only, rejecting non-loopback sources. Tailnet grants and application allowlisting are both required defense layers; any future device-specific policy using posture or Tailscale policy app capabilities must have tests and must never fall back to "any tailnet member."

## 9. Local discovery and queries

Stock mainline OMP `>= 18.1.20` owns the collaboration controller and local discovery directory ([PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, carried by [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20)); the gateway is a read-only discovery reader and query client, never a publisher server:

- The gateway only reads OMP's private, current-user-owned discovery directory and queries each host's published endpoint: reject symlinks and unsafe ownership or permissions, never write, rename, or unlink discovery files or sockets, and never derive the endpoint from a filename.
- Per-host discovery tokens authorize queries to OMP (private because they permit querying links, though not collaboration capabilities themselves); bound newline-framed requests, responses, connection timeouts, and discovery entries, and never log discovery tokens, raw replies, transport error strings, or capability-bearing parse errors.
- Fetch metadata with `snapshot` and fetch capabilities only at launch time with an explicit generation-bound `link`, rejecting stale generations and unavailable roles rather than substituting a newer or stronger link.
- The registry is metadata-only and memory-only: a daemon restart begins empty, polling repopulates it (`registry.heartbeatSeconds` default 10 seconds; `registry.ttlSeconds` default 35 seconds, exceeding twice the interval on a monotonic receipt clock), and no capability store exists.
- Only `ENOENT` or `ECONNREFUSED` proves a queried host dead; timeouts, permission or resource errors, and wire errors retain its card until TTL expiry, while absence from discovery removes it ([Host poller and launch broker](ARCHITECTURE.md#12-host-poller-and-launch-broker)).
- Tern remains an execution environment for stock OMP ([ADR-038](DECISIONS.md#adr-038--tern-is-an-execution-environment-not-an-integration), narrowly amended by [ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption)): session identity stays OMP's `instanceId` and `generation` from OMP-native discovery, with no Tern discovery adapter, general control surface, `tsp.ts` reader, pane scraping, focus, attachment, keystrokes, or native handoff.
- Opt-in creation reads only bounded `tern inspect --json` metadata, parses unsigned 64-bit IDs losslessly, rejects remote host tags at bit 56 or above, matches `omp_session_file` only by in-memory basename token without opening, statting, tailing, or scraping that JSONL file, and reauthorizes **Control** before `ready` and again at capability launch.
- The gateway's private `readiness-token` proves managed loopback readiness to its CLI and `doctor` via an HMAC over a fresh 256-bit challenge and one-time startup instance nonce (rejecting generic health responses and older same-token processes), is never an OMP credential, and fails closed on failed rotation without restoring the prior token ([Staging, readiness proof, and activation](ARCHITECTURE.md#61-staging-readiness-proof-and-activation)).
- For pre-`v0.4.0` `publisher-token` transitions, follow [Recover across the v0.3.0 boundary](UPGRADE_ROLLBACK.md#recover-across-the-v030-boundary).

These OS-permission and token controls reduce accidental and cross-user access; they are not a sandbox against same-user malware.

## 10. Lost phone and user presence

Operators rely on these device and tailnet controls for lost-phone containment ([Lost phone and revocation](OPERATIONS.md#11-lost-phone-and-revocation)):

- use mobile OS device lock and biometrics;
- require strong identity-provider authentication for Tailscale;
- remove or expire a lost device promptly and stop active OMP collaboration rooms;
- keep tailnet grants narrow;
- persist no session capability in the PWA.

Optional stronger **Control** protection ([ADR-008](DECISIONS.md#adr-008--optional-webauthn-gate-not-native-biometrics), proposed and unimplemented): passkey enrollment and per-launch WebAuthn verification are not part of the gateway. Any future implementation must enforce the following contract without replacing device revocation, screen lock, or tailnet policy:

- enroll a WebAuthn credential with user verification;
- require a fresh assertion for each **Control** launch or a very short verified window;
- bind challenge, operation, origin, instance, generation, and mode server-side;
- store only public credential material;
- never treat a successful **View** action as authorization for **Control**.

## 11. Logging, diagnostics, and test artifacts

Gateway log fields are numeric or boolean only; never log strings from host queries or metadata (`apps/gateway/src/logger.ts`). At normal verbosity, the shipped gateway allows only:

- fixed event names selected by the implementation, not data from a host or request;
- numeric protocol versions, generations, counts, and durations;
- boolean success, failure, and health fields.

Never attach string-valued identifiers, hashes, paths, error messages, metadata, or serialized query objects. Across logs, diagnostics, and support bundles, the following are forbidden:

- capabilities or substrings;
- request or response bodies for launch endpoints;
- authorization or identity headers;
- per-host discovery tokens or the readiness token;
- transcript, prompt, tool, or subagent content;
- full filesystem paths by default;
- browser network traces containing secret responses;
- screenshots while a canary capability is visible;
- unredacted tailnet names and identities in public bundles.

Creation adds no logging exception: request payloads, operation and owner identifiers, labels, executable and working-copy paths, `argv` and `env`, raw Tern stdout/stderr or inspection output, and `omp_session_file` never enter logs or public errors.

`omp-gateway doctor --bundle` archives exclude the creation ledger, fleet grant and coordinator state files, creation request payloads, `argv` and `env`, and raw CLI or inspection output; never add those files to a support archive, and keep client snapshot-loading progress limited to `received` and `total` counters rather than transcript content.

Qualification harness logs, Percy visual review, and device-cloud vendor rules are in [Qualification and test infrastructure](#14-qualification-and-test-infrastructure).

### Manual `/collab` is outside this boundary

The rules above bind the gateway. Upstream OMP's manual `/collab` command deliberately prints the full capability to the terminal, because showing the user the link is the entire point of that flow; it is not a defect there and this project cannot change it.

Anything recording an OMP terminal therefore captures a live, unexpired capability: session transcripts, terminal recorders, CI logs of a PTY, and supervised process managers that retain stdout. If `/collab` runs inside a recorded or supervised session, stop the session to revoke the printed link.

This contrast motivates the gateway's model: the gateway never renders a capability, serves a metadata-only session list, fetches one generation-bound capability at launch time after an explicit action, and returns it `no-store` to same-origin JavaScript that hands it straight to the pinned client. Nothing on that path is printable.

Operationally: treat any recording of a terminal that ran `/collab` as containing a secret, and prefer gateway-mediated access wherever a session is recorded or supervised.

## 12. Supply-chain and updates

Release artifacts and installations enforce these supply-chain invariants:

- minimal reviewed dependencies and committed lockfiles;
- dependency license and maintenance review;
- CI builds from tagged source;
- checksums, SBOM, and provenance for release artifacts;
- signed tags and artifacts where maintainers can support them;
- operators verify published checksums and attestations per [Verify a published build](RELEASE.md#verify-a-published-build) before extracting; `omp-gateway install` never downloads and performs no signature check itself;
- no self-update channel in v1 unless it is signed, rollback-safe, and separately threat-modeled;
- preserve upstream OMP attribution for vendored or adapted code.

## 13. Security acceptance gates

Before release, prove:

- public and LAN clients cannot reach the service;
- unauthorized, absent, shared-but-not-allowlisted, and tagged-without-supported-auth identities are denied;
- remote identity-header spoofing cannot bypass the loopback Serve path;
- list, SSE, and static HTML responses contain no capability canary;
- launch responses are `no-store` and absent from logs, traces, and caches;
- browser URL, history, DOM, clipboard, cookies, Local Storage, IndexedDB, Cache Storage, service-worker state, test artifacts, and diagnostics contain no canary after leaving a session;
- collaboration-capability canaries never enter attention metadata, persisted push state, push payloads, notifications, or notification routes;
- persisted `push-state.json` contains only the private subscription, VAPID, identity, and detail contract, never session metadata or content;
- attention and notification surfaces expose only [ADR-019](DECISIONS.md#adr-019--complete-the-couch-flow-attention-contract-with-bounded-presentation-metadata)'s approved bounded metadata: opaque request identity, count, and detail-selected labels; Private has no body, Preview falls back to Session because stock OMP snapshots supply no preview, and prompt, option, answer, transcript, and full-path data remain forbidden;
- stopped, expired, and replaced generations cannot launch;
- view-only (**View**) mutation attempts are rejected by the OMP host;
- unconfigured fleet notification routes fail with `404`, and every other unconfigured cross-origin `/api/` request (except loopback `GET /api/v1/health`) fails with `403` before identity checks and without CORS headers;
- configured `http.trustedDashboardOrigins` (at most 8) admit only the exact-origin routes listed in [Cross-origin access](PROTOCOL.md#cross-origin-access) and their authenticated `OPTIONS` preflights (without consuming launch rate-limit tokens) under full Tailscale identity authorization, and any future WebAuthn endpoints must enforce the same exact-origin boundary;
- a fleet grant credential is refused by every route except `GET /api/v1/notification-feed`, the feed refuses browser requests, foreign, revoked, or expired grants, and grants whose coordinator, origin trust, or owner was removed, and a remote event never reaches another owner's or an unselecting device's subscription;
- fleet feeds, fleet pushes (`version: 3`), and fleet notification data carry no title, working directory, model, preview, timestamp, endpoint, secret, or capability, and synthetic canaries in those fields are rejected before persistence, logging, routing, or rendering;
- malformed and oversized IPC and API input stays bounded;
- gateway restart starts empty and discovery polling repopulates only live hosts;
- every test record kept by the real-device cloud qualification vendors ([Qualification and test infrastructure](#14-qualification-and-test-infrastructure)) contains neither session's live **View** or **Control** link, and the qualification tunnel reaches nothing outside the candidate origin and its `connect-src` sources;
- release binaries bind loopback only and match published checksums.

## 14. Qualification and test infrastructure

This section covers the repository's test suites, qualification harnesses, visual-review uploads, and real-device cloud runs rather than the shipped gateway runtime. Maintainer procedures are in [Test plan](TEST_PLAN.md), [Release procedure](RELEASE.md), and [BrowserStack visual review](BROWSERSTACK.md).

### Qualification logs and failure evidence

Qualification diagnostics and `--qualification-log-dir` event files live only in access-restricted local directories (0700 parent directory, 0600 files) outside public receipts and CI artifacts, running against synthetic fixtures and canary capabilities with no external vendor credentials.

Structured daemon qualification logs record only closed event names, finite numbers, and booleans, while private CLI stderr and `browser-substep.json` retain redacted developer-authored error chains that operators must inspect and redact before sharing.

- Test infrastructure must fail when a known canary appears in logs, files, Playwright traces, HARs, screenshots, video, browser history, DOM snapshots, caches, storage, service-worker state, or diagnostics archives.
- Tern, multi-host fleet, and speech test fixtures or qualification notes follow the same leak rules: never record a literal 43-character base64url token, a 64-hex discovery token, a collaboration capability, a real `*.ts.net` tailnet hostname (use `<name>.example.ts.net`), a public IPv4 address, or a `/Users/<name>` path.
- The stable qualification CLI's private stderr separately retains developer-authored `Error` messages and stacks along `cause` and `AggregateError` edges, and readiness's private `browser-substep.json` retains the failed browser step, error message, CDP method, and elapsed time.
- Both sinks use the repository's identifier and capability rules to redact private identifiers and withhold capability-bearing lines, never serialize arbitrary error properties, and never enter receipts, gateway logs, or public artifacts.
- Repeated or cyclic errors and traversal-limit exhaustion are marked explicitly rather than recursed; message and stack ceilings are 4 and 16 KiB respectively, withholding oversized fields without retaining partial secrets or scanning unbounded provider bodies.
- Redaction and truncation are explicit and the complete serialized diagnostic is capped below 256 KiB; diagnostic-retention failures stay in private causes rather than the sanitized failure graph, and concurrent execution expiry cannot replace a browser failure or discard its cause.
- Producer-authored `Error` messages are the authorship boundary (identifier and capability scanning is defense in depth, not a general-purpose body classifier): a short capability-free response body copied into an `Error` message is retained in these private sinks and must never enter receipt evidence, gateway structured telemetry, or public artifacts.
- `AndroidAdbError` in `scripts/android-device.ts` withholds command stdout and stderr at construction before the bounded private diagnostic formatter rather than copying provider output into an `Error` message and relying on redaction afterward.
- Effectful Pixel readiness reads GCM only after acquiring its lease and checkpointing a restorable device baseline; a proven disconnection authorizes one bounded Wi-Fi off/on cycle, not changes to Tailscale, DNS, exit-node, firewall, battery, or notification policy.
- The 30-second Wi-Fi reconnect wait does not enlarge delivery budgets, execution cancellation and normal radio restoration remain authoritative, and an exhausted GCM remedy never authorizes an automatic campaign retry.
- Late observations and any malformed or duplicate connection line cannot establish readiness; receipts contain only `gcmConnected` and `gcmRemedyApplied` booleans, while all GCM exits and subsequent readiness errors retain those facts and the censored private sample.
- Successful Push hands the GCM sample to its enclosing readiness owner as separate process-local context retained before post-action persistence and deadline checks, without serializing that context into the receipt; the sample allowlists only the client-connected flag and an `OFF` or bounded duration reconnect alarm (`unavailable` on malformed fields), never device IDs, app or message IDs, network names, endpoints, or the rest of `GcmService` output.
- Qualification explicitly supplies `--qualification-log-dir` (an environment variable alone never enables daemon retention, leaving ordinary installations unchanged); `install`, `rollback`, and `repair` forward the option only to runtimes advertising `structured-v1`, and raw daemon stdout and stderr remain discarded independently.
- The `--qualification-log-dir` sink accepts only closed event names and fields, finite numbers, and booleans (plus the fixed envelope timestamp, level, and name), retaining four files of at most 256 KiB in an existing absolute current-user-owned 0700 directory with no symlink components and single-link 0600 regular files (unsafe startup fails; rate-limited discovery and authorization events use the same closed vocabulary).
- Each synchronous burst durably invalidates the existing private health inode before touching log data; its microtask commit flushes the bounded active file and commits the exact event index and first retained index (rotation flushes the file being moved, per-event appends need no per-event fsync, and an interrupted or failed burst never publishes success).
- Writer startup and final collection acquire the same exclusive private in-directory claim inside the service writable location: the writer makes its claim durable before logging, and a failed close retains it even if a closed-looking lease write reached the cache and every health invalidation fails.
- Graceful teardown drains admitted HTTP handlers (not only sockets) and every other event producer, then fsyncs final health, closed lease, and directory state; claim unlink is the last fallible close step, restart and collection reject any held claim (requiring explicit reset after abrupt death or unpersisted unlink, never automatic repair), and writes after close increment a bounded in-memory drop count.
- Restart and collection require contiguous records in oldest-to-newest file order beginning at index 1 unless the committed rotation boundary explains the prefix; missing or truncated retained files and record reordering fail.
- Logs live outside fixture-cleanup directories, and reads bracket event files with health reads to retry changed or unsettled health/lease state so a torn snapshot never becomes evidence.
- After the daemon stops, collection holds the exclusive claim while validating bounded records into private, exclusively created immutable job files and lane/phase slices, fsyncs the files and directory, and rechecks retained health before atomically retiring and unlinking only the retired remote directory.
- Failed validation or deletion preserves the claim or retired evidence, and no raw errors, endpoints, real identifiers or hashes, notification text, payloads, capabilities, tokens, or provider bodies are retained in these artifacts.
- Push qualification events retain only numeric sequence, opaque request alias, kind flags, subscription counts, durations, and HTTP status; qualification-only aliases are allocated from the next retained-log append index (preventing reuse across daemon restarts in the same job), mapped to exact session/generation/request tuples only in process memory, and exposed as `qualificationPushAlias` on authenticated `GET /api/v1/sessions` only for the exact active ask (ordinary responses omit it).
- Before any re-arm, the runtime re-fetches the owned fixture snapshot, requires its alias to match queue, send, and failure evidence, and requires both phone clear and matching outbound clear acknowledgement.
- Immediately before transport, a fresh snapshot must retain the original instance and generation, controllability, no active ask, and matching request/alias state, and the guarded fixture command checks the OMP session ID synchronously (detecting a session switch, though the cross-process check is not atomic across same-session generation rotation).
- Collector windows use event indices and one exact request alias: queue sequences must increase, every send in a queue must start before its first completion, and every declared fan-out send must be acknowledged (multiple recipients are valid; provider acknowledgement proves acceptance rather than phone presentation, and missing completions, foreign aliases, rotation gaps, or invalid telemetry never establish success by time proximity).
- Only a single-send explicit retryable failure permits re-arm (at most one evidence-backed fresh ask per phase, separate from overlap recovery; partially acknowledged fan-outs and subscription replays, which carry a required boolean on queue/send events, never authorize a fresh-ask retry, and request identities remain volatile).
- Radio restoration closes the original window before reopening the WebAPK for post-restoration observation, and a late post cannot satisfy a fresh ask unless the worker attests its exact request and the authoritative snapshot retains its generation.
- Late-post and ask-metadata samplers install before waiting or returning `delivery_timeout` or `delivery_metadata_timeout` (preserving snapshot error identities), remain armed through clear settlement, are replaced for a fresh ask, disarm immediately on in-budget delivery or ambiguous overlap retry, and retain late deliveries or sampler failures without skipping device restoration.
- Readiness starts its failure clock before mutation, rechecks execution deadlines after asynchronous observations and before success, rounds monotonic durations into bounded safe integers, retains ordered millisecond pairs in per-phase `deliveryTimings` without overwriting earlier observations, and enforces separate 160-second delivery and clear windows starting before answer and metadata work (60/160-second bounds and both raw-stream discard and structured-log safety proofs remain required).
- Containment errors take precedence over expired delivery budgets (including post-recovery request attestation); unacknowledged target creation remains unresolved after its response route expires, target or forward cleanup failure blocks Pixel release with causally linked collateral, final task restoration uses ADB without reopening CDP, and notification cleanup inspects both v1 and v2 Hold/Hide stores without treating malformed records as absence.

### Percy visual upload boundary and Live

Percy is a test-only third-party sink receiving authored synthetic DOM, first-party build resources, and redacted CLI logs for 21 synthetic snapshots (seven states across three source viewports) — never a production gateway, live relay, or real OMP session ([ADR-035](DECISIONS.md#adr-035--advisory-percy-review-of-capability-free-serialized-fixtures), [BrowserStack visual review](BROWSERSTACK.md)).

BrowserStack Live (manual interactive browser sessions) is restricted to manual, capability-free synthetic fixtures with no Live tunnel, real-session access, or candidate qualification authority. Local mode starts no Percy and strips Percy credentials; forks and `gateway-ci` dispatches receive no token and report not uploaded, while eligible CI uploads supply the token only to the pinned native-Node CLI after an offline preflight audit.

- Synthetic **View** and **Control** canaries count as forbidden material: `DashboardFixture.assertNoCapabilityMaterial` closes over full capabilities, room ID, encoded key, every contiguous 16-character segment, and URL, JSON, and HTML-escaped forms without exposing any as a fixture property.
- The installed `@percy/dom` serializer runs with the SDK's exact options; its full HTML (including hidden attributes, form values, inline styles, and text), every resource and its decoded bytes, and the SDK's exact last-mile `POST` must pass that guard plus the capability and identifier scanners (a finding fails closed rather than redacting, and errors, reporter output, and SDK diagnostics never repeat the input or match).
- Percy asset discovery is restricted to the loopback fixture host in Playwright's installed Chromium with JavaScript rendering disabled, refusing off-origin requests and unreviewed embedded, executable, or resource surfaces; eligible upload mode requires a healthy Percy server under pinned native Node, a responsive API and active build in the Bun worker, exactly 21 submissions, and build finalization, with no traces, screenshots, videos, raw diagnostics, or Percy output entering CI artifacts.
- Local CLI logs stay in memory, whereas Percy redacts and uploads its CLI logs with each build (`PERCY_CLIENT_ERROR_LOGS=false` disables only the separate CI-log upload, and structured log metadata is scanned rather than trusting vendor redaction).
- Before real upload starts, upload mode runs the identical 21-case suite with a five-minute deadline, no real token, and no `sendBuildLogs` call against a native-Node Percy testing host supplied one ephemeral synthetic authority over a private local pipe.
- After all 21 submissions, the host applies the pinned CLI redactor to non-`ci` logger entries as `sendBuildLogs` does, requires the `clilogs` candidate to pass the full/segment/escape guard and both scanners, verifies that a planted SDK-log canary fails without echoing, and emits only closed-set phase/reason codes and bounded counts across nested processes.

### Real-device cloud qualification

Cloud-device qualification opens **View** and **Control** on TestingBot's real devices (with BrowserStack Automate as a fixed empty-pool fallback for iPad Safari and Samsung Chrome only, never iPhone), so a vendor-operated device briefly holds a live capability for only the isolated qualification OMP session and lane fixture on a candidate gateway, both using a synthetic model key and no user data and both revoked at teardown.

A loopback `CONNECT` proxy restricts tunnel traffic to TLS passthrough for the candidate origin and its `connect-src` sources (exposing only those hostnames and ciphertext sizes), and post-session audits inspect every vendor record for capabilities, 16-character capability windows, video, and screenshots.

TestingBot credentials live only in child-process environment variables and in-memory request headers; on the single-user orchestrator, BrowserStack Local reads its key from a transient 0600 file in the owned 0700 attempt directory.

- TestingBot's tunnel runs with `--noproxy` through the lane's own loopback `CONNECT` proxy (opening `CONNECT` tunnels only to the candidate origin and its `connect-src` sources, refusing plain HTTP, loopback, LAN, and other tailnet services, and closing the proxy and tunnel before releasing the Pixel lease).
- Stock tunnel 4.9 opens an unauthenticated Selenium relay and metrics server on all interfaces by default; the lane passes port `-1` for both and stops any tunnel that listens outside loopback or fails to start before proceeding.
- Sessions disable video, screenshots, device logs, and public visibility; without relying on log-disable settings, page evaluations return only bounded counts, booleans, closed codes, error names, and `LEAK_SINKS` names (keeping capabilities in-page with no digest, length, matched text, address, cache/DB name, or page-controlled asset pathname), parse user-agent and client-hint attestation in-page before opening any capability, and build receipt strings only from fixed grammars.
- After sessions end (including partial or failed attempts, ending every known session before releasing fixtures, tunnels, or workspaces), the lane fetches every TestingBot test record, asset inventory, and declared log, HAR, or performance surface under one raw-byte budget.
- Signed TestingBot log reads forward no account authorization, refuse redirects and unreviewed HTTPS origins/buckets, and fail if any declared surface cannot be inspected (an empty inventory proves nothing about unobservable vendor-internal retention).
- Every TestingBot surface is scanned as bounded raw bytes and via the duplicate-key-rejecting canonical JSON parser (covering JSON escape forms while plaintext logs stay raw-only and never supply references, and malformed JSON-declared logs fail closed).
- Any TestingBot record containing either session's live **View** or **Control** link, any contiguous 16-character interior or delimiter-crossing window, or retained video or screenshots fails the audit; links and windows stay in orchestrator memory, only record counts and verdicts persist, and audit/cleanup errors with available devices are diagnostic rather than holds.
- Each target's sessions end before the next allocation; any cloud release or restoration checkpoint failure marks `pixelUnrestored` through aggregate errors so the Pixel-lease guard blocks queued device work until cleanup recovery, and if an iPhone attempt fails before disabling background alerts, its metadata-only subscription stays on the candidate gateway only until cleanup uninstalls it.
- BrowserStack selection occurs only on a valid empty TestingBot eligible pool before any primary write (failures never switch vendors), using vendor-qualified session ownership where an ambiguous create remains dirty.
- BrowserStack Local 8.9 (pinned Darwin x64 artifact under Rosetta, prepared after binary/directory setup and before tunnel intent) runs with force-local, all-port host filters, force-proxy through the loopback `CONNECT` proxy, loopback-only listeners, discarded stdout/stderr, and a private 0600 readiness FIFO.
- Local cleanup closes the proxy first and stops only processes matching realpath-resolved executable, unique attempt working directory, and private 0600 PID/birth lineage (releasing a never-created directory only when a process snapshot proves no matching executable lineage, and failing closed on ambiguity).
- Single-user orchestrator `argv` exception: the lane never places the BrowserStack key in its own `argv`, URLs, receipts, or logs, passing `--config-file` to a 0600 key config in the owned 0700 attempt directory (removed on stop and crash recovery); because the pinned vendor binary expands the key into its child's `argv` where same-user processes already can read the 1Password service-account token, prefer a dedicated BrowserStack team-member key and rotate on suspected exposure.
- BrowserStack's mandatory text logs, session JSON, and all six log and media surfaces undergo the same bounded raw-plus-canonical and exact-16 audit (including partial failures), extracting unauthenticated redirect-free signed references only from whole-value well-formed HTTP(S) URLs in duplicate-key-rejecting JSON.
- Valid BrowserStack URL references contain one case-insensitive `://`, their hostname once, and no comma; plaintext logs never supply references, and any key or non-reference string containing `://` or a pinned artifact, dashboard, or documentation hostname fails closed.
- Before accepting any retained BrowserStack JSON body, a hostname census across raw text, strict canonical JSON, and four-pass fixpoint percent-decoded text (literal malformed escapes; excess depth fails closed; one decoded `://` per reference) must equal accepted reference occurrences against `scripts/browserstack-pins.json`, or fail with `unaccounted BrowserStack artifact reference`.
- Reviewed API and S3 artifact origins (requiring `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-SignedHeaders`, and `X-Amz-Signature` once each when signed, with only `response-content-type` optional) are fetched, scanned, privately inventoried, and absence-verified, whereas dashboard presentations are counted and never fetched.
- Capability-free BrowserStack probes on 2026-10-20 pin top-level `browser_url`, `public_url`, `logs` and `video_url` to exact record-bound dashboard paths and query grammars (no userinfo, ports or fragments), and accept only `insights.summary.time_breakdown.{browserstack_time,user_time,capabilities_impact}.optimize_url` links under `/docs/` on the separately pinned documentation origin (no query; optional safe fragment), never fetched or included in the artifact census.
- A dashboard presentation's content is the audited session record (proven removed by API deletion); any other origin anywhere, or a dashboard-host URL embedded in longer text or another field, fails closed, and duplicate references retain the same inventory and media-classification checks.
- Every running and finalized BrowserStack session read is media-classified with no running `video_url` exemption: only `null`, `false`, `""`, and `[]` markers count as disabled (accepting clean indicators plus the observed missing-object S3 `403` as media absence, while media `200` fails and finalized `video_url` must match the session-bound dashboard presentation).
- Media detection rejects nonempty screenshot/video/visual fields (including opaque failed-command payloads, not only familiar media URLs), case-insensitive `data:` or media-pattern keys, and text-body media keys (`:` or `=`, bare or quoted, excluding quoted placeholders such as `"[REDACTED]"`) carrying nonempty containers or `http(s):`, `data:`, or base64-prefixed strings.
- Raw `iVBORw0KGgo`, `/9j/`, `R0lGOD`, or `UklGR` runs followed by 64+ base64 characters and non-media bodies matching PNG/JPEG/GIF/WebP/MP4/WebM/plausible-BMP byte signatures fail media checks, while declared media count as media without reading their bodies.
- Retained text is audited only as UTF-8: any charset other than UTF-8/US-ASCII, repeated charset parameter, or NUL byte in a decoded body checkpoints an unreviewed-encoding incident, and any already-audited artifact that starts serving content is inspected again.
- Every non-media retained-surface response body — including rejected `DELETE` replies, signed-artifact checks, `200`s while awaiting `404`, and transient `5xx` bodies before retry (excluding plan, catalog, and Local-download transport bodies) — is raw-scanned and, when declared JSON, canonically scanned before status or format rejection.
- Conflicting WebDriver session IDs are treated as unidentified, and unbound pre-build references persist an incident and fail closed without queuing volatile references for later discovery.
- Artifacts first declared after the audit (origin plus pathname, retaining re-signed URLs in private 0600 recovery progress inside its 0700 directory), post-audit schema/census/validation failures (recovering only validated whole-value pinned URLs from strict JSON while checkpoint failures halt), audit hits, and unverifiable surfaces persist incidents that block fresh cleanup and never clear on `DELETE` or clean later metadata.
- Crash recovery re-audits finalized raw surfaces when both recorded session generations match or increments `unauditedRecordsDeleted` without claiming a clean audit (audit, `DELETE`, and absence are monotonic stages, so post-`DELETE` `404` never downgrades an earlier audit, and closed-code stage-accurate diagnostics replace page strings).
- Release requires `DELETE` acknowledgement, `404` on session JSON and all six log APIs, and absence of every declared artifact (including initial `404`s; exhausted waits block the Pixel lease), then releases records, tunnels, fixture, and workspace in order, retaining downstream state on failure while closing the proxy and removing the key config.
