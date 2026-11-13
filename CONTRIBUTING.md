# Contributing

This guide walks new contributors from cloning OMP Session Gateway, the companion to Oh My Pi (OMP), to merging a pull request through the merge queue.

## Start here

Read `README.md`, `AGENTS.md`, [Architectural decisions](docs/DECISIONS.md), and [Security design and threat model](docs/SECURITY.md) before changing behavior. Security properties are part of the product contract, not optional hardening work.

The gateway integrates with stock OMP `>= 18.1.20` through its native discovery registry and collaboration controller. No fork, custom OMP build, or gateway-specific OMP plugin is required; keep gateway policy and installers here, propose general-purpose controller or registry changes upstream, and read [Mainline OMP integration](docs/OMP_INTEGRATION.md) before changing that boundary.

For ordinary host installation, use the [published release archive](docs/OPERATIONS.md#2-cli-and-daemon-installation). A source checkout is for development and does not carry signed-release qualification ([Current claim](docs/COMPATIBILITY.md#current-claim)).

Prerequisites: Git with commit signing enabled, Bun `1.4.4` (pinned in `package.json` and `mise.toml`), and GitHub CLI (`gh`) for pull-request and merge-queue commands.

1. Confirm the pinned Bun version:

   ```sh
   bun --version
   ```

   The output must be `1.4.4`.

2. Install locked dependencies from the repository root:

   ```sh
   bun install --frozen-lockfile
   ```

3. Run the repository check, typecheck, web build, unit and integration tests, and capability and identifier leak scans:

   ```sh
   bun run check
   ```

   All suites pass and finish with `capability leak scan passed` and `identifier leak scan passed`.

Browser end-to-end and visual checks require Playwright browser binaries that `bun install` does not fetch. Run `bunx playwright install chromium` on a fresh checkout and after any `@playwright/test` version bump before running `bun run test:browser` or `bun run test:visual`, or browser launch fails with `Executable doesn't exist`.

Run `bunx playwright install firefox webkit` as well before running `bun run test:browser:compat` ([How to run the suites](docs/TEST_PLAN.md#how-to-run-the-suites)).

## Build from source

After completing the first green check in [Start here](#start-here), run the gateway from your checkout in loopback-only development mode (run `bun run build` first whenever `apps/web` or `packages/collab-client` changes):

```sh
bun apps/gateway/src/cli.ts serve --dev-localhost --port 4317 --origin http://127.0.0.1:4317
```

Open `http://127.0.0.1:4317` in a local browser on the same host. Seeing live sessions requires stock OMP `>= 18.1.20` with `omp config set collab.autoStart control` and a running `omp` process ([OMP configuration](docs/OPERATIONS.md#5-omp-configuration)); without one, the directory shows **No live sessions**.

For a source-based local service install, satisfy [One-time prerequisites](docs/OPERATIONS.md#1-one-time-prerequisites), run `bun run build`, and run the commands in [CLI and daemon installation](docs/OPERATIONS.md#2-cli-and-daemon-installation) from the repository root with `apps/gateway/src/cli.ts` in place of the archive's `apps/gateway/src/cli.js` entry point.

`bun run release:build` writes a deterministic Bun-runtime archive and SHA-256 manifest under `dist/release/` without qualifying or publishing that build.

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

1. Select or open a focused [GitHub issue](https://github.com/carrythroughsystems/omp-session-gateway/issues), create a branch from `main`, and sign every commit on the branch.
2. Keep the change small enough to review and test, and add or update behavioral, failure-mode, and secret-non-persistence tests ([Unit tests](docs/TEST_PLAN.md#1-unit-tests), [Secret-leak test harness](docs/TEST_PLAN.md#2-secret-leak-test-harness)); text-only changes do not need new tests that only assert wording.
3. Run `bun run check`. When browser or embedded-client behavior changes, also run `bun run test:browser` (and `bun run test:browser:compat` for cross-engine changes) and exercise the changed surface ([How to run the suites](docs/TEST_PLAN.md#how-to-run-the-suites)).
4. Add a `changelog.d/` fragment when user-, administrator-, or protocol-visible behavior changes ([Changelog entries](#changelog-entries)).
5. Open a pull request using the repository template, explain architecture and security impact, and list the exact verification commands you ran; repository checks do not qualify a host, relay, or physical phone.

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

### Merging with the queue

`main` requires the GitHub merge queue (branch ruleset `main-merge-queue`) and signed commits. All seven required status checks must pass on the reviewed head: `implementation-checks`, `browser-notifications`, `portable-source (ubuntu-24.04)`, `portable-source (macos-latest)`, `portable-source (windows-latest)`, `browser-core`, and `windows-service-lifecycle`.

Once review is approved and those checks pass, contributors with repository queue permission enqueue the pull request by substituting its number for `<number>` and reviewed commit SHA for `<reviewed-head-sha>` (fork contributors ask the reviewing maintainer to enqueue):

```sh
pr_id=$(gh pr view <number> --repo carrythroughsystems/omp-session-gateway --json id --jq .id)
gh api graphql -f id="$pr_id" -f oid=<reviewed-head-sha> -f query='
  mutation($id: ID!, $oid: GitObjectID!) {
    enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $oid}) {
      mergeQueueEntry { state position }
    }
  }'
```

- Do not run `gh pr merge`: auto-merge is disabled on this repository, so `gh pr merge` requests auto-merge and fails with `Auto merge is not allowed for this repository`.
- Enqueueing does not prove the pull request has merged; GitHub tests the latest `main` plus earlier queued entries with the same seven checks on the `merge_group` workflow event, then squash-merges.
- Do not rebase or refresh a green branch solely because another queued pull request merged ahead of it.
- Sign all commits, never bypass the queue with an administrator flag or role-based bypass, and never enqueue automated release pull requests.

Direct release-bot merges and release-window queue pauses are maintainer procedures; see [Merge queue](docs/RELEASE.md#merge-queue).

## Security-sensitive contributions

A **View** (read-only) or **Control** (writable) collaboration link is a bearer secret, called a capability in [Protocol contracts](docs/PROTOCOL.md); never use real OMP collaboration links in code, tests, screenshots, recordings, issues, or pull requests. Generate conspicuous synthetic fixtures ([Secret-leak test harness](docs/TEST_PLAN.md#2-secret-leak-test-harness)), and do not add telemetry, third-party browser assets, public listeners, or persistent capability storage.

Changes touching any of the following require threat-model review and negative tests:

- Tailscale identity and authentication;
- loopback binding and proxy trust;
- local IPC (Unix-socket or named-pipe query channel) authentication or permissions;
- capability parsing and delivery;
- browser history, storage, or service workers;
- logging, diagnostics, tracing, or crash handling;
- OMP session-generation lifecycle (`generation` is OMP's counter that changes when a session is replaced);
- self-hosted collaboration relay support (OMP's encrypted WebSocket transport).

## Coding standards

The stack is strict TypeScript on Bun, with minimal dependencies. Prefer explicit types at trust boundaries, runtime validation for all untrusted input, bounded queues and payloads, and dependency injection for clocks, randomness, storage, and network listeners so security behavior is testable.

Do not introduce a framework solely for convenience when a small maintained dependency or platform primitive is sufficient. Explain significant dependency additions in the pull request.

## Documentation

Update [Architecture](docs/ARCHITECTURE.md), [Protocol contracts](docs/PROTOCOL.md), [Installation and operations](docs/OPERATIONS.md), [Compatibility](docs/COMPATIBILITY.md), and [Security design and threat model](docs/SECURITY.md) in the same pull request as a behavior change. Add an Architecture Decision Record (ADR) to [Architectural decisions](docs/DECISIONS.md) when changing an accepted decision.

## Changelog entries

Changelog entries are `changelog.d/` fragments; never edit `CHANGELOG.md` `[Unreleased]` directly.
Add one `changelog.d/<section>-<short-slug>.md` file per entry, using `added`, `changed`,
`deprecated`, `removed`, `fixed`, or `security` and a lowercase, hyphen-separated slug.
The file contains exactly one `- ` bullet, with any continuation lines indented two spaces,
no blank lines, lines at most 100 characters, and a trailing LF newline.
See [fragment rules and example](changelog.d/README.md). Release preparation collects and deletes fragments; contributors do not edit `CHANGELOG.md` release sections by hand. Test-only changes need no fragment.

## Governance

The repository owner is the initial maintainer and final decision maker while the contributor base is small. Routine changes are decided through pull-request review; security disclosures follow [Private vulnerability reporting](SECURITY.md). Maintainer roles may be added when sustained review, release, or security-response work requires them.

## Licensing

By contributing, you agree that your contribution is licensed under the repository's MIT License. Preserve all upstream notices when adapting OMP or third-party material.

## Community conduct

Be respectful, specific, and evidence-driven. Critique designs and code rather than people. Harassment, threats, discrimination, doxxing, and deliberate disclosure of other users' secrets are not acceptable.
