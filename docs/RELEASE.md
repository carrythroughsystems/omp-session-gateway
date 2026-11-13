# Release process

This runbook is for maintainers who build, qualify, promote, publish, and smoke-test releases of OMP Session Gateway, the companion to Oh My Pi (OMP), and for anyone verifying a published release archive. If you are installing or updating a gateway, read [Verify a published build](#verify-a-published-build) and [CLI and daemon installation](OPERATIONS.md#2-cli-and-daemon-installation).

- Procedure: [Pre-alpha, alpha, beta, and stable artifacts](#pre-alpha-alpha-beta-and-stable-artifacts) and [Mainline stable release procedure](#mainline-stable-release-procedure)
- Driver: [Unattended release driver](#unattended-release-driver)
- Gates: [Release gates](#release-gates) and [Qualification attempt ownership](#qualification-attempt-ownership)
- Verification: [Post-release local installation smoke](#post-release-local-installation-smoke), [Default-relay soak qualification](#default-relay-soak-qualification), [Fleet CI runtime](#fleet-ci-runtime), [Build and keyless provenance](#build-and-keyless-provenance), [Verify a published build](#verify-a-published-build), [Versioning](#versioning), and [Release notes](#release-notes)
- Records: [Dated rollout records](#dated-rollout-records)

## Pre-alpha, alpha, beta, and stable artifacts

The repository builds Bun-runtime release candidates (`pre-alpha`) and promotes a candidate to `stable` (GitHub Latest) only after its signed archive passes the hardware and device-cloud qualification matrix. For the latest release, supported platforms, and recorded lane receipts, see [Current claim](COMPATIBILITY.md#current-claim) and [Release status](RELEASE_STATUS.md); for predecessor rollback boundaries, see [Upgrade and rollback](UPGRADE_ROLLBACK.md).

## Mainline stable release procedure

Each step below is a separate effect; a candidate, a passed receipt, or an approved lock never promotes itself. Before starting, confirm a clean checkout of `main` matching `origin/main` (`qualify:stable` refuses detached or unpublished commits), place pinned Bun `1.4.4` first on `PATH`, drain the [merge queue](#merge-queue) and pause new enqueues until Step 6 lands, and verify that no [unattended release driver](#unattended-release-driver) campaign or smoke is active.

The manual path requires an explicit maintainer decision for scope, live qualification, promotion, publication, and published-byte smoke. The unattended driver holds standing routine authority for those steps within its requested `patch` or `minor` release class and resource caps, without per-release approval prompts.

1. **Prepare the candidate.** Run `bun scripts/release-generate.ts prepare X.Y.Z --date YYYY-MM-DD` (append `--release-class minor` for a minor cut) and open one `chore(release): prepare X.Y.Z` pull request.
   - Version and lock edits in `GENERATED_RELEASE_PATHS.prepare` (`scripts/release-policy.ts`): `package.json`, `apps/gateway/package.json`, `apps/web/package.json`, `packages/collab-client/package.json`, `packages/protocol/package.json`, `PRODUCT_VERSION` in `apps/gateway/src/diagnostics.ts` and `scripts/build-release.ts`, `GATEWAY_VERSION` in `apps/gateway/src/installation.ts`, and workspace versions in `bun.lock`.
   - Release copy and ledger edits (16 files total): `CHANGELOG.md` assembled from `changelog.d/` fragments (deleting consumed fragments), `scripts/release-text.json` (generating `version`, `candidateTag`, `summary`, `highlights`, `stableRollback`, `changesToTest`, and `candidateRollback` while preserving `combinations` and `plannedBoundary`), `docs/RELEASE_STATUS.md`, `docs/ANDROID.md`, `docs/ATTENTION_SPEC.md`, `docs/LIFECYCLE_BRANCH_RESUME.md`, and `docs/BACKLOG.md`.
   - Merge the pull request synchronously with a pinned head ([Merge queue](#merge-queue)), push a signed annotated `vX.Y.Z-prealpha.1` tag on the merge commit, and [verify the published candidate](#verify-a-published-build) with `TAG=vX.Y.Z-prealpha.1` (`gh release verify` applies only after the 24-hour lock window).
2. **Qualify it.** Run `bun run qualify:stable --tag vX.Y.Z-prealpha.1 --preflight` (read-only admission) followed by `bun run qualify:stable --tag vX.Y.Z-prealpha.1` (about an hour; see [Release gates](#release-gates)).
   - The Debian droplet workflow accepts only an exact candidate tag; after a failure, fix the cause on `main`, leave `~/.local/share/omp-session-gateway/qualification/<tag>/stable-qualification.json` unchanged, and move that `<tag>` directory aside without deleting it only as [Release gates](#release-gates) allow before rerunning.
   - Afterwards confirm that no qualification droplet or ephemeral SSH key remains in the DigitalOcean account, and that no `omp-winqual-*` instance, firewall group, or tailnet node remains.
3. **Promote it.** Run `bun scripts/release-generate.ts approve vX.Y.Z --date YYYY-MM-DD --receipt ~/.local/share/omp-session-gateway/qualification/vX.Y.Z-prealpha.1/stable-qualification.json --candidate-tag vX.Y.Z-prealpha.1` and open one `chore(release): approve vX.Y.Z for stable promotion` pull request.
   - Approval updates the eight `GENERATED_RELEASE_PATHS.approve` files: `STABLE_RELEASE.lock.json`, `docs/RELEASE_STATUS.md` (recording all thirteen lanes and their attempt counts), `docs/UPGRADE_ROLLBACK.md`, `README.md` (`Exact qualified OMP` row), `docs/COMPATIBILITY.md` (`platforms`, `release`, and `qualification`), `site/llms.txt`, `site/status/index.html`, and `scripts/release-text.json` (`qualification` and `combinations`).
   - Claim surfaces move to `vX.Y.Z is qualified for stable promotion; publication is pending.` while install and download surfaces link to the latest release without naming a version (`scripts/site-coherence.test.ts` fails on any disagreement with `STABLE_RELEASE.lock.json`).
   - Build a clean stable archive (`OMP_RELEASE_CHANNEL=stable bun run release:build`) and run `bun run release:compare -- <candidate archive> <candidate SHA-256> dist/release/omp-session-gateway-X.Y.Z-bun.tar` using the verified Step 1 `omp-session-gateway-X.Y.Z-bun.tar` and its 64-hex SHA-256 from `SHA256SUMS`; every member must match except `release-info.json`, `SBOM.spdx.json`, `STABLE_RELEASE.lock.json`, and `schemas/stable-release.schema.json`.
   - Before merging, run `bun run check`, `bun scripts/release-policy.ts vX.Y.Z X.Y.Z STABLE_RELEASE.lock.json`, and `bun run smoke:release -- --tag vX.Y.Z --plan`.
4. **Publish.** Merge the approval PR synchronously with its head pinned ([Merge queue](#merge-queue)), confirm `git rev-parse <merge-sha>^{tree}` equals the tested tree, and push a signed annotated `vX.Y.Z` tag on the merge commit so `.github/workflows/signed-release.yml` publishes it. [Verify the published build](#verify-a-published-build), confirm it is GitHub Latest, and check out `vX.Y.Z` to reproduce its digest with `OMP_RELEASE_CHANNEL=stable bun run release:build`.
5. **Smoke the published bytes.** Run [Post-release local installation smoke](#post-release-local-installation-smoke) with the verified archive digest, saving its JSON stdout as `<smoke-json>`.
6. **Record the evidence.** On current `main`, run `bun scripts/release-generate.ts record vX.Y.Z --date YYYY-MM-DD --smoke <smoke-json> --status <status-json> --publication <publication-json>`, passing the UTC smoke completion date rather than the preparation date.
   - `<status-json>` is the JSON stdout of `status` on the installed gateway (`apps/gateway/src/cli.js status`), and `<publication-json>` is `{ tag, sourceCommit, archiveSha256, runUrl, releaseUrl, publishedAt }` for the published release and `signed-release.yml` run (`scripts/release-generate.ts`).
   - Open and merge `docs(release): record vX.Y.Z publication and installed verification`, updating the nine `GENERATED_RELEASE_PATHS.record` files (`docs/RELEASE_STATUS.md`, `docs/ANDROID.md`, `docs/ATTENTION_SPEC.md`, `docs/LIFECYCLE_BRANCH_RESUME.md`, `docs/BACKLOG.md`, `docs/COMPATIBILITY.md`, `site/llms.txt`, `site/status/index.html`, and `scripts/release-text.json`) to `Stable vX.Y.Z is published as immutable GitHub Latest.` with publication and smoke results.

Every mainline release renews a founder-approved fresh 1,800-second relay check in place of the eight-hour gate. The orchestrator defaults to 1,800 seconds and rejects shorter checks; `OMP_STABLE_RELAY_SECONDS` may select 1,800–3,600 seconds. Eight-hour endurance is not rerun or claimed, and no historical eight-hour receipt transfers.

## Unattended release driver

The opt-in Studio driver executes automated repository writes as `alphastorm-release` after a weekly schedule or manual workflow dispatch opens a release request. Under standing routine authority — the pre-reviewed policy fingerprint in `scripts/release-policy.ts` covering routine `patch` and `minor` releases when no protected control path changed — the release bot merges the generated promotion pull request without per-release founder approval, Slack authority, buttons, or tokens.

Slack may relay only the first line of a release-bot progress comment. Manual runs remain available, and must never overlap a driver campaign or smoke.

### Request, authority and gates

`.github/workflows/release-request.yml` runs on Mondays at 15:17 UTC (`17 15 * * 1`) and resolves npm `latest` to one exact stock OMP version. A scheduled run exits cleanly without opening a request when `UPSTREAM.lock.json` equals or exceeds that version, or when an open non-PR issue authored by `github-actions[bot]` carries the title `Upstream tracking: vX.Y.Z` (numeric version only), recording the reason in the step summary and skipping the canary and filing jobs.

After a green canary, an issue-read-only job checks again for an open tracking issue and skips the filing job if one arrived in the meantime; a skipped filing job is never treated as an explicit re-request. Scheduled runs never request fixes-only releases, and a filed weekly issue is consumed on the next tick.

Manual dispatches run on `main` with `omp_version` (default `latest`) and `release_class` (`patch` by default, or `minor`; scheduled runs are always `patch`). The workflow resolves the exact stock npm version, refuses any version below `UPSTREAM.lock.json`, and runs the Linux and Windows canary:

- A failing canary keeps its canary-issue reporting and opens no tracking issue.
- A passing canary opens or reuses `Upstream tracking: vX.Y.Z` with the `release-request` label using `GITHUB_TOKEN` in a job that never checks out or runs pull request code.
- When `omp_version` equals `UPSTREAM.lock.json`, the workflow files a fixes-only request and Carrythrough (the automated upstream-pin delivery app, `carrythroughsystems[bot]`) opens no baseline pull request.
- Minor requests use the same `Upstream tracking: vX.Y.Z` title, add the `release-minor` label, and reuse only a minor issue so they never rebind an existing patch request.

The issue body is for human readers and is never parsed by the driver. Authority comes from a successful filing job named `Request OMP vX.Y.Z` (patch) or `Request OMP vX.Y.Z (minor)` and its Actions `run:attempt`, where the filing step validates the issue URL, emits numeric `tracking_issue`, and a subsequent step records `Record tracking issue #N` in the Actions jobs API.

Labels, timestamps, and issue text are not attribution evidence; missing, duplicate, failed, or mismatched records, or a `release-minor` label without a matching minor filing job, grant no authority. The persisted `release_class` cannot be switched by diagnostic re-requests, and completing a patch release leaves any open minor request intact.

The driver computes the target version from the latest stable tag: `patch` increments the patch number, and `minor` increments the minor number and resets patch to `0` (arbitrary versions and major bumps are refused). With published `v0.7.7`, run `gh workflow run release-request.yml --ref main -f omp_version=18.12.5 -f release_class=minor` to request `v0.8.0`; `v0.7.8-prealpha.N` tags stay immutable, and an older patch issue stays open until the minor release finishes.

`bun scripts/release-driver.ts plan` is read-only (including local state) and can use a read-only `gh` session before bot credentials are installed. Each `tick` invocation advances at most one transition along the [Mainline stable release procedure](#mainline-stable-release-procedure), landing an eligible Carrythrough draft order first and posting one reconciled bot comment formatted as `release-driver: <state> — <detail>` with links.

During the smoke transition, `tick` passes `--force-reinstall --rebuild-omp` because a retried smoke finds the stable gateway active from the failed attempt and `record` demands install evidence. Once `record` merges, `close` closes fulfilled tracking requests.

An upstream baseline **order** is a pull request authored by `carrythroughsystems[bot]` (GitHub type `Bot`) from this repository's `carrythrough/*` branch into `main`, first observed as a draft. Every changed file (including both names of any rename) must belong to the seven-file `ORDER_SCOPE` (`scripts/release-driver.ts`):

1. `CHANGELOG.md`
2. `UPSTREAM.lock.json`
3. `docs/COMPATIBILITY.md`
4. `docs/DECISIONS.md`
5. `docs/OMP_INTEGRATION.md`
6. `docs/RELEASE_STATUS.md`
7. `scripts/windows-qualification-pins.json`

An out-of-scope order enters `held` and is never landed automatically; multiple matching orders wait as ambiguous. All seven `REQUIRED_CHECKS` must pass on the exact head (`implementation-checks`, `windows-service-lifecycle`, `browser-notifications`, `portable-source (ubuntu-24.04)`, `portable-source (macos-latest)`, `portable-source (windows-latest)`, and `browser-core`).

Behind branches are updated before rechecking, and merges call the synchronous REST merge endpoint (`merge_method=squash`, exact head `sha` matching `--match-head-commit`, `commit_title` set to `<observed PR title> (#N)`, and empty `commit_message`). No driver push targets `main`; GitHub creates the signed squash commit under strict branch protection with auto-merge disabled.

The promotion pull request is the reviewable exact-subject artifact. Standing routine authority admits only the requested next `patch` or explicit next `minor` version, eligible `ORDER_SCOPE` orders, and `fix`, `perf`, or `revert` pull requests reviewed by the configured maintainer:

- A maintainer merge satisfies source review directly; a bot-merged `fix`, `perf`, or `revert` must touch no authority path (including rename-from paths) and carry the configured maintainer's latest non-comment review as `APPROVED` at the exact head whose tree equals the landed squash merge tree (dismissed, superseded, post-merge, and stale-head reviews never count).
- Bot and maintainer logins must differ case-insensitively; there is no separate lead identity or bot self-approval, and runtime evaluates the bot-review branch before any maintainer-merge shortcut.
- The installed Studio checkout is the reviewed setup baseline; later commits on `main` must trace to an associated merged pull request in those classes or a bot-owned generated release record, and direct or unclassified commits hold.

Founder fixes must be squash-merged with an immutable `fix`, `perf` or `revert` merge-commit subject (optional Conventional Commit scope). Mutable PR titles never authorize a release, and rebase or multi-commit merges without an exact associated PR merge SHA hold with `out-of-class` naming the first unreviewed commit; resolve them via [Studio installation](#studio-installation-run-as-gwops-after-integration) rather than retitling or relaxing the predicate.

Before merging `approve`, the driver durably pins the candidate tag, source commit, and archive digest, promotion head and tree, and policy fingerprint. Passed evidence must bind `qualification`, `stable-build`, `runtime-comparison`, `release-policy`, `smoke-plan`, and `local-checks` to that subject with all seven checks green on the same head; phase `approval-required` evaluates this predicate without asking the founder, and only `alphastorm-release` may merge `approve`.

Stable tag signing re-verifies the merger, merge source and tree, evidence, `main`, and policy. `main` movement between `prepare` and `approve` triggers a `stale-source` hold rather than absorbing newer commits, whereas `main` may advance after stable signing while publication, smoke, and `record` complete against the pinned stable commit.

A routine release cannot modify its own authority (`scripts/release-policy.ts`):

- Protected authority paths (`ROUTINE_AUTHORITY_PATHS` and control rules) cover `.github/CODEOWNERS`, `release-request.yml`, `signed-release.yml`, `pages.yml`, release policy/driver/generator/state/comparison/download/smoke/qualification/outcome/builder/evidence/provider-read scripts, host and Pixel leases, and `stable-lanes.ts`.
- Additional protected controls cover `STABLE_RELEASE.lock.json` (admitted only as `approve` output, never in a routine fix), `schemas/*`, `AGENTS.md` (and any `CLAUDE.md` matched by the control filename rule), `tsconfig*.json`, `bunfig.toml`, `mise.toml`, and lockfiles other than `UPSTREAM.lock.json` and `bun.lock` (including `mise.lock`).
- Manifest fingerprinting covers all five `package.json` files omitting only top-level `version`, `bun.lock` omitting only workspace versions, and `scripts/build-release.ts` omitting only `PRODUCT_VERSION` (lifecycle scripts and dependency or trusted-dependency edits remain protected controls even in added nested packages). Tracked edits or untracked non-ignored files (including Bun-autoloaded `.env` or config inputs) mark the Studio checkout dirty and hold admission.
- Routine implementation paths (`ROUTINE_IMPLEMENTATION_PATHS`) cover listed non-signing CI workflows, individual lane scripts, `scripts/fixtures/*`, `scripts/*.test.{ts,py}`, application packages, and documentation (including `docs/RELEASE.md`) after normal source review without reinstalling the driver; unclassified `scripts/*` or `.github/*` paths fail repository tests and are treated as protected at runtime.
- Branch-protection attestation (`ROUTINE_BRANCH_PROTECTION`) binds bot and reviewer logins, the seven `REQUIRED_CHECKS`, and attested admin-only `main` settings (`strict` checks, `enforce_admins=true`, `dismiss_stale_reviews=true`, `required_approving_review_count=0`, code-owner and last-push approval `false`, `required_signatures=true`, `required_linear_history=false`, force pushes and deletions `false`, `required_conversation_resolution=true`, `restrictions=null`).
- At runtime the unprivileged bot rereads `protected=true`, `enforcement_level="everyone"`, the seven check contexts on `/branches/main`, commit `verification.verified`, and PR merger metadata, holding on any divergence; updating attested admin-only settings or the policy fingerprint requires the separately reviewed, job-free [Studio installation](#studio-installation-run-as-gwops-after-integration) setup path rather than granting admin scopes or self-upgrading.

Generated `prepare`, `approve`, and `record` pull requests may touch only their per-kind `GENERATED_RELEASE_PATHS` set (including both paths of a rename), and `prepare` may additionally delete valid `changelog.d/<section>-<short-slug>.md` fragments without touching `changelog.d/README.md`. Normalized control equality is rechecked at merge and on prior release records, and adopting a remote `release-driver/*` checkpoint requires a verified signature authored by `alphastorm-release`.

`prepare` and `approve` compare normalized controls against the pinned Studio checkout, whereas `record` compares controls between its pull request merge base and head alongside `GENERATED_RELEASE_PATHS.record`. Reviewed control changes merged after stable signing therefore do not block `record`, while a `record` branch that alters a control holds with `generated-content-mismatch` without advancing the installed driver or authorizing a new release.

`record` generation branches from current `main` rather than `stableCommit`. When GitHub reports the `record` pull request `BEHIND`, `mergeable: false`, or `DIRTY` (`mergeable_state: dirty`), the driver verifies bot ownership, signature, and generated-file rules on the open PR, regenerates on current `main`, and force-updates only that `record` branch with a lease on the old head and a single bot-signed commit (never GitHub `update-branch`).

Unknown mergeability waits, and stale merge intents are dropped and re-planned once checks pass on the replacement head. Source-keyed detached worktrees retain commit checkpoints across crashes, and a pushed branch without a pull request is adopted without checking it out under a newer `main` key.

The `record` worktree is treated strictly as data: the driver calls its own installed `runReleaseGenerate` in-process without running `bun install`, imports, or lifecycle scripts from `main`, keeping bot credentials isolated from unpinned `main` code. Every generator invocation verifies that all input and output paths (and `changelog.d` on `prepare`) are canonical regular files and directories inside the worktree without symlinks.

Because CI checks historical generator fixtures (`v0.7.4` sanitized golden receipt) and `scripts/site-coherence.test.ts` rather than byte equality against an older installed driver, a schema or marker change on `main` can cause an older pinned generator to fail PR checks; reconcile manually under the release's pinned policy instead of advancing the driver mid-release.

`ROUTINE_HOLD_REASONS` (`scripts/release-policy.ts`) defines thirteen typed holds: `authority-path-changed`, `policy-changed`, `out-of-class`, `stale-source`, `missing-evidence`, `head-tree-changed`, `unexpected-merger`, `pr-identity-changed`, `required-checks-missing`, `merge-tree-changed`, `merge-missing`, `merge-signature-missing`, and `generated-content-mismatch`. Incomplete checks wait without effects; other holds stop and preserve the subject for operator review.

`prepare`, `approve`, and `record` require an explicit `--date YYYY-MM-DD`. `prepare` and `approve` reuse the persisted preparation date, whereas the smoke worker writes ISO UTC `completedAt` and `finish-smoke` persists `smokedAt` so `release-generate.ts record --date` always receives the UTC smoke completion date (including across delayed observation, regeneration, or replay, with no preparation-date fallback).

`prepare` reads `changelog.d/` fragments ([fragment authoring rules](../changelog.d/README.md)), orders sections as `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security` with filenames sorted per section, deletes consumed fragments, leaves `## [Unreleased]` empty, and writes deterministic entry counts and summaries into `CHANGELOG.md` and `scripts/release-text.json`.

Re-preparing an unpublished cut or superseding an unqualified next-patch cut with `prepare X.Y.Z --release-class minor --date YYYY-MM-DD` keeps existing bullets, folds in sorted new fragments, recounts bullets (including count-only header drift on an unqualified cut), and regenerates `scripts/release-text.json` while refusing edited summaries, qualified cuts, or duplicate cuts and leaving `STABLE_RELEASE.lock.json` and `UPSTREAM.lock.json` untouched. No `main` commits may land before `approve`.

### Merge queue

Branch ruleset `main-merge-queue` enforces a squash-only merge queue on `refs/heads/main` (`"grouping_strategy": "ALLGREEN"`, up to five entries built and merged together, 60-minute check response timeout) layered over classic branch protection (`strict: true`, `enforce_admins: true`, signed commits and conversation resolution required, force pushes, deletions, and auto-merge disabled; `ROUTINE_BRANCH_PROTECTION` in `scripts/release-policy.ts`).

Every pull request head and `merge_group` commit must pass the seven `REQUIRED_CHECKS` in `scripts/release-policy.ts`: `implementation-checks`, `windows-service-lifecycle`, `browser-notifications`, `portable-source (ubuntu-24.04)`, `portable-source (macos-latest)`, `portable-source (windows-latest)`, and `browser-core`.

Ordinary contributor pull requests merge through the queue: after review and once all seven checks pass on signed commits, enqueue the pull request with the GraphQL `enqueuePullRequest` mutation (`pullRequestId` and `expectedHeadOid`), as shown in [Merging with the queue](../CONTRIBUTING.md#merging-with-the-queue). GitHub validates the `merge_group` tree against `main` plus earlier queued entries and creates a signed squash commit; `gh pr merge` fails because repository auto-merge is disabled.

Generated `prepare`, `approve`, and `record` pull requests merge directly without entering the queue. `alphastorm-release` holds the repository `Maintain` role, granting a pull-request-only bypass on `main-merge-queue` (`pull_requests_only`) while keeping classic branch protection, all seven checks, `strict` heads, and commit signatures in force.

The driver calls the synchronous REST merge endpoint (`merge_method=squash`, exact `sha`, `commit_title="<observed PR title> (#N)"`, empty `commit_message`) and verifies `mergedBy` equals `alphastorm-release`.

Prohibitions during normal development and release windows:

- Never bypass the queue with an administrator flag, relax the seven required checks or signature rule, enable auto-merge, or grant the `Maintain` bypass role to ordinary contributors.
- Never enqueue generated `prepare`, `approve`, or `record` pull requests; queuing could combine `approve` with another change or break direct bot-merger attribution.
- Drain the merge queue before a release window and stop new enqueues until the `record` pull request merges, because unrelated `main` commits between `prepare` and `approve` trigger a `stale-source` hold.

If `main-merge-queue` (ruleset `26248647`) rejects a valid direct bot merge, a repository owner can set `enforcement` to `"disabled"` on `repos/carrythroughsystems/omp-session-gateway/rulesets/26248647` and re-run `tick`; see [Merge queue rollout (operator only)](#merge-queue-rollout-operator-only) for the historical rollout audit.

### Studio installation (run as gwops after integration)

The `alphastorm-release` account is a repository collaborator with write access (`Maintain` role for the merge-queue bypass) and Studio SSH signing key `~/.ssh/omp-gateway-release-signing` (public half `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPnD0XsQMUDImQxiWVgU8IXM6XeMVxFgPvp9bOAl/5Gd`).

The driver derives the bot's noreply tagger address from its numeric GitHub ID (default `339384828+alphastorm-release@users.noreply.github.com`) and runs `gh` and HTTPS `git` writes via `~/.config/gh-release-bot`, discarding ambient founder tokens and git identities.

Prerequisites match the full campaign and smoke:

- Retained macOS guest (`VirtualMac2,1`) running and reachable over SSH, attached Pixel with the **OMP Sessions** WebAPK installed, published predecessor installed on the Studio, and empty-password `~/Library/Keychains/omp-qualification.keychain-db` (unlocked by the driver before campaign Pixel work and before smoke).
- Private mode-`0600` credential files owned by `gwops`: `~/.ssh/omp-gateway-release-signing`, `~/.vultr-apikey`, `~/.ts-qual-apikey`, `~/.ts-qual-authkey` (or `~/.ts-authkey-qual`), and `~/.local/state/omp-session-gateway/op-service-account.token`.
- Pinned Darwin-arm64 Bun `1.4.4` at `~/.omp/lane-toolchain/bun-1.4.4/bin/bun` (seeded from the checksum-verified `oven-sh/bun` release; see [Bun 1.4.4 host preparation](#bun-144-host-preparation-before-the-next-campaign)), `/opt/homebrew/opt/openjdk@17/bin/java`, `adb`, `security`, `git`, `gh`, `cosign`, `shasum`, `ssh`, `scp`, `bash`, `python3`, `curl`, `tmux`, and `op` on the explicit Homebrew `PATH`, with older launchers drained while retaining receipts and `lease.sqlite`.

Disable admission and unload the LaunchAgent before mutating the checkout, and stop after the inspection commands if any worker, `tmux` session, unsettled intent or outbox, or `lease.sqlite` owner is present. Finish or recover an active release on its existing policy first; never advance the checkout underneath an in-progress release or delete `lease.sqlite` to proceed.

SSH to the Studio as the operator (for example `ssh gwops@studio.example.ts.net`) and run:
```sh
export PATH="$HOME/.omp/lane-toolchain/bun-1.4.4/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
state="$HOME/.local/state/omp-session-gateway/release-driver"
install -d -m 700 "$state"
touch "$state/disabled"
if launchctl print "gui/$(id -u)/com.omp.gateway-release-driver" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/com.omp.gateway-release-driver"
fi
# Confirm no driver tick/worker or tmux job remains before touching the checkout.
pgrep -fl 'release-driver|stable-qualification|post-release-smoke'
tmux list-sessions
# Inspect state/outbox and all job claims, retaining them; never fabricate completion.
if test -f "$state/state.json"; then jq '{phase,candidate,intent,announcement}' "$state/state.json"; fi
find "$state/jobs" -name '*.json' -type f -print
if test -f "$HOME/.local/state/omp-session-gateway/release-host/lease.sqlite"; then
  sqlite3 -readonly "$HOME/.local/state/omp-session-gateway/release-host/lease.sqlite" 'select * from campaign;'
fi
# STOP until active owners have completed and pending effects/outbox are reconciled.
# Do not advance a checkout underneath a pending release; finish/recover it on its old policy.
cd "$HOME/Development/omp-session-gateway"
git fetch origin main
git switch main
git merge --ff-only origin/main
bun install --frozen-lockfile
GH_CONFIG_DIR="$HOME/.config/gh-release-bot" gh auth status
# Must print alphastorm-release; do not copy the founder's gh configuration.
GH_CONFIG_DIR="$HOME/.config/gh-release-bot" gh api user --jq .login
bun scripts/release-driver.ts plan
# One-time cleanup of checkouts retained by older driver versions; keep admission disabled.
# Review wouldRemove paths, local branches and estimated bytes before applying.
bun scripts/release-driver.ts prune
OMP_RELEASE_DRY_RUN=0 bun scripts/release-driver.ts prune --apply
bun --eval 'const template = await Bun.file("scripts/com.omp.gateway-release-driver.plist").text(); await Bun.write(process.env.HOME + "/Library/LaunchAgents/com.omp.gateway-release-driver.plist", template.replaceAll("@HOME@", process.env.HOME));'
chmod 600 "$HOME/Library/LaunchAgents/com.omp.gateway-release-driver.plist"
# Replace this documentation target with the retained guest's actual SSH target.
/usr/libexec/PlistBuddy -c 'Set :EnvironmentVariables:OMP_STABLE_MAC_HOST gwqual@mac.example.ts.net' "$HOME/Library/LaunchAgents/com.omp.gateway-release-driver.plist"
# The checked-in template is dry-run by default. Review the config and read-only plan first.
plutil -lint "$HOME/Library/LaunchAgents/com.omp.gateway-release-driver.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.omp.gateway-release-driver.plist"
# To arm after review, unload, change the explicit switch, and reload:
launchctl bootout "gui/$(id -u)/com.omp.gateway-release-driver"
/usr/libexec/PlistBuddy -c 'Set :EnvironmentVariables:OMP_RELEASE_DRY_RUN false' "$HOME/Library/LaunchAgents/com.omp.gateway-release-driver.plist"
rm "$HOME/.local/state/omp-session-gateway/release-driver/disabled"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.omp.gateway-release-driver.plist"
```

The plist runs every 300 seconds and at load under `gwops` (`ProcessType` `Interactive`), sending `launchd` stdout and stderr to `/dev/null` while keeping a bounded 256-KiB private `driver.log` and per-job exit and diagnostic files without modifying gateway or VM LaunchAgents. Environment variables are `OMP_RELEASE_BOT_LOGIN`, `OMP_RELEASE_FOUNDER_LOGIN`, `OMP_RELEASE_GH_CONFIG_DIR`, `OMP_RELEASE_SIGNING_KEY`, `OMP_RELEASE_STATE_DIR` (absolute paths), and `OMP_RELEASE_DRY_RUN=1|true`.

### Readiness and credential expiry

Inspect driver readiness and state without mutating local files or GitHub:

```sh
bun scripts/release-driver.ts plan
bun scripts/release-driver.ts status
```

`plan` reports readiness alongside its proposed next operation (and can read GitHub with an operator `gh` session while checking machine readiness against `OMP_RELEASE_GH_CONFIG_DIR`); `status` reports `phase`, `candidate`, unsettled `intent` or `announcement` outbox, typed `holdReason`, and any first unreviewed source commit.

Readiness checks private file ownership and `0600` modes, required executables, pinned Darwin-arm64 Bun `1.4.4`, `OMP_STABLE_MAC_HOST` configuration and SSH reachability, one authorized `adb` device, bot login and `push` permission, writer-readable branch-protection contexts on `/branches/main` (admin-only fields come from `ROUTINE_BRANCH_PROTECTION`), `disabled` and `dry-run` switches, and `lease.sqlite`.

Ordinary `tick` runs write sanitized `readiness.json` before admitting a request and leave requests unconsumed when any check is false, persisting no raw credentials, device serials, or HTTP headers.

GitHub token expiry is read from response headers when present, whereas 1Password service-account, Tailscale, and Vultr expiry remain `unknown` without provider metadata; the driver never guesses validity or refreshes tokens.

File presence and SSH reachability do not substitute for candidate `--preflight`, which checks cloud catalogs, Pixel PIN and WebAPK state, workflow secrets, and full guest readiness; resolve missing prerequisites, wrong bot login, or owned/unreadable `lease.sqlite` before arming without deleting an active lease.

During Studio smoke runs, gateway `doctor` (`funnelDisabled`) and `smoke:release` scope their Tailscale Funnel check to the gateway's Serve authority: unrelated Studio Funnels may stay active without pausing them, whereas Funnel on the gateway origin, proxy or TCP routes to its loopback port, non-loopback gateway listeners, or unparseable Serve status fail closed.

### Durable jobs, failures and kill switch

Driver state lives under `~/.local/state/omp-session-gateway/release-driver/`. Atomic `state.json` writes sync file data before rename (and sync the parent directory on POSIX) to persist write intents, pinned PR and tag identities, and the comment outbox; SQLite `tick.sqlite` serializes `tick` invocations, and deterministic branch, tag, comment-marker, and `tmux` names reconcile provider writes accepted immediately before a crash (`plan` creates none of these).

Bot-owned git worktrees live under `work/` so the operator checkout stays clean:

- Once `close` is persisted, the driver prunes recognized `work/` checkouts from other versions and older `vX.Y.Z-rebuild` worktrees (`git worktree remove --force`, `git worktree prune`, and local `release-driver/...` branch deletion, leaving remote refs, tags, and the saved state's own version family intact until a later version closes; pruning errors log a bounded warning in `driver.log` without rolling back `close`).
- Preview cleanup with `bun scripts/release-driver.ts prune` (`wouldRemove` paths, branches, logical `bytes` without following symlinks, and `kept` reasons), or run `OMP_RELEASE_DRY_RUN=0 bun scripts/release-driver.ts prune --apply` under the tick mutex; both refuse if armed without `disabled` while a `tmux` job runs, protect unsettled intents, non-terminal jobs, live sessions, symlinks, and paths outside `work/`, and leave `jobs/`, `state.json`, `readiness.json`, and `lease.sqlite` untouched.
- State patches list deleted fields in an explicit `clear` array rather than `undefined` JSON properties, and campaigns run from a published `release-driver/*-campaign` branch pinned to the `prepare` merge commit so `main` movement cannot alter orchestrator code.

Campaign, approve-check, and smoke workers run detached in named `tmux` sessions with a `started` claim, JSON result, and exit file under `jobs/`:

- Campaign workers fsync the qualification child's exact last 262,144 bytes of stdout and stderr as immutable `0600` `qualification-out.log` and `qualification-err.log` (empty if qualification never started, separate from outer `out.log` and `err.log`) before writing exit and result files, while receipts live at `~/.local/share/omp-session-gateway/qualification/<candidate>/stable-qualification.json`.
- Smoke workers fsync `0600` `smoke-out.log` and `smoke-err.log` (262,144 bytes each), write bounded `smoke-failure.json` on failure without altering `jobs/<job>/diagnostic.json` (the sanitized `{ failureSummary }` written on typed campaign failures) or retry authority, and retain per-stage Android logs under `smoke-logs/` so closed stage names such as `"Android Chrome"` preserve the child exception (never infer a cause from the stage name alone).
- Raw child logs and error chains are private operator diagnostics; never copy them into issues or public comments.

Qualification and smoke share `lease.sqlite` without deleting or stealing live or foreign owners. Missing workers, non-retryable device or cloud failures, and job specifications that disagree with their launch binding stop in `diagnostic-required` (recording `failedMain`, clearing the launch intent, and posting one diagnostic comment; raw timeouts or exit codes `75` and `143` alone never grant retry, and missing local `approve` workers resume only at the identical head, tree, and policy).

Automatic same-issue re-selection after a fix lands on `main`:

- Once `main` advances past `failedMain` (recorded from the candidate commit that ran rather than observation-time `main`), the driver re-selects the open tracking issue carrying the same OMP version, `release_class`, and API-recorded `Record tracking issue #N` filing `run:attempt` (revalidated even past the newest 100 workflow runs; older runs lacking `Record tracking issue #N` require one new `release-request.yml` dispatch, and closed issues cannot retry without a replacement request).
- An unmerged `prepare` held on `stale-source` also re-selects once `main` moves (merged `prepare` PRs, other authority holds, and versions with an existing stable tag or newer GitHub Latest do not).
- Re-selection appends `{candidate, reason, at, issue, preparePr, failedMain}` to `state.retired`, closes only the bot-owned unmerged `prepare` PR (dropping and replanning intents if an untracked orphan or `prealpha` tag appears), reserves the retired ordinal, and prepares the next unused `vX.Y.Z-prealpha.N` after rechecking source review, policy, and owner-verified lease cleanup ([Release gates](#release-gates)), without closing the tracking issue or modifying prior jobs or receipts.
- Fulfilled issues record their filing identity at `close` and are never re-selected.

If the 30-second 1Password `op whoami` probe times out (`host-fault`), run `brew reinstall --cask 1password-cli` (or invoke `op` through a hardlink to the same inode if macOS hangs on the installed path), verify `op --account my.1password.com --version`, and rerun the candidate's `--preflight` (`diagnostic-required` clears automatically only after `main` advances past `failedMain`, or via quiesced state retirement to `retired/`).

When a fix changes protected release controls, complete the quiesced [Studio installation](#studio-installation-run-as-gwops-after-integration) review and move the old `state.json` to `retired/` only after confirming no unsettled intent or outbox, stable publication, active worker, or owned `lease.sqlite` row.

To stop new driver admissions immediately (the emergency kill switch):

```sh
touch "$HOME/.local/state/omp-session-gateway/release-driver/disabled"
launchctl bootout "gui/$(id -u)/com.omp.gateway-release-driver"
```

This unloads future ticks without killing an active campaign or smoke mid-cleanup. Inspect `jobs/*/spec.json`, `tmux list-sessions`, exit and result files, and the qualification receipt, and let active work finish or recover before rearming via [Studio installation](#studio-installation-run-as-gwops-after-integration); never delete `state.json`, a `started` claim, `tick.sqlite`, or `lease.sqlite`, and revoke the `alphastorm-release` credential immediately if the operator account is compromised.

### Bounded device-cloud journey retries

Before a cloud journey's first collaboration navigation, each attested directory visit allows up to 60 seconds for its service worker to settle (preventing `uncontrolled` stalls on TestingBot Galaxy S25 and S24 devices without altering the installed-shell readiness check).

Within one `deviceCloud` lane run, each iPhone, iPad, or Samsung target may retry once after an ordinary post-attestation collaboration or Home Screen failure:

- Only the failed target allocates a second device session; the candidate, retained-Mac fixture, live OMP generation, tunnels, Pixel lease, lane epoch, passed targets, and sibling lane receipts stay unchanged, and a second failure on the same target is terminal.
- Before retrying, the first session must end, pass its live-link and media audit, and (for BrowserStack) complete `DELETE` and three-minute artifact-absence verification; unknown allocation outcomes, attestation mismatches, sink or audit hits, containment failures, and OMP generation changes never retry.
- Schema-3 `progress.journeys[target]` and `resources` record attempts, outcomes, and session IDs without raw errors; `approve` binds each passing target to its final allocation and verifies audit counts across clean-audited allocations (`scripts/qualification-failure.ts` types `journey_failed` as `product`/`confirmed` at `<target>_verified` and `audit_failed` as `confirmed` or `read_only` at `records_audited`, and crashes run dirty-attempt cleanup without resetting budgets).

Availability holds never use per-journey retries: an initial empty pool uses the hold rules below, while empty-pool availability after a failed first journey is a non-retryable mixed diagnostic failure.

### Automatic same-candidate campaign retries

Candidates with the version-1 execution and outcome contract bound retries via `campaignAttempt` (initial attempt `0`, plus retries `1` and `2`). Only validated infrastructure root failures and their collateral with verified cleanup, reconciled allocations, and zero unknown mutations qualify; product, harness, unknown, mixed, collateral-only, malformed, or dirty outcomes (including unexplained Push timeouts or raw Windows exit `143`) stop in `diagnostic-required`.

Scheduling and predecessor-proof rules:

- `schedule-campaign-retry` writes `retry-pending`, `retryNotBefore` (60 seconds before attempt 1, 120 seconds before attempt 2), and a bound `retryPlan` whose `nextAttempt` reserves the next ordinal (`campaignAttempt` advances on launch), binding candidate tag/source/digest, predecessor, orchestrator commit, policy, `macHost`, job/log digests (`out.log`, `err.log`, `qualification-out.log`, `qualification-err.log`), machine-outcome and failed-receipt digests, summary, restart lanes, and scope.
- Before scheduling and before launch, the driver verifies the exited job, unchanged candidate and policy, absence of approval/publication/workers/foreign lease holders, matching subprocess and typed-outcome exit codes, and a non-empty restart set (preserving `failed-qualification.json` in the completed job directory; orphaned results without an exit file stop as diagnostic).
- Attempts 1 and 2 consume predecessor authority durably before admission via `--retry-receipt-sha256` (campaign retries) or `--retry-outcome-file` plus `--retry-outcome-sha256` (effect-free preflight retries; standalone `--preflight` accepts attempt 0 only).
- Passed product and `ompPublication` proofs stay intact while failed Push, Windows, or cloud lanes restart on fresh epochs, collateral publication restarts on an isolated OMP host, artifacts reverify, readiness reruns, and Mac cleanup reopens.
- Ownership in `lease.sqlite` stays `qualification:<candidate>:<receipt path>` across attempts without calling lease clear (`recoverFailedCampaign()` in `scripts/release-driver-runtime.ts` runs only when retiring a candidate after a `main` fix). Jobs use `jobs/<issue>-<candidate>-campaign/` for attempt 0 and `jobs/<issue>-<candidate>-campaign-retry-<n>/` for retries, treating `started` as a hard no-relaunch fence and posting sanitized progress comments without raw errors or identifiers.

After attempt 2 fails, `diagnostic-required` retains the exhaustion summary and lease; repair the failed owner and land a `main` fix so only new-candidate selection resets the retry budget. Update the driver across execution-format changes only through the drained [Studio installation](#studio-installation-run-as-gwops-after-integration) procedure (`retry-device-cloud` is refused on version-1 jobs, and old schema-3 receipts without version-1 outcomes never auto-retry).

### Legacy device-cloud availability holds

Only validated empty pinned-device pool observations count as availability; authentication, catalog, transport, attestation, exhausted journey-retry, audit, and cleanup errors remain diagnostic.

On an availability-only failure, `qualify:stable` atomically writes a closed JSON outcome to `OMP_STABLE_OUTCOME_FILE` (`preflight-outcome.json` or `campaign-outcome.json` in the private job directory; stdout/stderr is never parsed as machine evidence) and exits `75`, recording `failed` with one to three schema-3 `availabilityHold` leaves (missing or invalid outcome files make exit `75` diagnostic).

Before an allocation hold is resumable, sibling consumers must finish, the relay tunnel must stop, `ompPublication` lifecycle must pass, Windows must settle, and all resource and final Mac cleanups must pass (a preflight-only hold creates no cloud session, tunnel, fixture, or receipt and retries as a fresh campaign start).

For legacy jobs without version-1 automatic retries, `infrastructure-held` waits for explicit operator authorization after checking equipment availability:

```sh
bun scripts/release-driver.ts status
bun scripts/release-driver.ts retry-device-cloud --candidate <exact-prealpha-tag> --job-attempt <current-attempt>
```

`retry-device-cloud` takes the tick mutex, checks the held candidate/attempt, absence of unsettled intents/workers/approval/publication/foreign lease owners, unchanged policy and `macHost` from `spec.json`, and an eligible held receipt (`held-qualification.json` matching the working receipt) or preflight hold, then schedules one `jobs/<issue>-<candidate>-campaign-retry-<n>/` launch on the next non-dry-run tick (replaying a `spec.json`-only `tmux` failure only without `started` or `tmux`).

For a manual campaign outside the driver, run from the candidate's orchestrator checkout with identical `OMP_STABLE_MAC_HOST`, predecessor, and receipt directory (`OMP_STABLE_QUALIFICATION_DIR` if overridden; see [Release gates](#release-gates)):

```sh
bun run qualify:stable -- --tag <exact-prealpha-tag> --resume-device-cloud
```

`--resume-device-cloud` rejects dirty, stale-cleanup, or mismatched-commit receipts before effects, clears and persists the old hold before admission, keeps passed Debian, macOS, Android, Push, Windows, relay, and `ompPublication` proofs, reverifies signatures, rebuilds the candidate gateway and OMP fixture, reopens Mac cleanup, and runs a fresh cloud epoch under `lease.sqlite` (ordinary errors exit `1`; see [Durable jobs, failures and kill switch](#durable-jobs-failures-and-kill-switch)).

### Carrythrough checks-pod boundary

`bun run check:order` validates `ORDER_SCOPE` pins, schemas, repository conventions, claim coherence, and release-ledger gates on Linux without physical devices or post-install network access. The checks pod requires a writable workspace (the rest of `/` and `$HOME` may stay read-only, with no Docker daemon, npm token, or devices), about 4 GiB RAM, and TCP `443` egress only during `bun install` or an intentional `scripts/upstream-pins.ts` refresh.

`scripts/upstream-pins.ts` performs one GitHub commit read and one contents read per `relevantPaths` entry (using optional `GH_TOKEN`/`GITHUB_TOKEN` only for GitHub API calls), two `raw.githubusercontent.com` manifest reads, and six npm registry metadata and tarball reads verified locally with `tar`.

## Release gates

Recorded release decisions and lane measurements are in [Release status](RELEASE_STATUS.md); supported and qualified platform claims are in [Compatibility and support policy](COMPATIBILITY.md). Generated or signed artifacts never promote themselves.

Every advertised release requires:

- private vulnerability reporting and repository security controls enabled;
- an exact mainline OMP commit, validated discovery and query contract, `collab-web` provenance, and license inventory;
- all unit, integration, browser, type, build, and secret or identifier leak checks green;
- advertised host installers qualified against the exact signed candidate;
- loopback-only exposure plus positive and negative Tailscale identity and `Origin` evidence;
- physical-client **View** and **Control**, stale-generation, session-lifecycle, and forbidden-sink evidence;
- documented configuration, upgrade, rollback, cleanup, compatibility, and known limits; and
- complete checksums, SPDX 2.3 SBOM, GitHub build attestations, Cosign Sigstore bundles, signed tag, and reproducible build verification.

Stable publication requires `STABLE_RELEASE.lock.json` in the signed tag's tree to record passed candidate tag/source/digest, runtime-byte comparison, Debian, Virtualization.framework macOS guest (`VirtualMac2,1`, [ADR-033](DECISIONS.md#adr-033--retain-a-macos-virtual-machine-as-the-campaign-mac)), Windows host, physical Pixel, background Web Push, mainline OMP discovery/query/launch/revocation, provenance, and secret-sink evidence (no fork-era receipt satisfies a mainline lane).

`.github/workflows/signed-release.yml` verifies that checked-out `HEAD` equals the event SHA, checks candidate ancestry and published candidate digest, requires a GitHub-verified signed annotated tag, and rechecks tag state before provenance generation, draft creation, and publication.

[Issue #65](https://github.com/carrythroughsystems/omp-session-gateway/issues/65) remains a disclosed Android Chrome browser-process limitation: after 45 uninterrupted visible failure seconds, the shell surfaces retry and force-stop/reopen guidance without third-party probes or claiming JavaScript repaired Chrome.

`bun run qualify:stable --tag "$TAG"` reverifies candidate and predecessor signatures and provenance, and runs Debian and macOS guest lifecycle, rollback, mainline OMP discovery/launch/revocation, Pixel acceptance and sinks, relay smoke, [Windows](WINDOWS_QUALIFICATION.md), [background Push](ANDROID.md#physical-background-push-lane), cloud devices ([ADR-032](DECISIONS.md#adr-032--qualify-iphone-ipad-and-android-browsers-on-real-cloud-devices-in-every-stable-campaign)), and cleanup.

The orchestrator writes its private schema-3 receipt to `~/.local/share/omp-session-gateway/qualification/<tag>/stable-qualification.json`; retargeted scripts are not qualification evidence until every lane runs against the exact signed candidate.

Predecessor verification in `scripts/post-release-smoke.ts` has one finite historical exception: `v0.7.5` (SHA-256 `171dec1a9902c934c99060b250f209cf627ce194d07da1412b35ad419c3ec57c`), verified via retained Cosign bundles under identity `https://github.com/alphastorm/omp-session-gateway/.github/workflows/signed-release.yml@refs/tags/v0.7.5` and issuer `https://token.actions.githubusercontent.com` (`githubAttestations: "historical-cosign"`, rechecked at `approve`).

Its signed tag, six-asset set, Latest state, checksums, and archive digest remain mandatory; candidates, published-byte smokes, and all other predecessors require all three online GitHub build attestations, and attestation outages or digest mismatches fail closed.

Before spending a full campaign after harness or lane changes, exercise affected lanes in development mode at the exact orchestrator tree under pinned Bun `1.4.4`:

- Background Push: `OMP_PUSH_FIXTURE_BINARY="$PINNED_OMP" bun scripts/android-push-qualification.ts development <published archive>`, where `OMP_PUSH_FIXTURE_BINARY` names the exact stock OMP entrypoint (`dist/cli.js` or binary) matching `UPSTREAM.lock.json` ([Physical background-Push lane](ANDROID.md#physical-background-push-lane)).
- OMP session lifecycle: `bun scripts/omp-lifecycle-development.ts --omp <absolute path to stock OMP dist/cli.js>` ([OMP session lifecycle lane](LIFECYCLE_BRANCH_RESUME.md)).

Required scenario coverage inside every stable campaign:

- `androidPush` must pass `triage_verified` and `stale_taps_verified` after `clear_verified` and before `force_stop_verified` (including second-fixture cleanup; `replayed: true` proves physical delayed-tap metadata presentation after authoritative clear rather than network push delay).
- `ompPublication` must record passed `evidence.lifecycle` (`newGeneration`, `fork`, and `resumed`): once live consumers settle (or only cloud availability held after releasing resources) and the relay tunnel stops, the Mac guest runs `/new`, `/fork` after two synthetic messages, stop/revocation, `--continue`, and stop/revocation.
- Generation rotations require `+1` on the same `instanceId` with stale launches rejected and live **View**/**Control** returning `200` `no-store`, while resume requires a new `instanceId` at generation `1` (`/branch` rewind stays in the upstream canary, and interrupted steps rerun in full).
- External-state lanes (`windows`, `androidPush`, `deviceCloud`) pair with epoch-bound cleanup lanes (`windowsCleanup`, `androidPushCleanup`, `deviceCloudCleanup`). Windows runs alongside Debian and macOS, whereas core Android, background Push, device cloud, and the Windows physical-client check serialize under the in-process Pixel lease (`deviceCloud` ends sessions and stops tunnels and fixtures inside its turn, and any lane that fails to restore the Pixel blocks subsequent Pixel consumers).

Receipt resumption and dispatch safety:

- Receipts resume only for the identical candidate tag, orchestrator commit, and `STABLE_RELEASE.lock.json` predecessor (mismatched `--previous-tag` or `OMP_STABLE_PREVIOUS_TAG` fails before effects; remove the override and rerun).
- Before dispatching Debian, the orchestrator persists a UUID, sets `Stable qualification <uuid>` as the run name, and finds the run via the Actions API; if a persisted UUID is not discoverable, search Actions for `Stable qualification <uuid>` at that commit and resume once visible (move `~/.local/share/omp-session-gateway/qualification/<tag>/` aside only if API evidence proves no run exists and all Mac lanes have zero attempts; otherwise recover Mac cleanup first).
- Before renewed Mac effects, the orchestrator reopens `cleanup` durably; resumed `relay` passes must cover the requested duration with coherent timestamps inside the recorded attempt (missing, shorter, or historical 60-second proofs fail before admission without auto-rerunning `relay`, while unfinished Mac cleanup runs).

Never delete, rename, or replace `~/.local/state/omp-session-gateway/release-host/lease.sqlite` to unlock a campaign, because unlinking the file can create two live lock inodes. If the original command cannot resume recovery, stop all launchers and child processes, reconcile recorded host, device, and cloud state, and clear the `campaign` row only through an `EXCLUSIVE` SQLite transaction.

Cross-process exclusion and owner-verified lease retirement:

- Qualification and `smoke:release` acquire `~/.local/state/omp-session-gateway/release-host/lease.sqlite` under the Studio release account before reading/writing receipts or mutating hosts or devices (`--preflight` and `smoke:release -- --plan` stay read-only; changing `OMP_STABLE_QUALIFICATION_DIR` never bypasses the shared SQLite file, and manual `adb`/SSH or development scripts must not overlap a campaign).
- SQLite `EXCLUSIVE` locking holds an OS lock across ownership and cleanup (1-second busy wait, never stolen by age or PID probes); process death releases the OS lock while keeping the committed owner row so only the exact campaign tag and receipt directory (or smoke repo/tag) can resume.
- During landed-fix re-selection, the driver may clear its failed row in an `EXCLUSIVE` SQLite transaction (fsyncing `jobs/<failed-job>/lease-recovery.json` and stamping `clear-authorized` then `cleared`) only once the job exited, no workers or OS locks remain, Debian and all four cleanup lanes (`cleanup`, `windowsCleanup`, `androidPushCleanup`, `deviceCloudCleanup`) passed at matching epochs, all cloud sessions ended, audited, and deleted, and every owner proves `unresolvedMutation: false`:
  - Windows: `windowsCleanup` reports zero `omp-winqual-` instances, firewall groups, and prefix-listed tailnet nodes (`tailnetNodesRemaining`), plus a verified Pixel baseline if `pixel_verified` was reached.
  - Device cloud: all recorded sessions ended and passed audit, and `deviceCloudCleanup` counts zero `activeVendorSessions` (TestingBot attempt-build sessions plus BrowserStack running and queued sessions).
  - Background Push: `androidPushCleanup` records a verified Pixel baseline (Airplane mode `0`, mobile data on, validated Wi-Fi, VPN up, and `GcmService` connected over Wi-Fi; captured inside the restoring Pixel lease turn).
  - Readiness: `receipt.rigReadiness` for the matching `campaignAttempt` is `restored` with `baselineRestored: true`.

Campaign prerequisites across the Studio controller, Mac guest, Pixel, and cloud accounts (`OMP_STABLE_*` overrides):

- Controller tools and lock guards: `gh`, `cosign`, `adb`, repository workflow secrets, clean published `main` (`STABLE_RELEASE.lock.json` and `docs/RELEASE_STATUS.md` are hash-guarded and never edited by `qualify:stable`), and predecessor from `STABLE_RELEASE.lock.json` (`--previous-tag` and `OMP_STABLE_PREVIOUS_TAG` may only restate it).
- Retained Mac guest (`VirtualMac2,1`, [ADR-033](DECISIONS.md#adr-033--retain-a-macos-virtual-machine-as-the-campaign-mac)): configure SSH target (`user@host` DNS or IPv4 without SSH flags) and expected `/usr/sbin/sysctl -n hw.model` before admission (the workstation stages verified rollback archives and Sigstore bundles so the guest needs no GitHub token, checks `UPSTREAM.lock.json` `sourceTree` and `liveOmpHosts`, and persists `macHost` in schema-3 receipts before first Mac effects):

  ```sh
  export OMP_STABLE_MAC_HOST=gwqual@mac.example.ts.net  # replace with the qualification guest
  export OMP_STABLE_MAC_MODEL=VirtualMac2,1
  unset OMP_STABLE_MAC_SUDO_PASSWORD_FILE
  # OMP_STABLE_MAC_LOGIN defaults to alphastorm@github unless overridden.
  ```

- Mac guest login and toolchain: the SSH account (standard or admin; FileVault off if bare-metal) must auto-login to `gui/<uid>` Aqua after reboot so persistence records `yes` for `guest reboot changed` (`kern.bootsessionuuid`), `console login`, and `readiness token preserved` with green `doctor`.
- Mac guest `PATH` and OMP: install Bun `1.4.4` in `~/.bun/bin`, stock OMP `>= 18.1.20` (`packageVersions["@oh-my-pi/pi-coding-agent"]` from `UPSTREAM.lock.json`) on `PATH`, and user-owned TUN-mode Tailscale (remote commands use `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin` and explicit staged `cosign` paths).
- Mac guest sudo: when `OMP_STABLE_MAC_SUDO_PASSWORD_FILE` is unset, the orchestrator passes empty `OMP_MAC_SUDO_PW` and `sudo -n` must allow `true`, `/usr/local/bin/tailscale` (or `PATH` fallback) `status --json`, `set --operator=<SSH account>`, `cert --cert-file <home>/omp-qual.crt --key-file <home>/omp-qual.key <tailnet DNS name>`, and `shutdown -r now` (bare-metal hosts such as `Mac14,3` may supply a `0600` single-line `OMP_STABLE_MAC_SUDO_PASSWORD_FILE` over SSH stdin).
- Mac guest optional `reboot-guard`: on shared hosts, an owner-executable regular file `$HOME/.config/omp-qualification/reboot-guard` (validated without executing during `--preflight`) runs immediately before `shutdown -r now` and aborts persistence with `the host's reboot guard refused: <output>` (first 400 bytes) on nonzero exit.
- Windows lane: `0600` `~/.vultr-apikey` (admitting the Studio's egress `/32`), `~/.ts-qual-apikey`, `~/.ts-qual-authkey` (or `~/.ts-authkey-qual`), and tools pinned in `scripts/windows-qualification-pins.json` ([Windows qualification](WINDOWS_QUALIFICATION.md)).
- Pixel equipment: one USB-attached Pixel with Tailscale Doze exemption, Do Not Disturb off, hotspot/USB/Bluetooth tethering off, and the **OMP Sessions** WebAPK installed with notification permission granted for the Mac guest's origin ([Android qualification](ANDROID.md)).
- Device-cloud lane: `/opt/homebrew/opt/openjdk@17/bin/java` (or `OMP_STABLE_JAVA`), cached pinned TestingBot tunnel jar under `~/.cache/omp-session-gateway/testingbot/`, and the read-only `0600` 1Password service-account token at `~/.local/state/omp-session-gateway/op-service-account.token` (bound by the release driver as `OMP_STABLE_OP_TOKEN_FILE`) with read access to `op://Centaur/TestingBot/key` and `op://Centaur/TestingBot/secret`.

### Effectful rig readiness before fan-out

`--preflight` is read-only admission (no phone subscription, fixture staging, or VM allocation, and standalone bound `--preflight` accepts attempt `0` only with `HEAD` matching execution source). An effectful campaign acquires `lease.sqlite`, verifies candidate and predecessor bytes (consuming retry authority first on attempts `1`–`2`), and runs the effectful rig-readiness gate before allocating a Windows VM or dispatching Debian:

- Readiness requires an unoccupied Mac guest (no gateway service/listener and empty Serve/Funnel status), installs a disposable candidate gateway and stock-OMP fixture, checks bounded egress and `doctor`/loopback/Serve/Funnel invariants, and requires one locked-screen Pixel Web Push send, acknowledgement, lock-screen presentation, answer, and authoritative clear within 160 seconds.
- Windows readiness reuses credential, image, plan, and toolchain admission, requiring remaining per-tag VM allowance and zero unreconciled resources while recording `quotaObservable: false` without probe VMs when provider quota metadata is unavailable.
- Under the Pixel lease after radio-baseline capture, readiness inspects `dumpsys activity service GcmService` (10-second `adb` cap), running one `svc wifi disable` → 2-second pause → `svc wifi enable` cycle with up to 30 seconds (capped by execution deadline) if disconnected.
- Malformed or duplicate GCM lines fail without cycling Wi-Fi, in-window disconnect fails as `gcm_disconnected` (`infra_transient`), and timeouts fail as harness deadlines (both stop in `diagnostic-required` without retry while restoring radios); schema-3 `gcmConnected` and `gcmRemedyApplied` booleans record on pass and fail, keeping censored samples only in the private cause chain.
- Readiness reads `GET /api/v1/push/config` and requires `subscriptionCount === 1` on the disposable Mac gateway (`0` fails as missing prerequisite; `> 1` fails as `stale_subscriptions` without exposing endpoints or auto-deleting subscriptions) alongside positive matching `sendCount` and `ackCount`, presentation, and clear.

To recover `stale_subscriptions`, keep the driver disabled and finish Pixel and Mac restoration first (`scripts/qualify-macos-host.sh omp-clean uninstall` removes the fixture and service while leaving `~/.local/state/omp-session-gateway/push-state.json` intact). Turn off notifications from known stale browsers (`DELETE /api/v1/push/subscription`) while the gateway runs, or reset all subscriptions on the stopped disposable Mac guest (`jq` required):

```sh
# Run as the retained Mac qualification user, only with the gateway stopped.
# Preserve VAPID keys and every other private state field; print no state contents.
(
  set -eu
  umask 077
  state="$HOME/.local/state/omp-session-gateway/push-state.json"
  test ! -e "$HOME/Library/LaunchAgents/omp-session-gateway.plist"
  ! launchctl print "gui/$(id -u)/omp-session-gateway" >/dev/null 2>&1
  ! lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1
  test -f "$state" && test ! -L "$state"
  temporary="$(mktemp "$state.reset.XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  jq '.subscriptions = []' "$state" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$state"
)
```

Next, stage the authorized candidate fixture, open only the Pixel's installed **OMP Sessions** WebAPK, toggle notifications off and on, and confirm `subscriptionCount === 1` before rearming (never rotate tokens or delete `lease.sqlite`, receipts, or driver state to bypass `stale_subscriptions`).

Browser baseline capture and private error-chain diagnostics:

- Before browser capture, the Push owner writes `rig-readiness/<epoch>/push-progress.json`; capture errors map to `browser_baseline_failed` with a closed substep (`wake`, `WebAPK`, CDP forward/connect, target inventory, attachment, execution context, navigation, or notification-state read), while cleanup errors and expired deadlines keep their own classifications.
- The CLI writes redacted cause and `AggregateError` chains to private stderr (`qualification-err.log`) and `0600` `rig-readiness-logs/browser-substep.json` (substep, 4-KiB message, 16-KiB stack, CDP method or `null`, elapsed ms, `truncated: true` and `redacted: true` flags across the chain, picking the deepest CDP cause or earliest deepest leaf inside 256 KiB; see [Qualification logs and failure evidence](SECURITY.md#qualification-logs-and-failure-evidence)).

Readiness state, restoration, and runaway ceilings:

- `receipt.rigReadiness` records the attempt, private epoch, phase, observations, monotonic timings, and cleanup disposition: Pixel restoration runs before Mac service/staging removal, passing campaigns require terminal `restored` readiness (`baselineRestored: true`), checkpoint failures set `persistenceFailed` without skipping restoration owners, and unrestored Push/cloud fixtures keep their Mac directories and owner files.
- `cleanupFailed` survives later resource destruction; Windows cleanup wraps transport errors as `windowsCleanup/containment/containment_unproven` (`operation: unknown`, `cleanupVerified: false`), and inline Windows Pixel restoration uses a fresh 10-minute owner.
- Readiness uninstall removes the disposable service and staging while retaining `readiness-token` and `installation/{current,history}.json`, so `baselineRestored` attests the Pixel baseline, service/Serve containment, and staging rather than a pre-readiness installation-state snapshot.
- Outer runaway ceilings: Windows 180 minutes, Push and device cloud 90 minutes each, Mac cleanup 90 minutes (two 10-minute scripts plus two 30-minute SSH owners require 80 minutes before margin), Windows readiness/Windows cleanup/cloud cleanup 30 minutes each, core Android 30 minutes, Push cleanup 15 minutes, relay `OMP_STABLE_RELAY_SECONDS` plus 5 minutes, and tunnel startup 90 seconds (1-second health reads).
- Remote commands, shell wrappers, streamed uploads, and OMP PTYs register process groups through `scripts/qualification-remote-owner.sh` (journaled before dispatch; cancelled via a fresh SSH command awaiting group exit, or a changed boot UUID for detached reboot owners, recording `remote_unsettled` collateral and fencing host effects when unsettled; only bounded read-only admission probes omit owner files). Manual attempt-0 readiness stays diagnostic without synthesizing driver bindings.

### BrowserStack device-cloud fallback

Target-to-vendor policy, receipt attribution, and availability holds:

- TestingBot is the sole iPhone vendor (including Home Screen Web Push), and TestingBot is tried first for iPad Safari and Samsung Chrome (Samsung-only with corroborated hardware model code), selecting BrowserStack immediately only when the eligible TestingBot free pool is empty before any primary write (never after a failure, and never running devices in parallel).
- Device-cloud receipts record each target's vendor (`TestingBot` or `BrowserStack`), tunnel version (`4.9` or `8.9`), allocated model, and device-reported OS and browser versions (`cloud.vendor` is `"TestingBot"` when homogeneous or `"mixed"` with `cloud.tunnelVersion: "per-target"` when BrowserStack serves iPad or Samsung; mixed receipts never attribute BrowserStack devices to TestingBot, and legacy homogeneous receipts retain their summaries).
- Shared-device availability is infrastructure rather than a product pass or defect; a valid pinned pool with no free eligible device produces a failed attempt with closed `availabilityHold` evidence and CLI exit code `75`, while auth, catalog, transport, audit, and cleanup failures remain diagnostic ([Legacy device-cloud availability holds](#legacy-device-cloud-availability-holds)).

BrowserStack prerequisites (checked lazily only when fallback is needed; admission fails closed if absent):

- Read-only 1Password service-account access to `op://Centaur/BrowserStack/username` and `op://Centaur/BrowserStack/access-key` alongside existing TestingBot/Java setup.
- BrowserStack `Automate Mobile` with five group/team parallels, pinned to cutoff **2027-10-20 00:00 UTC** in `scripts/browserstack-pins.json` (Plan API omits expiry; renewal requires a reviewed pin update), plus Rosetta 2 on Apple silicon (`arch -x86_64 /usr/bin/true`).
- Dedicated BrowserStack team-member key rotated on suspected exposure under the single-user orchestrator exception ([Real-device cloud qualification](SECURITY.md#real-device-cloud-qualification)): the lane writes the key to a `0600` `local.yml` inside an owned `0700` attempt directory, discards Local stdout/stderr, and reads only a `0600` readiness FIFO in memory because BrowserStack Local `8.9` re-spawns with `--key` in child `argv` (never capture Local debug output with a live key).

#### Audit, cleanup recovery, and mixed-vendor development check

Keep the original `0600` progress checkpoint (inside its `0700` directory; never publish it) and exact orchestrator checkout across cleanup and crash recovery:

- Cleanup routes each known session by vendor, ends it, audits and `DELETE`s BrowserStack records, and verifies `404` on session JSON, all six log APIs, and every declared signed artifact (checkpointed before `DELETE`, including initial `404`s, within a three-minute absence window; delayed artifacts that serve content are fetched and scanned, and timeout leaves `recordRemoved: false` for `deviceCloudCleanup` retry).
- After record absence passes, cleanup closes the loopback proxy, stops owned tunnels by process ancestry and canonical executable/cwd (if Local termination is unverified, key config is removed while preserving the workspace and `0600` PID/birth checkpoint; never-created directories clear only when process enumeration proves zero lineage), and removes the fixture and workspace (ambiguous creates stay dirty until reconciled in the vendor account, and unverified release sets `pixelUnrestored`).
- Only whole JSON string values in duplicate-key-rejecting JSON containing one well-formed `http(s)://` URL (one case-insensitive `://`, hostname once, no comma; never object keys or plaintext logs) count as references; any other key or value containing `://` or a pinned artifact, dashboard, or documentation hostname fails closed.
- `scripts/browserstack-pins.json` pins record-bound `browser_url`, `public_url`, `logs`, and `video_url` dashboard paths and queries plus the three `optimize_url` `/docs/` links (neither host is fetched, `/docs/` is excluded from the artifact census, and queried S3 artifacts require all six `X-Amz-*` parameters once each with `response-content-type` optional).
- Every retained JSON body must pass raw, canonical, and four-pass fixpoint percent-decoded (literal malformed escapes; excess depth fails; one decoded `://` per URL) artifact and dashboard hostname censuses matching accepted reference counts, or fail with `unaccounted BrowserStack artifact reference`.
- Durable incidents are checkpointed for audit hits, conflicting WebDriver IDs, pre-finalization URLs (`unbound retained reference`, no volatile queue), post-audit new origin+pathname objects (`post-audit retained reference`, deleted without late auditing), post-audit schema/census errors (`post-audit unvalidated record`, recovering whole-value pinned URLs from strict JSON while write errors halt), non-UTF-8/US-ASCII or repeated `charset` or `NUL` bytes, and unpinned `video_url` values.
- Media indicators fail on running or finalized reads for non-empty screenshot/video/visual fields, `data:` or media-pattern keys, unquoted/quoted `:`/`=` text-log media keys excluding quoted placeholders, long raw image-base64 runs, or binary image/video byte signatures (boolean/text capability-flag echoes are ignored, and declared media stay unread).
- Every retained response body (including rejected `DELETE`, signed-artifact errors, `200`s during absence polling, and `5xx` bodies before retry; XML/text `404`s and missing-object S3 `403`s are raw-scanned and hostname-censused without forcing JSON) is scanned raw and canonically before rejection; any incident runs `DELETE` and absence verification without clearing the incident or authorizing restoration.
- Milestones `audited`, `recordRemovalStarted` (checkpointed before `DELETE` so crash recovery checks absence without re-sending `DELETE`, and post-`DELETE` `404`s keep prior audits), `recordDeleted`, and `recordRemoved` advance monotonically, normalizing legacy inventories to the last URL per origin/path and reporting closed codes plus removed-under-incident status.
- Crash cleanup re-audits finalized surfaces only when live and fixture OMP generations match; otherwise it deletes records and increments `unauditedRecordsDeleted` without marking them audited.

To run a non-qualifying mixed-vendor development check (private **Tested** evidence only; confirm no campaign, Pixel task, or Mac guest work overlaps, and put pinned Bun `1.4.4` first on `PATH`):

```sh
bun scripts/device-cloud-development.ts \
  --identity "${DEVICE_CLOUD_IDENTITY:?private isolated identity JSON required}" \
  --mac-host "${OMP_STABLE_MAC_HOST:?qualification user@host required}" \
  --origin "${DEVICE_CLOUD_ORIGIN:?deployed candidate HTTPS origin required}" \
  --session-label "${DEVICE_CLOUD_SESSION_LABEL:?isolated live OMP label required}" \
  --mixed-vendors
```

`DEVICE_CLOUD_IDENTITY` (`ExternalLaneIdentity` in `scripts/device-cloud-development.ts`) must bind the verified candidate archive/digest, stock-OMP identity, and a fresh private `receiptRoot` containing `device-cloud-development`, with the candidate gateway, isolated OMP session, SSH fixture tools, both vendor accounts, Java, Rosetta 2, and single-user workstation boundary ready.

Bounds are one attempt, at most three sequential sessions (TestingBot iPhone with Home Screen Push, BrowserStack iPad, and BrowserStack Samsung), zero creation retries, and no new allocations after 40 minutes while in-flight bounds finish, running full production audits and teardown on pass or fail.

## Qualification attempt ownership

The stable orchestrator retains schema-3 receipts and existing lane owners rather than introducing
a workflow engine. New driver-bound executions identify the exact candidate, predecessor,
orchestrator, policy, retained Mac and attempt. A completed attempt's job and exact receipt snapshot
are immutable; only the candidate's working receipt advances. Consuming a retry removes the old
failure authorization durably before admission or setup. Passed product proofs remain unchanged,
while failed resource-owning lanes start on fresh epochs after current cleanup proof.
Fresh unbound effectful campaigns require attempt zero. Later ordinals require the exact terminal-failed
receipt digest or an immutable effect-free prior preflight outcome and digest, never just an execution
file. Both routes consume authority durably before admission. Renewed admission failures belong to `campaign/admission`,
preserving typed classifications without attaching a failure to a pending or previously passed lane.
Execution source must match HEAD before admission or outcome writes; standalone bound `--preflight`
accepts only attempt zero. Verified artifact identities are checked against the execution before
replacing receipt fields, so a rejected candidate cannot corrupt later terminal persistence.

Consumer failure does not cancel healthy siblings. The shared OMP host and relay tunnel live until
their consumers settle; the tunnel stops before the independent publication lifecycle runs.
Publication failure has a terminal timestamp, never an invented pass. Every normally returned
campaign failure finalizes all started lanes and the campaign. Hard process death or failed storage
remains an interrupted attempt, not authority to relaunch.
Relay-stop failure belongs to `campaign/teardown`, not an already-passed publication proof. Finalization
reconciles every typed lane owner with its terminal verdict before validating the complete graph.

Execution cancellation carries a monotonic deadline to owned reads, subprocesses and waits. The
owner aborts and awaits termination before cleanup; no timed-out promise is abandoned. Cleanup
serializes per resource owner, not globally: Pixel restoration stays under its lease, Windows
destruction does not queue behind unrelated Pixel work, and retained-Mac destructive cleanup waits
for Mac consumers and their fixture restoration. A poisoned Pixel refuses subsequent measurements
with collateral references to its originating failures, but always admits restoration under the same
lease. Failed persistence cannot skip owned cleanup; `persistenceFailed` blocks a clean verdict.
Later successful cleanup does not erase an earlier cleanup failure, its identity, or Pixel poisoning.
A shared containment predicate rejects negative cleanup/reconciliation facts, persistence failures
and remaining resources; the final receipt also consumes unsettled remote owners even when setup
failed before a lane recorded its resource. Cleanup, retry and retirement use that same conservative
boundary. Failed cloud or Push restoration retains its Mac fixture and owner records; other owners,
including Windows VM destruction, remain independent.
All mutating/lifecycle remote commands use `qualification-remote-owner.sh`, shared by TypeScript
executors and the Mac shell wrapper. Uploads stream through an owned command rather than unowned
`scp`; OMP PTYs foreground the registered process group. Shell-wrapper owner IDs are journaled before
dispatch so losing the local wrapper cannot lose the remote fence. Cancellation uses a fresh bounded
SSH command to terminate the whole group and await absence, not merely kill the local SSH client.
Leader exit or a completion marker never proves that descendants have stopped. A detached reboot
owner remains unresolved until a changed boot identity proves the old group cannot survive.
A private cancellation tombstone fences delayed admission; unproved termination refuses later
effects on that host, including destructive cleanup and tunnel startup, with `remote_unsettled`
collateral referencing the original teardown root. Ordinary nonzero exits are reconciled too.
Only explicitly bounded read-only admission probes bypass ownership; they create no owner files.

Read-only admission is distinct from effectful rig readiness. After lease acquisition and verified
candidate/predecessor bytes, readiness stages a disposable candidate/stock-OMP fixture, measures
the real push path, and restores it before any full matrix fan-out. Its private receipt epoch owns
the Pixel baseline sidecar; structured observations contain only bounded numbers and booleans.
Manual attempt-zero readiness is diagnostic evidence, not a synthesized policy binding or automatic
retry authorization.
Failed or unresolved readiness is a failure-graph owner, never a passing receipt: its terminal
summary must represent it, and unresolved restoration cannot coexist with proven cleanup.
`restored` requires an explicit `baselineRestored: true`; passing campaigns also require terminal
passed readiness. Every receipt write validates the full schema, and restarting lanes clears
not-started reasons as well as stale failure evidence. Restarting a root invalidates the
entire prior standalone failure graph before persistence, including dependent collateral.
The Push owner retains its transient baseline for restoration, but the orchestrator's sidecar mirror
advances only after its private durable write. Restoration attempts every owner even if every
checkpoint fails; typed `persistenceFailed` evidence, cleanup identities and Pixel poisoning survive
both later cleanup and final receipt writes. Failed cleanup persistence cannot report a restored
baseline or manufacture retry authority. Effect-free Windows admission service failures use the
actual `preflight`, `connection` or `output` producer steps; post-allocation steps cannot authorize
receiptless retries.
Readiness restoration is **not a byte-identical installation-state baseline**: uninstall removes
the disposable service/staging but retains the gateway token and runtime activation history/current
pointer. Those private states are neither captured/digest-compared nor isolated by this gate.
Consequently the subsequent full Mac lifecycle follows a readiness candidate activation, not a
pristine pre-readiness install. Installation-state isolation/restoration remains an explicit deferred
P2; `baselineRestored` covers the captured Pixel baseline, service/Serve containment and staging only.
Transport failures at an ordinary lane's explicit `cleanup` step do not authorize automatic retry.
Private receipt, readiness-baseline and outcome persistence belongs to the POSIX release driver:
file data and parent directories are fsynced; Windows refuses those writes before filesystem
effects. Pure receipt/graph parsing and in-memory state-machine tests remain portable.

## Post-release local installation smoke

After `.github/workflows/signed-release.yml` publishes a stable release, run `smoke:release` (`scripts/post-release-smoke.ts`) from the matching release tooling checkout (`smoke:release` is not shipped inside the runtime archive) to verify the published archive on the Darwin-arm64 Studio operator account (`gwops`) and USB-attached physical Pixel. Signed-candidate qualification and earlier smokes never substitute for a published-byte run.

Prerequisites before running `smoke:release`:

- Run under pinned Bun `1.4.4` (`package.json` `packageManager`) with `gh`, `cosign`, `git`, `shasum`, `tar`, `plutil`, `tailscale`, `tmux`, and `adb` on `PATH` as `tailscaled`'s Studio operator, with an existing `tailscale-serve` gateway (`auth.allowedLogins` non-empty; on a fresh host, install the published predecessor first), private `config.json` and `readiness-token`, and the Pixel PIN in `~/Library/Keychains/omp-qualification.keychain-db`.
- Connect one authorized `adb` device (disconnect others; no `OMP_ANDROID_SERIAL` override exists) with the **OMP Sessions** WebAPK installed for the Studio origin, tethering off, and the one-time Tailscale (`com.tailscale.ipn`) Doze exemption set ([Device admission and one-time WebAPK setup](ANDROID.md#device-admission-and-one-time-webapk-setup), checked read-only before downloads or host changes). Do Not Disturb and Bedtime may stay on because smoke does not test notifications.

Preview bounded effects read-only (`--plan` claims no lease and makes no network, service, Tailscale, OMP, or Android changes), then run the smoke with the verified archive SHA-256:

```sh
bun run smoke:release -- --tag "$TAG" --plan
bun run smoke:release -- --tag "$TAG" --archive-sha256 "$ARCHIVE_SHA256"
```

Optional flags are `--repo <owner/name>` (default `carrythroughsystems/omp-session-gateway`), `--force-reinstall` (reinstalls even when the active runtime already matches `$TAG` and `sourceCommit`; always passed by the release driver), and `--rebuild-omp` (runs `bun add --global --exact @oh-my-pi/pi-coding-agent@<pinned-version>` and prepends Bun's global bin to `PATH`).

Under the shared `smoke:<repository>:<tag>` lock in `~/.local/state/omp-session-gateway/release-host/lease.sqlite`, `smoke:release` executes these steps in order:

1. Downloads all six release assets, checks `SHA256SUMS`, confirms GitHub Latest state and API digests, verifies all three Cosign Sigstore bundles and three GitHub build attestations (honoring `HISTORICAL_RELEASE_TAGS` signer identity), checks local and GitHub verified annotated tags and `origin/main` ancestry, matches `--archive-sha256`, and validates `release-info.json`, `/assets/app.<hash>.js`, and `UPSTREAM.lock.json` (`>= 18.1.20` and Bun `1.4.4`).
   - During publication, `signed-release.yml` also validates draft and published flags plus all six uploaded digests across `0`/`2`/`4`/`8`-second retries, deleting the draft or release if verification fails while leaving the signed tag for diagnosis and any already-public attestations or Rekor entries as failed-attempt provenance.
2. Seeds or verifies `~/.local/lib/omp-session-gateway/bun/v1.4.4/bun` (`0755`), then selects `omp` on `PATH` when its `realpath` resolves inside `@oh-my-pi/pi-coding-agent` or falls back to Bun's global install (installing the pinned version when absent or `--rebuild-omp` is set) so non-stock launchers such as Code Mode are never used, refusing before any gateway change unless stock mainline `>= 18.1.20` has readable `collab.autoStart`.
3. Installs (when version, commit, LaunchAgent Bun path, or `--force-reinstall` requires it) through the persistent Bun executable, proves `config.json` and `readiness-token` remained byte-identical, ensures the gateway's Tailscale Serve HTTPS mapping while verifying all unrelated Serve mappings are unchanged, and requires `status` (`installed`, `active`, `ready`, `diverged: false`) and every `doctor` check to pass.
4. Sets `collab.autoStart` to `control` (verified by read-back), creates `~/omp-post-release-<version>-<nonce>` with a `0600` `.omp-session-gateway-post-release-smoke` marker, and starts a detached `tmux` fixture using `scripts/omp-fixture.json` and `OMP_SKIP_SETUP=1` (must publish with a model within 90 seconds; non-eligible targets fail closed), then runs `android-collab-smoke.ts`, `android-leak-sweep.ts`, `android-acceptance.ts`, and WebAPK verification:
   - Acceptance admits reachability when ICMP succeeds or, when host firewall stealth drops ICMP, when an owned Chrome/CDP disposable tab navigates top-level to credential-free `/api/v1/health` within 15 seconds (`2xx`, exact URL, `status` `ready` or `degraded`, `no-store`, service worker bypassed; `android-reachability` logs `satisfiedBy` as `icmp`, `https`, or `null` to private stderr, while qualification `--preflight` stays ICMP-only).
   - Acceptance snapshots Airplane, Wi-Fi, and mobile-data state, polls `dumpsys connectivity` (`Current Networks:`, 5-second `adb` bound, up to 60 seconds) after each lock, Airplane, and forced-Doze cycle for a connected VPN agent, and on restoration restores radios, exits forced Doze, resets battery emulation, rechecks VPN, and runs the 15-second HTTPS `/api/v1/health` check (`AndroidTailnetRecoveryError` marks restoration failed; reconnect Tailscale manually on the Pixel if stopped).
   - WebAPK verification wakes the display, dismisses the keyguard, sends `KEYCODE_HOME`, and launches the `org.chromium.webapk.*` package for the gateway host (re-dispatching at 10 seconds inside a 30-second focus deadline, with 20-second launcher and 5-second `dumpsys`/keyevent bounds plus 2-second kill grace; timeouts keep `topResumedActivity`, `topDisplayFocusedRootTask`, `mWakefulness`, and `isKeyguardShowing` up to 768 bytes each) and checks `/` or `/client/` within 30 seconds.
5. Kills only the owned `tmux` session, waits for `/api/v1/sessions` revocation, removes the fixture directory only if `.omp-session-gateway-post-release-smoke` matches the run ID, copies `android-{collab,leaks,acceptance}-{out,err}.log` (up to 262,144 bytes each, `0600`) and on failure `failure.json` into `0700` `OMP_RELEASE_SMOKE_LOG_DIR` (`smoke-logs/` under the driver, or `~/.local/state/omp-session-gateway/post-release-smoke/`), and removes staging (kept intact if log copying fails).
   - Leaves the stable gateway, `config.json`, `readiness-token`, persistent Bun, mainline OMP, Serve mappings, and WebAPK installed; if killed before cleanup, check `tmux` for `omp-post-release-*` and verify `~/<label>/.omp-session-gateway-post-release-smoke` before deleting anything.

Record every published-byte smoke result, including any failed attempt, in [Release status](RELEASE_STATUS.md) with its source commit, archive digest, preservation, physical-client, and cleanup evidence.

## Default-relay soak qualification

This optional eight-hour lane is not a mainline release gate; each mainline release runs a founder-approved fresh 30-minute signed-candidate check instead, and only an actual 28,800-second run may be reported as eight-hour or bounded-memory-growth evidence (no fork-era result transfers).

Keep a stock mainline OMP `>= 18.1.20` session and the gateway running, then exercise a read-only **View** client for the default eight hours:

```sh
OMP_GATEWAY_SOAK_PUBLIC_ORIGIN=https://gateway.example.ts.net \
OMP_GATEWAY_SOAK_TAILSCALE_LOGIN=user@example.com \
OMP_GATEWAY_SOAK_GATEWAY_PID="$(launchctl print "gui/$(id -u)/omp-session-gateway" | awk '$1 == "pid" && $2 == "=" {print $3; exit}')" \
bun run qualify:relay-soak
```

The harness sends identity headers and receives the launch capability over a numeric loopback gateway origin, requires `no-store` metadata and launch responses, never prints the capability, and fails if the collaboration client disconnects or is not live at completion. Set `OMP_GATEWAY_SOAK_INSTANCE_ID` to pick one published session, or `OMP_GATEWAY_SOAK_SECONDS` (`>= 1`) for a shorter diagnostic run.

When `OMP_GATEWAY_SOAK_GATEWAY_PID` is set (from `launchctl` on macOS as above, or `systemctl --user show --property MainPID --value omp-session-gateway` on Linux; never inferred from the listening port because loopback may be an SSH tunnel), the harness fails before launch if unsampleable or on gateway exit and samples RSS and CPU at relay start, every ~60 seconds, and at completion.

The output JSON adds a `gateway` summary (sample count, start/end/min/max RSS in KiB, least-squares RSS trend in KiB/hour, and CPU seconds; set `OMP_GATEWAY_SOAK_SAMPLES` to a non-existent absolute path to stream `elapsed_s,rss_kib,cpu_s` CSV rows). Record the gateway commit, stock OMP commit, output JSON, host and browser versions, and date in [Release status](RELEASE_STATUS.md).

## Fleet CI runtime

Fleet CI is an optional external self-hosted shadow runner service (operated outside this repository) rather than a substitute for required GitHub-hosted checks or release qualification. Every job installs and verifies the `package.json` `packageManager` Bun version (`bun run check:repository` rejects self-hosted jobs that skip runtime setup or use a different Bun version).

The fleet controller pins the complete workflow digest; after an intentional workflow edit, review and update that profile binding without rewriting historical qualification records. Validate the appliance and run a bounded shadow against a clean pushed commit rather than relying on a controller dry-run, bypassing workload guards, or replacing the shared runner image.

## Build and keyless provenance

`.github/workflows/signed-release.yml` accepts only commits reachable from `main` tagged with shapes matching the `package.json` version (positive integer `n`; `rc`, `stable`-suffixed, zero-indexed, cross-version, and unknown shapes fail before building):

- `v<version>-prealpha.<n>` for internal engineering candidates;
- `v<version>-alpha[.<n>]` for advertised alpha prereleases;
- `v<version>-beta[.<n>]` for advertised beta prereleases;
- `v<version>` for the stable GitHub Latest release; and
- `provenance-test-v<version>.<n>` for provenance exercises.

`scripts/release-policy.ts` is the sole tag classifier, mapping only bare `v<version>` to `stable`, non-prerelease, and GitHub Latest (all other shapes publish as prereleases with Latest disabled; `OMP_RELEASE_CHANNEL` selects only `release-info.json` channel text and rejects unknown values).

The workflow runs `bun run check`, builds the deterministic archive, verifies its SHA-256 digest, publishes `actions/attest-build-provenance` GitHub attestations and keyless Cosign Sigstore bundles via GitHub Actions OIDC (no long-lived signing key exists), creates one complete draft, and publishes six assets:

- `omp-session-gateway-<version>-bun.tar`;
- `omp-session-gateway-<version>.spdx.json`;
- `SHA256SUMS`;
- `omp-session-gateway-<version>-bun.tar.sigstore.json`;
- `omp-session-gateway-<version>.spdx.json.sigstore.json`; and
- `SHA256SUMS.sigstore.json`.

Repository **Settings → General → Features → Immutable releases** is required before tagging; confirm it prints `true`:

```sh
gh api repos/carrythroughsystems/omp-session-gateway/immutable-releases --jq .enabled
```

GitHub locks the release, assets, and tag and issues the immutable-release attestation after a 24-hour post-publication grace window; treat every published release as final immediately and cut a new tag to fix defects.

For a local unsigned build, run `bun run check` and `bun run release:build`, which emits `dist/release/omp-session-gateway-<package-version>-bun.tar` (containing `SBOM.spdx.json` and zero source maps) plus external SPDX 2.3 SBOM and `SHA256SUMS` (set `OMP_RELEASE_CHANNEL` to `pre-alpha`, `alpha`, `beta`, or `stable` to reproduce a tag's `release-info.json` while all other members and the SBOM stay identical). Never upload source maps, logs, recordings, or unverified fixture diagnostics.

## Verify a published build

Install current GitHub CLI (`gh`) and Cosign releases, select the release tag, and download its assets into an empty directory:

```sh
REPO=carrythroughsystems/omp-session-gateway
TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
WORKFLOW=signed-release.yml
# Historical signing identity snapshot, captured 2026-10-09; newest: v0.7.5,
# published 2026-10-08T16:38:49Z. Never infer the signer from a redirected URL.
SIGNING_REPO="$REPO"
case "$TAG" in
  v0.7.5|v0.7.5-prealpha.2|v0.7.5-prealpha.1|v0.7.4|v0.7.4-prealpha.1|v0.7.3|v0.7.3-prealpha.1|v0.7.2|v0.7.2-prealpha.2|v0.7.2-prealpha.1|v0.7.1|v0.7.1-prealpha.1|v0.7.0|v0.7.0-prealpha.1|v0.6.3|v0.6.3-prealpha.2|v0.6.3-prealpha.1|v0.6.2|v0.6.2-prealpha.1|v0.6.1|v0.6.1-prealpha.1|v0.6.0|v0.6.0-prealpha.4|v0.6.0-prealpha.3|v0.6.0-prealpha.2|v0.6.0-prealpha.1|v0.5.3|v0.5.3-prealpha.1|v0.5.2|v0.5.2-prealpha.1|v0.5.1|v0.5.1-prealpha.1|v0.5.0|v0.5.0-prealpha.1|v0.4.2|v0.4.2-prealpha.1|v0.4.1|v0.4.1-prealpha.3|v0.4.1-prealpha.2|v0.4.1-prealpha.1|v0.4.0|v0.4.0-prealpha.1|v0.3.0|v0.3.0-prealpha.3|v0.3.0-prealpha.2|v0.3.0-prealpha.1|v0.2.1|v0.2.1-prealpha.2|v0.2.0|v0.2.0-prealpha.1|v0.1.0-prealpha.25|v0.1.0-prealpha.24|v0.1.0|v0.1.0-prealpha.23|v0.1.0-prealpha.22|v0.1.0-prealpha.21|v0.1.0-beta.1|v0.1.0-prealpha.20|v0.1.0-prealpha.19|v0.1.0-prealpha.18|v0.1.0-alpha.1|v0.1.0-alpha|provenance-test-v0.1.0.11|v0.1.0-prealpha.17|v0.1.0-prealpha.13|v0.1.0-prealpha.12|v0.1.0-prealpha.11|v0.1.0-prealpha.9|v0.1.0-prealpha.10|v0.1.0-prealpha.8|v0.1.0-prealpha.7|v0.1.0-prealpha.6|v0.1.0-prealpha.5|v0.1.0-prealpha.4|v0.1.0-prealpha.3|v0.1.0-prealpha.2|v0.1.0-prealpha.1|provenance-test-v0.1.0.10|provenance-test-v0.1.0.9|provenance-test-v0.1.0.8|provenance-test-v0.1.0.7|provenance-test-v0.1.0.6|provenance-test-v0.1.0.5)
    SIGNING_REPO=alphastorm/omp-session-gateway ;;
esac

mkdir release-verification
gh release download "$TAG" --repo "$REPO" --dir release-verification
cd release-verification
ARCHIVE="$(ls omp-session-gateway-*-bun.tar)"
SBOM="$(ls omp-session-gateway-*.spdx.json)"
```

Without an explicit tag, `gh release view` selects GitHub Latest (always the qualified stable release). To verify a historical release, set `TAG` to that tag and `WORKFLOW` to its signing workflow (`v0.1.0-beta.1` used `release.yml`); downloads come from `carrythroughsystems/omp-session-gateway`, while certificates and attestations through `v0.7.5` keep `alphastorm/omp-session-gateway` (never add newer tags to that closed list or use wildcards, and read `ARCHIVE`/`SBOM` from disk).

Verify the immutable-release attestation and all six assets (fails during the 24-hour pre-lock grace window or on an unattested file):

```sh
gh release verify "$TAG" --repo "$REPO"
for asset in \
  "$ARCHIVE" \
  "$SBOM" \
  SHA256SUMS \
  "$ARCHIVE.sigstore.json" \
  "$SBOM.sigstore.json" \
  SHA256SUMS.sigstore.json
do
  gh release verify-asset "$TAG" "$asset" --repo "$REPO"
done
```

Verify the archive checksum (`shasum -a 256 -c SHA256SUMS` on macOS):

```sh
sha256sum --check SHA256SUMS
```

On Windows, in PowerShell (prints `True`):

```powershell
$archive = Get-Item omp-session-gateway-*-bun.tar
(Get-FileHash $archive -Algorithm SHA256).Hash -eq (Select-String -Path SHA256SUMS -SimpleMatch $archive.Name).Line.Split(' ')[0]
```

Verify GitHub build provenance against the exact signer repository, workflow, and tag ref:

```sh
for artifact in "$ARCHIVE" "$SBOM" SHA256SUMS
do
  gh attestation verify "$artifact" \
    --repo "$SIGNING_REPO" \
    --signer-workflow "$SIGNING_REPO/.github/workflows/$WORKFLOW" \
    --source-ref "refs/tags/$TAG"
done
```

Verify the independent Sigstore bundles against the GitHub Actions OIDC issuer and certificate identity:

```sh
CERTIFICATE_IDENTITY="https://github.com/$SIGNING_REPO/.github/workflows/$WORKFLOW@refs/tags/$TAG"
for artifact in "$ARCHIVE" "$SBOM" SHA256SUMS
do
  cosign verify-blob \
    --bundle "$artifact.sigstore.json" \
    --certificate-identity "$CERTIFICATE_IDENTITY" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    "$artifact"
done
```

Passing checksum, build-attestation, Cosign, and immutable-release checks prove archive integrity and origin (not host or client compatibility); continue with [CLI and daemon installation](OPERATIONS.md#2-cli-and-daemon-installation).

## Versioning

OMP Session Gateway uses Semantic Versioning:

- breaking configuration, protocol, or security behavior increments the appropriate version component;
- pre-`1.0` minor versions may introduce breaking changes when stated prominently in release notes; and
- wire and HTTP protocol versions are explicit and never inferred from package versions alone.

## Release notes

Every release note includes:

- release channel status (`pre-alpha`, `alpha`, `beta`, or `stable`);
- compatible stock OMP versions and baseline commit;
- security-relevant changes;
- user-visible changes;
- configuration or migration steps;
- known limits and rollback instructions; and
- acknowledgements without reporter-sensitive details.

## Dated rollout records

Everything below is a dated rollout or fork-era record kept as written for historical evidence.

### Merge queue rollout (operator only)

**Status: active since 2026-10-31.** Ruleset `main-merge-queue` (id 26248647) was created
active after `alphastorm-release` was granted Maintain. Readback showed bot `push=true`,
`maintain=true`, `admin=false`, bypass `pull_requests_only`, and classic protection byte-identical
before and after. Repository admins inherit the Maintain bypass: the owner's readback is also
`pull_requests_only`. That adds no authority, because admins can already edit the ruleset.
The proof PR #553 was enqueued by the owner. All seven required contexts passed on merge group
`de9a635`, and `main` advanced to that commit: one parent, subject
`fix(release): generate record prs on current main and date them by the smoke (#553)`,
signature verified, `mergedBy=alphastorm`. The bot's direct merge is still unproven until the
next release. The rollout text below is kept as executed.

The 2026-10-30 inspection found a public organization repository, no rulesets, squash-only
merges, auto-merge disabled, and the classic protection attested above. Keep that entire classic
protection unchanged.
Add one repository branch ruleset containing **only** `merge_queue`, targeting `refs/heads/main`,
with the repository Maintain role as a PR-only bypass actor, after granting that role to
`alphastorm-release`. **The founder selected this design; the lead executes the rollout.**
Never bypass the write role, all admins, required checks, signatures, or the classic protection.

The lead's 2026-10-30 read-only inspection found that `alphastorm-release` is a direct `write`
collaborator, **not** an organization member. The Enterprise organization has **2/2 seats filled**
and requires 2FA; the bot token has only `read:org` and `repo` scopes.
The bot-only team design was rejected: it needs a paid seat, bot 2FA and bot UI acceptance.
Updating the existing public-repository collaborator to Maintain avoids organization enrollment
and a new team seat, but grants broader repository-management permissions and role-wide bypass
to matching current/future holders. The [role capabilities][mq-roles] are broader than Write but
not Admin. Inspect effective inherited/custom roles; require a non-bypass ordinary actor for
the queue proof. This PR changes no settings and does not broaden the bot token's scopes.

#### Decision and primary sources

- [Queue availability][mq-availability]: public organization repositories qualify; private
  organization repositories require Enterprise Cloud. This is not an organization-wide ruleset.
- [Queue behavior][mq-docs]: classic protection and rulesets can require a queue. It checks the
  latest base plus earlier queued PRs, without requiring authors to refresh each branch.
  Retain `strict=true`: queue integration supplies the updated subject for ordinary PRs, while
  direct release-bot merges must still be up to date. Do not loosen the seven existing checks.
- [Rule layering][mq-layering] and [role bypass][mq-bypass]: rulesets layer with classic
  protection; a bypass applies to its ruleset, not the independent classic rules.
  Maintain can bypass for pull requests only. The sole `merge_queue` rule makes this a
  queue-only exception, not a general release-policy override.
- [CLI merge][mq-cli] queues on queue-required branches; its documented direct-bypass option
  is the administrator flag, which this driver must never use. A role bypass alone does not
  justify leaving `gh pr merge` unchanged.
- [Synchronous REST merge][mq-rest] supports an expected head `sha` and `merge_method=squash`;
  it does **not** enqueue. A merge that cannot be performed returns 405; a changed head returns
  409. The driver uses this endpoint with the queue-only bypass and still rereads the merged PR.
  Explicit `commit_title="<observed PR title> (#N)"` and empty `commit_message` preserve the
  immutable release subject without inheriting repository message defaults.
  Without an effective bypass it fails closed, rather than treating enqueue as completion.
- [Queue actor fields][mq-actors] distinguish `enqueuer` from `mergedBy` (REST `merged_by`).
  The primary docs do **not** promise their equality. Do not authorize a release from an enqueue
  identity or assume a queued merge is attributed to the bot. Record observed attribution in
  the rehearsal, but the release path continues to require a directly observed bot merge.
- [Signed commits][mq-signatures]: signatures remain required, including introduced head
  commits; a signed final squash alone does not excuse unsigned head commits. The queue method
  is `SQUASH`, matching the repository setting. Verify the landed signature in both rehearsals.
- [Actions merge groups][mq-event]: `github.sha` is the merge-group SHA, not an individual PR
  head. `ci.yml`, `compatibility.yml`, and `platform-qualification.yml` all listen for
  `merge_group: checks_requested`; they produce the same seven contexts on that SHA.

This is smaller and safer than adding queued-release states. A queued approve could incorporate
another PR and produce a different tree from its qualification receipt. The driver retains
`assertCheckpointAuthor`, generated-content checks, strict head checks, `update-release-pr`,
bot merger attribution, and both pre/post-merge approve tree-equality checks. It only changes
the merge transport. Existing signed bot checkpoints and accepted-merge crash replay remain
valid. No checkpoint-author relaxation or queue-head adoption is permitted.

After the debt PRs land and before activation, the lead drains/disables the Studio driver and
advances its installed checkout to a `main` containing **#552**, following
[Studio installation](#studio-installation-run-as-gwops-after-integration). This is the reviewed
job-free setup path for an authority-file change, never a bot self-upgrade. Finish or recover
pending work on its old policy before advancing the checkout.
Before every release window, **drain the ordinary queue and stop new enqueues until record
lands**. Queue bypass does not reserve `main`; unrelated main movement still holds the release.

#### Exact settings commands — selected Maintain-role design

The [GitHub Terraform provider's role-ID documentation][mq-role-ids] explicitly maps
`maintain` to **`actor_id: 2`** (`write` is 4, `admin` is 5). These IDs are not the display-order
positions of the roles. GitHub's REST ruleset schema documents `RepositoryRole` and PR-only
bypass but does not enumerate these built-in IDs; the linked versioned provider document
supplies the mapping. Verify the ruleset readback/UI identifies the bypass as Maintain.

The [collaborator API][mq-collaborators] updates an existing collaborator without adding them
to the organization. The lead runs these commands as owner after advancing the Studio. The role
grant does not add a token scope or Administration permission. Before activation, inventory
all effective roles: every current/future matching Maintain holder could gain this bypass.
An unexpected effective bypass audience blocks rollout, rather than silently accepting it.

```sh
set -eu
repo=carrythroughsystems/omp-session-gateway
audit=$(mktemp -d)
test "$(gh api user --jq .login)" != alphastorm-release
gh api "repos/$repo/branches/main/protection" > "$audit/protection-before.json"
gh api "repos/$repo/rulesets?includes_parents=true" > "$audit/rulesets-before.json"
jq -e 'length == 0' "$audit/rulesets-before.json"
gh api --paginate "repos/$repo/collaborators?affiliation=all&per_page=100" \
  --slurp > "$audit/collaborators-before.json"
gh api "repos/$repo/collaborators/alphastorm-release/permission"
gh api -X PUT repos/carrythroughsystems/omp-session-gateway/collaborators/alphastorm-release \
  -f permission=maintain
gh api "repos/$repo/collaborators/alphastorm-release/permission" \
  --jq '{permission,role_name,user:.user.login}'
# Require role_name=maintain. The legacy permission field can still say write.
cat > "$audit/queue-ruleset.json" <<'JSON'
{
  "name": "main-merge-queue",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    {"actor_id": 2, "actor_type": "RepositoryRole", "bypass_mode": "pull_request"}
  ],
  "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
  "rules": [
    {
      "type": "merge_queue",
      "parameters": {
        "check_response_timeout_minutes": 60,
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 5,
        "max_entries_to_merge": 5,
        "merge_method": "SQUASH",
        "min_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 0
      }
    }
  ]
}
JSON
ruleset_id=$(gh api --method POST "repos/$repo/rulesets" \
  --input "$audit/queue-ruleset.json" --jq .id)
gh api "repos/$repo/rulesets/$ruleset_id"
gh api "repos/$repo/rulesets/$ruleset_id" \
  --jq '{id,enforcement,bypass_actors,conditions,rules,current_user_can_bypass}'
gh api "repos/$repo/rules/branches/main"
gh api "repos/$repo/branches/main/protection" > "$audit/protection-after.json"
diff -u "$audit/protection-before.json" "$audit/protection-after.json"
```

Create the ruleset **active**, not disabled: a disabled queue cannot exercise an ordinary PR.
Require readback `enforcement=active`, exactly one `merge_queue` rule and exactly the
`RepositoryRole`/2/`pull_request` bypass. There are **no branch-protection edits**, merge-method
changes or auto-merge enablement. Five speculative builds allow useful overlap; `ALLGREEN`
does not intentionally admit failing PRs. The 60-minute response timeout covers the longest
required job's 25-minute cap plus runner startup.

No release script requires the bot's role to equal `write`: `StudioDriver.readiness()` checks
only `repository.permissions.push === true`; qualification's GitHub preflight checks the same
capability. The authority fingerprint binds bot/reviewer identities, protected controls,
branch-protection attestation and required checks, not a repository role string. Maintain
therefore needs no readiness/authority relaxation. Keep `permissions.admin=false` in the
live readback. In the dedicated bot-authenticated shell, with no founder token overrides:

```sh
test "$(gh api user --jq .login)" = alphastorm-release
gh api repos/carrythroughsystems/omp-session-gateway --jq '{permissions}'
gh api "repos/carrythroughsystems/omp-session-gateway/rulesets/$ruleset_id" \
  --jq '{id,enforcement,current_user_can_bypass}'
```

Require bot `permissions.push=true`, `permissions.maintain=true`, `permissions.admin=false`
and `current_user_can_bypass=pull_requests_only`.

#### Queue verification and next-release fallback

The lead first lands **one ordinary reviewed, signed PR through the active queue**, without
requesting a release. This repository has no human actor whose readback is
`current_user_can_bypass=never`: repository admins inherit the Maintain bypass. Instead, prove
that the PR went through the queue: `isInMergeQueue` and the `merge_group` runs on its group SHA.
After its seven required checks pass:

```sh
gh api "repos/$repo/rulesets/$ruleset_id" --jq .current_user_can_bypass
ordinary_head=$(gh pr view "$ordinary_pr" --repo "$repo" --json headRefOid --jq .headRefOid)
ordinary_title=$(gh pr view "$ordinary_pr" --repo "$repo" --json title --jq .title)
gh api graphql -f id="$(gh pr view "$ordinary_pr" --repo "$repo" --json id --jq .id)" \
  -f oid="$ordinary_head" -f query='mutation($id: ID!, $oid: GitObjectID!) {
    enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $oid}) {
      mergeQueueEntry { state position }
    }
  }'
# gh pr merge would request auto-merge here, which this repository disables.
gh run list --repo "$repo" --event merge_group \
  --json databaseId,workflowName,headSha,status,conclusion,url
# Set group_sha to this PR's observed merge-group SHA, not its individual head.
gh api "repos/$repo/commits/$group_sha/check-runs?per_page=100&filter=latest" \
  --jq '.check_runs[] | {name,status,conclusion,app:.app.slug}'
gh pr view "$ordinary_pr" --repo "$repo" --json state,mergedBy,mergeCommit
merge_sha=$(gh pr view "$ordinary_pr" --repo "$repo" --json mergeCommit --jq .mergeCommit.oid)
gh api "repos/$repo/commits/$merge_sha" \
  --jq '{parents:[.parents[].sha],message:.commit.message,verification:.commit.verification}'
```

Require all seven named contexts from GitHub Actions to succeed on the merge-group SHA,
covering all three workflows; no manual branch refresh. Require the landed commit to have one
parent (squash), first message line exactly `$ordinary_title (#$ordinary_pr)`, and
`verification.verified=true`. Record run URLs, group SHA, merge SHA and attribution.
If queue-created message defaults do not produce that subject, stop and reconcile the setting
with the lead; this rollout does not silently change repository message defaults.

The bot's **direct** merge is proven at the **next real release**, not by a synthetic release
or an extra bot probe PR. Observe its normal prepare/approve/record merges; the driver pins the
head, sends an explicit title and empty message, rereads bot merger identity, and retains all
signature/checkpoint/tree checks. If the queue refuses that direct merge, the lead disables
only this ruleset using the retained payload, reads back the result, then re-ticks the same
driver state as `gwops` under the existing bot configuration:

```sh
# Owner settings shell:
jq '.enforcement = "disabled"' "$audit/queue-ruleset.json" |
  gh api --method PUT "repos/$repo/rulesets/$ruleset_id" --input -
gh api "repos/$repo/rulesets/$ruleset_id" --jq '{id,enforcement,bypass_actors}'
gh api "repos/$repo/branches/main/protection"
# Studio gwops, installed checkout and pinned Bun from the installation runbook:
bun scripts/release-driver.ts tick
```

Do not reset state, relax merger/tree/signature checks, or bypass classic protection. A different
hold still requires its existing recovery; disabling the queue is not authority to ignore it.
The PR's CI and the ordinary queue proof do not claim live bot-merge evidence before that release.

[mq-availability]: https://docs.github.com/en/pull-requests/concepts/deploying-code
[mq-docs]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
[mq-layering]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rule-layering
[mq-bypass]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset
[mq-cli]: https://cli.github.com/manual/gh_pr_merge
[mq-rest]: https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request
[mq-actors]: https://docs.github.com/en/graphql/reference/pulls
[mq-signatures]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-signed-commits
[mq-event]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group
[mq-rules-api]: https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
[mq-role-ids]: https://github.com/integrations/terraform-provider-github/blob/v6.12.1/website/docs/r/organization_ruleset.html.markdown#bypass_actors
[mq-roles]: https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization
[mq-collaborators]: https://docs.github.com/en/rest/collaborators/collaborators#add-a-repository-collaborator

### Repository transfer window (Studio driver)

The installed LaunchAgent is `~/Library/LaunchAgents/com.omp.gateway-release-driver.plist`,
working in `~/Development/omp-session-gateway` as `gwops`. It invokes pinned Bun 1.4.4 with
`scripts/release-driver.ts tick` every 300 seconds. The repository is the code constant
`REPOSITORY`, not a plist argument or a gh host setting. The installed checkout does not follow
main automatically. Its last inspected commit was `d70791bf490e4e38ca743b4738b856784b8ebc4b`.

1. **Before transfer**, allow any campaign/job to finish; do not cut over between prepare and
   approval. As `gwops` on the Studio, disable admission, inspect the state and shared lease,
   and unload the timer only after all work is drained:

   ```sh
   export PATH="$HOME/.omp/lane-toolchain/bun-1.4.4/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
   state="$HOME/.local/state/omp-session-gateway/release-driver"
   touch "$state/disabled"
   jq '{phase,candidate,intent,job}' "$state/state.json"
   sqlite3 "$HOME/.local/state/omp-session-gateway/release-host/lease.sqlite" 'select * from campaign;'
   tmux list-sessions
   launchctl print "gui/$(id -u)/com.omp.gateway-release-driver"
   # Proceed only when no driver tick/job or campaign lease is active.
   launchctl bootout "gui/$(id -u)/com.omp.gateway-release-driver"
   ```

2. Transfer the repository in GitHub Settings → General → Transfer ownership to
   `carrythroughsystems`. Preserve the bot's write access and the App installation's access.
   Land the prepared organization-reference PR on the new repository **through all seven strict
   required checks**; admins cannot bypass this protection. Keep the Studio disabled until that
   PR merges. Redeploy the Pages workflow at the new owner; the old Pages URL does not redirect.

3. **After the PR merges**, advance the installed checkout and check the bot's new repository
   permissions. The plist, signing key, gh host `github.com` and user identities
   `alphastorm-release`, `alphastorm` and the order App's bot do not change:

   ```sh
   cd "$HOME/Development/omp-session-gateway"
   git remote set-url origin https://github.com/carrythroughsystems/omp-session-gateway
   git fetch origin main
   git switch main
   git merge --ff-only origin/main
   bun install --frozen-lockfile
   bun test scripts/release-driver.test.ts scripts/post-release-smoke.test.ts
   export GH_CONFIG_DIR="$HOME/.config/gh-release-bot"
   unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
   gh api user --jq .login
   gh api repos/carrythroughsystems/omp-session-gateway --jq '{full_name,permissions}'
   bun scripts/release-driver.ts plan
   # Require alphastorm-release, permissions.push=true, and an expected read-only plan.
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.omp.gateway-release-driver.plist"
   rm "$HOME/.local/state/omp-session-gateway/release-driver/disabled"
   launchctl kickstart "gui/$(id -u)/com.omp.gateway-release-driver"
   ```

Do not rely on old-name API redirects during the gap. Even redirected GET responses carry the
new `head.repo.full_name`, so the old driver's exact repository comparisons no longer recognize
orders/owned PRs. It also addresses comments, PR creation/merges and pushes with the old name;
write redirect behavior is not a cutover guarantee. No state/receipt rewriting is needed for a
drained driver: historical URLs are evidence, not dispatch targets.

### Bun 1.4.4 host preparation (before the next campaign)

This repository move is not a host deployment or a new qualification. Keep the Studio driver
disabled and unloaded, with no campaign, worker or shared lease active, throughout toolchain and
checkout preparation. Do not mutate a pending release's runtime or policy.

For a published-byte smoke of a pre-move release such as v0.9.0, use a pre-move harness checkout
under Bun 1.4.0, following the [matching-release recovery-checkout pattern](#post-release-local-installation-smoke).
`post-release-smoke` derives the expected archive runtime and required running Bun from that
checkout's `packageManager`, not from the release tag alone.

1. As Studio `gwops`, install the official Darwin-arm64 binary at
   `~/.omp/lane-toolchain/bun-1.4.4/bin/bun`, verifying the downloaded zip against the same
   release's `SHASUMS256.txt` before extracting it. Seed the persistent runtime used by Android
   and Windows controller commands from that verified binary, rather than waiting for a smoke:

   ```sh
   toolchain="$HOME/.omp/lane-toolchain/bun-1.4.4"
   download="$(mktemp -d)"
   (
     set -euo pipefail
     persistent="$HOME/.local/lib/omp-session-gateway/bun/v1.4.4"
     cd "$download" &&
     gh release download bun-v1.4.4 -R oven-sh/bun \
       -p bun-darwin-aarch64.zip -p SHASUMS256.txt &&
     awk '$2 == "bun-darwin-aarch64.zip" { print }' SHASUMS256.txt | shasum -a 256 -c &&
     unzip -q bun-darwin-aarch64.zip &&
     install -d "$toolchain/bin" &&
     install -m 755 bun-darwin-aarch64/bun "$toolchain/bin/bun" &&
     test "$("$toolchain/bin/bun" --version)" = 1.4.4 &&
     install -d -m 700 "$persistent" &&
     cp "$toolchain/bin/bun" "$persistent/bun" &&
     chmod 0755 "$persistent/bun" &&
     test "$("$persistent/bun" --version)" = 1.4.4
   ) && rm -rf "$download" && export PATH="$toolchain/bin:$PATH"
   ```

2. Advance the drained checkout through the Studio installation procedure below, install its
   frozen dependencies under 1.4.4, and **regenerate the installed driver plist from
   `scripts/com.omp.gateway-release-driver.plist`**. Merely updating the checkout leaves the old
   installed executable and PATH in place. Preserve the actual retained-Mac target and reviewed
   dry-run setting, inspect the read-only plan, then reload the regenerated plist only after the
   remaining prerequisites agree.
3. Before the next campaign, satisfy the retained Mac's `~/.bun/bin/bun` and the Linux provisioner's
   runtime from `UPSTREAM.lock.json.bunVersion`, and the Windows guest runtime and downloaded-zip
   checksum from `scripts/windows-qualification-pins.json` (`bunVersion`/`bunSha256`). Require their
   observed versions to agree with the current pin; an older lane installation is not inherited
   qualification. The next signed candidate must requalify every lane under 1.4.4.
4. The published-byte smoke verifies the prepared persistent Bun at
   `~/.local/lib/omp-session-gateway/bun/v1.4.4/bun` before installing the gateway, copying its
   running Bun there if absent. That persistent copy is distinct from the driver's lane toolchain;
   keep the service's exact installed Bun path available. Installation re-points the service
   definition to that Bun, and gateway rollback keeps it
   ([upgrade and rollback](UPGRADE_ROLLBACK.md)). Published v0.9.0 retains its 1.4.0 qualification.
5. Prepare the qualification Pixel once: exempt Tailscale (`com.tailscale.ipn`) from Doze via
   **Settings → Apps → Tailscale → Battery → Unrestricted**, or explicitly run
   `adb shell dumpsys deviceidle whitelist +com.tailscale.ipn`. Tailscale recommends unrestricted
   battery use; the acceptance journey's forced-Doze cycle can otherwise kill its VPN and leave
   later smoke stages off the tailnet. Read back `adb shell dumpsys deviceidle whitelist` and
   require a complete `user,com.tailscale.ipn,<uid>` or `system,com.tailscale.ipn,<uid>` line with
   a decimal UID. Shared device admission requires that exact entry before mutations: stable
   qualification preflight remains read-only, and published-byte smoke refuses before release
   download or host changes. An unreadable probe, malformed entry or lookalike package refuses.
   This is explicit operator setup, never an automatic Tailscale or battery-policy remedy; see
   [Android device admission](ANDROID.md#device-admission-and-one-time-webapk-setup).

### One-time #452 installation

**One-time #452 installation after `v0.8.0-prealpha.3`:** this is an authority change, not an
automatic retry across policy fingerprints. Keep the driver disabled while the founder merges
#452 and the maintainer performs the job-free, quiesced installation. Then:

1. Checksum and retain .3's state, immutable job specification/results/logs and qualification
   receipts. Confirm no worker/process owns the host and all four cleanup lanes and Debian
   passed at the recorded epochs. Use the maintainer EXCLUSIVE owner-verified lease-clear
   procedure below, not database deletion; move the old `state.json` into the driver's `retired/`
   archive. Preserve all referenced job/receipt evidence. Do not edit its policy fingerprint or
   the immutable failed-worker specification to force a match.
2. In the gateway checkout, dispatch the updated request workflow once:
   ```sh
   gh workflow run release-request.yml --ref main -f omp_version=18.12.5 -f release_class=minor
   ```
   Wait for its successful filing job to record `Record tracking issue #448`. It must reuse the
   still-open minor request #448, not close it or create a replacement.
3. Run read-only `bun scripts/release-driver.ts plan`. Require `select` for issue #448 and
   `v0.8.0-prealpha.4`, under the newly installed policy, before changing the kill switch.
4. Rearm through the reviewed setup procedure. Later failures under that policy can use automatic
   same-request re-selection; .3's old authority binding is intentionally not carried across.

### v0.3.0 qualification and promotion


**Fork-era record:** this section preserves the named v0.3.0 campaign, its commands, and its
patched OMP evidence. It is not a command to republish that immutable version or a mainline result.

Stable **v0.3.0** was published as immutable GitHub Latest for that campaign;
**v0.3.0-prealpha.3** was its signed qualification vehicle.
The host/client matrix, runtime equivalence, and fresh eight-hour relay endurance passed.
The candidate uses exact patched OMP
v18.1.14 and Bun 1.4.0, with **v0.2.1** as the rollback predecessor. Historical qualification
does not transfer. The retained Mac must have the exact pinned Bun before any host lane runs.

The seven-lane orchestrator includes a bounded relay smoke, not the eight-hour endurance gate.
When the pinned client/host path changes, run the full-duration default-relay procedure below;
do not copy a historical long-window pass into the new release decision.

Land the complete candidate changes on `main`, confirm the final source commit, then create and
push the signed annotated candidate tag at that commit. From the clean published Darwin-arm64
checkout, run:

```sh
bun run qualify:stable --tag v0.3.0-prealpha.3
```

Review every lane in the passed receipt before updating `STABLE_RELEASE.lock.json`. The stable
workflow requires the qualified predecessor to remain GitHub Latest, rechecks it immediately before
promotion, and byte-compares the stable runtime against the signed candidate. Do not publish bare
`v0.3.0` with the historical v0.2.1 lock. Gateway rollback does not switch the separately installed
OMP binary; v0.2.1 retains its exact v17.4.1 prerequisite.

Managed candidate upgrades retain hostname, omitted port, identity-trust, and registry settings.
Continue supplying the production origin and allowlist on both installation and upgrade; unchanged
configuration bytes are not rewritten.

### Sourced contract matrix — observed 2026-10-20

The public-page probes below are **Tested**, not qualification or a capability-opening journey.
Documentation is distinguished from live observations; no claim covers vendor-internal retention.

| Contract | Source | Observed finding / gate |
| --- | --- | --- |
| Account and entitlement | [Plan API](https://www.browserstack.com/docs/automate/api-reference/selenium/plan); read-only 1Password identity/field reads | `SERVICE_ACCOUNT` at `my.1password.com`; both fields readable. Plan HTTP 200: `Automate Mobile`, group/team maximum 5, running/queued 0, queue maximum 5. `terminal_access=Public` is not session privacy evidence. No expiry field. |
| W3C real mobile | [Official Selenium example](https://www.browserstack.com/docs/automate/selenium/oxygen) | Fixed `https://hub.browserstack.com/wd/hub`, Basic header only. `browserName=safari/chrome`; `bstack:options` contains exact `deviceName`, `osVersion`, `realMobile:true`, `local:true`, `localIdentifier`. Both target allocations succeeded. An initial `enableTelemetry` option was refused (HTTP 200/status 13, empty session ID); it is not sent. |
| Catalog / availability | [Browser API](https://www.browserstack.com/docs/automate/api-reference/selenium/browser) | 5,244 rows. Eligible reviewed aliases: `iPad 10th`/iOS 27 (`ipad`), `Samsung Galaxy S26`/Android 16.0, S25/15.0, S24/16.0 or 14.0 (`android`, Chrome). `samsung` means Samsung Internet and is refused. iPad 9th rows were below the iPadOS 26 floor; no A55 alias was present. No documented per-model free-device API was identified; plan concurrency is not availability. |
| Allocation identity | Bounded public-page session capabilities, REST session identity and device-side version report | iPad 10th: Safari 27.0, iPadOS 27.0. Samsung Galaxy S26: Chrome 152.0.7977.54, Android 16.0.0, `SM-S942B`. A 2026-10-20 BrowserStack follow-up probe also reported S26 `SM-S942U1`. Android's capability `deviceName` is a serial, not evidence; exact REST model and Chrome hardware hints corroborate it. **Attestation gate passed.** |
| Local artifact | [Downloads](https://www.browserstack.com/docs/local-testing/releases-and-downloads), [official Python loader](https://raw.githubusercontent.com/browserstack/browserstack-local-python/master/browserstack/local_binary.py), downloaded bytes | Official Darwin x64 8.9, Mach-O x86_64, runs under Rosetta. Exact ZIP/binary pins below; an unversioned URL changing bytes fails closed. |
| Forced routing | [Binary parameters](https://www.browserstack.com/docs/local-testing/binary-params), [tunnel firewall](https://www.browserstack.com/local-testing/tunnel-firewall) | `--force-local` plus exact `--include-hosts` rejects nonincluded names; exclusion supersedes inclusion. `--only` is ineffective with force-local and is not used. Filters cover all ports/protocols, so the exact CONNECT allowlist remains authoritative. |
| Browser upstream / containment | [Proxy configuration](https://www.browserstack.com/docs/automate/selenium/test-behind-proxy/configure-settings), [binary parameters](https://www.browserstack.com/docs/local-testing/binary-params) | `--local-proxy-host 127.0.0.1`, lane-owned port, `--force-proxy`, unique local identifier, dashboard/proxy discovery disabled. Before allocation, seven proxy denials (plain HTTP, wrong port, alternate name, loopback address/name, LAN, tailnet) returned 403 with zero trap connections. During successful iPad/Samsung probes, Local forwarded only example.com CONNECTs (one/two). **Observed proxy gate passed.** |
| TLS and listeners | [Transparent TCP architecture](https://www.browserstack.com/docs/local-testing/network-and-architecture); proxy and Local probes | Direct versus CONNECT-proxied example.com certificate fingerprints matched with authorized TLS. Actual Local traffic carried TLS ClientHello, not plaintext. Local owned processes had no listeners; runtime refuses any non-loopback listener. This is not remote-browser certificate-chain attestation. **Observed noninterception/listener gate passed.** |
| Credential configuration | [Binary parameters](https://www.browserstack.com/docs/local-testing/binary-params); synthetic child-spawn trace and production-helper probes | 0600 config in 0700 directory accepted; binary expands it to child `--key`. **Explicit maintainer exception, not argv secrecy.** Lane argv contains only the config path. Normal stop and a killed-parent recovery removed config/FIFO and left zero owned Local processes; recovery verifies exact executable plus attempt cwd and shutdown quiescence. |
| Recording / masking | [Debugging controls](https://www.browserstack.com/docs/automate/selenium/debugging-options), [sensitive data](https://www.browserstack.com/docs/automate/selenium/hide-sensitive-data) | `video/debug/networkLogs/seleniumLogs/appiumLogs:false`, `consoleLogs:"disable"` and `maskCommands:"screenshot,setValues,getValues,setCookies,getCookies"` used. Text logs cannot be disabled and retained public navigation/commands. No screenshot references or retained media were observed. Failed-command screenshots remain an audit gate, never assumed absent. |
| Retained surfaces | [Session API](https://www.browserstack.com/docs/automate/api-reference/selenium/session); both finalized records | Session JSON and `/logs`, `/networklogs`, `/consolelogs`, `/seleniumlogs`, `/appiumlogs`, `/telemetrylogs`, plus all populated signed log/profiling/session-terminal/build-terminal references are inspected. `/logs` returned text (4,855/5,472 bytes), console a 363-byte no-messages placeholder, other log APIs 404. Console signed URL returned the same text; other signed logs 404. `browser_url`/`public_url` are dashboard representations, not followed as log surfaces; no public sharing is enabled. |
| Media indicators | Same Session API and debugging contract; both records | Video URL was populated even when disabled, but returned S3 403 `AccessDenied` mentioning missing `s3:ListBucket`, the observed missing-object response. Together with disabled capability and clean indicators, accepted as **no retained media observed**. A media URL serving a body fails the audit. |
| Deletion / absence | [DELETE session](https://www.browserstack.com/docs/automate/api-reference/selenium/session#delete-session); both records | Single `DELETE /automate/sessions/{id}.json` returned HTTP 200/`status:ok`; session JSON and all six API log surfaces then returned 404. **Record-removal gate passed.** Issued signed console URLs briefly still served identical audited text, then returned 404 (iPad observed absent after 30 seconds; Samsung on a later read). |
| Signed URL lifetime | Observed `X-Amz-Date` / `X-Amz-Expires` and post-delete reads; reviewed recovery contract | One issued URL advertised 604,800 seconds (seven days), although its object disappeared sooner. Every declared reference, including initially-404 artifacts, persists only in private 0600 progress until verified absent. Even identical clean text must disappear within the three-minute absence bound; otherwise cleanup remains incomplete. Fresh processes recheck the same durable inventory. Public evidence/logs never contain signed URLs. |
| Multiple hosts / canonical ownership | [Tunnel Firewall examples 2–3](https://www.browserstack.com/local-testing/tunnel-firewall); pinned 8.9 synthetic-key child trace and Local-only probe | The documented syntax is separate space-delimited host argv entries, not a comma-joined argument. The child trace preserved `example.com` and `example.org`; actual Local reached readiness with both. The configured proxy accepted CONNECT/TLS to both (authorized, matching direct certificate fingerprints), denied all seven trap cases with 403 and zero trap connections, and Local had no listeners. Fresh-process stop through the unresolved `/var` path removed config/FIFO using canonical executable/cwd ownership. No device session was used for this probe: it proves Local configuration plus proxy containment, not a two-host remote-browser journey. |

The shared strict parser refuses duplicate decoded object keys at any depth before deriving
references from JSON metadata or inventories. JSON log bodies use the same parser; ordinary
text logs remain raw-only and are never reference sources. The audit searches raw bounded bytes
plus strict canonical serialization for each whole live
View/Control capability and every exact contiguous 16-character window. Default-relay capabilities
are compact `room.key` strings, not candidate-origin URLs: retained directory navigation is not
an exception to the scan and needs no obfuscation. Only counts/verdicts enter returned evidence.
The private recovery checkpoint additionally holds vendor-signed artifact references and public
session generation identities, never View/Control links or retained log contents. Deletion is
defense in depth after this audit. Unknown surfaces, missing required logs and exhausted byte
budgets fail. Nonempty screenshot/video/visual fields and image/video URLs are retained-media
indicators, including opaque screenshots in failed-command responses.

Artifact discovery walks all strings in the complete strictly parsed JSON, not a top-level field
projection. The disjoint origin lists in `browserstack-pins.json` classify nested API/S3 references
as artifacts, and only top-level `browser_url`/`public_url` on `automate.browserstack.com` as dashboard
presentations. Dashboard references are counted, never fetched or followed, and their session/log
API absence proves removal of their represented content. Other origins, or the dashboard origin
in another field, fail closed. Property-style tests place references at varied nested paths.

Pinned in `scripts/browserstack-pins.json`:

| Artifact | URL / bytes / SHA-256 |
| --- | --- |
| ZIP | `https://local-downloads.browserstack.com/BrowserStackLocal-darwin-x64.zip`; `10298446` bytes; `bb293eeeeec062f97b380a0de077a2e5aea48b288b4bb654f8274ee6483b2d4d` |
| Local 8.9 binary | `36317952` bytes; `9091089b71864a5f840ba26eb15e141be184676cf2c9f0d821c53cb4cd42d8fb` |

The reviewed three create calls were one schema refusal with no session, one successful iPad and
one successful Samsung. Both allocated sessions opened only `https://example.com`, were ended,
inspected and deleted; all record APIs and the previously issued signed text artifacts were
subsequently absent. No View/Control capability, Pixel, retained Mac, stable campaign or driver
was exercised. Local-only probes also proved private config modes and crash recovery.
The iPad generation is the vendor's allocation report, not an independent Safari hardware
identifier: Safari corroborates tablet family and version. Samsung's Chrome model code adds
independent browser-reported hardware corroboration. Neither observation broadens qualification.

### Fork-era post-release smoke procedure

All commands, prerequisites, preservation claims, and results in this subsection are retained
for their named historical release checkout. They do not describe mainline setup.

After a stable release is public, run its published bytes on the configured local Darwin-arm64 Mac
and the attached physical Android client. This is a post-publication install/upgrade smoke, not a
second stable qualification run and not a substitute for `qualify:stable`.

Prerequisites are Bun 1.3.14, `gh`, `cosign`, `git`, `shasum`, `tar`, `plutil`, `tailscale`, `tmux`,
and `adb`; an attached supported Pixel; an existing private gateway config and publisher token; the
configured Tailscale Serve origin; and the **OMP Sessions** WebAPK already installed for that exact
origin. The Android qualification PIN stays in the documented macOS Keychain service.

Zero, unauthorized, or ambiguous adb devices are refused before release download, host mutation, or
fixture creation. Every Android path uses the shared single-device admission; disconnect other
devices instead of selecting one with an environment override. The former `OMP_ANDROID_SERIAL`
override is removed: it applied only to smoke preflight, not the subsequent device journeys.

Post-release smoke also refuses active or unobservable tethering before those effects: its Android
acceptance lane switches the device radios. Do Not Disturb/Bedtime may remain on because these
smoke lanes do not exercise notifications; the harness never changes DND.

Acceptance snapshots airplane, Wi-Fi and mobile-data state after admission and restores and
verifies that exact baseline, rather than unconditionally enabling both radios. It also attempts
Doze and battery reset after a failed radio restoration. Restoration and owned-fixture cleanup
failures are reported with, never instead of, the primary qualification failure.

After each lock, Airplane and forced-Doze recovery cycle, acceptance requires the Pixel's
tailnet VPN to return: up to 60 seconds of one-second polling for a connected VPN agent in the
`Current Networks:` section of `dumpsys connectivity`. Each recovery adb read is bounded to
five seconds. This read-only check follows the rendered same-page recovery measurement without
opening Chrome tabs, changing DevTools forwards or disturbing the measured page's visibility.
Private acceptance evidence records VPN/HTTPS booleans and timings, with `httpsProbed: false`
between cycles; ICMP observations alone never establish recovery.
After the measured journey is over, restoration restores radios, exits forced Doze, resets battery
emulation, repeats the VPN check and additionally proves the tailnet path with one owned top-level
HTTPS health navigation using the same 15-second probe described below. A lost path raises
`AndroidTailnetRecoveryError`; during restoration it is a restoration failure, preventing later
smoke or qualification stages from using the disconnected Pixel.

Before the Doze exemption became an admission prerequisite, Tailscale was not on the release
Pixel's Doze whitelist. Forced Doze could terminate its VPN and leave the tailnet path down after
Doze exited. An already stopped VPN still requires the operator to **reconnect Tailscale on the
Pixel** before another attempt. No Tailscale/VPN, airplane-mode, DNS, exit-node, firewall or
battery-policy remedy is automatic; the recovery check changes none of those device settings.

This fork-era example ran from the `v0.2.1` checkout with its own Bun and OMP pins. The later
fork-era v0.3.0 engineering source used Bun 1.4.0 and OMP v18.1.14; neither set of bytes is the
current mainline source or a transferable qualification:


```sh
bunx bun@1.3.14 run smoke:release -- \
  --tag v0.2.1 \
  --archive-sha256 <the omp-session-gateway-0.2.1-bun.tar digest from the published SHA256SUMS>
```

The command verifies the annotated tag, GitHub Latest state, all six release asset digests,
`SHA256SUMS`, three GitHub attestations, three Sigstore bundles, archive source metadata, the hashed
PWA asset, and the exact OMP/Bun pins. It then installs or verifies the stable gateway through the
persistent pinned Bun runtime, proves the config and publisher token remained byte-identical,
creates only the configured Serve mapping while comparing every unrelated mapping, and requires all
`doctor` checks to pass.

Before touching the installed gateway, the OMP lane selects the `omp` on `PATH` when it resolves
inside the mainline `@oh-my-pi/pi-coding-agent` package, and otherwise Bun's global install of that
package, so a same-named launcher such as Code Mode is never exercised. The selected binary must be
`>=18.1.20`, and the smoke refuses before any gateway change when no candidate qualifies. It sets
`collab.autoStart` to `control`, then starts one uniquely named `omp-post-release-*` tmux fixture
carrying only the synthetic qualification credential. Every smoke and qualification fixture uses the
model in `scripts/omp-fixture.json`, starts with `OMP_SKIP_SETUP=1` so an onboarding wizard cannot
swallow prompts, and fails as soon as it publishes without a resolved model. The smoke then runs
physical View-to-Control prompt/interrupt,
forbidden-sink, lock/Airplane/Doze same-page recovery, and installed-WebAPK launch checks. The
installed WebAPK may resume either the directory or its existing collaboration route; the launch
check preserves that page instead of requiring the directory title. Before launching, the smoke
confirms the display is awake and the keyguard dismissed, then sends HOME so Chrome's browser
task does not keep focus after acceptance. It dispatches the same launcher intent once more if
the standalone task is still not focused and resumed after ten seconds. Both launches and polling
share one thirty-second focus deadline, measured from the first dispatch. Each launcher dispatch
has a twenty-second adb bound, capped by the remaining focus window; dumpsys and keyevent
commands retain their five-second bound. A stalled final adb read and private power/keyguard
sampling each have a five-second command bound plus two-second termination grace, keeping the
failure path below forty-five seconds from the first launch. A focus timeout keeps the public
error unchanged; its private cause retains only the last `topResumedActivity` and
`topDisplayFocusedRootTask` lines, `mWakefulness`, and `isKeyguardShowing` (four structural lines,
at most 768 bytes each; unsafe fields are withheld). No page content or capability is retained.
Target eligibility is checked before touching the device; protected, soak, old, missing, ambiguous, or
non-Control fixtures fail closed.

The Android acceptance journey admits device-origin reachability when ICMP succeeds **or**, after
ICMP loss, an owned Chrome/CDP top-level HTTPS health navigation succeeds. The host can drop ICMP,
for example when the macOS application firewall uses stealth mode. Chrome's Local Network Access
blocks the same tailnet request from an opaque `about:blank` document, so the fallback navigates
only its owned disposable tab to `/api/v1/health` on the validated, credential-free HTTPS origin.
Admission requires no navigation error, that exact committed URL (not a redirect or interstitial),
a 2xx navigation `responseStatus`, and a parsed gateway health body whose `status` is `ready` or
`degraded`; discovery readiness does not change network reachability. It fetches no capability and
does not log response bodies or navigate the user's PWA tab. The service worker bypasses both
navigations and `/api/`, and the health response is `no-store`, so the PWA cache is untouched.
Its execution deadline is 15 seconds, followed by the existing bounded owned target/forward cleanup;
late responses or unproven cleanup cannot admit the journey.

Private Android stderr contains a closed `android-reachability` record: the ICMP and HTTPS
observations and `satisfiedBy` (`icmp`, `https`, or `null`). ICMP loss alone is an observation, not
a refusal, when the HTTPS alternative succeeds. Both failed probes still refuse before the
acceptance journey's radio mutations. An adb transport failure remains fatal. No VPN, DNS, firewall,
credential, or TLS-validation policy is changed. Qualification preflights remain ICMP-only and
read-only; they never opt into the browser-backed alternative.

Normal success and failure kill only that tmux session, wait for registry revocation, remove the
fixture only when its per-run ownership marker still matches, and delete private staging. The stable
gateway, config/token, Bun runtime, mainline OMP, Serve configuration, and WebAPK remain installed.
Before deleting staging, the smoke copies its three Android commands' `android-{collab,leaks,acceptance}-{out,err}.log`
files to a new private diagnostic directory; each contains at most 262,144 exact bytes and is
fsynced with mode `0600`. The directory is mode `0700`. It retains no downloaded archives or
fixture launcher scripts. Failure/cause/restoration diagnostics are saved as bounded `failure.json`.
The driver binds `OMP_RELEASE_SMOKE_LOG_DIR` to its job's `smoke-logs/`; a standalone run uses a
fresh directory below `~/.local/state/omp-session-gateway/post-release-smoke/` and announces that
location on stderr. An explicit `OMP_RELEASE_SMOKE_LOG_DIR` must be absolute and not yet exist.
Existing evidence is never replaced. If copying logs fails, staging is left intact for private
operator recovery after all fixture restoration steps have been attempted. Review these files
locally; do not publish raw command output, capabilities, credentials, or device identifiers.
`--rebuild-omp` runs `bun add --global --exact` for the pinned package and uses Bun's global bin.
`--force-reinstall` retests an already active stable gateway. `--plan` prints the
bounded effects without network, service, Tailscale, OMP, or Android changes.

If the orchestrator is killed before its restoration owner runs cleanup, inspect tmux for the single
`omp-post-release-*` name and require the matching
`~/<label>/.omp-session-gateway-post-release-smoke` marker before killing or removing anything.
Never wildcard-delete fixture directories or touch unrelated tmux sessions or Serve mappings.


Before the real stable tag, rehearse the exact gh create/edit flags in a private repository. Require
six assets in the draft and published states, prerelease/not-Latest for the prerelease control,
non-prerelease/Latest for the stable case, a matching latest-release API result, and complete
release/tag cleanup. Record the gh version and resulting JSON in the release ledger.

The protected 28,800-second default-relay result may transfer only while relay host/client,
collab-web, and wire bytes remain identical. A bounded real relay smoke still runs for the exact
candidate. Windows and every other excluded mode are not stable blockers because they are not
advertised; they must remain explicit exclusions.

The superseded release.yml workflow (GitHub workflow ID 316404456) reports state deleted. Hardened
signed-release.yml is active as workflow ID 339848215. Historical tags retain release.yml in their
certificate identity; new tags use signed-release.yml. A run that fails after
attestation or Cosign signing may leave public GitHub
attestations or Rekor entries even when no release is published; those records are failed-attempt
provenance, not an advertised release.
The workflow validates API-observed draft and published flags plus six uploaded asset digests
against the exact local signed files. It retries state observation after 0/2/4/8 seconds. If draft
validation still fails, it deletes the draft; if post-publication tag or release-state validation
still fails, it deletes the release. The signed tag remains for operator diagnosis. Private live
rehearsal proved publication/deletion compensation. Already-public attestation or Rekor records are
not removed and remain failed-attempt provenance.
