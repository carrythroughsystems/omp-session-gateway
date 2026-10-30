# Contributing

Thank you for helping build OMP Session Gateway.

## Start here

Read `README.md`, `AGENTS.md`, `docs/DECISIONS.md`, and `docs/SECURITY.md` before changing behavior. Security properties are part of the product contract, not optional hardening work.

The gateway integrates with stock OMP `>= 18.1.20` through its native registry/controller.
No fork, custom OMP build, or gateway-specific OMP plugin is required. Keep gateway policy and
installers here; propose general-purpose controller/registry changes upstream. Read
[OMP integration](docs/OMP_INTEGRATION.md) before changing that boundary.

For ordinary installation, use the [published stable archive](docs/OPERATIONS.md#2-cli-and-daemon-installation).
A source checkout is for development and is not signed-artifact qualification.

## Build from source

Use Bun 1.4.4 in this checkout. A source build does not inherit the signed release's qualification.

```sh
bun install --frozen-lockfile
bun run check

# Loopback-only development mode
bun apps/gateway/src/cli.ts serve \
  --dev-localhost \
  --port 4317 \
  --origin http://127.0.0.1:4317
```

For a source-based production install, run `bun run build`, then use the installation commands in `README.md` with `apps/gateway/src/cli.ts` instead of the archive's `.js` entry point. `bun run release:build` builds the deterministic Bun-runtime archive and checksum manifest; it does not qualify or publish that build.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/gateway` | Loopback daemon, OMP discovery/query reader, launch broker, HTTP API, CLI, services, and diagnostics |
| `apps/web` | Mobile session directory PWA and no-secret service worker |
| `packages/protocol` | Runtime-validated OMP discovery/query and browser contracts |
| `packages/collab-client` | Pinned OMP `collab-web` source and in-memory bootstrap patch |
| `scripts/build-web.ts` | Reproducible hashed PWA/client asset build |
| `scripts/build-release.ts` | Deterministic Bun-runtime release archive and SHA-256 manifest |
| `scripts/post-release-smoke.ts` | Published-byte local Mac/physical-Android smoke with owned-fixture cleanup |
| `docs/media` | Canonical README media plus its seeded-fixture capture provenance |
| `docs/` | Architecture, protocol, security, operations, compatibility, and release evidence |
| `UPSTREAM.lock.json` | Exact OMP source and package baseline |

## Development workflow

1. Open or select a focused [GitHub issue](https://github.com/carrythroughsystems/omp-session-gateway/issues).
2. Create a branch from `main`.
3. Keep the change small enough to review and test.
4. Add or update relevant behavioral, failure-mode, and secret-non-persistence tests; text-only
   changes do not need new tests that merely assert wording.
5. Use the pinned Bun 1.4.4 toolchain: `bun install --frozen-lockfile`, then `bun run check`.
   For browser behavior, also run `bun run test:browser` and exercise the changed surface. That
   lane needs Playwright's own Chromium build, which `bun install` does not fetch: run
   `bunx playwright install chromium` on a fresh checkout, and again after a Playwright version
   bump, or every case fails at browser launch with `Executable doesn't exist`. The cross-engine
   `bun run test:browser:compat` lane also needs `bunx playwright install firefox webkit`.
6. Open a pull request using the template and explain architecture/security impact. Report the
   exact verification performed; repository checks do not qualify a host, relay, or physical phone.

Suggested branch names:

```text
feat/registry-ipc
fix/stale-generation-launch
docs/tailscale-deployment
```

Suggested commit subjects use conventional prefixes:

```text
feat(protocol): validate generation-aware upserts
test(security): detect capabilities in browser storage
fix(web): reject stale launch generations
```

## Security-sensitive contributions

Never use real OMP collaboration links in code, tests, screenshots, recordings, issues, or pull requests. Generate conspicuous synthetic fixtures. Do not add telemetry, third-party browser assets, public listeners, or persistent capability storage.

Changes touching any of the following require threat-model review and negative tests:

- Tailscale identity/authentication;
- loopback binding and proxy trust;
- IPC authentication or permissions;
- capability parsing/delivery;
- browser history/storage/service workers;
- logging, diagnostics, tracing, or crash handling;
- OMP session-generation lifecycle;
- self-hosted relay support.

## Coding standards

The stack is strict TypeScript on Bun, with minimal dependencies. Prefer explicit types at trust boundaries, runtime validation for all untrusted input, bounded queues and payloads, and dependency injection for clocks, randomness, storage, and network listeners so security behavior is testable.

Do not introduce a framework solely for convenience when a small maintained dependency or platform primitive is sufficient. Explain significant dependency additions in the pull request.

## Documentation

Update the relevant architecture, protocol, operations, compatibility, and security documents in the same pull request as a behavior change. Add an ADR entry to `docs/DECISIONS.md` when changing a previously accepted decision.

## Changelog entries

Changelog entries are `changelog.d/` fragments; never edit `CHANGELOG.md` `[Unreleased]` directly.
Add one `changelog.d/<section>-<short-slug>.md` file per entry, using `added`, `changed`,
`deprecated`, `removed`, `fixed`, or `security` and a lowercase, hyphen-separated slug.
The file contains exactly one `- ` bullet, with any continuation lines indented two spaces,
no blank lines, lines at most 100 characters, and a trailing LF newline.
See [fragment rules and example](changelog.d/README.md). Release preparation collects and deletes
fragments; contributors do not cut or recount release sections by hand. Test-only changes need
no fragment.

## Governance

The repository owner is the initial maintainer and final decision maker while the contributor base
is small. Routine changes are decided through pull-request review; security disclosures follow
[SECURITY.md](SECURITY.md). Maintainer roles may be added when sustained review, release, or
security-response work makes them necessary.

## Licensing

By contributing, you agree that your contribution is licensed under the repository's MIT License. Preserve all upstream notices when adapting OMP or third-party material.

## Community conduct

Be respectful, specific, and evidence-driven. Critique designs and code rather than people. Harassment, threats, discrimination, doxxing, and deliberate disclosure of other users' secrets are not acceptable.
