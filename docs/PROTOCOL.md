# Protocol contracts

This specification is for integrators and contributors looking up the wire and HTTP contracts of OMP Session Gateway, the companion to Oh My Pi (OMP). It defines the local OMP discovery files and socket queries, the browser HTTP and Server-Sent Events (SSE) routes, Web Push envelopes, cross-origin admission, and the in-memory collaboration client bootstrap.

Runtime parsers are in `packages/protocol`, and Draft 2020-12 JSON Schemas for emitted responses are in `schemas/`. Across this document, an OMP host (one running `omp` process) publishes local discovery metadata, and a **View** or **Control** link is a bearer secret, called a capability in the contracts.

The shared `parseJsonFrame` tokenizer (`MAX_FRAME_BYTES`, 64 KiB) rejects empty frames, invalid UTF-8, NUL bytes, duplicate object keys, and JSON objects or arrays nested beyond 64 levels.

Display-label parsers reject raw strings above 2,048 UTF-16 code units before NFC normalization and stripping of ASCII control and Unicode bidirectional characters. Normalized labels allow at most 256 Unicode code points for session labels (`MAX_LABEL_CODEPOINTS`) or 1–64 code points for fleet and session-creation labels (`MAX_FLEET_LABEL_CODEPOINTS`).

## 1. OMP discovery directory

What files does stock OMP publish on disk, and how does the gateway read them? Stock mainline OMP `>= 18.1.20` ([PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), commit `4999b98bd5`, [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20)) publishes under `~/.omp/run/collab-hosts` (`%USERPROFILE%\.omp\run\collab-hosts` on Windows).

`PI_CONFIG_DIR` replaces the `.omp` directory name relative to the home directory rather than the full path, and `omp.discoveryDir` selects an explicit path.

The gateway only reads this directory and never creates, writes, renames, or unlinks discovery files or socket endpoints, including leftover entries from exited processes. Each publication writes one `<entryId>.json` file (`entryId` matching `^[a-z0-9-]{8,64}$`, POSIX mode `0600`) once at publication time (`schemas/omp-host-registry.schema.json`, `parseOmpDiscoveryEntry`):

```json
{
  "version": 1,
  "instanceId": "metadata-instance-id",
  "pid": 12345,
  "endpoint": "/home/user/.omp/run/collab-hosts/entry-id.sock",
  "createdAt": 1789862400000,
  "token": "<per-host-query-token>"
}
```

