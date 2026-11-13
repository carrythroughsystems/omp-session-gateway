# `apps/gateway`

This package implements the `omp-gateway` CLI and the per-user `omp-gatewayd` daemon; use this guide to find the module, command, state file, or test suite that owns each gateway behavior. The daemon reads the collaboration discovery directory published by stock Oh My Pi (OMP) `>= 18.1.20` under Bun `1.4.4` behind TUN-mode Tailscale Serve; for host installation, multi-host setup, fleet notifications, speech, and Tern session creation, see [Installation and operations](../../docs/OPERATIONS.md).

## Module map

| Module | Responsibility | Contract or guide |
|---|---|---|
| `src/auth.ts` | Loopback peer check, second-hop proxy detection, Serve login allowlist, `Origin` guards, and feed topology admission | [Tailnet authorization](../../docs/SECURITY.md#8-tailnet-authorization) |
| `src/cli.ts` | `omp-gateway` and `omp-gatewayd` entrypoint, option parsing, `runServe` wiring, and transactional lifecycle commands | [CLI and daemon installation](../../docs/OPERATIONS.md#2-cli-and-daemon-installation) |
| `src/config.ts` | Strict `config.json` validation, `readiness-token` lifecycle, private POSIX/Windows ACL file I/O, and rollback key removal | [Gateway configuration reference](../../docs/OPERATIONS.md#14-gateway-configuration-reference) |
| `src/diagnostics.ts` | Deterministic tar builder for redacted `omp-gateway-diagnostics.tar` support archives (`doctor.json` and `manifest.json`) | [`doctor` and diagnostics bundle](../../docs/OPERATIONS.md#12-doctor-and-diagnostics-bundle) |
| `src/doctor.ts` | Read-only host, service, TUN/Serve, allowlist, asset, OMP version, relay, and conditional Tern/fleet state checks | [`doctor` and diagnostics bundle](../../docs/OPERATIONS.md#12-doctor-and-diagnostics-bundle) |
| `src/fleet-coordinator.ts` | Home-gateway fleet notification coordinator, source SSE pullers, epoch/sequence state, reconciliation, and Push v3 fan-out | [Fleet notification coordinator](../../docs/ARCHITECTURE.md#fleet-notification-coordinator) |
| `src/fleet-source.ts` | Remote-source notification grant verifier persistence and identifier-only `GET /api/v1/notification-feed` SSE stream | [Fleet notification source](../../docs/ARCHITECTURE.md#fleet-notification-source) |
| `src/http-policy.ts` | Document and API security headers, `no-store` cache control, `Permissions-Policy`, and cross-origin route/preflight rules | [Cross-origin access](../../docs/PROTOCOL.md#cross-origin-access) |
| `src/http.ts` | Loopback HTTP server, rate limiter, metadata list/SSE, per-launch capability broker, Web Push, fleet, and creation routes | [`omp-gatewayd`](../../docs/ARCHITECTURE.md#13-omp-gatewayd) |
| `src/installation.ts` | Payload staging under `installation/versions/`, `current.json` pointer activation, `history.json`, and predecessor pruning | [Installation transactions](../../docs/ARCHITECTURE.md#6-installation-transactions) |
| `src/logger.ts` | Numeric/boolean-only `SafeLogger` with rate limiting and bounded schema-validated `QualificationLogSink` rotation | [Logging, diagnostics, and test artifacts](../../docs/SECURITY.md#11-logging-diagnostics-and-test-artifacts) |
| `src/omp-registry.ts` | Read-only OMP discovery directory reader, coalesced `startHostPoller`, and per-launch `OmpLaunchResolver` IPC client | [Host poller and launch broker](../../docs/ARCHITECTURE.md#12-host-poller-and-launch-broker) |
| `src/push.ts` | VAPID key pair management, owner-bound Web Push subscription storage, endpoint pacing, and Push v2 delivery | [Background attention push](../../docs/ARCHITECTURE.md#23-background-attention-push) |
| `src/registry.ts` | In-memory metadata-only `SessionRegistry`, monotonic TTL reconciliation, generation/request launch checks, and event fan-out | [Host poller and launch broker](../../docs/ARCHITECTURE.md#12-host-poller-and-launch-broker) |
| `src/service.ts` | Per-user `systemd`, macOS `LaunchAgent`, and Windows `OMP Session Gateway` scheduled-task rendering and ownership checks | [CLI and daemon installation](../../docs/OPERATIONS.md#2-cli-and-daemon-installation) |
| `src/static.ts` | Symlink-rejecting loader for built **OMP Sessions** assets (`apps/web/dist/`) and immutable `/assets/*` cache headers | [Shell updates and caching](../../docs/ARCHITECTURE.md#shell-updates-and-caching) |
| `src/tailnet.ts` | OS interface table inspection for Tailscale kernel TUN device presence and locally bound tailnet addresses | [Network exposure](../../docs/SECURITY.md#4-network-exposure) |
| `src/tern-cli.ts` | Lossless bigint JSON tokenizer and bounded `tern inspect --json` and `tern new tab` subprocess wrapper | [Opt-in Tern session creation](../../docs/OPERATIONS.md#opt-in-tern-session-creation) |
| `src/tern-creation.ts` | Serialized session creation state machine, capability-free ledger persistence, crash recovery, and OMP discovery adoption | [Session creation state machine](../../docs/PROTOCOL.md#session-creation-state-machine) |

## Commands

In the source checkout, run `bun apps/gateway/src/cli.ts <command>` (`src/installation.ts` bundles it into `apps/gateway/src/cli.js` for staged and release archives, and `cli.ts` treats `argv[1]` basename `omp-gatewayd` with no arguments as `serve`).

Commands that serve or stage web assets (`serve`, `install`, `doctor`) expect `apps/web/dist/` from `bun run build` at the repository root ([Build from source](../../CONTRIBUTING.md#build-from-source)); for operator usage, see [CLI and daemon installation](../../docs/OPERATIONS.md#2-cli-and-daemon-installation).

| Command | Operator options | Internal or qualification options |
|---|---|---|
| `serve` | `--dev-localhost`, `--port`, `--origin` | `--readiness-instance`, `--qualification-log-dir` |
| `install` | `--origin`, `--allow`, `--port`, `--no-start` | `--qualification-log-dir` |
| `uninstall` | `--no-stop` | — |
| `rollback` | `--to` | `--qualification-log-dir` |
| `status` | — | — |
| `doctor` | `--bundle`, `--output` | — |
| `rotate-readiness-token` | — | `--qualification-log-dir` |
| `serve-guidance` | — | — |
| `help` (`--help`) | — | — |

## State files

All gateway-owned files use private owner-only permissions (`0600` on POSIX; protected user plus `SYSTEM` DACL on Windows). For OS directory locations, see [Paths](../../docs/OPERATIONS.md#13-paths).

| File or directory | Base directory | Owning module |
|---|---|---|
| `config.json`, `readiness-token` | `<configDir>` | `src/config.ts` |
| `config.pre-rollback.json` | `<configDir>` | `src/cli.ts`, `src/config.ts` |
| `omp-session-gateway.service` / `omp-session-gateway.plist` / `omp-session-gateway-task.xml` | OS user service path (`<configDir>` on Windows) | `src/service.ts` |
| `installation/current.json`, `installation/history.json`, `installation/versions/<version>-<digest>/` | `<stateDir>` | `src/installation.ts` |
| `push-state.json` | `<stateDir>` | `src/push.ts` |
| `notification-grants.json` | `<stateDir>` | `src/fleet-source.ts` |
| `fleet-notifications.json` | `<stateDir>` | `src/fleet-coordinator.ts` |
| `session-creations.json` | `<stateDir>` | `src/tern-creation.ts` |

## Tests

Seventeen of the 19 modules in `src/` have a matching `<module>.test.ts` file under `apps/gateway/test/`, while `src/auth.ts` and `src/http-policy.ts` are covered by `http.test.ts` and `security-mutations.test.ts`.

`apps/gateway/test/` also includes `fleet-two-gateway.test.ts`, `ci-workflow.test.ts`, shared helpers in `test-support.ts`, and JSON fixtures in `test/fixtures/`. Four POSIX-specific suites (`ci-workflow.test.ts`, `cli.test.ts`, `doctor.test.ts`, and `push.test.ts`) are excluded on Windows in `scripts/test-portable.ts`.

Run a single test file from the repository root with an explicit `./` path:

```sh
bun test ./apps/gateway/test/config.test.ts
```

For full suite and qualification coverage, see [Test plan](../../docs/TEST_PLAN.md).

## Boundaries

- No collaboration relay or proxy: the gateway serves metadata and pinned `collab-web` assets (`bun run build` populates `apps/web/dist/`) and never runs a WebSocket relay or server-side session proxy.
- No persistent session database: `SessionRegistry` holds non-secret metadata in memory only; daemon startup begins empty and repopulates on the next OMP discovery poll.
- No capability store or cache: a **View** or **Control** link is a bearer secret, called a capability in the contracts; the gateway fetches it from OMP only on an explicit launch POST, returns it once with `Cache-Control: no-store, max-age=0`, and never caches or persists it.
- Read-only OMP discovery and narrow Tern boundary: the gateway never writes, renames, or unlinks files in `omp.discoveryDir`, never scrapes terminals or session transcripts, and invokes Tern only for opt-in `new tab` creation and read-only `inspect --json` adoption.
- Numeric and boolean logs only: `SafeLogger` rejects string fields so titles, paths, logins, tokens, and capabilities cannot enter logs.
