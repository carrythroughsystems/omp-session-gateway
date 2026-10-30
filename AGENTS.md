# Repository agent instructions

This file applies to the entire repository unless a more specific `AGENTS.md` exists below a
subdirectory.

## Product boundary

OMP Session Gateway is a secure, local-first directory and capability broker for the browser
collaboration pages of currently running interactive Oh My Pi (OMP) processes.

- Reuse OMP's existing `packages/collab-web` client and wire protocol.
- The PWA lists sessions and launches that client; it does not render or mutate transcripts.
- Opt-in Tern creation starts a new interactive OMP process on its execution host from
  administrator-approved project, working-copy, and profile IDs, then adopts it through OMP's
  own discovery (ADR-043). An optional first-task draft stays in browser memory and never auto-sends.
- Consume mainline OMP’s discovery/query contract; keep gateway changes independent of OMP internals.
- Do not add terminal injection, terminal or PTY scraping, QR decoding, clipboard monitoring,
  process-memory inspection, or saved-session-file scraping.
- Do not claim affiliation with or endorsement by OMP, and do not reuse OMP artwork without
  permission.

## Sources of truth

Read the documents governing the subsystem before changing it:

- architecture or trust boundaries: `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, and
  `docs/SECURITY.md`;
- IPC or HTTP contracts: `docs/PROTOCOL.md`;
- OMP integration: `docs/OMP_INTEGRATION.md` and `UPSTREAM.lock.json`;
- release claims: `docs/TEST_PLAN.md`, `docs/COMPATIBILITY.md`, and
  `docs/RELEASE_STATUS.md`.

`UPSTREAM.lock.json` is the exact current OMP baseline. Inspect that source rather than relying on
an older prose snapshot. Update the lock, compatibility data, integration notes, and accepted decisions
together when the baseline or design changes. Keep `bun run check` green.

## Product names

- Product and repository: **OMP Session Gateway** / `omp-session-gateway`
- Management CLI: `omp-gateway`
- Daemon: `omp-gatewayd`
- Optional foreground alias: `omp-gateway serve`
- Service identifier: `omp-session-gateway`
- PWA name: **OMP Sessions**
- Default example tailnet tag: `tag:omp-session-gateway`

## Architecture and security invariants

### Network and IPC

- Production HTTP listeners bind only to `127.0.0.1` and optionally `::1`.
- Tailscale Serve over tailnet HTTPS is the supported remote path. Do not configure or document
  Tailscale Funnel as a normal path.
- Trust Tailscale identity headers only on the loopback backend behind Serve. Production rejects
  missing identity and compares normalized `Tailscale-User-Login` against an exact allowlist.
- Development auth may allow loopback clients without Tailscale, but must reject non-loopback
  sources.
- Require stock mainline OMP `>= 18.1.20`; the controller and local registry shipped in
  PR #11908 (`4999b98bd5`), carried by `v18.1.20`.
- The gateway only reads OMP’s private discovery directory and queries each host’s published endpoint.
  Never write, rename, or unlink discovery files or sockets; never derive the endpoint from a filename.
- Per-host discovery tokens authorize queries to OMP; the gateway’s private readiness token proves
  managed loopback readiness to its CLI and is never an OMP credential.
- The registry is metadata-only and memory-only. A daemon restart begins empty; polling repopulates it.
- Keep metadata records structurally separate from transient launch responses.

### Capabilities

View and Control links are bearer secrets. They may exist only in:

- the live OMP process;
- authenticated per-host query and launch request memory;
- one no-store launch response; and
- volatile collaboration-client JavaScript memory.

They must never enter files, databases, ordinary logs, diagnostics, tracing, metrics, crash reports,
URLs, redirect locations, cookies, browser storage, service-worker caches, analytics, third-party
assets, screenshots, recordings, issue fixtures, or CI artifacts. JavaScript strings cannot be
reliably zeroized; minimize their lifetime and references instead of claiming zeroization.

Session-list and SSE responses contain metadata only. Fetch a capability only after an explicit View
or Control action. Launch requests include the expected generation; stale cards fail rather than
receiving a newer capability. Transfer capabilities to the same-origin pinned client in memory. The gateway fetches each
capability from OMP at launch time and never stores or caches it, even in the registry.
Gateway log fields are numeric or boolean only; never log strings from host queries or metadata.

### HTTP and browser

- Validate exact `Origin` on state-changing requests and evaluate `Sec-Fetch-Site` defensively (`requestHasValidMutationContext` for same-origin routes; `requestHasTrustedDashboardContext` for cross-origin launches and creations from `http.trustedDashboardOrigins`).
- Do not use wildcard CORS or `Access-Control-Allow-Credentials`. Cross-origin admission is bounded to at most 8 `http.trustedDashboardOrigins` and exposed only on `GET /api/v1/sessions`, `POST /api/v1/sessions/:instanceId/launch`, `GET /api/v1/session-creation-options`, `POST /api/v1/session-creations`, `GET /api/v1/session-creations/:operationId` (exact lowercase UUIDv4), and their `OPTIONS` preflights (`fleet.targets` is bounded to 7 remote targets, 8 sources total with `local`). `/api/v1/events`, `/api/v1/push/*`, `/api/v1/client-config`, `/api/v1/health`, and static assets are never exposed cross-origin. An opted-in target trusts those dashboards to create processes from its configured profiles, not merely read metadata or open existing sessions.
- Keep `SourceKey` (`id + "\0" + origin`) strictly as a dashboard-side in-memory discriminator; never concatenate it into an OMP `instanceId` or send it on the wire. Device-local triage storage (`omp.sessions.held-asks.v2`, `omp.sessions.dismissed.v2`) records `sourceId` and `sourceOrigin` without labels or capabilities, and Web Push / app badges remain scoped to the home gateway only.
- API, creation, and launch responses are `no-store`.
- Set strict CSP (`connect-src` extended on document HTML only with `fleet.targets[].origin`), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, frame protections, and a narrow Permissions Policy (`microphone=()` by default and on all non-document responses; `microphone=(self)` on document HTML only when `speech.browserRecognition` is `true`).
- `speech.browserRecognition` defaults to `false`. When enabled, the in-page Web Speech control mounts only in writable **Control**, and **Use text** only populates the composer draft — it never submits (**Send** remains a separate action).
- The service worker caches only immutable application-shell assets and bypasses cross-origin, navigation, non-GET, `/api/`, and collaboration-client bootstrap traffic.
- Keep runtime assets first-party; do not add analytics, remote fonts, third-party scripts, or CDNs.

## OMP integration invariants

Manual collaboration commands and automatic startup share one collaboration controller; never
duplicate `CollabHost` ownership or import unstable private APIs from an external plugin.

The supported settings contract is:

```jsonc
{
  "collab": {
    "autoStart": "off" // "off" | "view" | "control"
  }
}
```

- `off` preserves normal OMP behavior.
- Start only after interactive context and session initialization complete.
- Register only after the collaboration host connects successfully.
- `view` permits View queries; `control` permits View and Control queries.
- Revoke generation N before publishing N+1 whenever the active host or session changes.
- Stop, shutdown, and fatal host failure unregister immediately.
- OMP publication is independent of gateway availability; OMP does not connect to the gateway.
- Preserve `/collab`, `/collab view`, `/collab status`, `/collab stop`, `/join`, and
  `/leave` behavior.
- Tern remains an execution environment for stock OMP (ADR-038, narrowly amended by ADR-043): session identity stays OMP's `instanceId` and `generation` from OMP-native discovery. No Tern discovery adapter or general control surface, `tsp.ts` reader, pane scraping, focus, attachment, or keystrokes; only opt-in ADR-043 new-tab creation and inspect-metadata adoption on the execution host.
- Creation uses administrator-authored argv arrays and an explicit complete CLI environment, never browser-selected executables, paths, argv, env, or task text. Persist private capability-free intent before spawning; uncertainty never permits automatic re-spawn. Browser cancellation stops watching, not the process.

## Reliability and bounds

- `registry.heartbeatSeconds` is the discovery poll interval (default 10 seconds); TTL defaults to
  35 seconds and must exceed twice the interval. Both remain bounded configuration values.
- Expiry uses daemon receipt time from a monotonic clock.
- Only `ENOENT`/`ECONNREFUSED` proves a queried host dead. Timeouts, permission/resource errors,
  and wire errors retain its card until TTL expiry; absence from discovery removes it.
- Poll rounds coalesce, and launches revalidate generation, access, and any attention request identity.
- Bound host entries, records, query and body sizes, SSE queues, titles, and paths.
- Keep the current OMP relay for the supported path. A self-hosted or proxied relay remains
  unsupported until separately threat-modeled and soak-qualified.

## Change and release discipline

- Fix the source behavior; do not suppress failures or special-case fixtures.
- Add or update tests for every behavior change, including failure modes and secret non-persistence.
- Use distinctive synthetic secrets and keep capability and identifier leak scans green.
- Exercise the real changed surface before declaring it working.
- Use the Tested / Supported / Qualified vocabulary in `docs/COMPATIBILITY.md` (ADR-030). Claim
  support only for platform families whose named CI lanes are green, and qualification only for the
  exact combinations marked qualified in `docs/RELEASE_STATUS.md` and `docs/COMPATIBILITY.md`. Never
  present hosted-runner, emulated-device, or smoke evidence as qualification.
- Update architecture, protocol, operations, compatibility, security, and changelog material when
  their contracts change. Record accepted architecture changes in `docs/DECISIONS.md`.
- Changelog entries are `changelog.d/` fragments; never edit `CHANGELOG.md` `[Unreleased]` directly.
  Follow `changelog.d/README.md`: one section-prefixed file per bullet, two-space continuations,
  lines at most 100 characters, and a trailing LF newline. Test-only changes need no fragment.
- Keep generated assets and unrelated refactors out of integration changes.
- Use Conventional Commits subjects: `type(scope): lowercase imperative description` or
  `type: lowercase imperative description`.

