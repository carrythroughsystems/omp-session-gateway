# Protocol contracts

This document covers the gateway’s HTTP/SSE API and its client side of mainline OMP’s local
discovery/query contract. Browser API shapes are unchanged by the mainline cutover. Runtime
validation lives in `packages/protocol`; browser JSON Schemas remain in `schemas/`.

The schemas describe canonical emitted list/SSE data, including bounded ask metadata and
OMP's 8–64 character identities. Runtime parsers may additionally normalize legacy input.
HTTP/SSE regressions validate real serialized responses with a Draft 2020-12 validator.

## 1. OMP discovery directory

Require stock OMP `>= 18.1.20`: [PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20).
OMP publishes under `~/.omp/run/collab-hosts`. `PI_CONFIG_DIR` replaces the `.omp` directory
**name relative to the home directory**, not the entire discovery path. The gateway may select an
explicit directory with `omp.discoveryDir`. It only reads this directory: it never creates, writes,
renames, or unlinks discovery entries or endpoints, including apparently stale ones.

Each live publication has one `<entryId>.json` file, mode `0600`, written once and never rewritten
for metadata changes. Its required fields are:

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

The token authorizes queries to this one OMP host. It is private authentication material, **not** a
View or Control capability and not a gateway installation credential. Discovery files never
contain collaboration capabilities. Verify private ownership and permissions and reject symlinks
and malformed entries. Read `endpoint` from the file; do not derive it from `entryId` or PID. OMP
relocates overlong socket paths to `/tmp/omp-collab-<hash>/<entryId>.sock`.

OMP evolves registry v1 additively, without a version bump. Discovery files, snapshots, `model`,
and replies may carry fields beyond those documented here: the gateway validates every documented
field that is present, requires the non-optional ones, ignores the rest, and builds its records
from named fields only. Any other `version` or `v` is refused.

A killed host leaves its file behind until an OMP listing such as `omp collab list` prunes it; the
gateway never deletes it. Each round the gateway revisits admitted publications, then examines at
most 4,096 directory names and reads unknown publications newest first, so older leftovers and
non-publication residue cannot displace a new session. It remembers, by file identity, up to ten
publications per admission slot whose endpoint proved dead (`ENOENT`/`ECONNREFUSED`) and skips each
unchanged one without a read or query. A replaced file is read again; a pruned one is forgotten.

## 2. Per-host query transport

The gateway connects to the OMP-owned endpoint as a client. Frames are UTF-8 newline-delimited JSON:
**one request per connection**, followed by one reply and host-initiated close. There is no gateway
listener, publisher handshake, persistent stream, or unsolicited metadata frame on this path.
Terminate the request with a newline; bound request/response bytes using
`MAX_OMP_REGISTRY_REQUEST_BYTES` and `MAX_OMP_REGISTRY_RESPONSE_BYTES`, validate protocol version
1 and reply shape, and never echo raw input or transport errors into logs.

`omp.queryTimeoutMs` defaults to 1500 ms. Gateway log fields accept only numeric or boolean values,
never strings, query tokens, endpoints, snapshots, request bodies, or replies.

### `snapshot`

Request:

```json
{ "v": 1, "token": "<per-host-query-token>", "op": "snapshot" }
```

Success is `{ ok: true, v: 1, snapshot }`. The metadata snapshot contains:

| Field | Meaning |
|---|---|
| `instanceId` | OMP process identity; never use PID alone as the card identity. |
| `generation` | Current collaboration generation, required on link requests. |
| `pid` | Host process ID. |
| `sessionId` | Active OMP session identity. |
| `sessionName` | Session display name. |
| `cwd` | Host working directory; the gateway exposes only its bounded basename by default. |
| `model` | `{ provider, id }`; mapped to a bounded browser display label. |
| `startedAt` | Epoch milliseconds; converted to ISO time for browser metadata. |
| `participants` | Host participant count. |
| `relayConnected` | Host relay-connection state, not a reason to retire discovery. |
| `inputRequired` | Boolean attention signal; no prompt, options, answer, or request content. |
| `busy` | Optional activity boolean from upstream PR #12844; omitted/null is unknown, not idle. Non-boolean values are malformed. |
| `access` | Shared access, `view` or `control`; determines Control availability. |

No snapshot contains a capability. The gateway derives bounded `SessionMetadata` plus its own
opaque attention identity; neither full paths nor per-host query tokens enter list/SSE. Boolean
`busy` projects into optional browser metadata; absent/null is omitted. A retained/unreadable host
loses only that activity knowledge, without refreshing last-seen time or TTL. An unlisted snapshot
field is ignored, except that a snapshot naming ask content (`prompt`, `question`, `options`,
`prefill`, `answer`, `requestId`, or `count`) is refused as a privacy regression.

### `link`

Only an explicit authorized View/Control launch triggers this request:

```json
{
  "v": 1,
  "token": "<per-host-query-token>",
  "op": "link",
  "access": "view",
  "generation": 3
}
```

`access` is exactly `view` or `control`; `generation` is the value observed by the browser.
Success is `{ ok: true, v: 1, url }`, where `url` is a bearer capability. No example capability is
recorded here. The launch broker validates the reply and revalidates current generation, requested
access, and optional attention request identity before returning the unchanged HTTP launch shape.
It never stores or caches the capability.

### Wire errors

All error replies have the shape `{ ok: false, v: 1, error }`. The complete error-code set is:

