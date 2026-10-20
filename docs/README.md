# Documentation

OMP Session Gateway lists your running [Oh My Pi](https://github.com/can1357/oh-my-pi) terminal sessions on a private page and opens OMP's own encrypted View or Control client with one tap.

## Use it

- [Usage](USAGE.md) — everyday screens, buttons, triage controls, and background alerts
- [Operations](OPERATIONS.md) — install, Tailscale Serve, tailnet policy, updates, lost phone revocation, and troubleshooting
- [Upgrade and rollback](UPGRADE_ROLLBACK.md) — predecessor compatibility and step-by-step recovery
- [Compatibility](COMPATIBILITY.md) — what is supported in CI and what was qualified on real hardware

## Trust it

- [Security model](SECURITY.md) — threat model, trust boundaries, and secret-handling invariants
- [Security policy](../SECURITY.md) — how to report a vulnerability privately
- [Architecture](ARCHITECTURE.md) — daemon, discovery reader, PWA shell, and launch handoff design

## Build on it

- [Contributing](../CONTRIBUTING.md) — development workflow, source builds, and repository layout
- [Protocol](PROTOCOL.md) — OMP discovery/query and browser HTTP/SSE contracts
- [OMP integration](OMP_INTEGRATION.md) — stock mainline discovery/query contract and supported settings
- [Attention specification](ATTENTION_SPEC.md) — Needs you queue, triage semantics, and notification lifecycle
- [Test plan](TEST_PLAN.md) — unit, integration, browser, and leak-detection coverage
- [BrowserStack](BROWSERSTACK.md) — synthetic Percy visual review, project setup, baseline policy, Live limits and sponsorship renewal
- [Branding](BRANDING.md) — visual identity, tokens, and typography
- [Upstream strategy](UPSTREAM_STRATEGY.md) — how the gateway tracks mainline OMP
- [Backlog](BACKLOG.md) — deferred work and open follow-ups

## Records (dated; kept as written)

- [Release status](RELEASE_STATUS.md) — release ledger and authoritative qualification evidence
- [Decisions](DECISIONS.md) — architecture decision records (ADRs)
- [Release runbook](RELEASE.md) — maintainer release procedure, including how to [verify a published build](RELEASE.md#verify-a-published-build)
- [Linux qualification](LINUX_QUALIFICATION.md) — Debian host qualification runbook and historical evidence
- [Windows qualification](WINDOWS_QUALIFICATION.md) — Windows host qualification runbook and historical evidence
- [Android qualification](ANDROID.md) — physical Pixel acceptance and background Web Push runbook
- [Lifecycle, branch, and resume](LIFECYCLE_BRANCH_RESUME.md) — session generation transitions and daily upstream canary record
- [Launch copy](LAUNCH_COPY.md) — dated launch draft
- [Media provenance](media/README.md) — seeded-fixture capture provenance and regeneration steps

Current claims live in [COMPATIBILITY.md](COMPATIBILITY.md); where a dated record disagrees, [RELEASE_STATUS.md](RELEASE_STATUS.md) is authoritative.