- `version` is parsed as any safe integer `>= 1` by `parseOmpDiscoveryEntry` and `schemas/omp-host-registry.schema.json`, while `OmpHostReader` refuses any `version !== 1` alongside RPC requests and replies whose `v` is not `1`.
- `instanceId` matches `^[a-z0-9-]{8,64}$`, `pid` is an integer in `1`–`2,147,483,647`, and `createdAt` is an integer `>= 0` in epoch milliseconds.
- `endpoint` is a non-empty string without NUL bytes; callers must read `endpoint` from the JSON file rather than deriving it from `entryId` or `pid` because OMP relocates long socket paths ([Discovery and per-host queries](OMP_INTEGRATION.md#2-discovery-and-per-host-queries)).
- `token` matches `^[0-9a-f]{64}$` and authorizes queries to this one OMP host only; discovery files never contain **View** or **Control** capabilities or gateway credentials, and symlinks or non-private permissions are rejected.

OMP evolves registry v1 additively without bumping `version` or `v`: discovery files, snapshots, `model`, and replies may include extra fields, which the gateway ignores while building records from named fields only.

Each poll revisits admitted publications first, scans at most 4,096 directory names, sorts unknown candidates newest-first before reading up to `registry.maxSessions` (default `100`), and caches up to `10 * registry.maxSessions` unchanged dead files (`ENOENT` or `ECONNREFUSED`); see [Mainline OMP discovery reader](ARCHITECTURE.md#11-mainline-omp-discovery-reader) and [Host poller and launch broker](ARCHITECTURE.md#12-host-poller-and-launch-broker).

## 2. Per-host query transport

How does the gateway query a published OMP host? The gateway connects as a client to `endpoint` and exchanges UTF-8 newline-delimited JSON: one newline-terminated request per connection, followed by one single-line reply and an OMP-initiated close. There is no gateway IPC listener, publisher registration, persistent socket stream, or unsolicited metadata push.

Requests are bounded to `MAX_OMP_REGISTRY_REQUEST_BYTES` (4 KiB), responses to `MAX_OMP_REGISTRY_RESPONSE_BYTES` (64 KiB), and connection timeouts to `omp.queryTimeoutMs` (`1500`, 1,500 ms by default).

Every RPC envelope requires `v: 1` (`OMP_REGISTRY_VERSION`). Operational log fields accept only numeric or boolean values, never tokens, endpoints, snapshots, capabilities, or raw transport errors ([Logging, diagnostics, and test artifacts](SECURITY.md#11-logging-diagnostics-and-test-artifacts)).

### `snapshot`

Queries live metadata for one OMP host without requesting a capability (`parseOmpSnapshotReply`).

- Request: `{ "v": 1, "token": "<per-host-query-token>", "op": "snapshot" }`
- Response: `{ ok: true, v: 1, snapshot }`

| Field | Type | Contract |
|---|---|---|
| `instanceId` | `string` (`^[a-z0-9-]{8,64}$`) | OMP host identity; never substitute `pid` alone. |
| `generation` | `integer >= 1` | OMP's session-replacement counter, required on `link` requests. |
| `pid` | `integer` (`1`–`2,147,483,647`) | OS process ID of the OMP host. |
| `sessionId` | `string` (`1`–`256` chars) | Active OMP session identifier (no NUL, CR, or LF). |
| `sessionName` | `string \| null` (optional) | Session title, normalized to `<= 256` code points (`title`). |
| `cwd` | `string \| null` (optional) | Working directory; reduced to its basename (`cwdLabel`). |
| `model` | `{ provider, id } \| null` (optional) | Mapped to `<provider>/<id>` (`<= 256` code points). |
| `startedAt` | `integer` (`0`–`8,640,000,000,000,000`) | Epoch milliseconds; projected to ISO-8601 UTC. |
| `participants` | `integer >= 0` | Connected collaboration participant count. |
| `relayConnected` | `boolean` | Relay socket state; `false` never retires local discovery. |
| `inputRequired` | `boolean` | Attention signal only, with no prompt, options, or answer text. |
| `busy` | `boolean \| null` (optional) | Optional activity flag on OMP `>= 18.2.9`; `null` or omitted means unknown. |
| `access` | `"view" \| "control"` | Shared collaboration role; sets `canControl` (`canView` is always `true`). |

- `generation` is OMP's counter that increments when a session is replaced, preventing a stale card from opening a newer session.
- Neither full filesystem paths nor per-host query tokens enter browser list or SSE responses.
- Non-boolean, non-null `busy` values are rejected as malformed, and any snapshot containing `prompt`, `question`, `options`, `prefill`, `answer`, `requestId`, or `count` is rejected as a privacy violation.

### `link`

Requests one capability from OMP during an explicit authorized **View** or **Control** launch (`parseOmpLinkReply`).

```json
{
  "v": 1,
  "token": "<per-host-query-token>",
  "op": "link",
  "access": "view",
  "generation": 3
}
```

- Request: `access` is `"view"` or `"control"`, and `generation` is the positive integer observed by the browser.
- Response: `{ ok: true, v: 1, url }`, where `url` is 16–8,192 UTF-8 bytes (`MAX_CAPABILITY_BYTES`, 8 KiB) without NUL bytes and is wrapped in `SecretCapability` before returning.
- Revalidation: the launch broker revalidates `generation`, requested access, and any attention `requestId` against `SessionRegistry` both before and after the socket query, and never stores or caches `url`.

### Wire errors

Failed OMP host queries return `{ ok: false, v: 1, error }` with one of eight OMP wire error codes:

| `error` | Meaning |
|---|---|
| `malformed_request` | Request JSON or framing is invalid. |
| `unsupported_protocol` | Request `v` is not `1`. |
| `authentication_failed` | Per-host query `token` was rejected. |
| `snapshot_unavailable` | Host cannot supply a snapshot on this poll. |
| `invalid_operation` | `op` is neither `snapshot` nor `link`. |
| `invalid_access` | `access` is neither `view` nor `control`. |
| `stale_generation` | Requested `generation` does not match the active session. |
| `access_unavailable` | Host does not share the requested `access` mode. |

OMP wire error codes are distinct from gateway HTTP problem codes, and none proves that the OMP host process has exited.

## 3. Polling, liveness, and reconciliation

When does the gateway retain or remove a session card? `registry.heartbeatSeconds` sets the discovery poll interval (default 10 seconds), and concurrent poll triggers share one in-flight round. Successful `snapshot` replies refresh `lastSeenAt` and observation age on a monotonic daemon clock, while `registry.ttlSeconds` (default 35 seconds) must exceed twice `registry.heartbeatSeconds`.

Only `ENOENT` or `ECONNREFUSED` from an endpoint query proves that an OMP host has exited. Timeouts, `EMFILE`, `EACCES`, malformed replies, and OMP wire errors (including `snapshot_unavailable`) are transient: the registry retains an existing card without refreshing its observation timestamp until `registry.ttlSeconds` expires, clearing only `busy` activity knowledge.

Entries absent from both the observed and retained sets are removed during reconciliation, an absent discovery directory is treated as a valid empty directory, and socket close after one reply is normal framing. On daemon startup, the memory-only registry begins empty and repopulates on the first poll ([Host poller and launch broker](ARCHITECTURE.md#12-host-poller-and-launch-broker)).

## 4. Browser HTTP API

Which HTTP routes does `omp-gatewayd` serve, and what rules govern every `/api/` request? Production requests (`auth.mode: "tailscale-serve"`) require a loopback peer (`127.0.0.1`, `::1`, or `::ffff:127.0.0.1`) behind TUN-mode Tailscale Serve and a normalized `Tailscale-User-Login` (`1`–`320` NFC lowercase characters) listed in `auth.allowedLogins` ([Tailnet authorization](SECURITY.md#8-tailnet-authorization)).

Second-hop proxy checks reject requests when `X-Forwarded-For` is multi-hop or outside `100.64.0.0/10` and `fd7a:115c:a1e0::/48`, when `Host` or `X-Forwarded-Host` disagrees with `http.publicOrigin`, or when `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, `CF-Ray`, `X-Forwarded-Server`, or `Tailscale-Funnel-Request` is present. Development mode (`auth.mode: "dev-localhost"`) admits loopback peers matching the configured loopback `http://` origin.

Common route rules (`apps/gateway/src/http.ts`, `apps/gateway/src/http-policy.ts`, `apps/gateway/src/auth.ts`):

- Unconfigured notification routes first: when `notifications` is unset, `/api/v1/notification-feed`, `/api/v1/notification-grants*`, and `/api/v1/push/fleet/*` return `404 not_found` before any `Origin`, query, auth, or `OPTIONS` check (`/api/v1/notification-feed` and `/api/v1/notification-grants*` also return `404` early whenever `notifications.coordinators` is unset, while on a source-only host `/api/v1/push/fleet/*` runs `Origin`, query, auth, and `OPTIONS` checks before returning `404`).
- Origin pre-check and query strings: on every remaining `/api/` route except loopback `GET /api/v1/health`, an `Origin` header that equals neither `http.publicOrigin` nor an admitted cross-origin dashboard origin returns `403 forbidden` without CORS headers before identity checks. Every `/api/` route rejects query parameters with `400 bad_request`.
- Response headers: every `/api/` and `application/problem+json` response carries `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, strict `Permissions-Policy`, and the non-document `Content-Security-Policy` ([Browser controls](SECURITY.md#7-browser-controls)).
- Access logging: server access logs omit query strings, request and response bodies, authorization and identity headers, and launch response sizes.
- Error shape: errors return `Content-Type: application/problem+json` with `{ code, message }` and fixed non-echoing messages; unhandled exceptions return `500 internal_error`. Server-wide request bodies cap at `MAX_FRAME_BYTES` (64 KiB), and oversized or malformed route bodies return `400 bad_request`.
- Same-origin mutations: `POST`, `PUT`, and `DELETE` routes require `Origin` equal to `http.publicOrigin` and `Sec-Fetch-Site` absent or `same-origin` (`requestHasValidMutationContext`, `403 forbidden` otherwise), plus exact case-insensitive `Content-Type: application/json` with no parameters (`415 unsupported_media_type` otherwise).
- Cross-origin mutations: cross-origin `POST` routes require `Origin` in `http.trustedDashboardOrigins` (and in `notifications.coordinators` for grant routes), `Sec-Fetch-Site` absent or in `{same-site, cross-site}`, and exact `Content-Type: application/json` (`requestHasTrustedDashboardContext`, `403 forbidden` otherwise).
- Rate limiting: `LaunchRateLimiter` enforces 20 requests per 60 seconds per normalized identity in each of four buckets (`launch`, `push`, `creation`, `grant`; map capacity `Math.max(4, identityCapacity * 4)` where `identityCapacity` is `auth.allowedLogins.length` or `1` in `dev-localhost` mode), returning `429 rate_limited` when exceeded.

| Method | Path | Purpose | Cross-origin |
|---|---|---|---|
| `GET` | `/api/v1/client-config` | Bootstrap home source, remote targets, and speech opt-in | No |
| `GET` | `/api/v1/sessions` | Read metadata-only session list snapshot | Yes |
| `GET` | `/api/v1/events` | Stream metadata-only directory SSE events | No |
| `POST` | `/api/v1/sessions/:instanceId/launch` | Broker one capability for **View** or **Control** | Yes |
| `GET` | `/api/v1/session-creation-options` | Read Tern creation availability, projects, and profiles | Yes |
| `POST` | `/api/v1/session-creations` | Admit or idempotently replay a Tern creation | Yes |
| `GET` | `/api/v1/session-creations/:operationId` | Read owner-scoped Tern creation status | Yes |
| `GET` | `/api/v1/push/config` | Read public VAPID key and eligible recipient count | No |
| `POST` | `/api/v1/push/subscription` | Register or update caller's Web Push subscription | No |
| `DELETE` | `/api/v1/push/subscription` | Remove caller's Web Push subscription | No |
| `POST` | `/api/v1/push/fleet/status` | Read caller's fleet source enrollment and selection | No |
| `POST` | `/api/v1/push/fleet/grants` | Mint a coordinator grant secret and verifier | No |
| `POST` | `/api/v1/push/fleet/grants/:grantId/activate` | Verify initial source snapshot and activate grant | No |
| `POST` | `/api/v1/push/fleet/grants/:grantId/revoke` | Delete a coordinator grant and close its puller | No |
| `PUT` | `/api/v1/push/fleet/recipient` | Select 1–7 remote alert sources for an endpoint | No |
| `DELETE` | `/api/v1/push/fleet/recipient` | Clear remote alert sources and return to Push v2 | No |
| `POST` | `/api/v1/notification-grants` | Store a 30-day grant verifier on a source | Yes (coordinators) |
| `POST` | `/api/v1/notification-grants/:grantId/renew` | Extend a source grant by 30 days | Yes (coordinators) |
| `POST` | `/api/v1/notification-grants/:grantId/revoke` | Revoke a source grant | Yes (coordinators) |
| `GET` | `/api/v1/notification-feed` | Stream machine-authenticated source SSE feed | No (machine only) |
| `GET` | `/api/v1/health` | Probe loopback readiness and optional HMAC proof | No (loopback only) |

### Directory and launch

These four routes bootstrap the **OMP Sessions** directory, stream live metadata updates, and broker per-tap **View** and **Control** capabilities.

#### `GET /api/v1/client-config`

Returns the public client bootstrap configuration for multi-host polling and opt-in browser speech recognition (`schemas/client-config.schema.json`, `parseClientConfigResponse`).

- Request: Authenticated same-origin `GET` with no query string.
- Response (`200 OK`):

```json
{
  "version": 1,
  "local": {
    "id": "local",
    "label": "studio",
    "origin": "https://studio.example.ts.net"
  },
  "targets": [
    {
      "id": "workstation",
      "label": "Workstation",
      "origin": "https://workstation.example.ts.net"
    }
  ],
  "speech": {
    "browserRecognition": false
  }
}
```

- Projection: `local.id` is `"local"`, `local.origin` equals `http.publicOrigin`, and `local.label` uses `fleet.label`, defaulting to the first DNS label of `http.publicOrigin` or the literal loopback host in `dev-localhost` mode. The payload never includes `auth.allowedLogins`, `http.trustedDashboardOrigins`, paths, tokens, or registry state; browser bootstrap fallback behavior is in [Fleet sources](ARCHITECTURE.md#fleet-sources).
- Errors: `400 bad_request` on query parameters; `403 forbidden` on any foreign `Origin` or unauthorized identity.
- Limits: Serialized body bounded to `MAX_CLIENT_CONFIG_BYTES` (32 KiB), with at most 7 `targets` (`MAX_FLEET_TARGETS`, 8 sources total) having unique `id` (`^[a-z][a-z0-9-]{0,31}$`, excluding `"local"`), `label` (`1`–`64` code points), and canonical `origin` (`<= 256` characters).

#### `GET /api/v1/sessions`

Returns the current metadata-only session directory snapshot (`schemas/session-list.schema.json`, `parseSessionListResponse`).

- Request: Authenticated same-origin or trusted cross-origin `GET` with no query string.
- Response (`200 OK`):

```json
{
  "revision": 42,
  "sessions": [
    {
      "instanceId": "0190d9ad-example",
      "generation": 3,
      "title": "Fix payment retry logic",
      "cwdLabel": "checkout-service",
      "model": "provider/model",
      "startedAt": "2026-07-19T16:25:00.000Z",
      "lastSeenAt": "2026-07-19T16:25:20.000Z",
      "canView": true,
      "canControl": true,
      "inputRequired": true,
      "busy": false,
      "ask": {
        "requestId": "opaque-in-memory-request-id",
        "since": "2026-07-19T16:25:18.000Z"
      }
    }
  ]
}
```

- Optional `busy` (`boolean`) is included when the OMP host reports boolean activity and omitted when activity is unknown.
- `ask` is required when `inputRequired` is `true` and forbidden when `false`: `requestId` (`^[A-Za-z0-9_-]{16,128}$`, `<= 128` UTF-8 bytes) is opaque routing metadata minted by the gateway, `since` is daemon receipt ISO-8601 time, and optional `preview` (`<= 256` code points) and `optionCount` (`1`–`128`) are omitted for stock OMP hosts because stock OMP snapshots carry boolean `inputRequired` only.
- Optional `qualificationPushAlias` (`integer >= 1`, forbidden when `inputRequired` is `false`) is an opaque qualification-log append index for the active `ask`, emitted only when the daemon runs with `--qualification-log-dir`.
- Responses never contain capabilities, room keys, write tokens, relay secrets, per-host query tokens, readiness tokens, transcripts, answers, tool output, or full filesystem paths.
- Errors: `400 bad_request` on query parameters; `403 forbidden` on disallowed `Origin` or unauthorized identity.
- Limits: At most 1,000 sessions (`MAX_SESSIONS`); `revision >= 0`; `startedAt`, `lastSeenAt`, and `ask.since` up to 64 characters; `title`, `cwdLabel`, and `model` up to 256 normalized code points each.

#### `GET /api/v1/events`

Streams metadata-only directory changes over Server-Sent Events (`schemas/sse-event.schema.json`, `parseSessionEvent`).

- Request: Authenticated same-origin `GET` with no query string.
- Response (`200 OK`): `Content-Type: text/event-stream; charset=utf-8` with `Connection: keep-alive` and `X-Accel-Buffering: no`. Each stream starts with `snapshot` (`{ type: "snapshot", revision, sessions }`), followed by `session_upsert`, `session_remove`, and `keepalive` (`data: {}`) every 5 seconds (`SSE_KEEPALIVE_MS`), which re-verifies the Tailscale Serve tunnel interface and proves HTTP liveness rather than OMP host freshness.
- Errors: `400 bad_request` on query parameters; `403 forbidden` on any foreign `Origin` or unauthorized identity.
- Limits: Stream closes when backpressure drops `desiredSize` below `-32` (`highWaterMark: 32`).

#### `POST /api/v1/sessions/:instanceId/launch`

Brokers one generation-bound **View** or **Control** capability from the owning OMP host (`schemas/launch-request.schema.json`, `schemas/launch-response.schema.json`, `parseLaunchRequest`, `parseLaunchResponse`).

- Request: Authenticated same-origin or trusted cross-origin `POST` with no query string, URL-decoded `:instanceId` matching `^[a-z0-9-]{8,64}$` (encoded segment `1`–`384` characters), `Content-Type: application/json`, and body:

```json
{
  "mode": "view",
  "generation": 3
}
```

- Request-specific **Control** launches include optional `"requestId": "<opaque-request-id>"` (rejected when `mode` is `"view"`), which the gateway revalidates alongside `generation` as routing correlation rather than authorization.
- Response (`200 OK`, secret-bearing):

```json
{
  "mode": "view",
  "generation": 3,
  "capability": "<opaque-omp-collaboration-capability>"
}
```

- Consumed once in JavaScript memory; never cached, persisted, logged, traced, retried by a service worker, or written into the DOM.
- Errors:
  - `400 bad_request`: query parameters, invalid `:instanceId` within the `1`–`384`-character segment, malformed or oversized JSON body, unknown keys, or `requestId` with `mode: "view"`.
  - `403 forbidden`: unauthorized identity, invalid `Origin` or `Sec-Fetch-Site`, or cross-origin `POST` without exact `Content-Type: application/json`.
  - `404 not_found`: unknown, removed, or TTL-expired session (or encoded `:instanceId` longer than 384 characters).
  - `409 generation_mismatch`: `generation` does not match the current OMP host generation.
  - `409 request_mismatch`: `requestId` does not match the session's current actionable request.
  - `409 mode_unavailable`: OMP host does not share the requested `mode`.
  - `415 unsupported_media_type`: same-origin `POST` without `Content-Type: application/json`.
  - `429 rate_limited`: per-identity `launch` rate limit exceeded.
- Limits: Request body bounded to 4 KiB (`4,096` bytes); `capability` is 16–8,192 UTF-8 bytes; rate limited per identity only (`identityKey + "\0launch"`, 20 requests per 60 seconds, with no per-session limiter).

### Session creation

When `tern` is configured on an execution host ([ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption)), these three routes list approved creation choices, admit idempotent creation operations, and report committed operation state before an ordinary **Control** launch.

#### Session creation DTO rules

Every creation payload and nested object enforces `requireExactKeys` and rejects unknown keys, duplicate JSON keys, `null` substitutions, invalid state/field combinations, and byte-bound overflows (`packages/protocol`, `schemas/session-creation-*.schema.json`):

| DTO | Field | Type and constraint | Bound |
|---|---|---|---|
| `SessionCreationOptions` | `version`, `revision` | Literal `1`; lowercase UUIDv4 per daemon lifetime | `<= 64` KiB |
| `SessionCreationOptions` | `available`, `reason?` | `boolean`; `reason` required iff `available === false` | — |
| `SessionCreationOptions` | `projects`, `profiles` | `[]` when unavailable; else `1`–`16` projects (`1`–`8` copies), `1`–`8` profiles | — |
| `SessionCreationRequest` | `clientOperationId`, `revision` | Lowercase UUIDv4 per **Create** tap; options `revision` UUIDv4 | `<= 4` KiB |
| `SessionCreationRequest` | `projectId`, `workingCopyId`, `profileId` | Choice IDs matching `^[a-z][a-z0-9-]{0,31}$` (`"local"` allowed) | — |
| `SessionCreationReceipt` | `operationId`, `state` | Daemon UUIDv4; `"accepted"` (`202`) or current state (`200`) | `<= 2` KiB |
| `SessionCreationStatus` | `operationId`, `state`, `updatedAt` | Daemon UUIDv4; `SessionCreationState`; UTC `YYYY-MM-DDTHH:mm:ss.sssZ` | `<= 2` KiB |
| `SessionCreationStatus` | `session?`, `error?` | `session` iff `"ready"`; `error` iff terminal non-ready state | — |

- `reason` (when `available` is `false`) is `"not_configured"`, `"configuration_unavailable"`, `"tern_unavailable"`, or `"ledger_unavailable"`.
- Project and profile `id` values are unique within their arrays, working-copy `id` values are unique within each project, and choice `label` values are `1`–`64` normalized code points.
- `session` (when `state` is `"ready"`) is `{ instanceId, generation }` (`instanceId` matching `^[a-z0-9-]{8,64}$`, `generation` in `1`–`9,007,199,254,740,991`).
- Public options expose only choice IDs and display labels, never filesystem paths, executables, `argv`, or `env`; receipts, statuses, and problem bodies never echo labels, paths, `argv`, `env`, drafts, raw CLI output, or capabilities.

#### `GET /api/v1/session-creation-options`

Returns Tern creation availability and configured project, working-copy, and profile choices (`schemas/session-creation-options.schema.json`, `parseSessionCreationOptions`).

- Request: Authenticated same-origin or trusted cross-origin `GET` with no query string.
- Response (`200 OK`):

```json
{
  "version": 1,
  "revision": "14f3cfa2-c391-4ada-91f0-e486fd5bfccc",
  "available": true,
  "projects": [
    {
      "id": "website",
      "label": "Website",
      "workingCopies": [{ "id": "main", "label": "main" }]
    }
  ],
  "profiles": [{ "id": "omp", "label": "OMP" }]
}
```

- Restarting the daemon mints a fresh random `revision` UUIDv4 without exposing a configuration hash.
- When `available` is `false`, `200 OK` returns `projects: []`, `profiles: []`, and `reason`: `not_configured` (`config.tern` absent), `configuration_unavailable` (`config.tern` is `{}` or path checks failed), `tern_unavailable` (`tern inspect --json` failed or daemon stopping), or `ledger_unavailable` (`<stateDir>/session-creations.json` invalid or unreadable).
- Errors: `400 bad_request` on query parameters; `403 forbidden` on disallowed `Origin` or unauthorized identity.
- Limits: Response bounded to 64 KiB (`MAX_SESSION_CREATION_OPTIONS_BYTES`); availability probes coalesce and cache for 5 seconds, reusing cached availability while an active creation holds the single Tern CLI slot.

#### `POST /api/v1/session-creations`

Admits a new Tern session creation operation or replays an unexpired receipt for the same caller (`schemas/session-creation-request.schema.json`, `parseSessionCreationRequest`, `parseSessionCreationReceipt`).

- Request: Authenticated same-origin or trusted cross-origin `POST` with no query string, `Content-Type: application/json`, and body:

```json
{
  "clientOperationId": "4e86bd6c-f68a-4d96-8f34-bb7d67cdbe58",
  "revision": "14f3cfa2-c391-4ada-91f0-e486fd5bfccc",
  "projectId": "website",
  "workingCopyId": "main",
  "profileId": "omp"
}
```

- Idempotent replay (`200 OK`): inside one serialized admission section, an unexpired record matching normalized identity + `clientOperationId` (independent of `Origin`) with an identical payload returns `200 OK` `{ "operationId": "<uuid-v4>", "state": "<current-state>" }` before checking `revision`, availability, busy state, or rate limits.
- New admission (`202 Accepted`): persists `accepted` to `<stateDir>/session-creations.json` before returning `202 { "operationId": "<uuid-v4>", "state": "accepted" }`. Browser disconnect, request abort, or closing the tray never cancels an accepted operation, and no cancel or `DELETE` route exists.
- Errors: `400 bad_request` (query string, invalid/oversized JSON, or unknown choice ID); `403 forbidden` (unauthorized identity, invalid mutation context, or cross-origin `Content-Type`); `409 operation_conflict` (replayed `clientOperationId` with any changed field); `409 revision_mismatch` (stale `revision`); `415 unsupported_media_type`; `429 creation_busy` (another operation is nonterminal); `429 rate_limited`; `503 tern_unavailable`, `503 creation_capacity`, or `503 ledger_unavailable`.
- Limits: Request bounded to 4 KiB (`MAX_SESSION_CREATION_REQUEST_BYTES`), receipt to 2 KiB (`MAX_SESSION_CREATION_STATUS_BYTES`), at most 1 nonterminal operation globally, at most 64 unexpired ledger records, and 20 new admissions per 60 seconds per identity (`identityKey + "\0creation"`).

#### `GET /api/v1/session-creations/:operationId`

Returns committed owner-scoped status for one creation operation without invoking Tern (`schemas/session-creation-status.schema.json`, `parseSessionCreationStatus`).

- Request: Authenticated same-origin or trusted cross-origin `GET` with no query string and `:operationId` matching lowercase UUIDv4 (`SESSION_CREATION_UUID_PATTERN`).
- Response (`200 OK`):

```json
{
  "operationId": "703e065e-793f-41ab-9ead-00ff6bdcfd72",
  "state": "ready",
  "updatedAt": "2026-10-24T23:59:00.000Z",
  "session": { "instanceId": "example-instance", "generation": 1 }
}
```

| `state` | Required state-specific field | Forbidden fields |
|---|---|---|
| `accepted`, `launching`, `awaiting_omp` | None | `session`, `error` |
| `ready` | `session: { instanceId, generation }` | `error` |
| `failed` | `error: "preflight_failed" \| "spawn_failed" \| "interrupted"` | `session` |
| `started_unavailable` | `error: "adoption_timeout" \| "correlation_ambiguous" \| "control_unavailable" \| "interrupted"` | `session` |
| `outcome_unknown` | `error: "launch_outcome_unknown" \| "interrupted"` | `session` |

- Ownership binds to the normalized authorized identity rather than `Origin`, so the same identity can read status from another trusted dashboard.
- Errors: `400 bad_request` on query parameters; `403 forbidden` on disallowed `Origin` or unauthorized identity; `404 not_found` on unknown, expired, non-UUIDv4, or foreign `:operationId`; `503 ledger_unavailable` on unreadable or invalid ledger state.
- Limits: Response bounded to 2 KiB (`MAX_SESSION_CREATION_STATUS_BYTES`).

#### Session creation state machine

Every state transition is durably written and `fsync`-committed to `<stateDir>/session-creations.json` before becoming visible over HTTP or triggering its external action (`apps/gateway/src/tern-creation.ts`):

| From | To | Trigger or error |
|---|---|---|
| none | `accepted` | Valid new request committed before `202` and before preflight or spawn. |
| `accepted` | `launching` | Path checks, discovery baseline, and `tern inspect` succeed within 10 s; committed before spawn. |
| `accepted` | `failed` | `preflight_failed` on preflight failure/timeout; `interrupted` on shutdown or startup recovery. |
| `launching` | `awaiting_omp` | `tern new tab` exits `0` (10 s, 8 KiB) with a new local `block < 2^56`; block ID committed. |
| `launching` | `failed` | `spawn_failed` when OS process creation fails before a child exists. |
| `launching` | `outcome_unknown` | `launch_outcome_unknown` on lost/bad stdout, non-zero exit, timeout, or baseline block; `interrupted` on restart. |
| `awaiting_omp` | `ready` | Unique 1:1 Tern block/pane match and fresh **Control**-authorized OMP binding adopted. |
| `awaiting_omp` | `started_unavailable` | `correlation_ambiguous`, `control_unavailable` (`view`-only at deadline), `adoption_timeout` (110 s), or `interrupted`. |

- Adoption polls `tern inspect --json` every 1 second (5 s / 1 MiB bound) and post-spawn OMP discovery (`refreshForAdoption`) until one local `block === blocks[].id === panes[].pane` has an `omp_session_file` basename `<sessionId>` token matching a single fresh OMP host (`startedAt` and `createdAt` at or after `tern new tab` spawn time, outside baseline IDs) authorized for `control` ([Opt-in creation and adoption](OMP_INTEGRATION.md#opt-in-creation-and-adoption)).
- Optional `tern.window` (`""` or `"2"`–`"999"`) adds `--window <KEY>` to every `inspect` and `new tab` subprocess without exposing a wire field or falling back to another window: missing window slots report `tern_unavailable` in options or `failed` (`preflight_failed`) before spawn, and closed windows during adoption end at `started_unavailable` (`adoption_timeout`).
- Terminal states (`ready`, `failed`, `started_unavailable`, `outcome_unknown`) are immutable, total daemon execution is bounded to 110 seconds on a monotonic clock from acceptance, and `ready` returns `{ instanceId, generation }` so the browser refreshes the source and calls `POST /api/v1/sessions/:instanceId/launch` (`mode: "control"`).

#### Creation retention, errors, and browser watching

- Ledger retention (`<stateDir>/session-creations.json`): version 1, bounded to 64 records and 512 KiB, retained for 24 hours from `createdAt`; expired terminal records are pruned on startup and before new admissions, and unexpired records are never evicted.
- HTTP problem codes vs terminal `status.error`: terminal operation errors travel inside `200 OK` `SessionCreationStatus` responses; HTTP `application/problem+json` codes cover request, admission, and ledger failures:

| HTTP status | `code` | Routes | Condition |
|---|---|---|---|
| `400` | `bad_request` | Options, Creations, Status | Query string, bad/oversized JSON, unknown key, or invalid UUID/choice ID. |
| `403` | `forbidden` | All creation routes, `OPTIONS` | Disallowed identity, `Origin`, `Sec-Fetch-Site`, or cross-origin `Content-Type`. |
| `404` | `not_found` | Status `GET` | Unknown, expired, non-UUIDv4 `:operationId`, or another caller's operation. |
| `409` | `operation_conflict` | Creations `POST` | Replayed `clientOperationId` with a changed field (including `revision`). |
| `409` | `revision_mismatch` | Creations `POST` | New `clientOperationId` with a stale options `revision`. |
| `415` | `unsupported_media_type` | Creations `POST` | Same-origin `POST` without `Content-Type: application/json`. |
| `429` | `rate_limited` | Creations `POST` | Per-identity `creation` rate limit (`20/min`) exceeded. |
| `429` | `creation_busy` | Creations `POST` | Another creation operation is nonterminal. |
| `503` | `tern_unavailable` | Creations `POST` | `tern` unconfigured, runtime/inspect failed, or daemon stopping. |
| `503` | `creation_capacity` | Creations `POST` | Ledger holds 64 unexpired operations. |
| `503` | `ledger_unavailable` | Creations `POST`, Status `GET` | Ledger validation, read, or atomic write failed. |
| `500` | `internal_error` | All routes | Unhandled server exception boundary. |

- Browser watching: the browser never retries `POST /api/v1/session-creations` automatically; it polls status serially and holds at most one capability-free paused intent in memory so **Check creation** can inspect status or explicitly replay the identical `clientOperationId` ([OMP Sessions PWA](ARCHITECTURE.md#14-omp-sessions-pwa), [Creating a session in Tern](../apps/web/README.md#creating-a-session-in-tern)).

### Background alerts

These routes configure per-device Web Push subscriptions on the home gateway and define Push v2 (`version: 2`) notification envelopes and tap routes.

#### `GET /api/v1/push/config`

Returns the public half of the installation's VAPID key pair and the gateway-global eligible recipient count (`parsePushConfigResponse`).

- Request: Authenticated same-origin `GET` with no query string.
- Response (`200 OK`):

```json
{
  "version": 2,
  "applicationServerKey": "<url-safe-P-256-public-key>",
  "subscriptionCount": 1
}
```

- `applicationServerKey` is 80–128 base64url characters, and `subscriptionCount` (`0`–`8`) counts stored unexpired subscriptions whose owner login remains allowed globally on the gateway without exposing endpoints, keys, or identities. The VAPID private key never leaves `<stateDir>/push-state.json` and daemon memory.
- Errors: `400 bad_request` on query parameters; `403 forbidden` on foreign `Origin` or unauthorized identity.
- Limits: `subscriptionCount` is an integer in `0`–`8`.

#### `POST /api/v1/push/subscription`

Registers or updates (`POST`) or removes (`DELETE`) a browser Web Push subscription on `/api/v1/push/subscription` (`parsePushSubscriptionRequest`, `parsePushSubscriptionResponse`, `parsePushUnsubscribeRequest`).

- Request (`POST`): Authenticated same-origin mutation with no query string, `Content-Type: application/json`, and body:

```json
{
  "version": 2,
  "detailLevel": "session",
  "subscription": {
    "endpoint": "https://push.example.invalid/send/device",
    "expirationTime": null,
    "keys": {
      "p256dh": "<browser-public-key>",
      "auth": "<browser-auth-secret>"
    }
  }
}
```

- `detailLevel` is `"private"`, `"session"`, or `"preview"` (optional on `POST`: new subscriptions explicitly send `"session"`, and omitting `detailLevel` on re-registration preserves the endpoint's stored level). `endpoint` must be a canonical `https://` URL without credentials or fragment; `expirationTime` is `null`, omitted, or a non-negative safe integer; `p256dh` is 80–128 base64url characters and `auth` is 20–64 base64url characters.
- Request (`DELETE /api/v1/push/subscription`): Same-origin mutation with `Content-Type: application/json` and `{ "version": 2, "endpoint": "..." }`.
- Response: `POST` returns `200 OK` `{ "version": 2, "detailLevel": "private" | "session" | "preview" }` after persisting to `<stateDir>/push-state.json` (VAPID keys, endpoints, transport keys, owner identity, and detail level only) and queuing active **Control**-capable requests. `DELETE` returns `204 No Content`; browser unsubscribe is authoritative, and push-service `404` or `410` responses evict matching delivery targets.
- Errors: `400 bad_request` on query parameters, invalid/oversized JSON, or invalid fields; `403 forbidden` on unauthorized identity or invalid same-origin context; `409 subscription_rejected` (`POST` at the 8-subscription cap or on write failure); `415 unsupported_media_type`; `429 rate_limited`.
- Limits: Request body bounded to 8 KiB (`MAX_PUSH_SUBSCRIPTION_BYTES`), `endpoint` bounded to 4 KiB (`MAX_PUSH_ENDPOINT_BYTES`), at most 8 stored subscriptions (`MAX_PUSH_SUBSCRIPTIONS`), and 20 requests per 60 seconds per identity (`identityKey + "\0push"`).

#### Web Push notification envelopes

For subscriptions without remote fleet sources selected, the encrypted Web Push payload (`aes128gcm`, `urgency: "high"`, `TTL: 300` seconds, 10-second send timeout, no `Topic` header, VAPID `sub` set to `https://github.com/carrythroughsystems/omp-session-gateway` so Apple push servers accept the JWT) is one of three Push v2 shapes (`parseAttentionPushMessage`):

```json
{
  "version": 2,
  "type": "attention",
  "instanceId": "metadata-instance-id",
  "generation": 3,
  "requestId": "opaque-in-memory-request-id",
  "pendingAskCount": 2,
  "title": "OMP session needs attention",
  "body": "Fix payment retry logic · checkout-service"
}
{
  "version": 2,
  "type": "activity_stop",
  "instanceId": "metadata-instance-id",
  "generation": 3,
  "pendingAskCount": 0,
  "title": "OMP session activity stopped",
  "body": "Fix payment retry logic · checkout-service"
}
{
  "version": 2,
  "type": "clear",
  "instanceId": "metadata-instance-id",
  "requestId": "opaque-in-memory-request-id",
  "pendingAskCount": 1
}
```

- `pendingAskCount` is `0`–`1,000` (`MAX_PUSH_PENDING_COUNT`). Presentation fields are built at send time (`<= 256` code points with Private Use Area glyphs stripped) and never persisted: `body` is omitted at `private`, and `preview` falls back to `session` when `ask.preview` is absent (`activity_stop` has no `requestId` and uses `session` at `preview`).
- Service-worker notification `data` (`parseNotificationData`) contains `{ version: 2, type: "attention", instanceId, requestId }` or `{ version: 2, type: "activity_stop", instanceId, generation }`.
- Fallback click routes (`parseNotificationRoute`) are `GET /collab/:instanceId?request=:requestId` (**Control**) and `GET /collab/:instanceId?activity=stopped&generation=:generation` (read-only **View**). Valid routes serve the `no-store` `/` shell and scrub to `/` before networking; duplicate, mixed, extra, fragment-bearing, or malformed parameters are rejected (`400 bad_request`), and capabilities never enter push payloads, notification data, routes, worker messages, or history.
- Pacing, tag replacement, badge updates, stop triggers, and click revalidation semantics are specified in [Notification lifecycle](ATTENTION_SPEC.md#notification-lifecycle), [Activity-stop notifications](ATTENTION_SPEC.md#activity-stop-notifications), and [Notification tap](ATTENTION_SPEC.md#notification-tap).

### Fleet notifications

For fleet notifications — where the home gateway serving the installed app (the coordinator) sends background Web Push alerts for selected remote hosts, called sources ([ADR-048](DECISIONS.md#adr-048--fleet-notifications-through-the-home-gateway-as-coordinator)) — HTTP bodies carry `version: 1`, fleet pushes carry `version: 3`, and devices with no remote source selected remain on Push v2. Every object is validated with exact keys and byte bounds in `packages/protocol`.

- Role configuration and `404` gating: `notifications` is optional in `config.json`. Coordinator routes (`/api/v1/push/fleet/*`) are same-origin only and answer `404 not_found` unless `notifications.sources` is configured (before `Origin` and `OPTIONS` checks when `notifications` is absent, and after same-origin auth checks when only `notifications.coordinators` is set). Source grant and feed routes answer `404 not_found` unless `notifications.coordinators` is configured.

Coordinator routes (same-origin, owner-authenticated, `Content-Type: application/json`, per-identity `push` rate limit of `20/min`; `503 fleet_unavailable` if `<stateDir>/fleet-notifications.json` is unhealthy):

| Method and path | Request | Response | Body bound |
|---|---|---|---|
| `POST /api/v1/push/fleet/status` | `{ version: 1, endpoint? }` | `200 { version: 1, sources }` (`<= 8` KiB) | `8` KiB |
| `POST /api/v1/push/fleet/grants` | `{ version: 1, sourceId }` | `201 { version: 1, grantId, verifier }` | `4` KiB |
| `POST /api/v1/push/fleet/grants/:grantId/activate` | `{ version: 1 }` | `204` after initial feed snapshot | `4` KiB |
| `POST /api/v1/push/fleet/grants/:grantId/revoke` | `{ version: 1 }` | `204` | `4` KiB |
| `PUT /api/v1/push/fleet/recipient` | `{ version: 1, endpoint, sources }` | `200 { version: 1, sources, released }` | `8` KiB |
| `DELETE /api/v1/push/fleet/recipient` | `{ version: 1, endpoint }` | `200 { version: 1, sources: [], released }` | `8` KiB |

- The three coordinator routes carrying a push `endpoint` (`status` and `PUT`/`DELETE` `recipient`) accept up to 8 KiB (`MAX_FLEET_REQUEST_BYTES + MAX_PUSH_ENDPOINT_BYTES`); the three grant routes accept up to 4 KiB (`MAX_FLEET_REQUEST_BYTES`). Invalid JSON or schema mismatches return `400 bad_request`, invalid same-origin context returns `403 forbidden`, wrong media type returns `415 unsupported_media_type`, and rate-limit overflow returns `429 rate_limited`.
- `status` returns `{ version: 1, sources: [{ sourceId, state, selected, grantId?, expiresAt? }] }` (`409 subscription_required` if `endpoint` is not an active caller subscription), where `state` is `"not_enrolled"`, `"pending"`, `"current"`, `"stale"`, `"unauthorized"`, or `"unsupported"`.
- `grantId` appears in every `status` row except `"not_enrolled"` (absent) and `"unsupported"` (optional), and `"current"` and `"stale"` include `expiresAt` from the source feed. Coverage is separate from browser notification permission, and a disconnected or uncovered source never produces an **All clear** state ([Fleet notifications in ATTENTION_SPEC](ATTENTION_SPEC.md#fleet-notifications)).
- `grants` (`POST`) requires a configured `sourceId` (`400 bad_request`), an active caller subscription (`409 subscription_required`), and coordinator capacity (`<= 32` grants, `503 grant_capacity`). `grantId` is a lowercase UUIDv4, `secret` is 256 random bits kept only at the coordinator, and `verifier` is the 43-character unpadded base64url SHA-256 of `"omp-fleet-grant-v1" ‖ 0x00 ‖ grantId ‖ 0x00 ‖ secret`.
- `activate` waits up to 5 seconds for the source's first feed `snapshot` to verify the grant and returns `204`, or fails with:
  - `409 grant_rejected`: the grant is unknown or unowned at the coordinator, the caller lacks an active push subscription, the source feed rejected the bearer token (`401`), or the feed `snapshot` had an owner-digest mismatch or expired `expiresAt`;
  - `503 source_unreachable`: the coordinator could not reach the source feed, hit a stream error, or received no initial `snapshot` within 5 seconds;
  - `404 unsupported`: the source answered `404` on `GET /api/v1/notification-feed` because fleet source alerts are not configured there.
- `recipient` (`PUT`/`DELETE`) requires an active caller `endpoint` (`409 subscription_required`) and at most 8 fleet recipients (`503 recipient_capacity`); `PUT` `sources` names `1`–`7` distinct remote `sourceId`s, never `"local"`, and `DELETE` returns the subscription to Push v2.
- Disabling or deselecting the last device of an owner that selects a source discards that owner's grant secret, closes its feed puller, and reports `{ sourceId, grantId }` in `released` for browser-direct revocation at the source (30-day expiry covers unreachable sources).

Source grant routes (browser-direct cross-origin `POST` from an origin in both `http.trustedDashboardOrigins` and `notifications.coordinators`, authenticated from the source's own Tailscale Serve `Tailscale-User-Login`, per-identity `grant` rate limit of `20/min`, 4 KiB body bound):

- `POST /api/v1/notification-grants`: `{ version: 1, grantId, verifier }` -> `201 { version: 1, grantId, expiresAt }`. A source keeps one grant per normalized owner and coordinator origin (replacing any prior grant for that pair and closing its stream), expires grants 30 days after creation or renewal, prunes expired entries before checking the 16-grant cap (`503 grant_capacity`), and returns `409 grant_rejected` if `grantId` belongs to another owner or coordinator.
- `POST /api/v1/notification-grants/:grantId/renew`: `{ version: 1 }` -> `200 { version: 1, grantId, expiresAt }` (`401 unauthorized` if the grant is missing or belongs to another owner or coordinator).
- `POST /api/v1/notification-grants/:grantId/revoke`: `{ version: 1 }` -> `204` whether or not the grant exists, answering success only after the change is persisted to `<stateDir>/notification-grants.json`. Corrupt or unwritable source state returns `503 grants_unavailable` on all source routes.

Source machine feed (`GET /api/v1/notification-feed`):

- Request and admission: machine-only `GET` with no query string (`400 bad_request` otherwise) and `Authorization: Bearer <grantId>.<secret>`. It refuses any `Origin` or `Sec-Fetch-*` header with `403 forbidden` and never reads `Tailscale-User-Login`.
- Feed authorization and limits: requires a loopback peer and measured Tailscale TUN interface without second-hop proxy headers, returning `401 unauthorized` on invalid/expired/revoked credentials, `429 rate_limited` above `20/min` per `grantId`, or `503 grants_unavailable`.
- Response (`200 OK`, `text/event-stream; charset=utf-8`): emits `: heartbeat` comments every 15 seconds, waits until the source's discovery poller completes a healthy round before sending the initial authoritative `snapshot`, and closes if its 256-event queue overflows. Each `data` line matches `event: <type>` and is bounded to 260,096 bytes (`MAX_SESSIONS × 256 + 4 KiB`, `parseFleetFeedEvent`):

```json
{ "version": 1, "type": "snapshot", "owner": "<43-char owner digest>", "expiresAt": "2026-12-07T00:00:00.000Z", "sessions": [{ "instanceId": "metadata-instance-id", "generation": 3, "requestId": "opaque-request-id" }] }
{ "version": 1, "type": "upsert", "session": { "instanceId": "metadata-instance-id", "generation": 3 } }
{ "version": 1, "type": "remove", "instanceId": "metadata-instance-id", "generation": 3 }
{ "version": 1, "type": "stop", "instanceId": "metadata-instance-id", "generation": 3 }
```

- `requestId` is present iff the session is waiting and **Control**-capable, `stop` is live-only, and `owner` is the 43-character base64url SHA-256 of `"omp-fleet-owner-v1" ‖ 0x00 ‖ coordinatorOrigin ‖ 0x00 ‖ login`.

Fleet push envelopes (`version: 3`, `parseFleetPushMessage`, under 3 KiB JSON, high urgency, 5-minute TTL, no `Topic`):

```json
{ "version": 3, "type": "attention", "source": "xeffoL_kxqTcht3AiIR0FT", "instanceId": "aaaa1111bbbb2222", "generation": 3, "requestId": "req_0123456789abcdef", "seq": { "epoch": 7, "n": 42 }, "badge": { "count": 2, "complete": true }, "title": "OMP session needs attention", "body": "Studio · bb2222" }
{ "version": 3, "type": "activity_stop", "instanceId": "aaaa1111bbbb2222", "generation": 3, "seq": { "epoch": 7, "n": 43 }, "badge": { "count": 2, "complete": true }, "title": "OMP session activity stopped" }
{ "version": 3, "type": "clear", "source": "xeffoL_kxqTcht3AiIR0FT", "instanceId": "aaaa1111bbbb2222", "generation": 3, "requestId": "req_0123456789abcdef", "seq": { "epoch": 7, "n": 44 }, "badge": { "count": 1, "complete": true } }
```

- `source` is omitted for coordinator-local sessions and otherwise holds the 22-character base64url prefix of the SHA-256 of `"omp-fleet-binding-v1" ‖ 0x00 ‖ sourceId ‖ 0x00 ‖ origin`.
- `seq.epoch` persists across coordinator restarts (`max(previous + 1, current Unix seconds)`) with one coordinator-wide `seq.n` counter per epoch; `badge.count` (`0`–`8,000`) counts known waiting **Control**-capable requests across selected sources, and `badge.complete` is `false` whenever any selected source is not `"current"`.
- `body` is omitted at `private`; otherwise remote alerts format `<configured source label> · <last 6 chars of instanceId>` (checked with `parseFleetPushMessage(payload, remoteLabels)` before sending) and local alerts prefix `fleet.label` before local `session` detail.
- Fleet notification `data` is `{ version: 3, type, source?, instanceId, requestId }` or `{ version: 3, type, source?, instanceId, generation }`, and fallback tap routes append `&source=<binding>` for remote sources; ordering rules are in [Ordering and restart](ATTENTION_SPEC.md#ordering-and-restart).
- Worker `postMessage` support and mode (`apps/web/src/service-worker.ts`): `{ type: "omp-notification-support-request", version: 2 | 3 }` over a `MessageChannel` replies `{ type: "omp-notification-support-response", version, received? }` (`received` on `version: 3`), and `{ type: "omp-notification-mode", version: 3, fleet: boolean }` replies `omp-notification-mode-set` or `omp-notification-mode-failed`.
- Worker `postMessage` reconcile (`parseFleetReconcileMessage`): `{ type: "omp-notification-reconcile", version: 3, asOf: { received }, fresh, pending, counted, complete }` supplies unique `"local"` or 22-character binding arrays (`fresh` a subset of `counted`), `pending` `{ source?, instanceId, generation, requestId }` entries belonging to `fresh` (`<= 8,000`), and boolean `complete`.

### `GET /api/v1/health`

Probes loopback process and discovery-directory readiness, with optional instance-bound HMAC verification for `omp-gateway` lifecycle commands.

- Request: Loopback-only `GET` (`127.0.0.1`, `::1`, or `::ffff:127.0.0.1`) with no query string, no Tailscale identity requirement, and optional `X-OMP-Readiness-Challenge: <43-char base64url>` (`^[A-Za-z0-9_-]{43}$`). Loopback `GET /api/v1/health` is exempt from the foreign-`Origin` `403` pre-check, and never emits CORS headers.
- Response (`200 OK`): `{ "status": "ready" | "degraded" }` without a challenge, or `{ "status": "ready" | "degraded", "proof": "<43-char base64url HMAC>", "instance"?: "<startup-nonce>" }` when challenged, where `proof` is `HMAC-SHA256(readinessToken, challenge + "\0" + (readinessInstance ?? ""))` and `instance` appears when `--readiness-instance` is non-empty.
- Readiness scope: `status` is `"ready"` when `omp.discoveryDir` is usable or absent and `"degraded"` when unsafe or unreadable; responses never expose paths, counts, identities, or tokens, and `readiness-token` is never shared with OMP.
- Errors: `400 bad_request` on query parameters, malformed `X-OMP-Readiness-Challenge`, or challenge sent when `readinessToken` is unset; `403 forbidden` on a non-loopback peer or non-`GET` with foreign `Origin`.
- Limits: `X-OMP-Readiness-Challenge` must be 43 base64url characters (256 bits).

### Cross-origin access

When `http.trustedDashboardOrigins` configures 1–8 canonical origins, the gateway admits browser-direct CORS requests from those exact origins on eight route and method pairs ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors)):

1. `GET /api/v1/sessions`
2. `POST /api/v1/sessions/:instanceId/launch`
3. `GET /api/v1/session-creation-options`
4. `POST /api/v1/session-creations`
5. `GET /api/v1/session-creations/:operationId` (exact lowercase UUIDv4)
6. `POST /api/v1/notification-grants` (origin must also appear in `notifications.coordinators`)
7. `POST /api/v1/notification-grants/:grantId/renew` (exact lowercase UUIDv4; origin also in `notifications.coordinators`)
8. `POST /api/v1/notification-grants/:grantId/revoke` (exact lowercase UUIDv4; origin also in `notifications.coordinators`)

`/api/v1/client-config`, `/api/v1/events`, `/api/v1/push/*`, `/api/v1/notification-feed`, `/api/v1/health`, and static assets are never exposed cross-origin:

- Origin and authorization checks: `Origin` must be a single canonical origin in `http.trustedDashboardOrigins` (missing, `null`, `*`, malformed, or multi-valued headers are rejected). Admitted requests run full target-gateway authorization (loopback peer, TUN-mode Serve topology, second-hop refusal, `auth.allowedLogins`, rate limits, and body bounds), and cross-origin `POST` routes enforce `requestHasTrustedDashboardContext`.
- CORS response headers: admitted responses (including `400`, `403`, `404`, `409`, `415`, `429`, `500`, and `503` problem responses on the eight allowed pairs) add `Access-Control-Allow-Origin: <exact matched origin>` and `Vary: Origin`, retain `Cache-Control: no-store, max-age=0`, and never emit `Access-Control-Allow-Credentials` or `*`.
- Preflight (`OPTIONS`) admission: unconfigured notification routes (`notifications` absent, or grant/feed routes without `notifications.coordinators`) return `404 not_found` first. On the eight admitted route patterns, `OPTIONS` authenticates the caller without querying OMP, invoking Tern, or charging rate limits, and checks `Access-Control-Request-Method` (`GET` or `POST`) and `Access-Control-Request-Headers` (absent, or `content-type` on `POST`).
- Preflight (`OPTIONS`) response: valid preflights return `204 No Content` with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: GET` (or `POST`), `Access-Control-Allow-Headers: Content-Type` (`POST` only), `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`, and `Cache-Control: no-store, max-age=0` (no `Access-Control-Max-Age`). Any other `/api/` `OPTIONS` request returns `403 forbidden` without CORS headers.

## 5. In-memory collab client bootstrap

How does **OMP Sessions** mount the embedded collaboration client without exposing the capability? `packages/collab-client/upstream/src/embed.ts` (`embed-contract.ts`) exports the same-document bootstrap:

```ts
function startCollabWithCapability(
  container: HTMLElement,
  capability: string,
  onDispose: () => void,
  options?: CollabEmbedOptions,
): () => void;
```

- Capability and role invariants: parse `capability` with pinned upstream OMP code, derive read-only **View** from the absence of a write token (omitting optional `readOnly` in a host welcome never upgrades **View** or replays a mutating frame), keep the bootstrap out of production devtools globals, DOM attributes/text/forms, `location`, `window.name`, `BroadcastChannel`, clipboard, service-worker messages, and storage, and clear all references and invoke `onDispose` on exit.
- Navigation and reload: installed PWAs always mount `startCollabWithCapability` in the current document because standalone Android windows need not preserve `window.opener` (a same-origin child window transferring the capability once over a validated `MessageChannel` is valid only when an exact-origin opener exists). Direct `GET /client/` requests serve the `no-store` `/` shell so reloading returns to the directory.
- Loading progress: `CollabEmbedState.loading` publishes `{ received, total } | null` snapshot-chunk counters through `onStateChange` (`null` when idle or unmounted).
- First-task draft: optional `CollabEmbedOptions.takeInitialPromptDraft?: () => string | undefined` drains at most one shell-held draft (`<= 8,000` code points / `32` KiB, bound to `sourceKey`, `instanceId`, and `generation`) once into an empty composer in live writable **Control** when the relay is healthy and no Ask or photo draft/send is active, never auto-sending or reapplying on reconnect.
- Gateway probe: `probeGateway(signal)` returns `Promise<GatewayProbeResult>` (`"healthy" | "unavailable" | "forbidden"`, defaulting to `GET /api/v1/health` when omitted and `GET <source>/api/v1/sessions` in **OMP Sessions**); `"forbidden"` sets `gatewayHealth.state = "forbidden"` (`PathHealthState`) and halts relay refresh and automatic probe retries until a foreground or online transition.
- Host UI responses: submitted host UI responses stay disabled until `ui-request-end`, resend after a fresh welcome, and accept a targeted `ui-request-end` as an idempotent acknowledgement.
- Photo prompts: writable **Control** photo prompts use OMP's encrypted v3 `{ t: "prompt", text, images }` relay frame (`<= 4` normalized `ImageContent` `image/jpeg` blocks `<= 1` MiB each, supplying `"Please inspect this photo."` or `"Please inspect these photos."` when text is empty and keeping staged drafts until a post-baseline `collab-prompt` transcript echo arrives).
- Speech and media bounds: `browserRecognitionEnabled` gates Web Speech input; recognizer and image bounds are in [Embedded integration](../packages/collab-client/README.md#embedded-integration) and user flows in [View and Control](USAGE.md#view-and-control).

## 6. Capability lifetime

How long does a capability exist in memory? The gateway has no secret store: a capability exists in `omp-gatewayd` memory only while resolving one authorized `link` query and returning one `no-store` launch response, and in volatile collaboration-client memory while mounted. It never enters URLs, redirects, logs, fixtures, diagnostics, files, or browser caches or storage, and reloading returns to the directory ([Capability handling](SECURITY.md#6-capability-handling)).

## 7. Revisions and races

How do revisions, epochs, and source keys order concurrent updates across the gateway and browser?

- Monotonic registry revisions: each `SessionRegistry` mutation increments a daemon-wide integer `revision`.
- Local directory epochs: starting a local directory epoch aborts any in-flight snapshot fetch, closes any prior `EventSource`, loads one authenticated `GET /api/v1/sessions` snapshot, and only then opens `GET /api/v1/events`; within one epoch, frames with a lower `revision` are ignored and same-revision snapshots are idempotent.
- SSE liveness and freeze: `GET /api/v1/events` sends `keepalive` every 5 seconds; 12 seconds of silence closes the stream while keeping last-seen metadata in memory, using 4-second initial and 20-second recovery snapshot timeouts with upper-half jittered retry caps (`1`, `2`, `4`, `8`, `16`, `30` seconds), and Page Lifecycle `freeze` closes the stream cleanly until visible resume ([Availability behavior](ARCHITECTURE.md#5-availability-behavior)).
- Shell updates: service-worker upgrades cache the full shell before `skipWaiting` and `clients.claim()` without navigating windows, idle pages reload after 1 second on `controllerchange`, and `GET /update/` serves the `no-store` `/` shell and scrubs to `/` ([Shell updates and caching](ARCHITECTURE.md#shell-updates-and-caching)).
- Launch and removal races: launch requests send the observed `generation`; mismatches return `409 generation_mismatch` with no capability, removed and TTL-expired sessions both return `404 not_found`, and session removal while opening resets the view with a generic notice.
- Source keys in memory: the browser addresses sessions by `SourceKey = id + "\0" + origin`, `SessionRef = { sourceKey, instanceId, generation, requestId? }`, and map key `sourceKey + "\0" + instanceId`, never concatenating `SourceKey` into `instanceId` or sending it on the wire (device-local triage keys in [Browser storage](../apps/web/README.md#browser-storage)).
- Remote source polling: remote `fleet.targets` never open `EventSource` streams; each polls `GET <origin>/api/v1/sessions` with `{ mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", signal }` ([Fleet sources](ARCHITECTURE.md#fleet-sources)).
- Remote response parsing and epochs: remote session-list bodies use `JSON.parse` plus `parseSessionListResponse` (duplicate keys follow `JSON.parse` last-key-wins rather than `parseJsonFrame`); within one remote epoch, the latest completed response is authoritative across lower revisions after a remote daemon restart, and `revision` is never compared across sources.
