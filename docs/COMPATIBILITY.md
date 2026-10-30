# Compatibility and support policy

## Platforms and browsers

Use OMP Session Gateway from a modern browser, and install it as a PWA where the platform supports
web-app installation. The gateway runs on the computer that runs OMP.

<!-- release-generate:platforms:start -->
| Surface | Status | Tested by | Qualified on hardware |
|---|---|---|---|
| Linux host | Supported | `portable-source (ubuntu-24.04)`, `implementation-checks`, `linux-arm64-source-checkout` (aarch64), daily `canary` against stock OMP | Run 40427270819 succeeded (https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/40427270819); OS/kernel versions and migration counts are not exported. |
| macOS host | Supported | `portable-source (macos-latest)` | VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon a9dda5e6640b173279d738c0d13374fcc5daa409d7167ce9ff54ea56bf5afb30. |
| Windows host | Supported | `portable-source (windows-latest)`, `windows-service-lifecycle`, daily `canary-windows` against stock OMP | Windows x86-64 build 26100; 4 CPUs, 8186 MiB; Administrator upgrade/rollback from v0.8.0 and fresh standard-account lifecycle; interactive logon, not unattended boot. |
| Chrome and Chromium | Supported | `browser-core` desktop Chromium; `browser-notifications` full suite at Pixel sizes | Pixel 8 Pro, Android 17, Chrome 155.0.8059.84; BrowserStack, tunnel 8.9: Galaxy S26 (16.0.0, chrome 152.0.7977.54) |
| Edge and other Chromium-based browsers | Supported through Chromium | `browser-core` desktop Chromium; the client has no Edge-specific code path | None |
| Firefox | Supported | `browser-core` desktop Firefox | None |
| Safari and WebKit | Supported | `browser-core` desktop WebKit | TestingBot, tunnel 4.9: iPhone 17 Pro Max (26.6, safari 26.6.1); TestingBot, tunnel 4.9: iPad (9th generation) (26.6, safari 26.6) |
| Android | Supported | `browser-notifications` at measured Pixel sizes | Pixel 8 Pro, Android 17, Chrome 155.0.8059.84; BrowserStack, tunnel 8.9: Galaxy S26 (16.0.0, chrome 152.0.7977.54) |
| iPhone and iPad | Tested as a browser | `browser-core` WebKit with iPhone-class emulation | TestingBot, tunnel 4.9: iPhone 17 Pro Max (26.6, safari 26.6.1); TestingBot, tunnel 4.9: iPad (9th generation) (26.6, safari 26.6) |
<!-- release-generate:platforms:end -->

### What the words mean