| `error` | Meaning |
|---|---|
| `malformed_request` | The request cannot be accepted as a valid query. |
| `unsupported_protocol` | The request protocol version is unsupported. |
| `authentication_failed` | The per-host query token is not accepted. |
| `snapshot_unavailable` | The host cannot currently supply its snapshot. |
| `invalid_operation` | The operation is not `snapshot` or `link`. |
| `invalid_access` | The link access value is invalid. |
| `stale_generation` | The requested collaboration generation is no longer current. |
| `access_unavailable` | The current host does not share the requested role. |

These are OMP wire errors, not gateway HTTP problem codes. None proves that the host has exited.

## 3. Polling, liveness, and reconciliation

`registry.heartbeatSeconds` now means the discovery poll interval (default 10 seconds). Concurrent
polls join one round. A successful observation refreshes metadata freshness using daemon receipt
time from a monotonic clock. `registry.ttlSeconds` defaults to 35 seconds and must exceed twice
the poll interval.

**Only `ENOENT` or `ECONNREFUSED` from a host query proves that host finished.** A timeout,
`EMFILE`, `EACCES`, malformed reply, or any wire error (including `snapshot_unavailable`) is
transient: retain an existing card, without refreshing its successful-observation time, until
TTL expiry. Do not convert these errors into immediate session removal or discovery-file cleanup.
Hosts absent from both the observed and retained sets are removed during reconciliation. An
absent discovery directory is a valid empty directory, not a reason to create it. A normal close
after a query response is framing, not a host-death signal.

After a daemon restart the memory-only registry begins empty and the next poll discovers live
hosts. OMP does not reconnect to or authenticate with the gateway.

## 4. Browser HTTP API

Production requests are accepted only through the loopback Tailscale Serve proxy path and require an allowed identity. By default, no CORS is enabled; opt-in cross-origin access is permitted only for exact dashboard origins configured in `http.trustedDashboardOrigins` on the exact route/method pairs specified under [Cross-origin access](#cross-origin-access).

Every `/api/` response includes at least:

```http
Cache-Control: no-store, max-age=0
Pragma: no-cache
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: same-origin
```

The server's access log must suppress query strings, request/response bodies, authorization headers, identity headers, and launch endpoint response sizes.

### `GET /api/v1/client-config`

Returns the public client bootstrap configuration (validated by [`schemas/client-config.schema.json`](../schemas/client-config.schema.json) and `parseClientConfigResponse`):

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

Requirements and behavior:

- authenticated identically to `GET /api/v1/sessions`;
- same-origin only: if an `Origin` request header is present and does not equal `http.publicOrigin`, the gateway returns `403 Forbidden`;
- no query string allowed; `Cache-Control: no-store, max-age=0`; never receives CORS headers;
- built from named fields only (`local = { id: "local", label: fleet.label, origin: http.publicOrigin }` where `fleet.label` defaults to the first DNS label of the `http.publicOrigin` host and loopback dev origins keep the literal host, `targets = fleet.targets`, `speech = { browserRecognition: speech.browserRecognition }`), bounded to `MAX_CLIENT_CONFIG_BYTES` (32 KiB), with at most 7 `targets` (8 sources total);
- never spreads `GatewayConfig` and never includes `auth.allowedLogins`, `http.trustedDashboardOrigins`, filesystem paths, readiness or discovery tokens, or registry state;
- older gateways without this endpoint return `404`, which the web app treats as local-only with `speech.browserRecognition = false` and no error banner; a `200` response with an invalid body, unsupported version, or `local.origin !== location.origin` is treated as a fleet bootstrap error (`Fleet configuration unavailable — reload this app`) while the local directory keeps working.

### `GET /api/v1/sessions`

Returns metadata only:

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
      "inputRequired": true,
      "ask": {
        "requestId": "opaque-in-memory-request-id",
        "since": "2026-07-19T16:25:18.000Z"
      },
      "lastSeenAt": "2026-07-19T16:25:20.000Z",
      "canView": true,
      "canControl": true
    }
  ]
}
```

It must never contain a capability, room key, write token, relay secret, per-host query token, readiness token, transcript, answer, tool output, or full path by default. `ask.requestId` is opaque routing metadata generated by the gateway, and `ask.since` is daemon receipt time. `ask.preview` and `optionCount` remain absent until an explicit bounded OMP snapshot contract supplies them.

### `GET /api/v1/events`

Server-Sent Events contain only the same metadata types used by the list endpoint.

Event types:

- `snapshot`;
- `session_upsert`;
- `session_remove`;
- metadata-free named `keepalive` events every 5 seconds, observable by dashboard JavaScript.

A fresh snapshot establishes each connection's state. Keepalives prove transport liveness, not
session freshness; the latter still requires successful OMP observations.

### `GET /api/v1/push/config`

Returns the public half of the per-install VAPID key:

```json
{
  "version": 2,
  "applicationServerKey": "<url-safe-P-256-public-key>"
}
```

The response is authenticated and no-store. The VAPID private key never leaves the gateway's
user-only state file and process memory.

### `POST /api/v1/push/subscription`

After an explicit permission action, the browser registers or updates its subscription:

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

`detailLevel` is exactly `private`, `session`, or `preview`. New subscriptions explicitly select
`session`. Re-registering an existing browser subscription may omit `detailLevel`; the gateway then
preserves that endpoint's stored choice, defaulting only migrated v1 state to `session`. Require
exact same-origin mutation context, `application/json`, strict keys, HTTPS endpoint without
credentials or fragment, bounded key/endpoint/body sizes, authenticated identity, rate limits, and
at most eight stored subscriptions. Persist only the endpoint/keys, identity, detail level, and
VAPID pair in a private atomic state file. This file is not the session registry and contains no
session metadata or collaboration capability.

`DELETE /api/v1/push/subscription` accepts exactly `{ "version": 2, "endpoint": "..." }`. Browser
unsubscribe is authoritative; a failed delete leaves an unusable endpoint that the gateway removes
when delivery returns `404` or `410`.

### Web Push notification envelopes

The encrypted payload is exactly one of the following attention/clear envelopes, or the strict
`activity_stop` envelope described below:

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
  "type": "clear",
  "instanceId": "metadata-instance-id",
  "requestId": "opaque-in-memory-request-id",
  "pendingAskCount": 1
}
```

