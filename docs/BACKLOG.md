# Backlog


<!-- release-generate:release-task:start -->
- Qualify and publish v0.9.0 with stock OMP v18.12.5; published v0.8.0 stays current stable.
- Requalify attention and lifecycle scenarios on the exact signed candidate; historical evidence does not transfer.
<!-- release-generate:release-task:end -->
GitHub issues are the active work queue. [Compatibility](COMPATIBILITY.md) and
[Release status](RELEASE_STATUS.md) record current support and qualification;
[the changelog](../CHANGELOG.md) records shipped work. This file keeps only open product direction.

## Current

- Track upstream discovery/query compatibility with the daily executable
  [upstream OMP canary](../.github/workflows/upstream-canary.yml), starting at stock `v18.1.20`.
  The gateway ignores fields OMP adds under registry v1 (ADR-028); a version bump or a
  changed type for a field it reads still needs a gateway change.

## Candidate follow-ups

- WebAuthn/passkey verification before Control launch.
- Session aliases, favorites, and per-session control policy.
- A separately threat-modeled signed update mechanism.

## Later or optional

- Native **Open in Tern** handoff: Android Tern 0.9.5 is **upstream-blocked** on a missing
  browser-invocable intent filter ([tern-sdk #143](https://github.com/stencil-hq/tern-sdk/issues/143)),
  and desktop handoff (`tern://` session routing) is deferred. Neither is part of
  [ADR-043 creation](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption).
- A separately scoped Tern plugin, not a discovery or terminal-scraping fallback.
- A desk-handoff queue beyond this device's existing Hold action.
- Unified cross-host notifications; current Web Push and badges remain home-gateway scoped.
- A qualified self-hosted relay deployment mode.
- Trusted Web Activity packaging.
- Multiple desktop hosts with explicit grouping.
- Read-only family or team dashboard roles.
- Alternative remote paths such as Cloudflare Tunnel (#158) or Portal Tunnel (#74), only with broad
  demand; Tailscale Serve stays the only supported path.

## Not planned

- A native Android collaboration client.
- A public hosted control plane or Tailscale Funnel support.
- Transcript indexing or persistence in the gateway.
- Replacing OMP's UI or collaboration protocol.
