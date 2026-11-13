# BrowserStack: synthetic visual review

This runbook tells release maintainers how to run and maintain synthetic Percy visual review, enforce the BrowserStack Live boundary, look up the Automate fallback rules, and renew BrowserStack's open-source sponsorship for OMP Session Gateway, the companion to Oh My Pi (OMP).

BrowserStack's open-source sponsorship supplies the products below until **2027-10-20** (`2027-10-20T00:00:00Z` in `scripts/browserstack-pins.json`). Percy is advisory visual review of authored synthetic fixtures, not functional browser testing or signed-release device qualification ([ADR-035](DECISIONS.md#adr-035--advisory-percy-review-of-capability-free-serialized-fixtures), [Current claim](COMPATIBILITY.md#current-claim)).

| Product | Entitlement | Repository role |
| --- | --- | --- |
| Percy Professional | Project-configured renderers and snapshot quota | Advisory visual review of synthetic DOM and first-party assets |
| Automate Mobile | Five parallel real-device mobile-browser sessions over WebDriver | Empty-pool fallback vendor for cloud-device qualification ([Automate](#automate)) |
| Live Desktop & Mobile | One user, manual | Exploratory review of capability-free synthetic fixtures only |

## Percy scope

`bun run test:visual` builds the **OMP Sessions** dashboard and pinned collaboration client, then validates seven states at each of three Chromium source viewports. These are CSS viewport sizes, not emulated or qualified devices; 810×1080 matches a ninth-generation iPad CSS viewport without claiming execution on an iPad.

| Source project | CSS viewport |
| --- | --- |
| `visual-phone-390x844` | 390×844 |
| `visual-tablet-810x1080` | 810×1080 |
| `visual-desktop-1280x800` | 1280×800 |

The seven states are `directory-empty`, `directory-all-clear`, `directory-needs-you`, `directory-partial-coverage`, `settings-enabled-session`, `collab-view`, and `collab-control-ask`. Each snapshot is named `state / project` (**21 distinct snapshots**), serialized at its source width with fixed clock and randomness, locale `en-US`, time zone `UTC`, dark theme, reduced motion on, and device pixel ratio `1`.

Test-only styles disable CSS animation and transition replay; any active animation fails the lane.

Directory requests contain metadata only, and collaboration prose and code are authored synthetic content (`apps/web/e2e/synthetic-product-fixture.ts`) rather than recorded conversations. That shared deterministic fixture preserves [README media](media/README.md) capture defaults without regenerating media.

Source and script-disabled serialized geometry must match, including the 560 px directory column and 900 px desktop **View** transcript with the header aligned to the session column. `collab-control-ask` preserves the embedded client's 880 px bounded body and checks exact geometry parity rather than imposing a 900 px inner transcript.

## Percy data flow

The advisory visual lane runs outside the shipped gateway runtime:

```text
built dashboard + pinned client -> loopback synthetic fixture + in-page relay stub -> Chromium at each source viewport -> installed @percy/dom serialization -> exact-material/capability/identifier guards -> Percy SDK -> host-restricted, JavaScript-disabled discovery -> advisory visual build
```

No live OMP process, real transcript, production gateway, capability canary, or third-party runtime asset enters this pipeline (a **View** or **Control** link is a bearer secret, called a capability in the contracts).

- Local validation (`bun run test:visual`) checks all 21 `state / project` snapshots and source-to-serialized geometry without starting Percy or reading credentials.
- Serialization: `@percy/dom` builds preflight HTML and first-party resources with the exact `percySnapshot` options, and upload mode rechecks every payload immediately before the SDK `POST`.
- Leak guards: synthetic authority stays in source-context closure memory; `DashboardFixture` rejects full synthetic capabilities, room IDs, keys, 16-character segments, and escaped forms, and both capability and identifier scanners inspect HTML, resource strings, and decoded resource bytes, failing closed rather than redacting.
- Asset discovery and responsive flags: asset discovery runs in Playwright's installed Chromium restricted to the loopback fixture host with JavaScript, responsive recapture, and responsive-asset discovery disabled. `PERCY_DO_NOT_CAPTURE_RESPONSIVE_ASSETS=true` also skips `@percy/cli`'s startup device-details lookup in both the testing host and live CLI.
- Native-Node preflight audit: before starting the live Percy CLI, upload mode runs the same 21-case suite under a ten-minute deadline (`5 * HANG_DEADLINE_MS`) against the installed native-Node Percy testing host with real asset discovery, no vendor network calls, and no real token.
- Preflight log audit: a private pipe supplies one shared ephemeral synthetic authority (never exposed on `DashboardFixture`, `argv`, environment variables, output, or files); after all 21 submissions, the fixture guard and both scanners audit the redacted `clilogs` candidate (non-`ci` logger records and metadata) and require a planted SDK-log canary to fail, emitting only `visual-audit: states=21 logs=passed planted=rejected`.
- Upload finalization and logs: upload mode requires a healthy Percy server, all 21 submissions, and build finalization, never falling back to local mode.
- Retained artifacts: Percy redacts and uploads **CLI logs with every build** (disabling client error-log collection suppresses **CI logs only**, not CLI logs), while no local Percy capture output, trace, screenshot, video, or raw SDK diagnostic enters CI artifacts ([Percy visual upload boundary and Live](SECURITY.md#percy-visual-upload-boundary-and-live)).

## Set up the Percy project

Prerequisites: install Bun `1.4.4`, run `bun install --frozen-lockfile`, and run `bunx playwright install chromium` (`scripts/test-visual.ts` passes `--no-install` to Playwright in both local and upload modes).

Upload mode also requires native **Node.js 24.22.0 LTS** on `PATH` (or via `OMP_VISUAL_NODE_EXECUTABLE`); only `@percy/cli` runs under Node while builds, workers, and local validation run on Bun. CI pins `actions/setup-node` by commit, verifies exactly 24.22.0, and passes `OMP_VISUAL_NODE_EXECUTABLE` to the runner; local uploads resolve native `node` from `PATH` and fail on absence with `reason=node-missing` and `visual upload: Node.js is required for Percy`.

Never launch Percy with Bun (its HTTP API can appear started without answering health requests, creating a zero-snapshot build). `scripts/test-visual.ts` sets `PERCY_DROPIN_DISABLE=true` automatically so committed screenshots never seed or auto-approve baselines.

1. Create a dedicated **web** Percy project for these synthetic fixtures connected to this repository; never share a project or token with production captures or real sessions.
2. Choose renderers in Percy project settings (recommended: **Chrome, Firefox, Safari, and Edge**, plus **Safari on iPhone** and **Chrome on Android** if quota allows), and confirm the billing multiplier for 21 snapshots; renderer availability and quota are account settings, not repository facts.
3. Keep JavaScript rendering disabled in Percy project settings, review access and retention, and record the project, renderers, quota, project owner, baseline approver, and sponsorship-renewal owner in maintainer-private operational notes; never record `PERCY_TOKEN` in this repository.
4. Store the project token as the GitHub Actions repository secret `PERCY_TOKEN` (exposed only to the eligible upload step, never in command arguments, artifacts, or local files).
5. Run `bun run test:visual` locally without a token, confirm `bun run test:visual:percy` without `PERCY_TOKEN` fails with `visual upload: PERCY_TOKEN is required`, and then supply `PERCY_TOKEN` in the process environment to verify a real upload (unhealthy servers, SDK warnings, skipped or incomplete submissions, or failed finalization also fail).
6. Establish the baseline from `main` and confirm all 21 names, widths, commit metadata, renderers, and resources; then apply a temporary CSS change on a disposable branch, confirm a reviewable Percy diff, and discard the branch.
7. Exercise a same-repository pull request, a fork pull request, and a controller-driven `gateway-ci` dispatch to confirm that forks and fleet dispatches receive no token and report **not uploaded**.

In CI, `visual-review` runs on fixed `ubuntu-24.04`, never on `gateway-ci` fleet runners. Local validation (`bun run test:visual`) runs on every invocation without a token and fails the job on error.

`Upload guarded Percy snapshots` (`bun run test:visual:percy`) runs on same-repository `pull_request`, `main` push, and GitHub-hosted `workflow_dispatch` with `continue-on-error: true` (no retry and no silent fallback to local mode), while fork pull requests and all `gateway-ci` dispatches run local-only. The lane is **not a required merge check**.

## Review and baseline policy

- Keep both `visual-review` and Percy statuses advisory, separate from functional supporting lanes.
- Maintainers inspect every changed snapshot; do not auto-approve or auto-update baselines.
- Approve only intentional layout or content changes after functional checks pass; an unavailable vendor is a failed advisory upload, not a functional regression or release qualification failure.
- Review capture-tool, serializer, and Chromium bumps together with new baselines; `@percy/cli`, `@percy/playwright`, and `@playwright/test` are exact `devDependencies` pins excluded from Dependabot, and runtime output stays first-party.
- Claim no real Percy build or deliberate visual-diff proof until observed in the configured project; no supported or qualified platform follows from a Percy render.

### Diagnose a failed upload

The runner forwards only closed-set `state`, `project`, `phase`, and `reason` codes plus bounded validation and submission counts across both child-process layers (written in CI to `GITHUB_STEP_SUMMARY` and the seven-day `visual-diagnostics-<run_id>-<run_attempt>` artifact under `test-results/visual-diagnostics/`), never printing raw Percy or browser text.

Select the failing boundary from the reported phase without enabling raw logs, traces, screenshots, or vendor error-log collection:

- `phase=server`: malformed addresses, unreachable API, invalid HTTP/JSON/type, or missing build identity.
- `phase=playwright`: child-worker submission count or summary failures before build finalization.
- `phase=submit`: SDK offline, warning, error, missing submission, guard rejection, or server rejection.
- `phase=percy`: child exit, CLI diagnostics, incomplete snapshot counts, or missing build finalization.
- CLI diagnostic categories: every stdout and stderr line is classified against pinned package patterns (baseline, config, discovery, SDK update, log upload, layout mode, lockfile, proxy, Node, HTTP/network, or serialization), and any unknown line fails as `cli-unknown-diagnostic`.
- `cli-runtime-notice`: the sole nonfatal diagnostic, matching the exact unconditional `bin/run.cjs` notice in `@percy/cli` `1.32.12` about the next major version requiring Node 20+ (which the exact major pin and native Node 24.22.0 satisfy); any changed or extra line and every SDK warning fail.

## Live rule

BrowserStack Live is manual, one-user exploratory review of **capability-free synthetic fixtures only**. Never connect Live to a production gateway, real OMP process, tailnet service, or any fixture that can acquire synthetic **View** or **Control** canaries. The repository supplies no Live launcher or tunnel, local fixture availability never authorizes forwarding a gateway, and manual Live observations are neither CI nor qualification evidence.

## Automate

BrowserStack Automate Mobile is the `deviceCloud` fallback vendor when TestingBot's eligible free device pool is empty, running real-device iPad Safari and Samsung Android Chrome qualification targets sequentially (never in parallel, and never for iPhone) under [ADR-032](DECISIONS.md#adr-032--qualify-iphone-ipad-and-android-browsers-on-real-cloud-devices-in-every-stable-campaign).

Tunnel isolation, credential handling, and retained-record leak and media audits are defined in [Real-device cloud qualification](SECURITY.md#real-device-cloud-qualification), campaign fallback rules are in [BrowserStack device-cloud fallback](RELEASE.md#browserstack-device-cloud-fallback), and qualified device status is recorded in [Current claim](COMPATIBILITY.md#current-claim).

## Sponsorship renewal

The sponsorship expires **2027-10-20** (`2027-10-20T00:00:00Z`). Review it on **2027-09-20**: verify entitlement, snapshot quota, upload health, access and retention settings, and renewal ownership.

Renew before expiry and update `entitlement.cutoff` in `scripts/browserstack-pins.json`, or remove `PERCY_TOKEN` and Automate credentials and update `scripts/browserstack-pins.json`, workflow expectations, and the BrowserStack attribution in [README.md](../README.md) together; never leave a green local-only check or stale attribution implying active BrowserStack execution after sponsorship ends.