`body` is omitted for `private`; `preview` may append one bounded preview line and otherwise falls
back to `session`. Presentation fields are built at send time and never persisted in gateway push
state. Send with high urgency, a five-minute TTL, and no `Topic` header, because FCM throttles
collapsible messages ([delivery](ATTENTION_SPEC.md#notification-lifecycle)). The
VAPID `sub` claim is the repository URL, `https://github.com/carrythroughsystems/omp-session-gateway`: a
contact the push service can reach, which Apple enforces by rejecting the JWT otherwise. The
service worker uses one notification tag per instance, updates it silently, closes it on `clear`,
and sets or clears the app badge from `pendingAskCount`.

An `activity_stop` envelope contains exactly `version: 2`, `type: "activity_stop"`, `instanceId`,
`generation`, `pendingAskCount`, fixed `title: "OMP session activity stopped"`, and optional `body`.
It has no request ID. Private omits the body; Preview uses Session detail. It shares the existing
instance tag and five-minute TTL. A displayed valid attention notification wins over a stop;
a clear closes only matching request data and therefore cannot close a stop. See the exact
[trigger and precedence contract](ATTENTION_SPEC.md#activity-stop-notifications).

Stop clicks use `/collab/:instanceId?activity=stopped&generation=:generation` and open only View
for the same current generation/canView after authentication. Gone or changed targets stay on the
directory. Both routes reject duplicate/mixed/extra parameters and invalid identities/generations,
then scrub the routing URL before networking. Older v2 workers ignore new stop payloads until
shell activation; attention/clear and durable push-state schemas remain unchanged.

The click route `/collab/:instanceId?request=:requestId` contains routing metadata only and returns
the no-store application shell. The app loads current authenticated metadata and performs the
ordinary Control launch POST only when the exact request identity remains actionable and
controllable. A capability never enters the push payload, route, notification, service worker, or
history state.

### `POST /api/v1/sessions/:instanceId/launch`

Request:

```json
{
  "mode": "view",
  "generation": 3
}
```

Request-specific Control launches also include the current opaque `requestId`. The gateway
revalidates that exact ask as well as the generation before releasing Control; the ID is routing
metadata, not an authorization credential.

Requirements:

- exact same-origin `Origin` (with `Sec-Fetch-Site: same-origin` when present), or an exact configured origin in `http.trustedDashboardOrigins` under [Cross-origin access](#cross-origin-access) (with `Sec-Fetch-Site` absent or in `{same-site, cross-site}`);
- `Content-Type: application/json` with no ambiguous encodings;
- verified and allowed Tailscale identity;
- current generation match and fresh successful host observation;
- requested access is still shared by OMP;
- per-identity and per-session rate limits;
- no WebAuthn assertion in the current API; an additional Control gate remains the ADR-008 proposal.

Successful response, classified as secret-bearing:

```json
{
  "mode": "view",
  "generation": 3,
  "capability": "<opaque-omp-collaboration-capability>"
}
```

The response is consumed once in memory. It is never cached, logged, traced, retried by a service worker, included in browser error reporting, or inserted into the DOM.

Error behavior:

- generation mismatch: `409 Conflict` with a generic non-secret problem object;
- missing/expired record: `404 Not Found`;
- unauthorized identity: `403 Forbidden` without session existence details;
- requested role no longer shared: `409 Conflict` with `mode_unavailable`;
- exact attention request no longer current: `409 Conflict` with `request_mismatch`;
- malformed request: bounded `400` response that does not echo input.

### Session creation DTO rules

[ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption) adds `SessionCreationOptions`, `SessionCreationRequest`, `SessionCreationReceipt`, and `SessionCreationStatus` in `packages/protocol` (`parseSessionCreationOptions`, `parseSessionCreationRequest`, `parseSessionCreationReceipt`, `parseSessionCreationStatus`). Public JSON Schemas are `schemas/session-creation-options.schema.json`, `schemas/session-creation-request.schema.json`, and `schemas/session-creation-status.schema.json`. `client-config` v1, `SessionMetadata`, list/SSE, launch DTOs, and OMP discovery/relay frames are unchanged.

Every object (including nested choices and `ready` bindings) enforces `requireExactKeys` and rejects unknown keys, duplicate JSON keys, `null` substitutions, invalid state/field combinations, and size overflows:

| DTO / Schema | Field | Type / Constraint |
| --- | --- | --- |
| `SessionCreationOptions` (`schemas/session-creation-options.schema.json`, $\le 64\text{ KiB}$) | `version` | Literal `1` (`SESSION_CREATION_VERSION`) |
| | `revision` | Canonical lowercase UUIDv4 (`SESSION_CREATION_UUID_PATTERN`), generated once per daemon lifetime |
| | `available` | `boolean` |
| | `reason` | Required iff `available === false` (forbidden when `true`): `"not_configured" \| "tern_unavailable" \| "configuration_unavailable" \| "ledger_unavailable"` |
| | `projects` | `[]` when `available === false`; otherwise `1`–`16` `{ id, label, workingCopies }` (`1`–`8` `{ id, label }` per project) |
| | `profiles` | `[]` when `available === false`; otherwise `1`–`8` `{ id, label }` |
| `SessionCreationRequest` (`schemas/session-creation-request.schema.json`, $\le 4\text{ KiB}$) | `clientOperationId` | Canonical lowercase UUIDv4 generated per explicit **Create** action |
| | `revision` | Canonical lowercase UUIDv4 matching current options `revision` |
| | `projectId`, `workingCopyId`, `profileId` | Configured choice IDs matching `^[a-z][a-z0-9-]{0,31}$` (`local` is permitted; project/profile IDs unique in their collections, working-copy IDs unique within a project; choice `label` values normalized to `1`–`64` NFC code points) |
| `SessionCreationReceipt` (`parseSessionCreationReceipt`, $\le 2\text{ KiB}$) | `operationId` | Canonical lowercase UUIDv4 assigned by the daemon |
| | `state` | `"accepted"` on `202 Accepted`; current `SessionCreationState` on `200 OK` idempotent replay |
| `SessionCreationStatus` (`schemas/session-creation-status.schema.json`, $\le 2\text{ KiB}$) | `operationId` | Canonical lowercase UUIDv4 |
| | `state` | `"accepted" \| "launching" \| "awaiting_omp" \| "ready" \| "started_unavailable" \| "failed" \| "outcome_unknown"` |
| | `updatedAt` | Canonical UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`) |
| | `session` | Required iff `state === "ready"`: `{ instanceId: "^[a-z0-9-]{8,64}$", generation: 1..9007199254740991 }` |
| | `error` | Required iff state is `failed`, `started_unavailable`, or `outcome_unknown` (closed `SessionCreationError`) |

Public options expose only choice IDs and display labels — never filesystem paths, executables, `argv`, or `env`. Receipts, status responses, and problem bodies never echo labels, paths, `argv`, `env`, prompt text, raw CLI output, or capabilities.

### `GET /api/v1/session-creation-options`

Authenticated, no query parameters, `Cache-Control: no-store, max-age=0`. Returns `200 OK` with `SessionCreationOptions`:

```json
{
  "version": 1,
  "revision": "14f3cfa2-c391-4ada-91f0-e486fd5bfccc",
  "available": true,
  "projects": [
    {
      "id": "alpha-founder",
      "label": "Alpha Founder",
      "workingCopies": [{ "id": "main", "label": "main" }]
    }
  ],
  "profiles": [{ "id": "omp", "label": "OMP" }]
}
```

- `revision` is an opaque random UUIDv4 generated once per daemon lifetime; restarting the daemon invalidates previously fetched options without exposing a configuration hash.
- When `available` is `false`, the response still returns `200 OK` with `projects: []`, `profiles: []`, and `reason`:
  - `not_configured`: `config.tern` is absent.
  - `configuration_unavailable`: `config.tern` is `{}` or a configured executable/working-copy runtime check failed.
  - `tern_unavailable`: `tern inspect --json` failed or timed out, or the service is stopping.
  - `ledger_unavailable`: `<stateDir>/session-creations.json` failed validation or could not be read/written safely.
- Availability probes are demand-driven, coalesced, and cached for 5 seconds; while an operation owns the single CLI slot, `options` reuses the latest cached availability instead of spawning a second `tern` subprocess. A `404` on an older gateway is treated by the browser as unavailable.

### `POST /api/v1/session-creations`

Authenticated, no query parameters, `Cache-Control: no-store, max-age=0`. Request body (`SessionCreationRequest`, $\le 4\text{ KiB}$):

```json
{
  "clientOperationId": "4e86bd6c-f68a-4d96-8f34-bb7d67cdbe58",
  "revision": "14f3cfa2-c391-4ada-91f0-e486fd5bfccc",
  "projectId": "alpha-founder",
  "workingCopyId": "main",
  "profileId": "omp"
}
```

Admission and idempotency rules (executed inside one serialized admission section):

- **Mutation context:** Same-origin requests require `requestHasValidMutationContext`; cross-origin requests from `http.trustedDashboardOrigins` require `requestHasTrustedDashboardContext` with exact `Content-Type: application/json`.
- **Idempotent replay (`200 OK`):** Keyed by **normalized authorized identity + `clientOperationId`** (independent of `Origin`). If an unexpired record matches both keys and the parsed request payload is identical, the gateway returns `200 OK` with `{ "operationId": "<uuid-v4>", "state": "<current-state>" }` before checking current `revision`, availability, busy state, or rate limits.
- **Conflict (`409 operation_conflict`):** Same normalized identity + `clientOperationId` with any changed request field (including `revision`).
- **New admission (`202 Accepted`):** Verified against current `revision` (`409 revision_mismatch` on mismatch), active operation slot (at most one nonterminal operation globally; `429 creation_busy` with no queue), availability (`503 tern_unavailable` or `503 ledger_unavailable`), configured choice IDs (`400 bad_request`), ledger capacity ($\le 64$ unexpired records; `503 creation_capacity`), and the per-identity `creation` rate limiter (`20/min`, tracked-key map capacity `Math.max(3, identityCapacity * 3)` where `identityCapacity` is `auth.allowedLogins.length` or `1` in `dev-localhost` mode, charged only for genuinely new admissions; `429 rate_limited`). The daemon persists `accepted` before returning `202 { "operationId": "<uuid-v4>", "state": "accepted" }` and scheduling execution.
- **No remote cancellation:** Browser disconnect, request abort, or closing the tray never cancels an accepted daemon operation; no `DELETE` or cancel route exists.

### `GET /api/v1/session-creations/:operationId`

Authenticated owner-scoped status, no query parameters, `Cache-Control: no-store, max-age=0`. `:operationId` must match `SESSION_CREATION_UUID_PATTERN` (exact lowercase UUIDv4). Returns `200 OK` with `SessionCreationStatus` ($\le 2\text{ KiB}$):

```json
{
  "operationId": "703e065e-793f-41ab-9ead-00ff6bdcfd72",
  "state": "ready",
  "updatedAt": "2026-10-24T23:59:00.000Z",
  "session": { "instanceId": "example-instance", "generation": 1 }
}
```

| `state` (`SessionCreationState`) | Required state-specific field | Forbidden fields |
| --- | --- | --- |
| `accepted`, `launching`, `awaiting_omp` | None | `session`, `error` |
| `ready` | `session: { instanceId, generation }` | `error` |
| `failed` | `error: "preflight_failed" \| "spawn_failed" \| "interrupted"` | `session` |
| `started_unavailable` | `error: "adoption_timeout" \| "correlation_ambiguous" \| "control_unavailable" \| "interrupted"` | `session` |
| `outcome_unknown` | `error: "launch_outcome_unknown" \| "interrupted"` | `session` |

Unknown, expired, malformed-UUID, and other-identity operations all return `404 not_found`. Ownership is bound to the normalized authorized identity (not `Origin`), so the same identity can inspect its operation from another trusted dashboard. Status `GET` reads committed state only and never invokes Tern.

### Session creation state machine

Every state transition is durably committed to `<stateDir>/session-creations.json` (write → `fsync` → atomic rename → directory `fsync`) before becoming observable in HTTP responses or triggering its dependent external action:

| From → To | Trigger and durable boundary |
| --- | --- |
| none → `accepted` | Valid new request admitted; durable intent committed before `202` response and before any preflight/spawn work |
| `accepted` → `launching` | Runtime validation, fresh OMP discovery round (`refreshForAdoption`), and `tern inspect --json` preflight succeed within 10 s; baseline instance/session/block IDs recorded in memory; `launching` committed **before** `Bun.spawn` |
| `accepted` → `failed` (`preflight_failed`) | Runtime path check, OMP discovery baseline, or `tern inspect --json` preflight fails or times out |
| `accepted` → `failed` (`interrupted`) | Daemon shutdown or startup recovery before `launching` was committed; spawning is prohibited afterward |
| `launching` → `failed` (`spawn_failed`) | OS process creation definitively failed before a child process existed |
| `launching` → `awaiting_omp` | `tern new tab --json --keep-open --cwd <path> -- <argv…>` exits `0` within 10 s / 8 KiB with one valid local block receipt (`block` $< 2^{56}$ and not in pre-spawn baseline); decimal block ID committed with `awaiting_omp` |
| `launching` → `outcome_unknown` (`launch_outcome_unknown`) | Child process existed, but stdout was lost, malformed, oversized, non-zero exit, timed out, or matched an existing baseline block ID |
| `launching` → `outcome_unknown` (`interrupted`) | Daemon shutdown or startup recovery while in `launching` |
| `awaiting_omp` → `ready` | Serial `tern inspect --json` (1 s interval, 5 s / 1 MiB bound) and post-spawn OMP discovery observation yield an exact 1:1 local `block === blocks[].id === panes[].pane` match, a single fresh OMP binding whose `sessionId` is a complete `[A-Za-z0-9-]+` token of `basename(omp_session_file)` minus `.jsonl` (with `startedAt` and `createdAt` $\ge$ `launching.updatedAt`, excluding baseline instance/session IDs), and `registry.authorizeLaunch(instanceId, generation, "control")` succeeds |
| `awaiting_omp` → `started_unavailable` (`correlation_ambiguous`) | More than one eligible `(instanceId, generation)` binding matches |
| `awaiting_omp` → `started_unavailable` (`control_unavailable`) | 110 s total operation deadline reached while the unique matching host is `view`-only |
| `awaiting_omp` → `started_unavailable` (`adoption_timeout`) | 110 s total operation deadline reached without an adoptable binding (including missing `omp_session_file` or early process exit) |
| `awaiting_omp` → `started_unavailable` (`interrupted`) | Daemon shutdown or startup recovery after `awaiting_omp` was committed |

All terminal states (`ready`, `failed`, `started_unavailable`, `outcome_unknown`) are immutable. Total daemon execution is bounded to **110 seconds** monotonically from acceptance. `ready` carries only `{ instanceId, generation }`; the browser refreshes the selected source and calls ordinary `POST /api/v1/sessions/:instanceId/launch` (`mode: "control"`) to obtain the capability.

### Creation retention, errors, and browser watching

- **Ledger retention (`<stateDir>/session-creations.json`):** Version 1, at most 64 records, 512 KiB maximum, retained for **24 hours** from acceptance (`createdAt`). Expired terminal records are pruned at startup and before new admissions; unexpired records are never evicted.
- **Problem responses (`application/problem+json`):** Use `{ code, message }` with fixed messages that never echo IDs, paths, `argv`, `env`, or CLI output. Terminal `status.error` values are returned inside `200 OK` `SessionCreationStatus` payloads, not as HTTP problem codes:

| HTTP status | `code` | Route(s) | Condition |
| --- | --- | --- | --- |
| `400 Bad Request` | `bad_request` | Options `GET`, Creations `POST`, Status `GET` | Query parameters on any route; malformed/oversized JSON body, unknown keys, or invalid UUID/choice ID in Creations `POST` |
| `403 Forbidden` | `forbidden` | All creation routes and `OPTIONS` | Missing/disallowed Tailscale identity, unallowlisted `Origin`, invalid `Sec-Fetch-Site`, or cross-origin `POST` without exact `Content-Type: application/json` |
| `404 Not Found` | `not_found` | Status `GET` (and unmatched paths) | Unknown, expired, non-UUIDv4 `:operationId` path segment, or another identity's `operationId` |
| `409 Conflict` | `operation_conflict` | Creations `POST` | Same normalized identity + `clientOperationId` replayed with a different payload (including `revision`) |
| `409 Conflict` | `revision_mismatch` | Creations `POST` | New `clientOperationId` submitted with a stale options `revision` |
| `415 Unsupported Media Type` | `unsupported_media_type` | Creations `POST` | Same-origin `POST` without `Content-Type: application/json` |
| `429 Too Many Requests` | `rate_limited` | Creations `POST` | Per-identity `creation` limiter (`20/min`) exceeded on a new operation |
| `429 Too Many Requests` | `creation_busy` | Creations `POST` | Another creation operation is currently nonterminal (`accepted`, `launching`, or `awaiting_omp`) |
| `503 Service Unavailable` | `tern_unavailable` | Creations `POST` | `tern` is unconfigured, runtime/inspect probe failed, or service is stopping |
| `503 Service Unavailable` | `creation_capacity` | Creations `POST` | Ledger already holds 64 unexpired operations |
| `503 Service Unavailable` | `ledger_unavailable` | Creations `POST`, Status `GET` | Private ledger could not be validated, read, or durably committed |
| `500 Internal Server Error` | `internal_error` | All routes | Unexpected unhandled exception boundary |

- **Browser transport and watching (`SessionCreationTransport`, `SessionCreationController`):** Options `GET` timeout 4 s, creations `POST` timeout 10 s, status `GET` timeout 4 s; local requests use same-origin credentials, remote requests use `mode: "cors"`, `credentials: "omit"`, `redirect: "error"`, with no automatic `POST` retries. Status polling runs serially 1 s after each response completes for at most 120 s from the explicit **Create** action. Scope/source change, competing launch/tray, readable `403`, `visibilitychange` to hidden, `freeze`/`pagehide`, or **Close** stops watching while the daemon operation continues. One paused capability-free intent is held in page memory so **Check creation** can `GET` status (or replay the identical `POST` when the acknowledgement was lost) without generating a new UUID.

### `GET /api/v1/health`

A local unauthenticated health endpoint returns only generic process readiness. Session counts,
identities, config, paths, and session health require authenticated diagnostics or local CLI access.
Readiness includes discovery health, not just HTTP reachability: an absent OMP directory is valid,
but an unsafe or unreadable directory degrades discovery. No directory path, token, count, or host
detail appears in this response. The optional HMAC challenge/response uses the gateway’s private
readiness token and keeps its existing shape; that token is never given to OMP.


### Cross-origin access

When `http.trustedDashboardOrigins` is non-empty (up to 8 canonical origins), the gateway admits browser-direct CORS requests from those exact origins on a strictly bounded surface ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors)):

- **Allowed routes and methods:** only `GET /api/v1/sessions`, `POST /api/v1/sessions/:instanceId/launch`, `GET /api/v1/session-creation-options`, `POST /api/v1/session-creations`, `GET /api/v1/session-creations/:operationId` (exact lowercase UUIDv4), and `OPTIONS` preflight on those exact paths. `/api/v1/events`, `/api/v1/push/config`, `/api/v1/push/subscription`, `/api/v1/client-config`, `/api/v1/health`, and static assets are never exposed cross-origin.
- **Origin admission:** the request `Origin` header must be a single canonical origin present in `http.trustedDashboardOrigins`. Missing, `null`, `*`, malformed, or multi-valued `Origin` headers are not admitted. Any foreign non-admitted `Origin` on any `/api/` route except loopback `GET /api/v1/health` is refused with `403` (`forbidden`) and no CORS headers before identity checks.
- **Normal authorization applies:** admitted cross-origin requests still run the full target-gateway authorization path (loopback peer check, TUN-mode Tailscale Serve verification, second-hop proxy header refusal, `auth.allowedLogins` check, rate limiting, and body-size bounds).
- **Cross-origin mutation context (`requestHasTrustedDashboardContext`):** cross-origin `POST /api/v1/sessions/:instanceId/launch` and `POST /api/v1/session-creations` require `Origin` in `http.trustedDashboardOrigins`, `Sec-Fetch-Site` absent or in `{same-site, cross-site}` (`none` and `same-origin` are rejected on the cross-origin path), and `Content-Type` exactly `application/json`. `requestHasValidMutationContext` remains required for local launches, creations, and push subscription mutations. An opted-in target trusts those dashboards to create approved processes as well as read metadata and open existing sessions.
- **Response headers on admitted requests:** responses add `Access-Control-Allow-Origin: <exact matched origin>` and `Vary: Origin`, keep `Cache-Control: no-store, max-age=0`, and never emit `Access-Control-Allow-Credentials` or a wildcard. Problem responses (`400`, `403`, `404`, `409`, `413`, `415`, `429`, `500`, `503`) for an admitted origin on the allowed route/method pairs carry the same `Access-Control-Allow-Origin` and `Vary: Origin` headers so the dashboard can distinguish a readable `403` from a network or CORS failure.
- **Preflight (`OPTIONS`):** handled only on the five allowed route patterns above, authenticated through the normal identity path, without querying OMP, starting Tern, or consuming mutation rate-limit tokens. A valid preflight requires `Origin` in `http.trustedDashboardOrigins` and `Access-Control-Request-Method` matching the route (`GET` for sessions, creation options, and exact creation status; `POST` for launch and the creations collection). `Access-Control-Request-Headers` may be absent, or exactly `content-type` (case-insensitive) for POST only; GET permits no requested headers. It returns `204 No Content` with:
  - `Access-Control-Allow-Origin: <exact matched origin>`
  - `Access-Control-Allow-Methods: GET` (or `POST`)
  - `Access-Control-Allow-Headers: Content-Type` (`POST` only)
  - `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`
  - `Cache-Control: no-store, max-age=0` (and no `Access-Control-Max-Age`)

  Any other `OPTIONS` request returns `403 Forbidden` with no CORS headers.
## 5. In-memory collab client bootstrap

Shipped same-page API, defined in `packages/collab-client/upstream/src/embed.ts`:

```ts
function startCollabWithCapability(
  container: HTMLElement,
  capability: string,
  onDispose: () => void,
  options?: CollabEmbedOptions,
): () => void;
```

The return value disposes the mounted client; the capability is passed directly to the pinned
component rather than through a navigation or persistent bootstrap object.

Requirements:

- parse with pinned upstream OMP code;
- derive View/read-only state from the absence of the capability write token; a host welcome may
  further restrict a full link but omission of its optional `readOnly` field must never upgrade a
  View link or replay a pending mutating response;
- do not stringify or attach the bootstrap object to React/Vue devtools-visible global state in production;
- never assign the capability to `location`, an element attribute, text content, a form field, or persistent state;
- clear references on disconnect/leave and call `onDispose`;
- reload returns to the directory rather than reconnecting.
- publish required `CollabEmbedState.loading: { received: number; total: number } | null`
  through `onStateChange`, forwarding only existing snapshot counters and using `null` when
  there is no client or loading completes. No transcript data or snapshot-ingestion change is
  introduced. The gateway chip shows `Joining session… 43%` before first live and
  `Reconnecting… 43%` after earlier live; floor and clamp the percentage to 0–100, omit it for
  invalid/zero totals, retain forbidden/ended/sustained-outage priority, and change live-region
  copy only when the rendered text changes.
- accept optional `CollabEmbedOptions.takeInitialPromptDraft?: () => string | undefined`,
  threaded App → Session → Composer. The shell holds at most one 8,000-code-point/32-KiB
  first-task draft in volatile memory bound to the created source/instance/generation. Drain
  it once only in live writable Control, with healthy relay, no active Ask, an empty ordinary
  draft, and no photo draft/pending photo send. Never overwrite existing text, fill AskEditor,
  send a prompt, synthesize Enter, persist the text, or reapply it on reconnect/rerender.
  Disposal or cancellation clears the holder; an explicit retry of opening the same ready
  binding may retain it if failure occurred before mounting.
- treat browser network APIs only as remeasurement triggers; derive gateway and relay state from
  `CollabEmbedOptions.probeGateway` (or the default same-origin `GET /api/v1/health` probe when `probeGateway` is omitted), passive host traffic, and optional encrypted health ping/pong frames;
- when `probeGateway(signal)` is supplied, it returns `Promise<GatewayProbeResult>` (`"healthy" | "unavailable" | "forbidden"`), where `"healthy"` requires a parsed session list from the selected source's `GET <origin>/api/v1/sessions`, `"forbidden"` reflects a readable `403` and sets `gatewayHealth.state = "forbidden"` (`PathHealthState` includes `"forbidden"`, and the embedded client's shell chip shows `Access withdrawn`) without refreshing the relay or scheduling automatic probe retries (a later visibility or online transition may probe once more), and `"unavailable"` follows the existing degraded/unreachable recovery path;
- when `CollabEmbedOptions.browserRecognitionEnabled` is `true` (from `speech.browserRecognition`), enable the opt-in Web Speech (`SpeechRecognition` / `webkitSpeechRecognition`) microphone control in writable **Control** sessions only: configure the recognizer with `lang = navigator.language || "en-US"`, `continuous = true`, `interimResults = true`, one alternative (`maxAlternatives = 1`), and no automatic restart; enforce a `10 s` start watchdog (`SPEECH_START_TIMEOUT_MS`), a `120 s` capture limit (`SPEECH_CAPTURE_LIMIT_MS`), and a `5 s` stop watchdog (`SPEECH_STOP_TIMEOUT_MS`); bound the review buffer to `128` segments (`MAX_SPEECH_SEGMENTS`), `8,000` Unicode code points (`MAX_SPEECH_CODEPOINTS`), and `32 KiB` UTF-8 (`MAX_SPEECH_BYTES`); use the fixed keyboard-dictation help `"Use your keyboard's microphone key to dictate into this box. iPhone: Settings → General → Keyboard → Enable Dictation. Dictation never sends — tap Send when the text is right."` and pre-start disclosure `"Your browser or OS may send audio to its speech provider before any OMP prompt is sent."`; keep recognized text in the editable review buffer until the user explicitly taps **Use text**; and keep **Use text** separate from **Send**;
- keep a submitted host UI response visible and disabled until `ui-request-end`; resend it after a
  fresh welcome, and accept a targeted end frame as the idempotent acknowledgement when the host
  already settled that request;
- for writable photo prompts, use the pinned v3 `{ t: "prompt", text, images }` frame without a
  gateway media endpoint or protocol revision; each `ImageContent` is a normalized `image/jpeg`
  data block, with at most four blocks and at most 1 MiB of decoded bytes per block;
- accept only JPEG, PNG, and WebP source files up to 24 MiB and at most an 8,192px edge or
  20 megapixels, re-encode to a maximum 2,048px edge in browser memory so source filenames and
  EXIF/location metadata do not cross the relay, and drop preview/base64 references on remove,
  host-confirmed transcript echo, or client disposal;
- expose separate user actions and hidden inputs for **Take photo**
  (`capture="environment"`) and **Choose existing** (no `capture`); both feed the same bounded
  preparation path, and cancelling either chooser sends nothing;
- retain a sent photo draft until an exact `collab-prompt` transcript entry acknowledges its text
  and image blocks after the recorded pre-send entry; if that baseline is absent during reconnect,
  no older identical entry may acknowledge the draft. After five seconds without acknowledgement,
  keep the draft and offer retry only while the relay is healthy;
- permit image-only submission by supplying the explicit neutral text `Please inspect this photo.`
  (or its plural); user-entered text takes precedence unchanged;

Separate-page design alternative (not the shipped launch path):

1. open `/client/` synchronously during the user's tap;
2. the child creates a `MessageChannel` and sends a ready message to its exact same-origin opener;
3. the opener fetches the launch response and transfers the capability through the channel;
4. both sides validate origin, source window, one-time state, and message shape;
5. the opener drops its reference immediately after acknowledgement;
6. the child closes on timeout or origin mismatch.

The separate-page alternative is not valid for installed Android PWA launch: Chrome may reuse the standalone window,
leaving `/client/` without an opener and destroying the only in-memory sender. Installed mode must use the preferred
same-document mount.

Do not put the capability in a path, query, fragment, window name, BroadcastChannel, clipboard, or service-worker message.

## 6. Capability lifetime

The gateway has no secret store. A capability exists in gateway memory only while resolving one
authorized launch and returning its no-store response. It is then passed to the pinned client’s
in-memory bootstrap. Never place it in a URL, redirect, log, fixture, diagnostic, file, or browser
cache; reload returns to the directory.

## 7. Revisions and races

- Each registry mutation increments a daemon-wide revision.
- A client starts a new directory epoch by aborting any prior snapshot, closing its prior SSE source, fetching one authenticated snapshot, and only then opening SSE.
- Within one connected epoch, a response or event with a lower revision is ignored. Duplicate same-revision snapshots remain idempotent.
- The gateway emits a metadata-free `keepalive` SSE event every 5 seconds. After 12 seconds without a directory event or keepalive, a loaded dashboard marks gateway updates paused but retains the last authenticated metadata with a freshness timestamp and closes the stream. Initial snapshots time out after 4 seconds; recovery snapshots use 20 seconds. Retry delays are randomly selected from the upper half of exponentially growing caps of 1/2/4/8/16/30 seconds before a new SSE epoch. This is the current implementation, not ADR-016's original 4-second/1/2/4-second recovery policy; the discrepancy is recorded in the current audit note in [DECISIONS.md](DECISIONS.md#current-implementation-audit--2026-09-14).
- A dashboard page that the browser freezes (Page Lifecycle `freeze`, which Chrome on Android delivers about a minute after the page is hidden) closes its stream and cancels its liveness and retry timers without showing a failure. When the page becomes visible again, the ordinary resume path loads a fresh snapshot and opens a new stream. A briefly hidden page keeps its stream.
- A changed PWA shell caches completely before its worker calls `skipWaiting`. Activation deletes prior shell caches and claims clients; it never navigates a client, because a window client's URL is its creation URL rather than the route the page reached through the history API (ADR-018 amendment). An update-aware page reloads itself one second after its controller changes only while no launch is pending, no routed notification awaits its snapshot, and no collaboration client is mounted; otherwise the update applies when a failed launch returns to the directory or the user leaves collaboration. Activations by earlier workers may still navigate a client to no-store `/update/`, which the app synchronously replaces with `/`.
- Launch requests carry the generation observed in the metadata response.
- A mismatch never returns a capability.
- Expired and removed records are indistinguishable to remote callers.
- A session removed while a client page is opening closes or resets that page with a generic message.
- In the web app, every session is addressed in memory by `SourceKey = id + "\0" + origin`, `SessionRef = { sourceKey, instanceId, generation, requestId? }`, and session map key `sourceKey + "\0" + instanceId`. The source key is a browser-only discriminator and is never concatenated into an OMP `instanceId` or sent in any HTTP request, route, or relay frame. Device-local triage records in `localStorage` use `omp.sessions.held-asks.v2` and `omp.sessions.dismissed.v2` carrying `sourceId` and `sourceOrigin`.
- Remote fleet sources (`fleet.targets`) do not open `EventSource` streams. Each remote source maintains its own epoch, request sequence, revision, freshness timestamp, and error state, polling `GET <origin>/api/v1/sessions` with `{ mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", signal }` on visible start and every 10 seconds while visible (at most 1 request in flight per source, 5-second request timeout, 35-second stale grace window before last-seen rows expire, 8 MiB body limit, and 1 s → 30 s jittered failure backoff). A readable `403` transitions the remote source to `forbidden` (`Access withdrawn.`), clears its rows, disposes any active shell from that source, and pauses automatic polling until **Retry** or a foreground (`visibilitychange`, `pageshow`, or `online`) transition. Hidden or frozen pages abort in-flight remote polls without recording a failure and refresh immediately on `visibilitychange`, `pageshow`, or `online` before re-enabling stale actions. Within a remote source's current epoch, the latest completed request is authoritative (accepting a lower revision after a remote daemon restart) and older or prior-epoch responses are discarded; revisions are never compared across sources.
