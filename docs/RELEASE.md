# Release process

This document is the maintainer runbook for building, qualifying, promoting, and publishing OMP
Session Gateway releases. If you are installing or updating a gateway, you only need
[Verify a published build](#verify-a-published-build) and the
[installation guide](OPERATIONS.md#2-cli-and-daemon-installation).

## Pre-alpha, alpha, beta, and stable artifacts

The repository builds Bun-runtime release candidates (`pre-alpha`) and promotes a candidate to
`stable` (GitHub Latest) only after its signed archive passes the full hardware and device-cloud
qualification matrix. For the current published release, supported platforms, and recorded lane
receipts, see [Compatibility](COMPATIBILITY.md) and [Release status](RELEASE_STATUS.md); for
predecessor rollback boundaries, see [Upgrade and rollback](UPGRADE_ROLLBACK.md).

## Mainline stable release procedure

This sequence published v0.5.0 (#222–#225) and v0.5.1 (#227–#230). Each step is a separate effect;
a candidate, a passed receipt, or an approved lock never promotes itself. Work from a clean checkout
of `main` that matches `origin/main` (`qualify:stable` refuses detached or unpublished commits), with
pinned Bun `1.4.0` first on `PATH`.

The manual path requires an explicit maintainer decision for scope/publication, live qualification
and installed-byte smoke. The standing routine driver below already has authority for these steps
within its requested patch/minor release class and existing resource caps; it does not ask again per release.

1. **Prepare the candidate.** One `chore(release): prepare X.Y.Z` PR bumps the version in the five
   `package.json` files, `PRODUCT_VERSION` in `apps/gateway/src/diagnostics.ts` and
   `scripts/build-release.ts`, and `GATEWAY_VERSION` in `apps/gateway/src/installation.ts`; cuts the
   `CHANGELOG.md` section; generates the highlights and rollback text in
   `scripts/release-text.json` (read by `.github/workflows/signed-release.yml`); and notes the preparation in the release ledger. After it
   merges, push a signed annotated `vX.Y.Z-prealpha.1` tag on the merge commit and
   [verify the published candidate](#verify-a-published-build).
2. **Qualify it.** Run `bun run qualify:stable --tag vX.Y.Z-prealpha.1 --preflight`, which checks
   admission prerequisites without effects, then the same command without `--preflight` (about an
   hour; see [Release gates](#release-gates)). The droplet workflow takes only an exact candidate
   tag. After a failure, fix the cause on `main`, keep the failed receipt unchanged, and archive it
   only as the release gates allow before rerunning. Afterwards confirm that no qualification
   droplet or ephemeral SSH key remains in the DigitalOcean account, and that no `omp-winqual-*`
   instance, firewall group, or tailnet node remains.
3. **Promote it.** One `chore(release): approve vX.Y.Z for stable promotion` PR sets
   `STABLE_RELEASE.lock.json` from the passed receipt, records every lane and any failed attempt in
   the ledger, moves the COMPATIBILITY release paragraph, the status page, and `site/llms.txt` to
   "qualified; publication pending" wording, and writes the predecessor section of
   [UPGRADE_ROLLBACK.md](UPGRADE_ROLLBACK.md). Install and download surfaces link to the latest
   release and name no version. `scripts/site-coherence.test.ts` fails while any of these disagree
   with the stable lock. A clean
   `OMP_RELEASE_CHANNEL=stable bun run release:build` of that tree must match every candidate
   archive member by path, mode, and bytes, except `release-info.json`, `SBOM.spdx.json`,
   `STABLE_RELEASE.lock.json`, and `schemas/stable-release.schema.json`:
   `bun run release:compare -- <candidate archive> <candidate SHA-256> dist/release/omp-session-gateway-X.Y.Z-bun.tar`
   refuses a candidate that is not the qualified digest and fails on any other difference. Before merging, run
   `bun run check`, `bun scripts/release-policy.ts vX.Y.Z X.Y.Z STABLE_RELEASE.lock.json`, and
   `bun run smoke:release -- --tag vX.Y.Z --plan`.
4. **Publish.** Merge with the head pinned, confirm the merged tree equals the tested tree, and push
   a signed annotated `vX.Y.Z` tag on the merge commit; `signed-release.yml` publishes it. Verify the
   published build, confirm it is GitHub Latest, and reproduce its archive digest with a local
   stable-channel build of the tag.
5. **Smoke the published bytes.** Run the [post-release smoke](#post-release-local-installation-smoke)
   with the verified digest.
6. **Record the evidence.** One `docs(release): record vX.Y.Z publication and installed
   verification` PR moves the COMPATIBILITY release paragraph, the status page, and `site/llms.txt`
   to "published" and records the publication run, source, digest, and smoke result.

Every mainline release so far has renewed a founder-approved fresh 1,800-second relay check in
place of the eight-hour gate. The orchestrator defaults to 1,800 seconds and rejects shorter
checks; `OMP_STABLE_RELAY_SECONDS` may select 1,800–3,600 seconds. Eight-hour endurance is not
rerun or claimed, and no historical eight-hour receipt transfers.

## Unattended release driver

The opt-in Studio driver makes every automated repository write as `alphastorm-release`.
The weekly workflow or a manual dispatch starts a request. Under standing routine authority the
release bot merges the generated exact-subject promotion PR; there is no per-release founder
approval, Slack authority, button, or token. Slack may relay only the first line of a
release-bot progress comment. The manual procedure above remains available, but must never overlap a driver
campaign or smoke.

### Request, authority and gates

`.github/workflows/release-request.yml` requests a release weekly on Mondays at 15:17 UTC
(`17 15 * * 1`), resolving npm `latest` to one exact stock OMP version. A scheduled run succeeds
without requesting anything when `UPSTREAM.lock.json` already equals or exceeds that version,
or any open, non-PR issue authored by `github-actions[bot]` has the exact title
`Upstream tracking: vX.Y.Z` (numeric version only). The reason appears in the step summary, and
the canary and filing jobs do not run. After a green canary, a separate issue-read-only job checks
for any such open request again before the filing job; if a request arrived in the meantime,
it skips the filing job with a summary instead. The filing job stays skipped, not successful,
so the driver cannot count the skip as an explicit re-request. Scheduled runs never request
fixes-only releases. A newly filed weekly issue is consumed normally.

Manual requests dispatch the workflow on `main` with `omp_version` (default `latest`) and
`release_class` (`patch` by default, or explicit `minor`). Scheduled requests are always `patch`.
It resolves the exact stock npm version, refuses a version below `UPSTREAM.lock.json`, and calls
the existing Linux/Windows canary. A red canary retains its existing canary-issue reporting and
opens no tracking issue. A green run opens or reuses `Upstream tracking: vX.Y.Z` with the
`release-request` label, using `GITHUB_TOKEN` in a job that never checks out or executes PR code.
Equality with the lock is a fixes-only request: it is still filed and Carrythrough does not start
an order. Patch and minor requests keep the same exact upstream title, but minor requests carry
the `release-minor` label and reuse only an issue of that class. Thus a minor request does not
rebind an existing patch request. The issue body is for humans; the driver never parses it.
A successful request job's `Request OMP vX.Y.Z` (patch) or `Request OMP vX.Y.Z (minor)` name and
Actions run/attempt bind the version and class and identify explicit re-requests without issue
edits. A minor label without a matching successful filing job grants no authority. The selected
class is persisted with the request; diagnostic re-requests cannot switch it, and completing a
patch release does not close an outstanding minor request.

The driver derives the gateway target from the latest stable tag: `patch` increments the patch,
while `minor` increments the minor and resets the patch to zero. No arbitrary version or major
transition is accepted. For example, with published `v0.7.7`, use
`gh workflow run release-request.yml --ref main -f omp_version=18.12.5 -f release_class=minor`
to request `v0.8.0`; unpublished `v0.7.8-prealpha.N` tags remain immutable. Leave an older patch
request open until the new minor request succeeds, then annotate/close it as superseded.

`bun scripts/release-driver.ts plan` is read-only, including local state. It can use the existing
read-only gh session before bot credentials are installed. `tick` advances at most one step:
select the highest trusted open request, land the exact Carrythrough draft order, generate and
merge prepare, sign/publish/verify the candidate, preflight and qualify, generate and locally check
approve, check routine authority, merge as the release bot, sign/publish/verify stable (including rebuilt-digest equality), smoke
with `--force-reinstall --rebuild-omp`, generate/merge record, and close fulfilled requests. A
retried smoke finds the stable gateway already active from the failed attempt, and the record
accepts only smoke evidence of an install, so every driver smoke reinstalls the published bytes.
Each state transition posts exactly one reconciled bot comment:
`release-driver: <state> — <detail>`, followed by links.

An order must be authored by `carrythroughsystems[bot]` with GitHub type `Bot`,
from this repository's `carrythrough/*` head into `main`, first observed as a draft. Only these
paths, in this order, belong to the binding's ORDER_SCOPE:

1. `CHANGELOG.md`
2. `UPSTREAM.lock.json`
3. `docs/COMPATIBILITY.md`
4. `docs/DECISIONS.md`
5. `docs/OMP_INTEGRATION.md`
6. `docs/RELEASE_STATUS.md`
7. `scripts/windows-qualification-pins.json`

Both the current and previous filenames of a rename must be in scope. An out-of-scope order gets
`held` and is never landed automatically. Multiple matching orders are ambiguous and wait.
Every required GitHub Actions check must pass on the exact head: `implementation-checks`,
`windows-service-lifecycle`, `browser-notifications`, `portable-source (ubuntu-24.04)`,
`portable-source (macos-latest)`, `portable-source (windows-latest)`, and `browser-core`.
Behind branches are updated before rechecking; merges are squash merges with `--match-head-commit`.
No driver push targets `main`. Strict branch protection and signed-commit requirements remain in
force; GitHub supplies the signed squash merge. Auto-merge stays disabled.

The promotion PR remains the reviewable exact-subject artifact. Standing authority permits only
the requested next patch or explicit next minor version, eligible upstream baseline orders, and fixes/performance fixes/reverts
already reviewed and merged by the configured maintainer. The installed checkout is the separately
reviewed setup baseline. Later source commits require an associated merged main PR in those
classes or a bot-owned generated release record; unclassified/direct source commits refuse.
Founder fixes must be squash-merged with an immutable `fix`, `perf` or `revert` merge-commit
subject (optional Conventional Commit scope). Mutable PR titles never authorize a release.
Rebase/multi-commit merges can leave commits without an exact associated PR merge SHA and are
intentionally out of class: the typed hold names the first unreviewed commit. Resolve through
the separately reviewed setup path, not by retitling a PR or relaxing the routine predicate.

Before bot merge the Studio durably pins candidate tag/source/digest, promotion head/tree and the
installed-policy fingerprint. Its passed receipt must bind qualification, stable build, candidate
runtime comparison, release-policy gate, smoke plan and local checks to that subject. All seven
GitHub checks must pass on the same head. The legacy phase name "approval-required" evaluates
this predicate; it no longer asks the founder. Only the configured release bot may merge this PR.
Stable signing independently rereads merger, merge source/tree, evidence, current main and policy.
Main movement after prepare is a stale-source hold, never silent incorporation of newer work.

A routine release cannot change its own controls: all .github/ paths (signers, credential permissions,
checks and CODEOWNERS), all schemas/, all scripts/ except generated release-text.json and the
order-scoped windows-qualification-pins.json, AGENTS.md/CLAUDE.md, tsconfig/bunfig/other lock controls,
and docs/RELEASE.md, docs/TEST_PLAN.md, docs/SECURITY.md are protected. Package manifests
at every depth are fingerprinted with only their top-level version omitted; root bun.lock omits only
generated workspace versions. The manifest sweep found the root and four workspace package.json
files, bunfig.toml, mise.toml and mise.lock; no npm/Yarn configuration, Deno, Python or Cargo
install manifests are present. Lifecycle scripts and dependency/trusted-dependency changes remain
controls, even in a newly added nested package. bunfig.toml and lifecycle-capable mise.toml at
any depth are protected; mise.lock is covered by the lockfile rule. build-release.ts omits only its
generated product-version literal. Both tracked modifications and untracked non-ignored files
(including Bun-autoloaded .env/config inputs) make the installed checkout dirty and hold admission.
Ordinary source/test fixes do not change quality requirements.
Added/deleted control paths and rename-from paths cannot evade the comparison. The live main
branch-protection attestation, configured bot/source-reviewer identities and required-check list also
enter the fingerprint. The setup reviewer observed classic main protection: strict seven required
checks; enforce_admins=true; stale-review dismissal=true; zero required approving reviews;
code-owner/last-push approval=false; signed commits=true; linear history=false; force pushes and
deletions=false; conversation resolution=true; restrictions=null. These exact admin-only facts are
committed as ROUTINE_BRANCH_PROTECTION. At runtime the unprivileged bot rereads protected=true,
protection enabled for everyone and the exact seven contexts from /branches/main, plus the merged
commit verification.verified signature and PR merger metadata. A readable divergence holds. The
bot cannot reread admin-only fields: they are attested, not claimed as freshly observed. Changing
the attestation or an admin-only setting is the separately reviewed F3 setup path; never broaden
the machine credential to administration access. Changing the installed-policy fingerprint requires the same separately
reviewed one-time setup/installation path, never a release-bot self-upgrade.

Generated prepare/approve/record PRs must change only the exact per-kind `GENERATED_RELEASE_PATHS`
set in scripts/release-policy.ts, including both rename filenames. This is rechecked before merging
and when classifying previous release records. Protected paths remain refused; prepare may change
only the generated build-release.ts version literal, manifest versions and bun.lock workspace
versions, proven by normalized control equality at the merge boundary. Existing PR/remote-branch
checkpoints require a verified head signature and the configured bot as commit author before
adoption. Bot PR authorship or a release-driver branch prefix alone grants no authority.

ROUTINE_HOLD_REASONS in scripts/release-policy.ts enumerates authority-path-changed, policy-changed,
out-of-class, stale-source, missing-evidence, head-tree-changed, unexpected-merger,
pr-identity-changed, required-checks-missing, merge-tree-changed, merge-missing, merge-signature-missing and generated-content-mismatch. Pending required
checks wait without an effect; other holds preserve the subject for operator review. A historical
passed job without the exact evidence binding grants no authority.

Prepare, approve and record use `scripts/release-generate.ts` with an explicit persisted
`--date YYYY-MM-DD`; package/workspace versions and source constants are mechanical edits.
Release prose lives in `scripts/release-text.json`, not in the workflow. The existing
`site-coherence.test.ts` and `release-policy.ts` remain gates, not bypassable renderer assertions.
The golden v0.7.4 fixtures use a sanitized real candidate receipt and compare generated surfaces
with committed release history; the fixture notes describe the retained public evidence.

`prepare X.Y.Z --release-class minor --date YYYY-MM-DD` uses the same next-minor predicate
as selection and promotion. It may supersede an unqualified, unpublished next-patch preparation:
the package/workspace/constants move to the next minor; that prepared CHANGELOG section and
`[Unreleased]` are folded into one new cut; the generator recounts all bullets and regenerates
`release-text.json` together. The old summary must still match its companion metadata; never
hand-recount either header. Qualified/published preparations, unrelated versions, duplicate cuts
and edited summaries refuse. The published stable lock and OMP baseline stay unchanged.
Installing this class-aware control change is the separately reviewed job-free Studio setup path,
not a release-bot self-upgrade. No main changes may land between prepare and approve.

### Repository transfer window (Studio driver)

The installed LaunchAgent is `~/Library/LaunchAgents/com.omp.gateway-release-driver.plist`,
working in `~/Development/omp-session-gateway` as `gwops`. It invokes pinned Bun 1.4.0 with
`scripts/release-driver.ts tick` every 300 seconds. The repository is the code constant
`REPOSITORY`, not a plist argument or a gh host setting. The installed checkout does not follow
main automatically. Its last inspected commit was `d70791bf490e4e38ca743b4738b856784b8ebc4b`.

1. **Before transfer**, allow any campaign/job to finish; do not cut over between prepare and
   approval. As `gwops` on the Studio, disable admission, inspect the state and shared lease,
   and unload the timer only after all work is drained:

   ```sh
   export PATH="$HOME/.omp/lane-toolchain/bun-1.4.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
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

### Studio installation (run as gwops after integration)

The bot account is a repository collaborator with write access. Its registered Studio SSH signing
key is `~/.ssh/omp-gateway-release-signing`; the key's public half is
`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPnD0XsQMUDImQxiWVgU8IXM6XeMVxFgPvp9bOAl/5Gd`.
The driver reads the authenticated bot's numeric GitHub id and derives its noreply tagger address
(default account: `339384828+alphastorm-release@users.noreply.github.com`). All gh and HTTPS git
writes use `~/.config/gh-release-bot`; ambient founder tokens and git identities are discarded.
Neither a token nor a private key belongs in the plist or repository.

Prerequisites remain those of the full campaign/smoke above: retained guest running and reachable,
Pixel and WebAPK ready, cloud credentials in their private files, predecessor installed, current
`gh`/`cosign`/`tmux`/`adb`, and pinned Bun. The driver unlocks the empty-password
`~/Library/Keychains/omp-qualification.keychain-db` before campaign Pixel work and before smoke.
Non-login SSH needs the explicit Homebrew PATH. Install only after old manual launchers and their
children are drained; retain their receipts and the shared release-host lease.

SSH to the Studio as the operator (for example `ssh gwops@studio.example.ts.net`), then:
Disable admission and unload the driver before any checkout mutation. Do not continue while a
worker, detached job or host lease remains active: let it finish and retain its receipts. A failed
owner requires its documented recovery; never delete the lease to make installation proceed.

```sh
export PATH="$HOME/.omp/lane-toolchain/bun-1.4.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
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

The template runs every 300 seconds and at load under the logged-in gwops user. It sends launchd
stdout/stderr to `/dev/null`; the driver keeps a bounded 256-KiB private `driver.log` and per-job
exit/diagnostic files. The account's existing gateway and VM LaunchAgents are not modified.
Configuration is `OMP_RELEASE_BOT_LOGIN`, `OMP_RELEASE_FOUNDER_LOGIN`,
`OMP_RELEASE_GH_CONFIG_DIR`, `OMP_RELEASE_SIGNING_KEY`, `OMP_RELEASE_STATE_DIR` (absolute
paths), and `OMP_RELEASE_DRY_RUN=1|true`. Defaults match the paths above.

### Readiness and credential expiry

Both plan and status are read-only, including local state. Plan includes readiness alongside its
proposed operation; status reports phase, candidate, pending intent/outbox, typed hold and the
first unreviewed source commit when applicable. Readiness
uses the dedicated machine account even when a plan uses an existing read-only gh session for
repository reads. It checks private credential-file ownership/mode/presence, required tools,
pinned Darwin-arm64 Bun, configured retained guest/SSH reachability, one authorized adb device,
repository write identity, writer-readable branch-protection facts, disabled/dry-run switches and
the shared lease. Admin-only facts use the installed attestation above, not inferred defaults. Normal ticks persist
sanitized readiness.json before new-request admission; false prerequisites leave requests unconsumed.
No raw credential, device serial or response header is persisted.

GitHub credential expiry is reported from its response header when supplied. Service-account,
Tailscale and Vultr expiry/validity remain explicitly unknown without supported metadata; the
driver does not invent validity or refresh credentials. TestingBot catalog/device availability,
Pixel PIN/WebAPK, workflow-secret validity and retained guest full preflight remain mandatory
candidate preflight requirements. File presence/SSH reachability are not full-matrix qualification
or zero-touch proof. Readiness lists unobserved checks explicitly. Resolve missing prerequisites,
wrong bot identity or an unreadable/owned lease before arming; never delete the owning lease.

The Funnel check is gateway-scoped: unrelated Mana/Studio Funnels stay live. Funnel on the gateway
Serve authority, proxy/TCP routes to its backend, foreground gateway exposure, and unparseable
relevant configuration refuse. Do not pause unrelated investor Funnels to pass smoke. Published-byte
smoke still forces reinstall and checks every doctor result; public gateway exposure stays prohibited.

### Durable jobs, failures and kill switch

State lives under `~/.local/state/omp-session-gateway/release-driver/`: atomic/fsynced
`state.json` contains the write intent, pinned PR/tag identities and comment outbox. A SQLite
mutex excludes overlapping ticks. Deterministic release branches, tags, comment markers and tmux
job ids reconcile a provider write accepted just before a process crash. Plan does not create any
of these. Bot-owned worktrees under `work/` leave the operator checkout's working tree alone.
The candidate campaign uses a dedicated published `release-driver/*-campaign` branch pinned to
the prepare merge, so unrelated movement of main cannot silently change the orchestrator source.

Campaign, approve checks and smoke run detached in named tmux sessions with a start claim, JSON
result and exit file under `jobs/`. Campaign receipts remain at
`~/.local/share/omp-session-gateway/qualification/<candidate>/stable-qualification.json`.
Qualification and smoke use their existing shared release-host lease (including its durable failed
owner); the driver never deletes, replaces or steals it. An ordinary failed/missing device/cloud job enters
diagnostic-required, reports non-passed lanes, and is not retried. A missing local approve-check
worker can resume only at the same head/tree and policy; no device, cloud or publication action
is replayed. Passed/failed results are never overwritten to invent a retry. The saved intent and
outbox reconcile accepted bot merges and announcements after a crash; immutable tags never move. An explicit new green request
after a fix on main selects the next prealpha only after the previous lease is recovered. Follow
[Release gates](#release-gates) for cleanup/recovery of that exact old campaign first; a new request
is not permission to abandon cloud/device resources. Ordinary failed receipts stay unchanged. Public
verification failures also leave the write intent for diagnosis; immutable tags are never moved.

A 1Password identity-probe deadline is a host-fault diagnostic, not a wrong-account verdict.
The probe kills its child after 30 seconds. If the installed macOS executable hangs, an operator
can re-exec the same inode through a hardlink or run `brew reinstall --cask 1password-cli`;
confirm `op --account my.1password.com --version` under the release account, then rerun the
exact candidate's credential-bearing preflight. A passing manual preflight has no durable
candidate-bound retry receipt and does not clear `diagnostic-required`. The retry gate compares
main's SHA for inequality with `failedMain`, not changed paths or ancestry; separate source and
policy authority still apply. Retain the failed job and receipts, land the reviewed fix, and
request the same exact OMP version again. If release controls change, the job-free setup review
must also explicitly retire the failed selection's old policy binding: archive its state only
after confirming no pending intent/outbox, stable publication, active job or owned host lease,
then select the new request under the reviewed installed policy. Updating the checkout alone
leaves the old binding and holds preparation. The next selection uses the next prealpha; never
overwrite a completed campaign job or its evidence.

### Device-cloud availability holds

Only validated no-free pinned-device observations are availability. Authentication, malformed
catalogs, transport/queue ambiguity, allocation mismatch, journey defects, audit errors and failed
cleanup remain diagnostic. The stable CLI exits 75 for an availability-only failure. The driver
sets `OMP_STABLE_OUTCOME_FILE` to a distinct `preflight-outcome.json` or `campaign-outcome.json`
inside the private job directory; the CLI atomically writes a closed JSON outcome there. Earlier
human lane stdout/stderr is never parsed as machine evidence. Missing or invalid outcome files
make exit 75 diagnostic. An allocation attempt remains `failed` with additive `availabilityHold`
evidence containing the complete closed array of one to three hold leaves in schema 3.

Before reporting a resumable allocation hold, all other consumers must finish, the relay tunnel
must stop, the real OMP publication lifecycle must pass, Windows must settle, and every resource
and final Mac cleanup must pass. A cleanup or lifecycle error combined with availability refuses
resumption. A preflight-only hold creates no cloud session, tunnel, fixture or qualification
receipt and may instead be retried as an effects-free campaign start.

The driver's `infrastructure-held` phase never retries automatically, even after devices become
free or a later observation passes. First inspect the private completed job and receipt, confirm
equipment availability, then authorize exactly the displayed candidate and attempt:

```sh
bun scripts/release-driver.ts status
bun scripts/release-driver.ts retry-device-cloud --candidate <exact-prealpha-tag> --job-attempt <current-attempt>
```

The command takes the tick mutex and checks: exact held selection and attempt; no pending
intent/outbox, active candidate worker, approve step or stable publication; unchanged reviewed
source/control policy and Mac host from the immutable completed-worker specification, not the
invoking CLI environment; a fully eligible held receipt or effects-free preflight hold; and no
foreign release-host owner. It allocates no devices. The next ordinary tick launches one new
job; repeating the authorization is refused. A dry-run configuration never authorizes a write.
Both hold scopes persist that binding, and a scope mismatch is refused even if the receipt is
otherwise eligible.

Attempt zero keeps `jobs/<issue>-<candidate>-campaign/`; retries use
`jobs/<issue>-<candidate>-campaign-retry-<n>/`, with matching unique tmux/worktree/branch names.
Never remove or overwrite a completed job, its start claim, result, logs, exit file, or
`held-qualification.json`. For allocation holds, that private immutable snapshot must still
equal the working receipt when retry is authorized. The working receipt advances normally only
in the new attempt.
If tmux fails after writing the new specification, the next tick replays that same authorized
job, directory and host binding while neither its worker start claim nor tmux session exists.
It does not allocate another ordinal or overwrite the specification. A start claim is a hard
no-relaunch fence even when the tmux session has disappeared.

For an operator-owned eligible campaign outside the driver, use the same source, candidate,
predecessor, Mac host and receipt directory explicitly:

```sh
bun run qualify:stable -- --tag <exact-prealpha-tag> --resume-device-cloud
```

This refuses ordinary, foreign, incomplete, stale-cleanup or dirty receipts before admission
or receipt mutation. It reruns the whole cloud attempt on a new epoch, not an old browser session.
Once eligibility is accepted, it clears and persists the old hold before any admission or setup.
Only a newly validated all-hold failure can restore eligibility; an ordinary setup, teardown or
protected-file failure exits 1 and leaves no hold authorization. Resume uses its own in-process
preflight, not a separate driver preflight against stale authorization. A new admission-only hold
on an existing eligible receipt remains receipt-scoped, with fresh preflight leaves and the same
required passed proof and clean resources.
Passed Debian, macOS lifecycle, Android, background Push, Windows, relay and OMP publication
proof stay unchanged. Candidate/predecessor signatures, checksums and identity are reverified;
the candidate gateway and a fresh isolated OMP fixture are reconstructed and launch readiness
checked; final Mac cleanup reopens. Those setup/identity/cleanup steps are not repeated expensive
qualification journeys. A changed orchestrator commit cannot resume this receipt. The original
release-host owner remains until the exact campaign succeeds; never clear it to force a retry.

To stop new work immediately:

```sh
touch "$HOME/.local/state/omp-session-gateway/release-driver/disabled"
launchctl bootout "gui/$(id -u)/com.omp.gateway-release-driver"
```

This does not kill an already-running campaign or smoke, because killing it can interrupt cleanup.
Inspect `jobs/*/spec.json`, each exact tmux session, exit/result files and the qualification receipt;
drain or recover the owning job before rearming. Never remove `state.json`, the job start claim,
or either SQLite file to force a retry. Revoke the bot credential to stop repository writes if the
operator account is compromised; Slack has no credential or authority to pause/resume a release.

### Carrythrough checks-pod boundary

`bun run check:order` validates ORDER_SCOPE's pins/schema and existing repository/coherence/ledger
gates on Linux, with no devices and no network after `bun install`. The pod needs a writable
workspace but may keep the remaining root read-only, with about 4 GiB RAM and TCP 443 egress only
for dependency installation and an intentional upstream pin refresh. `scripts/upstream-pins.ts`
uses one GitHub commit lookup plus one GitHub contents lookup per `relevantPaths` entry; those
API reads work unauthenticated within GitHub's public rate limit or use `GH_TOKEN`/`GITHUB_TOKEN`
when supplied. Two source package manifests come from `raw.githubusercontent.com`, and six npm
registry reads cover coding-agent/wire metadata and two native-platform metadata/tarball pairs.
Only GitHub API requests receive that token. Native tarball integrity and payload hashes are
verified locally with `tar`; npm credentials, devices, a Docker daemon and a writable home root
are not prerequisites for the order check itself.

## v0.3.0 qualification and promotion


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

## Release gates

The current decision and exact evidence live in RELEASE_STATUS.md; compatibility claims live in
COMPATIBILITY.md. Generated or signed artifacts do not promote themselves.

Every advertised release requires:

- private vulnerability reporting and repository security controls enabled;
- an exact mainline OMP commit, validated discovery/query contract, collab-web provenance, and
  license inventory;
- all automated unit, integration, browser, type, build, and secret/identifier-leak checks green;
- advertised host installers qualified against the exact signed candidate;
- loopback-only exposure plus positive and negative Tailscale identity/Origin evidence;
- exact physical-client View/Control, stale-generation, lifecycle, and forbidden-sink evidence;
- documented configuration, upgrade, rollback, cleanup, compatibility, and limitations; and
- complete checksums, SBOM, GitHub attestations, Cosign bundles, signed tag, and reproducible build
  verification.

Stable publication additionally requires that the exact signed tag's tree contain a fully passed
STABLE_RELEASE.lock.json candidate tag/source/archive digest, runtime-byte comparison, Debian,
retained Mac14,3, Windows host, physical Pixel, background Web Push, mainline OMP discovery/query
and launch/revocation, provenance, and secret-sink evidence. No fork-era receipt can stand in for
one of these new candidate lanes.
The workflow asserts checked-out HEAD equals the event SHA, checks candidate ancestry and the
published candidate digest, requires a GitHub-verified signed annotated tag, and rechecks tag state
before public provenance, draft creation, and promotion. Issue #65 remains a browser-process
environment limitation: after 45 uninterrupted visible failure seconds, the loaded shell offers
retry and force-stop/reopen help without a third-party probe or a claim that JavaScript repaired
Chrome.

The following command and its result are **fork-era v0.2.1 history**, run from that release’s
clean, published Darwin-arm64 branch, not instructions for a mainline candidate:

```sh
bun run qualify:stable --tag v0.2.1-prealpha.2
```

For a selected mainline candidate, `bun run qualify:stable --tag "$TAG"` must re-verify signed
assets and provenance for the candidate and its predecessor, exercise Debian and retained-Mac
lifecycle, the exact predecessor, real mainline discovery/launch/revocation, physical Pixel
acceptance and secret sinks, bounded relay smoke, the [Windows host lane](WINDOWS_QUALIFICATION.md),
the [background Web Push lane](ANDROID.md), the real-device cloud lane (ADR-032), and cleanup. It
writes a private receipt (schema 3) under
`~/.local/share/omp-session-gateway/qualification/<tag>/stable-qualification.json`. Retargeted
scripts are not qualification evidence until these lanes run against the exact candidate.

The predecessor verifier has one finite, committed historical exception in
`scripts/post-release-smoke.ts`: `v0.7.5`, archive SHA256
`171dec1a9902c934c99060b250f209cf627ce194d07da1412b35ad419c3ec57c`.
Its archive, SBOM and checksums must verify against their retained keyless Cosign bundles with
certificate identity
`https://github.com/alphastorm/omp-session-gateway/.github/workflows/signed-release.yml@refs/tags/v0.7.5`
and OIDC issuer `https://token.actions.githubusercontent.com`. There is no long-lived public key.
The signed tag, exact asset set, published Latest state, checksums and actual archive digest
remain mandatory. This exception acknowledges absent historical build-provenance attestations;
it does not create replacement provenance or qualify any candidate. The receipt records
`githubAttestations: "historical-cosign"` and the pinned original signing identity, and approval
rechecks that evidence against the same finite allowlist. Candidates, normal publication smoke,
and every non-allowlisted predecessor still require all three online GitHub build attestations.
A changed historical digest or failed Cosign verification fails closed; an attestation outage
never selects the exception. Extending the list is a reviewed control-policy change, not a
runtime override. Preserve failed campaign receipts and the host lease during recovery; a new
orchestrator commit cannot resume or rewrite a receipt bound to the old commit.

Before spending a campaign, prove changed or previously failing lanes end to end in development
mode at the exact orchestrator tree. In particular, run the expanded Push lane with the pinned Bun:
`bun scripts/android-push-qualification.ts development <published archive>` (with the matching
`OMP_PUSH_FIXTURE_BINARY`), and run
`bun scripts/omp-lifecycle-development.ts --omp <absolute path to stock OMP dist/cli.js>`.
Follow the [Push procedure](ANDROID.md#physical-background-push-lane) and
[lifecycle procedure](LIFECYCLE_BRANCH_RESUME.md). These are tested evidence, not qualification;
a stable campaign must not be used to discover harness failures.

Every campaign must pass `androidPush`'s `triage_verified` and `stale_taps_verified`
after `clear_verified` and before `force_stop_verified`, including the second fixture's cleanup.
Delayed taps re-present the original notification's metadata-only data after authoritative clear;
`replayed: true` proves physical delayed-tap handling, not push delivery ordering or delay.
`ompPublication` must also contain passed `evidence.lifecycle` with `newGeneration`, `fork`, and
`resumed` observations. After all live-session users settle successfully (or only device-cloud
availability failed with its resources released) and the relay tunnel
stops, the Mac host runs `/new`, `/fork` after two synthetic messages, stop/revocation,
`--continue`, and stop/revocation again. Rotations require generation + 1 on the same instance,
stale launches rejected without capabilities, and live View/Control `200 no-store`; resume requires
a new instance at generation 1 with the same label and working launches. Rewind is not
gateway-visible and stays in the canary rather than this Mac step. Evidence is additive, the
receipt schema stays 3, and an interrupted lifecycle step remains non-passed and reruns in full.

The Windows, background Push, and device-cloud lanes own external state, so each has a cleanup lane
(`windowsCleanup`, `androidPushCleanup`, `deviceCloudCleanup`) that runs after every attempt and
passes only for the attempt epoch its lane recorded. A crash leaves a lane `running`, and a rerun may
resume it; a caught failure is released before a new attempt begins, and a failed release stops the
lane there. If admission fails while a recorded Windows VM exists, the command still destroys it.
Windows runs beside the Debian and Mac lanes. The core Android lane, background Push, the
device-cloud lane, and the Windows physical client take turns under the Pixel lease: the cloud lane's
prompts and alert reach every push subscription on the candidate gateway, so it ends its sessions and
stops its tunnel and fixture within its own turn, and `deviceCloudCleanup` has work only after an
attempt stopped before that release finished. A lane that cannot restore the phone blocks every
later one.

The receipt resumes only for the same candidate, exact orchestrator commit, and configured rollback predecessor. A stale `OMP_STABLE_PREVIOUS_TAG` or mismatched `--previous-tag` is refused before effects; remove the override and rerun the documented command to resume cleanup and qualification. Before Debian dispatch, the command persists a UUID, supplies it as the workflow run name, and discovers the resulting run through the Actions API. An accepted dispatch that is not yet discoverable fails closed rather than creating a duplicate billed run. Before renewed Mac effects, the command reopens the durable cleanup lane so a later process can recover after a crash. Persisted failures are generic markers; diagnostic subprocess errors stay only in the active process output.

A resumed relay pass must contain the existing live summary covering at least the requested
duration, with coherent elapsed time and timestamps inside its recorded attempt and campaign.
Missing, shorter, or stale proof fails overall qualification before admission or dispatch; it does
not automatically rerun the relay lane. Recorded pending Mac cleanup still runs, while completed
cleanup remains completed. A historical 60-second pass cannot satisfy this campaign.

Qualification and published-byte smoke take one cross-process release-host lease before reading
or replacing receipts, admission, dispatch, installation, or device effects. All campaigns must
run under the same release account on the same host, using its local home filesystem. The fixed
`~/.local/state/omp-session-gateway/release-host/lease.sqlite` is shared across tags, receipt
directories, and checkouts; changing `OMP_STABLE_QUALIFICATION_DIR` cannot bypass exclusion.
The existing in-process Pixel lease still orders lanes within the admitted campaign. Preflight
and smoke `--plan` remain read-only and do not claim the lease.

SQLite EXCLUSIVE locking retains an OS lock across the committed ownership record and all
effects/cleanup. Each contended SQLite operation waits at most one second, then refuses, even
for the same campaign. This acquisition wait is not a lease expiry. No timeout, PID
probe, or lease age can steal a live lock. On process death the OS releases it, but the committed
owner remains: rerun the exact qualification tag and receipt directory (or smoke repository/tag)
to resume recovery. A different campaign is refused until the original command succeeds. A
caught failure also retains ownership, including admission failures; correct the cause and rerun
that command. This does not clean up orphaned child processes or remote resources by itself:
inspect the existing receipt and recover its recorded resources before resuming after a crash,
following the lane-specific recovery procedures.

Never delete, rename, or replace the lease database to unlock a campaign: that can create two
live lock inodes. If the original command cannot recover, a maintainer must stop every launcher
and child, reconcile the recorded host/device/cloud effects, and clear the campaign row through
an exclusive SQLite transaction, not by unlinking the file. Drain older unguarded scripts before
deploying this guard. It is cooperative exclusion for this release account, not a distributed
lease or a fence against other users, manual adb/SSH, or standalone development qualification
commands; those still must not overlap a release campaign.

If a persisted Debian dispatch UUID is not discoverable, do not start a second process or delete the receipt blindly. Search Actions for the exact `Stable qualification <uuid>` title and orchestrator commit. Resume when that run appears. Only after API evidence proves no matching run exists and every Mac-related lane has zero attempts may the operator archive the entire private qualification directory and restart; otherwise recover the recorded Mac cleanup state first. Automatic redispatch is intentionally refused because an accepted-but-delayed workflow cannot be distinguished safely from a rejected request.

Mac qualification receives the archive SHA-256 already verified by the orchestrator and rejects
different bytes. The workstation verifies and stages rollback assets, including their Sigstore
bundles, so the retained Mac needs no GitHub credential. Mainline source and toolchain pins come
from `UPSTREAM.lock.json`; the OMP pin uses `sourceTree`, not a patched-tree assertion, and cleanup
counts `liveOmpHosts`. Fork-era receipt fields remain historical and must not be relabeled as new
mainline output.

Prerequisites are `gh`, `cosign`, `adb`, the repository workflow secrets, one attached Pixel, and an explicitly configured Mac SSH target. Configure it before admission or a campaign:

```sh
export OMP_STABLE_MAC_HOST=gwqual@mac.example.ts.net  # replace with the qualification host
export OMP_STABLE_MAC_MODEL=Mac17,14
unset OMP_STABLE_MAC_SUDO_PASSWORD_FILE
# OMP_STABLE_MAC_LOGIN remains alphastorm@github unless explicitly overridden.
```

`OMP_STABLE_MAC_HOST` must be `user@host` with a DNS name or IPv4 address, not SSH options,
a port, or shell syntax. `OMP_STABLE_MAC_MODEL` is the exact expected `sysctl -n hw.model`
identifier; admission and lifecycle evidence reject a different model. The receipt keeps schema 3
and records the measured model and macOS version, without pinning the old host's OS or build.
This target configuration is not qualification evidence for Mac17,14 or macOS 27.
For the proposed Virtualization.framework target (ADR-033), replace the model with the guest's measured `hw.model`, not the physical host's; retain the old target for any outstanding cleanup.

The SSH account may be standard or administrator and must log in automatically after a reboot:
the persistence lane measures its per-user LaunchAgent returning at **console login**, not boot
without a login. A pass requires a changed `kern.bootsessionuuid` (stable within one boot), the
qualification account's `gui/<uid>` Aqua login domain after SSH returns, a recovered gateway
listener and successful doctor, and an unchanged full SHA-256 readiness-token digest. The
non-identifying `guest reboot changed`, `console login`, and `readiness token preserved` verdicts
must all be `yes` and are recorded as booleans in the schema-3 Mac evidence.
On a bare-metal automatic-login host, FileVault must be off. The account needs
Bun 1.4.0 in `~/.bun/bin`, **stock OMP >=18.1.20 on PATH**, the lane's command-line tools, and a
user-owned TUN-mode Tailscale node. Doctor checks OMP compatibility during install, before the
`omp-build` lane creates its separate pinned fixture. Install the stock coding-agent package as
the qualification account, using `packageVersions["@oh-my-pi/pi-coding-agent"]` from
`UPSTREAM.lock.json`; both preflights print the exact `bun add --global --exact` command when
OMP is missing or unsupported, and refuse before staging or running any lane.

Remote commands use the fixed PATH
`/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin`: system and
admin-owned tools precede account-writable directories, and hardware probes call
`/usr/sbin/sysctl` directly. Qualification does not provision these prerequisites or make the
account an administrator. The rollback lane selects its staged Cosign by explicit executable
path rather than putting `~/qual-tools` ahead of system tools.

On a shared host, the qualification account may provide the optional, host-owned
`$HOME/.config/omp-qualification/reboot-guard`. It must be a regular file with its owner's
execute bit set and executable by that account. Both preflights run it without arguments on
the same fixed remote PATH, before lane effects; persistence runs it again immediately before
`shutdown -r now`. A missing guard leaves the existing commands unchanged. A present but
invalid guard refuses preflight and names its exact path.

The guard must be a read-only, prompt check of the host's own workload state: exit zero only
when reboot is safe, or exit nonzero with a diagnostic explaining why it is not. Refusal reports
`the host's reboot guard refused: <output>` using the first 400 bytes of combined stdout/stderr;
no shutdown is invoked. Do not put credentials in diagnostics. Qualification does not install
the guard, know which other workloads run, wait for them, or reserve the host after a successful
check. The host owner must coordinate workload starts to avoid a race after that check.

With no `OMP_STABLE_MAC_SUDO_PASSWORD_FILE`, the orchestrator passes an empty
`OMP_MAC_SUDO_PW` and the shell uses `sudo -n`. Narrow passwordless sudo must permit the
lane's exact commands: `true`, Tailscale `status --json`, `set --operator=<SSH account>`,
`cert --cert-file <home>/omp-qual.crt --key-file <home>/omp-qual.key <tailnet DNS name>`
(the SSH account's home, never world-writable `/tmp`), and `shutdown -r now`. The lane runs
`/usr/local/bin/tailscale` when that root-owned copy exists and falls back to PATH otherwise, so
the grant can name a path no non-root account can rewrite. Tailscale Serve and cleanup run as
the Tailscale operator without sudo.
For a password-requiring host, set `OMP_STABLE_MAC_SUDO_PASSWORD_FILE` to a current-user-owned
regular file with no group/other permissions (for example mode 0600); symlinks are refused.
The file contains one nonempty password line, with an optional final newline. Its contents never
enter argv or receipts and reach remote sudo only through the existing SSH-stdin framing.
The former `omp-macqual-01` remains selectable using its actual `user@host`, `Mac14,3`,
and that private password file; no cloud-provider lookup or credential is used for a Mac.
Keep the same host/model configuration for the entire campaign, including resumed cleanup.
Before the first Mac effect, the private schema-3 receipt persists its configured `macHost`.
A resumed campaign refuses a different host before admission or any remote cleanup. Historical
receipts with recorded Mac effects but no bound host cannot authorize automated cleanup: manually
clean the original Mac's gateway, Tailscale Serve, OMP fixtures, and qualification artifacts using
the original campaign checkout before starting a new campaign directory. A receipt with no Mac
effects may still start unbound; a hardware-model admission refusal never creates cleanup work
on an unowned host.

The Windows lane also needs a mode-private `~/.vultr-apikey` whose API access control admits the operator's current egress `/32`, the tagged Tailscale join key and API key in the private qualification files, and the controller tools pinned in `scripts/windows-qualification-pins.json` ([WINDOWS_QUALIFICATION.md](WINDOWS_QUALIFICATION.md)). Background Push needs Do Not Disturb off on the Pixel, no hotspot, USB or Bluetooth tethering from it (the controller must not depend on the Pixel for its network), and the OMP Sessions app installed, with notification permission granted, for the retained Mac's origin, as one-time equipment ([ANDROID.md](ANDROID.md)). The device-cloud lane needs Java for the TestingBot tunnel (`/opt/homebrew/opt/openjdk@17/bin/java`, or `OMP_STABLE_JAVA`) and the read-only 1Password service-account token at `~/.local/state/alpha-founder/retained-host/op-service-account.token` (mode `0600`, or `OMP_STABLE_OP_TOKEN_FILE`), which must be able to read `op://Centaur/TestingBot/key` and `op://Centaur/TestingBot/secret`; the tunnel jar is downloaded once into `~/.cache/omp-session-gateway/testingbot/` and verified against its pinned SHA-256 before every use. Environment overrides are prefixed `OMP_STABLE_`. The rollback predecessor comes from `STABLE_RELEASE.lock.json`; `--previous-tag` and `OMP_STABLE_PREVIOUS_TAG` may only restate it.

The orchestrator refuses a dirty or unpublished branch, rejects changed candidate or receipt identity, and hash-guards `STABLE_RELEASE.lock.json` plus `docs/RELEASE_STATUS.md`. It never edits either file, creates a stable tag, or publishes a stable release. Ledger approval and stable publication remain separate maintainer effects after the receipt is reviewed.

### BrowserStack device-cloud fallback

The fixed policy is TestingBot-only iPhone (including Home Screen/background Web Push), and
TestingBot-first iPad Safari/Samsung Chrome with immediate BrowserStack selection only when the
eligible TestingBot free pool is empty. There is no fallback after a primary write or failure and
no parallel device execution. A catalog is not a reservation. Each target's evidence names its
actual vendor, exact allocated model, device-reported OS/browser and tunnel version.

Keep the existing TestingBot token/Java prerequisites. BrowserStack additionally needs the same
read-only service account to read `op://Centaur/BrowserStack/username` and
`op://Centaur/BrowserStack/access-key`, Automate Mobile with five group/team parallels, and Rosetta 2
on Apple Silicon (`arch -x86_64 /usr/bin/true` must succeed). Credentials, entitlement checks and
Local startup are lazy: a wholly TestingBot attempt does not depend on BrowserStack. The fallback
fails admission clearly when required Rosetta/credentials/entitlement are absent. Its maintained
cutoff is **2027-10-20 00:00 UTC**, conservatively derived from the plan's end date; the Plan API
does not report expiry. Renewal requires a reviewed pin update, not an environment bypass.

Use a dedicated BrowserStack team-member key for qualification and rotate it on suspected
exposure. The single-user orchestrator exception in
[Security](SECURITY.md#real-device-cloud-qualification) is mandatory: the lane writes the key only
to a 0600 `local.yml` in an owned 0700 attempt directory and passes the filename, but Local 8.9
re-spawns itself with the key in its child argv. Same-user processes already can read the service
account token. Local stdout/stderr are discarded; a 0600 FIFO supplies only the fixed readiness
marker in memory. Never capture Local debug output with a real key.

#### Sourced contract matrix — observed 2026-10-20

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

#### Recovery and the remaining mixed development journey

Keep the original private progress and exact orchestrator checkout. Cleanup routes each known
session by vendor, ends it, inspects/removes BrowserStack records, verifies absence, closes the
proxy, stops only owned tunnels, and removes config/workspace. The checkpoint is 0600 inside a
0700 directory; never publish it. All declared signed references are checkpointed before DELETE,
including ones initially returning 404, and removed from progress only after verified absence.
A crash-era saved clean flag cannot authorize lingering signed URLs: normal and fresh-process
cleanup both require disappearance within the three-minute absence bound. A delayed artifact is
fetched and scanned if it starts serving content. Exhaustion leaves `recordRemoved` false and
cleanup dirty; retry through `deviceCloudCleanup`, retaining the original progress.
Only a whole JSON string value containing one well-formed absolute HTTP(S) URL is a reference:
one case-insensitive `://`, its hostname exactly once, and no comma; keys are never references.
Any other key/value containing `://` or a pinned artifact/dashboard/documentation hostname fails closed.
Every retained JSON body must pass independent raw/canonical artifact/dashboard hostname censuses whose counts equal
accepted reference occurrences, including duplicates; mismatches are `unaccounted BrowserStack
artifact reference` failures, not permission to guess delimiters or follow nested URLs.
The census additionally checks canonical text percent-decoded to a fixpoint within four passes
(malformed escapes stay literal; excess depth fails closed), requires one decoded `://` per
reference.
The capability-free BrowserStack probes on 2026-10-20 pin `browser_url`, `public_url`, `logs` and
`video_url` to the observed record-bound dashboard paths and exact query grammars, plus
only the three observed time-breakdown components' `optimize_url` documentation links under
`/docs/`, with neither host fetched and documentation excluded from the artifact census.
An unreviewed real URL remains a diagnostic requiring evidence and a reviewed pin update, never
runtime loosening; fixed audit/parser causes are available in memory while progress/receipts stay generic.
A pre-build/pre-finalization reference persists an `unbound retained reference` incident and fails
closed immediately, with no volatile pending list; later clean metadata permits deletion and
absence checks but neither normal nor fresh crash cleanup clears the incident or authorizes restoration.
A new artifact object (origin plus pathname) first declared after auditing, even in the pre-DELETE GET, atomically
checkpoints its inventory plus a `post-audit retained reference` incident and receives only
deletion/absence verification rather than late auditing, including after a crash; keys also use
value media classification and any `data:`/media-pattern key fails closed.
Recovery normalizes old signature inventories to the last URL per origin/path identity without
clearing incidents, ignores boolean/text capability-flag echoes as media, and reports only closed
installed-shell codes and an explicit removed-under-incident status when deletion succeeds.
Every BrowserStack record-audit failure persists an incident through deletion and crash recovery,
nested media containers and long raw image-signature runs remain media despite ignored capability
echoes, queried artifacts require all six reviewed `X-Amz-*` keys exactly once with only
`response-content-type` optional, and conflicting WebDriver session ids fail regardless of capabilities shape.
Any finalized `video_url` outside the mandatory pinned session-bound dashboard presentation is
an incident, and text logs also inspect unquoted/single-quoted media keys and `=` assignments
without mistaking quoted placeholder brackets for retained containers.
A running-session media hit survives clean finalization and still blocks restoration after
verified deletion, and every non-media-labelled retained body is byte-signature checked under the
same bound before decoding/text scanning while declared image/video bodies remain unread media hits.
A retained body declaring any charset other than UTF-8/US-ASCII, repeating its charset parameter,
or decoding with a NUL is an unreviewed text encoding: an incident that still deletes the record
but never restores.
Post-audit validation/schema/census errors atomically checkpoint a `post-audit unvalidated record`
incident with safely recoverable pinned-origin whole-value URLs from strict JSON and still proceed
through DELETE and bounded record/log/artifact absence checks, never heuristic recovery of malformed
JSON or restoration approval; a checkpoint-write failure still stops effects.
When inventory is missing, first verify record/all-six-log absence before reporting it unavailable;
XML/text artifact 404 bodies and the reviewed media-403 denial are raw-scanned and hostname-censused
as absence evidence without forcing JSON unless their Content-Type declares it.
The `audited`, `recordDeleted`, and `recordRemoved` milestones are monotonic. A retry after API
deletion keeps its earlier audit; a 404 does not invent an unaudited deletion. Response bodies
from every retained surface, before or after the audit and whatever their HTTP status, are scanned
before rejection: raw first, then strict canonical JSON and reference discovery for declared JSON.
This includes rejected DELETE bodies, signed-artifact errors and transient 5xx bodies before a GET
retry, as well as responses received while waiting for API absence. A capability hit persists an
incident before the original status/format error is thrown or the retry proceeds. Image/video
bodies stay unread and report media; plan/catalog/Local-download transport bodies are not retained
surfaces.
Fresh cleanup re-audits finalized raw surfaces against the live links only if the persisted live
and fixture generation identities still match. Otherwise it still deletes for confidentiality,
reports `unauditedRecordsDeleted`, and never calls those records audited. A detected link/media
hit or unverifiable required surface persists an incident even after deletion; stop and handle
that incident rather than clearing progress or authorizing another campaign.
If Local termination is unverified, cleanup removes its key config but preserves the working
directory and private PID/birth checkpoint needed to identify remaining processes; it does not
claim restoration. Discovery uses process ancestry and canonical executable/cwd, never argv names.
Cleanup keeps both the fixture and workspace while any record or tunnel release remains unverified;
it also keeps the workspace after fixture-stop failure. Local download/directory preparation occurs
before tunnel intent is checkpointed. A missing never-created directory is safely idempotent only
when process enumeration proves no matching executable lineage; otherwise cleanup stays dirty.
An unidentified create stays dirty; reconcile that attempt's exact vendor/build in the account
before any new attempt, never guess an ID, discard progress or retry creation blindly. Failure to
restore any resource/checkpoint sets `pixelUnrestored` and blocks later Pixel lanes.

After the lead confirms no campaign, Pixel operation or retained-Mac use overlaps, select the
verified Bun 1.4.0 binary on `PATH` (not a newer workstation Bun), then run:

```sh
bun scripts/device-cloud-development.ts \
  --identity "${DEVICE_CLOUD_IDENTITY:?private isolated identity JSON required}" \
  --mac-host "${OMP_STABLE_MAC_HOST:?qualification user@host required}" \
  --origin "${DEVICE_CLOUD_ORIGIN:?deployed candidate HTTPS origin required}" \
  --session-label "${DEVICE_CLOUD_SESSION_LABEL:?isolated live OMP label required}" \
  --mixed-vendors
```

The identity must bind the verified candidate archive/digest, exact stock-OMP identity and a
fresh private `receiptRoot` containing `device-cloud-development`; the live candidate gateway,
isolated published OMP session, SSH fixture tools, both vendor accounts, Java, Rosetta and the
single-user workstation boundary must already be ready. Bounds: one attempt, at most three
sequential sessions (TestingBot iPhone with Home Screen Push; BrowserStack iPad and Samsung),
no session-creation retries, and no new allocations after 40 minutes. In-flight provider-command
and session bounds still apply; 40 minutes is not a wall-clock kill deadline. Production audits
and release run on failure too. Results are private **Tested** evidence, never qualification.
This command has not been run by the public-page probe work.

## Post-release local installation smoke

From the matching release tooling checkout, run
`bun run smoke:release -- --tag "$TAG" --archive-sha256 "$ARCHIVE_SHA256"` with the exact verified
public digest. The runtime archive does not contain this maintainer script. Use the release’s
Bun/source pins and stock OMP `>= 18.1.20`; require readiness-token/config preservation, mainline
discovery and launch/revocation, physical Android recovery/isolation, and owned-fixture cleanup.
Signed-candidate qualification and prior release smokes do not substitute for a published-byte run.

The smoke host is now the Studio operator account, with the gateway at the Studio's own tailnet
origin and the Pixel attached to the Studio. That account must be tailscaled's operator. The smoke
is an upgrade smoke and requires an existing installed gateway and Tailscale Serve configuration;
on a fresh host, install the published predecessor first. The smoke installs Bun's global stock
OMP itself; no separate manual stock-OMP installation is required.

Every release's published-byte result, including any failed first attempt, is recorded in the
[release ledger](RELEASE_STATUS.md) with its source, digest, preservation, physical-client, and
cleanup evidence.

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
check preserves that page instead of requiring the directory title. Target
eligibility is checked before touching the device; protected, soak, old, missing, ambiguous, or
non-Control fixtures fail closed.

Normal success and failure kill only that tmux session, wait for registry revocation, remove the
fixture only when its per-run ownership marker still matches, and delete private staging. The stable
gateway, config/token, Bun runtime, mainline OMP, Serve configuration, and WebAPK remain installed.
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

## Default-relay soak qualification

This optional long-duration lane is not a mainline release gate; each release has used a
founder-approved fresh 30-minute signed-candidate check instead. Only an actual eight-hour run may
be reported as eight-hour evidence.

Keep a stock mainline OMP `>= 18.1.20` host and the gateway running, then exercise a view-only client for the default
eight hours:

```sh
OMP_GATEWAY_SOAK_PUBLIC_ORIGIN=https://gateway.example.ts.net \
OMP_GATEWAY_SOAK_TAILSCALE_LOGIN=user@example.com \
OMP_GATEWAY_SOAK_GATEWAY_PID="$(launchctl print "gui/$(id -u)/omp-session-gateway" | awk '$1 == "pid" && $2 == "=" {print $3; exit}')" \
bun run qualify:relay-soak
```

The harness sends identity headers and receives the launch capability only through a numeric loopback
gateway origin, requires `no-store` metadata and launch responses, never prints the capability, and
fails if the collaboration client ends or is not live at completion. Set
`OMP_GATEWAY_SOAK_INSTANCE_ID` to select one published session. `OMP_GATEWAY_SOAK_SECONDS` may shorten
a diagnostic run to at least one second, but only the default 28,800-second duration qualifies the
long-lived relay scenario.

The harness also measures the gateway process named by `OMP_GATEWAY_SOAK_GATEWAY_PID`: take it from
the service manager, as above on macOS, or with
`systemctl --user show --property MainPID --value omp-session-gateway` on Linux. It never infers the
process from the listening port, because a loopback origin may be a tunnel whose listener is not the
gateway, such as the stable lane's SSH forward. With a PID, it fails before launching if that process
cannot be sampled. Inside the window it reads the process's resident memory and CPU time when the
relay goes live, about every 60 seconds, and at completion, and it fails if the gateway process exits.
The output JSON adds a `gateway` summary: sample count, start/end/min/max RSS in KiB, the
least-squares RSS trend in KiB per hour, and CPU seconds inside the window. Without a PID it takes no
gateway measurement and adds no `gateway` summary. Set `OMP_GATEWAY_SOAK_SAMPLES` to an absolute path,
which requires a PID, to append every sample to a new CSV (`elapsed_s,rss_kib,cpu_s`) as it is taken;
the harness refuses an existing file.

Record the gateway commit, exact mainline OMP commit, output JSON, host/browser versions, and date in
`RELEASE_STATUS.md`. Bounded memory growth may be claimed only from an actual eight-hour run's
samples, never from a shorter diagnostic. Eight-hour endurance is **not rerun or claimed** by any
mainline release. A passed 30-minute candidate check does not establish bounded memory growth; no
fork-era long-window result transfers to the changed host/query/client baseline.

## Fleet CI runtime

Fleet CI is optional shadow verification, not a substitute for required GitHub-hosted checks or
release qualification. Each job installs and verifies the `packageManager` Bun version; the
shared appliance image is not the repository runtime contract. `bun run check:repository` rejects
jobs that skip runtime setup on self-hosted runners or select a different Bun version.

The fleet controller pins the complete workflow digest. After an intentional workflow change,
review and update that profile binding without rewriting historical qualification evidence.
A successful controller dry-run does not prove host readiness; validate the configured appliance
and run a bounded shadow against the exact clean, pushed checkpoint. Do not bypass workload guards
or replace the shared runner image merely to satisfy this repository's Bun pin.

## Build and keyless provenance

The release workflow accepts only tags matching the current package.json version:

- v<version>-prealpha.<n> for an internal engineering artifact;
- v<version>-alpha[.<n>] for the advertised alpha shape;
- v<version>-beta[.<n>] for the advertised beta shape;
- the exact bare v<version> for the stable GitHub Latest shape; and
- provenance-test-v<version>.<n> for a provenance exercise.

The integer n must be positive. Release-candidate, rc, stable-suffixed, zero-indexed, cross-version,
and all unknown shapes fail before artifact creation. The tagged commit must be reachable from main.

scripts/release-policy.ts is the sole tag classifier. It maps only the bare version to stable,
non-prerelease, and Latest; alpha, beta, pre-alpha, and provenance shapes remain prereleases and
not-Latest. The validated channel selects release-info.json qualification; it cannot author or
widen the claim, and every unknown OMP_RELEASE_CHANNEL fails the build.

.github/workflows/signed-release.yml runs bun run check, builds the deterministic archive,
checks its SHA-256 digest, and then uses GitHub Actions OIDC for both provenance systems:

- `actions/attest-build-provenance` publishes GitHub build attestations for the archive,
  deterministic SPDX 2.3 SBOM, and `SHA256SUMS`;
- Cosign signs all three files keylessly and writes a Sigstore bundle beside each one; and
- no repository signing key or long-lived signing secret exists.

The workflow creates one complete draft, uploads every asset, then publishes once. Stable is published as a non-prerelease and explicitly marked Latest; every other channel is published as a prerelease with Latest disabled:

- `omp-session-gateway-<version>-bun.tar`;
- `omp-session-gateway-<version>.spdx.json`;
- `SHA256SUMS`;
- `omp-session-gateway-<version>-bun.tar.sigstore.json`;
- `omp-session-gateway-<version>.spdx.json.sigstore.json`; and
- `SHA256SUMS.sigstore.json`.

The repository's **Settings → General → Features → Immutable releases** setting is
enabled and required before tagging. A maintainer can confirm it without using a signing
secret:

```sh
gh api repos/carrythroughsystems/omp-session-gateway/immutable-releases --jq .enabled
```

It must print `true`. GitHub applies a 24-hour grace period after publication before
locking the release, assets, and tag and issuing the immutable-release attestation. Treat
the release as final at publication; publish a new tag to correct it.

Run `bun run check` and `bun run release:build` for a local unsigned build. The builder
emits `dist/release/omp-session-gateway-<package-version>-bun.tar`, a deterministic SPDX 2.3 dependency
inventory, and `SHA256SUMS`; the archive also contains `SBOM.spdx.json` and no source maps.
For a byte-exact rebuild of an advertised tag, set OMP_RELEASE_CHANNEL to that tag's channel. Valid
values are pre-alpha (default), alpha, beta, and stable; every other value fails. The channel moves
release-info.json and nothing else: every other archive member and the SBOM stay byte-identical
across channels. This runtime-neutral Bun archive is not a substitute for qualified host operation.

Do not upload source maps, logs, test recordings, or diagnostics that might contain
fixture capabilities unless the leak scanner has verified them.

## Verify a published build

Install current GitHub CLI and Cosign releases, choose the tag, and download into an empty
directory:

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

Without a tag, `gh release view` resolves the current GitHub Latest release, which is always the
qualified stable. To verify a historical artifact, set `TAG` to it and use its matching signing
workflow: for example, `v0.1.0-beta.1` used `release.yml`, not `signed-release.yml`. Do not
substitute today’s workflow identity for a historical receipt. Repository downloads use the new
owner, but signed certificates and attestation source repositories never change on transfer.
The closed historical tag list above selects the old signing identity only for releases already
published when this cutover was prepared; every other tag requires the new owner. Do not add
future tags to that list or replace exact workflow/tag/issuer pins with a wildcard.
Asset names carry the package version, not the tag: a candidate tagged `vX.Y.Z-prealpha.N`
downloads `omp-session-gateway-X.Y.Z-bun.tar`, so the names are read from the fresh directory.

Verify the immutable release attestation and every release asset. A failure means the release is not yet immutable or the downloaded asset is
not part of the attested release:

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

Verify the archive checksum (`shasum -a 256 -c SHA256SUMS` is the macOS equivalent):

```sh
sha256sum --check SHA256SUMS
```

On Windows, in PowerShell (prints `True`):

```powershell
$archive = Get-Item omp-session-gateway-*-bun.tar
(Get-FileHash $archive -Algorithm SHA256).Hash -eq (Select-String -Path SHA256SUMS -SimpleMatch $archive.Name).Line.Split(' ')[0]
```

Verify GitHub build provenance against the exact repository, workflow, and tag ref:

```sh
for artifact in "$ARCHIVE" "$SBOM" SHA256SUMS
do
  gh attestation verify "$artifact" \
    --repo "$SIGNING_REPO" \
    --signer-workflow "$SIGNING_REPO/.github/workflows/$WORKFLOW" \
    --source-ref "refs/tags/$TAG"
done
```

Verify the independent Sigstore bundles against the GitHub Actions OIDC issuer and exact
workflow-ref certificate identity:

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

Successful checksum, build-attestation, Cosign, and immutable-release checks establish
integrity and origin. They do not by themselves establish host/client compatibility or complete
the release qualification gates above. Continue with the
[verified-archive installation steps](OPERATIONS.md#2-cli-and-daemon-installation).

## Versioning

Use Semantic Versioning:

- breaking configuration/protocol/security behavior increments the appropriate version;
- pre-1.0 minor versions may contain breaking changes but must state them prominently;
- protocol versions are explicit and not inferred solely from package versions.

## Release notes

Every release note should include:

- status (experimental/alpha/beta/stable);
- compatible OMP versions/commits;
- security-relevant changes;
- user-visible changes;
- configuration or migration steps;
- known issues and rollback instructions; and
- acknowledgements without exposing reporter-sensitive details.
