# Mainline OMP integration

This guide tells integrators and contributors what OMP Session Gateway requires from stock Oh My Pi (OMP), how discovery, snapshot polling, capability brokering, and Tern session creation work, and where the integration boundary sits.

## Supported prerequisite

Stock mainline OMP `>= 18.1.20` is the only OMP prerequisite: no fork, custom OMP build, gateway-specific OMP plugin, or second OMP executable is used. The gateway consumes OMP's local registry without patching OMP or importing private controller APIs; releases earlier than `18.1.20` lack this registry and are unsupported.

Production deployment requires Bun `1.4.4`, TUN-mode Tailscale Serve, an exact login allowlist (`auth.allowedLogins`; [Installation and operations](OPERATIONS.md)), and the one-time `collab.autoStart` setting below.

| Surface | Pin or contract | Notes |
|---|---|---|
| Stock mainline OMP host | `>= 18.1.20` | Minimum OMP version supplying the native local registry (`collab.autoStart`). |
| Engineering host baseline | `v18.20.0` (`c308970263ae13744ea15ab67302e3dac840e266`) | Exact OMP commit and Git tree (`ba890953dd69eb4bf73bb7233bbe50ccfacd6912`) in [`UPSTREAM.lock.json`](../UPSTREAM.lock.json) ([Baseline review record](UPSTREAM_STRATEGY.md#baseline-review-record)). |
| Embedded browser client | `v18.20.0` (`@oh-my-pi/collab-web` `16.3.6`, `@oh-my-pi/pi-wire` `18.20.0`) | Provenance pin in [`packages/collab-client`](../packages/collab-client/README.md): independent `collab-web` source, wire dependency, and vendored `pi-utils` helper provenance, with bounded resync rejoin and older-host rendering retained. |
| Gateway runtime | Bun `1.4.4` | Required runtime for `omp-gateway` (the CLI), `omp-gatewayd` (the daemon), and release archives. |

For the latest release and its qualified hardware matrix, see [Current claim](COMPATIBILITY.md#current-claim) and [Release status](RELEASE_STATUS.md).

## Additive activity compatibility

Under registry v1 ([Protocol](PROTOCOL.md)), the gateway validates only the fields it reads and ignores unknown additive fields ([ADR-028](DECISIONS.md#adr-028--consume-mainline-omp-discovery-and-resolve-capabilities-only-at-launch)). Any snapshot naming `prompt`, `question`, `options`, `prefill`, `answer`, `requestId`, or `count` is refused as a privacy violation.

The minimum host stayed at `18.1.20` when the engineering baseline moved to `v18.20.0`: its registry and native IPC sources are unchanged from `v18.18.0`, and the additive guest resync and `select.approval` markers affect the embedded browser client, not the gateway's metadata registry reader.

OMP hosts (one running `omp` process per collaboration entry) at `18.2.9` or newer ([PR #12844](https://github.com/can1357/oh-my-pi/pull/12844)) emit optional boolean `busy` (OMP's `session.isStreaming` state): `true` while running a turn, `false` while idle, and unknown when omitted or `null`. OMP `18.1.20`–`18.2.8` hosts appear in the directory with unknown activity; `busy` is not proof of task completion or process exit.

Known `busy` activity appears in browser metadata and drives opt-in activity-stop alerts over Web Push v2 for local subscriptions and Web Push v3 for fleet notifications (where the home gateway sends alerts for selected remote hosts; [Fleet notifications](PROTOCOL.md#fleet-notifications)). Hosts with unknown activity do not trigger stop alerts; see [Activity-stop notifications](ATTENTION_SPEC.md#activity-stop-notifications) for trigger and read-only **View** tap rules (**Control** is writable).

## 1. Operator settings

Set `collab.autoStart` once in OMP so interactive sessions publish automatically:

```sh
omp config set collab.autoStart control
# Or choose read-only sharing:
omp config set collab.autoStart view
```

Equivalent settings JSON:

```jsonc
{
  "collab": {
    "autoStart": "control" // "off" | "view" | "control"; default "off"
  }
}
```

Start participating interactive sessions with plain `omp`. OMP starts collaboration after session initialization and writes its local discovery entry; the gateway discovers the OMP host on its next poll regardless of start order. Manual collaboration commands stay owned by OMP and need no gateway hook.

OMP publishes only after its relay opens the room. On OMP `18.5.1` and newer, an automatic start whose relay is unreachable or times out retries immediately and backs off from 1 to 60 seconds, publishing generation 1 (OMP's counter that increments when a session is replaced) once recovered; a room refusal is not retried. OMP `18.1.20`–`18.5.0` makes one startup attempt and shows `Collab auto-start failed` until `/collab`, a session switch, or a restart.

Changing `collab.autoStart` or upgrading `omp` on disk affects new `omp` processes; running sessions keep their loaded state until restarted. A **View** or **Control** link is a bearer secret, called a capability in the contracts: manual `/collab` prints capabilities to the terminal, so do not run it in a recorded or supervised session.

## 2. Discovery and per-host queries

OMP owns `~/.omp/run/collab-hosts` (`%USERPROFILE%\.omp\run\collab-hosts` on Windows; `PI_CONFIG_DIR` replaces the `.omp` directory name relative to the home directory), and the gateway can read an alternate path via `omp.discoveryDir`. Every publication consists of a private `<entryId>.json` discovery file and an owner-only query endpoint.

`OmpHostReader` (`apps/gateway/src/omp-registry.ts`) reads the discovery file's `version`, `instanceId`, `pid`, `endpoint`, `createdAt`, and per-host query `token`, and connects to the published endpoint verbatim ([Protocol](PROTOCOL.md)).

Upstream relocates overlong POSIX socket paths under `/tmp/omp-collab-<hash>` before `v18.10.2` and under owner-only `/tmp/omp-<euid>` (the effective Unix user ID) from `v18.10.2` ([`a608a9ca07`](https://github.com/can1357/oh-my-pi/commit/a608a9ca07c9443634e80d877d61c602099dab91)), which also creates `<entryId>.sock.bind.lock` beside each Unix socket and names Windows pipes `\\.\pipe\omp-<entryId>-<hash>`.

Discovery files are written once at publication time and never modified by the gateway. A killed OMP host's file stays on disk until `omp collab list` prunes it, so within its bounded per-round scan (`registry.maxSessions`, default `100`) the gateway reads unknown publications newest first and skips unchanged files whose endpoint proved dead, preventing leftovers from displacing newer sessions.

Queries use newline-framed JSON authenticated by the discovery file's `token`, one request and response per connection: `snapshot` returns metadata, and `link` resolves one exact generation and access mode (`view` or `control`) on launch ([Protocol](PROTOCOL.md)).

OMP also ships `omp collab list [--json]` and `omp collab link <instanceId|pid> [--view] [--json]`; `omp collab link` prints a capability, so never capture its output in logs, files, fixtures, or diagnostics, and the gateway never shells out to it.

### Isolated-HOME execution hosts

To run OMP under an isolated `HOME`, run OMP and `omp-gatewayd` as the **same OS uid on the execution host**, set `collab.autoStart` inside the isolated `HOME`, and point the gateway's absolute `omp.discoveryDir` at `<isolated-HOME>/.omp/run/collab-hosts` (adjusting `.omp` if `PI_CONFIG_DIR` is set). The gateway may keep its own `HOME` and XDG configuration root; only `omp.discoveryDir` must match.

For example, with a private `/private/tmp/omp-example-home` (`0700`):

```sh
HOME=/private/tmp/omp-example-home omp config set collab.autoStart control
HOME=/private/tmp/omp-example-home omp
```

Set `omp.discoveryDir` in `config.json` before starting the gateway:

```json
{ "omp": { "discoveryDir": "/private/tmp/omp-example-home/.omp/run/collab-hosts" } }
```

Keep the isolated `HOME` and discovery directory private (`0700`, with `0600` POSIX files and sockets). `OmpHostReader` refuses symlinks, foreign uids, and group or other permissions on the directory, discovery file, or POSIX socket (`apps/gateway/src/omp-registry.ts`); never widen ACLs, copy discovery files or tokens, or derive socket paths from filenames.

Each gateway reads one discovery root, and separate roots use separate local gateways with browser-direct federation ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors)).

Verify an isolated-`HOME` stock OMP binary locally with the lifecycle development harness:

```sh
bun install --frozen-lockfile
bun run build
bun scripts/omp-lifecycle-development.ts \
  --omp /opt/homebrew/bin/omp \
  --isolated-home --expect-version <omp-version>
```

On macOS, pass an absolute `--omp` binary path and replace `<omp-version>` with the three-part version from `omp --version`; omitting `--expect-version <omp-version>` requires `packageVersion` from `UPSTREAM.lock.json` (`scripts/omp-lifecycle-development.ts`).

The harness creates a private `HOME`, sets `collab.autoStart=control`, runs a loopback gateway against that `omp.discoveryDir`, attaches the embedded client in **View** and **Control** across an owned `/quit` restart, and verifies card revocation and OMP-owned file removal without capturing terminal output, capabilities, screenshots, or traces; see [Observed isolated-HOME proof — 2026-10-23](#observed-isolated-home-proof--2026-10-23).

## 3. Polling and lifecycle

`startHostPoller` (`apps/gateway/src/omp-registry.ts`) coalesces concurrent polls and reconciles observed snapshots with retained hosts. `registry.heartbeatSeconds` sets the poll interval (default `10` seconds) and `registry.ttlSeconds` sets retention for unreachable hosts (default `35` seconds, greater than twice `heartbeatSeconds`; [Gateway configuration reference](OPERATIONS.md#14-gateway-configuration-reference)).

Only `ENOENT` and `ECONNREFUSED` prove a queried OMP host dead. Timeouts, `EMFILE`, `EACCES`, and wire errors such as `snapshot_unavailable` retain an observed card until TTL expiry, while entries removed from the discovery directory drop on the next poll. Stopping or restarting `omp-gatewayd` does not interrupt OMP publication or require an OMP reconnect.

OMP's `instanceId` keys each session card, and `generation` identifies session replacement (`PID` alone is unsafe because PIDs are reused). The gateway projects `sessionName`, the basename of `cwd` (`cwdLabel`), and `model` (`provider/id`) into bounded labels, and turns boolean `inputRequired` into an opaque gateway `ask.requestId` and receipt timestamp without prompt text or option counts.

Auto-titled sessions on OMP `18.8.1` and newer format `sessionName` as `<icon> <CODE>: <title>` within the gateway's 256-code-point label bound.

## 4. Per-launch capability broker

`OmpLaunchResolver` (`apps/gateway/src/omp-registry.ts`) checks the requested `generation`, mode (`view` or `control`), and optional `requestId` against current registry metadata, queries `link` on that OMP host, and revalidates metadata before returning the capability. The gateway never stores or caches capabilities in disk or memory state.

Launch refusals distinguish `generation_mismatch` (HTTP `409`), `request_mismatch` (`409`), `missing` (`404`), and `mode_unavailable` (HTTP 409 when the OMP host does not share the requested mode; [Protocol](PROTOCOL.md)). Capabilities exist only in the transient query/response and active browser memory, and gateway log fields are numeric or boolean only ([Security §11](SECURITY.md#11-logging-diagnostics-and-test-artifacts)).

## 5. Gateway configuration and readiness

`omp.discoveryDir` defaults to `~/.omp/run/collab-hosts` (or `~/<PI_CONFIG_DIR>/run/collab-hosts`), and `omp.queryTimeoutMs` defaults to 1,500 ms (`1500` in JSON; [Gateway configuration reference](OPERATIONS.md#14-gateway-configuration-reference)).

The gateway's private `readiness-token` authenticates managed loopback readiness checks only and is never sent to OMP. `omp-gateway doctor` checks that `omp` on `PATH` is `>= 18.1.20` (`compatibility`), that `omp.discoveryDir` is absent or safely readable (`discoveryReadable`), and that observed hosts are healthy (`sessionHealth`; [`doctor` and diagnostics bundle](OPERATIONS.md#12-doctor-and-diagnostics-bundle)).

## 6. Client and qualification boundary

The gateway embeds the pinned `collab-web` client ([`packages/collab-client`](../packages/collab-client/README.md)) with same-page in-memory capability bootstrap ([Protocol §5](PROTOCOL.md#5-in-memory-collab-client-bootstrap)).

Its embed contract exposes `loading: { received, total } | null` snapshot counters for the shell's connection chip and optional `takeInitialPromptDraft()`, which drains a volatile first-task draft once into an empty composer in live writable **Control** without auto-sending or reapplying on reconnect. Photo attachments travel over OMP's encrypted `{ t: "prompt", text, images }` relay frames and never pass through the gateway HTTP server or service worker.

Unit and integration checks for discovery, polling, and launch brokering are in `apps/gateway/test/omp-registry.test.ts` (for an example upstream tag-diff check, see [18.12.5 → 18.12.6 discovery/collaboration contract delta](#18125--18126-discoverycollaboration-contract-delta-2026-10-23)).

Release qualification exercises stock OMP publication, **View** and **Control** launches and refusals, session replacement and stop, gateway restart, transient query faults, and capability non-persistence; see [Test plan](TEST_PLAN.md), [Current claim](COMPATIBILITY.md#current-claim), and [Release status](RELEASE_STATUS.md).

## Running OMP inside Tern

Tern is a terminal environment where stock OMP runs, not a separate discovery integration ([ADR-038](DECISIONS.md#adr-038--tern-is-an-execution-environment-not-an-integration)); [ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption) adds only opt-in process creation and metadata-only adoption:

- **Terminal-independent discovery:** stock OMP `>= 18.1.20` started inside a Tern pane, tab, or window publishes under `~/.omp/run/collab-hosts` (or `~/<PI_CONFIG_DIR>/run/collab-hosts`) whenever `collab.autoStart` is `control` or `view` under the same OS user as `omp-gatewayd` ([Developer-workstation smoke](#developer-workstation-smoke-2026-10-22)).
- **Identity and mirroring:** gateway session identity is OMP's `instanceId` and `generation`. Multiple Tern windows or panes mirroring one `omp` process share one OMP discovery entry and appear as one row in **OMP Sessions** (the browser app); Tern block IDs are recorded only in `<stateDir>/session-creations.json`.
- **Remote Tern panes:** an `omp` process in a Tern pane on another machine is discovered by `omp-gatewayd` on that execution host and reached on that host's app or via browser-direct federation ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors)), never by inspecting local terminal windows.
- **Browser launch semantics:** tapping **View** or **Control** mounts the embedded `collab-web` client in the browser rather than focusing or typing into a native Tern pane.
  Native **Open in Tern** handoff is unsupported on Android because Tern Android (`so.stencil.tern`) declares only `MAIN`/`LAUNCHER` without `VIEW`, `BROWSABLE`, URL schemes, or App Links ([tern-sdk #143](https://github.com/stencil-hq/tern-sdk/issues/143); [Pixel installed-build inventory](#pixel-installed-build-inventory-2026-10-24)). Desktop native handoff is **Deferred** ([Status vocabulary](COMPATIBILITY.md#status-vocabulary); `/Applications/Tern.app` registers `tern` for pairing only).
- **Default has no Tern dependency:** when `tern` is omitted from `config.json`, installation, `doctor`, discovery polling, and session launches never probe or require Tern. No Tern discovery adapter, pane scraper, general terminal control API, or reader for OMP's Tern Surface Protocol (`tsp.ts`) wire surface is used.

### Opt-in creation and adoption

Administrator configuration, path/profile bounds, and `tern.window` setup are in [Tern session creation](OPERATIONS.md#9-tern-session-creation); the phone flow is in [Start a new session](USAGE.md#start-a-new-session).

On the OMP side, `profile.env` supplies only the `tern` CLI child's environment and does not cross Tern's GUI-server RPC boundary into the spawned pane. OMP inside Tern's pane environment must therefore already resolve the configuration root that publishes to `omp.discoveryDir` and have `collab.autoStart` set to `control` (`view`-only sessions appear in the directory but cannot complete **Control** adoption).

During creation (`apps/gateway/src/tern-cli.ts`, `apps/gateway/src/tern-creation.ts`), `omp-gatewayd` runs `[executable, "new", "tab", "--json", "--keep-open", "--cwd", path, "--", ...profile.argv]` — printing `{"block": <uint64>}` — and polls `tern inspect --json`, which returns `sessions[].tabs[].blocks[]` (`id`) and `panes[]` (`pane` and `omp_session_file` named `<ISO-timestamp>_<sessionId>.jsonl`; [Pixel installed-build inventory](#pixel-installed-build-inventory-2026-10-24)).

When `tern.window` is configured (`""` for the first window or `"2"`–`"999"`), `omp-gatewayd` inserts `["--window", KEY]` after `"new", "tab"` and after `"inspect", "--json"` on every inspection without fallback or selector-free retry.

The parser decodes unsigned 64-bit IDs losslessly, rejects remote host tags at bit 56 or above, requires a 1:1 `block === blocks[].id === panes[].pane` match, and matches the `[A-Za-z0-9-]+` `sessionId` token in `basename(omp_session_file)` (without `.jsonl`) against a post-spawn OMP discovery round without opening the JSONL file.

Once one fresh host binding is authorized for `control` in `SessionRegistry` (`apps/gateway/src/registry.ts`), creation reaches `ready` (`{ instanceId, generation }`) for an ordinary **Control** launch ([Session creation state machine](PROTOCOL.md#session-creation-state-machine)).

## Dated observations

The sections below are dated development and device observations and are kept as written.

### Observed isolated-HOME proof — 2026-10-23

The exact command above passed on the macOS Apple-silicon developer workstation with the
installed stock native OMP `18.12.6` and Bun `1.4.0` (71.65 seconds). The real gateway consumed
only the fresh HOME's explicit discovery root; both initial and restarted OMP processes attached
through the real embedded client/stock relay in View and Control. This is **Smoke-tested**
developer evidence, not a signed-release, retained-host, Tailscale Serve or physical-phone
qualification. No Tern or proxy was involved; the harness submitted no model prompt.

Observed output (all fields retained; decimal `448` is octal `0700`):

```json
{
  "passed": true,
  "ompVersion": "18.12.6",
  "isolatedHome": true,
  "discovery": {
    "sameUid": true,
    "directoryMode": 448,
    "privatePublication": true
  },
  "initial": {
    "published": true,
    "viewAttached": true,
    "viewReadOnly": true,
    "controlAttached": true,
    "controlWritable": true
  },
  "restart": {
    "newInstance": true,
    "generation": 1,
    "republished": true,
    "viewAttached": true,
    "controlAttached": true
  },
  "revocation": { "cardsRemoved": 2, "filesRemoved": 2 },
  "cleanup": { "stopped": true, "privateRootRemoved": true }
}
```

An earlier forced-termination attempt revoked the card but failed the pre-cleanup discovery-file
removal check; OMP's own later listing pruned the stale file. The passing proof waits for ordinary
`/quit` shutdown instead. It does not turn forced process death into a claim of immediate file
removal, and the gateway never deletes or repairs a publication.

### 18.12.5 → 18.12.6 discovery/collaboration contract delta (2026-10-23)

Compared the canonical stock tags, not the retired downstream fork:
`v18.12.5` = `d5cd750e41fede277f9eb933455da92a0738915e`;
`v18.12.6` = `45c35e40c46166dc726ccc52f5d27f40f2449f99`. With
`OMP_SOURCE_CHECKOUT` pointing to the local checkout containing those stock tags, used:

```sh
git -C "$OMP_SOURCE_CHECKOUT" log v18.12.5..v18.12.6 -- \
  packages/coding-agent/src/collab \
  packages/coding-agent/src/cli/collab-cli.ts \
  packages/coding-agent/src/slash-commands/builtin-collaboration.ts \
  packages/collab-web packages/wire/src docs/collab.md
```

The scoped log and scoped diff were empty: controller, private registry, host/query protocol,
relay/client and collaboration CLI sources are unchanged. `packages/wire/package.json` changes
only its version from `18.12.5` to `18.12.6`; its protocol source is unchanged. The
[18.12.6 coding-agent changelog](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/CHANGELOG.md#18126---2026-10-21)
records ACP steering/cancellation, MCP reauthentication, print builtins, deferred interactive
extension loading, subagent fallback/usage fixes and browser-tab close confirmation, not a
discovery/collaboration schema change. Deferred extension startup may change startup timing, so
the proof waits for real publication rather than assuming a fixed delay.

For this focused seam, a host-baseline bump is **contract-benign**, subject to the observed
consumer proof and unchanged registry/client sources; it is not a claim that every 18.12.6 runtime
change is benign or release-qualified. `UPSTREAM.lock.json` remains at `v18.12.5`; a baseline
bump is a separate control change with its normal review and qualification. The independent
embedded client pin remains unchanged too.

### Pixel installed-build inventory (2026-10-24)

Read-only device and desktop CLI probes on 2026-10-24 recorded:

- **Android build (`Pixel 10 Pro`, `blazer`, Android 17 patch `2026-10-05`):** Chrome `155.0.8059.84`, Tailscale `com.tailscale.ipn`, installed **OMP Sessions** WebAPKs, and sideloaded Tern Android `so.stencil.tern` `0.9.5` (`versionCode 905`, `minSdk 28`, `targetSdk 34`).
- **Intent-filter probe (`dumpsys package so.stencil.tern`, `pm get-app-links so.stencil.tern`):** `so.stencil.tern/so.stencil.platform.StencilActivity` declares only `android.intent.action.MAIN` + category `LAUNCHER` — no `VIEW`, `BROWSABLE`, URL scheme, domain, or App Links ([tern-sdk #143](https://github.com/stencil-hq/tern-sdk/issues/143)).
- **Desktop CLI probe (macOS, Tern `0.9.5` build `2863c37`):** `tern new tab --json --keep-open --cwd <dir> -- <argv…>` prints `{"block": <uint64>}` in the first window; `tern inspect --json` prints `sessions[].tabs[].blocks[]` and `panes[]` with matching numeric `id` and `pane` (observed `317827580031` on both) and `omp_session_file` (`<ISO-timestamp>_<sessionId>.jsonl`). `/Applications/Tern.app` registers URL scheme `tern` ("Tern pairing link", role Viewer) without documented session-routing semantics.
- **Boundary:** Confirms the Android native-handoff blocker and desktop CLI correlation facts; it is not an end-to-end physical qualification of ADR-043 creation.

### Developer-workstation smoke (2026-10-22)

Running stock OMP inside Tern with two-gateway federation and speech UI was **smoke-tested on 2026-10-22** ([Status vocabulary](COMPATIBILITY.md#status-vocabulary): developer-workstation smoke evidence, not a CI lane and not release qualification):

- **Environment:** Tern `0.9.5` (build `2863c37`) on macOS (Apple silicon); stock OMP `18.12.6` (Homebrew install, one patch release above the `v18.12.5` engineering host baseline pin in `UPSTREAM.lock.json`); configuration root `~/.omp` (`PI_CONFIG_DIR` unset); discovery directory `~/.omp/run/collab-hosts`; `collab.autoStart = control`.
- **Native discovery inside Tern panes:** fresh interactive OMP sessions were started inside Tern panes with the Tern CLI (`tern new tab --cwd <dir> -- env OMP_SKIP_SETUP=1 omp …`), one with the repository's synthetic-key fixture arguments and one with the operator's ordinary model credentials. Each published its native discovery entry within ~13 s of launch; the gateway's `OmpHostReader` observed every Tern-hosted host (`access: control`, `relayConnected: true`) and ignored ~220 stale publications left by earlier sessions.
- **Two-gateway loopback federation, remote Control, ask round-trip, outage isolation, and injected speech flow:** two gateways built from this tree ran in `dev-localhost` mode on loopback ports from private `XDG_CONFIG_HOME` directories, both reading the same discovery directory. The home gateway listed the other as a `fleet.targets` entry and had `speech.browserRecognition: true`; the remote gateway listed the home origin in `http.trustedDashboardOrigins`. In the home PWA (desktop Chrome):
  - the **Host** picker showed `All hosts` / `Home` / `Remote`, and the same three Tern-hosted `instanceId` values appeared as six independent rows labelled by host;
  - a **View** launched from a home row posted to the home origin;
  - with the picker on the remote host, **View** and then **Control** posted to the remote origin through a real preflight (`OPTIONS …/launch` `204`, then `POST …/launch` `200`) with no credentials, the shell bar named the remote host, and the relay connected;
  - a synthetic prompt sent through remote **Control** was acknowledged by the Tern-hosted OMP (echoed in the transcript, then the expected synthetic-key `401`);
  - a real ask raised by the second session surfaced as metadata only (`inputRequired: true`, opaque `ask.requestId`, no preview) and was answered from the embedded ask through remote **Control**, after which OMP replied and both gateways reported `inputRequired: false`;
  - stopping the remote gateway produced `Remote: Cannot reach this host from this app.` with **Retry** and `Host coverage incomplete — Unavailable: Remote` while home rows stayed usable;
  - the keyboard-dictation help (`Use your keyboard's microphone key to dictate into this box. iPhone: Settings → General → Keyboard → Enable Dictation. Dictation never sends — tap Send when the text is right.`) and the opt-in speech flow (`Your browser or OS may send audio to its speech provider before any OMP prompt is sent.` disclosure → **Start** → listening with interim/final text → **Stop** → editable review → **Use text** filled the draft while **Send** stayed separate and nothing was sent) worked in the real bundle using a fake `SpeechRecognition` constructor injected before load (no microphone was used).
- **Not exercised and still pending:** any phone or installed PWA, the HTTPS Tailscale Serve path (identity headers and real CORS over Serve), Wi-Fi/cellular transitions, session replacement (`/new`, `/fork`), reconnect, and shutdown while inside Tern beyond closing the panes, native browser speech recognition on any device, and Pixel or iPhone keyboard dictation. Issue [#380](https://github.com/carrythroughsystems/omp-session-gateway/issues/380)'s installed-iPhone acceptance is therefore not satisfied yet; see [TEST_PLAN.md](TEST_PLAN.md#g-tern-multi-host-federation-and-speech-input-acceptance-matrix).