**Tested** means a named CI lane runs on hosted runners or browser engines. **Supported** means
every listed lane stays green (on each change, and canaries daily) and bug reports are accepted.
**Qualified** names what a signed release passed on real hardware or named cloud devices in
[Current claim](#current-claim) and the [release ledger](RELEASE_STATUS.md), plus the retained
macOS Virtualization.framework guest under ADR-033; see [Status vocabulary](#status-vocabulary).

Browser **Tested** evidence distinguishes a clean first pass from a flaky retry pass. Both
`browser-notifications` and `browser-core` allow one retry only for `CI=true`/`CI=1`, retain a
sanitized per-attempt JSON report for 14 days, and summarize counts and repository test locations;
local runs have zero retries. Weekly/manual `browser-flake-budget` maintenance enforces at most
1% flaky logical executions per lane/project and no test/project flaky more than twice over seven
days, with missing reporter-enabled browser-job evidence failing coverage. Cancelled jobs and
selective reruns of only sibling jobs owe no new report; outcomes are derived from expected
status and attempts rather than trusted labels. This containment changes no
assertion, deadline, browser project, or physical/signed-candidate qualification claim. Prepare
PRs execute required checks on their own exact checkout, even for a version-only bump; main's
green results cannot be reused. See [browser evidence policy](TEST_PLAN.md#browser-retries-evidence-and-harness-readiness).

- **Installing as a PWA.** Chromium browsers install from the browser menu on desktop and Android.
  Safari installs with Add to Home Screen on iPhone and iPad, and Add to Dock on macOS. Desktop
  Firefox has no web-app install; it works in a tab.
- **Background alerts** (Web Push) are qualified in full on a physical Pixel with Chrome on Android,
  where force-stop and forced Doze outcomes are observed variants rather than guaranteed delivery. On
  iPhone and iPad (iOS and iPadOS 16.4+), Safari offers Web Push to a Home Screen app; a cloud iPhone
  qualifies enabling alerts in the Home Screen app, delivery with the app in the background, and the
  tap into Control, without a lock-screen claim (ADR-032).
- **Browser versions.** The client uses CSS `color-mix()`, `:has()`, and dynamic viewport units, so
  browsers older than Chrome and Edge 111, Firefox 121, and Safari 16.2 render incorrectly.
- **Windows** starts the gateway at interactive logon, not at unattended boot.

- **Terminal environments.** Tern is an execution environment for stock OMP, not a separate gateway
  integration ([ADR-038](DECISIONS.md#adr-038--tern-is-an-execution-environment-not-an-integration)).
  Sessions started inside Tern use the same `collab.autoStart` setting and `~/.omp/run/collab-hosts`
  registry as any other terminal ([Running OMP inside Tern](OMP_INTEGRATION.md#running-omp-inside-tern)),
  and the [Status vocabulary](#status-vocabulary) (**Tested**, **Supported**, **Qualified**,
  **Smoke-tested**) applies without a separate Tern row. Developer-workstation execution inside Tern was
  **smoke-tested on 2026-10-22** (not CI, not release qualification) on macOS (Apple silicon) with Tern
  `0.9.5` (build `2863c37`), stock OMP `18.12.6` (Homebrew install, one patch release above the
  `v18.12.5` engineering host baseline pin), `~/.omp` (`PI_CONFIG_DIR` unset), `~/.omp/run/collab-hosts`,
  `collab.autoStart = control`, and two `dev-localhost` gateways in desktop Chrome: two fresh sessions
  started with `tern new tab --cwd <dir> -- env OMP_SKIP_SETUP=1 omp …` published within ~13 s while
  `OmpHostReader` observed all three Tern-hosted hosts (`access: control`, `relayConnected: true`) and
  ignored ~220 stale publications; the home PWA showed `All hosts` / `Home` / `Remote` with six
  independent rows for the three colliding Tern `instanceId`s, launched home **View** and remote
  **View**/**Control** via `OPTIONS …/launch` `204` + `POST …/launch` `200` with no credentials, echoed
  a synthetic prompt (`401`), routed and answered a real metadata-only ask (`inputRequired: true` →
  `false`), isolated a stopped remote gateway (`Remote: Cannot reach this host from this app.` with
  **Retry** and `Host coverage incomplete — Unavailable: Remote`), and exercised keyboard-dictation help
  plus the opt-in speech flow via an injected fake `SpeechRecognition` constructor (no microphone used).
  Still pending and not exercised: any phone or installed PWA, the HTTPS Tailscale Serve path (identity
  headers and real CORS over Serve), Wi-Fi/cellular transitions, session replacement/reconnect/shutdown
  while inside Tern beyond closing the panes, native browser speech recognition on any device, and Pixel
  or iPhone keyboard dictation; issue
  [#380](https://github.com/carrythroughsystems/omp-session-gateway/issues/380)'s installed-iPhone
  acceptance is therefore not satisfied yet
  ([TEST_PLAN.md](TEST_PLAN.md#g-tern-multi-host-federation-and-speech-input-acceptance-matrix)).
## Current claim

<!-- release-generate:release:start -->
v0.9.0 is qualified for stable promotion; publication is pending. [Release v0.9.0](https://github.com/carrythroughsystems/omp-session-gateway/releases/tag/v0.9.0). Signed candidate v0.9.0-prealpha.7; source b0f07b11e7d4fb2d0afeea7496a77323d6c66d5a; archive SHA-256 d2053558f3ac7dd857db971dcf57757e652e8776de83deb2b9a9138e7457a887. Published v0.8.0 remains the predecessor. Stock OMP v18.12.5 (d5cd750e41fede277f9eb933455da92a0738915e), Bun 1.4.0. All thirteen lanes passed; attempt counts and measured evidence are in the [release ledger](RELEASE_STATUS.md). Stable publication and published-byte smoke are pending.
<!-- release-generate:release:end -->

The current Mac host qualification runs in a Virtualization.framework guest (`VirtualMac2,1`),
which does not exercise bare-metal firmware, FileVault unlock, physical sleep/wake, or startup
before login (ADR-033). The qualified scope includes the Mac-guest new-generation/fork/resume
transitions and Pixel Push triage/stale-tap scenarios recorded in the campaign, not arbitrary
attention or lifecycle behavior on every platform; see [attention acceptance](ATTENTION_SPEC.md)
and [lifecycle coverage](LIFECYCLE_BRANCH_RESUME.md).

Stock mainline OMP `>= 18.1.20` ([PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), commit
`4999b98bd5`) is the minimum supported host version: set `collab.autoStart`
([operator settings](OMP_INTEGRATION.md#1-operator-settings)) and start participating sessions with
plain `omp`. The current engineering baseline is `v18.12.5` (`UPSTREAM.lock.json`) and the
qualified host baseline is recorded in the release-generated matrix below, while the independent
embedded browser client pin is `v18.12.6`.
Under registry v1, the gateway validates only the fields it reads and ignores unknown additive
fields (ADR-028); a registry version bump or a changed type on a consumed field still requires a
gateway update.

v18.12.5 (`d5cd750e41fede277f9eb933455da92a0738915e`) keeps registry v1, the discovery file
format and query contract, the relay protocol, and `collab.autoStart` behavior unchanged from
v18.12.3: every relevant path is byte-identical between the two tags except `package.json`, which
only the version bumps change, and `docs/extensions.md`, where
[can1357/oh-my-pi#16361](https://github.com/can1357/oh-my-pi/pull/16361) documents GitLab MR
references for the extension `ctx.annotations` diff source, which the gateway neither reads nor
sends. v18.12.3 (`53a0377db6845e0dae606146130766ec92d407fd`) in turn kept these contracts
unchanged from v18.10.2: the collaboration host, registry, settings, collaboration slash commands,
`docs/collab.md`, `collab-web` `app.tsx` and `lib/client.ts`, and `packages/wire/src/index.ts`
are byte-identical between those tags.
[can1357/oh-my-pi#15680](https://github.com/can1357/oh-my-pi/pull/15680) adds an optional
`runtime` build identity to session entries, including replicated ones, which the gateway never
reads and the embedded client does not consume;
[can1357/oh-my-pi#15467](https://github.com/can1357/oh-my-pi/pull/15467) changes only a CLI
guest's prompt-cache key; and the remaining changes touch the TUI approval dialog, extension
plan-review hooks, and a `collab-web` eval renderer now included by the independent v18.12.6 client
refresh. That refresh also takes render coalescing, streaming-tail Markdown, linear-time
Markdown/math lexing, and idle agent-drawer polling shutdown. The discovery/query contract is
unchanged; browser source tests and synthetic smoke do not qualify a new signed artifact.
Since v18.10.2, upstream
[`a608a9ca07`](https://github.com/can1357/oh-my-pi/commit/a608a9ca07c9443634e80d877d61c602099dab91)
serves the registry over native IPC with the same one-line JSON request and response, a 0600
socket, overlong paths relocated under the owner-only `/tmp/omp-<euid>`, and same-user peers
only; the gateway reads the published endpoint verbatim, so its queries are unchanged. No canary,
candidate, or qualification is claimed for v18.12.5; the matrix below stays bound to v18.10.2.
As in v18.8.3, upstream
[can1357/oh-my-pi#14714](https://github.com/can1357/oh-my-pi/pull/14714) stops mirroring frames
while no guest is joined, and a generated `sessionName` may carry a title-card prefix
([OMP integration](OMP_INTEGRATION.md#3-polling-and-lifecycle)). From OMP `18.5.1`, an automatic
start whose relay is unreachable or times out is retried
([operator settings](OMP_INTEGRATION.md#1-operator-settings)).

<!-- release-generate:qualification:start -->
| Surface | Current contract | Qualification |
|---|---|---|
| Exact qualified source | v18.12.5, d5cd750e41fede277f9eb933455da92a0738915e; Bun 1.4.0 | Stock OMP; mainline >=18.1.20 required |
| artifacts | Signed candidate v0.9.0-prealpha.7 | Signed tag, checksums, GitHub attestations 3/3 and Sigstore bundles 3/3; v0.8.0 verified the same way. |
| debian | Signed candidate v0.9.0-prealpha.7 | Run 40427270819 succeeded (https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/40427270819); OS/kernel versions and migration counts are not exported. |
| macos | Signed candidate v0.9.0-prealpha.7 | VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon a9dda5e6640b173279d738c0d13374fcc5daa409d7167ce9ff54ea56bf5afb30. |
| ompPublication | Signed candidate v0.9.0-prealpha.7 | Stock OMP v18.12.5; generation 1; publication, View/Control, new-generation/fork/resume and revocation. |
| android | Signed candidate v0.9.0-prealpha.7 | Pixel 8 Pro, Android 17 build CP3A.261005.005, Chrome 155.0.8059.84; same-page unlock 7115 ms, Airplane 4425 ms, Doze 176 ms; 7/7 detectable; clean. |
| androidPush | Signed candidate v0.9.0-prealpha.7 | Android 17, Chrome 155.0.8059.84, installed WebAPK; force-stop delivered_while_force_stopped, Doze delivered_after_doze_exit; outcomes are observed variants, not delivery guarantees. |
| androidPushCleanup | Signed candidate v0.9.0-prealpha.7 | Device, browser and fixture restored. |
| deviceCloud | Signed candidate v0.9.0-prealpha.7 | TestingBot, tunnel 4.9: iPhone 17 Pro Max (26.6, safari 26.6.1); TestingBot, tunnel 4.9: iPad (9th generation) (26.6, safari 26.6); BrowserStack, tunnel 8.9: Galaxy S26 (16.0.0, chrome 152.0.7977.54). Home Screen alerts were proven only on the TestingBot iPhone and do not qualify lock-screen presentation. |
| deviceCloudCleanup | Signed candidate v0.9.0-prealpha.7 | Restored. |
| relay | Signed candidate v0.9.0-prealpha.7 | 1,800 seconds, 2026-10-27T00:47:39.591Z–2026-10-27T01:17:39.605Z; 2 transitions, final phase live. Eight-hour endurance is not claimed. |
| cleanup | Signed candidate v0.9.0-prealpha.7 | Zero gateway processes, listeners and live OMP hosts. |
| windows | Signed candidate v0.9.0-prealpha.7 | Windows x86-64 build 26100; 4 CPUs, 8186 MiB; Administrator upgrade/rollback from v0.8.0 and fresh standard-account lifecycle; interactive logon, not unattended boot. |
| windowsCleanup | Signed candidate v0.9.0-prealpha.7 | Zero instances and firewalls; tailnet node deleted and access vault removed. |
<!-- release-generate:qualification:end -->

The gateway only reads OMP discovery, polls metadata, and fetches capabilities per launch without
storing them. The minimum version is an integration contract, not proof that every later release
or platform has been tested. No fork-era qualification, signed receipt, or endurance result
transfers to this architecture. Current source/package pins live in `UPSTREAM.lock.json`. Each
release records a fresh 30-minute relay check; eight-hour endurance is not claimed.

The Linux ARM64 source-checkout job stages the published platform native package at the
`UPSTREAM.lock.json` version and runs upstream's `registry.test.ts`, `registry-smoke.test.ts`, and
`host-registry.test.ts`. It gates only the discovery/query contract consumed by the gateway, not
unrelated upstream collaboration suites or full repository checks. The required Windows job gates
gateway contracts, ACLs, and service lifecycle only. Real OMP-to-gateway discovery on Windows is
exercised by the `canary-windows` lane, which drives stock OMP's named pipe through the unchanged
reader, and each stable campaign's signed-artifact Windows lane qualifies Windows Server 2025
x86-64 at interactive logon ([WINDOWS_QUALIFICATION.md](WINDOWS_QUALIFICATION.md), ADR-031).

## Fork-era published-release history

Everything in this section records the named historical gateway artifacts, not current source.
Their patch prerequisites and activation commands apply only to their matching release tags.

**Published qualified stable:** `v0.3.0` (immutable GitHub Latest), exact patched OMP `v18.1.14`, Bun `1.4.0`.<br>
**Signed candidate:** `v0.3.0-prealpha.3`, independently qualified and approved.<br>
**Rollback predecessor:** published stable `v0.2.1`, retaining its own exact patched OMP v17.4.1.<br>
**Advertised combinations:** Debian 13 (trixie) x86-64 and macOS 26.6.1 arm64 (`Mac14,3`) hosts,
with Chrome `152.0.7977.75` on Android 17 (Pixel 10 Pro). Nothing else is advertised.

Fresh signed-artifact provenance, Debian/macOS/Pixel qualification, 49-file runtime equivalence,
and 28,800-second default-relay endurance passed. Historical qualification does not transfer.

Tailscale Serve over tailnet HTTPS is the only supported remote path. Funnel must remain disabled
and Tailscale must run its TUN-mode client; userspace-networking tailscaled does not establish the
required loopback/identity boundary and is refused
([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)). Stable v0.3.0 requires
OMP v18.1.14 at `daf07999c2fee9b22edc7bf8fea1fb6272e0df5e`, patched tree
`17f84676442ee103564d01755ed1f76bbc51820e`, and the versioned `omp-gateway-patched` activation
route. Stock OMP is unsupported. Older releases retain the immutable baselines recorded below.
Upstreaming and paired packaging are not gates for this exact matrix under ADR-024 and ADR-025.

The stable support claim comes from one exact signed-candidate qualification, not row counts or
transferred labels. Candidate `v0.3.0-prealpha.3` at source
`2c89d8280059a2bb638901d413df44b35593ddd4` passed the complete matrix through one resumable
receipt:

- release run [`34254684458`](https://github.com/alphastorm/omp-session-gateway/actions/runs/34254684458)
  verified the signed tag, six assets, checksums, three GitHub attestations, three Sigstore bundles,
  and archive SHA-256 `05c8a8f4001612d7e10c52139bf5b7aa53dca42e64fa2c262592cf6c4d932ec5`;
- Debian run [`34258230589`](https://github.com/alphastorm/omp-session-gateway/actions/runs/34258230589)
  passed the complete disposable Debian 13 lifecycle and the published `v0.2.1` predecessor pair;
- `Mac14,3` / macOS 26.6.1 arm64 passed `doctor` 17/17, rollback 20/20 against published `v0.2.1`,
  persistence, exact artifact checks, patched-OMP publication/revocation, uninstall, and cleanup;
- the physical Pixel passed same-page lock, Airplane, and forced-Doze recovery with a clean
  seven-sink capability sweep after explicit ADB authorization;
- exact patched OMP v18.1.14 published and revoked generation-1 View and Control with `200 no-store`;
- the default relay finished a 60-second smoke and a fresh 28,800-second endurance run live; and
- final cleanup measured zero gateway/OMP processes and zero gateway listeners.

Windows source/lifecycle checks pass, but Windows remains unadvertised and outside this stable
matrix. No prior release evidence substitutes for a v0.3.0 candidate lane. Supplemental physical
camera delivery on Chrome `152.0.7977.82` and endurance on `Mac16,5` / macOS 26.6.2 are named
smokes/scenarios, not additional supported host/browser combinations.

Known limits remain part of the claim. Exact candidate `v0.3.0-prealpha.3` recovered same-page automatically
after the qualified lock, Airplane, and forced-Doze transitions. Chrome for Android can still wedge
its process-wide network state after some abrupt transitions while Android remains healthy. Native
EventSource reconnection and the bounded snapshot fallback recover the proven cases; after 45
uninterrupted visible seconds the loaded shell exposes force-stop/reopen help. JavaScript does not
claim it can restart Chrome's network service
([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)). Preview detail currently falls
back to Session detail. Background Web Push remains outside the stable core claim. Portal Tunnel,
self-hosted/proxied relays, Funnel, userspace networking, shared mutually untrusted local accounts,
and every unnamed platform/browser/version remain unsupported.

A signed artifact proves origin, not fitness. Candidate history for the 0.1 point release is
explicit, and the 0.2 campaign adds its own row:

| Candidate | Build | Disposition | Verification |
|---|---|---|---|
| `v0.1.0-prealpha.18` | `0.1.0-3a9bb1cccc6e` | **Failed qualification; retained as evidence.** Repeated explicit rollback reached systemd's start-rate limit and repair could not restart. | Six signed/attested assets verified; macOS/Pixel/relay sublanes passed; Debian full lane failed at W2. |
| `v0.1.0-prealpha.19` | `0.1.0-28d89a99565d` | **Qualified replacement.** Clears the systemd start-rate counter only before an explicit operator-requested install/rollback start. | Archive SHA-256 `f6e01c4b96b5630fccbb3c79f0a0dae1677e316990d869db6e300ce96605a762`; checksums, three GitHub attestations, and three Cosign bundles verified; exact Debian/macOS/Pixel evidence above. |
| `v0.1.0-prealpha.20` | `0.1.0-848c968923f1` | **Qualified and promoted to `v0.1.0-beta.1`.** Uses the accepted exact v17.4.1 patch route; upstreaming and paired packaging are not gates. | Archive SHA-256 `ba789f7a7f6799a53dab205e26cf6f3ebbaa39c2e26655315c1a809075b09ed2`; checksums, signed tag, all attestations/Cosign bundles, byte-identical rebuild, Debian/macOS/Pixel lanes, exact Linux/macOS patched-OMP operation, and bounded beta relay smoke passed. |
| `v0.1.0-prealpha.21` | `0.1.0-a98c526c40a3` | **Rejected.** Final qualification passed artifact, Debian, macOS, and relay lanes but failed the physical Android lane; cleanup passed. | Archive SHA-256 `cb7da13531875b879c3ab1c2451b58683199263877a74475f539258dfdcba33c`; Debian run `32565941928`; receipt `v0.1.0-prealpha.21.failed-32565941928-187994c`. |
| `v0.1.0-prealpha.22` | `0.1.0-489b58e4b862` | **Rejected.** Lock and Doze did not recover, Airplane recovery took 170,210 ms, and no outage status rendered; cleanup passed. | Archive SHA-256 `194958b5b7affce27163145ca90b5cc14c6952ebb0bbf15b43878c351c6c69db`; release run `32579082734` attempt 2; Debian run `32579748768`. |
| `v0.1.0-prealpha.23` | `0.1.0-434cddc44333` | **Qualified and approved for `v0.1.0`.** Native EventSource reconnection plus bounded snapshot fallback passed explicit no-reload recovery. | Archive SHA-256 `f98bad0ce2ae20d3892e560069b2fbfc4ab6d084a403b6aa57e41c628c25ce98`; signed tag/assets/attestations/bundles, exact rebuild, Debian/macOS/Pixel/patched-OMP/relay lanes, seven-sink sweep, and cleanup all passed exactly once. |
| `v0.2.0-prealpha.1` | `0.2.0-db88afb2ca18` | **Qualified and approved for `v0.2.0`.** Couch-flow visual pass, Settings sheet, transcript windowing, and shell-precached collab client; cross-version `v0.1.0` rollback pair. | Archive SHA-256 `149fc1b88a22b9cb1781bcb6219f2c1e41cafc867cb4eefe0a1e04b07eceeea2`; signed tag/assets/attestations/bundles, Debian run `33156664373` incl. `v0.1.0` migration, macOS `doctor` 17/17 and rollback 20/20, Pixel lock/Airplane/Doze recovery with a clean seven-sink sweep, patched-OMP publication/revocation, 60s relay smoke, and cleanup all passed exactly once. |
| `v0.2.1-prealpha.1` | `0.2.1-3ea58e234b6d` | **Rejected before qualification.** Build, attest, and signing passed; draft validation still expected 0.2.0 asset names and deleted the draft. | Signed diagnostic tag and transparency records retained; no GitHub release survived and no host/client qualification ran. |
| `v0.2.1-prealpha.2` | `0.2.1-f09e3566c238` | **Qualified and approved for `v0.2.1`.** Final phone hierarchy, coherent product versioning, predecessor-bound receipts, and stable runtime equivalence gate. | Archive SHA-256 `9fd5e49b9819ab4dfc82f978fcd9e8382b83d5b821bb341c6b6e6979ff42c7fa`; release run `33206359784`, Debian `33207184350`, macOS `doctor` 17/17 and rollback 20/20 from v0.2.0, physical Pixel recovery/leak sweep, patched-OMP publication/revocation, 60s relay smoke, and cleanup passed. |
| `v0.3.0-prealpha.1` | `0.3.0-1a8a3212e195` | **Published pre-alpha; locally smoke-tested, not qualified.** Phone photo chooser/composer using existing OMP v3 image prompts. | Archive SHA-256 `60750b2b5f21d4e99dbd1a4d05230f4aa3f4d79b15c113d08aa68042a54c5fed`; release run `33281549543`; checksums, six immutable assets, three attestations, and three bundles verified; local Darwin install/doctor 17/17 and real patched-host desktop plus measured Pixel-viewport sends passed. No physical Android run. |
| `v0.3.0-prealpha.2` | `0.3.0-d259ea06c7fe` | **Published pre-alpha direct-camera follow-up; locally smoke-tested, not qualified.** Explicit Take photo and Choose existing paths. | Archive SHA-256 `ca05549aecdf0d2e01f2b5d6820729222e29b38e92aa4ee1582c009e195c6fff`; release run `33283594409`; provenance and six assets verified; local Darwin install/doctor 17/17 and real patched-host Pixel-viewport camera-input JPEG plus library-input PNG sends passed. Native Android camera launch not exercised. |
| `v0.3.0-prealpha.3` | `0.3.0-17a8de62547e` | **Qualified for stable v0.3.0.** Exact patched OMP v18.1.14, Bun 1.4.0, phone photos, native MathML, reconnect tail recovery, and configuration preservation. | Archive SHA-256 `05c8a8f4001612d7e10c52139bf5b7aa53dca42e64fa2c262592cf6c4d932ec5`; release run 34254684458, Debian run 34258230589, Mac doctor 17/17 and rollback 20/20 from v0.2.1, physical Pixel recovery/isolation, OMP publication/revocation, fresh 28,800-second endurance, cleanup, and 49-file runtime equivalence passed. |

[`RELEASE_STATUS.md`](RELEASE_STATUS.md) is the source of truth for evidence and release decisions.
This document defines the supported boundary. Where they disagree, the ledger is authoritative.

## v0.5.0 compatibility correction

Published v0.4.2 rejects the additive `busy` field emitted by OMP 18.2.9 and can hide live sessions
(#219). The v0.5.0 parser fix accepts validated booleans and preserves absent/null as unknown.
Mixed current/legacy host discovery and View/Control are covered by real local IPC regression tests.
This does not advance the pinned baseline, native/client versions, or exact qualification matrix.

v0.5.0 stop alerts use the presence of valid activity metadata, not an OMP version guess.
Older hosts keep ordinary directory/ask behavior with unknown activity. Push state and v2
attention/clear remain compatible; older workers cannot interpret stops until activation and
the browser may substitute a generic background-update notification. Open or refresh the PWA
after upgrading before relying on stop alerts.
This does not qualify physical background delivery or imply successful task completion.

## Status vocabulary

Compatibility statements use these terms deliberately:

| Term | Meaning |
|---|---|
| **Tested** | A named CI lane runs it and is green, on every change or on its stated schedule. It proves that lane's scope on hosted runners or browser engines, not a physical device or a signed release. |
| **Supported** | A platform family the project keeps working and accepts bug reports against. Each supported family names the Tested lanes that cover it and its known limits; support never implies qualification. |
| **Qualified** | The complete applicable release matrix passed on the named version, OS, browser, and deployment path. |
| **Implemented** | The relevant code path exists and has repository-level automated coverage. |
| **Smoke-tested** | A named scenario passed in one recorded environment. This is not a platform support claim. |
| **Deferred** | Intentionally outside the current release target. |
| **Unsupported** | Must not be presented as a working deployment path. |

An implemented or smoke-tested row remains unqualified until every applicable security,
installation, lifecycle, and cleanup scenario passes. Blank version ranges never imply support.
Tested and supported never become qualified: a green hosted or emulated lane is not a
physical-device or signed-release result. A family whose lanes stop running loses its support
status (ADR-030).

The advisory [Percy visual lane](BROWSERSTACK.md#percy-scope) re-renders 18 synthetic DOM
snapshots at three CSS viewports. Visual snapshots are neither functional browser tests nor
qualification, even when a renderer is branded Safari, Edge, iPhone or Android. They do not add
Tested functional coverage, Supported families or Qualified rows to the matrices above.

Real-device cloud rows (ADR-032) are qualified **in the browser on a cloud device**: the stable
campaign's `deviceCloud` lane passed on the named real device, OS, and browser version in
the vendor named for that target, each as the device itself reported it. The limits are part of that claim.
Tailscale Serve saw the orchestrator's allowlisted login, not the phone's own; alerts were proven
with the device unlocked and the app in the background; and lock, Airplane, Doze, force-stop, and
cellular behavior are qualified only on the Pixel.

Shared-device availability is infrastructure, not a candidate pass or defect. A valid pinned
pool with no free eligible device produces a failed attempt with closed availability-hold
evidence (CLI exit 75); auth, transport, audit and cleanup failures remain diagnostic. Wider
model pools and capability-free allocation probes are Tested tooling evidence only. They add
no qualified devices or versions to the signed-release tables above.

New device-cloud receipts attribute vendor and tunnel version to each target. TestingBot remains
the only iPhone vendor and the only cloud Home Screen/background-alert proof. iPad Safari and
Samsung Chrome may use BrowserStack when their TestingBot pool is empty; mixed receipts never
attribute BrowserStack's devices to TestingBot. Android remains Samsung-only, with a corroborated
hardware code. Legacy homogeneous receipts retain their original summaries. The 2026-10-20
BrowserStack public-page allocations (iPad 10th/Safari 27.0 and Galaxy S26 SM-S942B/Android
16.0.0/Chrome 152.0.7977.54) are Tested allocation and retention evidence only, not qualification
of these versions or completion of the collaboration journey.
A later capability-free BrowserStack S26 probe on 2026-10-20 also observed `SM-S942U1`, as allocation evidence only.

## Exact OMP baseline

**Fork-era evidence:** the table and pin-refresh records below are immutable published-release
history, not the mainline support matrix above. Any local patch path or lock reference here means
the file at that historical tag; it no longer describes the shipping prerequisite.

Published releases and unreleased development targets use separate immutable upstream revisions:

| Gateway line | OMP source | Nearest release baseline | OMP package baselines | Collab client | Registry protocol | Claim |
|---|---|---|---|---|---:|---|
| `0.3.0`, qualified stable v0.3.0 | `can1357/oh-my-pi@daf07999c2fee9b22edc7bf8fea1fb6272e0df5e` | `v18.1.14` | coding-agent `18.1.14`; wire `18.1.14` | collab-web `16.3.6` from the same source commit, with gateway patches | 1 | Fresh signed v0.3.0-prealpha.3 matrix and endurance; exact patched tree `17f84676442ee103564d01755ed1f76bbc51820e` |
| `0.3.0`, published as `v0.3.0-prealpha.2` | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit, with photo composer patches | 1 | Published engineering prerelease; exact local smoke only |
| `0.1.0`, published as `v0.1.0-alpha.1` | `can1357/oh-my-pi@858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55` | `v17.3.8` | coding-agent `17.3.8`; wire `17.3.8` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit alpha qualification only |
| `0.1.0`, published as `v0.1.0-beta.1` | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit beta qualification through the versioned patched-binary route |
| `0.1.0`, published as `v0.1.0` | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit stable qualification with patch tree `a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7` through the versioned patched-binary route |
| `0.2.0`, published as `v0.2.0` | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit stable qualification with patch tree `a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7` through the versioned patched-binary route |
| `0.2.1`, published as `v0.2.1` | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit stable qualification with unchanged patch tree `a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7`; UI/version point release only |

v17.3.8 remains the immutable alpha baseline; the older beta and stable lines retain exact v17.4.1.
Stable v0.3.0 independently qualifies the exact patched v18.1.14 pin in `UPSTREAM.lock.json`.
No loose semver range, stock binary, or arbitrary fork is supported.

**Pin refreshed 2026-08-21, from `v17.3.8` to `v17.4.1`.** The maintained
`gateway-collaboration` series already targeted the new exact base. The carried health-probe commit
applied cleanly, and the v17.4.1 QR-command fixture was adapted to exercise manual publication
recovery. Upstream collab-web, wire, and relay host/client implementation bytes are unchanged;
package metadata and the out-of-path session-close ordering changed. Earlier platform evidence did
not transfer automatically: `.20` repeated the beta lanes, and stable candidate `.23` repeated the
complete signed-artifact, Debian, macOS, physical Pixel, exact patched-OMP publication/revocation,
relay, leak, and cleanup gates. The command-complete `omp-gateway-patched` route is the qualified
stable prerequisite; upstreaming and paired OMP packaging remain non-gates.

**Pin refreshed 2026-08-19, from `v17.0.6` / `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`.** The
previous mbox did not apply at this commit (`interactive-mode.ts`, `agent-session.ts`,
`session-manager.ts`, and `builtin-registry.ts` all conflicted), so the shipped patch was
regenerated against `v17.3.8`. The refresh itself carried source-level evidence only: it re-ran the
documented patch suite and the repository suite, and it re-ran no native host, Tailscale, relay,
Android, browser, or signed-artifact qualification. Any platform row whose evidence predates
2026-08-19 is therefore **NOT RUN** for this pin until re-executed, and an unchanged row is never
coverage of `v17.3.8`.

Historical v0.2.1 qualification used candidate `v0.2.1-prealpha.2`. On 2026-08-28 it passed the
complete Debian signed-artifact lifecycle including the published `v0.2.0` predecessor
migration; the complete macOS install, persistence, rollback, and cleanup sequence; exact v17.4.1
patched-OMP publication/revocation; physical Pixel same-page lock, Airplane, and forced-Doze
recovery; the seven-sink capability sweep; and the bounded relay smoke. The protected
28,800-second long-window result transferred within that unchanged historical relay/client/wire
baseline only; it does not transfer to v0.3.0. The current candidate repeated endurance independently.
Issue #65 stays open for other process-wide Chrome failures, not as a
qualification exception for the transitions the candidate actually passed.

The fork-era source paths, versions, observation dates, and upstream findings remain in each
release tag’s `UPSTREAM.lock.json`. Those historical integrations required:

- the apply-ready OMP controller/auto-start/registry patch in
  [the fork-era patch directory](https://github.com/alphastorm/omp-session-gateway/tree/v0.3.0/patches/oh-my-pi);
- the pinned collab-web source integration described by
  [`packages/collab-client/upstream/UPSTREAM.json`](../packages/collab-client/upstream/UPSTREAM.json);
- the reviewed in-memory client bootstrap, because upstream collab-web writes a
  capability to `location.hash`; and
- exact Bun `1.4.0` for the v0.3.0 qualified build/runtime. Archives declare Bun `>=1.4.0`, but
  no broader version range is qualified. Historical v0.2.1 remains specific to Bun `1.3.14`.

## Versioned interfaces

Three compatibility surfaces change independently:

| Surface | Current version | Current behavior |
|---|---|---|
| Gateway client of OMP discovery/query | 1, mainline OMP `>= 18.1.20` | Validates consumed discovery and reply fields and ignores unknown additive v1 fields; snapshot polling and per-launch link resolution. |
| PWA to gateway HTTP API | `/api/v1` | Metadata-only list/SSE, `GET /api/v1/client-config`, generation-bound launch plus `409 mode_unavailable`, and opt-in exact-origin CORS (`http.trustedDashboardOrigins`) on `/api/v1/sessions` and `/api/v1/sessions/:instanceId/launch`. |
| Pinned OMP browser client | Exact source/provenance in the client lock | In-memory bootstrap; not a claim to support arbitrary client/wire combinations. |

There is no gateway-owned publisher protocol and no cross-version publisher fallback. Unknown
protocol majors fail closed. The host minimum does not supersede the pinned browser-client
provenance or the need for exact release qualification.

## Host and client matrix

**Fork-era evidence only:** every result and support label in this historical matrix belongs to
the named patched-OMP artifacts. It does not qualify the mainline prerequisite.

The following describes code, evidence, and each row's support boundary. Debian 13 x86-64, macOS
26.6.1 arm64, and Chrome 152.0.7977.75 on the Android 17 Pixel have exact `v0.3.0-prealpha.3`
qualification. Historical evidence never substitutes for this result.
Windows passes persistent source acceptance through reboot-to-interactive-login and the complete
gateway/OMP path, but remains unadvertised until signed Windows gateway and patched-OMP artifacts
repeat it. This Windows-only gap does not block the narrower stable matrix. Desktop Chromium is
smoke only.

| Platform | Implemented path | Recorded evidence | Qualification | Support claim |
|---|---|---|---|---|
| Linux host | User-only Unix-domain socket; systemd user service | Signed `v0.3.0-prealpha.3` passed the complete Debian 13 x86-64 lifecycle in [run 34258230589](https://github.com/alphastorm/omp-session-gateway/actions/runs/34258230589): install/readiness, permissions, rotation, diagnostics, v0.2.1 upgrade/rollback, identity denial, persistence, refusal-safe uninstall, cleanup, and disposable-host teardown. Exact patched OMP v18.1.14 built and published. | Qualified with TUN-mode Tailscale Serve; no other Linux release, architecture, or init-system claim. | Stable v0.3.0: Debian 13 x86-64 only |
| macOS host | User-only Unix-domain socket; LaunchAgent | Signed `v0.3.0-prealpha.3` on Mac14,3 / macOS 26.6.1 arm64 passed exact archive/native-addon checks, private install, doctor 17/17, rotation/persistence, control-plane restart, v0.2.1 rollback 20/20, identity/exposure, exact patched OMP v18.1.14 build/publication/revocation, uninstall, Serve reset, and zero-process/listener cleanup. | Qualified only for macOS 26.6.1 arm64 on Mac14,3 with TUN-mode Tailscale Serve; interactive-login startup. | Stable v0.3.0: named macOS combination only |
| Windows host | Current-user named pipe and Scheduled Task with `LogonTrigger` + `InteractiveToken`; paired OMP publisher uses nonce-bound mutual HMAC before releasing capabilities | Hosted run `29791906104` passed publisher mutual authentication, ACLs, cross-user denial, service lifecycle, rotation, and uninstall. A persistent Windows Server 2025 source lane on 2026-08-21 then passed exact-source install in 77,498 ms, reboot with task installed but no pre-login listener, automatic first-RDP-login startup without `/Run`, config/token continuity, rotation, active upgrade, history-selected rollback, TUN-mode Serve, `doctor` 17/17, and clean uninstall. Exact patched OMP `v17.4.1` built on the host, auto-published View and Control, returned `200 no-store` launches, denied a mismatched generation `409`, and revoked within 374 ms after forced exit. | **PARTIAL for release.** The persistent source lane accepts #90 and the reboot/login contract, but its gateway archive and OMP binary were unsigned. A Windows-only hang in the complete `read-only.test.ts` fixture also remains to be dispositioned; the publisher suite passed 13/13 and production publication/revocation passed. Repeat the entire lane with paired signed artifacts. | None; Windows remains unadvertised. If later promoted, the promise is “starts at interactive login,” not unattended boot. |
| Android client | Installable HTTPS PWA through Tailscale Serve | Pixel 10 Pro / Android 17 build CP2A.260805.005 / Chrome 152.0.7977.75 loaded signed candidate asset `/assets/app.32115375c6b5.js`. View/read-only, Control, and prompt acknowledgement passed. Same-page lock (9,451 ms), Airplane (8,481 ms), and forced Doze (8,799 ms) recovered without a reload; all seven forbidden capability sinks were detectable and clean. | Qualified only for the named device/OS/browser. Issue #65 remains a process-wide Chrome limitation outside the proven transitions. | Stable v0.3.0: named Pixel combination only |
| Desktop Chromium | Development/smoke client | Serve access as the current node's allowed identity, loopback-backend identity rejection, three real OMP cards, View/Control/interrupt, SSE, URL scrub, browser-store/cache checks, process removal, foreground/online reconnect, and live `/new` generation revocation (`409` for the stale generation) passed | Not a release target, and never a substitute for physical Android qualification: emulating a device's viewport and pixel ratio is not a result from that device. The denied-identity evidence in this document comes from a tagged droplet and the physical Pixel, not from desktop Chromium. | Smoke only |

At those fork-era releases, no other Linux init system, macOS deployment mode, Windows service
mechanism, iOS browser, Firefox, Safari, or Chromium derivative had a compatibility claim. Current
platform and browser support is in [Platforms and browsers](#platforms-and-browsers).

The v1 HTTP identity boundary assumes a user-controlled workstation. Any untrusted process or
different OS account that can connect to the desktop's loopback port can forge the non-cryptographic
Serve identity headers and is therefore outside the support boundary. Shared shell hosts and
mutually untrusted local accounts are unsupported even though IPC publication itself remains
current-user/token protected.

## Deployment dependency matrix

**Fork-era evidence only:** measured results below retain their original scope. The current
Tailscale-only policy is unchanged, but the mainline candidate must repeat qualification; even
unchanged browser or relay behavior does not inherit these passes.

| Dependency or mode | Current state | Compatibility statement |
|---|---|---|
| Tailscale Serve over tailnet HTTPS | Required production architecture. Advertised evidence includes macOS-hosted Serve on macOS 26.5.2/26.6.1 arm64; supplemental Windows Server 2025 source acceptance used Authenticode-valid Tailscale `1.102.3`, TUN mode, and passed `doctor` 17/17. No Tailscale version range is qualified. | The signed-candidate identity matrix is closed for the advertised hosts: tagged/no-user identity denied, real non-allowlisted identity denied, real allowlisted identity admitted, forged headers ignored, direct backend addresses refused, and Funnel disabled. Mainline campaigns from v0.6.0 also qualify the signed-artifact Windows Server 2025 path through Serve. Direct loopback spoofing remains outside the explicitly single-user v1 trust boundary, and the full identity evidence must repeat on every newly advertised host. |
| User-owned Tailscale source identity | Designed identity-header mode | One exact user-owned login — the operator's own — was observed through Serve and allowlisted for qualification; no broader identity or device support is claimed. The login itself is deliberately not reproduced here: the only login written into this file is a placeholder in a reserved TLD, so nothing readable here is ever authenticable. A denial by a *different real person's* login has never been measured and cannot be produced by a single-account tailnet. |
| Tagged Tailscale source device | Unsupported, and now measured | Serve populates user identity headers only for user-owned source devices, so a request proxied from a tagged source arrives with no user identity and the `tailscale-serve` auth mode must fail closed. Measured on droplet a node carrying `tag:omp-session-gateway`, confirmed by both `tailscale status` and `tailscale whois`, which reported no user profile and a tag list: `403` through Serve on `/api/v1/sessions` and on `/`. A tagged phone would need a separately designed app-capabilities or equivalent authentication mode; do not silently weaken authentication to accommodate one. |
| Any other forwarder onto the gateway's loopback port | Unsupported; a complete authentication bypass | A tunnel, reverse proxy, port forward, container publish, or SSH `-L` that terminates remote traffic and relays it to `127.0.0.1:<port>` presents a loopback peer, satisfying the first authorization check, and then forwards whatever `Tailscale-User-Login` the remote caller chose. Tailscale Serve is safe here only because it overwrites caller-supplied identity headers; nothing else in this design does. See [`SECURITY.md`](SECURITY.md) §4 and [#74](https://github.com/alphastorm/omp-session-gateway/issues/74). |
| Existing OMP encrypted relay | Required v1 relay path. Real View/Control/interrupt passed. Exact stable candidate `.23` finished a 60-second default-relay smoke live with two transitions. A protected 28,800-second run completed 22 transitions without restart; it transfers because relay host/client, collab-web, and wire bytes are identical. Relay availability and traffic metadata remain inherited dependencies. | Supported only through the existing default relay; no availability or metadata-hiding guarantee beyond OMP's relay |
| Self-hosted or proxied relay | Unsupported/deferred | Must pass the dedicated long-lived WebSocket soak and a separate security qualification before it can be documented as supported. |
| `dev-localhost` HTTP mode | Development only | Never a remote, LAN, or production deployment path. |
| Tailscale Funnel or public reverse tunnel | Unsupported | Must not be enabled or documented as a normal deployment path. |

WebAuthn control gating, a Trusted Web Activity, native Android applications, server-side
multi-host proxying, and fleet-wide push remain deferred. Background Web Push is qualified on the Pixel by each stable
campaign's background-Push lane (ADR-031): the exact-version closed-app, lock-screen,
tap-to-current-Control, stale-generation, force-stop, network-change, Doze, and forbidden-sink
matrix, with force-stop and Doze recorded as observed variants. From v0.6.2, the real-device cloud
lane (ADR-032) adds a narrower iPhone check: Home Screen install, alerts enabled with a real tap,
delivery with the app in the background, and the tap into Control. Other browsers and devices
remain unqualified for background alerts.

## Upstream refresh procedure

For every proposed OMP update:

1. Inspect the new release/tag and collaboration-related source changes.
2. Run `bun scripts/upstream-pins.ts <version> --write` to derive the exact tag, commit, tree,
   package versions, observation date, and integrity-verified Darwin arm64 and Windows x64
   native pins into `UPSTREAM.lock.json` and `scripts/windows-qualification-pins.json`. It
   refuses a Bun range the pin does not satisfy and any relevant path missing at the tag. Record
   the findings in the lock notes.
3. Check the supported mainline discovery/query contract and minimum host version; do not create a
   downstream OMP patch or fallback transport.
4. Rebuild the pinned collab-web integration and verify its provenance and license notices.
5. Run discovery/query, protocol, link parsing, View, and Control verification.
6. Run the [upstream canary](LIFECYCLE_BRANCH_RESUME.md#daily-upstream-canary): `publish`,
   `snapshot`, `stale-generation`, `view`, `control`, `new-generation`, `fork`, `branch-rewind`,
   `continue`, and `unregister`. Windows runs `continue` but skips exactly the three keystroke
   stages. Prove the retained-Mac `ompPublication` lifecycle step with
   `bun scripts/omp-lifecycle-development.ts --omp <absolute path to stock OMP dist/cli.js>`
   before the campaign; require its additive lifecycle evidence in that campaign. Keep
   relay-replacement, fatal-failure, and shutdown checks; these stages do not stand in for them.
7. Run the complete capability-leak suite and real browser/Android acceptance.
8. Qualify every advertised host installer and deployment path.
9. Update this matrix, [`RELEASE_STATUS.md`](RELEASE_STATUS.md), and the changelog.

Do not call an additional OMP version or platform qualified merely because it satisfies the
`>= 18.1.20` minimum; record exact CI and acceptance evidence for each advertised combination.

## Protocol evolution

- Reject unknown major protocol versions.
- Add optional fields within a major only when old peers safely ignore them.
- Never reinterpret a field's security meaning in place.
- Emit one browser API major at a time.
- Record protocol versions in diagnostics without capability values.
- Document upgrade order and rollback behavior when the gateway and mainline host contract changes.

Every published release must identify the exact OMP and collab-web source, build command,
Bun version, dependency lockfile hash, local patches, license notices, and shipped asset hashes.
