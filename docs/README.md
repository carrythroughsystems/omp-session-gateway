# Documentation

Use this index to find the right guide, contract, or runbook for OMP Session Gateway, which serves the **OMP Sessions** web app to list and open your live [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) terminal sessions across one or more hosts (computers running OMP and the gateway).

## Use it

- [Overview and quickstart](../README.md) — decide whether OMP Session Gateway fits your workflow, review its privacy invariants and limits, and run a first single-host install
- [Using OMP Sessions](USAGE.md) — install the **OMP Sessions** web app on your phone, triage **Needs you** requests, open read-only **View** or writable **Control**, attach photos, dictate, switch hosts, turn on background alerts, and start sessions

## Run it

- [Installation and operations](OPERATIONS.md) — install and manage the `omp-gateway` CLI and `omp-gatewayd` service, configure Tailscale Serve and login access, enable multiple hosts, remote-host alerts, or session creation in Tern (an optional terminal environment), and run `doctor`
- [Upgrade and rollback](UPGRADE_ROLLBACK.md) — update a running service in place, roll back to a previous installed version, and restore saved settings
- [Compatibility and support policy](COMPATIBILITY.md) — look up CI-supported vs hardware-qualified platforms and browsers, the current release claim, and OMP version baselines

## Trust it

- [Security design and threat model](SECURITY.md) — review protected assets, trust boundaries, Tailscale and OMP relay exposure, and secret-handling invariants for collaboration links (capabilities)
- [Security policy](../SECURITY.md) — report a security vulnerability privately

## Build on it

- [Contributing](../CONTRIBUTING.md) — set up a development checkout, build from source, run pre-pull-request checks, and submit changes
- [Architecture](ARCHITECTURE.md) — learn how the daemon, OMP discovery poller, multi-host and alert coordinators, **OMP Sessions** web app, and installer fit together
- [Protocol contracts](PROTOCOL.md) — look up OMP local discovery queries and the browser HTTP, Server-Sent Events (SSE), cross-origin, remote-alert, and session-creation wire contracts
- [Mainline OMP integration](OMP_INTEGRATION.md) — check what the gateway reads from stock OMP (`>= 18.1.20`), discovery directory rules, and how OMP runs or starts inside Tern
- [Attention specification](ATTENTION_SPEC.md) — look up **Needs you** queue rules, activity-stop alert conditions, and push notification state machines
- [Brand and UI specification](BRANDING.md) — apply the project's Signal UI design system, state colors, typography, floating trays, and editorial copy rules
- [Test plan](TEST_PLAN.md) — map each behavior to its unit, integration, browser, or secret-leak test suite and see how to run it
- [Upstream strategy](UPSTREAM_STRATEGY.md) — see how the project tracks and reviews new stock OMP releases
- [Backlog](BACKLOG.md) — check deferred work and open follow-ups
- [Gateway package](../apps/gateway/README.md) — contributor map of `apps/gateway` modules, CLI entrypoints, runtime state files, and package tests
- [Web app package](../apps/web/README.md) — contributor map of `apps/web` modules, browser storage keys, service worker caching, floating trays, and tests
- [Protocol package](../packages/protocol/README.md) — contributor map of `packages/protocol` shared wire types, JSON and label validators, and schema contracts
- [Collaboration client package](../packages/collab-client/README.md) — contributor map of `packages/collab-client`, the pinned `collab-web` browser client, and the upstream OMP client drift check

## Release maintenance

- [Release runbook](RELEASE.md) — end-to-end maintainer release procedure and how anyone can [verify a published build](RELEASE.md#verify-a-published-build)
- [Linux qualification](LINUX_QUALIFICATION.md) — run the Debian Linux host release-qualification procedure
- [Windows qualification](WINDOWS_QUALIFICATION.md) — run the Windows host release-qualification procedure and review automated Windows OMP checks
- [Android qualification](ANDROID.md) — run physical Pixel app and background Web Push release qualification
- [Lifecycle, branch, and resume](LIFECYCLE_BRANCH_RESUME.md) — qualify OMP session restart, fork, and resume transitions and review daily upstream OMP checks
- [BrowserStack visual review](BROWSERSTACK.md) — run synthetic visual-regression snapshots in Percy on BrowserStack

## Records (dated; kept as written)

- [Release status](RELEASE_STATUS.md) — inspect the authoritative release ledger and recorded hardware qualification evidence
- [Decisions](DECISIONS.md) — read accepted architecture decision records (ADRs)
- [Changelog](../CHANGELOG.md) — read release-by-release changes
- [Launch copy](LAUNCH_COPY.md) — read the archived launch announcement draft
- [Media provenance](media/README.md) — see how the README screenshots and demo video were captured and how to regenerate them

Current claims live in [COMPATIBILITY.md](COMPATIBILITY.md); where a dated record disagrees, [RELEASE_STATUS.md](RELEASE_STATUS.md) is authoritative.
