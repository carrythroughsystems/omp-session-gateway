# Mainline OMP integration

## Supported prerequisite

Use stock mainline OMP `>= 18.1.20`. The integration is native to stock OMP: no fork, custom OMP
build, or gateway-specific OMP plugin is required. The separately installed gateway consumes OMP's
local registry; it does not patch OMP, import private controller APIs, or install a second OMP
executable. Releases earlier than `18.1.20` lack this registry and are unsupported. Deployment
requires Bun `1.4.0`, TUN-mode Tailscale Serve, an exact login allowlist, and the one-time
`collab.autoStart` setting below.

| Surface | Pin or contract | Notes |
|---|---|---|
| Stock mainline OMP host | `>= 18.1.20` | Minimum host version supplying the native local registry (`collab.autoStart`) |
| Engineering host baseline | `v18.12.3` (`53a0377db6845e0dae606146130766ec92d407fd`) | Exact OMP source and tree (`51822a49a4cc7eebabdb1e848c79f8aa873deb40`) in `UPSTREAM.lock.json` |
| Embedded browser client | `v18.4.2` (`@oh-my-pi/collab-web` `16.3.6`, `@oh-my-pi/pi-wire` `18.4.2`) | Independent browser-client provenance pin in [`packages/collab-client`](../packages/collab-client/README.md); it does not import the `collab-web` Markdown-rendering changes upstream shipped in v18.4.12, the render-coalescing changes in v18.8.0 ([can1357/oh-my-pi#14728](https://github.com/can1357/oh-my-pi/pull/14728)), or the eval-output rendering changes in v18.12.3 ([can1357/oh-my-pi#12730](https://github.com/can1357/oh-my-pi/pull/12730)) |
| Gateway runtime | Bun `1.4.0` | Required runtime for the CLI, daemon, and release archives |

For the current published release and its qualified hardware matrix, see
[Compatibility](COMPATIBILITY.md) and [Release status](RELEASE_STATUS.md).

## Additive activity compatibility

Under registry v1, the gateway validates the fields it reads and ignores unknown additive fields
(ADR-028). Any snapshot naming prompt, question, options, prefill, answer, requestId, or count is
refused. The minimum host version stayed unchanged when the engineering baseline later moved to
v18.12.3.

Hosts from OMP `18.2.9` onward (upstream
[PR #12844](https://github.com/can1357/oh-my-pi/pull/12844)) may include optional boolean `busy`
(`session.isStreaming`): `true` while running a turn, `false` while idle, and unknown when omitted
or `null`. Older hosts remain visible in the same directory with unknown activity. `busy` is not
proof of successful task completion or process exit.

Known `busy` activity is projected into browser metadata and drives opt-in activity-stop alerts
through the existing Push v2 channel. Older hosts remain unknown and do not produce stop alerts.
See [ATTENTION_SPEC.md](ATTENTION_SPEC.md#activity-stop-notifications) for the exact trigger and
View-only tap semantics; no extra OMP setting is needed.

## 1. Operator settings

The only required OMP setting is:

```sh
omp config set collab.autoStart control
# Or choose read-only sharing:
omp config set collab.autoStart view
```

Equivalent settings:

```jsonc
{
  "collab": {
    "autoStart": "control" // "off" | "view" | "control"; default "off"
  }
}
```

Start participating interactive sessions with plain `omp`. OMP owns automatic collaboration
startup after session initialization and publishes its own local discovery entry. The gateway
discovers the host on its next poll, whether OMP or the gateway started first. Manual collaboration
commands remain OMP’s responsibility and require no gateway integration hook.

OMP publishes only after its relay opens the room. From OMP `18.5.1` onward, an automatic start
whose relay is unreachable or times out retries immediately and then backs off from 1 to 60
seconds, and the recovered room still publishes generation 1. A relay that refuses the room is not
retried. Earlier `18.1.20`–`18.5.0` releases make one startup attempt: if it fails, the session
shows `Collab auto-start failed` and stays out of the session list until `/collab`, a session
switch, or a restart.

Enabling `collab.autoStart` or upgrading the `omp` executable on disk applies to newly started
`omp` processes; already-running sessions keep their loaded process state until restarted. Manual
`/collab` prints bearer capabilities to the terminal, so do not run it in a recorded or supervised
session.

## 2. Discovery and per-host queries

OMP owns `~/.omp/run/collab-hosts`. `PI_CONFIG_DIR` replaces the `.omp` directory name relative
to the home directory. The gateway can select another directory through `omp.discoveryDir`.
Every publication consists of a private discovery file and an owner-only query endpoint.

`OmpHostReader` reads the file’s version, instance identity, PID, endpoint, creation time, and
per-host query token. It uses the published endpoint verbatim: long socket paths may be relocated
under `/tmp/omp-collab-<hash>` before v18.10.2 and under the owner-only `/tmp/omp-<euid>` from
v18.10.2 ([`a608a9ca07`](https://github.com/can1357/oh-my-pi/commit/a608a9ca07c9443634e80d877d61c602099dab91)),
which also leaves a `<entryId>.sock.bind.lock` file beside each socket and names Windows pipes
`\\.\pipe\omp-<entryId>-<hash>`. Discovery files are written once, so file timestamps do not
represent metadata freshness. The gateway only reads them and never repairs or removes them. A
killed host's file stays until an OMP listing (`omp collab list`) prunes it. Because each file's
timestamp is its publication time, the gateway reads unknown publications newest first and skips
unchanged files whose endpoint already proved dead, so leftovers cannot displace a new session.

Queries are newline-framed JSON, one request and response per connection. `snapshot` returns
metadata, while `link` resolves one exact generation and role on an explicit launch. The complete
file, snapshot, operation, and error-code contracts are in [PROTOCOL.md](PROTOCOL.md).

OMP also provides `omp collab list [--json]` and
`omp collab link <instanceId|pid> [--view] [--json]`. The latter deliberately outputs a bearer
capability: do not capture it in logs, files, fixtures, diagnostics, or issue reports. The gateway
queries the endpoint directly and never shells out to a link-printing command.

## 3. Polling and lifecycle

`startHostPoller` coalesces concurrent rounds and reconciles observed metadata with retained
hosts. `registry.heartbeatSeconds` is the poll interval (default 10 seconds);
`registry.ttlSeconds` defaults to 35 seconds and must exceed twice that interval.

Only `ENOENT`/`ECONNREFUSED` proves a queried host dead. Timeouts, `EMFILE`, `EACCES`, and
wire errors such as `snapshot_unavailable` retain a previously observed card until TTL expiry.
A host absent from discovery is removed; a reply followed by socket close is normal query framing.
A stopped gateway has no effect on OMP publication, and restarting it requires no OMP reconnect.

OMP’s instance identity keys the process card. Generation changes identify host replacement; PID
alone is unsafe because PIDs are reused. The gateway maps `sessionName`, `cwd`, and model
metadata to bounded browser labels, with basename-only paths by default. `inputRequired` is a
boolean, not a prompt or answer. The gateway derives its own opaque attention identity and receipt
time for browser routing; mainline OMP does not supply previews or option counts.
From 18.8.1, OMP writes a generated session title in the card form `<icon> <CODE>: <title>`
(upstream `355b5d9685529d337875d7d387ef53b1f32e7a72`), so an auto-titled session's `sessionName`
label may begin with an emoji or Nerd Fonts glyph and a short capitalized code. The field stays a
string within the gateway's label bound.

## 4. Per-launch capability broker

`OmpLaunchResolver` authorizes the requested generation, role, and optional attention request
identity against current metadata, fetches a link from that OMP host, and revalidates before
release. The gateway never stores or caches a capability, including in its memory-only registry.

HTTP list/SSE and launch shapes remain unchanged. Launch refusal includes `generation_mismatch`,
`request_mismatch`, `missing`, and `mode_unavailable`; the last becomes HTTP 409 when the host
no longer shares the requested role. Capabilities remain confined to transient query/response and
active client memory and never appear in logs or diagnostics. Gateway log fields are numeric or
boolean only.

## 5. Gateway configuration and readiness

`omp.discoveryDir` defaults to the OMP directory above; `omp.queryTimeoutMs` defaults to 1500.
The gateway’s `readiness-token` proves managed loopback readiness only and is not sent to OMP.
`doctor` checks that `omp` on PATH reports at least `18.1.20` (`compatibility`), verifies discovery
is absent or safely readable (`discoveryReadable`), and reports `sessionHealth`.

## 6. Client and qualification boundary

The gateway embeds the pinned OMP `collab-web` integration with in-memory capability bootstrap. The
photo composer uses existing encrypted v3 image prompts; it does not add a gateway media endpoint
or alter the discovery/query contract.

Behavioral coverage for the registry reader and broker lives in
`apps/gateway/test/omp-registry.test.ts`. Release qualification exercises the stock OMP binary,
View/Control launch and refusal, host replacement and stop, gateway restart, transient query
failures, capability non-persistence, and the client/relay path; see [TEST_PLAN.md](TEST_PLAN.md),
[COMPATIBILITY.md](COMPATIBILITY.md), and [RELEASE_STATUS.md](RELEASE_STATUS.md).

